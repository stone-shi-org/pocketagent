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
  /** This agent's own default model, or `null` to fall back to the global
      last-used model — PA-6 round 4's "each agent should configure their
      own model". Seeds a new chat created in this workspace; each chat then
      keeps its own choice exactly like today. */
  defaultModelId: z.string().nullable(),
  /**
   * PA-29: whether this agent's memory system is on. Defaults to `true` for
   * every existing agent (see the migration's own doc comment) — turning it
   * off skips both ranking memories into a turn's system message and
   * folding evicted rolling-window turns into new ones, but the rolling
   * window itself still trims what the LLM sees regardless, for basic
   * context-length safety (see `PlannerChatService`'s doc comment on that
   * split).
   */
  memoryEnabled: z.boolean(),
  /** PA-29 phase 3 (consolidation, not implemented yet): when a background
      pass last folded this agent's short-term memories into long-term ones.
      `null` until that phase ever runs for this agent — the column exists
      now so that later phase needs no migration of its own. */
  lastConsolidatedAt: z.number().int().nullable(),
});
export type PlannerWorkspace = z.infer<typeof PlannerWorkspace>;

export const PlannerWorkspaceListResponse = z.object({
  workspaces: z.array(PlannerWorkspace),
});
export type PlannerWorkspaceListResponse = z.infer<typeof PlannerWorkspaceListResponse>;

/**
 * `path` omitted (the original PA-6 behavior): a planner workspace is
 * app-owned scratch space, so the app decides where on disk it lives (a
 * fresh directory under the planner workspaces root) and the caller only
 * names it. `path` given: the caller instead points this agent at a
 * specific directory anywhere on the host, picked the same way `POST
 * /api/workspaces/add` lets a user pick a project folder — `createPath`
 * mirrors that endpoint's own `create` flag for a not-yet-existing
 * directory. **Providing `path` is the moment full read/write/delete trust
 * is handed to that directory**, exactly the trust an auto-created scratch
 * folder already has — see `PlannerWorkspaceRegistry.create`'s doc comment.
 */
export const CreatePlannerWorkspaceRequest = z.object({
  name: z.string().min(1).max(128),
  path: z.string().min(1).max(4096).optional(),
  createPath: z.boolean().optional(),
});
export type CreatePlannerWorkspaceRequest = z.infer<typeof CreatePlannerWorkspaceRequest>;

/**
 * Updates an agent. Every field independently optional — only what's sent is
 * touched, the same convention every other settings PATCH in this codebase
 * uses. `name` renames it — see `PlannerWorkspaceRegistry.rename`'s doc
 * comment for why the on-disk directory is never touched by *that*.
 * `defaultModelId` sets (or, with `null`, clears) this agent's own default
 * model. `path` (PA-6 round 5: "it lacks a way to change existing agent
 * workspace directory") re-points the agent at a different directory
 * instead — see `PlannerWorkspaceRegistry.setPath`'s doc comment for the
 * consequence this has for existing chats' transcripts, which the editor
 * must disclose before sending this; `createPath` mirrors
 * `CreatePlannerWorkspaceRequest`'s own flag for a not-yet-existing one.
 */
export const UpdatePlannerWorkspaceRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  defaultModelId: z.string().max(200).nullable().optional(),
  path: z.string().min(1).max(4096).optional(),
  createPath: z.boolean().optional(),
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
 * `GET /api/planner/models/discover` queries the configured endpoint's own
 * `/models` list (the standard OpenAI-compatible discovery endpoint) and
 * returns the raw model ids — nothing is added to the catalog server-side.
 * The editor caches them client-side purely to drive type-ahead in its
 * add-a-model field, and only an explicit click on a suggestion creates a
 * row (PA-6 round 7). Same "explicit action grants it" pattern
 * `POST /api/workspaces/add` uses for project folders: discovering a model
 * must never silently change what a chat's picker offers — and a provider
 * that lists hundreds of models would otherwise bury the handful anyone
 * actually uses.
 */
