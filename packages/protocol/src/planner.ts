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
  /** PA-29 phase 3: when `MemoryConsolidationService` last folded this
      agent's short-term memories into long-term ones. `null` until that
      service's ticker has run at least once for this agent (a freshly
      created agent, or one whose memory was just turned back on). */
  lastConsolidatedAt: z.number().int().nullable(),
  /**
   * PA-37 follow-up (reporter: "Let's not list the mcp tool as separate
   * tools to allow/disallow. Let's just enable/disable mcp as whole for
   * global or each agent."): whether *this agent* can use any MCP registry's
   * tools at all — the per-agent half of a two-layer on/off switch (the
   * other half is `PlannerSettingsDto.mcpEnabled`, global). Deliberately not
   * a per-tool or per-registry list the way native tools are: an agent
   * editor cannot change what a registry *is* (url/auth stay a global,
   * operator-only resource), only whether this one agent may reach any of
   * them. Both layers must be true for `McpRegistryService.listEnabledTools`
   * to return anything for this workspace — see that method's own doc
   * comment.
   */
  mcpEnabled: z.boolean(),
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
 * `memoryEnabled` (PA-29 phase 4) toggles this agent's memory system on/off
 * — trivially reversible, unlike `path`, so it needs no confirmation step.
 */
export const UpdatePlannerWorkspaceRequest = z.object({
  name: z.string().min(1).max(128).optional(),
  defaultModelId: z.string().max(200).nullable().optional(),
  path: z.string().min(1).max(4096).optional(),
  createPath: z.boolean().optional(),
  memoryEnabled: z.boolean().optional(),
  /** PA-37 follow-up: this agent's own MCP on/off switch — see
      `PlannerWorkspace.mcpEnabled`'s doc comment. Trivially reversible, like
      `memoryEnabled`, so it needs no confirmation step either. */
  mcpEnabled: z.boolean().optional(),
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
  /**
   * PA-29: the embedding provider — deliberately its own base URL, API key
   * and model, never assumed to be the same provider (or even the same
   * deployment) as the chat-completion endpoint above. The reporter's own
   * words: "Embedding need own setting with url, api key, model (in case I
   * deploy service on other place)." Mirrors `baseUrl`/`hasApiKey` exactly,
   * one layer down.
   */
  embeddingBaseUrl: z.string().nullable(),
  embeddingHasApiKey: z.boolean(),
  /** No discovery endpoint for this one (unlike the chat model catalog) — a
      plain text field is enough for v1; see `UpdatePlannerSettingsRequest`. */
  embeddingModelId: z.string().nullable(),
  /**
   * PA-31: the `web_search` tool's own provider — off by default, and
   * inert (`web_search`'s own `execute` refuses) until both a base URL is
   * set and `webSearchEnabled` is turned on. Two knobs rather than one
   * ("configured" vs "on") because an operator entering a URL mid-edit must
   * not have the tool start firing before the key is saved too — the same
   * reasoning `CreateCronJobRequest.skipPermissions` documents for keeping
   * a dangerous default an explicit, separate act.
   */
  webSearchEnabled: z.boolean(),
  webSearchBaseUrl: z.string().nullable(),
  /** No reveal route for this key, unlike `hasApiKey`/`embeddingHasApiKey`
      above — nothing outside this server ever needs to read it back, the
      same reasoning `CustomClaudeProviderStore`'s API key has no reveal
      endpoint either. */
  webSearchHasApiKey: z.boolean(),
  /** PA-31: the `url_fetch` tool's own provider — same on/off/base-url/key
      shape as `webSearch*` above, and deliberately a *separate* provider
      rather than a shared one: a search index and a page-fetch/scrape
      service are different products (the reporter's own example pairs an
      Omniroute-style search endpoint with a Firecrawl-style fetch one), and
      folding them into one config would force them onto the same base URL. */
  urlFetchEnabled: z.boolean(),
  urlFetchBaseUrl: z.string().nullable(),
  urlFetchHasApiKey: z.boolean(),
  /**
   * PA-37 follow-up: the global half of the MCP on/off switch — the other
   * half is per-agent (`PlannerWorkspace.mcpEnabled`). Unlike
   * `webSearchEnabled`/`urlFetchEnabled`, which are off until an operator
   * configures a base URL, this defaults to **on**: an MCP registry already
   * has its own `enabled` flag and its own connect/test gate
   * (`McpRegistrySummary`), so there is no "unconfigured" state this needs
   * to protect against — the switch exists purely so "MCP as a whole" can be
   * turned off globally or for one agent without touching any registry row.
   */
  mcpEnabled: z.boolean(),
});
export type PlannerSettingsDto = z.infer<typeof PlannerSettingsDto>;

