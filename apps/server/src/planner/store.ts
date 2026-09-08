import crypto from 'node:crypto';
import type { PlannerChat, PlannerMemory, PlannerMemoryTier } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/index.js';
import type { PlannerWorkspaceRow, PlannerWorkspaceStore } from './workspaces.js';

// ---- planner_workspaces -----------------------------------------------------

/**
 * Tracks whether `PlannerWorkspaceRegistry.ensureDefaultWorkspace` has ever
 * run, the same way `workspaces_seeded` tracks the project-folder seed —
 * see that key's doc comment in `workspaces/index.ts` for why this has to be
 * a flag rather than "the table is empty".
 */
const PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY = 'planner_default_workspace_seeded';

interface PlannerWorkspaceDbRow {
  id: string;
  name: string;
  path: string;
  is_default: number;
  created_at: number;
  default_model_id: string | null;
  memory_enabled: number;
  last_consolidated_at: number | null;
  mcp_enabled: number;
}

function fromDbRow(row: PlannerWorkspaceDbRow): PlannerWorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    defaultModelId: row.default_model_id,
    memoryEnabled: row.memory_enabled === 1,
    lastConsolidatedAt: row.last_consolidated_at,
    mcpEnabled: row.mcp_enabled === 1,
  };
}

export function createPlannerWorkspaceStore(db: Db): PlannerWorkspaceStore {
  return {
    list: () =>
      (
        db.prepare('SELECT * FROM planner_workspaces ORDER BY created_at').all() as PlannerWorkspaceDbRow[]
      ).map(fromDbRow),
    insert: (row) => {
      db.prepare(
        `INSERT INTO planner_workspaces
           (id, name, path, is_default, created_at, default_model_id, memory_enabled, last_consolidated_at, mcp_enabled)
         VALUES (@id, @name, @path, @isDefault, @createdAt, @defaultModelId, @memoryEnabled, @lastConsolidatedAt, @mcpEnabled)`,
      ).run({
        id: row.id,
        name: row.name,
        path: row.path,
        isDefault: row.isDefault ? 1 : 0,
        createdAt: row.createdAt,
        defaultModelId: row.defaultModelId,
        memoryEnabled: row.memoryEnabled ? 1 : 0,
        lastConsolidatedAt: row.lastConsolidatedAt,
        mcpEnabled: row.mcpEnabled ? 1 : 0,
      });
    },
    delete: (id) => db.prepare('DELETE FROM planner_workspaces WHERE id = ?').run(id).changes > 0,
    rename: (id, name) => {
      db.prepare('UPDATE planner_workspaces SET name = ? WHERE id = ?').run(name, id);
    },
    setDefaultModelId: (id, modelId) => {
      db.prepare('UPDATE planner_workspaces SET default_model_id = ? WHERE id = ?').run(modelId, id);
    },
    setPath: (id, newPath) => {
      db.prepare('UPDATE planner_workspaces SET path = ? WHERE id = ?').run(newPath, id);
    },
    setMemoryEnabled: (id, enabled) => {
      db.prepare('UPDATE planner_workspaces SET memory_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    setMcpEnabled: (id, enabled) => {
      db.prepare('UPDATE planner_workspaces SET mcp_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    setLastConsolidatedAt: (id, at) => {
      db.prepare('UPDATE planner_workspaces SET last_consolidated_at = ? WHERE id = ?').run(at, id);
    },
    isSeeded: () => readSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY) !== null,
    markSeeded: () => writeSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY, new Date().toISOString()),
  };
}

// ---- planner_agent_disabled_tools --------------------------------------------

/**
 * "Tools can be global, but each agent can select their own available
 * tools" (PA-6 round 4). Stores only what's *disabled* — see the migration's
 * own doc comment in `db/index.ts` for why that (rather than an allow-list)
 * is the correct default: every tool starts enabled for every agent,
 * including ones added to the catalog after an agent already existed.
 */
export function readDisabledToolNames(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT tool_name FROM planner_agent_disabled_tools WHERE workspace_id = ?')
    .all(workspaceId) as { tool_name: string }[];
  return new Set(rows.map((r) => r.tool_name));
}

/** Idempotent either way — disabling an already-disabled tool, or enabling
    an already-enabled one, is a no-op rather than an error. */