export const DiscoverPlannerModelsResponse = z.object({
  modelIds: z.array(z.string()),
});
export type DiscoverPlannerModelsResponse = z.infer<typeof DiscoverPlannerModelsResponse>;

/**
 * `POST /api/planner/models/:id/test` round-trips one minimal prompt through
 * the model to confirm the endpoint and model id actually work — never
 * touches a chat's transcript. `ok: false` covers both a transport failure
 * and a non-2xx response from the provider; `message` carries whichever one
 * happened (or a short excerpt of the reply, on success) since the editor
 * only ever needs one line to show next to the model row.
 */
export const TestPlannerModelResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().int(),
});
export type TestPlannerModelResponse = z.infer<typeof TestPlannerModelResponse>;

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
  /**
   * PA-10: this chat's mutating tool calls run without pausing for approval.
   *
   * Set **only** by an unattended trigger that already carries its own
   * skip-permissions decision — today, an inbound webhook whose
   * `skipPermissions` is on — and there is deliberately no way to ask for it
   * over HTTP: `CreatePlannerChatRequest` has no such field, so a browser
   * cannot mint a pre-approved chat. It is a property of the chat's
   * *provenance*, which is why it lives on the row rather than being threaded
   * through a turn: it has to survive an approval pause, a server restart, and
   * a `per-issue` webhook reusing the same chat for a later delivery.
   *
   * Exposed on the read DTO because CLAUDE.md's first invariant requires it:
   * "a session running with it must say so persistently in the UI, not just at
   * the moment it was created". `PlannerChatPage` badges it.
   */
  skipToolApprovalsEnabled: z.boolean(),
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
 * ones a remembered decision or yolo mode actually affects. `enabled` (PA-6
 * round 5: "in global setting, add section called 'tools' ... you can
 * disable or enable globally") is this tool's *global* on/off switch — off
 * here means off for every agent, regardless of that agent's own setting
 * (`PlannerAgentToolInfo.enabled`), which is a second, per-agent layer on
 * top of this one, not an alternative to it.
 */
export const PlannerToolInfo = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  enabled: z.boolean(),
});
export type PlannerToolInfo = z.infer<typeof PlannerToolInfo>;

export const PlannerToolListResponse = z.object({ tools: z.array(PlannerToolInfo) });
export type PlannerToolListResponse = z.infer<typeof PlannerToolListResponse>;

export const SetPlannerToolEnabledRequest = z.object({ enabled: z.boolean() });
export type SetPlannerToolEnabledRequest = z.infer<typeof SetPlannerToolEnabledRequest>;

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

/**
 * PA-6 round 4: "tools can be global, but each agent can select their own
 * available tools." The catalog (`name`/`description`/`readOnly`) stays the
 * global one from `PlannerToolInfo`. `enabled` is the *effective* state for
 * this agent right now — `false` if either this agent has it disabled, or
 * (PA-6 round 5) it's off globally — defaulting to `true` for every tool
 * neither has ever explicitly disabled (see the migration's own doc comment
 * for why the store is a disabled-list, not an allow-list). `disabledGlobally`
 * lets the editor grey out and explain a checkbox the agent can't override:
 * toggling *this* agent's own setting back on while a tool is off globally
 * would silently do nothing, which is worse than not offering the toggle at
 * all. Distinct from `PlannerToolApprovalRow`: that gates *when a mutating
 * call still has to ask*; this gates whether the tool is offered to the
 * model at all — a disabled tool never appears in the `tools` array sent
 * upstream, and a call to one anyway (a stale conversation, a model that
 * hallucinates a name) is refused the same way an unknown tool name already
 * is.
 */
export const PlannerAgentToolInfo = z.object({
  name: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  enabled: z.boolean(),
  disabledGlobally: z.boolean(),
});
export type PlannerAgentToolInfo = z.infer<typeof PlannerAgentToolInfo>;

