import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { AgentCard } from '../components/AgentCard.js';
import { Icon } from '../components/Icon.js';

const REFRESH_MS = 4000;

interface Props {
  /** Opens the session's own full view — same click-to-open as `RunningSessions`. */
  onOpen: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route, which has no sidebar to fall back to —
   * `DesktopShell` renders this in its right pane with the sidebar already
   * on screen, so it passes nothing here. Same "shared content, per-shell
   * chrome" split as `ProjectList`.
   */
  onBack?: () => void;
}

/**
 * The "Agents" fleet view: every agent running right now, as a card with a
 * mascot, a busy/idle dot, a live output preview, and — best-effort, for
 * structured sessions with an in-flight `Task` call — connected sub-agent
 * chips. Shared between `DesktopShell`'s right pane and the phone's
 * full-screen route, same convention as `ProjectList` being shared between
 * the two shells' layouts.
 *
 * Polls `listSessions` on its own timer, same shape as `RunningSessions` and
 * for the same reason: this has to stay live regardless of whether the
 * sidebar's own list is even mounted.
 */
export function AgentsFleetPage({ onOpen, onApiError, onBack }: Props): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof ApiError ? err.message : 'Could not load agents.');
      setSessions([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const content = (
    <div className="fleet-page">
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {sessions === null && <div className="spinner">Loading…</div>}

      {sessions?.length === 0 && <div className="fleet-empty">No agents running right now.</div>}

      {sessions && sessions.length > 0 && (
        <div className="fleet-grid">
          {sessions.map((session) => (
            // Keyed on id alone: `AgentCard` owns a live WS attach per card,
            // and a session that ends just falls out of the next poll.
            <AgentCard key={session.id} session={session} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );

  if (!onBack) return content;

  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Agents</strong>
        </div>
      </header>
      {content}
    </div>
  );
}
