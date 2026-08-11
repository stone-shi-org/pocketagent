import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { StatusBadge, formatRelative } from '../components/StatusBadge.js';
import { PushToggle } from '../components/PushToggle.js';

interface Props {
  onOpen: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}

export function SessionListPage({ onOpen, onApiError, onLogout }: Props): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listSessions();
      setSessions(result.sessions);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load sessions.');
      setSessions([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function terminate(id: string): Promise<void> {
    if (!window.confirm('Terminate this session? The running process will be stopped.')) return;
    try {
      await api.deleteSession(id);
    } catch (err) {
      onApiError(err);
    } finally {
      void refresh();
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">
          <strong>PocketAgent</strong>
          <span>{sessions ? `${sessions.length} session(s)` : 'Loading…'}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onLogout}>
          Sign out
        </button>
      </header>

      <div className="list-scroll">
        <div className="list-actions">
          <button type="button" className="primary" onClick={() => setShowNew(true)}>
            + New session
          </button>
          <button type="button" onClick={() => void refresh()}>
            Refresh
          </button>
          <PushToggle />
        </div>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {sessions === null && <div className="spinner">Loading sessions…</div>}

        {sessions?.length === 0 && (
          <div className="empty">
            No sessions yet.
            <br />
            Start one to get a terminal on this machine.
          </div>
        )}

        {sessions?.map((session) => (
          <div key={session.id} className="session-card" data-session-id={session.id}>
            <button type="button" className="meta" onClick={() => onOpen(session.id)}>
              <div className="name">{session.title}</div>
              <div className="detail">
                {session.agentDisplayName} · {session.workspaceLabel}
                {session.transport === 'structured' ? ' · native' : ' · terminal'}
              </div>
              <div className="detail">
                created {formatRelative(session.createdAt)}
                {session.lastActivityAt ? ` · active ${formatRelative(session.lastActivityAt)}` : ''}
                {session.attachedClients > 0 ? ` · ${session.attachedClients} viewer(s)` : ''}
              </div>
            </button>

            <div className="row" style={{ flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
              <StatusBadge status={session.status} />
              {!isTerminalStatus(session.status) && (
                <button
                  type="button"
                  className="danger icon-btn"
                  onClick={() => void terminate(session.id)}
                  aria-label={`Terminate ${session.title}`}
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showNew && (
        <NewSessionDialog
          onCancel={() => setShowNew(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowNew(false);
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}
