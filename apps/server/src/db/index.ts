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

/**
 * The `custom_claude_providers` table (PA-28).
 *
 * A named constant rather than an inline migration string because it is used
 * twice: once as a migration, and once as an idempotent repair in
 * `openDatabase` for the positional-migration hazard the two `PRAGMA
 * table_info` probes there already document. Referencing one definition is
 * what keeps the repair from drifting from the migration it repairs.
 */
export const CUSTOM_CLAUDE_PROVIDERS_DDL = `
  CREATE TABLE IF NOT EXISTS custom_claude_providers (
    id                 TEXT PRIMARY KEY,
    name               TEXT NOT NULL,
    provider_kind      TEXT NOT NULL,
    base_url           TEXT NOT NULL,
    api_key_ciphertext TEXT NOT NULL,
    models_json        TEXT NOT NULL,
    default_model      TEXT NOT NULL,
    small_model        TEXT,
    allow_unattended   INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
`;

/**
 * The `mcp_registries` table (PA-37).
 *
 * A named constant for the same reason `CUSTOM_CLAUDE_PROVIDERS_DDL` is one:
 * used both as this migration and as an idempotent repair in `openDatabase`,
 * so a database whose `schema_version` checkpoint lands at or past this
 * migration's index on some other branch's history (the positional-migration
 * hazard documented at the other repairs below) still ends up with this
 * table rather than throwing "no such table" on the first registry query.
 *
 * No new disabled-tool tables ride along with this one — an MCP tool is
 * addressed by `mcpQualifiedToolName(registryId, toolName)` and that string
 * is stored directly in the *existing* `planner_global_disabled_tools`/
 * `planner_agent_disabled_tools`/`planner_tool_approvals` tables. See PA-37's
 * posted plan for why that is the literal reading of "MCP tools treat same
 * as tools," not a parallel system that merely looks similar.
 */
export const MCP_REGISTRIES_DDL = `
  CREATE TABLE IF NOT EXISTS mcp_registries (
    id                       TEXT PRIMARY KEY,
    name                     TEXT NOT NULL,
    transport                TEXT NOT NULL,
    url                      TEXT NOT NULL,
    auth_kind                TEXT NOT NULL DEFAULT 'none',
    bearer_token_ciphertext  TEXT,
    header_name              TEXT,
    header_value_ciphertext  TEXT,
    enabled                  INTEGER NOT NULL DEFAULT 1,
    tool_count               INTEGER NOT NULL DEFAULT 0,
    last_connected_at        INTEGER,
    last_error               TEXT,
    created_at               INTEGER NOT NULL,
    updated_at               INTEGER NOT NULL
  );
`;

/**
 * Exported for one test only: `cron.test.ts` builds a *genuine* historical
 * database by replaying a prefix of this array, rather than by fully migrating
 * and then rewriting `schema_version`. Rewinding a fully-migrated database
 * re-runs every migration appended after the checkpoint, so that shortcut
 * silently depended on the migration under test being the last one in the
 * array — and broke the moment another was appended (PA-10).
 */