export function setToolEnabledForWorkspace(
  db: Db,
  workspaceId: string,
  toolName: string,
  enabled: boolean,
): void {
  if (enabled) {
    db.prepare(
      'DELETE FROM planner_agent_disabled_tools WHERE workspace_id = ? AND tool_name = ?',
    ).run(workspaceId, toolName);
  } else {
    db.prepare(
      `INSERT INTO planner_agent_disabled_tools (id, workspace_id, tool_name, created_at)
       VALUES (@id, @workspaceId, @toolName, @createdAt)
       ON CONFLICT (workspace_id, tool_name) DO NOTHING`,
    ).run({ id: crypto.randomUUID(), workspaceId, toolName, createdAt: Date.now() });
  }
}

// ---- planner_global_disabled_tools -------------------------------------------

/**
 * The coarser layer above `readDisabledToolNames`: a tool disabled here is
 * off for every agent, full stop — see the migration's own doc comment for
 * why this is a separate flat table rather than folded into the per-agent
 * one with a nullable `workspace_id`.
 */
export function readGlobalDisabledToolNames(db: Db): Set<string> {
  const rows = db.prepare('SELECT tool_name FROM planner_global_disabled_tools').all() as {
    tool_name: string;
  }[];
  return new Set(rows.map((r) => r.tool_name));
}

/** Idempotent either way, same as `setToolEnabledForWorkspace`. */
export function setToolEnabledGlobally(db: Db, toolName: string, enabled: boolean): void {
  if (enabled) {
    db.prepare('DELETE FROM planner_global_disabled_tools WHERE tool_name = ?').run(toolName);
  } else {
    db.prepare(
      `INSERT INTO planner_global_disabled_tools (tool_name, created_at)
       VALUES (?, ?)
       ON CONFLICT (tool_name) DO NOTHING`,
    ).run(toolName, Date.now());
  }
}

// ---- planner_agent_disabled_skills --------------------------------------------

/**
 * PA-38: the skills equivalent of `readDisabledToolNames`/
 * `setToolEnabledForWorkspace` — see the migration's own doc comment in
 * `db/index.ts` for why `skillId` is namespaced (`global:<slug>` or
 * `<workspaceId>:<slug>`) rather than a bare slug.
 */
export function readDisabledSkillNames(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT skill_id FROM planner_agent_disabled_skills WHERE workspace_id = ?')
    .all(workspaceId) as { skill_id: string }[];
  return new Set(rows.map((r) => r.skill_id));
}

/** Idempotent either way, same as `setToolEnabledForWorkspace`. */
export function setSkillEnabledForWorkspace(
  db: Db,
  workspaceId: string,
  skillId: string,
  enabled: boolean,
): void {
  if (enabled) {
    db.prepare(
      'DELETE FROM planner_agent_disabled_skills WHERE workspace_id = ? AND skill_id = ?',
    ).run(workspaceId, skillId);
  } else {
    db.prepare(
      `INSERT INTO planner_agent_disabled_skills (id, workspace_id, skill_id, created_at)
       VALUES (@id, @workspaceId, @skillId, @createdAt)
       ON CONFLICT (workspace_id, skill_id) DO NOTHING`,
    ).run({ id: crypto.randomUUID(), workspaceId, skillId, createdAt: Date.now() });
  }
}

// ---- planner_global_disabled_skills -------------------------------------------

/**
 * The coarser layer above `readDisabledSkillNames`: a skill disabled here is
 * off for every agent, full stop — see the migration's own doc comment for
 * why this is a separate flat table rather than folded into the per-agent
 * one with a nullable `workspace_id`. Mirrors `readGlobalDisabledToolNames`.
 */
export function readGlobalDisabledSkillNames(db: Db): Set<string> {
  const rows = db.prepare('SELECT skill_id FROM planner_global_disabled_skills').all() as {
    skill_id: string;
  }[];
  return new Set(rows.map((r) => r.skill_id));
}

/** Idempotent either way, same as `setToolEnabledGlobally`. */
export function setSkillEnabledGlobally(db: Db, skillId: string, enabled: boolean): void {
  if (enabled) {
    db.prepare('DELETE FROM planner_global_disabled_skills WHERE skill_id = ?').run(skillId);
  } else {
    db.prepare(
      `INSERT INTO planner_global_disabled_skills (skill_id, created_at)
       VALUES (?, ?)
       ON CONFLICT (skill_id) DO NOTHING`,
    ).run(skillId, Date.now());
  }
}

// ---- planner_models ---------------------------------------------------------

export interface PlannerModelRow {
  id: string;
  modelId: string;
  label: string;
  sortOrder: number;
  createdAt: number;
}

