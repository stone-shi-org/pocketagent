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
];

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