export const MIGRATIONS: readonly string[] = [
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
    -- issue_key/project_key hold a Bamboo planKey/derived-project-key for a
    -- type: 'bamboo' webhook -- reused rather than migrated to a neutral name.
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
  // Per-project routing for inbound webhooks: `projectKey -> cwd`, one JSON
  // blob for the same reason `filter_json` is — type-specific, validated as a
  // whole by Zod, never queried inside. `'[]'` (no routing configured) means
  // every delivery keeps running in the webhook's own `cwd`, so this migration
  // changes no existing webhook's behaviour.
  `
  ALTER TABLE webhooks ADD COLUMN project_map_json TEXT NOT NULL DEFAULT '[]';
  `,
  // Calls to POST /api/hooks/:slug that matched no runnable webhook: either the
  // slug does not exist, or it does but the webhook is disabled. The two cases
  // share one table and one code path deliberately, because the load-bearing
  // invariant is that they must stay indistinguishable *from outside* —
  // recording them identically here (one INSERT either way, before the
  // identical 404 is returned) keeps the work profile symmetric rather than
  // opening a new server-side timing difference between "wrong slug" and
  // "right slug, off".
  //
  // Never a payload, a signature, or any other request data: this row exists
  // purely so an operator can see "something hit this endpoint and nothing was
  // listening", not to audit the request. `webhook_id`/`webhook_name` are only
  // ever populated for the disabled case and are copied at hit time so the row
  // still describes itself if the webhook is later deleted — the same
  // discipline `webhook_deliveries.webhook_name` already follows.
  //
  // A separate table rather than folding into `webhook_deliveries`: that
  // table's `webhook_name`/`agent`/`signature_state` columns are NOT NULL,
  // which an unknown-slug hit cannot supply, and SQLite cannot relax a NOT
  // NULL constraint without rebuilding the table. Kept deliberately thin —
  // every row here is noise by definition, pruned as one global partition
  // rather than the per-webhook run/noise split `webhook_deliveries` needs.
  `
  CREATE TABLE IF NOT EXISTS webhook_hit_log (
    id           TEXT PRIMARY KEY,
    slug         TEXT NOT NULL,
    webhook_id   TEXT REFERENCES webhooks (id) ON DELETE SET NULL,
    webhook_name TEXT,
    reason       TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_hit_log_received ON webhook_hit_log (received_at DESC);
  `,
  // Per-issue-type prompt template routing. Serialized as `JiraPromptTemplateMapEntry[]`,
  // parsed and validated as a whole by Zod. `'[]'` means falling back to the
  // webhook's top-level prompt_template.
  `
  ALTER TABLE webhooks ADD COLUMN prompt_template_map_json TEXT NOT NULL DEFAULT '[]';
  `,
  // Auto-select agent and model from Jira issue labels (e.g. agent:claude, model:sonnet).
  `
  ALTER TABLE webhooks ADD COLUMN auto_select_agent_model INTEGER NOT NULL DEFAULT 0;
  `,
  // PA-6, phase 1 (foundation): the planner — an LLM chat with tools that treat
  // existing PocketAgent sessions as sub-agents. This migration lays down only
  // the two tables phase 1 actually uses; `planner_chats` and
  // `planner_tool_approvals` (the chat/approval schema) land in the phases that
  // consume them, so no table sits empty and unread for a release or two.
  //
  // `planner_workspaces` are app-owned scratch/skills directories, NOT a
  // second copy of `workspaces`. A `workspaces` root is one of the user's real
  // code repositories — PocketAgent only ever reads it and checks containment,
  // never writes into it unasked. A planner workspace is the opposite: this
  // app creates it (see `planner/workspaces.ts`'s `ensureDefaultWorkspace`)
  // and the planner's own file/exec tools (a later phase) are allowed to
  // write and delete inside it freely, the same ownership `data/pocketagent.db`
  // already has. `is_default` marks the one seeded at first boot — seeding is
  // tracked by a `planner_default_workspace_seeded` settings flag rather than
  // "table is empty", so deliberately removing the default workspace later
  // does not resurrect it on the next restart, exactly like `workspaces_seeded`.
  //
  // `planner_models` is one row per model offered by the single configured
  // LLM provider (`planner_llm_base_url`/`planner_llm_api_key`, read/written
  // as bespoke `settings` keys below rather than through `SETTINGS_FIELDS` —
  // they are not `Config` fields seeded from `.env`, the same reasoning that
  // keeps `global_skip_permissions` out of that table). Multiple rows are
  // what a chat's model picker switches between; there is deliberately no
  // per-model endpoint or key, since the request was "one provider, several
  // models", not several providers.
  `
  CREATE TABLE IF NOT EXISTS planner_workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS planner_models (
    id         TEXT PRIMARY KEY,
    model_id   TEXT NOT NULL,
    label      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_planner_models_sort ON planner_models (sort_order);
  `,
  // PA-6, phase 2 (chat core): one row per planner chat.
  //
  // `workspace_id` is ON DELETE SET NULL with `workspace_name` copied at
  // creation — the same discipline `cron_runs.job_id`/`webhook_deliveries.webhook_id`
  // already apply: deleting a planner workspace must not erase the chats that
  // lived in it, only detach them. `PlannerChatService.workspacePathFor` falls
  // back to the default workspace's directory for an orphaned chat's
  // transcript, the same way an orphaned cron run still renders using its
  // copied `job_name`.
  //
  // `last_model_id` is null until the first turn picks one (or the chat is
  // created with an explicit model) — see `planner_last_model_id` in
  // `settings`, which this seeds new chats from and which this in turn
  // updates after every turn, so "remember the last selection" works both
  // globally (for a brand new chat) and per-chat (once one has a history of
  // its own to keep consistent).
  //
  // No `planner_messages` table: a chat's transcript is JSONL on disk under
  // its workspace (`<workspace path>/.transcripts/<chatId>.jsonl`), the same
  // "transcript lives on disk, the database only indexes it" split
  // `conversations/index.ts` already uses for Claude Code's own transcripts.
  `
  CREATE TABLE IF NOT EXISTS planner_chats (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT REFERENCES planner_workspaces (id) ON DELETE SET NULL,
    workspace_name   TEXT NOT NULL,
    title            TEXT,
    last_model_id    TEXT,
    created_at       INTEGER NOT NULL,
    last_activity_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_planner_chats_activity ON planner_chats (last_activity_at DESC);
  CREATE INDEX IF NOT EXISTS idx_planner_chats_workspace ON planner_chats (workspace_id, last_activity_at DESC);
  `,
  // PA-6, phase 4: remembered decisions for the planner's mutating-tool
  // approval gate — "remember for this workspace" or "remember globally",
  // per the reporter's answer to open question 2 (both scopes, offered as a
  // choice at approval time, uniformly for every mutating tool including
  // `exec_command`).
  //
  // This is new persistence this codebase has never had. Every existing
  // approval mechanism is coarser: the Claude Agent SDK's own
  // `allow_session` (`structured-session.ts`) lives only in-memory for the
  // life of one process, and cron/webhooks each have a single all-or-nothing
  // `skip_permissions` boolean — neither remembers a decision *per tool*.
  //
  // `workspace_id` is deliberately not a foreign key to `planner_workspaces`:
  // a remembered decision for a workspace that is later deleted should not
  // vanish along with it (the same row could apply again if a workspace with
  // the same id could ever come back — it can't, ids are random — so in
  // practice a dangling row is simply inert, never wrongly reapplied to a
  // different workspace). `scope = 'global'` rows always have `workspace_id
  // IS NULL`; enforced by the application, not by the schema, since SQLite
  // has no partial-CHECK short of a trigger and the write path is the single
  // place this row is ever created (`planner/approval.ts`).
  //
  // The unique index uses `COALESCE(workspace_id, '')`: SQLite treats NULL as
  // distinct from every other NULL in a unique index, which would otherwise
  // let two 'global' rows coexist for the same tool.
  `
  CREATE TABLE IF NOT EXISTS planner_tool_approvals (
    id           TEXT PRIMARY KEY,
    scope        TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
    workspace_id TEXT,
    tool_name    TEXT NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    created_at   INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_tool_approvals_unique
    ON planner_tool_approvals (scope, COALESCE(workspace_id, ''), tool_name);
  `,
  // PA-6 round 4 (reporter: "current multiple agents design is just name,
  // actual I need real multiple agents"): each agent gets its own default
  // model and its own tool subset, not just a name and a directory.
  //
  // `default_model_id` has no FK to `planner_models` — same reasoning
  // `planner_chats.last_model_id` already has none: a model can be removed
  // from the catalog independently, and a dangling id here just means
  // `PlannerChatService.create` falls back to the global last-used model
  // instead, never a broken reference.
  //
  // `planner_agent_disabled_tools` stores only what's *turned off* — the
  // catalog (`planner/tools.ts`) stays global and every tool defaults to
  // enabled for every agent, so adding a brand new tool to the catalog
  // automatically reaches every existing agent with no backfill, and an
  // agent created before this migration is unaffected until someone
  // explicitly restricts it. This is deliberately the opposite structure
  // from `planner_tool_approvals` (which records a *decision made*, worth
  // keeping even for a deleted workspace) — a disabled-tool row is pure
  // current configuration of an agent that, once gone, makes the row
  // meaningless, so `ON DELETE CASCADE` here is correct where
  // `planner_tool_approvals.workspace_id` deliberately has no FK at all.
  `
  ALTER TABLE planner_workspaces ADD COLUMN default_model_id TEXT;

  CREATE TABLE IF NOT EXISTS planner_agent_disabled_tools (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES planner_workspaces (id) ON DELETE CASCADE,
    tool_name    TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_agent_disabled_tools_unique
    ON planner_agent_disabled_tools (workspace_id, tool_name);
  `,
  // PA-6 round 5 (reporter: "in global setting, add section called 'tools'
  // list global available tools, you can disable or enable globally"): a
  // second, coarser layer above `planner_agent_disabled_tools` — a tool
  // disabled here is off for *every* agent, full stop, regardless of that
  // agent's own per-tool setting. A separate table rather than reusing the
  // per-agent one with a nullable `workspace_id` (the way
  // `planner_tool_approvals.scope` does): there is no per-row scope
  // ambiguity to resolve here, so a flat table of tool names is simpler and
  // needs no `COALESCE`-based unique index. `tool_name` is the primary key
  // (no synthetic id) since there is at most one row per tool, globally.
  `
  CREATE TABLE IF NOT EXISTS planner_global_disabled_tools (
    tool_name  TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  `,
  // A one-shot continuation is still a real cron job — visible and durable
  // until it fires — but it resumes the refused conversation and removes its
  // own job row immediately after handing the run to the executor. This must
  // stay appended: existing databases have already recorded every migration
  // above it in `schema_version`.
  `
  ALTER TABLE cron_jobs ADD COLUMN resume_agent_session_id TEXT;
  ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER NOT NULL DEFAULT 0;
  `,
  // PA-10 (reporter: "Today, webhook can only select code agent, need add
  // 'pocket agent' agents in there too. The Jira tag should support pocket
  // agent too."): a webhook's `agent` may now name a Pocket Agent as
  // `pocket:<planner_workspace_id>` (see `POCKET_AGENT_ID_PREFIX`). No column
  // changes for that part — `webhooks.agent` is already TEXT and the whole
  // point of the namespaced-id design is that every existing row and reader
  // stays valid. What *is* new is where a pocket run's output lives.
  //
  // `webhook_deliveries.planner_chat_id` is the pocket equivalent of
  // `session_id`/`agent_session_id`: a pocket run creates no session, so
  // without it a delivery would have nothing to link to. Deliberately not a
  // foreign key, for exactly the reason `session_id` isn't one — a chat can be
  // deleted from the Pocket Agent UI long after the delivery, and a CASCADE
  // would quietly destroy history while a RESTRICT would make deleting a chat
  // fail. An orphaned id simply stops resolving, the same way a pruned
  // `session_id` does.
  //
  // `webhook_issue_sessions.planner_chat_id` is what makes `per-issue` mode
  // work for a Pocket Agent: that table is already the "which conversation
  // belongs to this issue" cache, and a pocket conversation is a chat rather
  // than a session. Still a cache — a pruned row means the next event on that
  // issue starts a fresh chat, exactly as it already means for a session.
  //
  // `planner_chats.skip_tool_approvals` records that a chat's mutating tool
  // calls are pre-approved because an unattended trigger created it with its
  // own skip-permissions decision already made. On the *chat* rather than
  // threaded through a turn because it has to survive an approval pause, a
  // restart, and a `per-issue` webhook reusing the chat for a later delivery.
  // `DEFAULT 0`, so every chat that already exists — and every chat a human
  // creates — is unaffected: there is no HTTP field that can set this.
  `
  ALTER TABLE webhook_deliveries ADD COLUMN planner_chat_id TEXT;
  ALTER TABLE webhook_issue_sessions ADD COLUMN planner_chat_id TEXT;
  ALTER TABLE planner_chats ADD COLUMN skip_tool_approvals INTEGER NOT NULL DEFAULT 0;
  `,
  // PA-11: the directory queue. A delivery that cannot start because another
  // agent is mid-turn in the same working tree waits here instead of running
  // concurrently (corrupting the tree) or being dropped.
  //
  // `queued_spec_json` freezes the *fully resolved* run — prompt included — at
  // delivery time. It has to: `store_payloads` may be false, so the payload
  // that produced this run may not exist to re-render from, and even when it
  // does, re-rendering later would re-decide the agent, model and branch from
  // data that has since changed. Nullable rather than NOT NULL because the
  // overwhelming majority of deliveries never queue, and SQLite cannot relax a
  // NOT NULL later without rebuilding the table.
  `
  ALTER TABLE webhook_deliveries ADD COLUMN queue_key TEXT;
  ALTER TABLE webhook_deliveries ADD COLUMN queued_at INTEGER;
  ALTER TABLE webhook_deliveries ADD COLUMN queued_spec_json TEXT;

  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_queued
    ON webhook_deliveries (queue_key, queued_at)
    WHERE status = 'queued';
  `,
  // PA-11: per-webhook directory policy, and the removal of `debounce_seconds`.
  //
  // `'queue'` is the backfilled default for *existing* webhooks as well as new
  // ones, which is a deliberate behaviour change approved on the ticket: the
  // previous behaviour for two deliveries racing into one directory was not a
  // considered `allow`, it was the absence of any check at all, and queueing
  // loses no work — unlike the same-webhook `skip` policy, it only delays.
  //
  // `debounce_seconds` is dropped rather than left dormant. It was stored,
  // editable and displayed, and it delayed nothing whatsoever: the timer map
  // that would have implemented it was only ever cleared, never populated. A
  // column that promises a behaviour the code does not have is worse than no
  // column, and the queue now covers the burst it was meant to smooth.
  `
  ALTER TABLE webhooks ADD COLUMN directory_policy TEXT NOT NULL DEFAULT 'queue';
  ALTER TABLE webhooks DROP COLUMN debounce_seconds;
  `,
  // PA-11: a human's own follow-up prompt, waiting for a working tree.
  //
  // Persisted rather than held in memory, unlike the dead debounce map it
  // replaces, and for the opposite reason: a debounce was a delay nobody had
  // been promised, whereas this is a message a person typed and pressed send
  // on. Losing it to a restart would be the one outcome this feature must never
  // produce, so the row outlives the process and is re-queued at boot.
  //
  // An attached image is deliberately *not* stored here. `ws/index.ts` has
  // already written it into the workspace and appended its path to `text`, so
  // the agent can still read it; keeping the base64 would put rows of several
  // megabytes into a database that otherwise holds only metadata.
  //
  // `session_id` is not a foreign key, for the same reason `cron_runs.session_id`
  // is not: `pruneOldSessions` and `SessionManager.forget` delete session rows,
  // and a CASCADE would silently discard a queued message while a RESTRICT
  // would make pruning fail.
  `
  CREATE TABLE IF NOT EXISTS session_prompt_queue (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tree_root  TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_session_prompt_queue_tree
    ON session_prompt_queue (tree_root, created_at);
  CREATE INDEX IF NOT EXISTS idx_session_prompt_queue_session
    ON session_prompt_queue (session_id);
  `,
  // PA-26 (reporter: "If jira ticket changed tag for agent, webhook should
  // horner that"): which agent the conversation cached for an issue belongs to.
  //
  // `webhook_issue_sessions` answers "what conversation is this issue already
  // being handled in", and `per-issue` mode resumes it. It never recorded *who*
  // was handling it, so a `agent:<other>` label added to a ticket after the
  // first delivery resumed the previous agent's transcript with the new agent's
  // CLI — the label was honoured for the spec and then ignored for the
  // conversation, which is both the reported bug and a cross-agent transcript
  // resume that could not have worked.
  //
  // Nullable, and NULL deliberately means *unknown* rather than "no agent": a
  // row written before this column existed must keep continuing its
  // conversation, not be abandoned on the next delivery for a mismatch nobody
  // can prove. It is stamped on the next write either way.
  `
  ALTER TABLE webhook_issue_sessions ADD COLUMN agent TEXT;
  `,
  // PA-28: user-managed Claude Code provider variants, replacing the two
  // compiled-in ones that came from `POCKETAGENT_DEEPSEEK_*` /
  // `POCKETAGENT_OMNIROUTE_*` (PA-19).
  //
  // `id` is the full agent id (`custom-claude:<slug>-<hex>`), not a bare uuid,
  // because that string is what a session row, a cron job and a webhook all
  // store in their own `agent` column. Keying on the same value those rows
  // carry means a provider can be looked up straight from one of them with no
  // translation step to get wrong.
  //
  // `api_key_ciphertext` is AES-256-GCM, base64 of `iv || tag || ciphertext`
  // (`crypto/secret-box.ts`), and is the first encrypted-at-rest column in this
  // database. NOT NULL: a provider with no credential is an agent that greys
  // out and can do nothing, so there is no state worth representing. Deliberately
  // *no* `api_key` plaintext column ever existed, so there is no migration path
  // by which one could be left behind.
  //
  // `models_json` is a JSON array of model ids rather than a child table: it is
  // read and written whole, only ever by this one provider's own adapter, and a
  // table would add a join to produce a list nothing else joins against.
  //
  // `allow_unattended` defaults to 0 — see the "never unattended" invariant in
  // CLAUDE.md. It drives `AgentAdapter.requiresAttendedUse` directly, so the
  // existing route checks in `routes/shared.ts` need no branch for it.
  CUSTOM_CLAUDE_PROVIDERS_DDL,
  // PA-29: a memory system so a Pocket Agent's chats don't forget things
  // within/between conversations. `planner_memories` holds both tiers — a
  // 'short' row folded in automatically as the rolling window in
  // `eventsToLlmMessages` evicts old turns (`PlannerChatService`), and a
  // 'long' row a later consolidation pass (PA-29 phase 3, not this
  // migration's concern) writes directly — so `tier` is a plain CHECK'd
  // column rather than two tables.
  //
  // `workspace_id` is `ON DELETE CASCADE`, unlike `planner_chats.workspace_id`
  // (`SET NULL`) or `planner_agent_disabled_tools.workspace_id` (also
  // CASCADE) — worth spelling out which side of that split this falls on. A
  // memory exists to make *this agent* sharper; it has no meaning once the
  // agent it was recalled for is gone, and there is no orphan-browsing UI for
  // it the way a cron run or webhook delivery has for its own history. That
  // is the same "cache vs. history" line this codebase already draws between
  // `webhook_issue_sessions` (CASCADEs) and `webhook_deliveries` (SET NULL
  // with fields copied) — a memory row is the cache side of that line, not
  // the history side.
  //
  // `source_chat_id` is deliberately not a foreign key, for the same reason
  // `cron_runs.session_id` isn't one: a chat can be deleted long after a
  // memory folded out of it was written, and a CASCADE would delete memories
  // a still-live agent may depend on while a RESTRICT would block deleting
  // the chat. An orphaned id simply stops resolving to anything, same as a
  // pruned session id already does elsewhere.
  //
  // `importance` is a 1-5 integer the model (or the rolling-window fold's own
  // heuristic) assigns at write time; `score()` in `planner/memory.ts` is the
  // one function that turns `importance` and `last_accessed_at` into a
  // ranking number, used identically by eviction (phase 1) and search
  // relevance (also phase 1) — "one function, two call sites" per the
  // approved design, so the two can never silently diverge on what "worth
  // keeping" means.
  //
  // The FTS5 virtual table mirrors `planner_memories` by rowid
  // (`content='planner_memories', content_rowid='rowid'`) rather than storing
  // its own copy of the text, and the three triggers below are the standard
  // idiom for keeping an external-content FTS5 index in sync with inserts,
  // deletes, and updates to the table it shadows — nothing here is
  // PocketAgent-specific. `better-sqlite3`'s bundled SQLite build includes
  // FTS5 (verified empirically: no separate extension load is needed), so no
  // new dependency was required to add this.
  //
  // `planner_workspaces.last_consolidated_at` and `.memory_enabled` are added
  // here rather than in a later migration even though nothing yet writes the
  // former: PA-29 phase 3 (consolidation) and phase 4 (settings UI) are
  // follow-up work that read these same columns, and splitting one
  // conceptual "add the memory feature's schema" change across two
  // migrations just for that would make the history harder to read, not
  // safer. `memory_enabled` defaults to 1 (on) so every existing agent gets
  // the feature the moment this migration runs, matching this codebase's
  // general "additive column, opt-out not opt-in" default for a feature with
  // no safety reason to start disabled.
  //
  // `planner_chats.memory_folded_turns` is what keeps the rolling-window
  // fold in `PlannerChatService` idempotent. A chat's transcript file is
  // append-only and re-read in full on every turn, so without a persisted
  // "how much of the oldest history is already folded" marker, every turn
  // past the window would re-summarize and re-save the same growing prefix
  // of old turns into a fresh memory row — this counter is what lets a turn
  // fold only the span that just fell out of the window since the *last*
  // turn. Not part of the `PlannerChat` protocol type: it is a pure
  // implementation detail of the fold, not something any client reads.
  `
  CREATE TABLE IF NOT EXISTS planner_memories (
    id               TEXT PRIMARY KEY,
    workspace_id     TEXT NOT NULL REFERENCES planner_workspaces (id) ON DELETE CASCADE,
    tier             TEXT NOT NULL CHECK (tier IN ('short', 'long')),
    content          TEXT NOT NULL,
    importance       INTEGER NOT NULL DEFAULT 3,
    source_chat_id   TEXT,
    created_at       INTEGER NOT NULL,
    last_accessed_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_planner_memories_workspace ON planner_memories (workspace_id, tier);

  CREATE VIRTUAL TABLE IF NOT EXISTS planner_memories_fts USING fts5(
    content, content='planner_memories', content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS planner_memories_ai AFTER INSERT ON planner_memories BEGIN
    INSERT INTO planner_memories_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS planner_memories_ad AFTER DELETE ON planner_memories BEGIN
    INSERT INTO planner_memories_fts (planner_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS planner_memories_au AFTER UPDATE ON planner_memories BEGIN
    INSERT INTO planner_memories_fts (planner_memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO planner_memories_fts (rowid, content) VALUES (new.rowid, new.content);
  END;

  ALTER TABLE planner_workspaces ADD COLUMN last_consolidated_at INTEGER;
  ALTER TABLE planner_workspaces ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE planner_chats ADD COLUMN memory_folded_turns INTEGER NOT NULL DEFAULT 0;
  `,
  // PA-29 (reporter: "Go ahead do it. Embedding need own setting with url,
  // api key, model (in case I deploy service on other place)"): semantic
  // ranking on top of the lexical (FTS5) ranking the previous migration
  // already added — a memory's embedding, computed at write time against
  // whichever embedding provider is configured then.
  //
  // `embedding_model` is what makes this safe to add without a backfill:
  // a memory's vector is only meaningful compared against another vector
  // from the *same* embedding model (different models place semantically
  // identical text at unrelated points in unrelated vector spaces, so a
  // cosine similarity between two vectors from different models is not
  // merely noisy, it is meaningless). Recording provenance per-row, rather
  // than assuming "whatever is configured now", is what lets
  // `PlannerMemoryService.search` skip (fall back to lexical-only ranking
  // for) any row whose `embedding_model` doesn't match the one configured
  // right now — a row saved before embeddings were configured, or under a
  // since-changed provider, degrades gracefully instead of corrupting the
  // ranking silently.
  //
  // Both columns are nullable with no default beyond SQLite's own implicit
  // `NULL`: `embedding` stays `NULL` for every row until this feature is
  // configured and used, and stays `NULL` forever for a row saved while it
  // was unconfigured — that row simply never participates in the semantic
  // half of ranking, the same "an unconfigured feature is a common, expected
  // steady state, never an error" posture the chat LLM endpoint itself
  // already has elsewhere in this file.
  //
  // The vector itself is a packed `Float32Array` `BLOB` (`encodeEmbedding`/
  // `decodeEmbedding` in `planner/store.ts`), not a JSON array of floats —
  // see those functions' own doc comments for why.
  `
  ALTER TABLE planner_memories ADD COLUMN embedding BLOB;
  ALTER TABLE planner_memories ADD COLUMN embedding_model TEXT;
  `,
  // PA-37: MCP registries — see `MCP_REGISTRIES_DDL`'s own doc comment for why
  // the DDL lives in a named constant rather than inline here.
  MCP_REGISTRIES_DDL,
  // PA-38: skills. A skill is a directory containing a `SKILL.md` (YAML
  // frontmatter plus a Markdown body) that `use_skill` loads verbatim into
  // the conversation — inert content, not a capability, so there is no
  // approval mechanism of its own; the model then acts using its existing,
  // already-gated tools. There is deliberately no `planner_skills` content
  // table: the filesystem is the source of truth (a global root scanned by
  // `SkillRegistryService`, plus each planner workspace's own `.skills/`
  // directory), and these two tables store only *enablement decisions* — the
  // exact split `planner_global_disabled_tools`/`planner_agent_disabled_tools`
  // already draw for the native tool catalog, one layer up.
  //
  // `skill_id` is namespaced (`global:<slug>` or `<workspaceId>:<slug>`,
  // never a bare slug) in both tables, because a global skill and a
  // per-workspace skill are allowed to reuse the same slug (they are
  // authored independently, often by copying an example) — a bare slug would
  // let disabling one silently disable the other. `planner_global_disabled_skills`
  // is a flat table keyed on the namespaced id alone (no synthetic id column,
  // same reasoning `planner_global_disabled_tools` gives: there is at most one
  // row per skill, globally, and no per-row scope ambiguity to resolve).
  // `planner_agent_disabled_skills` mirrors `planner_agent_disabled_tools`
  // exactly, including `ON DELETE CASCADE` on `workspace_id` (this row is
  // pure current configuration of an agent that, once gone, makes the row
  // meaningless) and the same `(workspace_id, skill_id)` unique index.
  `
  CREATE TABLE IF NOT EXISTS planner_global_disabled_skills (
    skill_id   TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS planner_agent_disabled_skills (
    id           TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES planner_workspaces (id) ON DELETE CASCADE,
    skill_id     TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_planner_agent_disabled_skills_unique
    ON planner_agent_disabled_skills (workspace_id, skill_id);
  `,
  // PA-37 follow-up (reporter: "Let's not list the mcp tool as separate
  // tools to allow/disallow. Let's just enable/disable mcp as whole for
  // global or each agent."): a per-agent MCP on/off switch, the same shape
  // as `memory_enabled` one layer above — defaults to 1 (on) so every
  // existing agent is unaffected until someone explicitly turns it off, the
  // same "adding a feature must not silently restrict what already worked"
  // discipline every other per-agent toggle in this table follows. The
  // global half of the switch is a plain `settings` row
  // (`PLANNER_MCP_ENABLED_KEY`, `planner/store.ts`), not a column here — it
  // has no per-agent identity to be scoped by, the same reasoning
  // `planner_global_disabled_tools` being a separate flat table already
  // documents.
  `
  ALTER TABLE planner_workspaces ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 1;
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

/**
 * Key in `settings` recording that the one-time import of the PA-19 env-var
 * provider variants into `custom_claude_providers` has already happened.
 *
 * A flag rather than "the table is empty", the same discipline
 * `workspaces_seeded` and the planner's own seed flag use: an operator who
 * migrates and then *deletes* the imported provider must not have it silently
 * resurrected on the next boot just because `POCKETAGENT_DEEPSEEK_API_KEY` is
 * still sitting in their `.env`.
 */
export const LEGACY_CLAUDE_PROVIDERS_MIGRATED_KEY = 'legacy_claude_providers_migrated';

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
  // Schema-version migrations are positional. An already-deployed branch
  // recorded version 20 before the continuation columns were appended, so its
  // old checkpoint can equal this branch's current migration count. Probe the
  // two additive columns as a compatibility repair: this is idempotent and
  // makes that historical database upgrade on its next normal restart.
  const cronColumns = new Set(
    (db.prepare('PRAGMA table_info(cron_jobs)').all() as { name: string }[]).map((column) => column.name),
  );
  if (!cronColumns.has('resume_agent_session_id')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN resume_agent_session_id TEXT');
  }
  if (!cronColumns.has('delete_after_run')) {
    db.exec('ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER NOT NULL DEFAULT 0');
  }
  // Same positional-migration hazard as above, but for `webhooks`: the
  // `auto_select_agent_model` migration was inserted mid-array (between the
  // prompt-template-map migration and the PA-6 planner migrations) rather
  // than appended, so a database whose checkpoint had already passed that
  // index before the migration landed skips it forever — the loop above only
  // checks a count, not which specific migrations ran. PA-21 (Jira): this is
  // exactly what made every webhook save 500 on a database in that state
  // (create/update always write this column; the raw "no such column" error
  // fell through as an unhandled 500). Probed the same idempotent way.
  const webhookColumns = new Set(
    (db.prepare('PRAGMA table_info(webhooks)').all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (webhookColumns.size > 0 && !webhookColumns.has('auto_select_agent_model')) {
    db.exec('ALTER TABLE webhooks ADD COLUMN auto_select_agent_model INTEGER NOT NULL DEFAULT 0');
  }
  // PA-26, same hazard once more: two feature branches that each *append* a
  // migration produce the same version count for different schemas, so a
  // database checkpointed by the other one skips this column forever. Every
  // `per-issue` delivery writes it (the upsert names it unconditionally), so a
  // miss would 500 the whole delivery path rather than degrade quietly —
  // exactly PA-21's failure. Probed idempotently for that reason.
  const issueSessionColumns = new Set(
    (db.prepare('PRAGMA table_info(webhook_issue_sessions)').all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  if (issueSessionColumns.size > 0 && !issueSessionColumns.has('agent')) {
    db.exec('ALTER TABLE webhook_issue_sessions ADD COLUMN agent TEXT');
  }
  // PA-28, same positional-migration hazard once more: a database whose
  // checkpoint already sat at or past this migration's index (see the two
  // repairs above for how that happens on a branch where a migration was
  // inserted rather than appended) would never create this table, and every
  // custom-provider query would then throw "no such table". Re-running the
  // *same* DDL constant the migration uses is idempotent (`IF NOT EXISTS`) and
  // cannot drift from it.
  db.exec(CUSTOM_CLAUDE_PROVIDERS_DDL);
  // PA-37, same positional-migration hazard once more: see `MCP_REGISTRIES_DDL`'s
  // own doc comment.
  db.exec(MCP_REGISTRIES_DDL);
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
  resume_agent_session_id: string | null;
  delete_after_run: number;
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
       last_run_status, last_error, resume_agent_session_id, delete_after_run
     ) VALUES (
       @id, @name, @enabled, @cron_expr, @time_zone, @schedule_kind, @preset_json,
       @cwd, @agent, @worktree_mode, @model, @effort, @effort_set, @skip_permissions,
       @prompt, @overlap_policy, @created_at, @updated_at, @next_run_at, @last_run_at,
       @last_run_status, @last_error, @resume_agent_session_id, @delete_after_run
     )`,
  ).run({
    ...row,
    resume_agent_session_id: row.resume_agent_session_id ?? null,
    delete_after_run: row.delete_after_run ?? 0,
  });
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
  /** `'jira' | 'bamboo'`. Discriminates every field below tagged "type-specific". */
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
  /**
   * Raw JSON of `JiraProjectMapEntry[]` (`type: 'jira'`) or `BambooPlanMapEntry[]`
   * (`type: 'bamboo'`) — a Bamboo webhook reuses this column keyed on `planKey`
   * rather than `projectKey`. `'[]'` means no per-project/per-plan routing. The
   * column kept its original name rather than being migrated to something
   * provider-neutral: it is already a typed container read back through the
   * schema matching `type`, and a rename would touch every read/write site for
   * no functional gain.
   */
  project_map_json: string;
  /**
   * Raw JSON of `JiraPromptTemplateMapEntry[]` (`type: 'jira'`, keyed on
   * `issueType`) or `BambooPromptTemplateMapEntry[]` (`type: 'bamboo'`, keyed
   * on `buildState`). `'[]'` means no per-issue-type/per-build-state template
   * routing.
   */
  prompt_template_map_json: string;
  cwd: string;
  agent: string;
  /** `'none' | 'new-branch' | 'current-branch'`. */
  worktree_mode: string;
  model: string | null;
  effort: string | null;
  /** 1 when `effort` was set explicitly — including explicitly to null. */
  effort_set: number;
  skip_permissions: number;
  auto_select_agent_model: number;
  prompt_template: string;
  /** `'per-delivery' | 'per-issue'`. */
  conversation_mode: string;
  /** `'skip' | 'allow'`, evaluated per conversation key. */
  overlap_policy: string;
  /**
   * `'queue' | 'allow'` — what to do when another agent is mid-turn in the
   * working tree this delivery would run in. Orthogonal to `overlap_policy`,
   * which is scoped to this webhook's own conversation rather than to a
   * directory that any trigger (or a human) can be working in.
   */
  directory_policy: string;
  max_concurrent: number;
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
  /** PA-10: set instead of `session_id` when the agent was a Pocket Agent. Not a foreign key either. */
  planner_chat_id: string | null;
  cwd: string | null;
  error: string | null;
  /**
   * The working tree this delivery is (or was) waiting on, from `treeRootOf`.
   * Null for every delivery that never queued.
   */
  queue_key: string | null;
  queued_at: number | null;
  /**
   * The frozen `RunSpec` this delivery will run, as JSON — prompt included.
   * See the migration comment for why it is frozen rather than re-derived.
   */
  queued_spec_json: string | null;
}