interface PlannerModelDbRow {
  id: string;
  model_id: string;
  label: string;
  sort_order: number;
  created_at: number;
}

function modelFromDbRow(row: PlannerModelDbRow): PlannerModelRow {
  return {
    id: row.id,
    modelId: row.model_id,
    label: row.label,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export function readPlannerModels(db: Db): PlannerModelRow[] {
  return (
    db.prepare('SELECT * FROM planner_models ORDER BY sort_order, created_at').all() as PlannerModelDbRow[]
  ).map(modelFromDbRow);
}

export function insertPlannerModel(db: Db, row: PlannerModelRow): void {
  db.prepare(
    `INSERT INTO planner_models (id, model_id, label, sort_order, created_at)
     VALUES (@id, @modelId, @label, @sortOrder, @createdAt)`,
  ).run(row);
}

export function deletePlannerModel(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_models WHERE id = ?').run(id).changes > 0;
}

/**
 * Empties the catalog in one statement — PA-6 round 7's "delete all" button.
 * Safe to call on an already-empty table (returns 0). Nothing else needs
 * cleaning up alongside it: `planner_chats.last_model_id` and
 * `planner_workspaces.default_model_id` deliberately have no FK to this
 * table, so a chat or an agent still naming a model that is no longer
 * catalogued keeps working — the id is just a string the provider either
 * accepts or doesn't (see both columns' own doc comments).
 */
export function deleteAllPlannerModels(db: Db): number {
  return db.prepare('DELETE FROM planner_models').run().changes;
}

/** Appends new models after whatever is already configured. */
export function nextPlannerModelSortOrder(db: Db): number {
  const row = db.prepare('SELECT MAX(sort_order) as maxOrder FROM planner_models').get() as {
    maxOrder: number | null;
  };
  return (row.maxOrder ?? -1) + 1;
}

// ---- planner LLM provider settings ------------------------------------------
//
// Bespoke `settings` keys, read/written directly rather than through
// `SETTINGS_FIELDS` (`settings/fields.ts`) — these are not `Config` fields
// seeded from `.env`, the same reasoning that keeps `global_skip_permissions`
// out of that table (see `GLOBAL_SKIP_PERMISSIONS_KEY` in `db/index.ts`).

export const PLANNER_LLM_BASE_URL_KEY = 'planner_llm_base_url';

/**
 * Stored in PLAINTEXT, like the webhook secret — the key must be replayed to
 * the provider verbatim, so there is no hashed-verification alternative.
 * Never logged, never returned by a plain read; see `revealPlannerApiKey`.
 */
export const PLANNER_LLM_API_KEY_KEY = 'planner_llm_api_key';

/**
 * Off by default. Not consumed by any code yet — the tool-approval gate that
 * reads this lands in a later phase — but recorded here as part of the
 * settings surface so the Settings page can be built against a stable shape.
 */
export const PLANNER_YOLO_ENABLED_KEY = 'planner_yolo_enabled';

/** Seeds a new chat's model picker; each existing chat keeps its own choice. */
export const PLANNER_LAST_MODEL_ID_KEY = 'planner_last_model_id';

/**
 * PA-29: the embedding provider's own settings — a separate base URL, API
 * key and model from the `PLANNER_LLM_*` ones above, per the approved
 * design ("Embedding need own setting with url, api key, model (in case I
 * deploy service on other place)"). Mirrors the chat-settings keys/functions
 * exactly, one layer down; see `PlannerSettingsDto.embeddingBaseUrl`'s own
 * doc comment (protocol package) for why the two are never folded together.
 */
export const PLANNER_EMBEDDING_BASE_URL_KEY = 'planner_embedding_base_url';

/** Same plaintext-storage reasoning as `PLANNER_LLM_API_KEY_KEY`. */
export const PLANNER_EMBEDDING_API_KEY_KEY = 'planner_embedding_api_key';

export const PLANNER_EMBEDDING_MODEL_ID_KEY = 'planner_embedding_model_id';

/**
 * PA-31: the `web_search` tool's own provider settings. Same plaintext
 * storage rationale as `PLANNER_LLM_API_KEY_KEY` above — this key is
 * replayed verbatim as a bearer token to the configured search endpoint,
 * so there is no hashed-verification alternative. `_ENABLED` is a separate
 * on/off switch from "a base URL is set" for the same reason
 * `CreateCronJobRequest.skipPermissions` documents keeping a
 * consequential default an explicit, separate act: an operator mid-typing
 * a URL must not have the tool start firing before they mean it to.
 */
export const PLANNER_WEB_SEARCH_ENABLED_KEY = 'planner_web_search_enabled';
export const PLANNER_WEB_SEARCH_BASE_URL_KEY = 'planner_web_search_base_url';
export const PLANNER_WEB_SEARCH_API_KEY_KEY = 'planner_web_search_api_key';

/** PA-31: the `url_fetch` tool's own provider settings — deliberately a
    separate provider from `web_search`'s (a search index and a
    page-fetch/scrape service are different products), same shape and
    plaintext-storage rationale one layer down. */
export const PLANNER_URL_FETCH_ENABLED_KEY = 'planner_url_fetch_enabled';
export const PLANNER_URL_FETCH_BASE_URL_KEY = 'planner_url_fetch_base_url';
export const PLANNER_URL_FETCH_API_KEY_KEY = 'planner_url_fetch_api_key';

/**
 * PA-37 follow-up: the global half of the MCP on/off switch — the per-agent
 * half is `planner_workspaces.mcp_enabled`. Unlike `PLANNER_WEB_SEARCH_ENABLED_KEY`/
 * `PLANNER_URL_FETCH_ENABLED_KEY`, which gate a tool that has no meaning
 * until a base URL is entered, MCP already has its own per-registry
 * `enabled`/connect-test gate, so absence of this key means **on** — a
 * fresh deployment with no MCP registries configured behaves identically
 * whether this key is set or not, and only an explicit turn-off changes
 * anything observable.
 */
export const PLANNER_MCP_ENABLED_KEY = 'planner_mcp_enabled';

export interface PlannerSettingsSnapshot {
  baseUrl: string | null;
  hasApiKey: boolean;
  yoloEnabled: boolean;
  lastModelId: string | null;
  embeddingBaseUrl: string | null;
  embeddingHasApiKey: boolean;
  embeddingModelId: string | null;
  webSearchEnabled: boolean;
  webSearchBaseUrl: string | null;
  webSearchHasApiKey: boolean;
  urlFetchEnabled: boolean;
  urlFetchBaseUrl: string | null;
  urlFetchHasApiKey: boolean;
  mcpEnabled: boolean;
}

export function readPlannerSettings(db: Db): PlannerSettingsSnapshot {
  return {
    baseUrl: readSetting(db, PLANNER_LLM_BASE_URL_KEY) || null,
    hasApiKey: (readSetting(db, PLANNER_LLM_API_KEY_KEY) ?? '').length > 0,
    yoloEnabled: readSetting(db, PLANNER_YOLO_ENABLED_KEY) === '1',
    lastModelId: readSetting(db, PLANNER_LAST_MODEL_ID_KEY) || null,
    embeddingBaseUrl: readSetting(db, PLANNER_EMBEDDING_BASE_URL_KEY) || null,
    embeddingHasApiKey: (readSetting(db, PLANNER_EMBEDDING_API_KEY_KEY) ?? '').length > 0,
    embeddingModelId: readSetting(db, PLANNER_EMBEDDING_MODEL_ID_KEY) || null,
    webSearchEnabled: readSetting(db, PLANNER_WEB_SEARCH_ENABLED_KEY) === '1',
    webSearchBaseUrl: readSetting(db, PLANNER_WEB_SEARCH_BASE_URL_KEY) || null,
    webSearchHasApiKey: (readSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY) ?? '').length > 0,
    urlFetchEnabled: readSetting(db, PLANNER_URL_FETCH_ENABLED_KEY) === '1',
    urlFetchBaseUrl: readSetting(db, PLANNER_URL_FETCH_BASE_URL_KEY) || null,
    urlFetchHasApiKey: (readSetting(db, PLANNER_URL_FETCH_API_KEY_KEY) ?? '').length > 0,
    // Absence means on — see `PLANNER_MCP_ENABLED_KEY`'s own doc comment.
    mcpEnabled: readSetting(db, PLANNER_MCP_ENABLED_KEY) !== '0',
  };
}

export function writePlannerMcpEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_MCP_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_LLM_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_LLM_API_KEY_KEY, apiKey ?? '');
}

