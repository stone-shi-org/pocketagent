import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionStatus } from '@pocketagent/protocol';

export type Db = Database.Database;

export interface SessionRow {
  id: string;
  title: string;
  agent: string;
  command: string;
  args_json: string;
  cwd: string;
  env_keys_json: string;
  status: SessionStatus;
  pid: number | null;
  cols: number;
  rows: number;
  exit_code: number | null;
  exit_signal: number | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_activity_at: number | null;
  /** Which process backend owns it: 'direct' or 'tmux'. */
  backend: string;
  /** Backend-specific handle that survives a restart (a tmux session name). */
  external_id: string | null;
  /** 'terminal' | 'structured'. */
  transport: string;
  /** The agent's own conversation id, for resuming a structured session. */
  agent_session_id: string | null;
  /** 1 when this session was started with approvals bypassed. */
  skip_permissions: number;
  /**
   * Stable id of the tmux pane this session adopted (`AdoptableTarget.id`),
   * or null for a session that started its own process. Persisted — not just
   * used transiently to resolve the attach request — so a session row keeps
   * a durable link back to the pane it came from even after the process
   * behind it (the tmux *client*, not the pane) has exited. That link is
   * what lets the home screen collapse repeated detach/reattach cycles on
   * the same pane into one chat instead of a new row every time.
   */
  adopt_target_id: string | null;
}

export interface AuthSessionRow {
  id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS sessions (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    agent            TEXT NOT NULL,
    command          TEXT NOT NULL,
    args_json        TEXT NOT NULL DEFAULT '[]',
    cwd              TEXT NOT NULL,
    env_keys_json    TEXT NOT NULL DEFAULT '[]',
    status           TEXT NOT NULL,
    pid              INTEGER,
    cols             INTEGER NOT NULL,
    rows             INTEGER NOT NULL,
    exit_code        INTEGER,
    exit_signal      INTEGER,
    created_at       INTEGER NOT NULL,
    started_at       INTEGER,
    ended_at         INTEGER,
    last_activity_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions (status);

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);
  `,
  // Durable backends: record which one owns a session and how to find the
  // process again after a restart.
  `
  ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'direct';
  ALTER TABLE sessions ADD COLUMN external_id TEXT;

