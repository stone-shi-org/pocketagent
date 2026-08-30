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
  // Inbound webhooks, the deliveries they received, and the per-issue
  // conversations they keep.
  //
  // Deliberately not folded into `cron_jobs`/`cron_runs` even though both end up
  // in the same run pipeline (`runs/executor.ts`, called from both services). A
  // delivery has to record a payload, a signature verdict, an event type, an
  // issue key and a body hash — none of which a scheduled firing has any use
  // for, and several of which need their own indexes.
  //
  // `secret` is stored in PLAINTEXT and there is no way around it. HMAC is a
  // keyed MAC: verifying sha256(secret, rawBody) requires the key material
  // itself, so hashing it here would make the primary auth mode
  // unimplementable. `auth_token_hash` is the contrast that proves the point —
  // a bearer token is verified by hashing whatever the sender presented, so it
  // is stored hashed and is never recoverable. Both are shown to the user at
  // creation; the read DTO exposes neither, and `secret` comes back only from an
  // explicit, rate-limited, logged reveal.
  //
  // `skip_permissions` defaults to 0 here, unlike `cron_jobs`. That is not an
  // oversight and it is documented in CLAUDE.md: a scheduled job's inverted
  // default rests on "nobody is awake at 3am", but only half of that transfers.
  // A cron job's prompt is written by the operator; a webhook's is built partly
  // from text a stranger typed into Jira, so inheriting the inversion would be
  // exactly the quiet default flip the first invariant forbids.
  //
  // `filter_json` is one blob rather than five columns for the same reason
  // `preset_json` is: the filter is type-specific (`type = 'jira'` today) and is
  // validated as a whole by a Zod schema on the way in. Nothing ever queries
  // inside it — filters are evaluated in memory against one payload, never
  // across rows.
  //
  // `body_hash` holds sha256 of the raw request body and is the real idempotency
  // key. The obvious choice, Jira's own `X-Atlassian-Webhook-Identifier`, is a
  // *header*, therefore outside the HMAC, therefore attacker-mutable: a captured
  // delivery could be replayed forever with a fresh identifier, the signature
  // would still verify, the uniqueness index would never fire, and an agent
  // would start every time. The header is kept in `delivery_header` as a log
  // hint only. The unique index on (webhook_id, body_hash) is the mechanism:
  // the insert *is* the claim, so there is no read-then-write race and it
  // survives a restart, which an in-memory set does not. SQLite treats NULLs as
  // distinct in a unique index, so orphaned rows whose webhook_id went NULL can
  // never collide with each other.
  //
  // `webhook_deliveries.webhook_id` is ON DELETE SET NULL and carries copies of
  // `webhook_name`/`agent`/`skip_permissions_enabled`, exactly like `cron_runs`:
  // deleting a webhook must not erase the record of what it already ran, and
  // turning the approval toggle off today must not retroactively make last
  // week's bypassed deliveries look supervised. `session_id` is again NOT a
  // foreign key — `pruneOldSessions` and `SessionManager.forget` delete session
  // rows out from under it.
  //
  // `webhook_issue_sessions` is the one table here that CASCADEs, because it is
  // a *cache*, not history: it remembers which conversation and which worktree
  // an issue key is being handled in, so `conversation_mode = 'per-issue'` can
  // resume rather than start over. Deriving that from `webhook_deliveries`
  // instead would have been one fewer table but would tie conversation
  // continuity to delivery retention — the pruner would silently start a fresh
  // conversation for a busy issue. A row here outliving its webhook would be
  // meaningless, hence CASCADE.
  `
  CREATE TABLE IF NOT EXISTS webhooks (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    slug                 TEXT NOT NULL UNIQUE,
    enabled              INTEGER NOT NULL DEFAULT 1,
    type                 TEXT NOT NULL DEFAULT 'jira',

    auth_mode            TEXT NOT NULL DEFAULT 'hmac',
    secret               TEXT NOT NULL,
    auth_token_hash      TEXT,
    secret_set_at        INTEGER NOT NULL,

    filter_json          TEXT NOT NULL DEFAULT '{}',

    cwd                  TEXT NOT NULL,
    agent                TEXT NOT NULL,
    worktree_mode        TEXT NOT NULL DEFAULT 'none',
    model                TEXT,
    effort               TEXT,
    effort_set           INTEGER NOT NULL DEFAULT 0,
    skip_permissions     INTEGER NOT NULL DEFAULT 0,
    prompt_template      TEXT NOT NULL,
    conversation_mode    TEXT NOT NULL DEFAULT 'per-delivery',
    overlap_policy       TEXT NOT NULL DEFAULT 'skip',
    max_concurrent       INTEGER NOT NULL DEFAULT 2,
    debounce_seconds     INTEGER NOT NULL DEFAULT 0,
    store_payloads       INTEGER NOT NULL DEFAULT 1,

    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    last_delivery_at     INTEGER,
    last_delivery_status TEXT,
    last_error           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_webhooks_cwd ON webhooks (cwd);

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id                       TEXT PRIMARY KEY,
    webhook_id               TEXT REFERENCES webhooks (id) ON DELETE SET NULL,
    webhook_name             TEXT NOT NULL,
    agent                    TEXT NOT NULL,
    status                   TEXT NOT NULL,
    trigger                  TEXT NOT NULL DEFAULT 'delivery',

    body_hash                TEXT,
    delivery_header          TEXT,

    event                    TEXT,
    event_type               TEXT,
    issue_key                TEXT,
    project_key              TEXT,
    actor                    TEXT,

    signature_state          TEXT NOT NULL,
    skip_permissions_enabled INTEGER NOT NULL DEFAULT 0,

    payload_json             TEXT,
    payload_bytes            INTEGER NOT NULL DEFAULT 0,
    payload_truncated        INTEGER NOT NULL DEFAULT 0,
    rendered_prompt          TEXT,
    reason                   TEXT,

    received_at              INTEGER NOT NULL,
    started_at               INTEGER,
    finished_at              INTEGER,
    session_id               TEXT,
    agent_session_id         TEXT,
    cwd                      TEXT,
    error                    TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_idem
    ON webhook_deliveries (webhook_id, body_hash);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook
    ON webhook_deliveries (webhook_id, received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
    ON webhook_deliveries (received_at DESC);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_conversation
    ON webhook_deliveries (agent_session_id);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_issue
    ON webhook_deliveries (webhook_id, issue_key, received_at DESC);

  CREATE TABLE IF NOT EXISTS webhook_issue_sessions (
    webhook_id       TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
    issue_key        TEXT NOT NULL,
    agent_session_id TEXT,
    session_id       TEXT,
    cwd              TEXT NOT NULL,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (webhook_id, issue_key)
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_issue_sessions_updated
    ON webhook_issue_sessions (updated_at);
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

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export interface WebhookRow {
  id: string;
  name: string;
  /** Lowercase; the last segment of the delivery URL. Unique. */
  slug: string;
  enabled: number;
  /** `'jira'`. Discriminates `filter_json`. */
  type: string;
  /** `'hmac' | 'bearer'`. */
  auth_mode: string;
  /** Plaintext, unavoidably — see the migration comment. */
  secret: string;
  /** sha256 of the bearer token, when `auth_mode` is `'bearer'`. Never recoverable. */
  auth_token_hash: string | null;
  secret_set_at: number;
  /** Raw JSON of a type-specific filter; parsed and validated by the caller. */
  filter_json: string;
  cwd: string;
  agent: string;
  /** `'none' | 'new-branch' | 'current-branch'`. */
  worktree_mode: string;
  model: string | null;
  effort: string | null;
  /** 1 when `effort` was set explicitly — including explicitly to null. */
  effort_set: number;
  skip_permissions: number;
  prompt_template: string;
  /** `'per-delivery' | 'per-issue'`. */
  conversation_mode: string;
  /** `'skip' | 'allow'`, evaluated per conversation key. */
  overlap_policy: string;
  max_concurrent: number;
  debounce_seconds: number;
  store_payloads: number;
  created_at: number;
  updated_at: number;
  last_delivery_at: number | null;
  last_delivery_status: string | null;
  last_error: string | null;
}

export interface WebhookDeliveryRow {
  id: string;
  /** Null once its webhook has been deleted; the copied columns carry on without it. */
  webhook_id: string | null;
  webhook_name: string;
  agent: string;
  status: string;
  /** `'delivery' | 'test'`. */
  trigger: string;
  /** sha256 of the raw body. The idempotency key — see the migration comment. */
  body_hash: string | null;
  /** `X-Atlassian-Webhook-Identifier`, kept as a log hint only. Never a defence. */
  delivery_header: string | null;
  event: string | null;
  event_type: string | null;
  issue_key: string | null;
  project_key: string | null;
  actor: string | null;
  /** `'valid' | 'invalid' | 'missing' | 'skipped'`. */
  signature_state: string;
  /** Copied at delivery time, so history records what actually ran. */
  skip_permissions_enabled: number;
  payload_json: string | null;
  payload_bytes: number;
  payload_truncated: number;
  rendered_prompt: string | null;
  /** Why it did not run, in words a human can act on. */
  reason: string | null;
  received_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** Not a foreign key — see the migration comment. */
  session_id: string | null;
  agent_session_id: string | null;
  cwd: string | null;
  error: string | null;
}

export interface WebhookIssueSessionRow {
  webhook_id: string;
  issue_key: string;
  agent_session_id: string | null;
  session_id: string | null;
  cwd: string;
  created_at: number;
  updated_at: number;
}

/** Statuses a delivery can still leave, mirroring `readActiveCronRuns`'s pair. */
const OPEN_DELIVERY = `status IN ('starting', 'running')`;

/**
 * Delivery statuses that represent noise rather than work.
 *
 * Pruned on their own budget: a bot spraying a leaked slug with bad signatures
 * would otherwise evict every real run's history within minutes.
 */
const NOISE_STATUSES = [
  'rejected',
  'invalid',
  'duplicate',
  'filtered',
  'throttled',
  'skipped',
] as const;

/** `status IN (…)` over `NOISE_STATUSES`, for a given table alias. */
function noisePredicate(alias: string, negate = false): string {
  const list = NOISE_STATUSES.map((s) => `'${s}'`).join(', ');
  return `${alias}status ${negate ? 'NOT IN' : 'IN'} (${list})`;
}

const NOISE_DELIVERY = noisePredicate('');

export function readWebhooks(db: Db): WebhookRow[] {
  return db.prepare('SELECT * FROM webhooks ORDER BY name').all() as WebhookRow[];
}

export function readWebhook(db: Db, id: string): WebhookRow | null {
  return (db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as WebhookRow | undefined) ?? null;
}

/**
 * Look a webhook up by the URL segment that was requested.
 *
 * Lowercases the argument rather than relying on a case-insensitive collation:
 * storage is always lowercase (uppercase is rejected at the route so the URL you
 * typed is the URL you got), but an admin who pasted a mixed-case URL into Jira
 * should still reach their webhook rather than get an indistinguishable 404.
 */
export function readWebhookBySlug(db: Db, slug: string): WebhookRow | null {
  return (
    (db.prepare('SELECT * FROM webhooks WHERE slug = ?').get(slug.toLowerCase()) as
      | WebhookRow
      | undefined) ?? null
  );
}

export function insertWebhook(db: Db, row: WebhookRow): void {
  db.prepare(
    `INSERT INTO webhooks (
       id, name, slug, enabled, type, auth_mode, secret, auth_token_hash,
       secret_set_at, filter_json, cwd, agent, worktree_mode, model, effort,
       effort_set, skip_permissions, prompt_template, conversation_mode,
       overlap_policy, max_concurrent, debounce_seconds, store_payloads,
       created_at, updated_at, last_delivery_at, last_delivery_status, last_error
     ) VALUES (
       @id, @name, @slug, @enabled, @type, @auth_mode, @secret, @auth_token_hash,
       @secret_set_at, @filter_json, @cwd, @agent, @worktree_mode, @model, @effort,
       @effort_set, @skip_permissions, @prompt_template, @conversation_mode,
       @overlap_policy, @max_concurrent, @debounce_seconds, @store_payloads,
       @created_at, @updated_at, @last_delivery_at, @last_delivery_status, @last_error
     )`,
  ).run(row);
}

/** Columns `updateWebhook` is allowed to write. `id`/`created_at` are immutable. */
type WebhookPatch = Partial<Omit<WebhookRow, 'id' | 'created_at'>>;

/**
 * Merge a partial patch into one webhook row.
 *
 * Read-modify-write for the same reason `updateCronJob` is: `PATCH
 * /api/webhooks/:id` is partial, so an omitted field must keep its value rather
 * than be clobbered to NULL. Absence is tested with `in`, never with a null
 * check, because `null` is a real value here — clearing `model`, or an
 * explicitly-default `effort`.
 */
export function updateWebhook(db: Db, id: string, patch: WebhookPatch): WebhookRow | null {
  const existing = readWebhook(db, id);
  if (existing === null) return null;

  const keys = Object.keys(patch).filter((k) => k in patch) as (keyof WebhookPatch)[];
  if (keys.length === 0) return existing;

  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE webhooks SET ${assignments} WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])),
    id,
  });
  return readWebhook(db, id);
}

export function deleteWebhook(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
}

export function insertWebhookDelivery(db: Db, row: WebhookDeliveryRow): void {
  db.prepare(
    `INSERT INTO webhook_deliveries (
       id, webhook_id, webhook_name, agent, status, trigger, body_hash,
       delivery_header, event, event_type, issue_key, project_key, actor,
       signature_state, skip_permissions_enabled, payload_json, payload_bytes,
       payload_truncated, rendered_prompt, reason, received_at, started_at,
       finished_at, session_id, agent_session_id, cwd, error
     ) VALUES (
       @id, @webhook_id, @webhook_name, @agent, @status, @trigger, @body_hash,
       @delivery_header, @event, @event_type, @issue_key, @project_key, @actor,
       @signature_state, @skip_permissions_enabled, @payload_json, @payload_bytes,
       @payload_truncated, @rendered_prompt, @reason, @received_at, @started_at,
       @finished_at, @session_id, @agent_session_id, @cwd, @error
     )`,
  ).run(row);
}

export function updateWebhookDelivery(
  db: Db,
  id: string,
  patch: Partial<Omit<WebhookDeliveryRow, 'id' | 'webhook_id'>>,
): void {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const assignments = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE webhook_deliveries SET ${assignments} WHERE id = @id`).run({
    ...Object.fromEntries(keys.map((k) => [k, patch[k] ?? null])),
    id,
  });
}