export function writePlannerYoloEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_YOLO_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerLastModelId(db: Db, modelId: string | null): void {
  writeSetting(db, PLANNER_LAST_MODEL_ID_KEY, modelId ?? '');
}

export function writePlannerEmbeddingBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerEmbeddingApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_API_KEY_KEY, apiKey ?? '');
}

export function writePlannerEmbeddingModelId(db: Db, modelId: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_MODEL_ID_KEY, modelId ?? '');
}

export function writePlannerWebSearchEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_WEB_SEARCH_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerWebSearchBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_WEB_SEARCH_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerWebSearchApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY, apiKey ?? '');
}

export function writePlannerUrlFetchEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_URL_FETCH_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerUrlFetchBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_URL_FETCH_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerUrlFetchApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_URL_FETCH_API_KEY_KEY, apiKey ?? '');
}

/**
 * The one read that carries the key. Rate-limited and logged at the route
 * (`routes/planner.ts`), mirroring `WebhookService.revealSecret` exactly.
 */
export function revealPlannerApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_LLM_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

/** The embedding provider's own reveal — same rate-limit/logging posture,
    at its own route. */
export function revealPlannerEmbeddingApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_EMBEDDING_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

/**
 * PA-31: the `web_search`/`url_fetch` tools' own keys, read fresh on every
 * tool call (`PlannerChatService.executeTool`) — like `plannerYoloEnabled`,
 * a key rotated in Settings must take effect on the very next call, not
 * wait for a restart or a cached snapshot. Unlike `revealPlannerApiKey`/
 * `revealPlannerEmbeddingApiKey` above, these are never reachable over
 * HTTP: nothing outside this server needs to read them back, the same
 * reasoning `CustomClaudeProviderStore`'s API key has no reveal endpoint
 * either.
 */
export function resolvePlannerWebSearchApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

export function resolvePlannerUrlFetchApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_URL_FETCH_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

// ---- planner_chats -----------------------------------------------------------

interface PlannerChatDbRow {
  id: string;
  workspace_id: string | null;
  workspace_name: string;
  title: string | null;
  last_model_id: string | null;
  created_at: number;
  last_activity_at: number;
  skip_tool_approvals: number;
}

function chatFromDbRow(row: PlannerChatDbRow): PlannerChat {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    title: row.title,
    lastModelId: row.last_model_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    skipToolApprovalsEnabled: row.skip_tool_approvals === 1,
  };
}

export function readPlannerChats(db: Db, workspaceId?: string): PlannerChat[] {
  const rows = (
    workspaceId
      ? db
          .prepare('SELECT * FROM planner_chats WHERE workspace_id = ? ORDER BY last_activity_at DESC')
          .all(workspaceId)
      : db.prepare('SELECT * FROM planner_chats ORDER BY last_activity_at DESC').all()
  ) as PlannerChatDbRow[];
  return rows.map(chatFromDbRow);
}

export function readPlannerChat(db: Db, id: string): PlannerChat | null {
  const row = db.prepare('SELECT * FROM planner_chats WHERE id = ?').get(id) as
    | PlannerChatDbRow
    | undefined;
  return row ? chatFromDbRow(row) : null;
}

export function insertPlannerChat(db: Db, chat: PlannerChat): void {
  db.prepare(
    `INSERT INTO planner_chats
       (id, workspace_id, workspace_name, title, last_model_id, created_at, last_activity_at,
        skip_tool_approvals)
     VALUES (@id, @workspaceId, @workspaceName, @title, @lastModelId, @createdAt, @lastActivityAt,
        @skipToolApprovals)`,
  ).run({ ...chat, skipToolApprovals: chat.skipToolApprovalsEnabled ? 1 : 0 });
}

/** Partial update: only the keys present in `patch` are touched. */
export function updatePlannerChat(
  db: Db,
  id: string,
  patch: Partial<Pick<PlannerChat, 'title' | 'lastModelId' | 'lastActivityAt'>>,
): void {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if ('title' in patch) {
    assignments.push('title = @title');
    params.title = patch.title;
  }
  if ('lastModelId' in patch) {
    assignments.push('last_model_id = @lastModelId');
    params.lastModelId = patch.lastModelId;
  }
  if ('lastActivityAt' in patch) {
    assignments.push('last_activity_at = @lastActivityAt');
    params.lastActivityAt = patch.lastActivityAt;
  }
  if (assignments.length === 0) return;
  db.prepare(`UPDATE planner_chats SET ${assignments.join(', ')} WHERE id = @id`).run(params);
}

export function deletePlannerChat(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_chats WHERE id = ?').run(id).changes > 0;
}

/**
 * PA-29: how many of a chat's oldest turns have already been folded into a
 * memory by the rolling window — see the migration's own doc comment for why
 * this exists and why it is not part of the `PlannerChat` protocol type.
 */
