import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { AgentCard } from '../components/AgentCard.js';
import { fleetSummary, groupFleet } from '../agent/fleet-groups.js';
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
 * The "Agents" fleet view: everything running right now, as a card with a
 * mascot, a busy/idle dot, a live output preview, and — best-effort, for
 * structured sessions with an in-flight `Task` call — connected sub-agent
 * chips. Shared between `DesktopShell`'s right pane and the phone's
 * full-screen route, same convention as `ProjectList` being shared between
 * the two shells' layouts.
 *
 * Cards are grouped by transport — agents, then terminal sessions — because
 * the two are not the same kind of thing and one flat grid claimed they were
 * (PA-22). `groupFleet` owns that rule; see its doc comment for why the split
 * is the transport rather than tmux-vs-not.
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

  const groups = sessions ? groupFleet(sessions) : [];

  const content = (
    <div className="fleet-page">
      <div className="fleet-header">
        {/* The phone shell's own `.home-bar` already says "Agents" above this;
            repeating the word right below it would just be noise there. */}
        {!onBack && <h1>Agents</h1>}
        <span className="fleet-count">{sessions === null ? 'Loading…' : fleetSummary(sessions)}</span>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {sessions === null && <div className="spinner">Loading…</div>}

      {/* "Nothing", not "no agents": a terminal session is not an agent, which
          is the whole point of the grouping below. */}
      {sessions?.length === 0 && <div className="fleet-empty">Nothing running right now.</div>}

      {groups.map((group) => (
        <section className="fleet-section" key={group.key}>
          <div className="fleet-section-head">
            <h2>
              <Icon name={group.icon} size={16} />
              {group.title}
              <span className="fleet-section-count">{group.sessions.length}</span>
            </h2>
            <p className="fleet-section-hint">{group.hint}</p>
          </div>
          <div className="fleet-grid">
            {group.sessions.map((session) => (
              // Keyed on id alone: `AgentCard` owns a live WS attach per card,
              // and a session that ends just falls out of the next poll. The
              // key is not prefixed with the group either, so a session that
              // somehow changed transport would keep its card rather than
              // remounting (and so re-attaching) its WebSocket.
              <AgentCard
                key={session.id}
                session={session}
                onOpen={onOpen}
                onApiError={onApiError}
                onStopped={() => void load()}
              />
            ))}
          </div>
        </section>
      ))}
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