export function readWebhookDelivery(db: Db, id: string): WebhookDeliveryRow | null {
  return (
    (db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as
      | WebhookDeliveryRow
      | undefined) ?? null
  );
}

/**
 * Newest first. `webhookId` omitted lists every webhook's deliveries, orphans
 * included; `includeNoise` false hides the filtered/rejected majority, which is
 * what the UI wants by default — one Jira bulk edit buries the runs worth
 * looking at.
 */
export function readWebhookDeliveries(
  db: Db,
  opts: { webhookId?: string; limit: number; includeNoise?: boolean },
): WebhookDeliveryRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.webhookId !== undefined) {
    clauses.push('webhook_id = ?');
    params.push(opts.webhookId);
  }
  if (opts.includeNoise === false) {
    clauses.push(`NOT ${NOISE_DELIVERY}`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(opts.limit);
  return db
    .prepare(`SELECT * FROM webhook_deliveries ${where} ORDER BY received_at DESC LIMIT ?`)
    .all(...params) as WebhookDeliveryRow[];
}

/** Deliveries that have not reached a terminal status yet. */
export function readActiveWebhookDeliveries(db: Db, webhookId?: string): WebhookDeliveryRow[] {
  if (webhookId !== undefined) {
    return db
      .prepare(`SELECT * FROM webhook_deliveries WHERE webhook_id = ? AND ${OPEN_DELIVERY}`)
      .all(webhookId) as WebhookDeliveryRow[];
  }
  return db
    .prepare(`SELECT * FROM webhook_deliveries WHERE ${OPEN_DELIVERY}`)
    .all() as WebhookDeliveryRow[];
}

/** How many deliveries are mid-run right now, across every webhook. */
export function countActiveWebhookDeliveries(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE ${OPEN_DELIVERY}`)
    .get() as { n: number };
  return row.n;
}

/**
 * Anything still `starting`/`running` at boot belongs to a dead server.
 *
 * Same reasoning as `markStaleCronRunsFailed`: a webhook run is always a
 * structured session, and those never survive a restart.
 */
export function markStaleWebhookDeliveriesFailed(db: Db, now = Date.now()): number {
  return db
    .prepare(
      `UPDATE webhook_deliveries
         SET status = 'failed',
             finished_at = COALESCE(finished_at, ?),
             error = COALESCE(error, 'The server restarted while this delivery was in progress.')
       WHERE ${OPEN_DELIVERY}`,
    )
    .run(now).changes;
}

/**
 * Keep delivery history bounded, in two independent partitions per webhook.
 *
 * One budget would not work here. Unlike a cron job, a webhook receives traffic
 * it did not ask for: anyone who learns a slug can generate unlimited
 * `rejected` rows, and one Jira bulk edit generates hundreds of legitimate
 * `filtered` ones. Pruning the two classes together means either class can evict
 * the runs that actually did something, which is exactly the history worth
 * keeping.
 */
export function pruneOldWebhookDeliveries(
  db: Db,
  opts: { keepRunsPerWebhook: number; keepNoisePerWebhook: number },
): number {
  // The inner predicate is aliased to `d.` so the correlated subquery ranks
  // within the same partition it is deleting from — ranking runs against a list
  // of noise rows would keep the wrong 50.
  const prune = (negate: boolean, keep: number): number =>
    db
      .prepare(
        `DELETE FROM webhook_deliveries
          WHERE NOT ${OPEN_DELIVERY}
            AND webhook_id IS NOT NULL
            AND ${noisePredicate('', negate)}
            AND id NOT IN (
              SELECT d.id FROM webhook_deliveries AS d
               WHERE d.webhook_id = webhook_deliveries.webhook_id
                 AND ${noisePredicate('d.', negate)}
               ORDER BY d.received_at DESC
               LIMIT ?
            )`,
      )
      .run(keep).changes;

  return prune(false, opts.keepNoisePerWebhook) + prune(true, opts.keepRunsPerWebhook);
}

export function deleteWebhookDeliveriesFor(db: Db, webhookId: string): number {
  return db.prepare('DELETE FROM webhook_deliveries WHERE webhook_id = ?').run(webhookId).changes;
}

/** Which conversations were produced by a webhook delivery, for the home screen's badge. */
export function readWebhookDeliveryConversationIds(db: Db): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT agent_session_id, webhook_id FROM webhook_deliveries
        WHERE agent_session_id IS NOT NULL AND webhook_id IS NOT NULL`,
    )
    .all() as { agent_session_id: string; webhook_id: string }[];
  return new Map(rows.map((r) => [r.agent_session_id, r.webhook_id]));
}