export function readPlannerChatMemoryFoldedTurns(db: Db, id: string): number {
  const row = db.prepare('SELECT memory_folded_turns FROM planner_chats WHERE id = ?').get(id) as
    | { memory_folded_turns: number }
    | undefined;
  return row?.memory_folded_turns ?? 0;
}

export function writePlannerChatMemoryFoldedTurns(db: Db, id: string, foldedTurns: number): void {
  db.prepare('UPDATE planner_chats SET memory_folded_turns = ? WHERE id = ?').run(foldedTurns, id);
}

// ---- planner_tool_approvals ---------------------------------------------------

export type PlannerApprovalScope = 'global' | 'workspace';
export type PlannerApprovalDecision = 'allow' | 'deny';

/**
 * `workspaceId` must be non-null for `scope: 'workspace'` and null for
 * `scope: 'global'` — enforced by the one caller that ever writes this row
 * (`planner/approval.ts`), not by the schema (see the migration's own doc
 * comment for why).
 */
export function readPlannerToolApproval(
  db: Db,
  scope: PlannerApprovalScope,
  workspaceId: string | null,
  toolName: string,
): PlannerApprovalDecision | null {
  const row = db
    .prepare(
      `SELECT decision FROM planner_tool_approvals
       WHERE scope = ? AND workspace_id IS ? AND tool_name = ?`,
    )
    .get(scope, workspaceId, toolName) as { decision: PlannerApprovalDecision } | undefined;
  return row?.decision ?? null;
}

