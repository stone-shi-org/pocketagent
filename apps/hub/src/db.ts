import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type HubDb = Database.Database;

export interface HubHostRow {
  id: string;
  label: string;
  base_url: string;
  enabled: number;
  is_default: number;
  /** `base64(iv || tag || ciphertext)` of the `pah_` credential, or NULL. */
  credential_enc: string | null;
  credential_prefix: string | null;
  /** The backend's own id for the credential, so removal can try to revoke it. */
  credential_id: string | null;
  bound_at: number | null;
  backend_host_id: string | null;
  created_at: number;
}

export interface HubSessionRow {
  id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  user_agent: string | null;
}

/**
 * Append-only, applied positionally against a `schema_version` row — the same
 * mechanism `apps/server/src/db/index.ts` uses, deliberately re-implemented
 * rather than shared.
 *
 * What is *not* copied is that file's trailing `PRAGMA table_info` repair
 * blocks. Those exist to heal positional drift in a schema with years of
 * branch history behind it; inheriting them into a schema whose first
 * migration ships today would be cargo cult, and would quietly license
 * inserting a migration mid-array later.
 */
export const HUB_MIGRATIONS: readonly string[] = [
  // 0 — PA-66. The registry and the Hub's own operator sessions.
  `
  CREATE TABLE IF NOT EXISTS hub_hosts (
    id                TEXT PRIMARY KEY,
    label             TEXT NOT NULL,
    base_url          TEXT NOT NULL,
    enabled           INTEGER NOT NULL DEFAULT 1,
    is_default        INTEGER NOT NULL DEFAULT 0,
    credential_enc    TEXT,
    credential_prefix TEXT,
    credential_id     TEXT,
    bound_at          INTEGER,
    backend_host_id   TEXT,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_hub_hosts_created_at ON hub_hosts (created_at);

  -- Shaped exactly like the backend's auth_sessions, because it is the same
  -- kind of thing: a random id in an HttpOnly cookie, exchanged once for the
  -- operator's token. A *different* table in a different database, because a
  -- Hub session grants "reach every bound host" and a backend session grants
  -- "terminal access on this machine" — the same row type, never the same row.
  CREATE TABLE IF NOT EXISTS hub_sessions (
    id           TEXT PRIMARY KEY,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_hub_sessions_expires_at ON hub_sessions (expires_at);
  `,
];

export function openHubDatabase(databasePath: string): HubDb {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (let i = current; i < HUB_MIGRATIONS.length; i += 1) {
    const migration = HUB_MIGRATIONS[i];
    if (migration === undefined) continue;
    db.exec(migration);
    current = i + 1;
  }
  db.prepare('UPDATE schema_version SET version = ?').run(current);
  return db;
}

export function purgeExpiredHubSessions(db: HubDb, now = Date.now()): void {
  db.prepare('DELETE FROM hub_sessions WHERE expires_at <= ?').run(now);
}
