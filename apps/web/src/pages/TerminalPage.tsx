import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo, SessionStatus, TerminalHintKind } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { api, ApiError } from '../api/client.js';
import { TerminalConnection, type ConnectionState } from '../api/ws-client.js';
import { createTerminal } from '../terminal/create-terminal.js';
import { MobileKeyBar, ctrlSequence } from '../components/MobileKeyBar.js';
import { PromptBox } from '../components/PromptBox.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ConnectionBadge, StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/Icon.js';
import { takePendingPrompt } from '../agent/pending-prompt.js';
import { notifyIdle, ensureNotificationPermission } from '../agent/notifications.js';

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
}

const RESIZE_DEBOUNCE_MS = 150;

export function TerminalPage({ sessionId, onBack, onApiError }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const connRef = useRef<TerminalConnection | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 });

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const [hints, setHints] = useState<TerminalHintKind[]>([]);
  const [ctrlActive, setCtrlActive] = useState(false);
  /** The CLI has printed something, so it is far enough up to be typed at. */
  const [sawOutput, setSawOutput] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  /**
   * An adopted pane shares its grid with whoever else is attached, so we must
   * not push our own dimensions at it — that would resize their terminal.
   */
  const adoptedRef = useRef(false);
  const [takeOverSize, setTakeOverSize] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);

  const ctrlActiveRef = useRef(false);
  ctrlActiveRef.current = ctrlActive;

  // ---- Terminal + connection lifecycle -------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const bundle = createTerminal(host);
    termRef.current = bundle.term;
    fitRef.current = bundle.fit;

    // Plain closure variable, not a ref: every handler below is recreated
    // together whenever this effect re-runs, so they always see the latest
    // write here without the staleness a `session` state read would have
    // inside this same closure.
    let latestTitle: string | null = null;
    const connection = new TerminalConnection({
      handlers: {
        onConnectionState: setConnection,

        onReplay: (data, truncated) => {
          if (truncated) {
            // Not contiguous with what is on screen: a partial ANSI stream would
            // corrupt the display, so start from a clean slate.
            bundle.term.reset();
            setNotice('Older output was dropped from the server buffer.');
          }
          bundle.term.write(data);
          if (data.length > 0) setSawOutput(true);
        },

        onOutput: (data) => {
          setSawOutput(true);
          bundle.term.write(data);
        },

        onAttached: (info) => {
          latestTitle = info.title;
          setSession(info);
          setStatus(info.status);
          setFatal(null);
          adoptedRef.current = info.adopted;
          // Adopt whatever size the browser actually has, right now.
          queueMicrotask(() => applyFit(true));
        },

        onStatus: (next, info) => {
          setStatus(next);
          if (info) {
            latestTitle = info.title;
            setSession(info);
          }
        },

        onExit: (exitCode, exitSignal) => {
          setStatus((prev) => (isTerminalStatus(prev) ? prev : 'exited'));
          setNotice(
            exitSignal
              ? `Process terminated by signal ${exitSignal}.`
              : `Process exited with code ${exitCode ?? 0}.`,
          );
        },

        onHint: (nextHints) => {
          setHints(nextHints);
          if (nextHints.includes('idle')) {
            // Same tab-hidden gate the approval alert uses on the structured
            // side; a fully detached client is covered by the server's own
            // push instead. `checkIdle` on the server only emits this once
            // per quiet stretch, so this does not fire on every poll.
            void notifyIdle(latestTitle ?? 'Session', sessionId);
          }
        },

        onError: (code, message) => {
          if (code === 'not_found') setFatal(message);
          else if (code === 'session_ended') setNotice(message);
        },

        onFatal: setFatal,
      },
    });
    connRef.current = connection;

    const inputDisposable = bundle.term.onData((data) => {
      let payload = data;
      if (ctrlActiveRef.current) {
        const mapped = ctrlSequence(data);
        if (mapped) payload = mapped;
        setCtrlActive(false);
      }
      connection.sendInput(payload);
    });

    // Full-screen TUIs request the size; answer with the real one — unless this
    // is someone else's pane, in which case we are a guest and stay quiet.
    const resizeDisposable = bundle.term.onResize(({ cols, rows }) => {
      lastSizeRef.current = { cols, rows };
      if (!adoptedRef.current || takeOverSizeRef.current) connection.sendResize(cols, rows);
    });

    connection.open(sessionId);
    void ensureNotificationPermission();

    return () => {
      inputDisposable.dispose();
      resizeDisposable.dispose();
      connection.close();
      bundle.dispose();
      connRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // ---- Metadata (title, workspace) even before the socket attaches ---------
  useEffect(() => {
    let cancelled = false;
    api
      .getSession(sessionId)
      .then((info) => {
        if (cancelled) return;
        setSession(info);
        setStatus(info.status);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        if (err instanceof ApiError && err.status === 404) setFatal('This session no longer exists.');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onApiError]);

  const takeOverSizeRef = useRef(false);
  takeOverSizeRef.current = takeOverSize;

  // ---- Responsive sizing ---------------------------------------------------
  const applyFit = useCallback((force = false) => {
    const fit = fitRef.current;
    const term = termRef.current;
    const conn = connRef.current;
    if (!fit || !term || !conn) return;

    try {
      fit.fit();
    } catch {
      return;
    }

    const { cols, rows } = term;
    const last = lastSizeRef.current;
    // Only talk to the server when the grid actually changed. Rotating a phone
    // fires a burst of events that would otherwise become a resize storm.
    if (!force && cols === last.cols && rows === last.rows) return;
    lastSizeRef.current = { cols, rows };
    if (!adoptedRef.current || takeOverSizeRef.current) conn.sendResize(cols, rows);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => applyFit(), RESIZE_DEBOUNCE_MS);
    };

    const observer = new ResizeObserver(schedule);
    if (hostRef.current) observer.observe(hostRef.current);

    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    // visualViewport fires when the soft keyboard opens/closes on iOS.
    window.visualViewport?.addEventListener('resize', schedule);

    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      window.visualViewport?.removeEventListener('resize', schedule);
    };
  }, [applyFit]);

  // ---- Actions -------------------------------------------------------------
  const sendRaw = useCallback((data: string) => {
    connRef.current?.sendInput(data);
    termRef.current?.focus();
  }, []);

  const sendPrompt = useCallback((text: string): boolean => {
    const conn = connRef.current;
    if (!conn) return false;
    // Send the text and the Enter as one message so the CLI sees an atomic line.
    return conn.sendInput(`${text}\r`);
  }, []);

  const terminate = useCallback(async () => {
    setStopping(true);
    try {
      await api.deleteSession(sessionId);
    } catch (err) {
      onApiError(err);
    } finally {
      setStopping(false);
      setConfirmingStop(false);
    }
  }, [sessionId, onApiError]);

  const alive = !isTerminalStatus(status);
  const inputDisabled = !alive || connection !== 'connected';

  // A prompt typed on the composer, delivered once the CLI can receive it.
  // Unlike a structured session there is no readiness signal here, so this
  // waits for the process to have produced something before typing at it.
  useEffect(() => {
    if (inputDisabled || !sawOutput) return;
    const queued = takePendingPrompt(sessionId);
    // A terminal session has no attach button (`supportsImageAttachment` is
    // never set below), so `queued.image` should never be set here — but if
    // a prompt composed for a structured chat somehow ends up delivered to a
    // terminal one, dropping the image silently beats sending raw keystrokes
    // it can't do anything with.
    if (queued) sendPrompt(queued.text);
  }, [inputDisabled, sawOutput, sessionId, sendPrompt]);

  return (
    <div className="terminal-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back to sessions">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>{session?.title ?? sessionId}</strong>
          <span>
            {session ? `${session.agentDisplayName} · ${session.workspaceLabel}` : 'Loading…'}
          </span>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <ConnectionBadge state={connection} />
          <StatusBadge status={status} />
        </div>
        {alive && (
          <button type="button" className="danger icon-btn" onClick={() => setConfirmingStop(true)}>
            Stop
          </button>
        )}
      </header>

      {session?.skipPermissionsEnabled && (
        <div className="skip-permissions-banner" role="status">
          Approvals are bypassed for this session — tool calls run unattended.
        </div>
      )}

      {fatal && <div className="notice">{fatal}</div>}

      {!fatal && notice && (
        <div className={`notice ${alive ? '' : 'exited'}`} onClick={() => setNotice(null)} role="status">
          {notice} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
        </div>
      )}

      {!fatal && !notice && connection === 'reconnecting' && (
        <div className="notice" role="status">
          Reconnecting… output will resume where it left off.
        </div>
      )}

      {!fatal && !notice && connection === 'connected' && hints.includes('possible_approval_prompt') && (
        <div className="notice" role="status">
          The agent may be waiting for your approval. Read the terminal and answer it yourself.
        </div>
      )}

      {session?.adopted && !takeOverSize && (
        <div className="notice" role="status">
          Attached to your own tmux pane at {session.cols}×{session.rows}. Not resizing it —
          that would resize your terminal too.{' '}
          <button
            type="button"
            className="inline-link"
            onClick={() => {
              setTakeOverSize(true);
              applyFit(true);
            }}
          >
            Fit to this screen anyway
          </button>
        </div>
      )}

      <div className={`terminal-host${session?.adopted && !takeOverSize ? ' fixed-grid' : ''}`} ref={hostRef} />

      <MobileKeyBar
        onSend={sendRaw}
        ctrlActive={ctrlActive}
        onToggleCtrl={() => setCtrlActive((v) => !v)}
        disabled={inputDisabled}
      />

      <PromptBox sessionId={sessionId} onSend={sendPrompt} disabled={inputDisabled} />

      {confirmingStop && (
        <ConfirmDialog
          title="Terminate this session?"
          body="The running process will be stopped."
          confirmLabel={stopping ? 'Stopping…' : 'Terminate'}
          busy={stopping}
          onConfirm={() => void terminate()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}
