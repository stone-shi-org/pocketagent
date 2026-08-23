import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChatSummary, HostInfo, ProjectInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { filterProjects } from '../agent/search.js';

const REFRESH_MS = 5000;

/** Chats shown per project before a "show more" row appears. */
const CHAT_PAGE_SIZE = 5;

/**
 * A deep link into code-server for a project's folder, or null if no
 * code-server base URL is configured for this host (`HostInfo.codeServerBaseUrl`)
 * — see `POCKETAGENT_CODE_SERVER_URL` in `.env.example`. code-server opens the
 * folder named in `?folder=`, appended to whatever path it is served under.
 */
function codeServerLink(base: string, cwd: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return `${root}?folder=${encodeURIComponent(cwd)}`;
}

/**
 * A folder's basename, narrowed to the characters a real tmux session name
 * may use (`AdoptionService`'s `TMUX_NAME_PATTERN`, a conservative printable
 * subset — not tmux's own much looser rules). Anything else — most often
 * spaces are fine but punctuation like `()[]` shows up in real folder names —
 * becomes `-` rather than failing "New tmux session" outright over a name
 * tmux itself would likely accept from a terminal anyway.
 */
function tmuxNameFor(projectName: string): string {
  const cleaned = projectName.replace(/[^A-Za-z0-9 ._-]/g, '-').trim();
  return (cleaned || 'session').slice(0, 64);
}

/** Every chat in a project and its folded worktrees, flattened. */
function allChats(projects: ProjectInfo[]): ChatSummary[] {
  const out: ChatSummary[] = [];
  for (const project of projects) {
    out.push(...project.chats, ...allChats(project.worktrees));
  }
  return out;
}