/**
 * Every field optional: a PATCH only touches what it sends. `apiKey` omitted
 * leaves the stored key untouched, since the editor is never shown the
 * current value to round-trip. `apiKey: ''` clears it — the same "empty
 * string on the wire means unset" convention `nullableStr` uses elsewhere in
 * this codebase's settings. `embeddingApiKey`/`embeddingBaseUrl`/
 * `embeddingModelId` follow the identical convention, one layer down, for
 * the separate embedding provider (see `PlannerSettingsDto.embeddingBaseUrl`'s
 * doc comment for why it is never folded into the chat provider's own
 * fields).
 */
export const UpdatePlannerSettingsRequest = z.object({
  baseUrl: z.string().max(2048).nullable().optional(),
  apiKey: z.string().max(2048).optional(),
  yoloEnabled: z.boolean().optional(),
  embeddingBaseUrl: z.string().max(2048).nullable().optional(),
  embeddingApiKey: z.string().max(2048).optional(),
  embeddingModelId: z.string().max(200).nullable().optional(),
  /** PA-31: `web_search`/`url_fetch` provider config — same "omitted keeps
      it, empty string clears it" convention as every field above. */
  webSearchEnabled: z.boolean().optional(),
  webSearchBaseUrl: z.string().max(2048).nullable().optional(),
  webSearchApiKey: z.string().max(2048).optional(),
  urlFetchEnabled: z.boolean().optional(),
  urlFetchBaseUrl: z.string().max(2048).nullable().optional(),
  urlFetchApiKey: z.string().max(2048).optional(),
  /** PA-37 follow-up: the global MCP on/off switch — see
      `PlannerSettingsDto.mcpEnabled`'s doc comment. */
  mcpEnabled: z.boolean().optional(),
});
export type UpdatePlannerSettingsRequest = z.infer<typeof UpdatePlannerSettingsRequest>;

/** The one response that carries the key. See `PlannerSettingsDto.hasApiKey`. */
export const PlannerApiKeyRevealResponse = z.object({
  apiKey: z.string(),
});
export type PlannerApiKeyRevealResponse = z.infer<typeof PlannerApiKeyRevealResponse>;

/** The embedding provider's own reveal response — same shape, same
    "explicit, rate-limited, logged" reveal-only rule as the chat key's,
    exported distinctly so a caller can never confuse which key it asked
    for. See `POST /api/planner/settings/embedding-api-key/reveal`. */
export const PlannerEmbeddingApiKeyRevealResponse = z.object({
  apiKey: z.string(),
});
export type PlannerEmbeddingApiKeyRevealResponse = z.infer<typeof PlannerEmbeddingApiKeyRevealResponse>;

/**
 * `POST /api/planner/settings/embeddings/test` round-trips one minimal piece
 * of text through the configured embedding endpoint/model to confirm it
 * actually works — a distinct DTO from `TestPlannerModelResponse` rather
 * than a reuse, because it is testing a different capability (embeddings,
 * not chat completion) at a different endpoint. `dims` is the length of the
 * returned vector, shown so a mismatch between what the editor expects and
 * what the endpoint actually returns is visible at a glance rather than
 * only failing later inside a cosine comparison.
 */
export const TestPlannerEmbeddingResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  dims: z.number().int(),
  latencyMs: z.number().int(),
});
export type TestPlannerEmbeddingResponse = z.infer<typeof TestPlannerEmbeddingResponse>;

/**
 * PA-31: `POST /api/planner/settings/web-search/test` runs one canned query
 * through the configured `web_search` provider (`GET`/`PATCH
 * /api/planner/settings`'s `webSearch*` fields) to confirm the endpoint and
 * key actually work, without needing a chat. Same `ok`/`message`/`latencyMs`
 * shape as `TestPlannerModelResponse` (there is nothing analogous to
 * `TestPlannerEmbeddingResponse.dims` for a search result) — but exported as
 * its own type rather than reused, for the same reason
 * `TestPlannerEmbeddingResponse` is its own type and not a reuse of
 * `TestPlannerModelResponse`: it tests a different capability, at a
 * different endpoint, and a caller must never confuse which one it asked
 * for.
 */
export const TestPlannerWebSearchResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().int(),
});
export type TestPlannerWebSearchResponse = z.infer<typeof TestPlannerWebSearchResponse>;

/** `url_fetch`'s own connection test — same shape and reasoning as
    `TestPlannerWebSearchResponse`, one layer down, at
    `POST /api/planner/settings/url-fetch/test`. */
export const TestPlannerUrlFetchResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().int(),
});
export type TestPlannerUrlFetchResponse = z.infer<typeof TestPlannerUrlFetchResponse>;

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