export const PlannerAgentToolsResponse = z.object({
  tools: z.array(PlannerAgentToolInfo),
});
export type PlannerAgentToolsResponse = z.infer<typeof PlannerAgentToolsResponse>;

export const SetPlannerAgentToolRequest = z.object({
  toolName: z.string().min(1),
  enabled: z.boolean(),
});
export type SetPlannerAgentToolRequest = z.infer<typeof SetPlannerAgentToolRequest>;

// ---- Pocket Agents as a selectable "agent" ----------------------------------

/**
 * PA-10: the namespace that lets a Pocket Agent be chosen anywhere a *coding*
 * agent id is chosen — today, an inbound webhook's `agent` field.
 *
 * A webhook (and a cron job, and a session) identifies its agent by a single
 * opaque string resolved against the server's `AgentRegistry` (`claude`,
 * `codex`, …). Rather than adding a parallel `agentKind` discriminator plus a
 * `plannerWorkspaceId` to every one of those specs — two fields whose
 * either/or invariant no type could express, and which every existing reader
 * of `agent` would have to learn about — a Pocket Agent occupies the *same*
 * value space under a reserved prefix: `pocket:<plannerWorkspaceId>`.
 *
 * That choice is what makes the second half of PA-10 ("the Jira tag should
 * support pocket agent too") fall out for free: `resolveLabelOverrides` reads
 * one string out of one Jira label, so a value space with room for a Pocket
 * Agent is the only shape that can express it at all.
 *
 * The prefix is a `:`-bearing string precisely *because* no registry agent id
 * can contain one — `AgentRegistry` ids are bare lowercase words — so a
 * collision is impossible rather than merely unlikely, and an old row written
 * before this feature existed can never accidentally parse as a Pocket Agent.
 *
 * Parsing lives here, in the protocol package, for the same reason
 * `cron-expr.ts` and `webhook-template.ts` do: the server resolves the id to a
 * planner workspace and the editor has to build and recognise the same string,
 * and a second copy of "does this start with `pocket:`" in `apps/web` is a
 * divergence waiting to happen.
 */
export const POCKET_AGENT_ID_PREFIX = 'pocket:';

/** Build the agent id for a Pocket Agent (planner workspace). */
export function pocketAgentId(plannerWorkspaceId: string): string {
  return `${POCKET_AGENT_ID_PREFIX}${plannerWorkspaceId}`;
}

/**
 * The planner workspace id inside a Pocket Agent agent id, or `null` when this
 * is an ordinary coding-agent id.
 *
 * Returns `null` for a bare `'pocket:'` with nothing after it too, so a
 * truncated or hand-edited value degrades to "not a Pocket Agent" (and is then
 * rejected as an unknown *coding* agent) rather than to "some Pocket Agent".
 */
export function parsePocketAgentId(agent: string): string | null {
  if (!agent.startsWith(POCKET_AGENT_ID_PREFIX)) return null;
  const id = agent.slice(POCKET_AGENT_ID_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Whether this agent id names a Pocket Agent rather than a coding agent. */
export function isPocketAgentId(agent: string): boolean {
  return parsePocketAgentId(agent) !== null;
}

/**
 * The token a Jira label uses to name a Pocket Agent: `agent:pocket-<slug>`.
 *
 * A Jira label cannot carry the `pocket:<uuid>` id itself — `resolveLabelOverrides`
 * matches `[a-zA-Z0-9_-]+` after the first separator, so a second colon ends
 * the match, and a workspace uuid is unusable to type by hand regardless. So a
 * label names a Pocket Agent by a slug of its *display name*, resolved against
 * the live list at delivery time.
 *
 * Deliberately the same slug shape `PlannerWorkspaceRegistry`'s own directory
 * naming uses, so "Release Notes" is `pocket-release-notes` in a label and
 * `release-notes` on disk — one mental model, not two.
 */
export const POCKET_AGENT_LABEL_PREFIX = 'pocket-';

export function pocketAgentLabelSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
