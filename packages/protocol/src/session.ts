import { z } from 'zod';
import { SessionTransport } from './agent-events.js';

/**
 * Lifecycle of a server-owned PTY session.
 *
 * `interrupted` is distinct from `killed`/`exited`: it means the PocketAgent
 * server restarted underneath a running PTY, so the real process is gone but we
 * never observed its exit. We do not pretend otherwise.
 */
export const SessionStatus = z.enum([
  'starting',
  'running',
  'exited',
  'killed',
  'error',
  'interrupted',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

/** Statuses after which the PTY can never produce output again. */
export const TERMINAL_STATUSES: readonly SessionStatus[] = [
  'exited',
  'killed',
  'error',
  'interrupted',
];

export function isTerminalStatus(status: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Session metadata as exposed to clients. Never includes env or resolved argv. */
export const SessionInfo = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.string(),
  agentDisplayName: z.string(),
  cwd: z.string(),
  /** Workspace-root-relative label for display, e.g. `src/project`. */
  workspaceLabel: z.string(),
  status: SessionStatus,
  // Zero is meaningful, not missing: a structured session has no character
  // grid at all. Requiring a positive value here silently invalidated every
  // `attached` frame for structured sessions.
  cols: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  pid: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  lastActivityAt: z.number().int().nullable(),
  /** Number of browser clients currently attached. */
  attachedClients: z.number().int().nonnegative(),
  /**
   * Identifies the current run of the output stream. Sequence numbers are only
   * comparable within one epoch; it changes when a session is re-adopted after
   * a server restart. Null for sessions that are only history.
   */
  epoch: z.string().nullable(),
  /** Which process backend owns this session. */
  backend: z.string(),
  /** Raw terminal, or normalized agent events. Drives which UI is shown. */
  transport: SessionTransport,
  /**
   * The agent's own conversation id. Structured sessions can be resumed from
   * this after a server restart, because the agent persists its own history.
   */
  agentSessionId: z.string().nullable(),
  /** True when this session can survive a PocketAgent restart. */
  durable: z.boolean(),
  /**
   * True when this session attached to a pane someone else started. The client
   * must not resize it — the grid is shared with whoever else is watching.
   */
  adopted: z.boolean(),
  /**
   * The stable id of the tmux pane this session adopted (`AdoptableTarget.id`),
   * null otherwise. Unlike `adopted`, this survives detaching: it is what lets
   * the home screen recognize that a fresh "Attach" in the Shell dialog is the
   * *same* pane as one already represented by a finished session row, so the
   * two collapse into a single chat instead of piling up a duplicate every
   * time you detach and reattach.
   */
  adoptTargetId: z.string().nullable(),
  /**
   * True when this session was started with approvals bypassed. Surfaced so
   * the UI can show it persistently while the session runs — the opt-in must
   * stay visible, not just be a fire-and-forget checkbox at creation time.
   */
  skipPermissionsEnabled: z.boolean(),
  /**
   * True while the agent is mid-turn (structured backends) or the terminal
   * classifier's last hint included `working` (raw PTY). Advisory only, same
   * spirit as `TerminalHintKind` — a heuristic for a status dot, never a
   * signal anything is gated on.
   */
  busy: z.boolean(),
  /**
   * Epoch ms when `busy` last flipped false -> true; null while idle. Unlike
   * `lastActivityAt`, this does not move again until the current turn ends, so
   * it is a stable sort key while streaming — `lastActivityAt` ticks on every
   * chunk and made the project list reorder mid-stream, which is confusing
   * when two agents are running in different projects at once.
   */
  busySince: z.number().int().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const AgentInfo = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string(),
  /** False when the underlying executable is not on PATH. */
  available: z.boolean(),
  /** Which transports this agent can be driven through. */
  transports: z.array(SessionTransport).min(1),
  /** Transport used when the client does not choose one. */
  defaultTransport: SessionTransport,
  /**
   * True when this agent has a real auto-approve mode to opt into
   * (`--dangerously-skip-permissions` / SDK `bypassPermissions`). Drives
   * whether the client offers the toggle at all — an agent with no such flag
   * has nothing for it to do.
   */
  supportsSkipPermissions: z.boolean(),
  /**
   * True when approvals are *always* bypassed for this agent — there is no
   * off state to offer. Distinct from `supportsSkipPermissions`, which implies
   * a per-session choice: this is for an agent whose only structured mode has
   * no synchronous approval channel at all (see `agy`'s headless CLI), so the
   * client must show a fixed notice instead of a toggle the user could
   * mistake for a real off switch.
   */
  forcesSkipPermissions: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const WorkspaceEntry = z.object({
  /** Absolute, canonicalized path. */
  path: z.string(),
  /** Display name (basename for children, full path for roots). */
  name: z.string(),
  /** True when this is a configured root rather than a discovered child. */
  isRoot: z.boolean(),
  /** True when the directory looks like a git repository. */
  isGitRepo: z.boolean(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntry>;

/**
 * A Claude Code conversation that already exists on disk and can be resumed.
 *
 * Discovered from the agent's own session store, so it survives the terminal
 * that created it. Only conversations inside a configured workspace root are
 * ever surfaced.
 */
export const ConversationInfo = z.object({
  /** The agent's session id — what gets passed as `resumeAgentSessionId`. */
  id: z.string(),
  cwd: z.string(),
  workspaceLabel: z.string(),
  title: z.string(),
  lastPrompt: z.string().nullable(),
  gitBranch: z.string().nullable(),
  updatedAt: z.number().int(),
  sizeBytes: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  /** An agent process is running in this directory right now. */
  directoryBusy: z.boolean(),
  /** Newest transcript in a busy directory: most likely the live one. */
  probablyLive: z.boolean(),
});
export type ConversationInfo = z.infer<typeof ConversationInfo>;

/**
 * A machine that PocketAgent can run agents on.
 *
 * There is exactly one today — the server you are talking to — but the concept
 * is first-class from the start so that a front server fronting several backs
 * does not require the client to be rewritten. Anything that varies per machine
 * belongs here rather than in a global response field.
 */
export const HostInfo = z.object({
  /** Stable across restarts; opaque to the client. */
  id: z.string(),
  /** What to show in the header, e.g. `workbench-01`. */
  name: z.string(),
  version: z.string(),
  /** False once a front server can report a back it cannot currently reach. */
  online: z.boolean(),
});
export type HostInfo = z.infer<typeof HostInfo>;

/**
 * One row in a project's chat list.
 *
 * Deliberately unifies two things the server tracks separately: a session that
 * is running now, and a conversation that only exists on disk. To the person
 * holding the phone they are the same thing — a chat they were having — and the
 * difference is a status, not a category.
 *
 * `sessionId` is set when there is a live session to open directly.
 * `conversationId` is set when there is a transcript to resume from. A chat can
 * have both: a running session that was itself resumed from a transcript.
 */
export const ChatSummary = z.object({
  /** Stable row key. The session id when live, else the conversation id. */
  id: z.string(),
  sessionId: z.string().nullable(),
  conversationId: z.string().nullable(),
  title: z.string(),
  /** Agent id, or null for a conversation whose session is long gone. */
  agent: z.string().nullable(),
  agentDisplayName: z.string(),
  transport: SessionTransport.nullable(),
  /** Null when this row is history rather than a session. */
  status: SessionStatus.nullable(),
  /** True when the session is still able to produce output. */
  live: z.boolean(),
  updatedAt: z.number().int(),
  messageCount: z.number().int().nonnegative().nullable(),
  /** An agent process is running in this directory, though maybe not this chat. */
  directoryBusy: z.boolean(),
  /** See `SessionInfo.busySince`. Null for a chat that is not this session. */
  busySince: z.number().int().nullable(),
  /**
   * See `SessionInfo.adoptTargetId`. Carried through to a finished chat so the
   * client can offer an in-place "Re-attach" action for a detached tmux pane
   * without having to reopen the Shell picker — the id is all `POST
   * /api/sessions` needs to resolve the same pane again.
   */
  adoptTargetId: z.string().nullable(),
});
export type ChatSummary = z.infer<typeof ChatSummary>;

/**
 * A workspace directory, with everything that has happened in it.
 *
 * `worktrees` folds in any linked git worktree of this checkout that would
 * otherwise show up as an unrelated project of its own — `git worktree add`
 * is how you fork a *branch* of work you already have a card for, not a new
 * project, and a phone-sized list has no room for one row per branch. A
 * worktree entry is itself a full `ProjectInfo` (so the client can reuse the
 * same row/menu rendering), but its own `worktrees` is always empty: a linked
 * worktree's `.git` is a file, not a directory, so nothing can ever point
 * *into* it the way a worktree points at its main checkout — there is no
 * second level to represent.
 */
export interface ProjectInfo {
  /** Absolute canonical path; also the row key. */
  cwd: string;
  /** Basename, which is what reads well on a phone. */
  name: string;
  /** Root-relative path, for disambiguating two projects with one basename. */
  workspaceLabel: string;
  isGitRepo: boolean;
  gitBranch: string | null;
  /** Excluded from the list unless explicitly asked for. */
  hidden: boolean;
  /**
   * True when this is a folder the user added, rather than a subdirectory that
   * merely happens to have had a session run in it. Only the former can be
   * removed; the latter can only be hidden.
   */
  isWorkspace: boolean;
  chats: ChatSummary[];
  worktrees: ProjectInfo[];
}
// `z.lazy` plus the explicit interface above is zod's documented pattern for a
// self-referencing schema — inference alone cannot see through the recursion.
export const ProjectInfo: z.ZodType<ProjectInfo> = z.lazy(() =>
  z.object({
    cwd: z.string(),
    name: z.string(),
    workspaceLabel: z.string(),
    isGitRepo: z.boolean(),
    gitBranch: z.string().nullable(),
    hidden: z.boolean(),
    isWorkspace: z.boolean(),
    chats: z.array(ChatSummary),
    worktrees: z.array(ProjectInfo),
  }),
);

/**
 * A folder found in an agent's own history.
 *
 * Suggested, never granted: appearing here means some agent has run in this
 * directory before, not that PocketAgent may use it.
 */
export const DiscoveredFolder = z.object({
  path: z.string(),
  /** Display form, e.g. `~/src/project`. */
  label: z.string(),
  /** Agent ids that have run here, e.g. `claude`, `codex`. */
  agents: z.array(z.string()),
  lastUsedAt: z.number().int(),
  sessions: z.number().int().nonnegative(),
});
export type DiscoveredFolder = z.infer<typeof DiscoveredFolder>;

/** One directory in the picker. */
export const BrowseEntry = z.object({
  path: z.string(),
  name: z.string(),
  isGitRepo: z.boolean(),
  /** Already a project, so the picker can say so instead of offering it twice. */
  added: z.boolean(),
});
export type BrowseEntry = z.infer<typeof BrowseEntry>;

/**
 * An existing tmux pane that PocketAgent could attach to.
 *
 * Only populated when adoption is explicitly enabled, and only for panes whose
 * working directory is inside a configured workspace root.
 */
export const AdoptableTarget = z.object({
  /** Opaque handle the client passes back; the server never trusts free text. */
  id: z.string(),
  socket: z.string(),
  sessionName: z.string(),
  windowIndex: z.number().int(),
  paneIndex: z.number().int(),
  command: z.string(),
  cwd: z.string(),
  workspaceLabel: z.string(),
  title: z.string(),
  cols: z.number().int().nonnegative(),
  rows: z.number().int().nonnegative(),
  /** True when another client is already attached — adopting will share size. */
  attachedClients: z.number().int().nonnegative(),
  /**
   * True when the pane's window is already zoomed (`tmux resize-pane -Z`).
   * Attaching zooms the target pane so picking one pane doesn't hand you the
   * whole split window — but `-Z` toggles, so the server must know the
   * current state to avoid un-zooming a window someone already zoomed.
   */
  zoomed: z.boolean(),
});
export type AdoptableTarget = z.infer<typeof AdoptableTarget>;