/**
 * PA-35: `DELETE /api/planner/workspaces/:id/chats`, the bulk counterpart to
 * `DELETE /api/planner/chats/:id` — mirrors `ProjectMenu`'s "Clear N finished
 * chats" for the project-chat tree. Unlike that action, there is no `live`
 * concept to exclude (see `PlannerChat`'s own doc comment: a planner turn runs
 * over a one-way SSE response, not a process anything can observe as "still
 * running"), so this removes every chat in the workspace and reports how many
 * so the UI can confirm it.
 */
export const DeleteAllPlannerChatsResponse = z.object({ removed: z.number().int() });
export type DeleteAllPlannerChatsResponse = z.infer<typeof DeleteAllPlannerChatsResponse>;

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

// ---- Skills (PA-38) ----------------------------------------------------------
//
// A skill is a directory containing a `SKILL.md` (YAML frontmatter naming it,
// then a Markdown body of instructions) that the `use_skill` tool loads
// verbatim into the conversation — inert content, not a capability, so there
// is deliberately no `readOnly` field here the way `PlannerToolInfo` has one:
// loading a skill never touches anything the tool-safety gate cares about,
// and the model then acts using its own, already-gated tools. Every other
// shape below mirrors the tools types one layer up (`PlannerToolInfo`/
// `PlannerAgentToolInfo`/their request types) on purpose — "skills treat same
// as tools" is the same literal design MCP tools already follow (PA-37).

/**
 * The two meta-tool names added to the planner's native catalog
 * (`planner/tools.ts`), named the same way `LIST_MCP_TOOLS_NAME`/
 * `CALL_MCP_TOOL_NAME` are — exported so `PlannerChatService` can
 * special-case them (the omission rule in `toolsFor`) without a second,
 * drifting copy of the literal.
 */
export const LIST_SKILLS_NAME = 'list_skills';
export const USE_SKILL_NAME = 'use_skill';

/**
 * A skill as a settings page's global catalog sees it. `id` is namespaced
 * (`global:<slug>` or `<workspaceId>:<slug>`) so a global skill and a
 * per-workspace skill can reuse the same `slug` without colliding in either
 * deny-list table — see the migration's own doc comment in `db/index.ts`.
 * `source`/`sourceLabel` are always `'global'`/`'Global'` here; the per-agent
 * response below (`PlannerAgentSkillInfo`) is where a workspace-owned skill's
 * own id/name show up instead. `enabled` is this skill's *global* switch,
 * mirroring `PlannerToolInfo.enabled` exactly.
 */
export const PlannerSkillInfo = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  sourceLabel: z.string(),
  enabled: z.boolean(),
});
export type PlannerSkillInfo = z.infer<typeof PlannerSkillInfo>;

export const PlannerSkillListResponse = z.object({ skills: z.array(PlannerSkillInfo) });
export type PlannerSkillListResponse = z.infer<typeof PlannerSkillListResponse>;

export const SetPlannerSkillEnabledRequest = z.object({ enabled: z.boolean() });
export type SetPlannerSkillEnabledRequest = z.infer<typeof SetPlannerSkillEnabledRequest>;

/** Registers a new *global* skill from an existing directory containing a
    parseable `SKILL.md`. A per-workspace skill needs no such route — it is
    just a `.skills/<slug>/SKILL.md` an operator drops into that agent's own
    directory, picked up on the next scan. */
export const RegisterPlannerSkillRequest = z.object({
  path: z.string().min(1),
});
export type RegisterPlannerSkillRequest = z.infer<typeof RegisterPlannerSkillRequest>;

/**
 * PA-38: one agent's own view of the skill catalog — `PlannerAgentToolInfo`'s
 * exact shape, one layer up. `enabled` is the *effective* state for this
 * agent (global AND per-agent); `disabledGlobally` greys out a checkbox the
 * agent can't override, the same reasoning the tools editor already uses.
 * Includes both the global catalog and this agent's own `.skills/` skills,
 * distinguished by `source`/`sourceLabel`.
 */
export const PlannerAgentSkillInfo = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.string(),
  sourceLabel: z.string(),
  enabled: z.boolean(),
  disabledGlobally: z.boolean(),
});
export type PlannerAgentSkillInfo = z.infer<typeof PlannerAgentSkillInfo>;

export const PlannerAgentSkillsResponse = z.object({ skills: z.array(PlannerAgentSkillInfo) });
export type PlannerAgentSkillsResponse = z.infer<typeof PlannerAgentSkillsResponse>;

export const SetPlannerAgentSkillRequest = z.object({
  skillId: z.string().min(1),
  enabled: z.boolean(),
});
export type SetPlannerAgentSkillRequest = z.infer<typeof SetPlannerAgentSkillRequest>;

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