export interface WebhookIssueSessionRow {
  webhook_id: string;
  issue_key: string;
  agent_session_id: string | null;
  session_id: string | null;
  /** PA-10: the Pocket Agent chat handling this issue, for a pocket-agent webhook. */
  planner_chat_id: string | null;
  /**
   * PA-26: the agent this conversation belongs to — a coding agent id or a
   * `pocket:<id>`.
   *
   * NULL means *unknown* (a row written before this column existed), and it is
   * decided by whoever actually last ran the subject — recovered from the
   * delivery history by `readLastRunAgentForIssue` — never by assuming the next
   * delivery's agent is the owner, because an `agent_session_id` is not
   * portable across agents (PA-30). A row whose owner differs from the
   * delivery's effective agent is not this delivery's conversation, and
   * `WebhookService` starts a fresh one rather than resuming it.
   */
  agent: string | null;
  cwd: string;
  created_at: number;
  updated_at: number;
}

/**
 * A call to `/api/hooks/:slug` that matched no runnable webhook. See the
 * migration comment: `webhook_id`/`webhook_name` are only ever set for the
 * `'disabled'` case, and no request data beyond the slug is ever stored here.
 */
export interface WebhookHitLogRow {
  id: string;
  slug: string;
  webhook_id: string | null;
  webhook_name: string | null;
  /** `'unknown_slug' | 'disabled'`. */
  reason: string;
  received_at: number;
}

