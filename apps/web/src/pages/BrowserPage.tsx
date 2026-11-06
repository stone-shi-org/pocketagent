import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BROWSER_CLOSE_FORBIDDEN,
  BROWSER_CLOSE_NOT_FOUND,
  BROWSER_CLOSE_PROTOCOL,
  BROWSER_PROTOCOL_VERSION,
  type BrowserClientMessage,
  type BrowserHelpPending,
  type BrowserInfo,
  type BrowserServerMessage,
  type BrowserTab,
  type ScreencastMetadata,
} from '@pocketagent/protocol';
import { hostUrl } from '../api/host.js';
import { useDocumentVisible } from '../agent/chat-read.js';
import {
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  framePointToPage,
  keyFramesFor,
  modifiersOf,
  normalizeTypedUrl,
  wheelDeltaForDrag,
} from '../agent/browser-input.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { Icon } from '../components/Icon.js';
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';

/**
 * PA-178: the live view of one shared browser — a project's or a Pocket
 * Agent's — for when only a person can get past a page: a sign-in, MFA, a
 * CAPTCHA, a consent screen.
 *
 * The frame is a JPEG screencast of the real page, drawn into an `<img>`; a
 * tap becomes a click at the matching page coordinate, a drag scrolls, and
 * the soft keyboard types through a hidden textarea. Frames are requested
 * only while this page is on screen, and nothing here keeps or logs one.
 */

interface Props {
  browserId: string;
  onBack: () => void;
  onOpenPlannerChat?: (chatId: string) => void;
  onApiError: (error: unknown) => void;
  /** False while sitting in a hidden desktop tab: no frames then. */
  active?: boolean;
}

type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

interface DialogState {
  dialogType: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultPrompt: string | null;
}

const MAX_DEVICE_SCALE = 2;

