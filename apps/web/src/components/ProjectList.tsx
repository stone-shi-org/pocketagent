import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatSummary,
  DeleteRemoteBranchRequest,
  DeleteWorktreeResponse,
  GitStatus,
  HostInfo,
  ProjectInfo,
  QueuedRunSummary,
  ShellSessionSummary,
} from '@pocketagent/protocol';
import { chatDotState, describeCron, usesClaudeTranscripts } from '@pocketagent/protocol';
import { ChatStatusDot } from './ChatStatusDot.js';
import { hostDotClass, type HostStatus } from '../hosts/host-status.js';
import type { HostCompatibilityState } from '../api/negotiate.js';
import { ApiError, type ApiClient } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { filterLiveOnly, filterProjects } from '../agent/search.js';
import { formatCountdown } from '../agent/cron-format.js';
import { formatRelative } from './StatusBadge.js';
import { DeleteWorktreeFlow } from './DeleteWorktreeFlow.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { isMissingAdoptTargetError } from './RecreateShellDialog.js';
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';
import {
  loadProjectTreeState,
  saveCollapsedProjects,
  saveCollapsedQueued,
  saveCollapsedSubagents,
  saveExpandedChats,
  saveExpandedDeleted,
} from '../hosts/tree-pref.js';

/** Chats shown per project before a "show more" row appears. */
const CHAT_PAGE_SIZE = 5;

/**
 * The `cwd` sent alongside an `adoptTargetId`, which the server discards.
 * `POST /api/sessions` takes an adopted session's directory from the resolved
 * pane (`body.cwd = target.cwd`) before it validates anything, so this value
 * is never read — but `CreateSessionRequest` requires the field.
 *
 * A named constant rather than the literal `'virtual:shell'` these call sites
 * used to pass: that string was the *other* meaning of the same sentinel, the
 * synthetic project id the "Shell" category replaced (PA-25), and leaving it
 * here would keep a grep for the retired design alive in code that has
 * nothing to do with it.
 */
const ADOPTED_CWD_PLACEHOLDER = 'adopt:resolved-server-side';

/**
 * Human-readable labels for `GitStatus` values — used by the corner attention
 * dot (`dirty`/`unpushed`) and by the inline git badge on project rows (PA-173).
 */
const GIT_STATUS_LABEL: Record<GitStatus, string> = {
  clean: 'Clean',
  dirty: 'Uncommitted changes',
  unpushed: 'Commits not pushed',
};

function rateLimitLabel(chat: ChatSummary): string | null {
  const limit = chat.rateLimit;
  if (!limit) return null;
  if (limit.resetsAt !== null) {
    return `Usage limit reached. Resets ${new Date(limit.resetsAt).toLocaleString()}.`;
  }
  if (limit.resetsAtLabel) return `Usage limit reached. Resets ${limit.resetsAtLabel}.`;
  return 'Usage limit reached. Reset time unavailable.';
}

/**
 * A deep link into code-server for a project's folder, or null if no
 * code-server base URL is configured for this host (`HostInfo.codeServerBaseUrl`)
 * — see `POCKETAGENT_CODE_SERVER_URL` in `.env.example`. code-server opens the
 * folder named in `?folder=`, appended to whatever path it is served under.
 */
