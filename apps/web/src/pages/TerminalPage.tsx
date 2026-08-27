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
import { getTakeOverSizePref, setTakeOverSizePref } from '../agent/adopted-size-prefs.js';

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  /** Navigates to a newly created session — see `reattach` below. */
  onResumed: (sessionId: string) => void;
}

const RESIZE_DEBOUNCE_MS = 150;

/**
 * Whether this pane's "fit to this screen anyway" opt-in was already made on
 * an earlier visit (see `adopted-size-prefs.ts`).
 *
 * Module scope, and shared by *every* path that learns a session's identity,
 * because there is more than one: the WebSocket's `onAttached` and the REST
 * metadata fetch that deliberately runs ahead of it. Only the former used to
 * consult the preference, so between mount and attach `session.adopted` was
 * already true while `takeOverSize` was still its initial `false` — the notice
 * (and the `fixed-grid` sizing it explains) appeared for a choice the user had
 * already made, then vanished the moment the socket attached.
 */
function hasStoredTakeOver(info: SessionInfo): boolean {
  return info.adopted && !!info.adoptTargetId && getTakeOverSizePref(info.adoptTargetId);
}

export function TerminalPage({ sessionId, onBack, onApiError, onResumed }: Props): JSX.Element {
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
  /**
   * Whether `onAttached` has fired at least once for this mount. `adoptedRef`
   * defaults to `false`, indistinguishable from "confirmed not adopted" —
   * but xterm.js can fire `onResize` before that first server round trip
   * completes (the font-load re-`fit()` in `createTerminal` in particular:
   * it resolves whenever `document.fonts.ready` does, on its own clock,
   * independent of the WebSocket handshake). Without this gate, that early
   * resize reads `adoptedRef.current` while it is still just the initial
   * value, not a real answer, and — for a session that turns out to *be*
   * adopted — sends the browser's own guessed-at, pre-font-metrics size to
   * the server before anything has said "don't". Confirmed against a real
   * tmux server as the mechanism behind "reattaching sometimes duplicates
   * the shell prompt dozens of times": that early resize lands on a shared
   * pane and forces every other attached client (including a real terminal
   * on someone's desktop) through a resize-triggered redraw, which a prompt
   * with its own `precmd`/`SIGWINCH` handling reprints from scratch. Once
   * this is `true`, `adoptedRef.current` is a real answer and safe to act on.
   */
  const knowsAdoptedRef = useRef(false);
  const [takeOverSize, setTakeOverSize] = useState(false);
  /**
   * Whether the server has confirmed an attach for the session currently being
   * shown. The REST metadata fetch below deliberately runs ahead of the socket,
   * so `session` alone says nothing about whether we are actually attached —
   * and the adopted-pane notice speaks in the present tense ("Attached to your
   * own tmux pane at N×M") about a size read from the database row, which
   * `reconcileAdoptedSize` can have moved on from since. Claiming a stale size
   * as the current one is the same failure the `resized` frame exists to
   * prevent, so the notice waits for a real answer.
   */
  const [hasAttached, setHasAttached] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [reattaching, setReattaching] = useState(false);

  const ctrlActiveRef = useRef(false);
  ctrlActiveRef.current = ctrlActive;

  // ---- Terminal + connection lifecycle -------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Switching sessions within one mount reuses this state, so a previous
    // session's confirmed attach must not vouch for the incoming one.
    setHasAttached(false);

    const bundle = createTerminal(host);
    termRef.current = bundle.term;
    fitRef.current = bundle.fit;

    // Plain closure variable, not a ref: every handler below is recreated
    // together whenever this effect re-runs, so they always see the latest
    // write here without the staleness a `session` state read would have
    // inside this same closure.
    let latestTitle: string | null = null;
    // True while `bundle.term.write()` is still processing a *replay* chunk
    // (scrollback sent on attach), as opposed to live output. xterm.js
    // auto-answers terminal capability queries it decodes in anything it is
    // given to parse — Device Attributes (`CSI c` / `CSI > c`), the ones a
    // shell prompt or tmux itself issues at startup to detect terminal
    // features — regardless of whether that byte came from a genuinely live
    // stream or from replayed history. A query baked into old scrollback is
    // stale; nothing is still waiting on its answer, but xterm.js cannot
    // tell the difference and answers anyway via `onData`, same as a real
    // keystroke — and unlike a real keystroke, nothing consumes it, so it
    // lands as literal garbage on whatever is reading the pane right now.
    // Since this replays on every attach, the garbage reappeared every time
    // the page was opened. Only *live* queries get answered; see the
    // `onData` handler below.
    let replaying = false;

    /**
     * Point the local grid at an adopted pane's real size.
     *
     * Shared by the attach path and the server-pushed `resized` path so the
     * two cannot drift: an adopted pane is mirrored, never fitted, and both
     * routes have to apply the same rule and the same `lastSizeRef` bookkeeping
     * (which is what keeps `applyFit`'s change-detection honest).
     *
     * The `term.resize` below re-enters xterm.js's own `onResize`, but that
     * handler declines to send anything back for a mirrored pane, so this does
     * not echo a size at the server.
     */
    const mirrorAdoptedGrid = (cols: number, rows: number): void => {
      bundle.term.resize(cols, rows);
      lastSizeRef.current = { cols, rows };
    };

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
          replaying = true;
          bundle.term.write(data, () => {
            replaying = false;
          });
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
          knowsAdoptedRef.current = true;
          setHasAttached(true);
          // Already decided "fit to this screen anyway" for this exact pane
          // before — on an earlier visit, or a previous attach that this one
          // superseded (see `adopted-size-prefs.ts`). Apply that now, before
          // deciding below whether to mirror the pane's real grid, so the
          // notice explaining the tradeoff does not reappear for a choice
          // that was already made.
          if (hasStoredTakeOver(info)) {
            takeOverSizeRef.current = true;
            setTakeOverSize(true);
          }
          if (info.adopted && !takeOverSizeRef.current) {
            // Mirror the pane's real grid instead of fitting the viewport. The
            // byte stream tmux sends (status line, splits, any full-screen TUI
            // inside) is laid out for that exact width/height; shrinking the
            // local xterm.js grid to a phone-sized container while replaying
            // it produces exactly the corrupted redraws — cursor moves and
            // background fills landing on the wrong cells — that "fit to this
            // screen anyway" exists to opt out of.
            mirrorAdoptedGrid(info.cols, info.rows);
          } else {
            // Adopt whatever size the browser actually has, right now.
            queueMicrotask(() => applyFit(true));
          }
        },

        onStatus: (next, info) => {
          setStatus(next);
          if (info) {
            latestTitle = info.title;
            setSession(info);
          }
        },

        /**
         * The pane's grid changed underneath us — tmux's shared window
         * followed some other client and the server's adopted-size
         * reconciliation resized the real PTY to match (see `ResizedMessage`).
         *
         * Only a mirrored pane acts on this. A session that fits its own
         * viewport owns its size, and so does an adopted one the user took
         * over with "fit to this screen anyway"; re-mirroring either would
         * fight `applyFit` and hand the size back to whoever else is attached.
         */
        onResized: (cols, rows) => {
          if (!adoptedRef.current || takeOverSizeRef.current) return;
          mirrorAdoptedGrid(cols, rows);
          // Keep the "attached at N×M" notice truthful; it is read straight
          // off `session`, which otherwise still holds the attach-time size.
          setSession((prev) => (prev ? { ...prev, cols, rows } : prev));
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
      // Not a real keystroke — xterm.js's own automatic reply to a terminal
      // capability query it just decoded out of replayed scrollback. See
      // `replaying`'s doc comment above for why this must not be forwarded.
      if (replaying) return;
      let payload = data;
      if (ctrlActiveRef.current) {
        const mapped = ctrlSequence(data);
        if (mapped) payload = mapped;
        setCtrlActive(false);
      }
      connection.sendInput(payload);
    });

    // Full-screen TUIs request the size; answer with the real one — unless this
    // is someone else's pane, in which case we are a guest and stay quiet. Also
    // stays quiet before the first `onAttached` — see `knowsAdoptedRef`'s doc
    // comment — since `adoptedRef.current` is not yet a real answer.
    const resizeDisposable = bundle.term.onResize(({ cols, rows }) => {
      lastSizeRef.current = { cols, rows };
      if (knowsAdoptedRef.current && (!adoptedRef.current || takeOverSizeRef.current)) {
        // `force` tells the server this is the deliberate "take over" opt-in
        // for an adopted pane, not this client's own guess — see
        // `ResizeMessage.force`'s doc comment. Harmless to send unconditionally
        // for a non-adopted session, which the server never checks it for.
        connection.sendResize(cols, rows, takeOverSizeRef.current);
      }
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
        // This runs *before* the socket attaches and is enough on its own to
        // satisfy the adopted-pane notice's `session?.adopted` condition, so
        // the stored opt-in has to be honoured here too — not only in
        // `onAttached`. See `hasStoredTakeOver`.
        if (hasStoredTakeOver(info)) {
          takeOverSizeRef.current = true;
          setTakeOverSize(true);
        }
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

    // A fixed-grid adopted pane (see onAttached) keeps the real pane's
    // dimensions; refitting it to the container on every window/orientation
    // resize would undo that and scramble the next full-screen redraw.
    if (adoptedRef.current && !takeOverSizeRef.current) return;

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
    // See `knowsAdoptedRef`'s doc comment: before the first `onAttached`,
    // `adoptedRef.current` is not yet a real answer, so this must stay quiet
    // rather than guess "not adopted" and push a size at what might turn out
    // to be someone else's shared pane.
    if (knowsAdoptedRef.current && (!adoptedRef.current || takeOverSizeRef.current)) {
      // Second argument is the wire-level opt-in `ResizeMessage.force` — an
      // unrelated "force" from this function's own `force` parameter above
      // (that one means "resend even if unchanged"; this one means "yes,
      // really resize a pane I do not own").
      conn.sendResize(cols, rows, takeOverSizeRef.current);
    }
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

  /**
   * Re-attach to the tmux pane this session adopted, without going back
   * through the Shell dialog's picker. `adoptTargetId` is the pane's own
   * stable id (see `SessionInfo.adoptTargetId`'s doc comment): the new
   * session this creates shares it with the one that just died here, so the
   * home screen's grouping (`representativeSessions` in `projects/index.ts`)
   * collapses the two into one chat instead of piling up a duplicate.
   */
  const reattach = useCallback(async () => {
    if (!session?.adoptTargetId) return;
    setReattaching(true);
    try {
      const created = await api.createSession({
        agent: session.agent,
        cwd: session.cwd,
        cols: session.cols,
        rows: session.rows,
        transport: 'terminal',
        adoptTargetId: session.adoptTargetId,
      });
      onResumed(created.id);
    } catch (err) {
      onApiError(err);
      setNotice(err instanceof ApiError ? err.message : 'Could not re-attach to that tmux session.');
      setReattaching(false);
    }
  }, [session, onApiError, onResumed]);

  const alive = !isTerminalStatus(status);
  const inputDisabled = !alive || connection !== 'connected';

  /**
   * True while this view is mirroring an adopted pane's grid instead of fitting
   * the viewport. Drives both the explanatory notice and the `fixed-grid`
   * sizing, from one expression, so the two cannot disagree about which mode
   * the terminal is in — and gated on `hasAttached` because until the server
   * answers, `applyFit` is still fitting the viewport (`adoptedRef` defaults to
   * false), so claiming a fixed grid then would describe the wrong mode.
   */
  const mirroringAdoptedPane = hasAttached && session?.adopted === true && !takeOverSize;

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
            {session?.adopted ? 'Detach' : 'Stop'}
          </button>
        )}
        {/* The tmux pane behind a detached/killed shell chat is usually still
            there — offer to rejoin it right where the status badge shows
            "Killed", instead of only from the Shell dialog's picker or the
            (easy to miss) button buried in the project tree. */}
        {!alive && session?.adoptTargetId && (
          <button type="button" className="icon-btn" onClick={() => void reattach()} disabled={reattaching}>
            {reattaching ? 'Re-attaching…' : 'Re-attach'}
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

      {mirroringAdoptedPane && session && (
        <div className="notice" role="status">
          Attached to your own tmux pane at {session.cols}×{session.rows}. Not resizing it —
          that would resize your terminal too.{' '}
          <button
            type="button"
            className="inline-link"
            onClick={() => {
              // Set the ref synchronously too: applyFit reads it immediately,
              // before this render's state update would otherwise land.
              takeOverSizeRef.current = true;
              setTakeOverSize(true);
              // Remembered by pane, not by this session id, so re-attaching
              // to the same pane later (a new session id every time — see
              // `adopted-size-prefs.ts`) does not ask again.
              if (session.adoptTargetId) setTakeOverSizePref(session.adoptTargetId);
              applyFit(true);
            }}
          >
            Fit to this screen anyway
          </button>
        </div>
      )}

      <div className={`terminal-host${mirroringAdoptedPane ? ' fixed-grid' : ''}`} ref={hostRef} />

      <MobileKeyBar
        onSend={sendRaw}
        ctrlActive={ctrlActive}
        onToggleCtrl={() => setCtrlActive((v) => !v)}
        disabled={inputDisabled}
      />

      <PromptBox sessionId={sessionId} onSend={sendPrompt} disabled={inputDisabled} />

      {confirmingStop && (
        <ConfirmDialog
          title={session?.adopted ? 'Detach from tmux session?' : 'Terminate this session?'}
          body={
            session?.adopted
              ? 'The terminal client will detach. Your tmux session will remain running.'
              : 'The running process will be stopped.'
          }
          confirmLabel={
            stopping
              ? session?.adopted
                ? 'Detaching…'
                : 'Stopping…'
              : session?.adopted
                ? 'Detach'
                : 'Terminate'
          }
          busy={stopping}
          onConfirm={() => void terminate()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}