/** Statuses a delivery can still leave, mirroring `readActiveCronRuns`'s pair. */
const OPEN_DELIVERY = `status IN ('starting', 'running')`;

/**
 * Deliveries waiting on a working tree (PA-11).
 *
 * Deliberately a *third* class, in neither `OPEN_DELIVERY` nor
 * `NOISE_STATUSES`, and every consumer of those two had to be checked:
 *
 * - not open, because `capReason` counts open rows against the concurrency caps
 *   and a queued row holds no session — counting it would let a queue throttle
 *   itself — and because `markStaleWebhookDeliveriesFailed` force-fails every
 *   open row at boot, which would destroy work that was accepted with a 202;
 * - not noise, because pruning is what noise means, and a queued row is work
 *   that has not happened yet.
 */
const QUEUED_DELIVERY = `status = 'queued'`;

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
       secret_set_at, filter_json, project_map_json, prompt_template_map_json, cwd, agent, worktree_mode, model, effort,
       effort_set, skip_permissions, auto_select_agent_model, prompt_template, conversation_mode,
       overlap_policy, directory_policy, max_concurrent, store_payloads,
       created_at, updated_at, last_delivery_at, last_delivery_status, last_error
     ) VALUES (
       @id, @name, @slug, @enabled, @type, @auth_mode, @secret, @auth_token_hash,
       @secret_set_at, @filter_json, @project_map_json, @prompt_template_map_json, @cwd, @agent, @worktree_mode, @model, @effort,
       @effort_set, @skip_permissions, @auto_select_agent_model, @prompt_template, @conversation_mode,
       @overlap_policy, @directory_policy, @max_concurrent, @store_payloads,
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
       finished_at, session_id, agent_session_id, planner_chat_id, cwd, error,
       queue_key, queued_at, queued_spec_json
     ) VALUES (
       @id, @webhook_id, @webhook_name, @agent, @status, @trigger, @body_hash,
       @delivery_header, @event, @event_type, @issue_key, @project_key, @actor,
       @signature_state, @skip_permissions_enabled, @payload_json, @payload_bytes,
       @payload_truncated, @rendered_prompt, @reason, @received_at, @started_at,
       @finished_at, @session_id, @agent_session_id, @planner_chat_id, @cwd, @error,
       @queue_key, @queued_at, @queued_spec_json
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
 * Deliveries parked on a working tree, oldest first.
 *
 * `RunQueue` is rebuilt from these at boot: the in-memory queue does not
 * survive a restart, but the frozen spec on each row does, so queued work
 * resumes rather than being silently dropped.
 */
export function readQueuedWebhookDeliveries(db: Db, webhookId?: string): WebhookDeliveryRow[] {
  if (webhookId !== undefined) {
    return db
      .prepare(
        `SELECT * FROM webhook_deliveries
          WHERE webhook_id = ? AND ${QUEUED_DELIVERY}
          ORDER BY queued_at ASC, received_at ASC`,
      )
      .all(webhookId) as WebhookDeliveryRow[];
  }
  return db
    .prepare(
      `SELECT * FROM webhook_deliveries
        WHERE ${QUEUED_DELIVERY}
        ORDER BY queued_at ASC, received_at ASC`,
    )
    .all() as WebhookDeliveryRow[];
}

/**
 * The agent that last *ran* for one subject, read from the delivery history.
 *
 * PA-30: the per-issue cache's `agent` column is NULL on rows written before
 * the column existed (PA-26), yet such a row still carries an
 * `agent_session_id` that belongs to whichever agent handled the issue back
 * then. Delivery rows are the durable record of that — every run inserts one
 * carrying its effective `agent` — so they can name an owner the cache row no
 * longer can. Only rows that actually *finished* running count: noise never
 * ran, a queued row has not run yet, and a `starting`/`running` row is the
 * delivery asking the question — the delivery's own row is inserted before it
 * runs, so counting it would always answer "the current agent".
 */
export function readLastRunAgentForIssue(
  db: Db,
  webhookId: string,
  issueKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT agent FROM webhook_deliveries
        WHERE webhook_id = ? AND issue_key = ?
          AND NOT ${NOISE_DELIVERY} AND NOT ${QUEUED_DELIVERY} AND NOT ${OPEN_DELIVERY}
        ORDER BY received_at DESC LIMIT 1`,
    )
    .get(webhookId, issueKey) as { agent: string } | undefined;
  return row?.agent ?? null;
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
            -- A queued delivery is work that has not happened yet, and it is
            -- neither open nor noise: without this it lands in the negated
            -- (real runs) partition and can be pruned out from under the
            -- queue, silently dropping work already answered with a 202.
            AND NOT ${QUEUED_DELIVERY}
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

/** One prompt a human sent that is waiting for a working tree (PA-11). */
export interface SessionPromptQueueRow {
  id: string;
  session_id: string;
  tree_root: string;
  text: string;
  created_at: number;
}

export function insertQueuedPrompt(db: Db, row: SessionPromptQueueRow): void {
  db.prepare(
    `INSERT INTO session_prompt_queue (id, session_id, tree_root, text, created_at)
     VALUES (@id, @session_id, @tree_root, @text, @created_at)`,
  ).run(row);
}

export function readQueuedPrompts(db: Db): SessionPromptQueueRow[] {
  return db
    .prepare('SELECT * FROM session_prompt_queue ORDER BY created_at ASC')
    .all() as SessionPromptQueueRow[];
}

export function readQueuedPrompt(db: Db, id: string): SessionPromptQueueRow | null {
  return (
    (db.prepare('SELECT * FROM session_prompt_queue WHERE id = ?').get(id) as
      | SessionPromptQueueRow
      | undefined) ?? null
  );
}

export function deleteQueuedPrompt(db: Db, id: string): number {
  return db.prepare('DELETE FROM session_prompt_queue WHERE id = ?').run(id).changes;
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
  const map = new Map(rows.map((r) => [r.agent_session_id, r.webhook_id]));
  // PA-27: `webhook_deliveries` is pruned to the newest rows per webhook
  // (`pruneOldWebhookDeliveries`), so a long-lived `per-issue` conversation
  // whose *originating* delivery has aged out would otherwise lose its badge
  // even though the conversation is still very much the webhook's.
  // `webhook_issue_sessions` is never pruned by delivery retention — only by a
  // real agent change (PA-26) or the webhook's own deletion — so it is the
  // durable source of this link. Only fills a gap left by the map above,
  // never overrides it.
  const cached = db
    .prepare(
      `SELECT agent_session_id, webhook_id FROM webhook_issue_sessions
        WHERE agent_session_id IS NOT NULL`,
    )
    .all() as { agent_session_id: string; webhook_id: string }[];
  for (const r of cached) {
    if (!map.has(r.agent_session_id)) map.set(r.agent_session_id, r.webhook_id);
  }
  return map;
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
       webhook_id, issue_key, agent_session_id, session_id, planner_chat_id, agent, cwd, created_at, updated_at
     ) VALUES (
       @webhook_id, @issue_key, @agent_session_id, @session_id, @planner_chat_id, @agent, @cwd, @created_at, @updated_at
     )
     ON CONFLICT (webhook_id, issue_key) DO UPDATE SET
       agent_session_id = COALESCE(excluded.agent_session_id, agent_session_id),
       session_id       = excluded.session_id,
       -- COALESCE so a caller that does not know the agent cannot erase a known
       -- one; the only writer that leaves it NULL would be a pre-PA-26 row's own
       -- read-modify-write, and forgetting the agent would silently re-enable
       -- resuming across an agent change.
       agent            = COALESCE(excluded.agent, agent),
       -- COALESCE, like \`agent_session_id\`: a pocket chat, once known, is the
       -- issue's conversation until the row is pruned. \`session_id\` is the one
       -- column that must be overwritable with NULL, because it is the *live*
       -- handle and a dead session has to stop looking alive.
       planner_chat_id  = COALESCE(excluded.planner_chat_id, planner_chat_id),
       cwd              = excluded.cwd,
       updated_at       = excluded.updated_at`,
  ).run(row);
}

