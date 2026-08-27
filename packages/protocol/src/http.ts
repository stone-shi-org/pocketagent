import { z } from 'zod';
import {
  AdoptableTarget,
  AgentInfo,
  BrowseEntry,
  ConversationInfo,
  DiscoveredFolder,
  HostInfo,
  ProjectInfo,
  SessionInfo,
  WorkspaceEntry,
} from './session.js';
import { EffortLevel, SessionTransport } from './agent-events.js';
import { LIMITS } from './ws.js';

export const LoginRequest = z.object({
  token: z.string().min(1).max(512),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  ok: z.literal(true),
  expiresAt: z.number().int(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({
  authenticated: z.boolean(),
  expiresAt: z.number().int().nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * Session creation input.
 *
 * Note what is absent: no command, no args, no env, no shell string. The client
 * chooses an agent id from the server-side registry and a cwd that must resolve
 * inside a configured workspace root. That is the whole attack surface.
 */
export const CreateSessionRequest = z.object({
  agent: z.string().min(1).max(64),
  cwd: z.string().min(1).max(4096),
  cols: z.number().int().min(LIMITS.minCols).max(LIMITS.maxCols).default(80),
  rows: z.number().int().min(LIMITS.minRows).max(LIMITS.maxRows).default(24),
  title: z.string().max(128).optional(),
  /** Defaults to the agent's preferred transport. */
  transport: SessionTransport.optional(),
  /** Resume a previous structured conversation by its agent session id. */
  resumeAgentSessionId: z.string().max(128).optional(),
  /**
   * When resuming, branch onto a new conversation id instead of appending to
   * the original transcript. Defaults to false so resuming continues the chat in-place.
   */
  forkSession: z.boolean().default(false),
  /** Attach to an existing tmux pane instead of starting a new process. */
  adoptTargetId: z.string().max(256).optional(),
  /**
   * Run this session with tool approvals bypassed instead of routed to the
   * browser (Claude Code's `--dangerously-skip-permissions` / the SDK's
   * `bypassPermissions` mode). Defaults to false: approval-on-every-call is
   * the whole point of PocketAgent, so this must be an explicit per-session
   * choice, never a silent default. Only agents that report
   * `supportsSkipPermissions` in `AgentInfo` honour it.
   */
  skipPermissions: z.boolean().default(false),
  /**
   * Model to start this session on (the Claude Agent SDK's model alias or
   * full id). Optional: omitted means "whatever the agent's own default is",
   * same as before this field existed. Only the `claude` agent's structured
   * transport honours it today — see `AgentInfo.defaultModel` for where the
   * composer sources a value to pre-fill this with, since nothing about model
   * choice is knowable before a session exists to ask.
   */
  model: z.string().min(1).max(200).optional(),
  /**
   * Effort level to start this session on. `null` explicitly means "the
   * model's own default" (distinct from omitting the field, which means "use
   * whatever was cached from a prior session, if anything" — see
   * `AgentInfo.defaultEffort`). Same one-agent caveat as `model` above.
   */
  effort: EffortLevel.nullable().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

/**
 * Create a git worktree for an existing project, on its own branch.
 *
 * A separate, explicit step from `CreateSessionRequest` rather than fields on
 * it: it mutates the filesystem (and the project's git state) where session
 * creation otherwise never does, so it gets its own audit point — the same
 * reasoning that keeps `POST /api/workspaces/add` separate from starting a
 * session. The resulting `cwd` is handed to `POST /api/sessions` afterward
 * like any other directory.
 *
 * `current` never reuses the branch already checked out in the project's main
 * worktree — git refuses to check the same branch out twice — so the server
 * mints a new branch name off its tip instead.
 */
export const CreateWorktreeRequest = z
  .object({
    /** The existing project directory to branch from. */
    cwd: z.string().min(1).max(4096),
    branchMode: z.enum(['new', 'current']),
    /** Required when `branchMode` is `"new"`; validated against git's own ref-name rules. */
    branchName: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.branchMode !== 'new' || !!v.branchName?.trim(), {
    message: 'branchName is required when creating a new branch.',
    path: ['branchName'],
  });
export type CreateWorktreeRequest = z.infer<typeof CreateWorktreeRequest>;

export const CreateWorktreeResponse = z.object({
  /** Canonical path of the new worktree; pass this as `cwd` to `POST /api/sessions`. */
  cwd: z.string(),
  /** The branch actually checked out there — may differ from a requested `branchName`. */
  branch: z.string(),
});
export type CreateWorktreeResponse = z.infer<typeof CreateWorktreeResponse>;

export const SessionListResponse = z.object({
  sessions: z.array(SessionInfo),
});
export type SessionListResponse = z.infer<typeof SessionListResponse>;

export const ConversationListResponse = z.object({
  conversations: z.array(ConversationInfo),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponse>;

export const AdoptableListResponse = z.object({
  /** False when adoption has not been enabled in configuration. */
  enabled: z.boolean(),
  targets: z.array(AdoptableTarget),
});
export type AdoptableListResponse = z.infer<typeof AdoptableListResponse>;

/**
 * Start a brand-new named tmux session on the adoption socket (the same one
 * `GET /api/adoptable` lists), rather than attaching to one that already
 * exists. The name becomes the real tmux session name, so it is also what a
 * plain `tmux attach -t <name>` on that socket would use from a real
 * terminal — this is meant to be a two-way door, not a PocketAgent-only one.
 */
export const CreateAdoptableSessionRequest = z.object({
  name: z.string().min(1).max(64),
  /**
   * Working directory the new tmux session starts in. Optional and validated
   * the same way `CreateSessionRequest.cwd` is (must resolve inside a
   * configured workspace root) — omitted by the Shell dialog's free-form
   * "create" flow, which falls back to the first workspace root, but set by
   * a project row's "New tmux session" action so the session actually lands
   * in that project's own folder rather than an arbitrary one.
   */
  cwd: z.string().min(1).max(4096).optional(),
});
export type CreateAdoptableSessionRequest = z.infer<typeof CreateAdoptableSessionRequest>;

/**
 * Everything the home screen needs, in one round trip.
 *
 * Composed server-side rather than by the client joining three endpoints: the
 * merge of live sessions with on-disk conversations needs the workspace
 * registry and the transcript store, and a phone on a slow link should not pay
 * three round trips to render its first screen.
 */
export const ProjectListResponse = z.object({
  host: HostInfo,
  projects: z.array(ProjectInfo),
});
export type ProjectListResponse = z.infer<typeof ProjectListResponse>;

/**
 * Remove one chat from the list.
 *
 * Both ids are optional but at least one is required: a chat can be a live
 * record, a transcript, or both, and removing it has to cover whichever exist.
 * Nothing on disk is deleted — a conversation is remembered as removed so a
 * later scan does not put it back.
 */
export const RemoveChatRequest = z
  .object({
    sessionId: z.string().max(128).optional(),
    conversationId: z.string().max(128).optional(),
  })
  .refine((v) => v.sessionId !== undefined || v.conversationId !== undefined, {
    message: 'Provide a sessionId, a conversationId, or both.',
  });
export type RemoveChatRequest = z.infer<typeof RemoveChatRequest>;

/** Directories are addressed by path; the server still validates containment. */
export const ProjectRequest = z.object({
  cwd: z.string().min(1).max(4096),
});
export type ProjectRequest = z.infer<typeof ProjectRequest>;

/** Add or forget a project folder. Any absolute directory on the host. */
export const WorkspaceRequest = z.object({
  path: z.string().min(1).max(4096),
  /**
   * Only consulted by `/api/workspaces/add`: create `path` (and any missing
   * parents) if it does not exist yet, instead of failing with `not_found`.
   * Lets the picker offer "new folder" without a separate mkdir endpoint —
   * creating and registering a project folder are still one deliberate act,
   * just one that no longer requires the folder to pre-exist.
   */
  create: z.boolean().optional(),
});
export type WorkspaceRequest = z.infer<typeof WorkspaceRequest>;

export const DiscoveredListResponse = z.object({
  folders: z.array(DiscoveredFolder),
});
export type DiscoveredListResponse = z.infer<typeof DiscoveredListResponse>;

export const BrowseResponse = z.object({
  /** Canonical path being listed. */
  path: z.string(),
  label: z.string(),
  /** Null at the filesystem root, where there is nowhere further up. */
  parent: z.string().nullable(),
  /** True when this directory is already a project. */
  added: z.boolean(),
  entries: z.array(BrowseEntry),
});
export type BrowseResponse = z.infer<typeof BrowseResponse>;

export const HostListResponse = z.object({
  /** The host serving this request, first. One entry until federation exists. */
  hosts: z.array(HostInfo).min(1),
});
export type HostListResponse = z.infer<typeof HostListResponse>;

export const AgentListResponse = z.object({
  agents: z.array(AgentInfo),
});
export type AgentListResponse = z.infer<typeof AgentListResponse>;

export const WorkspaceListResponse = z.object({
  workspaces: z.array(WorkspaceEntry),
});
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponse>;

export const HealthResponse = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/**
 * Read-only facts fixed at boot, never database-backed: `HOST`/`PORT` are
 * needed to bind before a settings page is even reachable, `databasePath` is
 * needed to open the very database that would otherwise store it, and
 * `nodeEnv` is a deployment mode, not an app setting. Shown on the settings
 * page so it's obvious *why* these aren't editable there, instead of just
 * silently missing.
 */
export const FixedServerInfo = z.object({
  host: z.string(),
  port: z.number().int(),
  databasePath: z.string(),
  nodeEnv: z.enum(['development', 'production', 'test']),
  isNetworkExposed: z.boolean(),
});
export type FixedServerInfo = z.infer<typeof FixedServerInfo>;

/**
 * Every other server setting, all database-backed (see
 * `apps/server/src/settings/fields.ts`): seeded once from the environment on
 * first boot, then persisted — `.env` is never consulted again. Some take
 * effect immediately; others were captured into another module's constructor
 * closure at boot and need a restart. `GET /api/settings` reports which via
 * `restartRequiredKeys`, not by omitting a value.
 *
 * `skipPermissionsEnabled` is the pre-existing server-wide switch to bypass
 * approvals for every session — a deliberate, dangerous override of the
 * per-session `CreateSessionRequest.skipPermissions` opt-in. Off by default;
 * see the "global skip-permissions switch" invariant in CLAUDE.md for what it
 * does and does not reach (a running terminal session's flag is fixed at
 * spawn). It is not one of `SETTINGS_FIELDS` — `SessionManager` owns its
 * storage and live propagation — but rides on this same resource because it
 * is, like the rest, a fact about the whole server rather than one session.
 */
export const RuntimeSettings = z.object({
  skipPermissionsEnabled: z.boolean(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  /** Comma-separated origins, or `''` for the same-origin-only default. */
  allowedOrigins: z.string(),
  maxSessions: z.number().int().min(1).max(200),
  outputBufferBytes: z
    .number()
    .int()
    .min(16 * 1024)
    .max(64 * 1024 * 1024),
  sessionIdleTimeoutSeconds: z
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 3600),
  sessionTtlHours: z.number().int().min(1).max(8760),
  cookieSecure: z.boolean(),
  trustProxy: z.boolean(),
  /** `''` hides the "Open in code-server" action. */
  codeServerUrl: z.string(),
  shell: z.string().min(1),
  claudeBin: z.string().min(1),
  agyBin: z.string().min(1),
  opencodeBin: z.string().min(1),
  codexBin: z.string().min(1),
  piBin: z.string().min(1),
  webDistPath: z.string().min(1),
  backend: z.enum(['direct', 'tmux']),
  tmuxBin: z.string().min(1),
  tmuxSocket: z.string().min(1),
  /** `''` disables tmux pane adoption. */
  adoptTmuxSocket: z.string(),
  /** `''` disables the systemd-slice wrapping. */
  tmuxSessionScopeSlice: z.string(),
  pushContact: z.string().min(1),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettings>;

export const UpdateSettingsRequest = RuntimeSettings.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

export const SettingsResponse = z.object({
  fixed: FixedServerInfo,
  settings: RuntimeSettings,
  /** `RuntimeSettings` keys that need a restart to take effect once changed. */
  restartRequiredKeys: z.array(z.string()),
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

export const UsageWindowInfo = z.object({
  label: z.string(),
  percentUsed: z.number().min(0).max(100),
  resetsAtLabel: z.string().nullable(),
  timezone: z.string().nullable(),
});
export type UsageWindowInfo = z.infer<typeof UsageWindowInfo>;

/**
 * One agent's own account/rate-limit usage — Claude's `/usage` slash command,
 * Codex's `account/rateLimits/read` RPC, and whatever a future agent adapter
 * adds. Each is polled locally and in the background by its own source under
 * `apps/server/src/usage/`, never fetched inside a request. `available:
 * false` covers every way a given agent's reading can fail (no binary, not
 * on a metered plan, a shape the parser does not recognise) with one field
 * the client can branch on instead of guessing from `error`, which is
 * diagnostic text only.
 */
export const AgentUsageInfo = z.object({
  /** Matches `AgentInfo.id`, e.g. `"claude"` or `"codex"`. */
  agent: z.string(),
  agentDisplayName: z.string(),
  available: z.boolean(),
  percentUsed: z.number().min(0).max(100).nullable(),
  /**
   * What the percentage is *of*, when the source distinguishes windows —
   * e.g. Codex's "7-day". Null for a source like Claude's `/usage` that only
   * ever reports one window and does not name it.
   */
  windowLabel: z.string().nullable(),
  /** Human phrasing, e.g. "Aug 13, 4:30pm" — deliberately not reparsed into a Date. */
  resetsAtLabel: z.string().nullable(),
  timezone: z.string().nullable(),
  /** All rate-limit windows reported by this agent (e.g. 5-hour and Weekly). */
  windows: z.array(UsageWindowInfo).optional(),
  /** When this snapshot was taken, not when the browser fetched it. */
  updatedAt: z.string(),
  error: z.string().nullable(),
});
export type AgentUsageInfo = z.infer<typeof AgentUsageInfo>;

export const UsageListResponse = z.object({
  usage: z.array(AgentUsageInfo),
});
export type UsageListResponse = z.infer<typeof UsageListResponse>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