export function BrowserPage({ browserId, onBack, onOpenPlannerChat, onApiError, active = true }: Props): JSX.Element {
  const api = useHostApi();
  const endpoint = useHostEndpoint();
  const documentVisible = useDocumentVisible();
  const visible = active && documentVisible;

  const [connection, setConnection] = useState<Connection>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [info, setInfo] = useState<BrowserInfo | null>(null);
  const [sandbox, setSandbox] = useState<boolean | null>(null);
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [url, setUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [promptText, setPromptText] = useState('');
  const [help, setHelp] = useState<BrowserHelpPending[]>([]);
  const [agentActive, setAgentActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [captured, setCaptured] = useState(false);
  const [dragMode, setDragMode] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const metaRef = useRef<ScreencastMetadata | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const send = useCallback((message: BrowserClientMessage): void => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const sendViewport = useCallback((): void => {
    const el = surfaceRef.current;
    if (!el) return;
    const width = Math.max(100, Math.round(el.clientWidth));
    const height = Math.max(100, Math.round(el.clientHeight));
    const mobile = window.matchMedia('(pointer: coarse)').matches;
    send({
      type: 'resize',
      width,
      height,
      deviceScaleFactor: Math.min(MAX_DEVICE_SCALE, Math.max(1, window.devicePixelRatio || 1)),
      mobile,
    });
  }, [send]);

  // ---- the socket -------------------------------------------------------------

  useEffect(() => {
    let disposed = false;
    let retry: number | null = null;
    let attempt = 0;
    const connect = (): void => {
      const ws = new WebSocket(
        hostUrl(endpoint, `/api/browser/${encodeURIComponent(browserId)}/ws?v=${BROWSER_PROTOCOL_VERSION}`),
      );
      socketRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnection('open');
        sendViewport();
        send({ type: 'visible', visible: visibleRef.current });
      };
      ws.onmessage = (e) => {
        let m: BrowserServerMessage;
        try {
          m = JSON.parse(String(e.data)) as BrowserServerMessage;
        } catch {
          return;
        }
        switch (m.type) {
          case 'hello':
            setInfo(m.browser);
            setSandbox(m.sandbox);
            return;
          case 'frame': {
            metaRef.current = m.metadata;
            // A data URL, not a blob URL: the app's CSP allows `img-src data:`
            // and not `blob:` (found in the demo — a blob frame rendered as a
            // broken image while taps, mapped from the element box, still
            // landed). At ~18 KB a frame the string costs nothing that matters.
            if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${m.data}`;
            setHasFrame(true);
            return;
          }
          case 'tabs':
            setTabs(m.tabs);
            return;
          case 'url':
            setUrl(m.url);
            return;
          case 'dialog':
            setDialog({ dialogType: m.dialogType, message: m.message, defaultPrompt: m.defaultPrompt });
            setPromptText(m.defaultPrompt ?? '');
            return;
          case 'dialog-closed':
            setDialog(null);
            return;
          case 'agent-activity':
            setAgentActive(true);
            return;
          case 'help':
            setHelp(m.pending);
            return;
          case 'error':
            setNotice(m.message);
            return;
          case 'closed':
            setNotice(m.reason);
            return;
        }
      };
      ws.onclose = (e) => {
        if (socketRef.current === ws) socketRef.current = null;
        if (disposed) return;
        if (e.code === BROWSER_CLOSE_FORBIDDEN || e.code === BROWSER_CLOSE_NOT_FOUND || e.code === BROWSER_CLOSE_PROTOCOL) {
          setConnection('closed');
          setFatal(e.reason || 'This browser cannot be opened.');
          return;
        }
        setConnection('reconnecting');
        attempt += 1;
        retry = window.setTimeout(connect, Math.min(10_000, 500 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => {
      disposed = true;
      if (retry !== null) window.clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [browserId, endpoint, send, sendViewport]);

  // Frames only while this page is on screen.
  useEffect(() => {
    send({ type: 'visible', visible });
  }, [send, visible]);

  useEffect(() => {
    const el = surfaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let timer: number | null = null;
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(sendViewport, 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sendViewport]);

  useEffect(() => {
    if (!agentActive) return;
    const t = window.setTimeout(() => setAgentActive(false), 6000);
    return () => window.clearTimeout(t);
  }, [agentActive]);

  useEffect(() => {
    if (!editingUrl) setUrlDraft(url);
  }, [url, editingUrl]);

  // ---- pointer input ------------------------------------------------------------

  const pointer = useRef<{
    id: number;
    startX: number;
    startY: number;
    lastY: number;
    mode: 'pending' | 'scroll' | 'drag';
    timer: number | null;
    touch: boolean;
  } | null>(null);

  const pagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    const meta = metaRef.current;
    if (!img || !meta) return null;
    return framePointToPage(clientX, clientY, img.getBoundingClientRect(), meta);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>): void => {
    e.preventDefault();
    const p = pagePoint(e.clientX, e.clientY);
    if (!p) return;
    const touch = e.pointerType !== 'mouse';
    if (!touch) {
      setCaptured(true);
      surfaceRef.current?.focus({ preventScroll: true });
      send({
        type: 'mouse',
        event: 'mousePressed',
        ...p,
        button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left',
        clickCount: e.detail > 1 ? Math.min(3, e.detail) : 1,
        modifiers: modifiersOf(e),
      });
      e.currentTarget.setPointerCapture(e.pointerId);
      pointer.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY, mode: 'drag', timer: null, touch };
      return;
    }
    const state = { id: e.pointerId, startX: e.clientX, startY: e.clientY, lastY: e.clientY, mode: 'pending' as const, timer: null as number | null, touch };
    pointer.current = state;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (dragMode) {
      pointer.current = { ...state, mode: 'drag' };
      send({ type: 'mouse', event: 'mousePressed', ...p });
      return;
    }
    state.timer = window.setTimeout(() => {
      // Held still: a real mouse drag (selecting text, a slider).
      if (pointer.current?.id === state.id && pointer.current.mode === 'pending') {
        pointer.current = { ...pointer.current, mode: 'drag', timer: null };
        send({ type: 'mouse', event: 'mousePressed', ...p });
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>): void => {
    const st = pointer.current;
    const p = pagePoint(e.clientX, e.clientY);
    if (!p) return;
    if (!st) {
      // Desktop hover, so menus and tooltips behave.
      if (e.pointerType === 'mouse') send({ type: 'mouse', event: 'mouseMoved', ...p, button: 'none', modifiers: modifiersOf(e) });
      return;
    }
    if (st.id !== e.pointerId) return;
    if (st.mode === 'drag') {
      send({ type: 'mouse', event: 'mouseMoved', ...p, button: 'left', modifiers: modifiersOf(e) });
      return;
    }
    if (st.mode === 'pending' && Math.hypot(e.clientX - st.startX, e.clientY - st.startY) > TAP_SLOP_PX) {
      if (st.timer !== null) window.clearTimeout(st.timer);
      st.mode = 'scroll';
      st.timer = null;
    }
    if (st.mode === 'scroll') {
      const img = imgRef.current;
      const meta = metaRef.current;
      const dy = e.clientY - st.lastY;
      st.lastY = e.clientY;
      if (img && meta && dy !== 0) {
        send({ type: 'mouse', event: 'mouseWheel', ...p, deltaX: 0, deltaY: wheelDeltaForDrag(dy, meta.deviceHeight, img.clientHeight) });
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>): void => {
    const st = pointer.current;
    pointer.current = null;
    if (!st || st.id !== e.pointerId) return;
    if (st.timer !== null) window.clearTimeout(st.timer);
    const p = pagePoint(e.clientX, e.clientY);
    if (!p) return;
    if (st.mode === 'drag') {
      send({ type: 'mouse', event: 'mouseReleased', ...p, ...(st.touch ? {} : { button: e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left', modifiers: modifiersOf(e) }) });
      return;
    }
    if (st.mode === 'pending') {
      // A tap: a click where the finger was.
      send({ type: 'mouse', event: 'mouseMoved', ...p, button: 'none' });
      send({ type: 'mouse', event: 'mousePressed', ...p });
      send({ type: 'mouse', event: 'mouseReleased', ...p });
      if (keyboardOpen) keyboardRef.current?.focus({ preventScroll: true });
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLImageElement>): void => {
    const p = pagePoint(e.clientX, e.clientY);
    if (!p) return;
    send({ type: 'mouse', event: 'mouseWheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifiersOf(e) });
  };

  // ---- keyboard ---------------------------------------------------------------

  /** Desktop: while captured, keys go to the page. Esc releases. */
  const onSurfaceKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!captured) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      setCaptured(false);
      surfaceRef.current?.blur();
      return;
    }
    const mods = modifiersOf(e);
    const frames = keyFramesFor(e.key, e.code, mods);
    if (frames) {
      e.preventDefault();
      send(frames.down);
      send(frames.up);
      return;
    }
    if (e.key.length === 1 && (mods & 6) === 0) {
      e.preventDefault();
      send({ type: 'insertText', text: e.key });
    }
  };

  const onPaste = (e: React.ClipboardEvent): void => {
    // A paste event's own data is readable over plain HTTP; `navigator.clipboard` is not.
    const text = e.clipboardData.getData('text/plain');
    if (text) {
      e.preventDefault();
      send({ type: 'insertText', text: text.slice(0, 10_000) });
    }
  };

  /** Phone: the hidden textarea raises the soft keyboard; what it types is sent as text. */
  const onKeyboardInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    const value = e.currentTarget.value;
    if (value) send({ type: 'insertText', text: value });
    e.currentTarget.value = '';
  };
  const onKeyboardKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    const frames = keyFramesFor(e.key, e.code, modifiersOf(e));
    if (!frames) return;
    e.preventDefault();
    send(frames.down);
    send(frames.up);
  };
  const toggleKeyboard = (): void => {
    const next = !keyboardOpen;
    setKeyboardOpen(next);
    if (next) keyboardRef.current?.focus({ preventScroll: true });
    else keyboardRef.current?.blur();
  };

  // ---- actions -------------------------------------------------------------------

  const go = (): void => {
    const target = normalizeTypedUrl(urlDraft);
    if (!target) {
      setNotice('Only http(s) addresses can be opened here.');
      return;
    }
    setEditingUrl(false);
    send({ type: 'navigate', url: target });
  };

  const answerHelp = async (item: BrowserHelpPending, outcome: 'done' | 'cancel'): Promise<void> => {
    setBusy(true);
    try {
      await api.answerBrowserHelp(browserId, item.helpId, outcome);
      setHelp((h) => h.filter((x) => x.helpId !== item.helpId));
    } catch (err) {
      onApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const stop = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.stopBrowser(browserId);
      onBack();
    } catch (err) {
      onApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const clearData = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.stopBrowser(browserId);
      await api.clearBrowserData(browserId);
      setConfirmClear(false);
      onBack();
    } catch (err) {
      onApiError(err);
    } finally {
      setBusy(false);
    }
  };

  const answerDialog = (accept: boolean): void => {
    send(accept ? { type: 'dialog-accept', ...(dialog?.dialogType === 'prompt' ? { promptText } : {}) } : { type: 'dialog-dismiss' });
    setDialog(null);
  };

  const label = info?.label ?? browserId;

  return (
    <div className="browser-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>Browser</strong>
          <span>
            {label}
            {connection !== 'open' ? ` · ${connection === 'closed' ? 'closed' : 'connecting…'}` : ''}
          </span>
        </div>
        <button type="button" className="icon-btn" onClick={() => void stop()} disabled={busy || help.length > 0}>
          Stop
        </button>
      </header>

      {help.map((item) => (
        <div key={item.helpId} className="browser-help-bar" role="status">
          <div className="browser-help-text">
            <strong>{item.chatTitle} needs you here</strong>
            <span>{item.reason}</span>
          </div>
          <div className="browser-help-actions">
            <button type="button" className="primary" disabled={busy} onClick={() => void answerHelp(item, 'done')}>
              Done — hand back to agent
            </button>
            <button type="button" disabled={busy} onClick={() => void answerHelp(item, 'cancel')}>
              Cancel
            </button>
            {onOpenPlannerChat && (
              <button type="button" className="link-btn" onClick={() => onOpenPlannerChat(item.chatId)}>
                Open chat
              </button>
            )}
          </div>
        </div>
      ))}

      {sandbox === false && (
        <div
          className="browser-note"
          role="note"
          title="This host has no unprivileged user namespaces, so Chromium runs with --no-sandbox — as playwright-cli always does."
        >
          Renderer sandbox is off on this host (as with playwright-cli).
        </div>
      )}

      <div className="browser-toolbar">
        <button type="button" className="round-btn" aria-label="Back" onClick={() => send({ type: 'back' })}>
          <Icon name="chevron-left" size={18} />
        </button>
        <button type="button" className="round-btn" aria-label="Forward" onClick={() => send({ type: 'forward' })}>
          <Icon name="chevron-right" size={18} />
        </button>
        <button type="button" className="round-btn" aria-label="Reload" onClick={() => send({ type: 'reload' })}>
          <Icon name="rotate" size={18} />
        </button>
        <form
          className="browser-url"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label="Address"
            value={urlDraft}
            onFocus={() => setEditingUrl(true)}
            onBlur={() => setEditingUrl(false)}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
        </form>
        <button
          type="button"
          className={keyboardOpen ? 'round-btn active' : 'round-btn'}
          aria-label="Keyboard"
          aria-pressed={keyboardOpen}
          onClick={toggleKeyboard}
        >
          <Icon name="key" size={18} />
        </button>
      </div>

      <div className="browser-tabs" role="tablist">
        {tabs.map((t) => (
          <div key={t.id} className={t.selected ? 'browser-tab selected' : 'browser-tab'}>
            <button
              type="button"
              role="tab"
              aria-selected={t.selected}
              title={t.url}
              onClick={() => send({ type: 'tab-select', tabId: t.id })}
            >
              {t.title || t.url || 'New tab'}
            </button>
            {tabs.length > 1 && (
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Close ${t.title || 'tab'}`}
                onClick={() => send({ type: 'tab-close', tabId: t.id })}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="browser-tab-new" aria-label="New tab" onClick={() => send({ type: 'tab-new' })}>
          <Icon name="plus" size={14} />
        </button>
        <button
          type="button"
          className={dragMode ? 'browser-mode active' : 'browser-mode'}
          aria-pressed={dragMode}
          title="Drag with the mouse instead of scrolling"
          onClick={() => setDragMode((d) => !d)}
        >
          {dragMode ? 'Drag' : 'Scroll'}
        </button>
      </div>

      {(agentActive || notice) && (
        <div className="browser-notices">
          {agentActive && <div className="browser-note">The agent is also controlling this browser.</div>}
          {notice && (
            <div className="browser-note" role="alert">
              {notice}
              <button type="button" className="link-btn" onClick={() => setNotice(null)}>
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      <div
        ref={surfaceRef}
        className={captured ? 'browser-surface captured' : 'browser-surface'}
        tabIndex={0}
        onKeyDown={onSurfaceKeyDown}
        onPaste={onPaste}
        onBlur={() => setCaptured(false)}
      >
        {fatal ? (
          <div className="browser-empty">{fatal}</div>
        ) : !hasFrame ? (
          <div className="browser-empty">{visible ? 'Starting the browser…' : 'Paused while hidden.'}</div>
        ) : null}
        <img
          ref={imgRef}
          className="browser-frame"
          alt={`Live view of ${label}`}
          draggable={false}
          style={hasFrame ? undefined : { display: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (pointer.current = null)}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
        />
        {captured && <div className="browser-captured">Keyboard captured — Esc to release</div>}
        <textarea
          ref={keyboardRef}
          className="browser-keyboard"
          aria-label="Type into the page"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          onInput={onKeyboardInput}
          onKeyDown={onKeyboardKeyDown}
          onPaste={onPaste}
          onBlur={() => setKeyboardOpen(false)}
        />
      </div>

      <footer className="browser-footer">
        <span className="muted">
          This browser keeps its logins. Agents use it with <code>playwright-cli attach</code>.
        </span>
        <button type="button" className="link-btn danger" disabled={busy || help.length > 0} onClick={() => setConfirmClear(true)}>
          Clear browser data…
        </button>
      </footer>

      {dialog && (
        <div className="dialog-backdrop" role="presentation">
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Page dialog">
            <h2>The page says</h2>
            <p className="confirm-body browser-dialog-message">{dialog.message}</p>
            {dialog.dialogType === 'prompt' && (
              <input value={promptText} onChange={(e) => setPromptText(e.target.value)} aria-label="Answer" />
            )}
            <div className="dialog-actions">
              {dialog.dialogType !== 'alert' && (
                <button type="button" onClick={() => answerDialog(false)}>
                  Cancel
                </button>
              )}
              <button type="button" className="primary" onClick={() => answerDialog(true)}>
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear browser data?"
          body={`This stops the browser and deletes every login, cookie and saved page data in ${label}'s browser. Agents will have to be signed in again.`}
          confirmLabel="Clear data"
          busy={busy}
          onConfirm={() => void clearData()}
          onCancel={() => setConfirmClear(false)}
        />
      )}
    </div>
  );
}
