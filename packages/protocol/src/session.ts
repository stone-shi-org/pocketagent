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
});
export type AdoptableTarget = z.infer<typeof AdoptableTarget>;
