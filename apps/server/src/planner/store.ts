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
}

function fromDbRow(row: PlannerWorkspaceDbRow): PlannerWorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
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
        `INSERT INTO planner_workspaces (id, name, path, is_default, created_at)
         VALUES (@id, @name, @path, @isDefault, @createdAt)`,
      ).run({
        id: row.id,
        name: row.name,
        path: row.path,
        isDefault: row.isDefault ? 1 : 0,
        createdAt: row.createdAt,
      });
    },
    delete: (id) => db.prepare('DELETE FROM planner_workspaces WHERE id = ?').run(id).changes > 0,
    isSeeded: () => readSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY) !== null,
    markSeeded: () => writeSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY, new Date().toISOString()),
  };
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