  CREATE INDEX IF NOT EXISTS idx_sessions_external_id ON sessions (external_id);
  `,
  // Structured sessions: how the session is driven, and the agent's own
  // conversation id so a restarted server can offer to resume it.
  `
  ALTER TABLE sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'terminal';
  ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;
  `,
  // What the user has chosen not to see.
  //
  // `project_visibility` records *decisions*, not a hidden list: build-output
  // directories are hidden by default, so unhiding one has to be storable too.
  // A row here always wins over the default patterns, in either direction.
  //
  // `hidden_chats` is keyed on the agent's conversation id rather than a
  // session id, because the transcript is what would otherwise bring a removed
  // chat back on the next scan of disk.
  `
  CREATE TABLE IF NOT EXISTS project_visibility (
    cwd        TEXT PRIMARY KEY,
    hidden     INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS hidden_chats (
    conversation_id TEXT PRIMARY KEY,
    created_at      INTEGER NOT NULL
  );
  `,
  // Folders the user has added, and a place to remember one-off facts such as
  // whether the initial seed from configuration has already happened.
  //
  // Workspaces moved out of the environment so they can be managed from the
  // UI. Configuration now only *seeds* this table on first run: editing
  // `.env` afterwards would otherwise silently fight what the user added.
  `
  CREATE TABLE IF NOT EXISTS workspaces (
    path     TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Per-session opt-in to bypass approvals. Off by default (see
  // structured-session.ts / claude.ts): recorded so the session list and the
  // live session view can show it persistently rather than only at creation.
  `
  ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0;
  `,
  // Durable identity for an adopted tmux pane. Before this, `adoptTargetId`
  // only ever lived on the create request long enough to resolve which pane
  // to attach to — nothing tied a session row back to that pane afterwards,
  // so detaching and re-attaching from the Shell dialog minted an unrelated
  // new row every time instead of reusing the one that already represented
  // this pane. See `ProjectService`'s grouping in `projects/index.ts`.
  `
  ALTER TABLE sessions ADD COLUMN adopt_target_id TEXT;
  `,
  // Per-agent "last observed live" model/effort cache.
  //
  // Not a user-configured default: a value that updates itself every time a
  // *live* session reports what it's actually running (see
  // `SessionManager.wire`'s `model_changed`/`effort_changed`/`models_available`
  // handling), the same way `derivedTitle` mirrors reality rather than being
  // set by hand. Nothing about model choice is knowable before a session
  // exists — the Claude Agent SDK cannot report a model catalog without a
  // running process — so this is the only way a brand-new session's composer
  // can show (and pre-select) a model at all. Keyed on agent id, not global:
  // different agent CLIs have different model catalogs and effort
  // vocabularies (see `EffortLevel`'s doc comment), so a cached value from one
  // must never leak into another's picker.
  `
  CREATE TABLE IF NOT EXISTS agent_defaults (
    agent_id    TEXT PRIMARY KEY,
    model       TEXT,
    effort      TEXT,
    models_json TEXT,
    updated_at  INTEGER NOT NULL
  );
  `,
  // Scheduled jobs, and the history of what they did.
  //
  // `cron_expr` is the only part of the schedule the scheduler ever reads.
  // `preset_json` is a descriptor of which picker built it (hourly/daily/
  // weekly/monthly at a time), kept solely so the editor can re-open the
  // picker the job was created with instead of dumping the user into the raw
  // expression field. It is never the source of truth: every write recompiles
  // `cron_expr` from it, so the two cannot drift, and a later change to the
  // compiler cannot silently retime a job that already exists.
  //
  // `time_zone` is an IANA name, not a UTC offset, because an offset does not
  // survive DST — and it is per job rather than server-wide, because a server
  // running in UTC still has to honour somebody's local 9am.
  //
  // `effort_set` exists because SQL has one NULL and `CreateSessionRequest`
  // has two absences: an omitted `effort` means "whatever was cached for this
  // agent", an explicit `null` means "the model's own default". Collapsing the
  // two would silently change what a job runs with.
  //
  // `skip_permissions` defaults to 1 here and to 0 everywhere else in this
  // schema. That inversion is deliberate and is documented in CLAUDE.md as an
  // override rather than left to be discovered: a scheduled job is unattended
  // by definition, so approvals routed to a browser nobody is looking at just
  // park the run forever. The invariant that matters still holds — with this
  // 0, an unanswered approval never decays into an allow; the run simply waits.
  //
  // `cron_runs.job_id` is ON DELETE SET NULL, not CASCADE: deleting a job must
  // not erase the record of what it already did, the same discipline that
  // stops "Remove" from deleting a transcript. That is also why `job_name` and
  // `agent` are copied onto every run row — an orphaned run still has to
  // describe itself, and renaming a job must not rewrite what its old runs say
  // they were.
  //
  // `session_id` is deliberately NOT a foreign key. `pruneOldSessions` and
  // `SessionManager.forget` both delete session rows out from under us; a
  // CASCADE there would quietly destroy run history, and a RESTRICT would make
  // pruning fail. A run whose session row is gone renders as "no longer
  // available" instead of vanishing, and `agent_session_id` is kept alongside
  // as the last-resort link to the transcript still on disk.
  `
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 1,

    cron_expr        TEXT NOT NULL,
    time_zone        TEXT NOT NULL,
    schedule_kind    TEXT NOT NULL,
    preset_json      TEXT,

    cwd              TEXT NOT NULL,
    agent            TEXT NOT NULL,
    worktree_mode    TEXT NOT NULL DEFAULT 'none',
    model            TEXT,
    effort           TEXT,
    effort_set       INTEGER NOT NULL DEFAULT 0,
    skip_permissions INTEGER NOT NULL DEFAULT 1,
    prompt           TEXT NOT NULL,
    overlap_policy   TEXT NOT NULL DEFAULT 'skip',

    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    next_run_at      INTEGER,
    last_run_at      INTEGER,
    last_run_status  TEXT,
    last_error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cron_jobs_due ON cron_jobs (enabled, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_cron_jobs_cwd ON cron_jobs (cwd);

  CREATE TABLE IF NOT EXISTS cron_runs (
    id               TEXT PRIMARY KEY,
    job_id           TEXT REFERENCES cron_jobs (id) ON DELETE SET NULL,
    job_name         TEXT NOT NULL,
    agent            TEXT NOT NULL,
    status           TEXT NOT NULL,
    trigger          TEXT NOT NULL,
    scheduled_for    INTEGER NOT NULL,
    started_at       INTEGER NOT NULL,
    finished_at      INTEGER,
    session_id       TEXT,
    agent_session_id TEXT,
    cwd              TEXT,
    error            TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs (job_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs (started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_cron_runs_conversation ON cron_runs (agent_session_id);
  `,
];

/**
 * Key in `settings` for the server-wide "skip all approvals" switch.
 *
 * Persisted rather than left as a pure env var so a runtime toggle (see
 * `PATCH /api/settings`) survives a restart without an operator having to edit
 * `.env`, and so a later restart with a *different* `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS`
 * does not silently fight whatever was last chosen at runtime — the same "config
 * only seeds, the database wins after that" rule `workspaces` already uses.
 */
export const GLOBAL_SKIP_PERMISSIONS_KEY = 'global_skip_permissions';

export function readSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function readWorkspaces(db: Db): string[] {
  const rows = db.prepare('SELECT path FROM workspaces ORDER BY path').all() as {
    path: string;
  }[];
  return rows.map((r) => r.path);
}

export function insertWorkspace(db: Db, path: string): void {
  db.prepare('INSERT OR IGNORE INTO workspaces (path, added_at) VALUES (?, ?)').run(
    path,
    Date.now(),
  );
}

export function deleteWorkspace(db: Db, path: string): boolean {
  return db.prepare('DELETE FROM workspaces WHERE path = ?').run(path).changes > 0;
}

/**
 * `env_keys_json` deliberately stores only the *names* of environment overrides,
 * never their values — the database must not become a place secrets accumulate.
 */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  if (row === undefined) {
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    if (!migration) continue;
    db.exec(migration);
    current = i + 1;
  }
  db.prepare('UPDATE schema_version SET version = ?').run(current);

  return db;
}

/**
 * Anything still marked `starting`/`running` at boot belongs to a dead server,
 * so record it as `interrupted` rather than showing a session the user can
 * never reattach to.
 *
 * `keepAlive` holds the ids of sessions that were genuinely re-adopted from a
 * durable backend — those really are still running and must be left alone.
 */
export function markStaleSessionsInterrupted(
  db: Db,
  keepAlive: readonly string[] = [],
  now = Date.now(),
): number {
  const placeholders = keepAlive.map(() => '?').join(',');
  const exclusion = keepAlive.length > 0 ? ` AND id NOT IN (${placeholders})` : '';
  const result = db
    .prepare(
      `UPDATE sessions
         SET status = 'interrupted', ended_at = COALESCE(ended_at, ?), pid = NULL
       WHERE status IN ('starting', 'running')${exclusion}`,
    )
    .run(now, ...keepAlive);
  return result.changes;
}

export function purgeExpiredAuthSessions(db: Db, now = Date.now()): number {
  return db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now).changes;
}

/**
 * Directories hidden by default because they are build output, not work.
 *
 * Matched on basename. These are defaults only: an explicit row in
 * `project_visibility` overrides them either way, so unhiding `dist` sticks.
 */
export const AUTO_HIDDEN_DIRS: ReadonlySet<string> = new Set([
  '__pycache__',
  'node_modules',
  '.venv',
  'venv',
  '.git',
  'dist',
  'build',
  'target',
  'coverage',
  '.next',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
]);

export interface VisibilityRow {
  cwd: string;
  hidden: number;
}

export function readProjectVisibility(db: Db): Map<string, boolean> {
  const rows = db.prepare('SELECT cwd, hidden FROM project_visibility').all() as VisibilityRow[];
  return new Map(rows.map((r) => [r.cwd, r.hidden === 1]));
}

export function setProjectVisibility(db: Db, cwd: string, hidden: boolean): void {
  db.prepare(
    `INSERT INTO project_visibility (cwd, hidden, created_at) VALUES (?, ?, ?)
       ON CONFLICT(cwd) DO UPDATE SET hidden = excluded.hidden`,
  ).run(cwd, hidden ? 1 : 0, Date.now());
}

export function readHiddenChats(db: Db): Set<string> {
  const rows = db.prepare('SELECT conversation_id FROM hidden_chats').all() as {
    conversation_id: string;
  }[];
  return new Set(rows.map((r) => r.conversation_id));
}

export function hideChat(db: Db, conversationId: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO hidden_chats (conversation_id, created_at) VALUES (?, ?)',
  ).run(conversationId, Date.now());
}

