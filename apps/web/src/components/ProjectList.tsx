import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatSummary, HostInfo, ProjectInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { filterProjects } from '../agent/search.js';

const REFRESH_MS = 5000;

/** Chats shown per project before a "show more" row appears. */
const CHAT_PAGE_SIZE = 5;

export interface ProjectsState {
  projects: ProjectInfo[] | null;
  host: HostInfo | null;
  error: string | null;
  resuming: string | null;
  refresh: () => Promise<void>;
  open: (chat: ChatSummary) => Promise<void>;
  removeChat: (chat: ChatSummary) => Promise<void>;
  clearFinished: (project: ProjectInfo) => Promise<void>;
  hideProject: (cwd: string) => Promise<void>;
  removeProject: (cwd: string) => Promise<void>;
}

/**
 * Loading, polling and opening — everything about the chat list except how it
 * looks.
 *
 * Split out because the phone screen and the desktop sidebar show the same list
 * and must not drift: two copies of "tapping a finished chat resumes it as a
 * branch" is one copy too many for a rule with that much behind it.
 */
export function useProjects(
  onOpen: (sessionId: string) => void,
  onApiError: (error: unknown) => void,
): ProjectsState {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
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
   * Only a *live* session is opened directly. A finished one has no process to
   * attach to — after a server restart it is a database row and nothing else —
   * so what the tap means is "continue this", and continuing means resuming the
   * conversation. Resuming branches, which is non-destructive and therefore
   * safe on a plain tap; appending to the original transcript needs a
   * confirmation and lives in the advanced dialog.
   *
   * A finished chat with no conversation behind it (a plain shell, say) has
   * nothing to continue. It still opens, so its final state is reachable.
   */
  const open = useCallback(
    async (chat: ChatSummary) => {
      if (chat.sessionId && (chat.live || !chat.conversationId)) {
        onOpen(chat.sessionId);
        return;
      }
      if (!chat.conversationId || resuming) return;

      setResuming(chat.id);
      try {
        const session = await api.createSession({
          agent: chat.agent ?? 'claude',
          cwd: projects?.find((p) => p.chats.some((c) => c.id === chat.id))?.cwd ?? '',
          cols: 80,
          rows: 24,
          transport: 'structured',
          resumeAgentSessionId: chat.conversationId,
          forkSession: false,
          title: chat.title,
        });
        await refresh();
        onOpen(session.id);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not resume that chat.');
      } finally {
        setResuming(null);
      }
    },
    [onOpen, onApiError, projects, resuming, refresh],
  );

  /**
   * Drop a chat from the list.
   *
   * Removal, not deletion: the session record goes and the conversation is
   * remembered as removed, but the transcript stays on disk and stays resumable
   * from a terminal. Running chats are refused by the server rather than killed
   * out from under whatever they are doing.
   */
  const removeChat = useCallback(
    async (chat: ChatSummary) => {
      try {
        await api.removeChat({
          ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
          ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
        });
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not remove that chat.');
      } finally {
        await refresh();
      }
    },
    [onApiError, refresh],
  );

  const clearFinished = useCallback(
    async (project: ProjectInfo) => {
      try {
        await api.clearFinished(project.cwd);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not clear that project.');
      } finally {
        await refresh();
      }
    },
    [onApiError, refresh],
  );

  const hideProject = useCallback(
    async (cwd: string) => {
      try {
        await api.hideProject(cwd);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not hide that project.');
      } finally {
        await refresh();
      }
    },
    [onApiError, refresh],
  );

  /** Stop treating a folder as a project. Nothing on disk changes. */
  const removeProject = useCallback(
    async (cwd: string) => {
      try {
        await api.removeWorkspace(cwd);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not remove that folder.');
      } finally {
        await refresh();
      }
    },
    [onApiError, refresh],
  );

  return {
    projects,
    host,
    error,
    resuming,
    refresh,
    open,
    removeChat,
    clearFinished,
    hideProject,
    removeProject,
  };
}

interface ListProps {
  state: ProjectsState;
  search: string;
  onCompose: (cwd: string) => void;
  /** Highlighted in the sidebar so you can see which chat you are reading. */
  activeSessionId?: string | null;
  /** Wording differs: one is tapped, the other clicked. */
  emptyHint: string;
  onAddProject: () => void;
}

