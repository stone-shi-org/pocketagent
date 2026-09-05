import { z } from 'zod';
import { LIMITS } from './limits.js';

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

/**
 * PA-6, phase 2 (chat core): a planner chat and its transcript.
 *
 * Deliberately not the `AgentEvent` union `agent-events.ts` defines for a
 * structured session. That union exists to carry *live, incremental* SDK
 * output (partial-message deltas, tool-call lifecycles) over a WebSocket to a
 * renderer built for exactly that shape. Phase 2's chat loop is
 * request/response, one full assistant message per turn — see
 * `planner/llm-client.ts`'s doc comment for why streaming is deferred — so
 * reusing `AgentEvent` here would mean emitting a union designed for partial
 * delivery to describe something that was never partial. A dedicated,
 * minimal transcript entry now, and a switch to `AgentEvent` if and when a
 * later phase adds real token-level streaming and tool-call events, keeps
 * each shape honest about what it actually carries.
 */
export const PlannerTranscriptEntry = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  createdAt: z.number().int(),
});
export type PlannerTranscriptEntry = z.infer<typeof PlannerTranscriptEntry>;

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

export const PlannerChatHistoryResponse = z.object({
  entries: z.array(PlannerTranscriptEntry),
});
export type PlannerChatHistoryResponse = z.infer<typeof PlannerChatHistoryResponse>;

export const PlannerSendMessageRequest = z.object({
  content: z.string().min(1).max(LIMITS.maxInputChars),
  /** Overrides the chat's remembered model for this turn onward. */
  modelId: z.string().max(200).optional(),
});
export type PlannerSendMessageRequest = z.infer<typeof PlannerSendMessageRequest>;

/**
 * PA-6, phase 4: a turn either finished, or paused on a mutating tool call
 * with no remembered decision. `approvalId` is opaque and short-lived (held
 * in server memory only, like `StructuredSession`'s own pending-permission
 * map) — it is resolved by `POST /api/planner/chats/:id/approvals/:approvalId`
 * and does not survive a server restart, the same limitation a live
 * session's own pending approval already has.
 */
export const PlannerTurnResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), assistantEntry: PlannerTranscriptEntry }),
  z.object({
    status: z.literal('approval_required'),
    approvalId: z.string(),
    toolName: z.string(),
    /** Raw JSON the model supplied for the call — no per-tool "nice" rendering yet. */
    argsSummary: z.string(),
  }),
]);
export type PlannerTurnResult = z.infer<typeof PlannerTurnResult>;

/** The user's entry is always produced immediately, whichever way the turn goes. */
export const PlannerSendMessageResponse = z.object({
  userEntry: PlannerTranscriptEntry,
  turn: PlannerTurnResult,
});
export type PlannerSendMessageResponse = z.infer<typeof PlannerSendMessageResponse>;

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