export function readWebhookIssueSession(
  db: Db,
  webhookId: string,
  issueKey: string,
): WebhookIssueSessionRow | null {
  return (
    (db
      .prepare('SELECT * FROM webhook_issue_sessions WHERE webhook_id = ? AND issue_key = ?')
      .get(webhookId, issueKey) as WebhookIssueSessionRow | undefined) ?? null
  );
}

/**
 * Remember which conversation and worktree an issue is being handled in.
 *
 * Upsert rather than insert-or-update in two statements: two deliveries for one
 * issue can race, and `ON CONFLICT` makes the second one an update instead of a
 * constraint error.
 */
export function upsertWebhookIssueSession(db: Db, row: WebhookIssueSessionRow): void {
  db.prepare(
    `INSERT INTO webhook_issue_sessions (
       webhook_id, issue_key, agent_session_id, session_id, cwd, created_at, updated_at
     ) VALUES (
       @webhook_id, @issue_key, @agent_session_id, @session_id, @cwd, @created_at, @updated_at
     )
     ON CONFLICT (webhook_id, issue_key) DO UPDATE SET
       agent_session_id = COALESCE(excluded.agent_session_id, agent_session_id),
       session_id       = excluded.session_id,
       cwd              = excluded.cwd,
       updated_at       = excluded.updated_at`,
  ).run(row);
}

/** Bound the per-issue cache. Dropping a row only costs a fresh conversation. */
export function pruneOldWebhookIssueSessions(db: Db, olderThan: number): number {
  return db.prepare('DELETE FROM webhook_issue_sessions WHERE updated_at < ?').run(olderThan)
    .changes;
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