export interface ProjectsState {
  projects: ProjectInfo[] | null;
  host: HostInfo | null;
  error: string | null;
  refresh: () => Promise<void>;
  open: (chat: ChatSummary) => void;
  removeChat: (chat: ChatSummary) => Promise<void>;
  detachChat: (chat: ChatSummary) => Promise<void>;
  reattachChat: (chat: ChatSummary) => Promise<void>;
  newTmuxSession: (project: ProjectInfo) => Promise<void>;
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
  onOpenChat: (conversationId: string) => void,
  onApiError: (error: unknown) => void,
): ProjectsState {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [host, setHost] = useState<HostInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

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
   * A live session is opened directly — there is a process to attach to. A
   * finished one has none: after a server restart it is a database row and
   * nothing else, and resuming it used to happen right here, on the tap
   * itself — a real agent process spun up for every idle look at old history,
   * and (per `projects/index.ts`'s home-screen merge rule) that transcript's
   * row would show as live with nothing ever said to it. `onOpenChat` instead
   * opens a read-only preview of the transcript; resuming — as a branch,
   * `forkSession: false`, same as ever — happens only once a prompt is
   * actually typed there, in `ChatPreviewPage`.
   *
   * A finished chat with no conversation behind it (a plain shell, say) has
   * nothing to preview or continue. It still opens by session id, so its
   * final state is reachable.
   *
   * The preview route only ever works for Claude: `onOpenChat` leads to
   * `ChatPreviewPage`, which reads `GET /api/conversations/:id/history` —
   * and that endpoint only discovers Claude Code's on-disk `.jsonl`
   * transcripts (`conversations/index.ts`). A finished chat from any other
   * agent (e.g. `agy`) has a `conversationId` too (its own agent-session id,
   * for `resumeAgentSessionId`), but no transcript there to read — routing it
   * to the preview page 404s and leaves it stuck with no way to continue.
   * It still has a session row, though, so send it to `AgentPage` instead;
   * that page's own `resumeAndSend` already resumes any agent generically
   * from `SessionInfo.agentSessionId`.
   */
  const open = useCallback(
    (chat: ChatSummary) => {
      if (chat.sessionId && (chat.live || chat.agent !== 'claude' || !chat.conversationId)) {
        onOpen(chat.sessionId);
        return;
      }
      if (chat.conversationId) onOpenChat(chat.conversationId);
    },
    [onOpen, onOpenChat],
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

  const detachChat = useCallback(
    async (chat: ChatSummary) => {
      if (chat.sessionId) {
        try {
          await api.deleteSession(chat.sessionId);
        } catch (err) {
          onApiError(err);
          setError(err instanceof ApiError ? err.message : 'Could not detach that session.');
        } finally {
          await refresh();
        }
      }
    },
    [onApiError, refresh],
  );

  /**
   * Re-attach to the tmux pane behind a finished Shell chat, in place —
   * without going back through the Shell dialog's picker. `adoptTargetId` is
   * the pane's own stable id (see `SessionInfo.adoptTargetId`'s doc comment),
   * so the server resolves the same pane it was ever attached to; the new
   * session row this creates shares that id, so the home screen's grouping
   * (`representativeSessions` in `projects/index.ts`) collapses it with the
   * old, now-superseded row into the same chat rather than adding a second
   * one. `cwd` here is a placeholder: `POST /api/sessions` overwrites it with
   * the resolved target's real directory before doing anything else.
   */
  const reattachChat = useCallback(
    async (chat: ChatSummary) => {
      if (!chat.adoptTargetId) return;
      try {
        const created = await api.createSession({
          agent: 'shell',
          cwd: 'virtual:shell',
          cols: 80,
          rows: 24,
          transport: 'terminal',
          adoptTargetId: chat.adoptTargetId,
        });
        onOpen(created.id);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not re-attach to that tmux session.');
      } finally {
        await refresh();
      }
    },
    [onApiError, onOpen, refresh],
  );

  /**
   * "New tmux session" from a project's three-dot menu: a real, human-visible
   * tmux session named after the folder, rooted in it — not PocketAgent's own
   * private backend (`backends/tmux.ts`'s `pocketagent-<id>` sessions), the
   * same `AdoptionService` socket the Shell dialog's picker and free-form
   * "create" already use.
   *
   * Idempotent by name rather than by some id the client remembers: a second
   * tap (or one from another tab) finds the same tmux session already exists
   * and reattaches to it — or, if a session is already live for it, just
   * opens that instead of spawning a second attaching client — rather than
   * erroring or leaving an orphaned attach process behind.
   */
  const newTmuxSession = useCallback(
    async (project: ProjectInfo) => {
      const name = tmuxNameFor(project.name);
      try {
        let target = (await api.listAdoptable(true)).targets.find((t) => t.sessionName === name);

        if (!target) {
          try {
            target = await api.createAdoptableSession(name, project.cwd);
          } catch (err) {
            // Lost a race with another tab (or another poll of this same
            // action) creating the same name between the list above and this
            // call — the session it made is exactly as good as the one this
            // call would have made, so look it up instead of failing.
            if (err instanceof ApiError && err.status === 409) {
              target = (await api.listAdoptable(true)).targets.find((t) => t.sessionName === name);
            }
            if (!target) throw err;
          }
        }

        const live = allChats(projects ?? []).find(
          (chat) => chat.live && chat.adoptTargetId === target!.id,
        );
        if (live?.sessionId) {
          onOpen(live.sessionId);
          return;
        }

        const created = await api.createSession({
          agent: 'shell',
          cwd: 'virtual:shell',
          cols: 80,
          rows: 24,
          transport: 'terminal',
          adoptTargetId: target.id,
        });
        onOpen(created.id);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not start that tmux session.');
      } finally {
        await refresh();
      }
    },
    [onApiError, onOpen, projects, refresh],
  );

  return {
    projects,
    host,
    error,
    refresh,
    open,
    removeChat,
    detachChat,
    reattachChat,
    newTmuxSession,
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
  /** Same highlight, for a chat opened as a preview that has no session yet. */
  activeConversationId?: string | null;
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
  activeConversationId,
  emptyHint,
  onAddProject,
}: ListProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expandedChats, setExpandedChats] = useState<Set<string>>(() => new Set());
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const { projects, open } = state;

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

  // Collapse, "show more" and the open menu are all keyed by whichever
  // project's own `cwd` they belong to — a folded worktree has its own real
  // cwd, so the same `Set`/nullable-string state that already tracks
  // top-level projects tracks worktree rows for free, with no parallel state
  // to keep in sync.
  const sectionProps = {
    state,
    open,
    searching,
    collapsed,
    toggle,
    expandedChats,
    showMoreChats,
    menuFor,
    setMenuFor,
    onCompose,
    activeSessionId,
    activeConversationId,
  };

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

      {visible.map((project) => (
        <ProjectSection key={project.cwd} project={project} nested={false} {...sectionProps} />
      ))}

      {!searching && projects !== null && (
        <button type="button" className="add-project" onClick={onAddProject}>
          <Icon name="folder" size={17} />
          Add a project folder
        </button>
      )}
    </>
  );
}

interface ProjectSectionProps {
  project: ProjectInfo;
  /** A folded worktree renders smaller and indented under its main checkout. */
  nested: boolean;
  state: ProjectsState;
  open: (chat: ChatSummary) => void;
  searching: boolean;
  collapsed: Set<string>;
  toggle: (cwd: string) => void;
  expandedChats: Set<string>;
  showMoreChats: (cwd: string) => void;
  menuFor: string | null;
  setMenuFor: (cwd: string | null) => void;
  onCompose: (cwd: string) => void;
  activeSessionId?: string | null;
  activeConversationId?: string | null;
}

/**
 * One project's card: its head, its chats, and — unless this section is
 * itself a worktree — any of its own worktrees, each rendered as another
 * `ProjectSection` one level down. Worktrees never nest further (see
 * `ProjectInfo.worktrees`'s doc comment for why), so recursion here always
 * bottoms out after one level; `nested` only exists to vary presentation.
 */
