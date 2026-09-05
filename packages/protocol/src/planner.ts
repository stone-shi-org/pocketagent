import { z } from 'zod';
import { LIMITS } from './limits.js';
import { AgentEvent } from './agent-events.js';

/**
 * PA-6, phase 1 (foundation): the planner — an LLM chat (any OpenAI-compatible
 * endpoint) with tools that treat existing PocketAgent sessions as sub-agents.
 *
 * This file only carries what phase 1 needs: the planner's own workspaces, the
 * model catalog for a single configured provider, and that provider's
 * settings. Chat/message/tool-approval schemas land in the phases that
 * introduce the chat loop and the approval gate, so nothing here is defined
 * ahead of code that uses it.
 */

/**
 * An app-owned scratch/skills directory for the planner, distinct from a
 * project `WorkspaceEntry`. A project workspace is one of the user's real
 * code repositories — PocketAgent only reads it and checks containment. A
 * planner workspace is the opposite: this app creates and owns it, and the
 * planner's own file/exec tools (a later phase) may write and delete inside
 * it freely. See `apps/server/src/planner/workspaces.ts`.
 */
export const PlannerWorkspace = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  /** The one seeded at first boot. Refuses removal — there must always be one. */
  isDefault: z.boolean(),
  createdAt: z.number().int(),
});
export type PlannerWorkspace = z.infer<typeof PlannerWorkspace>;

export const PlannerWorkspaceListResponse = z.object({
  workspaces: z.array(PlannerWorkspace),
});
export type PlannerWorkspaceListResponse = z.infer<typeof PlannerWorkspaceListResponse>;

/**
 * Unlike a project workspace, the caller does not name an arbitrary absolute
 * path. A planner workspace is app-owned scratch space, so the app decides
 * where on disk it lives (a fresh directory under the planner workspaces
 * root); the caller only names it.
 */
export const CreatePlannerWorkspaceRequest = z.object({
  name: z.string().min(1).max(128),
});
export type CreatePlannerWorkspaceRequest = z.infer<typeof CreatePlannerWorkspaceRequest>;

/** Renames an agent. Only `name` — see `PlannerWorkspaceRegistry.rename`'s doc
    comment for why the on-disk directory is never touched by this. */
export const UpdatePlannerWorkspaceRequest = z.object({
  name: z.string().min(1).max(128),
});
export type UpdatePlannerWorkspaceRequest = z.infer<typeof UpdatePlannerWorkspaceRequest>;

/**
 * One row of "this label maps to this model id", checked against the single
 * configured provider endpoint (`PlannerSettingsDto.baseUrl`). Multiple rows
 * are what a chat's model picker switches between — see the reporter's
 * answer to PA-6 open question 6: one provider, several configurable models.
 */
export const PlannerModel = z.object({
  id: z.string(),
  modelId: z.string(),
  label: z.string(),
  sortOrder: z.number().int(),
  createdAt: z.number().int(),
});
export type PlannerModel = z.infer<typeof PlannerModel>;

export const PlannerModelListResponse = z.object({
  models: z.array(PlannerModel),
});
export type PlannerModelListResponse = z.infer<typeof PlannerModelListResponse>;

export const CreatePlannerModelRequest = z.object({
  modelId: z.string().min(1).max(200),
  label: z.string().min(1).max(128),
});
export type CreatePlannerModelRequest = z.infer<typeof CreatePlannerModelRequest>;

/**
 * `hasApiKey` mirrors `Webhook.hasToken` / the omission of `secret` from the
 * webhook read DTO: the key is stored in plaintext (HMAC-style verification
 * would be impossible otherwise, and here the key must be replayed to the
 * provider verbatim, so there is no hashing alternative at all), never
 * returned by a plain GET, and readable only through an explicit,
 * rate-limited, logged reveal (`POST /api/planner/settings/api-key/reveal`).
 */
export const PlannerSettingsDto = z.object({
  baseUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  /**
   * Off by default. This will become the fourth documented override of the
   * "never answer a prompt for the user" invariant once the tool-approval
   * gate lands (a later phase) — recorded here first because the setting
   * itself is part of phase 1's foundation, even though nothing reads it yet.
   */
  yoloEnabled: z.boolean(),
  /** Seeds a new chat's model picker; each existing chat keeps its own choice. */
  lastModelId: z.string().nullable(),
});
export type PlannerSettingsDto = z.infer<typeof PlannerSettingsDto>;

/**
 * Every field optional: a PATCH only touches what it sends. `apiKey` omitted
 * leaves the stored key untouched, since the editor is never shown the
 * current value to round-trip. `apiKey: ''` clears it — the same "empty
 * string on the wire means unset" convention `nullableStr` uses elsewhere in
 * this codebase's settings.
 */
export const UpdatePlannerSettingsRequest = z.object({
  baseUrl: z.string().max(2048).nullable().optional(),
  apiKey: z.string().max(2048).optional(),
  yoloEnabled: z.boolean().optional(),
});
export type UpdatePlannerSettingsRequest = z.infer<typeof UpdatePlannerSettingsRequest>;

/** The one response that carries the key. See `PlannerSettingsDto.hasApiKey`. */
export const PlannerApiKeyRevealResponse = z.object({
  apiKey: z.string(),
});
export type PlannerApiKeyRevealResponse = z.infer<typeof PlannerApiKeyRevealResponse>;