export interface AgentDefaultsRow {
  agent_id: string;
  model: string | null;
  effort: string | null;
  /** Raw JSON of the agent's last-reported `ModelInfo[]` catalog; parsed by the caller. */
  models_json: string | null;
  updated_at: number;
}

export function readAgentDefaults(db: Db, agentId: string): AgentDefaultsRow | null {
  const row = db.prepare('SELECT * FROM agent_defaults WHERE agent_id = ?').get(agentId) as
    | AgentDefaultsRow
    | undefined;
  return row ?? null;
}

/**
 * Merge a partial observation into the cached row for one agent.
 *
 * Model, effort, and the model catalog arrive independently — from separate
 * `model_changed`/`effort_changed`/`models_available` events, often minutes
 * apart — so this is a read-modify-write upsert rather than a plain `INSERT
 * ... ON CONFLICT`: an omitted field must keep whatever was already cached
 * instead of being clobbered back to null.
 */
export function writeAgentDefaults(
  db: Db,
  agentId: string,
  patch: { model?: string | null; effort?: string | null; modelsJson?: string | null },
): void {
  const existing = readAgentDefaults(db, agentId);
  const model = patch.model !== undefined ? patch.model : (existing?.model ?? null);
  const effort = patch.effort !== undefined ? patch.effort : (existing?.effort ?? null);
  const modelsJson = patch.modelsJson !== undefined ? patch.modelsJson : (existing?.models_json ?? null);
  db.prepare(
    `INSERT INTO agent_defaults (agent_id, model, effort, models_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         model = excluded.model, effort = excluded.effort, models_json = excluded.models_json,
         updated_at = excluded.updated_at`,
  ).run(agentId, model, effort, modelsJson, Date.now());
}