/**
 * Forget the conversation cached for one issue.
 *
 * PA-26: called when a delivery's agent no longer matches the cached
 * conversation's. Dropping the row rather than patching it is what keeps
 * `upsertWebhookIssueSession`'s COALESCEd `agent_session_id`/`planner_chat_id`
 * from carrying the abandoned agent's ids forward into the new conversation's
 * row.
 */
export function deleteWebhookIssueSession(db: Db, webhookId: string, issueKey: string): number {
  return db
    .prepare('DELETE FROM webhook_issue_sessions WHERE webhook_id = ? AND issue_key = ?')
    .run(webhookId, issueKey).changes;
}

/** Bound the per-issue cache. Dropping a row only costs a fresh conversation. */
export function pruneOldWebhookIssueSessions(db: Db, olderThan: number): number {
  return db.prepare('DELETE FROM webhook_issue_sessions WHERE updated_at < ?').run(olderThan)
    .changes;
}

export function insertWebhookHit(db: Db, row: WebhookHitLogRow): void {
  db.prepare(
    `INSERT INTO webhook_hit_log (id, slug, webhook_id, webhook_name, reason, received_at)
     VALUES (@id, @slug, @webhook_id, @webhook_name, @reason, @received_at)`,
  ).run(row);
}

export function readWebhookHits(db: Db, opts: { limit: number }): WebhookHitLogRow[] {
  return db
    .prepare('SELECT * FROM webhook_hit_log ORDER BY received_at DESC LIMIT ?')
    .all(opts.limit) as WebhookHitLogRow[];
}

/** Every row here is noise by definition, so one global "keep newest N" prune. */
export function pruneOldWebhookHits(db: Db, keep: number): number {
  return db
    .prepare(
      `DELETE FROM webhook_hit_log
        WHERE id NOT IN (SELECT id FROM webhook_hit_log ORDER BY received_at DESC LIMIT ?)`,
    )
    .run(keep).changes;
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
