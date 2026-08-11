import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PermissionDecision,
  PermissionRequestEvent,
  SessionInfo,
  SessionStatus,
} from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { TerminalConnection, type ConnectionState } from '../api/ws-client.js';
import { applyEvent, applyEvents, emptyTranscript, type TranscriptState } from '../agent/transcript.js';
import { Transcript } from '../components/Transcript.js';
import { ApprovalSheet } from '../components/ApprovalSheet.js';
import { PromptBox } from '../components/PromptBox.js';
import { ConnectionBadge, StatusBadge } from '../components/StatusBadge.js';
import { notifyApproval, ensureNotificationPermission } from '../agent/notifications.js';

interface Props {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
}

/**
 * The structured counterpart to TerminalPage.
 *
 * Same session lifecycle, same reconnect machinery, same prompt box — the only
 * difference is that events are rendered as components instead of written into
 * a terminal emulator.
 */
export function AgentPage({ sessionId, onBack, onApiError }: Props): JSX.Element {
  const connRef = useRef<TerminalConnection | null>(null);
  const [transcript, setTranscript] = useState<TranscriptState>(emptyTranscript);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [status, setStatus] = useState<SessionStatus>('starting');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [fatal, setFatal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [showFiles, setShowFiles] = useState(false);

  useEffect(() => {
    const conn = new TerminalConnection({
      handlers: {
        onConnectionState: setConnection,
        onAttached: (info) => {
          setSession(info);
          setStatus(info.status);
          setFatal(null);
        },
        onStatus: (next, info) => {
          setStatus(next);
          if (info) setSession(info);
        },
        onAgentEvent: (event) => {
          setTranscript((prev) => applyEvent(prev, event));
          if (event.kind === 'permission_request') {
            // Only fires when the tab is hidden; the sheet is enough otherwise.
            void notifyApproval(event.title, sessionId);
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

  const sendPrompt = useCallback((text: string): boolean => {
    return connRef.current?.sendPrompt(text) ?? false;
  }, []);

  const decide = useCallback(
    (decision: PermissionDecision, message?: string) => {
      const request = transcript.pending[0];
      if (!request) return;
      setDeciding(true);
      connRef.current?.sendPermission(request.id, decision, message);
      // Optimistically clear so the sheet closes immediately on a slow link;
      // the authoritative permission_resolved event follows.
      setTranscript((prev) => ({ ...prev, pending: prev.pending.slice(1) }));
      setTimeout(() => setDeciding(false), 250);
    },
    [transcript.pending],
  );

  const terminate = useCallback(async () => {
    if (!window.confirm('Terminate this session? The agent will be stopped.')) return;
    try {
      await api.deleteSession(sessionId);
    } catch (err) {
      onApiError(err);
    }
  }, [sessionId, onApiError]);

  const alive = !isTerminalStatus(status);
  const inputDisabled = !alive || connection !== 'connected';
  const pending = transcript.pending[0] ?? null;

  const costLabel = useMemo(
    () => (transcript.totalCostUsd > 0 ? `$${transcript.totalCostUsd.toFixed(3)}` : null),
    [transcript.totalCostUsd],
  );

  return (
    <div className="terminal-page">
      <header className="topbar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to sessions">
          ‹
        </button>
        <div className="title">
          <strong>{session?.title ?? sessionId}</strong>
          <span>
            {session ? `${session.agentDisplayName} · ${session.workspaceLabel}` : 'Loading…'}
            {transcript.model ? ` · ${transcript.model}` : ''}
          </span>
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <ConnectionBadge state={connection} />
          <StatusBadge status={status} />
        </div>
        {alive && (
          <button type="button" className="danger icon-btn" onClick={() => void terminate()}>
            Stop
          </button>
        )}
      </header>

      <div className="agent-strip">
        {transcript.files.length > 0 && (
          <button type="button" className="chip" onClick={() => setShowFiles((v) => !v)}>
            {transcript.files.length} file{transcript.files.length === 1 ? '' : 's'} touched
          </button>
        )}
        {costLabel && <span className="chip muted">{costLabel}</span>}
        {transcript.busy && (
          <button
            type="button"
            className="chip danger-chip"
            onClick={() => connRef.current?.sendInterrupt()}
            disabled={inputDisabled}
          >
            Stop generating
          </button>
        )}
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

      <Transcript state={transcript} />

      {pending && (
        <ApprovalSheet
          request={pending}
          queued={transcript.pending.length - 1}
          onDecide={decide}
          disabled={deciding || connection !== 'connected'}
        />
      )}

      <PromptBox sessionId={sessionId} onSend={sendPrompt} disabled={inputDisabled} />
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