/** The folders and their chats. Presentation only; state comes from above. */
export function ProjectList({
  state,
  search,
  onCompose,
  activeSessionId,
  emptyHint,
  onAddProject,
}: ListProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedChats, setExpandedChats] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const { projects, resuming, open } = state;

  const visible = useMemo(() => filterProjects(projects ?? [], search), [projects, search]);
  const searching = search.trim().length > 0;

  const toggle = (cwd: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });

  const showMoreChats = (cwd: string): void =>
    setExpandedChats((prev) => new Set(prev).add(cwd));

  return (
    <>
      {projects === null && <div className="spinner">Loading…</div>}

      {projects !== null && (
        <h2 className="section-heading">{searching ? 'Results' : 'Projects'}</h2>
      )}

      {projects !== null && visible.length === 0 && (
        <div className="empty">
          {searching ? <>No chats match “{search.trim()}”.</> : emptyHint}
        </div>
      )}

      {visible.map((project) => {
        // A search that hid a folder's other chats should not also hide the
        // ones it matched, so collapsing is ignored while searching.
        const isCollapsed = !searching && collapsed.has(project.cwd);
        return (
          <section key={project.cwd} className="project" data-project={project.cwd}>
            <div className="project-head">
              <button
                type="button"
                className="project-name"
                onClick={() => toggle(project.cwd)}
                aria-expanded={!isCollapsed}
              >
                <Icon name="folder" className="folder" />
                <span className="project-label">{project.name}</span>
                <Icon
                  name="chevron-down"
                  className={`project-caret${isCollapsed ? ' closed' : ''}`}
                />
                {isCollapsed && <span className="project-count">{project.chats.length}</span>}
              </button>
              <button
                type="button"
                className="round-btn plain"
                onClick={() => onCompose(project.cwd)}
                aria-label={`New chat in ${project.name}`}
                title={`New chat in ${project.name}`}
              >
                <Icon name="compose" size={19} />
              </button>
              <button
                type="button"
                className="round-btn plain"
                onClick={() => setMenuFor(menuFor === project.cwd ? null : project.cwd)}
                aria-label={`Options for ${project.name}`}
                aria-expanded={menuFor === project.cwd}
              >
                <Icon name="ellipsis" size={18} />
              </button>
              {menuFor === project.cwd && (
                <ProjectMenu
                  project={project}
                  onClose={() => setMenuFor(null)}
                  onClear={() => {
                    setMenuFor(null);
                    void state.clearFinished(project);
                  }}
                  onHide={() => {
                    setMenuFor(null);
                    void state.hideProject(project.cwd);
                  }}
                  onRemove={() => {
                    setMenuFor(null);
                    void state.removeProject(project.cwd);
                  }}
                />
              )}
            </div>

            {!isCollapsed && project.chats.length === 0 && (
              <div className="project-empty">No chats yet</div>
            )}

            {(() => {
              // A search that hid a folder's other chats already narrowed
              // this to what matched, so the page limit only applies while
              // browsing — truncating a search result would hide a hit.
              const isExpanded = searching || expandedChats.has(project.cwd);
              const shown = isExpanded ? project.chats : project.chats.slice(0, CHAT_PAGE_SIZE);
              const remaining = project.chats.length - shown.length;
              return (
                !isCollapsed && (
                  <>
                    {shown.map((chat) => (
                      <div key={chat.id} className={`chat-line${chat.live ? ' live' : ''}`}>
                      <button
                        type="button"
                        className={[
                          'chat-row',
                          chat.live ? 'live' : '',
                          resuming === chat.id ? 'pending' : '',
                          activeSessionId && chat.sessionId === activeSessionId ? 'active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        data-chat-id={chat.id}
                        onClick={() => void open(chat)}
                        disabled={resuming !== null}
                        title={chat.title}
                      >
                        <span className="chat-title">
                          {chat.live && <span className="live-dot" aria-label="running" />}
                          {resuming === chat.id ? 'Resuming…' : chat.title}
                        </span>
                      </button>
                      {/* Running chats have no remove: stop them first, so the
                          process is never orphaned by losing its record. */}
                      {!chat.live && (
                        <button
                          type="button"
                          className="chat-remove"
                          onClick={() => void state.removeChat(chat)}
                          aria-label={`Remove ${chat.title} from the list`}
                          title="Remove from list"
                        >
                          <Icon name="close" size={14} />
                        </button>
                      )}
                      </div>
                    ))}
                    {remaining > 0 && (
                      <button
                        type="button"
                        className="chats-more"
                        onClick={() => showMoreChats(project.cwd)}
                      >
                        <Icon name="chevron-down" size={16} />
                        Show {remaining} more
                      </button>
                    )}
                  </>
                )
              );
            })()}
          </section>
        );
      })}

      {!searching && projects !== null && (
        <button type="button" className="add-project" onClick={onAddProject}>
          <Icon name="folder" size={17} />
          Add a project folder
        </button>
      )}
    </>
  );
}

/** Header chip naming the machine these projects live on. */
export function HostChip({ host }: { host: HostInfo | null }): JSX.Element | null {
  if (!host) return null;
  return (
    <span className="host-chip">
      <span className={`host-dot${host.online ? '' : ' offline'}`} aria-hidden="true" />
      <Icon name="terminal" />
      <span className="host-name">{host.name}</span>
    </span>
  );
}

/** Search field. Same control in the dock and in the sidebar. */
export function SearchField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="search-pill">
      <Icon name="search" size={18} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search chats"
        aria-label="Search chats"
      />
      {value.trim().length > 0 && (
        <button
          type="button"
          className="search-clear"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <Icon name="close" size={13} />
        </button>
      )}
    </div>
  );
}

/** Per-folder actions. Both are reversible-ish; neither touches a transcript. */
function ProjectMenu({
  project,
  onClose,
  onClear,
  onHide,
  onRemove,
}: {
  project: ProjectInfo;
  onClose: () => void;
  onClear: () => void;
  onHide: () => void;
  onRemove: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const finished = project.chats.filter((c) => !c.live).length;

  // The backdrop stays fixed to the viewport to catch the outside click, but
  // the menu itself is positioned against the folder row it belongs to.
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} role="presentation" />
      <div className="menu project-menu" role="menu">
        <button type="button" role="menuitem" disabled={finished === 0} onClick={onClear}>
          {finished === 0
            ? 'Nothing finished to clear'
            : `Clear ${finished} finished chat${finished === 1 ? '' : 's'}`}
        </button>
        {/* A folder you added can be removed outright. A directory that merely
            had a session run in it is not yours to remove — only to hide. */}
        {project.isWorkspace ? (
          <button type="button" role="menuitem" onClick={onRemove}>
            Remove this folder
          </button>
        ) : (
          <button type="button" role="menuitem" onClick={onHide}>
            Hide this project
          </button>
        )}
      </div>
    </>
  );
}
