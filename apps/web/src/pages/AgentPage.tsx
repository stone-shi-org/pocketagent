import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AskUserQuestionAnswer,
  EffortLevel,
  PermissionDecision,
  PermissionRequestEvent,
  PromptImage,
  SessionInfo,
  SessionStatus,
} from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { TerminalConnection, type ConnectionState } from '../api/ws-client.js';
import {
  applyEvent,
  applyEvents,
  emptyTranscript,
  resolveCurrentModel,
  type TranscriptItem,
  type TranscriptState,
} from '../agent/transcript.js';
import { Transcript } from '../components/Transcript.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { PromptBox } from '../components/PromptBox.js';
import { ConnectionBadge, StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/Icon.js';
import { notifyApproval, notifyTurnComplete, ensureNotificationPermission } from '../agent/notifications.js';
import { takePendingPrompt, setPendingPrompt } from '../agent/pending-prompt.js';

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
  /** Navigates to a newly created session — see `resumeAndSend` below. */
  onResumed: (sessionId: string) => void;
}

/**
 * The structured counterpart to TerminalPage.
 *
 * Same session lifecycle, same reconnect machinery, same prompt box — the only
 * difference is that events are rendered as components instead of written into
 * a terminal emulator.
 */
export function AgentPage({ sessionId, onBack, onApiError, onResumed }: Props): JSX.Element {
  const connRef = useRef<TerminalConnection | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** Prior conversation, kept apart from the live transcript on purpose: a
      replay frame replaces the live one wholesale and would otherwise wipe it. */
  const [history, setHistory] = useState<TranscriptItem[]>([]);

  useEffect(() => {
    // Plain closure variable, not a ref: every handler below is recreated
    // together whenever this effect re-runs (on `sessionId` change), so they
    // always see the latest write here without the staleness a `session`
    // state read would have inside this same closure.
    let latestTitle: string | null = null;
    const conn = new TerminalConnection({
      handlers: {
        onConnectionState: setConnection,
        onAttached: (info) => {
          latestTitle = info.title;
          setSession(info);
          setStatus(info.status);
          setFatal(null);
        },
        onStatus: (next, info) => {
          setStatus(next);
          if (info) {
            latestTitle = info.title;
            setSession(info);
          }
        },
        onAgentEvent: (event) => {
          setTranscript((prev) => applyEvent(prev, event));
          if (event.kind === 'permission_request') {
            // Only fires when the tab is hidden; the sheet is enough otherwise.
            void notifyApproval(event.title, sessionId);
          }
          if (event.kind === 'turn_complete') {
            // Same tab-hidden gate as the approval alert above; a fully
            // detached client is covered by the server's own push instead.
            void notifyTurnComplete(latestTitle ?? 'Session', sessionId);
          }
        },
        onAgentReplay: (events, truncated) => {
          // Events are self-contained, so a truncated replay loses history but
          // never corrupts what remains — just rebuild from what we were given.
          setTranscript(applyEvents(emptyTranscript(), events));
          if (truncated) setNotice('Older messages were dropped from the server buffer.');
        },
        onPendingPermissions: (requests) => {
          setTranscript((prev) => mergePending(prev, requests));
        },
        onExit: () => {
          setStatus((prev) => (isTerminalStatus(prev) ? prev : 'exited'));
        },
        onError: (code, message) => {
          if (code === 'not_found') setFatal(message);
          else setNotice(message);
        },

        onFatal: setFatal,
      },
    });
    connRef.current = conn;
    conn.open(sessionId);
    void ensureNotificationPermission();

    return () => {
      conn.close();
      connRef.current = null;
    };
  }, [sessionId]);

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

  /**
   * Backstory for a resumed conversation.
   *
   * The agent keeps the history internally but never re-emits it, so without
   * this a resumed chat opens blank and looks like it lost everything. Prepended
   * rather than merged: these events happened before anything on this socket,
   * and they are the only ones that can be out of order with the live stream.
   */
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    api
      .sessionHistory(sessionId)
      .then(({ events }) => {
        if (cancelled || events.length === 0) return;
        setHistory(applyEvents(emptyTranscript(), events).items);
      })
      .catch(() => {
        /* history is a nicety; a session without it still works */
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const sendPrompt = useCallback((text: string, image?: PromptImage): boolean => {
    return connRef.current?.sendPrompt(text, image) ?? false;
  }, []);

  const setModel = useCallback((model: string) => {
    connRef.current?.sendModel(model);
  }, []);

  const setEffort = useCallback((effort: EffortLevel | null) => {
    connRef.current?.sendEffort(effort);
  }, []);

  const decide = useCallback(
    (decision: PermissionDecision, message?: string, answer?: AskUserQuestionAnswer) => {
      const request = transcript.pending[0];
      if (!request) return;
      setDeciding(true);
      connRef.current?.sendPermission(request.id, decision, message, answer);
      // Optimistically clear so the sheet closes immediately on a slow link;
      // the authoritative permission_resolved event follows.
      setTranscript((prev) => ({ ...prev, pending: prev.pending.slice(1) }));
      setTimeout(() => setDeciding(false), 250);
    },
    [transcript.pending],
  );

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
  // A stopped/exited session has no process left to send to, but the agent's
  // own conversation survives it — same fact `ProjectList.open` relies on to
  // resume a finished chat from the home screen. Continuing here does the
  // same thing: start a fresh session bound to that conversation and hand it
  // the prompt, rather than leaving the box disabled forever just because
  // *this* session ended. `forkSession: false` matches every other resume
  // path so this does not pile up duplicate chats.
  const canResume = !alive && !!session?.agentSessionId;
  const resumeAndSend = useCallback(
    (text: string, image?: PromptImage): boolean => {
      if (!session?.agentSessionId || resuming) return false;
      setResuming(true);
      void api
        .createSession({
          agent: session.agent,
          cwd: session.cwd,
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: session.agentSessionId,
          forkSession: false,
          title: session.title,
        })
        .then((created) => {
          setPendingPrompt(created.id, text, image);
          onResumed(created.id);
        })
        .catch((err) => {
          onApiError(err);
          setNotice(err instanceof ApiError ? err.message : 'Could not continue this chat.');
          setResuming(false);
        });
      return true;
    },
    [session, resuming, onApiError, onResumed],
  );

  const handleSend = useCallback(
    (text: string, image?: PromptImage): boolean =>
      alive ? sendPrompt(text, image) : resumeAndSend(text, image),
    [alive, sendPrompt, resumeAndSend],
  );

  const inputDisabled = alive ? connection !== 'connected' : !canResume || resuming;
  const pending = transcript.pending[0] ?? null;

  // A prompt typed on the composer is delivered once the socket is up. Taking
  // it is destructive — it can only be read once — so this waits until there is
  // somewhere to actually send it.
  useEffect(() => {
    if (inputDisabled) return;
    const queued = takePendingPrompt(sessionId);
    if (queued) sendPrompt(queued.text, queued.image);
  }, [inputDisabled, sessionId, sendPrompt]);

  // Same fallback as the composer's model picker (see `resolveCurrentModel`'s
  // doc comment) — without it the title bar showed nothing at all for an agy
  // session until the user explicitly switched models, since agy's `init`
  // line never reports one.
  const modelLabel = useMemo(
    () => resolveCurrentModel(transcript.models, transcript.model)?.displayName ?? null,
    [transcript.models, transcript.model],
  );

  const costLabel = useMemo(
    () => (transcript.totalCostUsd > 0 ? `$${transcript.totalCostUsd.toFixed(3)}` : null),
    [transcript.totalCostUsd],
  );

  return (
    <div className="terminal-page agent-page">
      <header className="topbar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back to sessions">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="title">
          <strong>{session?.title ?? sessionId}</strong>
          <span>
            {session ? `${session.agentDisplayName} · ${session.workspaceLabel}` : 'Loading…'}
            {modelLabel ? ` · ${modelLabel}` : ''}
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

      <div className="agent-strip">
        {transcript.files.length > 0 && (
          <button type="button" className="chip" onClick={() => setShowFiles((v) => !v)}>
            {transcript.files.length} file{transcript.files.length === 1 ? '' : 's'} touched
          </button>
        )}
        {costLabel && <span className="chip muted">{costLabel}</span>}
      </div>

      {showFiles && transcript.files.length > 0 && (
        <ul className="file-list">
          {transcript.files.map((file) => (
            <li key={file} title={file}>
              {file}
            </li>
          ))}
        </ul>
      )}

      {fatal && <div className="notice">{fatal}</div>}
      {!fatal && notice && (
        <div className="notice" onClick={() => setNotice(null)} role="status">
          {notice} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
        </div>
      )}
      {!fatal && connection === 'reconnecting' && (
        <div className="notice" role="status">
          Reconnecting… the agent keeps working.
        </div>
      )}

      <Transcript state={transcript} history={history} />

      {pending && (
        <ApprovalSheet
          request={pending}
          queued={transcript.pending.length - 1}
          onDecide={decide}
          disabled={deciding || connection !== 'connected'}
        />
      )}

      <PromptBox
        sessionId={sessionId}
        onSend={handleSend}
        disabled={inputDisabled}
        supportsImageAttachment={session?.transport === 'structured'}
        commands={transcript.commands}
        models={transcript.models}
        currentModel={transcript.model}
        onSetModel={setModel}
        effort={transcript.effort}
        onSetEffort={setEffort}
        busy={transcript.busy}
        onInterrupt={() => connRef.current?.sendInterrupt()}
      />

      {confirmingStop && (
        <ConfirmDialog
          title="Terminate this session?"
          body="The agent will be stopped."
          confirmLabel={stopping ? 'Stopping…' : 'Terminate'}
          busy={stopping}
          onConfirm={() => void terminate()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}

/** Re-add approvals reported at attach that we have not already seen. */
function mergePending(
  state: TranscriptState,
  requests: PermissionRequestEvent[],
): TranscriptState {
  const known = new Set(state.pending.map((p) => p.id));
  const extra = requests.filter((r) => !known.has(r.id));
  if (extra.length === 0) return state;
  return { ...state, pending: [...state.pending, ...extra] };
}
