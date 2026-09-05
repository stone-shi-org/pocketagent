import { z } from 'zod';

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
