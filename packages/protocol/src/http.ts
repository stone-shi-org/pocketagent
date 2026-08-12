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
import { SessionTransport } from './agent-events.js';
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
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

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
 * Server-wide switch to bypass approvals for every session.
 *
 * A deliberate, dangerous override of the per-session `CreateSessionRequest.skipPermissions`
 * opt-in: PocketAgent's whole reason to exist is routing every approval to the
 * browser, and this switch turns that off fleet-wide instead of session-by-session.
 * It is off by default and must be turned on explicitly by whoever operates this
 * server — see the "global skip-permissions switch" invariant in CLAUDE.md for what
 * it does and does not reach (a running terminal session's flag is fixed at spawn).
 */
export const GlobalSettingsResponse = z.object({
  skipPermissionsEnabled: z.boolean(),
});
export type GlobalSettingsResponse = z.infer<typeof GlobalSettingsResponse>;

export const UpdateGlobalSettingsRequest = z.object({
  skipPermissionsEnabled: z.boolean(),
});
export type UpdateGlobalSettingsRequest = z.infer<typeof UpdateGlobalSettingsRequest>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;