export function writePlannerToolApproval(
  db: Db,
  scope: PlannerApprovalScope,
  workspaceId: string | null,
  toolName: string,
  decision: PlannerApprovalDecision,
): void {
  db.prepare(
    `INSERT INTO planner_tool_approvals (id, scope, workspace_id, tool_name, decision, created_at)
     VALUES (@id, @scope, @workspaceId, @toolName, @decision, @createdAt)
     ON CONFLICT (scope, COALESCE(workspace_id, ''), tool_name)
     DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
  ).run({
    id: crypto.randomUUID(),
    scope,
    workspaceId,
    toolName,
    decision,
    createdAt: Date.now(),
  });
}

export interface PlannerToolApprovalRow {
  id: string;
  scope: PlannerApprovalScope;
  workspaceId: string | null;
  toolName: string;
  decision: PlannerApprovalDecision;
  createdAt: number;
}

/**
 * Every remembered decision, for a settings page to list/edit — the "which
 * tool is allowed globally and each workspace" surface, expressed as
 * ordinary rows in the same table the chat's own approval card writes to
 * (PA-6 phase 4/5): pre-configuring a decision here and a human choosing
 * "remember" mid-chat are the same act, just triggered from two different
 * places.
 */
export function readPlannerToolApprovals(db: Db): PlannerToolApprovalRow[] {
  const rows = db
    .prepare('SELECT * FROM planner_tool_approvals ORDER BY created_at DESC')
    .all() as {
    id: string;
    scope: PlannerApprovalScope;
    workspace_id: string | null;
    tool_name: string;
    decision: PlannerApprovalDecision;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    workspaceId: r.workspace_id,
    toolName: r.tool_name,
    decision: r.decision,
    createdAt: r.created_at,
  }));
}

export function deletePlannerToolApproval(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_tool_approvals WHERE id = ?').run(id).changes > 0;
}

// ---- planner_memories ---------------------------------------------------------
//
// PA-29: raw persistence for the memory system, in the same "prepared
// statements, plain functions taking `Db` first" style as every other table
// in this file. `PlannerMemoryService` (`planner/memory.ts`) owns the
// scoring/eviction/ranking logic on top of these; nothing here decides which
// row survives a budget cap or which one a search should surface first.

interface PlannerMemoryDbRow {
  id: string;
  workspace_id: string;
  tier: PlannerMemoryTier;
  content: string;
  importance: number;
  source_chat_id: string | null;
  created_at: number;
  last_accessed_at: number;
  /** PA-29: `NULL` until an embedding provider is configured and this row's
      content has been embedded — see the migration's own doc comment for why
      a mismatched `embedding_model` (or a `NULL` one) must never be compared
      against another row's vector. */
  embedding: Buffer | null;
  embedding_model: string | null;
}

function memoryFromDbRow(row: PlannerMemoryDbRow): PlannerMemory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tier: row.tier,
    content: row.content,
    importance: row.importance,
    sourceChatId: row.source_chat_id,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

export function insertPlannerMemory(db: Db, memory: PlannerMemory): void {
  db.prepare(
    `INSERT INTO planner_memories
       (id, workspace_id, tier, content, importance, source_chat_id, created_at, last_accessed_at)
     VALUES (@id, @workspaceId, @tier, @content, @importance, @sourceChatId, @createdAt, @lastAccessedAt)`,
  ).run(memory);
}

export function readPlannerMemory(db: Db, id: string): PlannerMemory | null {
  const row = db.prepare('SELECT * FROM planner_memories WHERE id = ?').get(id) as
    | PlannerMemoryDbRow
    | undefined;
  return row ? memoryFromDbRow(row) : null;
}

/** Every row of one tier in one workspace — the eviction-budget scan.
    Small by construction (bounded by `MAX_SHORT_TERM_MEMORIES`/
    `MAX_LONG_TERM_MEMORIES` in `planner/memory.ts`), so no `LIMIT` here. */
export function readPlannerMemoriesForTier(
  db: Db,
  workspaceId: string,
  tier: PlannerMemoryTier,
): PlannerMemory[] {
  const rows = db
    .prepare('SELECT * FROM planner_memories WHERE workspace_id = ? AND tier = ?')
    .all(workspaceId, tier) as PlannerMemoryDbRow[];
  return rows.map(memoryFromDbRow);
}

/** Plain listing for a settings UI (PA-29 phase 4) — most-recent-first, no
    relevance scoring. `tier` omitted lists every tier for the workspace. */
export function readPlannerMemories(
  db: Db,
  workspaceId: string,
  tier?: PlannerMemoryTier,
): PlannerMemory[] {
  const rows = (
    tier
      ? db
          .prepare(
            'SELECT * FROM planner_memories WHERE workspace_id = ? AND tier = ? ORDER BY created_at DESC',
          )
          .all(workspaceId, tier)
      : db
          .prepare('SELECT * FROM planner_memories WHERE workspace_id = ? ORDER BY created_at DESC')
          .all(workspaceId)
  ) as PlannerMemoryDbRow[];
  return rows.map(memoryFromDbRow);
}

export function deletePlannerMemory(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_memories WHERE id = ?').run(id).changes > 0;
}

/**
 * `content`/`importance` only — deliberately does not touch `embedding`/
 * `embedding_model`. An edit through this path (the memories settings-page
 * editor) leaves whatever embedding this row already had, now describing
 * text that has changed underneath it; re-embedding on every edit was judged
 * out of scope for this pass (nothing else in this feature re-embeds on
 * edit either), so a hand-edited memory's semantic ranking is stale until a
 * future write path recomputes it. Its lexical (FTS5) ranking is unaffected,
 * since that index is kept in sync by the triggers on every UPDATE.
 */
export function updatePlannerMemory(
  db: Db,
  id: string,
  patch: { content?: string; importance?: number },
): void {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.content !== undefined) {
    assignments.push('content = @content');
    params.content = patch.content;
  }
  if (patch.importance !== undefined) {
    assignments.push('importance = @importance');
    params.importance = patch.importance;
  }
  if (assignments.length === 0) return;
  db.prepare(`UPDATE planner_memories SET ${assignments.join(', ')} WHERE id = @id`).run(params);
}

/** Sets a memory's embedding vector and the model it came from, once
    `PlannerMemoryService.save` has successfully embedded its content — see
    that method's own doc comment for why this is a separate write from the
    initial insert (the row must exist, with its real `content`, before it
    can be embedded) and why a failure here must never fail the save. */
export function updatePlannerMemoryEmbedding(
  db: Db,
  id: string,
  embedding: Buffer,
  embeddingModel: string,
): void {
  db.prepare('UPDATE planner_memories SET embedding = ?, embedding_model = ? WHERE id = ?').run(
    embedding,
    embeddingModel,
    id,
  );
}

/**
 * PA-29: a memory's embedding is stored as a packed `Float32Array` `BLOB`
 * rather than a JSON array of floats — a vector of even a few hundred
 * dimensions as JSON text is several times larger on disk and slower to
 * parse back out, for no benefit, since nothing but this feature's own code
 * ever reads the column directly (it never round-trips through the wire
 * protocol — see `PlannerMemory`'s own schema, which has no `embedding`
 * field at all).
 */
export function encodeEmbedding(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * The inverse of `encodeEmbedding`. Reads via `Buffer.readFloatLE` at each
 * 4-byte offset rather than reinterpreting the blob as a `Float32Array`
 * directly — a `Buffer` handed back by better-sqlite3 is a view into a
 * shared, pooled `ArrayBuffer` whose `byteOffset` is not guaranteed to be a
 * multiple of 4, and `Float32Array`'s constructor throws on a misaligned
 * offset; `readFloatLE` has no such alignment requirement.
 */
export function decodeEmbedding(blob: Buffer): number[] {
  const floatCount = Math.floor(blob.length / 4);
  const vector: number[] = new Array(floatCount);
  for (let i = 0; i < floatCount; i++) {
    vector[i] = blob.readFloatLE(i * 4);
  }
  return vector;
}

/** Bumps `last_accessed_at` for exactly the rows a search actually returned
    to the caller — never for a row only *considered* (an eviction scan, a
    dry-run preview) — see `PlannerMemoryService.search`'s `dryRun` option. */
export function touchPlannerMemoriesLastAccessed(db: Db, ids: readonly string[], now: number): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE planner_memories SET last_accessed_at = ? WHERE id IN (${placeholders})`).run(
    now,
    ...ids,
  );
}

