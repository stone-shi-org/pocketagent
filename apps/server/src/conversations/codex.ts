import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Reading Codex's own on-disk thread titles (PA-164).
 *
 * Codex persists per-thread titles in two places under `~/.codex`:
 *   1. `~/.codex/session_index.jsonl` — append-only NDJSON lines of the form
 *      `{"id": "<thread-id>", "thread_name": "<title>", "updated_at": "..."}`.
 *   2. `~/.codex/state_5.sqlite` — SQLite database with a `threads` table
 *      (`threads.title` keyed by `id`).
 *
 * `titleFor` checks `session_index.jsonl` first (no SQLite open needed, and an
 * append-only log naturally records the latest `thread_name` last when a
 * thread is renamed or re-titled) and falls back to `state_5.sqlite` opened
 * read-only (`readonly: true, fileMustExist: true`) because `codex app-server`
 * writes to it while running.
 */

/** A pathological session index should not be read into memory whole; matches AgyTranscriptStore's cap. */
const MAX_SESSION_INDEX_BYTES = 8 * 1024 * 1024;

export interface CodexTranscriptStoreOptions {
  /** Overridable for tests. Defaults to `~/.codex`. */
  codexDir?: string;
  /** Overridable for tests. Defaults to `<codexDir>/session_index.jsonl` (`~/.codex/session_index.jsonl`). */
  sessionIndexPath?: string;
  /** Overridable for tests. Defaults to `<codexDir>/state_5.sqlite` (`~/.codex/state_5.sqlite`). */
  stateDbPath?: string;
}

export class CodexTranscriptStore {
  private readonly sessionIndexPath: string;
  private readonly stateDbPath: string;

  constructor(options: CodexTranscriptStoreOptions = {}) {
    const rootDir = options.codexDir ?? path.join(os.homedir(), '.codex');
    this.sessionIndexPath = options.sessionIndexPath ?? path.join(rootDir, 'session_index.jsonl');
    this.stateDbPath = options.stateDbPath ?? path.join(rootDir, 'state_5.sqlite');
  }

  /**
   * Look up Codex's own title for a thread/conversation (PA-164).
   *
   * Primary source is `session_index.jsonl` (`thread_name` keyed by `id`),
   * scanned from the end so the most recent entry wins when a thread is
   * renamed or updated. When `session_index.jsonl` is missing or carries no
   * non-empty `thread_name` for `threadId`, falls back to `state_5.sqlite`
   * (`threads.title` keyed by `id`) opened read-only. Returns `null` on any
   * error and never throws.
   */
  async titleFor(threadId: string): Promise<string | null> {
    if (!threadId || threadId.includes('/') || threadId.includes('\\') || threadId === '..') {
      return null;
    }

    const fromIndex = await this.readTitleFromSessionIndex(threadId);
    if (fromIndex) return fromIndex;

    return this.readTitleFromStateDb(threadId);
  }

  private async readTitleFromSessionIndex(threadId: string): Promise<string | null> {
    try {
      const stat = await fs.stat(this.sessionIndexPath);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SESSION_INDEX_BYTES) return null;
      const raw = await fs.readFile(this.sessionIndexPath, 'utf8');
      return parseSessionIndexTitle(raw, threadId);
    } catch {
      return null;
    }
  }

  private readTitleFromStateDb(threadId: string): string | null {
    let db: Database.Database | null = null;
    try {
      db = new Database(this.stateDbPath, { readonly: true, fileMustExist: true });
      const row = db
        .prepare('SELECT title FROM threads WHERE id = ?')
        .get(threadId) as { title?: unknown } | undefined;
      if (!row || typeof row.title !== 'string') return null;
      const trimmed = row.title.trim();
      return trimmed || null;
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors on corrupt/locked db.
      }
    }
  }
}

/**
 * Scan `session_index.jsonl` from the tail for the latest non-empty
 * `thread_name` matching `threadId`.
 */
export function parseSessionIndexTitle(raw: string, threadId: string): string | null {
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const r = record as Record<string, unknown>;
    if (r.id !== threadId) continue;
    if (typeof r.thread_name !== 'string') continue;
    const name = r.thread_name.trim();
    if (name) return name;
  }
  return null;
}