export const PlannerChat = z.object({
  id: z.string(),
  /** Null when the owning workspace was later deleted — see `workspace_id`'s `ON DELETE SET NULL`. */
  workspaceId: z.string().nullable(),
  /** Copied at creation so an orphaned chat still describes itself, like `WebhookDelivery.webhookName`. */
  workspaceName: z.string(),
  title: z.string().nullable(),
  /** The model this chat last used; seeds the composer's model picker. */
  lastModelId: z.string().nullable(),
  createdAt: z.number().int(),
  lastActivityAt: z.number().int(),
});
export type PlannerChat = z.infer<typeof PlannerChat>;

export const PlannerChatListResponse = z.object({ chats: z.array(PlannerChat) });
export type PlannerChatListResponse = z.infer<typeof PlannerChatListResponse>;

/** Omitted `workspaceId` defaults to the default planner workspace. */
export const CreatePlannerChatRequest = z.object({
  workspaceId: z.string().optional(),
  title: z.string().max(200).optional(),
  modelId: z.string().max(200).optional(),
});
export type CreatePlannerChatRequest = z.infer<typeof CreatePlannerChatRequest>;

export const UpdatePlannerChatRequest = z.object({
  title: z.string().max(200).nullable().optional(),
  modelId: z.string().max(200).optional(),
});
export type UpdatePlannerChatRequest = z.infer<typeof UpdatePlannerChatRequest>;

/**
 * PA-6: a chat's transcript, as the same `AgentEvent` union a structured
 * session's own event stream produces (`agent-events.ts`) — reused directly,
 * not a parallel shape, per the reporter's "exact feature mirror" request.
 * Persisted as JSONL, one event per line (`apps/server/src/planner/transcript.ts`),
 * and replayed through the exact same `applyEvents` reducer the frontend
 * already has, so a reopened planner chat renders identically to a resumed
 * structured session: `user_prompt`/`text` render as the real chat UI does,
 * `tool_use`/`tool_result` render as a real, expandable tool-call bar
 * (`ToolCard`), and `permission_request`/`permission_resolved` render
 * through the real pending-approval machinery.
 *
 * The turn is streamed at both levels: each event reaches the browser the
 * moment it happens (the model decided to call a tool, the tool finished),
 * and the final reply's own text arrives token-by-token as `text_delta`
 * events, parsed live from the upstream provider's own SSE stream
 * (`planner/llm-client.ts`'s `streamComplete`). `text_delta` is transient —
 * it is never persisted to this history, only the fully assembled `text`
 * event is, the same "deltas are transport, not history" split a structured
 * session's own JSONL transcript already relies on; a reopened chat replays
 * the completed `text` and never re-streams it token by token.
 */
export const PlannerChatHistoryResponse = z.object({
  events: z.array(AgentEvent),
});
export type PlannerChatHistoryResponse = z.infer<typeof PlannerChatHistoryResponse>;

export const PlannerSendMessageRequest = z.object({
  content: z.string().min(1).max(LIMITS.maxInputChars),
  /** Overrides the chat's remembered model for this turn onward. */
  modelId: z.string().max(200).optional(),
});
export type PlannerSendMessageRequest = z.infer<typeof PlannerSendMessageRequest>;

/**
 * `allow_once` runs the tool without remembering anything. `allow_workspace`
 * / `allow_global` also persist to `planner_tool_approvals`, per the
 * reporter's answer to open question 2: both scopes are offered, uniformly,
 * for every mutating tool including `exec_command` — no tool is special-cased
 * to a narrower choice.
 */
export const PlannerToolApprovalChoice = z.enum([
  'allow_once',
  'allow_workspace',
  'allow_global',
  'deny',
]);
export type PlannerToolApprovalChoice = z.infer<typeof PlannerToolApprovalChoice>;

export const ResolvePlannerApprovalRequest = z.object({
  decision: PlannerToolApprovalChoice,
});
export type ResolvePlannerApprovalRequest = z.infer<typeof ResolvePlannerApprovalRequest>;

/**
 * PA-6, phase 5: the catalog for a settings page, so "which tool is allowed
 * globally and each workspace" has something to list. `readOnly` tells the
 * editor which tools never pause for approval at all (phase 3) versus which
 * ones a remembered decision or yolo mode actually affects.
 */
export const PlannerToolInfo = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
});
export type PlannerToolInfo = z.infer<typeof PlannerToolInfo>;

export const PlannerToolListResponse = z.object({ tools: z.array(PlannerToolInfo) });
export type PlannerToolListResponse = z.infer<typeof PlannerToolListResponse>;

/**
 * A pre-configured (rather than chat-triggered) remembered decision — the
 * same `planner_tool_approvals` row the chat's own "remember" buttons write,
 * surfaced here so a settings page can list, add, and revoke them without
 * needing a live chat to trigger a pause first.
 */
export const PlannerToolApprovalRow = z.object({
  id: z.string(),
  scope: z.enum(['global', 'workspace']),
  workspaceId: z.string().nullable(),
  toolName: z.string(),
  decision: z.enum(['allow', 'deny']),
  createdAt: z.number().int(),
});
export type PlannerToolApprovalRow = z.infer<typeof PlannerToolApprovalRow>;

export const PlannerToolApprovalListResponse = z.object({
  approvals: z.array(PlannerToolApprovalRow),
});
export type PlannerToolApprovalListResponse = z.infer<typeof PlannerToolApprovalListResponse>;

/** `workspaceId` is required (and must name a real workspace) when `scope` is `'workspace'`. */
export const SetPlannerToolApprovalRequest = z.object({
  scope: z.enum(['global', 'workspace']),
  workspaceId: z.string().optional(),
  toolName: z.string().min(1),
  decision: z.enum(['allow', 'deny']),
});
export type SetPlannerToolApprovalRequest = z.infer<typeof SetPlannerToolApprovalRequest>;