export interface CronJobRow {
  id: string;
  name: string;
  enabled: number;
  cron_expr: string;
  /** IANA zone name. */
  time_zone: string;
  /** `'preset' | 'expression'`. */
  schedule_kind: string;
  /** Raw JSON of a `CronSchedulePreset`; parsed by the caller. Non-null iff `schedule_kind` is `'preset'`. */
  preset_json: string | null;
  cwd: string;
  agent: string;
  /** `'none' | 'new-branch' | 'current-branch'`. */
  worktree_mode: string;
  model: string | null;
  effort: string | null;
  /** 1 when `effort` was set explicitly — including explicitly to null. See the migration comment. */
  effort_set: number;
  skip_permissions: number;
  prompt: string;
  /** `'skip' | 'allow'`. */
  overlap_policy: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: string | null;
  last_error: string | null;
}

export interface CronRunRow {
  id: string;
  /** Null once its job has been deleted; `job_name`/`agent` carry on without it. */
  job_id: string | null;
  job_name: string;
  agent: string;
  status: string;
  trigger: string;
  scheduled_for: number;
  started_at: number;
  finished_at: number | null;
  /** Not a foreign key — see the migration comment. */
  session_id: string | null;
  agent_session_id: string | null;
  cwd: string | null;
  error: string | null;
}

export function readCronJobs(db: Db): CronJobRow[] {
  return db.prepare('SELECT * FROM cron_jobs ORDER BY name').all() as CronJobRow[];
}

export function readCronJob(db: Db, id: string): CronJobRow | null {
  return (db.prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id) as CronJobRow | undefined) ?? null;
}

export function insertCronJob(db: Db, row: CronJobRow): void {
  db.prepare(
    `INSERT INTO cron_jobs (
       id, name, enabled, cron_expr, time_zone, schedule_kind, preset_json,
       cwd, agent, worktree_mode, model, effort, effort_set, skip_permissions,
       prompt, overlap_policy, created_at, updated_at, next_run_at, last_run_at,
       last_run_status, last_error
     ) VALUES (
       @id, @name, @enabled, @cron_expr, @time_zone, @schedule_kind, @preset_json,
       @cwd, @agent, @worktree_mode, @model, @effort, @effort_set, @skip_permissions,
       @prompt, @overlap_policy, @created_at, @updated_at, @next_run_at, @last_run_at,
       @last_run_status, @last_error
     )`,
  ).run(row);
}

/** Columns `updateCronJob` is allowed to write. `id`/`created_at` are immutable. */
type CronJobPatch = Partial<Omit<CronJobRow, 'id' | 'created_at'>>;

/**
 * Merge a partial patch into one job row.
 *
 * Read-modify-write for the same reason `writeAgentDefaults` is: `PATCH
 * /api/cron/jobs/:id` is partial, so an omitted field must keep its value
 * rather than be clobbered to NULL. Absence is tested with `in`, never with a
 * null check, because `null` is a real value here — clearing `model`, or an
 * explicitly-default `effort`.
 */
export function updateCronJob(db: Db, id: string, patch: CronJobPatch): CronJobRow | null {
  const existing = readCronJob(db, id);
  if (existing === null) return null;

  const keys = Object.keys(patch).filter((k) => k in patch) as (keyof CronJobPatch)[];
  if (keys.length === 0) return existing;

  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE cron_jobs SET ${assignments} WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])),
    id,
  });
  return readCronJob(db, id);
}

export function deleteCronJob(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM cron_jobs WHERE id = ?').run(id).changes > 0;
}