function ProjectSection({
  project,
  nested,
  state,
  open,
  searching,
  collapsed,
  toggle,
  expandedChats,
  showMoreChats,
  menuFor,
  setMenuFor,
  onCompose,
  activeSessionId,
  activeConversationId,
}: ProjectSectionProps): JSX.Element {
  // A search that hid a folder's other chats should not also hide the ones it
  // matched, so collapsing is ignored while searching.
  const isCollapsed = !searching && collapsed.has(project.cwd);

  // The virtual Shell "project" has no real folder on disk, so there is
  // nothing for code-server to open.
  const codeServerBase = state.host?.codeServerBaseUrl;
  const codeServerHref =
    codeServerBase && project.cwd !== 'virtual:shell'
      ? codeServerLink(codeServerBase, project.cwd)
      : null;

  return (
    <section
      className={`project${nested ? ' project--worktree' : ''}`}
      data-project={project.cwd}
    >
      <div className="project-head">
        <button
          type="button"
          className="project-name"
          onClick={() => toggle(project.cwd)}
          aria-expanded={!isCollapsed}
        >
          <Icon name={project.cwd === 'virtual:shell' ? 'agent-shell' : nested ? 'branch' : 'folder'} className="folder" />
          <span className="project-label">
            {nested ? project.gitBranch ?? project.name : project.name}
          </span>
          <Icon name="chevron-down" className={`project-caret${isCollapsed ? ' closed' : ''}`} />
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
        {codeServerHref && (
          <a
            className="round-btn plain"
            href={codeServerHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${project.name} in code-server`}
            title={`Open ${project.name} in code-server`}
          >
            <Icon name="code" size={19} />
          </a>
        )}
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
            onNewTmuxSession={
              project.cwd === 'virtual:shell'
                ? undefined
                : () => {
                    setMenuFor(null);
                    void state.newTmuxSession(project);
                  }
            }
          />
        )}
      </div>

      {!isCollapsed && project.chats.length === 0 && (
        <div className="project-empty">No chats yet</div>
      )}

      {(() => {
        // A search that hid a folder's other chats already narrowed this to
        // what matched, so the page limit only applies while browsing —
        // truncating a search result would hide a hit.
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
                      (activeSessionId && chat.sessionId === activeSessionId) ||
                      (activeConversationId && chat.conversationId === activeConversationId)
                        ? 'active'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-chat-id={chat.id}
                    onClick={() => open(chat)}
                    title={chat.title}
                  >
                    <span className="chat-title">
                      {chat.live && <span className="live-dot" aria-label="running" />}
                      {chat.title}
                    </span>
                  </button>
                  {chat.live && project.cwd === 'virtual:shell' && (
                    <button
                      type="button"
                      className="chat-remove"
                      onClick={() => void state.detachChat(chat)}
                      aria-label={`Detach ${chat.title}`}
                      title="Detach from tmux session"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                  {/* A finished Shell chat still points at a real tmux pane
                      (unless it was actually killed) — offer to rejoin it
                      directly, in place, rather than sending the user back
                      through the Shell dialog's picker. */}
                  {!chat.live && project.cwd === 'virtual:shell' && chat.adoptTargetId && (
                    <button
                      type="button"
                      className="chat-remove"
                      onClick={() => void state.reattachChat(chat)}
                      aria-label={`Re-attach ${chat.title}`}
                      title="Re-attach to this tmux pane"
                    >
                      <Icon name="terminal" size={14} />
                    </button>
                  )}
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
                <button type="button" className="chats-more" onClick={() => showMoreChats(project.cwd)}>
                  <Icon name="chevron-down" size={16} />
                  Show {remaining} more
                </button>
              )}
            </>
          )
        );
      })()}

      {/* Collapsing a project hides its worktrees along with its own chats —
          the two are one card, not siblings. */}
      {!isCollapsed &&
        project.worktrees.map((worktree) => (
          <ProjectSection
            key={worktree.cwd}
            project={worktree}
            nested
            state={state}
            open={open}
            searching={searching}
            collapsed={collapsed}
            toggle={toggle}
            expandedChats={expandedChats}
            showMoreChats={showMoreChats}
            menuFor={menuFor}
            setMenuFor={setMenuFor}
            onCompose={onCompose}
            activeSessionId={activeSessionId}
            activeConversationId={activeConversationId}
          />
        ))}
    </section>
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

/** Per-folder actions. All reversible-ish; none touches a transcript. */
function ProjectMenu({
  project,
  onClose,
  onClear,
  onHide,
  onRemove,
  onNewTmuxSession,
}: {
  project: ProjectInfo;
  onClose: () => void;
  onClear: () => void;
  onHide: () => void;
  onRemove: () => void;
  /** Undefined for the virtual Shell "project", which has no real folder to root a tmux session in. */
  onNewTmuxSession: (() => void) | undefined;
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
        {onNewTmuxSession && (
          <button type="button" role="menuitem" onClick={onNewTmuxSession}>
            New tmux session
          </button>
        )}
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