export function codeServerLink(base: string, cwd: string): string {
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

/**
 * Every chat in a project and its folded worktrees, flattened.
 *
 * Exported for `DesktopShell`'s tab strip, which needs to look a chat's title
 * and live status up by session/conversation id without re-walking the
 * project tree itself.
 */
export function allChats(projects: ProjectInfo[]): ChatSummary[] {
  const out: ChatSummary[] = [];
  for (const project of projects) {
    out.push(...project.chats, ...(project.subagents ?? []), ...allChats(project.worktrees));
  }
  return out;
}

/**
 * `preview`: a single click on a project-tree row, VS Code's name for the
 * one tab it reuses rather than piling up a new tab per click — the desktop
 * shell opens it in that reusable slot instead of a permanent tab. Omitted
 * (or a double click) opens a normal, permanent tab. The phone layout has no
 * tab strip to preview into, so its `onOpen`/`onOpenChat` just ignore this.
 */
export interface OpenChatOptions {
  preview?: boolean;
}

/**
 * One host's chat list, and everything that can be done to it.
 *
 * The phone screen and the desktop sidebar render the same list from this same
 * shape, which is what stops the two layouts drifting on rules like "tapping a
 * finished chat resumes it as a branch" — two copies of that is one too many.
 * Since PA-67 there is one of these *per host*, built by `useHostFleet` from
 * `projectActions` below, and the components that consume it did not have to
 * change: a host is a grouping dimension above this shape, not a field inside
 * it.
 */
export interface ProjectsState {
  projects: ProjectInfo[] | null;
  /**
   * The "Shell" category (PA-25) — every shell session, flat and already
   * sorted, from the same `/api/projects` round trip `projects` comes from.
   * `null` while nothing has loaded yet, exactly as `projects` is, so a
   * consumer can tell "no shells" from "not yet known".
   */
  shells: ShellSessionSummary[] | null;
  host: HostInfo | null;
  /**
   * Whether this bundle can actually talk to `host` (PA-61), and the sentence
   * to show if it cannot. Null until the first response arrives, so nothing
   * flashes a warning during the initial load.
   *
   * Derived from `host.protocol` — which `/api/projects` already carries —
   * rather than from a second `/health` poll: this refresh runs every 5s on a
   * phone, and one round trip that already contains the answer beats two.
   * `probeHost` exists for the case this cannot cover, a host not currently
   * serving a project list at all.
   */
  hostCompatibility: HostCompatibilityState | null;
  error: string | null;
  refresh: () => Promise<void>;
  open: (chat: ChatSummary, opts?: OpenChatOptions) => void;
  removeChat: (chat: ChatSummary) => Promise<void>;
  detachChat: (chat: ChatSummary) => Promise<void>;
  reattachChat: (chat: ChatSummary) => Promise<void>;
  recreateAndAttachChat: (chat: ChatSummary, sessionName: string, cwd: string) => Promise<void>;
  newTmuxSession: (project: ProjectInfo) => Promise<void>;
  clearFinished: (project: ProjectInfo) => Promise<void>;
  /** The Shell category's counterpart to `clearFinished`. Takes no directory. */
  clearFinishedShells: () => Promise<void>;
  hideProject: (cwd: string) => Promise<void>;
  removeProject: (cwd: string) => Promise<void>;
  /**
   * Deletes a linked git worktree and its local branch. Unlike every member
   * above, this does *not* swallow its own error into `onApiError`/`setError`
   * — `DeleteWorktreeFlow` needs to branch on `ApiError.code` (`dirty`,
   * `unmerged`, `worktree_busy`, ...) to show the right dialog, so it does its
   * own error handling and its own `refresh()` once it reaches a resting state.
   */
  deleteWorktree: (cwd: string) => Promise<DeleteWorktreeResponse>;
  /** Follow-up to `deleteWorktree`; also propagates rather than swallowing. */
  deleteRemoteBranch: (body: DeleteRemoteBranchRequest) => Promise<void>;
  /**
   * Cancel a queued webhook delivery, or move it to the front of its line
   * (PA-11). Swallow-then-`refresh()` like the rest, so the row goes at once
   * rather than up to a poll interval later (`hosts/poll-policy.ts`).
   */
  resolveQueued: (item: QueuedRunSummary, action: 'cancel' | 'front') => Promise<void>;
}

/**
 * Everything a `ProjectsState` can *do*, separated from where its data came
 * from.
 *
 * Extracted from `useProjects` in PA-67, and the extraction is the point. The
 * home screen now renders one chat list *per host*, which means one of these
 * per host — and a hook cannot be called in a loop whose length is a runtime
 * value. The bodies below were already written against nothing but an API
 * client plus `refresh`/`setError`, so lifting them out of `useCallback` into a
 * plain factory makes them reusable by `useHostFleet`'s per-host façades
 * without a second copy of rules like "tapping a finished chat resumes it as a
 * branch" — which is what `useProjects`' own doc comment said the
 * hook/component split existed to prevent in the first place.
 */
export type ProjectActions = Omit<
  ProjectsState,
  'projects' | 'shells' | 'host' | 'hostCompatibility' | 'error' | 'refresh'
>;

export interface ProjectActionsDeps {
  /** The host these actions address. */
  client: ApiClient;
  /** Re-reads this host's list; every mutating action ends by awaiting it. */
  refresh: () => Promise<void>;
  /** Shows a message on this host's own rows, never another host's. */
  setError: (message: string | null) => void;
  onApiError: (error: unknown) => void;
  onOpen: (sessionId: string, opts?: OpenChatOptions) => void;
  onOpenChat: (conversationId: string, opts?: OpenChatOptions) => void;
  onReplaceSession?: ((oldSessionId: string, newSessionId: string) => void) | undefined;
  /** Latest list for this host, read by `newTmuxSession`'s live-session check. */
  projects: ProjectInfo[] | null;
}

export function projectActions({
  client,
  refresh,
  setError,
  onApiError,
  onOpen,
  onOpenChat,
  onReplaceSession,
  projects,
}: ProjectActionsDeps): ProjectActions {
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
   * The preview route only ever works for the Claude family — stock `claude`
   * plus the third-party variants, which are the same binary writing the same
   * transcripts (`usesClaudeTranscripts`): `onOpenChat` leads to
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
  const open = (chat: ChatSummary, opts?: OpenChatOptions): void => {
    const claudeFamily = chat.agent !== null && usesClaudeTranscripts(chat.agent);
    if (chat.sessionId && (chat.live || !claudeFamily || !chat.conversationId)) {
      onOpen(chat.sessionId, opts);
      return;
    }
    if (chat.conversationId) onOpenChat(chat.conversationId, opts);
  };

  /**
   * Drop a chat from the list.
   *
   * Removal, not deletion: the session record goes and the conversation is
   * remembered as removed, but the transcript stays on disk and stays resumable
   * from a terminal. Running chats are refused by the server rather than killed
   * out from under whatever they are doing.
   */
  const removeChat = async (chat: ChatSummary): Promise<void> => {
    try {
      await client.removeChat({
        ...(chat.sessionId ? { sessionId: chat.sessionId } : {}),
        ...(chat.conversationId ? { conversationId: chat.conversationId } : {}),
      });
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not remove that chat.');
    } finally {
      await refresh();
    }
  };

  /**
   * A queued delivery, cancelled or bumped to the front.
   *
   * Only webhook-kind rows have an owning webhook to address; a queued *prompt*
   * belongs to a chat and is resolved over that chat's WebSocket instead, where
   * the "send anyway" escape hatch lives.
   */
  const resolveQueued = async (
    item: QueuedRunSummary,
    action: 'cancel' | 'front',
  ): Promise<void> => {
    if (item.kind !== 'webhook' || item.webhookId === null) return;
    try {
      await client.resolveQueuedDelivery(item.webhookId, item.id, action);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update the queue.');
    } finally {
      await refresh();
    }
  };

  const clearFinished = async (project: ProjectInfo): Promise<void> => {
    try {
      await client.clearFinished(project.cwd);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not clear that project.');
    } finally {
      await refresh();
    }
  };

  /** Same action for the Shell category, which has no directory to name. */
  const clearFinishedShells = async (): Promise<void> => {
    try {
      await client.clearFinishedShells();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not clear finished shells.');
    } finally {
      await refresh();
    }
  };

  const hideProject = async (cwd: string): Promise<void> => {
    try {
      await client.hideProject(cwd);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not hide that project.');
    } finally {
      await refresh();
    }
  };

  /** Stop treating a folder as a project. Nothing on disk changes. */
  const removeProject = async (cwd: string): Promise<void> => {
    try {
      await client.removeWorkspace(cwd);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not remove that folder.');
    } finally {
      await refresh();
    }
  };

  /**
   * Deletes a linked git worktree and its local branch. Deliberately does
   * *not* catch its own error the way every action above does — `ApiError`
   * propagates so `DeleteWorktreeFlow` can branch on `.code` (`dirty`,
   * `unmerged`, `worktree_busy`, ...) and show the matching dialog rather
   * than a generic banner. The flow component calls `refresh()` itself once
   * it reaches a resting state, whichever path that turns out to be.
   */
  const deleteWorktree = (cwd: string): Promise<DeleteWorktreeResponse> =>
    client.deleteWorktree(cwd);

  /** Follow-up to `deleteWorktree`; same propagate-don't-swallow reasoning. */
  const deleteRemoteBranch = (body: DeleteRemoteBranchRequest): Promise<void> =>
    client.deleteRemoteBranch(body).then(() => undefined);

  const detachChat = async (chat: ChatSummary): Promise<void> => {
    if (chat.sessionId) {
      try {
        await client.deleteSession(chat.sessionId);
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not detach that session.');
      } finally {
        await refresh();
      }
    }
  };

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
  const reattachChat = async (chat: ChatSummary): Promise<void> => {
    if (!chat.adoptTargetId) return;
    try {
      const created = await client.createSession({
        agent: 'shell',
        cwd: ADOPTED_CWD_PLACEHOLDER,
        cols: 80,
        rows: 24,
        transport: 'terminal',
        adoptTargetId: chat.adoptTargetId,
      });
      if (onReplaceSession && chat.sessionId) {
        onReplaceSession(chat.sessionId, created.id);
      } else {
        onOpen(created.id);
      }
    } catch (err) {
      if (isMissingAdoptTargetError(err)) {
        throw err;
      }
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not re-attach to that tmux session.');
    } finally {
      await refresh();
    }
  };

  /**
   * Recreate a missing tmux session and attach to it, replacing the old
   * dead session row in place (PA-48).
   */
  const recreateAndAttachChat = async (
    chat: ChatSummary,
    sessionName: string,
    cwd: string,
  ): Promise<void> => {
    try {
      let target = (await client.listAdoptable(true)).targets.find(
        (t) => t.sessionName === sessionName,
      );
      if (!target) {
        try {
          target = await client.createAdoptableSession(sessionName, cwd);
        } catch (err) {
          if (err instanceof ApiError && err.status === 409) {
            target = (await client.listAdoptable(true)).targets.find(
              (t) => t.sessionName === sessionName,
            );
          }
          if (!target) throw err;
        }
      }
      const created = await client.createSession({
        agent: 'shell',
        cwd: target.cwd,
        cols: target.cols,
        rows: target.rows,
        transport: 'terminal',
        adoptTargetId: target.id,
      });
      if (onReplaceSession && chat.sessionId) {
        onReplaceSession(chat.sessionId, created.id);
      } else {
        onOpen(created.id);
      }
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not recreate tmux session.');
      throw err;
    } finally {
      await refresh();
    }
  };

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
  const newTmuxSession = async (project: ProjectInfo): Promise<void> => {
    const name = tmuxNameFor(project.name);
    try {
      let target = (await client.listAdoptable(true)).targets.find((t) => t.sessionName === name);

      if (!target) {
        try {
          target = await client.createAdoptableSession(name, project.cwd);
        } catch (err) {
          // Lost a race with another tab (or another poll of this same
          // action) creating the same name between the list above and this
          // call — the session it made is exactly as good as the one this
          // call would have made, so look it up instead of failing.
          if (err instanceof ApiError && err.status === 409) {
            target = (await client.listAdoptable(true)).targets.find(
              (t) => t.sessionName === name,
            );
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

      const created = await client.createSession({
        agent: 'shell',
        cwd: ADOPTED_CWD_PLACEHOLDER,
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
  };

  return {
    open,
    removeChat,
    detachChat,
    reattachChat,
    recreateAndAttachChat,
    newTmuxSession,
    clearFinished,
    clearFinishedShells,
    hideProject,
    removeProject,
    deleteWorktree,
    deleteRemoteBranch,
    resolveQueued,
  };
}

interface ListProps {
  state: ProjectsState;
  search: string;
  /** PA-167: show only running agents. */
  liveOnly?: boolean;
  onCompose: (cwd: string) => void;
  /** Highlighted in the sidebar so you can see which chat you are reading. */
  activeSessionId?: string | null;
  /** Same highlight, for a chat opened as a preview that has no session yet. */
  activeConversationId?: string | null;
  /** Wording differs: one is tapped, the other clicked. */
  emptyHint: string;
  onAddProject: () => void;
  /** Opens a scheduled job's editor. Omitted where cron rows are not wanted. */
  onOpenCronJob?: (jobId: string) => void;
  /** Opens a webhook's editor. Omitted where webhook rows are not wanted. */
  onOpenWebhook?: (webhookId: string) => void;
  /** Opens a planner chat. Omitted where planner navigation is handled by hash fallback. */
  onOpenPlannerChat?: (chatId: string) => void;
  /** Only reached by `DeleteWorktreeFlow`, for a failure outside its own handled rejections. */
  onApiError: (error: unknown) => void;
}

/** The folders and their chats. Presentation only; state comes from above. */
export function ProjectList({
  state,
  search = '',
  liveOnly = false,
  onCompose,
  activeSessionId,
  activeConversationId,
  emptyHint,
  onAddProject,
  onOpenCronJob,
  onOpenWebhook,
  onOpenPlannerChat,
  onApiError,
}: ListProps): JSX.Element {
  const endpoint = useHostEndpoint();
  const hostId = endpoint.id;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadProjectTreeState(hostId).collapsed);
  const [collapsedSubagents, setCollapsedSubagents] = useState<Set<string>>(
    () => loadProjectTreeState(hostId).collapsedSubagents,
  );
  const [expandedDeleted, setExpandedDeleted] = useState<Set<string>>(
    () => loadProjectTreeState(hostId).expandedDeleted,
  );
  // Keyed by the *parent's* cwd, exactly as `expandedDeleted` is. Open by
  // default: a queue is a thing waiting to happen, and hiding it behind a
  // closed group is how "why hasn't my ticket run" becomes a support question.
  const [collapsedQueued, setCollapsedQueued] = useState<Set<string>>(
    () => loadProjectTreeState(hostId).collapsedQueued,
  );
  const [expandedChats, setExpandedChats] = useState<Set<string>>(
    () => loadProjectTreeState(hostId).expandedChats,
  );
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // A delete flow can outlive its three-dot menu closing (it opens its own
  // dialogs), so it is not reusing `menuFor`'s state — but like `menuFor`,
  // only one can be open at a time, keyed by the worktree's own `cwd`.
  const [deleteFlowFor, setDeleteFlowFor] = useState<string | null>(null);

  // Sync state if hostId changes while component instance is kept mounted
  useEffect(() => {
    const loaded = loadProjectTreeState(hostId);
    setCollapsed(loaded.collapsed);
    setCollapsedSubagents(loaded.collapsedSubagents);
    setExpandedDeleted(loaded.expandedDeleted);
    setCollapsedQueued(loaded.collapsedQueued);
    setExpandedChats(loaded.expandedChats);
  }, [hostId]);

  const { projects, open } = state;

  const visible = useMemo(() => {
    const base = liveOnly ? filterLiveOnly(projects ?? []) : (projects ?? []);
    return filterProjects(base, search);
  }, [projects, search, liveOnly]);
  const searching = search.trim().length > 0;

  const toggle = (cwd: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveCollapsedProjects(hostId, next);
      return next;
    });

  const toggleSubagents = (cwd: string): void =>
    setCollapsedSubagents((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveCollapsedSubagents(hostId, next);
      return next;
    });

  const toggleDeleted = (cwd: string): void =>
    setExpandedDeleted((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveExpandedDeleted(hostId, next);
      return next;
    });

  const toggleQueued = (cwd: string): void =>
    setCollapsedQueued((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      saveCollapsedQueued(hostId, next);
      return next;
    });

  const showMoreChats = (cwd: string): void =>
    setExpandedChats((prev) => {
      const next = new Set(prev).add(cwd);
      saveExpandedChats(hostId, next);
      return next;
    });

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
    collapsedSubagents,
    toggleSubagents,
    expandedDeleted,
    toggleDeleted,
    collapsedQueued,
    toggleQueued,
    expandedChats,
    showMoreChats,
    menuFor,
    setMenuFor,
    deleteFlowFor,
    setDeleteFlowFor,
    onCompose,
    activeSessionId,
    activeConversationId,
    onOpenCronJob,
    onOpenWebhook,
    onOpenPlannerChat,
    onApiError,
  };

  return (
    <>
      {projects === null && <div className="spinner">Loading…</div>}

      {projects !== null && (
        // PA-131: the add action sits on the heading rather than after the
        // list — on a phone a long project list put it a full scroll away.
        <div className="section-head">
          <h2 className="section-heading">{searching ? 'Results' : 'Projects'}</h2>
          {!searching && (
            <button
              type="button"
              className="round-btn plain section-head-action add-project"
              onClick={onAddProject}
              aria-label="Add a project folder"
              title="Add a project folder"
            >
              <Icon name="plus" size={18} />
            </button>
          )}
        </div>
      )}

      {projects !== null && visible.length === 0 && (
        <div className="empty">
          {searching ? (
            <>No chats match “{search.trim()}”.</>
          ) : liveOnly ? (
            <>No running agents.</>
          ) : (
            emptyHint
          )}
        </div>
      )}

      {visible.map((project) => (
        <ProjectSection key={project.cwd} project={project} nested={false} {...sectionProps} />
      ))}

    </>
  );
}

interface ProjectSectionProps {
  project: ProjectInfo;
  /** A folded worktree renders smaller and indented under its main checkout. */
  nested: boolean;
  state: ProjectsState;
  open: (chat: ChatSummary, opts?: OpenChatOptions) => void;
  searching: boolean;
  collapsed: Set<string>;
  toggle: (cwd: string) => void;
  collapsedSubagents: Set<string>;
  toggleSubagents: (cwd: string) => void;
  expandedDeleted: Set<string>;
  toggleDeleted: (cwd: string) => void;
  collapsedQueued: Set<string>;
  toggleQueued: (cwd: string) => void;
  expandedChats: Set<string>;
  showMoreChats: (cwd: string) => void;
  menuFor: string | null;
  setMenuFor: (cwd: string | null) => void;
  deleteFlowFor: string | null;
  setDeleteFlowFor: (cwd: string | null) => void;
  onCompose: (cwd: string) => void;
  activeSessionId?: string | null;
  activeConversationId?: string | null;
  onOpenCronJob?: (jobId: string) => void;
  onOpenWebhook?: (webhookId: string) => void;
  onOpenPlannerChat?: (chatId: string) => void;
  onApiError: (error: unknown) => void;
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
  collapsedSubagents,
  toggleSubagents,
  expandedDeleted,
  toggleDeleted,
  collapsedQueued,
  toggleQueued,
  expandedChats,
  showMoreChats,
  menuFor,
  setMenuFor,
  deleteFlowFor,
  setDeleteFlowFor,
  onCompose,
  activeSessionId,
  activeConversationId,
  onOpenCronJob,
  onOpenWebhook,
  onOpenPlannerChat,
  onApiError,
}: ProjectSectionProps): JSX.Element {
  const api = useHostApi();
  const [limitMenuFor, setLimitMenuFor] = useState<string | null>(null);
  const [continuationFor, setContinuationFor] = useState<string | null>(null);
  const [continuationError, setContinuationError] = useState<string | null>(null);
  const [confirmingDeleteAllDeleted, setConfirmingDeleteAllDeleted] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const limitMenuRef = useRef<HTMLSpanElement>(null);
  // A search that hid a folder's other chats should not also hide the ones it
  // matched, so collapsing is ignored while searching.
  const isCollapsed = !searching && collapsed.has(project.cwd);
  const isSubagentsExpanded = searching || !collapsedSubagents.has(project.cwd);
  // Inverted state, unlike `expandedDeleted`: the queue is open unless someone
  // closed it, because work waiting on this directory is information rather
  // than clutter — a queue nobody notices is the support question this whole
  // feature exists to answer.
  const isQueuedExpanded = !collapsedQueued.has(project.cwd);

  // The one synthetic project left (PA-25 moved shell sessions to their own
  // top-level category, so `'virtual:shell'` no longer reaches this list).
  const isVirtualWebhooks = project.cwd === 'virtual:webhooks';

  // A synthetic project and a deleted worktree have no real folder on disk, so
  // there is nothing for code-server to open.
  const codeServerBase = state.host?.codeServerBaseUrl;
  const codeServerHref =
    codeServerBase && !isVirtualWebhooks && !project.isDeleted
      ? codeServerLink(codeServerBase, project.cwd)
      : null;

  useEffect(() => {
    const dismiss = (event: PointerEvent): void => {
      if (!limitMenuRef.current?.contains(event.target as Node)) setLimitMenuFor(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLimitMenuFor(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const scheduleContinuation = async (chat: ChatSummary): Promise<void> => {
    if (!chat.sessionId) return;
    setContinuationFor(chat.id);
    setContinuationError(null);
    try {
      await api.scheduleContinueAfterLimit(chat.sessionId);
      setLimitMenuFor(null);
    } catch (error) {
      setContinuationError(error instanceof ApiError ? error.message : 'Could not schedule continuation.');
      onApiError(error);
    } finally {
      setContinuationFor(null);
    }
  };

  return (
    <section
      className={`project${nested ? ' project--worktree' : ''}${project.isDeleted ? ' project--deleted' : ''}`}
      data-project={project.cwd}
    >
      <div className="project-head">
        <button
          type="button"
          className="project-name"
          onClick={() => toggle(project.cwd)}
          aria-expanded={!isCollapsed}
          title={nested ? project.gitBranch ?? project.name : project.name}
        >
          <span className="project-icon">
            <Icon
              name={isVirtualWebhooks ? 'webhook' : nested ? 'branch' : 'folder'}
              className="folder"
            />
            {project.gitStatus && project.gitStatus !== 'clean' && (
              <span
                className={`git-status-dot git-status-dot--${project.gitStatus}`}
                role="img"
                aria-label={GIT_STATUS_LABEL[project.gitStatus]}
                title={GIT_STATUS_LABEL[project.gitStatus]}
              />
            )}
          </span>
          <span
            className="project-label"
            title={nested ? project.gitBranch ?? project.name : project.name}
          >
            {nested ? project.gitBranch ?? project.name : project.name}
          </span>
          {!nested && project.isGitRepo && (
            <span
              className={`project-git-badge${project.gitStatus ? ` project-git-badge--${project.gitStatus}` : ''}`}
              title={
                project.gitStatus
                  ? `${project.gitBranch ?? 'HEAD'} · ${GIT_STATUS_LABEL[project.gitStatus]}`
                  : (project.gitBranch ?? 'HEAD')
              }
            >
              <Icon name="branch" size={12} className="project-git-icon" />
              <span className="project-git-branch">{project.gitBranch ?? 'HEAD'}</span>
              {project.gitStatus && (
                <span
                  className={`project-git-status project-git-status--${project.gitStatus}`}
                  role="img"
                  aria-label={GIT_STATUS_LABEL[project.gitStatus]}
                />
              )}
            </span>
          )}
          <Icon name="chevron-down" className={`project-caret${isCollapsed ? ' closed' : ''}`} />
          {isCollapsed && (
            <span className="project-count">
              {isVirtualWebhooks ? project.webhooks.length : project.chats.length + (project.subagents?.length ?? 0)}
            </span>
          )}
          {/* Shown even when expanded, and even when collapsed alongside the
              chat count: work waiting on this directory is the one thing a
              glance at a folded row most needs to surface. */}
          {project.queued.length > 0 && (
            <span className="project-count project-count--queued" title="Waiting for this directory">
              {project.queued.length} waiting
            </span>
          )}
        </button>
        {!isVirtualWebhooks && !project.isDeleted && (
          <button
            type="button"
            className="round-btn plain"
            onClick={() => onCompose(project.cwd)}
            aria-label={`New chat in ${project.name}`}
            title={`New chat in ${project.name}`}
          >
            <Icon name="compose" size={19} />
          </button>
        )}
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
        {!isVirtualWebhooks && (
          <button
            type="button"
            className="round-btn plain"
            onClick={() => setMenuFor(menuFor === project.cwd ? null : project.cwd)}
            aria-label={`Options for ${project.name}`}
            aria-expanded={menuFor === project.cwd}
          >
            <Icon name="ellipsis" size={18} />
          </button>
        )}
        {menuFor === project.cwd && !isVirtualWebhooks && (
          <ProjectMenu
            project={project}
            nested={nested}
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
              project.isDeleted
                ? undefined
                : () => {
                    setMenuFor(null);
                    void state.newTmuxSession(project);
                  }
            }
            onDeleteWorktree={
              nested && !project.isDeleted
                ? () => {
                    setMenuFor(null);
                    setDeleteFlowFor(project.cwd);
                  }
                : undefined
            }
          />
        )}
        {deleteFlowFor === project.cwd && (
          <DeleteWorktreeFlow
            project={project}
            state={state}
            onApiError={onApiError}
            onClose={() => setDeleteFlowFor(null)}
          />
        )}
      </div>

      {/* Without the webhook clause a webhook-only project renders "No chats
          yet" directly above a visible webhook row. */}
      {!isCollapsed &&
        project.chats.length === 0 &&
        (project.subagents?.length ?? 0) === 0 &&
        project.cronJobs.length === 0 &&
        project.webhooks.length === 0 &&
        project.queued.length === 0 && <div className="project-empty">No chats yet</div>}

      {/* Scheduled jobs sit above the chats: a job is what is *going* to
          happen, and it is a spec rather than a conversation — there is no
          transcript to open, so tapping one opens its editor. Rendered even
          when it has never run, which is the whole reason it is here. */}
      {!isCollapsed &&
        onOpenCronJob &&
        project.cronJobs.map((job) => (
          <div key={job.id} className="chat-line cron-line">
            <button
              type="button"
              className={`chat-row cron-job-row${job.enabled ? '' : ' paused'}`}
              onClick={() => onOpenCronJob(job.id)}
              title={`${job.name} — ${describeCron(job.cronExpr)}${
                job.enabled ? '' : ' (paused)'
              }`}
            >
              <span className="chat-title">
                <span className="cron-icon-wrap">
                  <Icon name="clock" size={15} className="cron-badge-icon" />
                  {job.lastRunStatus !== null && (
                    <span
                      className={`cron-dot cron-dot--${job.lastRunStatus}`}
                      role="img"
                      aria-label={`Last run ${job.lastRunStatus}`}
                    />
                  )}
                </span>
                {job.name}
                {job.skipPermissionsEnabled && (
                  <Icon
                    name="shield"
                    size={13}
                    className="cron-shield"
                    aria-label="Approvals bypassed"
                  />
                )}
              </span>
              <span className="cron-line-when">
                {job.enabled
                  ? job.nextRunAt !== null
                    ? formatCountdown(job.nextRunAt)
                    : 'no next run'
                  : 'paused'}
              </span>
            </button>
          </div>
        ))}

      {/* Webhooks sit with the scheduled jobs, above the chats, and for a
          sharper version of the same reason: a webhook may never fire at all —
          a wrong URL, a mistyped secret, a proxy that is not forwarding — so a
          row that only appeared after the first delivery would hide exactly the
          case worth looking at. `never fired` is the signal. */}
      {!isCollapsed &&
        onOpenWebhook &&
        project.webhooks.map((hook) => (
          <div key={hook.id} className="chat-line cron-line">
            <button
              type="button"
              className={`chat-row cron-job-row${hook.enabled ? '' : ' paused'}`}
              onClick={() => onOpenWebhook(hook.id)}
              title={`${hook.name} — ${hook.triggerLabel}${hook.enabled ? '' : ' (disabled)'}`}
            >
              <span className="chat-title">
                <span className="cron-icon-wrap">
                  <Icon
                    name={hook.type === 'jira' ? 'webhook-jira' : 'webhook-bamboo'}
                    size={15}
                    className="cron-badge-icon"
                  />
                  {hook.lastDeliveryStatus !== null && (
                    <span
                      className={`cron-dot cron-dot--${hook.lastDeliveryStatus}`}
                      role="img"
                      aria-label={`Last delivery ${hook.lastDeliveryStatus}`}
                    />
                  )}
                </span>
                {hook.name}
                {hook.skipPermissionsEnabled && (
                  <Icon
                    name="shield"
                    size={13}
                    className="cron-shield"
                    aria-label="Approvals bypassed"
                  />
                )}
              </span>
              <span className="cron-line-when">
                {hook.enabled
                  ? hook.lastDeliveryAt !== null
                    ? formatRelative(hook.lastDeliveryAt)
                    : 'never fired'
                  : 'disabled'}
              </span>
            </button>
          </div>
        ))}

      {/* PA-11: the virtual "Queued" subdirectory. Work waiting for this
          directory to come free, in the order it will run. Modelled on the
          "Deleted worktrees" group — a synthetic, collapsible grouping row
          rather than a `ProjectInfo` — because a waiter is not a directory and
          has no chats of its own. It disappears by itself: the server stops
          sending the rows, and the next poll drops the group. */}
      {!isCollapsed && project.queued.length > 0 && (
        <div className="queued-group">
          <button
            type="button"
            className="project-name queued-toggle"
            onClick={() => toggleQueued(project.cwd)}
            aria-expanded={isQueuedExpanded}
            title="Waiting for another agent to finish in this directory"
          >
            <span className="project-icon">
              <Icon name="queue" className="folder" />
            </span>
            <span className="project-label">Queued</span>
            <Icon
              name="chevron-down"
              className={`project-caret${isQueuedExpanded ? '' : ' closed'}`}
            />
            <span className="project-count">{project.queued.length}</span>
          </button>
          {isQueuedExpanded &&
            project.queued.map((item) => (
              <div key={item.id} className="chat-line queued-line">
                <button
                  type="button"
                  className="chat-row queued-row"
                  onClick={() => {
                    // A waiting delivery has no transcript to open, so its row
                    // goes to the webhook that created it; a waiting prompt
                    // belongs to a chat, which does.
                    if (item.kind === 'prompt' && item.sessionId !== null) {
                      open({
                        id: item.sessionId,
                        sessionId: item.sessionId,
                        conversationId: null,
                        title: item.title,
                        agent: item.agent,
                        agentDisplayName: item.agentDisplayName,
                        transport: 'structured',
                        status: null,
                        live: true,
                        updatedAt: item.queuedAt,
                        messageCount: null,
                        directoryBusy: true,
                        busySince: null,
                        adoptTargetId: null,
                        cronJobId: null,
                        webhookId: null,
                        rateLimit: null,
                        plannerChatId: null,
                      });
                    } else if (onOpenWebhook && item.webhookId !== null) {
                      onOpenWebhook(item.webhookId);
                    }
                  }}
                  title={
                    item.kind === 'webhook'
                      ? `${item.title} — queued by ${item.webhookName ?? 'a webhook'}`
                      : `${item.title} — your message is waiting`
                  }
                >
                  <span className="chat-title">
                    <span className="cron-icon-wrap queued-icon-wrap">
                      {/* PA-27: every other "special" row in the tree (a
                          scheduled job, a webhook) leads with a type icon —
                          the queued row was the one exception, which is what
                          made it "look off" next to its siblings. `branch` for
                          a waiting prompt matches the same glyph the composer
                          uses for "a conversation to resume"; `webhook` for a
                          waiting delivery matches the badge a webhook-started
                          chat already wears. */}
                      <Icon
                        name={item.kind === 'prompt' ? 'branch' : 'webhook'}
                        size={15}
                        className="cron-badge-icon"
                      />
                    </span>
                    <span className="queued-position" aria-label={`Position ${item.position}`}>
                      {item.position}
                    </span>
                    {item.title}
                    {item.skipPermissionsEnabled && (
                      <Icon
                        name="shield"
                        size={13}
                        className="cron-shield"
                        aria-label="Approvals bypassed"
                      />
                    )}
                  </span>
                  <span className="cron-line-when">
                    {item.kind === 'webhook' ? (item.webhookName ?? 'webhook') : 'your message'}
                  </span>
                </button>
                {item.kind === 'webhook' && (
                  <>
                    {item.position > 1 && (
                      <button
                        type="button"
                        className="round-btn plain queued-action"
                        onClick={() => void state.resolveQueued(item, 'front')}
                        title="Run this one next"
                        aria-label="Run this one next"
                      >
                        <Icon name="arrow-up" size={16} />
                      </button>
                    )}
                    <button
                      type="button"
                      className="round-btn plain queued-action"
                      onClick={() => void state.resolveQueued(item, 'cancel')}
                      title="Remove from the queue"
                      aria-label="Remove from the queue"
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </>
                )}
              </div>
            ))}
        </div>
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
                    // Single click: VS Code's "preview" tab — reuses the
                    // strip's one unpinned slot instead of piling up a new
                    // tab per click. Double click keeps it open for good.
                    // Both always navigate, even if the tab is already open
                    // (permanent or preview) — DesktopShell's reducer only
                    // touches the tab list itself when there's actually
                    // something to change.
                    onClick={() => open(chat, { preview: true })}
                    onDoubleClick={() => open(chat, { preview: false })}
                    title={chat.title}
                  >
                    <span className="chat-title">
                      <ChatStatusDot state={chatDotState(chat)} />
                      {/* Inline, beside `live-dot`, rather than a corner
                          overlay: a chat row has no icon to pin a badge to. */}
                      {chat.cronJobId !== null && (
                        <Icon
                          name="clock"
                          size={13}
                          className="chat-cron-badge"
                          aria-label="Started by a scheduled job"
                        />
                      )}
                      {chat.webhookId !== null && (
                        <Icon
                          name="webhook"
                          size={13}
                          className="chat-cron-badge"
                          aria-label="Started by a webhook"
                        />
                      )}
                      {chat.mcpClient && (
                        <span title={`Started by MCP client ${chat.mcpClient}`}>
                          <Icon
                            name="mcp"
                            size={13}
                            className="chat-cron-badge"
                            aria-label={`Started by MCP client ${chat.mcpClient}`}
                          />
                        </span>
                      )}
                      {chat.plannerChatId !== null && (
                        <span
                          className="chat-planner-badge"
                          role="button"
                          tabIndex={0}
                          aria-label="Spawned by a planner chat"
                          title="Spawned by a planner chat. Open planner chat."
                          onClick={(e) => {
                            e.stopPropagation();
                            if (onOpenPlannerChat) onOpenPlannerChat(chat.plannerChatId!);
                            else window.location.hash = `#/planner/${encodeURIComponent(chat.plannerChatId!)}`;
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.stopPropagation();
                              if (onOpenPlannerChat) onOpenPlannerChat(chat.plannerChatId!);
                              else window.location.hash = `#/planner/${encodeURIComponent(chat.plannerChatId!)}`;
                            }
                          }}
                        >
                          <Icon name="agent-generic" size={13} />
                        </span>
                      )}
                      {chat.title}
                    </span>
                  </button>
                  {rateLimitLabel(chat) && chat.sessionId && (
                    <span className="chat-rate-limit-wrap" ref={limitMenuFor === chat.id ? limitMenuRef : null}>
                      <button
                        type="button"
                        className="chat-rate-limit-badge"
                        aria-label={`${rateLimitLabel(chat)} Open continuation menu.`}
                        title={rateLimitLabel(chat) ?? undefined}
                        aria-haspopup="menu"
                        aria-expanded={limitMenuFor === chat.id}
                        onClick={() => {
                          setContinuationError(null);
                          setLimitMenuFor((current) => (current === chat.id ? null : chat.id));
                        }}
                      >
                        <Icon name="clock" size={13} />
                      </button>
                      {limitMenuFor === chat.id && (
                        <span className="limit-continuation-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={continuationFor === chat.id}
                            onClick={() => void scheduleContinuation(chat)}
                          >
                            {continuationFor === chat.id ? 'Scheduling…' : 'Continue after limit reset'}
                          </button>
                          {continuationError && <span role="alert">{continuationError}</span>}
                        </span>
                      )}
                    </span>
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

      {/* PA-75: Collapsible Subagents group */}
      {!isCollapsed && project.subagents && project.subagents.length > 0 && (
        <div className="subagents-group">
          <div className="subagents-head project-head">
            <button
              type="button"
              className="project-name subagents-toggle"
              onClick={() => toggleSubagents(project.cwd)}
              aria-expanded={isSubagentsExpanded}
              title="Subagents started by a planner chat"
            >
              <span className="project-icon">
                <Icon name="agent-generic" className="folder" />
              </span>
              <span className="project-label">Subagents</span>
              <Icon
                name="chevron-down"
                className={`project-caret${isSubagentsExpanded ? '' : ' closed'}`}
              />
              <span className="project-count">{project.subagents.length}</span>
            </button>
          </div>
          {isSubagentsExpanded &&
            project.subagents.map((chat) => (
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
                  onClick={() => open(chat, { preview: true })}
                  onDoubleClick={() => open(chat, { preview: false })}
                  title={chat.title}
                >
                  <span className="chat-title">
                    <ChatStatusDot state={chatDotState(chat)} />
                    {chat.plannerChatId !== null && (
                      <span
                        className="chat-planner-badge"
                        role="button"
                        tabIndex={0}
                        aria-label="Spawned by a planner chat"
                        title="Spawned by a planner chat. Open planner chat."
                        onClick={(e) => {
                          e.stopPropagation();
                          if (onOpenPlannerChat) onOpenPlannerChat(chat.plannerChatId!);
                          else window.location.hash = `#/planner/${encodeURIComponent(chat.plannerChatId!)}`;
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            if (onOpenPlannerChat) onOpenPlannerChat(chat.plannerChatId!);
                            else window.location.hash = `#/planner/${encodeURIComponent(chat.plannerChatId!)}`;
                          }
                        }}
                      >
                        <Icon name="agent-generic" size={13} />
                      </span>
                    )}
                    {chat.title}
                  </span>
                </button>
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
        </div>
      )}

      {/* Collapsing a project hides its worktrees along with its own chats —
          the two are one card, not siblings. */}
      {!isCollapsed &&
        (() => {
          const activeWorktrees = project.worktrees.filter((w) => !w.isDeleted);
          const deletedWorktrees = project.worktrees.filter((w) => w.isDeleted);
          const isDeletedExpanded = searching || expandedDeleted.has(project.cwd);

          return (
            <>
              {activeWorktrees.map((worktree) => (
                <ProjectSection
                  key={worktree.cwd}
                  project={worktree}
                  nested
                  state={state}
                  open={open}
                  searching={searching}
                  collapsed={collapsed}
                  toggle={toggle}
                  collapsedSubagents={collapsedSubagents}
                  toggleSubagents={toggleSubagents}
                  expandedDeleted={expandedDeleted}
                  toggleDeleted={toggleDeleted}
                  collapsedQueued={collapsedQueued}
                  toggleQueued={toggleQueued}
                  expandedChats={expandedChats}
                  showMoreChats={showMoreChats}
                  menuFor={menuFor}
                  setMenuFor={setMenuFor}
                  deleteFlowFor={deleteFlowFor}
                  setDeleteFlowFor={setDeleteFlowFor}
                  onCompose={onCompose}
                  activeSessionId={activeSessionId}
                  activeConversationId={activeConversationId}
                  onApiError={onApiError}
                  {...(onOpenCronJob ? { onOpenCronJob } : {})}
                  {...(onOpenWebhook ? { onOpenWebhook } : {})}
                  {...(onOpenPlannerChat ? { onOpenPlannerChat } : {})}
                />
              ))}

              {deletedWorktrees.length > 0 && (
                <div className="deleted-worktrees-group">
                  <div className="deleted-worktrees-head project-head">
                    <button
                      type="button"
                      className="project-name deleted-worktrees-toggle"
                      onClick={() => toggleDeleted(project.cwd)}
                      aria-expanded={isDeletedExpanded}
                      title="Deleted worktrees"
                    >
                      <span className="project-icon">
                        <Icon name="folder" className="folder" />
                      </span>
                      <span className="project-label">Deleted worktrees</span>
                      <Icon
                        name="chevron-down"
                        className={`project-caret${isDeletedExpanded ? '' : ' closed'}`}
                      />
                      {!isDeletedExpanded && (
                        <span className="project-count">{deletedWorktrees.length}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="round-btn plain deleted-worktrees-delete-all"
                      onClick={() => setConfirmingDeleteAllDeleted(true)}
                      title="Delete all in deleted worktrees"
                      aria-label="Delete all in deleted worktrees"
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                  {isDeletedExpanded &&
                    deletedWorktrees.map((worktree) => (
                      <ProjectSection
                        key={worktree.cwd}
                        project={worktree}
                        nested
                        state={state}
                        open={open}
                        searching={searching}
                        collapsed={collapsed}
                        toggle={toggle}
                        collapsedSubagents={collapsedSubagents}
                        toggleSubagents={toggleSubagents}
                        expandedDeleted={expandedDeleted}
                        toggleDeleted={toggleDeleted}
                        collapsedQueued={collapsedQueued}
                        toggleQueued={toggleQueued}
                        expandedChats={expandedChats}
                        showMoreChats={showMoreChats}
                        menuFor={menuFor}
                        setMenuFor={setMenuFor}
                        deleteFlowFor={deleteFlowFor}
                        setDeleteFlowFor={setDeleteFlowFor}
                        onCompose={onCompose}
                        activeSessionId={activeSessionId}
                        activeConversationId={activeConversationId}
                        onApiError={onApiError}
                        {...(onOpenCronJob ? { onOpenCronJob } : {})}
                        {...(onOpenWebhook ? { onOpenWebhook } : {})}
                        {...(onOpenPlannerChat ? { onOpenPlannerChat } : {})}
                      />
                    ))}
                  {confirmingDeleteAllDeleted && (
                    <ConfirmDialog
                      title="Delete all in deleted worktrees?"
                      body="This will permanently clear all finished conversations from every deleted worktree under this project."
                      confirmLabel="Delete All"
                      cancelLabel="Cancel"
                      danger
                      busy={isDeletingAll}
                      onConfirm={async () => {
                        setIsDeletingAll(true);
                        try {
                          for (const wt of deletedWorktrees) {
                            await api.clearFinished(wt.cwd);
                          }
                        } catch (err) {
                          onApiError(err);
                        } finally {
                          setIsDeletingAll(false);
                          setConfirmingDeleteAllDeleted(false);
                          await state.refresh();
                        }
                      }}
                      onCancel={() => setConfirmingDeleteAllDeleted(false)}
                    />
                  )}
                </div>
              )}
            </>
          );
        })()}
    </section>
  );
}

/**
 * Header chip naming the machine these projects live on.
 *
 * The dot carries three states, not two (PA-61). "Incompatible" is deliberately
 * distinct from "offline": an unreachable host may well be back in a second,
 * whereas one outside the protocol range will keep refusing until somebody
 * upgrades something, and conflating them sends the user to wait for a reboot
 * that will not help. The chip is only ever a summary — `HostCompatibilityNotice`
 * is what actually says which versions are involved, since a dot and a tooltip
 * are not legible on a phone.
 */
export function HostChip({
  host,
  record,
  compatibility,
  allHosts,
  onClick,
}: {
  host: HostInfo | null;
  /**
   * The registry's own view of this host (PA-67), which exists before — and
   * without — a successful response.
   *
   * Load-bearing rather than cosmetic: `host` is `null` until a project list
   * comes back, so a chip driven by that alone *disappears* on an unreachable
   * host. On a phone the chip is the host switcher, so that left the user
   * stranded on a machine that is not answering with no way to switch back.
   * The multi-host demo caught it; the record is what keeps the label, the dot
   * and the tap target present regardless.
   */
  record?: { label: string; status: HostStatus } | null;
  compatibility?: HostCompatibilityState | null;
  /**
   * True in the aggregated view, where no single host is "the" host (PA-67).
   * The chip then names the view rather than a machine, because showing one
   * host's name above every host's chats is worse than showing none.
   */
  allHosts?: boolean;
  /**
   * Makes the chip the phone layout's host switcher (PA-67). Omitted on
   * desktop, where `HostRail` is the switcher and a second one in the sidebar
   * brand would be two affordances for one action.
   */
  onClick?: () => void;
}): JSX.Element | null {
  if (!host && !record && !allHosts) return null;
  const incompatible = compatibility?.compatibility.compatible === false;
  // The record's verdict wins where there is one: it is the same derivation the
  // rail, the sheet and the group heading all show, so the four cannot
  // disagree about one machine.
  const dotClass = record
    ? hostDotClass(record.status).replace('host-dot', '')
    : incompatible
      ? ' incompatible'
      : host === null || host.online
        ? ''
        : ' offline';
  // The registered name wins (PA-107): `record.label` is the one the user
  // typed. `host.name` — the machine's hostname — is only the fallback before
  // the fleet record exists, and a tooltip otherwise.
  const name = allHosts ? 'All hosts' : (record?.label ?? host?.name ?? '');
  const hostname = !allHosts && host?.name && host.name !== name ? host.name : null;
  const body = (
    <>
      {!allHosts && <span className={`host-dot${dotClass}`} aria-hidden="true" />}
      <Icon name={allHosts ? 'agents' : 'host'} />
      <span className="host-name" title={hostname ? `${name} (${hostname})` : undefined}>
        {name}
      </span>
      {!allHosts && incompatible && <span className="host-warn">incompatible</span>}
    </>
  );
  if (!onClick) return <span className="host-chip">{body}</span>;
  return (
    <button
      type="button"
      className="host-chip as-button"
      onClick={onClick}
      aria-label="Switch host"
      title="Switch host"
    >
      {body}
    </button>
  );
}

/**
 * The legible half of a per-host incompatibility (PA-61).
 *
 * Rendered above the project list rather than in place of it, which is the
 * acceptance criterion this component exists for: an incompatible host must not
 * take the app down, so everything already loaded stays on screen and
 * interactive. With several hosts this is one notice per bad host and the rest
 * of the list is untouched.
 *
 * Returns null when the host is fine, so the common case adds no markup at all.
 */
export function HostCompatibilityNotice({
  compatibility,
}: {
  compatibility: HostCompatibilityState | null;
}): JSX.Element | null {
  if (!compatibility || compatibility.message === null) return null;
  return (
    <div className="notice inline warn" role="status">
      {compatibility.message}
    </div>
  );
}

/** PA-167: "Only running" switch, under the search field in both layouts. */
export function LiveOnlyToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <label className="live-only-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Only running
    </label>
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

/**
 * Per-folder actions. Everything except "Delete worktree…" is reversible-ish
 * and touches no transcript; that one is destructive on purpose, gated on
 * `nested` so it can never show up on a main checkout's own menu.
 */
function ProjectMenu({
  project,
  nested,
  onClose,
  onClear,
  onHide,
  onRemove,
  onNewTmuxSession,
  onDeleteWorktree,
}: {
  project: ProjectInfo;
  /** A folded worktree row — see `ProjectSection`'s own `nested` doc comment. */
  nested: boolean;
  onClose: () => void;
  onClear: () => void;
  onHide: () => void;
  onRemove: () => void;
  /** Undefined for the virtual Shell "project", which has no real folder to root a tmux session in. */
  onNewTmuxSession: (() => void) | undefined;
  /** Undefined unless `nested` — a main checkout has no worktree/branch of its own to delete this way. */
  onDeleteWorktree: (() => void) | undefined;
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
        {nested && onDeleteWorktree && (
          <button type="button" role="menuitem" className="danger" onClick={onDeleteWorktree}>
            Delete worktree…
          </button>
        )}
      </div>
    </>
  );
}