/**
 * Jobs this tick should consider — one indexed range scan.
 *
 * `next_run_at` is materialized on write rather than computed per tick, so a
 * hundred jobs cost one query instead of a hundred schedule solves.
 */
export function readDueCronJobs(db: Db, now: number): CronJobRow[] {
  return db
    .prepare(
      `SELECT * FROM cron_jobs
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at`,
    )
    .all(now) as CronJobRow[];
}

export function insertCronRun(db: Db, row: CronRunRow): void {
  db.prepare(
    `INSERT INTO cron_runs (
       id, job_id, job_name, agent, status, trigger, scheduled_for, started_at,
       finished_at, session_id, agent_session_id, cwd, error
     ) VALUES (
       @id, @job_id, @job_name, @agent, @status, @trigger, @scheduled_for, @started_at,
       @finished_at, @session_id, @agent_session_id, @cwd, @error
     )`,
  ).run(row);
}

export function updateCronRun(
  db: Db,
  id: string,
  patch: Partial<Omit<CronRunRow, 'id' | 'job_id'>>,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE cron_runs SET ${assignments} WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])),
    id,
  });
}

export function readCronRun(db: Db, id: string): CronRunRow | null {
  return (db.prepare('SELECT * FROM cron_runs WHERE id = ?').get(id) as CronRunRow | undefined) ?? null;
}

/** Newest first. `jobId` omitted lists every job's runs, orphans included. */
export function readCronRuns(db: Db, opts: { jobId?: string; limit: number }): CronRunRow[] {
  if (opts.jobId !== undefined) {
    return db
      .prepare('SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?')
      .all(opts.jobId, opts.limit) as CronRunRow[];
  }
  return db
    .prepare('SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?')
    .all(opts.limit) as CronRunRow[];
}

/** Runs that have not reached a terminal status yet. */
export function readActiveCronRuns(db: Db, jobId?: string): CronRunRow[] {
  const open = `status IN ('starting', 'running')`;
  if (jobId !== undefined) {
    return db
      .prepare(`SELECT * FROM cron_runs WHERE job_id = ? AND ${open}`)
      .all(jobId) as CronRunRow[];
  }
  return db.prepare(`SELECT * FROM cron_runs WHERE ${open}`).all() as CronRunRow[];
}

/**
 * Anything still `starting`/`running` at boot belongs to a dead server.
 *
 * No `keepAlive` exception, unlike `markStaleSessionsInterrupted`: a cron run
 * is always a structured session, and those never survive a restart — the SDK
 * owns the process, so there is nothing to re-adopt.
 */
export function markStaleCronRunsFailed(db: Db, now = Date.now()): number {
  return db
    .prepare(
      `UPDATE cron_runs
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?),
             error = COALESCE(error, 'The server restarted while this run was in progress.')
       WHERE status IN ('starting', 'running')`,
    )
    .run(now).changes;
}

/**
 * Keep run history bounded, per job rather than globally.
 *
 * Global pruning would let one every-15-minutes job evict a monthly job's
 * entire history within a day, which is exactly backwards: the rare job's runs
 * are the ones worth keeping.
 */
export function pruneOldCronRuns(db: Db, keepPerJob: number): number {
  return db
    .prepare(
      `DELETE FROM cron_runs
        WHERE status NOT IN ('starting', 'running')
          AND job_id IS NOT NULL
          AND id NOT IN (
            SELECT id FROM cron_runs AS r
             WHERE r.job_id = cron_runs.job_id
             ORDER BY started_at DESC
             LIMIT ?
          )`,
    )
    .run(keepPerJob).changes;
}

export function deleteCronRunsForJob(db: Db, jobId: string): number {
  return db.prepare('DELETE FROM cron_runs WHERE job_id = ?').run(jobId).changes;
}

/** Which conversations were produced by a scheduled run, for the home screen's badge. */
export function readCronRunConversationIds(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT agent_session_id, job_id FROM cron_runs
        WHERE agent_session_id IS NOT NULL AND job_id IS NOT NULL`,
    )
    .all() as { agent_session_id: string; job_id: string }[];
  return new Map(rows.map((r) => [r.agent_session_id, r.job_id]));
}

/** Keep the session table from growing forever on a long-lived install. */
export function pruneOldSessions(db: Db, keep: number): number {
  return db
    .prepare(
      `DELETE FROM sessions
        WHERE status NOT IN ('starting', 'running')
          AND id NOT IN (
            SELECT id FROM sessions ORDER BY created_at DESC LIMIT ?
          )`,
    )
    .run(keep).changes;
}
