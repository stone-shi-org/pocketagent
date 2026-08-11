import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSummary, HostInfo, ProjectInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { PushToggle } from '../components/PushToggle.js';
import { formatRelative } from '../components/StatusBadge.js';
import { filterProjects } from '../agent/search.js';

interface Props {
  onOpen: (sessionId: string) => void;
  onCompose: (cwd?: string) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}

const REFRESH_MS = 5000;

/**
 * Home screen: a folder per workspace directory, the chats inside it, and one
 * button to start another.
 *
 * The grouping is the point. A flat list of sessions answers "what is running",
 * which is a server's question; the thing you actually want on a phone is
 * "what was I doing on this project", and a chat that has finished is still an
 * answer to that. So live sessions and finished conversations sit in one list,
 * distinguished by a dot rather than by being filed somewhere else.
 */
export function ProjectsPage({ onOpen, onCompose, onApiError, onLogout }: Props): JSX.Element {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [resuming, setResuming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listProjects();
      setProjects(result.projects);
      setHost(result.host);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load projects.');
      setProjects([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /**
   * Open a chat.
   *
   * A live session opens directly. A finished one is a transcript, so it has to
   * be resumed first — as a new branch, which is the non-destructive choice and
   * therefore safe to do on a plain tap. Appending to the original transcript
   * needs a confirmation and lives in the advanced dialog.
   */
  const open = useCallback(
    async (chat: ChatSummary) => {
      if (chat.sessionId) {
        onOpen(chat.sessionId);
        return;
      }
      if (!chat.conversationId || resuming) return;

      setResuming(chat.id);
      try {
        const session = await api.createSession({
          agent: chat.agent ?? 'claude',
          cwd: projectOf(projects, chat)?.cwd ?? '',
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: chat.conversationId,
          forkSession: true,
          title: chat.title,
        });
        onOpen(session.id);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not resume that chat.');
      } finally {
        setResuming(null);
      }
    },
    [onOpen, onApiError, projects, resuming],
  );

  const visible = useMemo(() => filterProjects(projects ?? [], search), [projects, search]);
  const searching = search.trim().length > 0;

  return (
    <div className="app projects-page">
      <header className="home-bar">
        <div className="home-title">
          <strong>Remote</strong>
          {host && (
            <span className="host-chip">
              <span className={`host-dot${host.online ? '' : ' offline'}`} aria-hidden="true" />
              <span className="host-icon" aria-hidden="true">
                ▣
              </span>
              <span className="host-name">{host.name}</span>
            </span>
          )}
        </div>
        <button
          type="button"
          className="round-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More"
          aria-expanded={menuOpen}
        >
          ⋯
        </button>
        {menuOpen && (
          <OverflowMenu
            onClose={() => setMenuOpen(false)}
            onAdvanced={() => {
              setMenuOpen(false);
              setShowAdvanced(true);
            }}
            onRefresh={() => {
              setMenuOpen(false);
              void refresh();
            }}
            onLogout={onLogout}
          />
        )}
      </header>

      <div className="home-scroll">
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {projects === null && <div className="spinner">Loading…</div>}

        {projects !== null && (
          <h2 className="section-heading">{searching ? 'Results' : 'Projects'}</h2>
        )}

        {projects !== null && visible.length === 0 && (
          <div className="empty">
            {searching ? (
              <>No chats match “{search.trim()}”.</>
            ) : (
              <>
                Nothing here yet.
                <br />
                Tap the compose button to start a chat.
              </>
            )}
          </div>
        )}

        {visible.map((project) => {
          const isCollapsed = !searching && collapsed.has(project.cwd);
          return (
            <section key={project.cwd} className="project" data-project={project.cwd}>
              <div className="project-head">
                <button
                  type="button"
                  className="project-name"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(project.cwd)) next.delete(project.cwd);
                      else next.add(project.cwd);
                      return next;
                    })
                  }
                  aria-expanded={!isCollapsed}
                >
                  <span className="folder-icon" aria-hidden="true">
                    {isCollapsed ? '▸' : '▾'}
                  </span>
                  <span className="project-label">{project.name}</span>
                  {project.gitBranch && <span className="project-branch">{project.gitBranch}</span>}
                  {isCollapsed && <span className="project-count">{project.chats.length}</span>}
                </button>
                <button
                  type="button"
                  className="round-btn compose-in-project"
                  onClick={() => onCompose(project.cwd)}
                  aria-label={`New chat in ${project.name}`}
                >
                  ✎
                </button>
              </div>

              {!isCollapsed &&
                project.chats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className={`chat-row${chat.live ? ' live' : ''}`}
                    data-chat-id={chat.id}
                    onClick={() => void open(chat)}
                    disabled={resuming !== null}
                  >
                    <span className="chat-title">
                      {chat.live && <span className="live-dot" aria-label="running" />}
                      {chat.title}
                    </span>
                    <span className="chat-meta">
                      {resuming === chat.id
                        ? 'Resuming…'
                        : [
                            chat.live ? statusLabel(chat) : null,
                            formatRelative(chat.updatedAt),
                            chat.messageCount ? `${chat.messageCount} msgs` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                  </button>
                ))}
            </section>
          );
        })}
      </div>

      <div className="home-dock">
        <div className="search-pill">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
          />
          {searching && (
            <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              ×
            </button>
          )}
        </div>
        <PushToggle compact />
        <button
          type="button"
          className="compose-fab"
          onClick={() => onCompose()}
          aria-label="New chat"
        >
          ✎
        </button>
      </div>

      {showAdvanced && (
        <NewSessionDialog
          onCancel={() => setShowAdvanced(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowAdvanced(false);
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}

function OverflowMenu({
  onClose,
  onAdvanced,
  onRefresh,
  onLogout,
}: {
  onClose: () => void;
  onAdvanced: () => void;
  onRefresh: () => void;
  onLogout: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="menu-backdrop" onClick={onClose} role="presentation">
      <div className="menu" ref={ref} onClick={(e) => e.stopPropagation()} role="menu">
        <button type="button" role="menuitem" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" role="menuitem" onClick={onAdvanced}>
          More session options…
        </button>
        <button type="button" role="menuitem" className="danger" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function statusLabel(chat: ChatSummary): string {
  if (chat.status === 'starting') return 'starting';
  return chat.transport === 'structured' ? 'native' : 'terminal';
}

function projectOf(projects: ProjectInfo[] | null, chat: ChatSummary): ProjectInfo | undefined {
  return projects?.find((p) => p.chats.some((c) => c.id === chat.id));
}