/**
 * One FTS5 hit joined back to its full row, plus SQLite's own `bm25()`
 * relevance for that match (more negative is a better match, SQLite's own
 * convention) — `PlannerMemoryService.search` combines this with `score()`
 * rather than using either alone, so a highly important but only loosely
 * related memory and a perfectly-matched but stale, unimportant one both get
 * a fair hearing.
 */
export interface PlannerMemoryFtsHit {
  memory: PlannerMemory;
  bm25: number;
  /** PA-29: this row's own embedding/model, straight off the row — `null`
      either way when it has never been embedded. `PlannerMemoryService.search`
      decides whether it is usable (matches the *currently configured* model)
      before ever decoding it; this hit type just carries what's on disk. */
  embedding: Buffer | null;
  embeddingModel: string | null;
}

/**
 * Raw FTS5 MATCH query against `planner_memories_fts`, filtered to one
 * workspace (and tier, if given), ordered by textual relevance alone —
 * `PlannerMemoryService.search` re-ranks the top `candidateLimit` of these
 * against `score()` before applying the caller's real `limit`. Returns `[]`
 * for a query with no usable tokens (see `buildFtsMatchQuery`) rather than
 * letting FTS5's query parser throw on an empty or all-punctuation string.
 */
export function searchPlannerMemoriesFts(
  db: Db,
  workspaceId: string,
  queryText: string,
  tier: PlannerMemoryTier | undefined,
  candidateLimit: number,
): PlannerMemoryFtsHit[] {
  const matchQuery = buildFtsMatchQuery(queryText);
  if (matchQuery === null) return [];
  const rows = (
    tier
      ? db
          .prepare(
            `SELECT m.*, bm25(planner_memories_fts) AS rank
             FROM planner_memories_fts
             JOIN planner_memories m ON m.rowid = planner_memories_fts.rowid
             WHERE planner_memories_fts.content MATCH ? AND m.workspace_id = ? AND m.tier = ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(matchQuery, workspaceId, tier, candidateLimit)
      : db
          .prepare(
            `SELECT m.*, bm25(planner_memories_fts) AS rank
             FROM planner_memories_fts
             JOIN planner_memories m ON m.rowid = planner_memories_fts.rowid
             WHERE planner_memories_fts.content MATCH ? AND m.workspace_id = ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(matchQuery, workspaceId, candidateLimit)
  ) as (PlannerMemoryDbRow & { rank: number })[];
  return rows.map((row) => ({
    memory: memoryFromDbRow(row),
    bm25: row.rank,
    embedding: row.embedding,
    embeddingModel: row.embedding_model,
  }));
}

/**
 * Turns arbitrary conversation text into a safe FTS5 `MATCH` argument: split
 * into word tokens, strip everything but letters/digits from each (dropping
 * FTS5's own query syntax characters — `"`, `-`, `*`, `:`, parentheses — so
 * none of them can be smuggled in from a user's own message and change the
 * query's *meaning*, e.g. a leading `-` turning a token into a NOT clause),
 * then phrase-quote each token and OR them together. A `MATCH` with zero
 * tokens throws in SQLite rather than matching nothing, so this returns
 * `null` for that case and the caller treats it as "no results" instead of
 * letting the query throw.
 */
function buildFtsMatchQuery(text: string): string | null {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((token) => token.length > 0)
    // Capped so one very long message cannot build an unbounded MATCH query.
    .slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}
