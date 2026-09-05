import crypto from 'node:crypto';
import type { PlannerChat } from '@pocketagent/protocol';
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
}

function fromDbRow(row: PlannerWorkspaceDbRow): PlannerWorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    defaultModelId: row.default_model_id,
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
        `INSERT INTO planner_workspaces (id, name, path, is_default, created_at, default_model_id)
         VALUES (@id, @name, @path, @isDefault, @createdAt, @defaultModelId)`,
      ).run({
        id: row.id,
        name: row.name,
        path: row.path,
        isDefault: row.isDefault ? 1 : 0,
        createdAt: row.createdAt,
        defaultModelId: row.defaultModelId,
      });
    },
    delete: (id) => db.prepare('DELETE FROM planner_workspaces WHERE id = ?').run(id).changes > 0,
    rename: (id, name) => {
      db.prepare('UPDATE planner_workspaces SET name = ? WHERE id = ?').run(name, id);
    },
    setDefaultModelId: (id, modelId) => {
      db.prepare('UPDATE planner_workspaces SET default_model_id = ? WHERE id = ?').run(modelId, id);
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

export interface PlannerSettingsSnapshot {
  baseUrl: string | null;
  hasApiKey: boolean;
  yoloEnabled: boolean;
  lastModelId: string | null;
}

export function readPlannerSettings(db: Db): PlannerSettingsSnapshot {
  return {
    baseUrl: readSetting(db, PLANNER_LLM_BASE_URL_KEY) || null,
    hasApiKey: (readSetting(db, PLANNER_LLM_API_KEY_KEY) ?? '').length > 0,
    yoloEnabled: readSetting(db, PLANNER_YOLO_ENABLED_KEY) === '1',
    lastModelId: readSetting(db, PLANNER_LAST_MODEL_ID_KEY) || null,
  };
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

/**
 * The one read that carries the key. Rate-limited and logged at the route
 * (`routes/planner.ts`), mirroring `WebhookService.revealSecret` exactly.
 */
export function revealPlannerApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_LLM_API_KEY_KEY);
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
       (id, workspace_id, workspace_name, title, last_model_id, created_at, last_activity_at)
     VALUES (@id, @workspaceId, @workspaceName, @title, @lastModelId, @createdAt, @lastActivityAt)`,
  ).run(chat);
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
