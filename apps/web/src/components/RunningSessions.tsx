import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { formatRelative } from './StatusBadge.js';

const REFRESH_MS = 4000;

/**
 * Every agent that is actually alive right now, flattened across every
 * project folder — independent of what is collapsed, hidden, or past the chat
 * list's page limit in `ProjectList`. That list answers "what was I doing";
 * this one answers "what is still running and occupying a slot", and with
 * enough sessions going across enough folders those stop being the same
 * question. Polls on its own timer rather than reusing `useProjects`, since
 * it needs to stay live while open regardless of whether the sidebar list is
 * even mounted (the phone layout unmounts it behind this dialog).
 */
export function RunningSessions({
  onClose,
  onOpen,
  onApiError,
}: {
  onClose: () => void;
  /** Opens the session and closes this dialog. */
  onOpen: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmSession, setConfirmSession] = useState<SessionInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const { sessions: all } = await api.listSessions();
      const alive = all
        .filter((s) => !isTerminalStatus(s.status))
        .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
      setSessions(alive);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load sessions.');
      setSessions([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // The confirm dialog's own Escape handler owns this key while it is open.
      if (e.key === 'Escape' && !confirmSession) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmSession]);

  /** Same confirm wording as the per-session Stop button, for one behaviour. */
  const stop = useCallback(
    async (session: SessionInfo) => {
      setBusyId(session.id);
      try {
        await api.deleteSession(session.id);
        await load();
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not stop that session.');
      } finally {
        setBusyId(null);
        setConfirmSession(null);
      }
    },
    [load, onApiError],
  );

  return (
    <div className="dialog-backdrop" onClick={confirmSession ? undefined : onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Active sessions"
      >
        <h2>Active sessions{sessions && sessions.length > 0 ? ` (${sessions.length})` : ''}</h2>
        <p className="transport-hint">
          Every agent running right now, across every project — regardless of what is collapsed
          or hidden in the list. Stop one here if you have lost track of it.
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {sessions === null && <div className="spinner">Loading…</div>}

        {sessions?.length === 0 && <div className="empty">Nothing is running right now.</div>}

        {sessions && sessions.length > 0 && (
          <div className="pick-list">
            {sessions.map((session) => (
              <div key={session.id} className="hidden-row">
                <button
                  type="button"
                  className="pick-main"
                  onClick={() => {
                    onOpen(session.id);
                    onClose();
                  }}
                >
                  <div className="pick-title">
                    <span className="live-dot" aria-hidden="true" />
                    {session.title}
                  </div>
                  <div className="pick-detail">
                    {session.agentDisplayName} · {session.workspaceLabel}
                    {session.pid ? ` · pid ${session.pid}` : ''} · started{' '}
                    {formatRelative(session.startedAt ?? session.createdAt)}
                  </div>
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => setConfirmSession(session)}
                  disabled={busyId !== null}
                >
                  {busyId === session.id ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>

      {confirmSession && (
        <ConfirmDialog
          title={`Stop “${confirmSession.title}”?`}
          body="The agent will be terminated."
          confirmLabel={busyId === confirmSession.id ? 'Stopping…' : 'Stop'}
          busy={busyId === confirmSession.id}
          onConfirm={() => void stop(confirmSession)}
          onCancel={() => setConfirmSession(null)}
        />
      )}
    </div>
  );
}
