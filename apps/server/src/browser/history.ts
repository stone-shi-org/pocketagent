import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { BrowserSuggestion } from '@pocketagent/protocol';

/**
 * PA-178: the address bar's suggestions, from the profile's own Chromium
 * history — the pages a person *and* the agent visited in this browser, which
 * is what a real omnibox would offer.
 *
 * Chromium holds `Default/History` with an exclusive lock while it runs
 * (measured: opening it read-only answers "database is locked"), so the file
 * and its write-ahead log are copied into a private temp directory and the
 * copy is read. A visit reaches the file within about five seconds. A copy
 * taken mid-write can be torn; SQLite then reports corruption and the bar
 * simply shows no suggestions, which is the right failure for a hint.
 *
 * Nothing here logs a URL or the query.
 */

/** A fresh copy at most this often per profile; typing does not re-copy on every key. */
const COPY_TTL_MS = 5_000;
const DEFAULT_LIMIT = 8;
/** Rows fetched by substring before ranking in JS. */
const CANDIDATES = 300;
/** Chromium's `last_visit_time` is microseconds since 1601-01-01. */
const WEBKIT_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

interface Copy {
  dir: string;
  takenAt: number;
}
const copies = new Map<string, Copy>();

function freshCopy(profileDir: string, now: number): string | null {
  const source = path.join(profileDir, 'Default', 'History');
  if (!fs.existsSync(source)) return null;
  const cached = copies.get(profileDir);
  if (cached && now - cached.takenAt < COPY_TTL_MS && fs.existsSync(path.join(cached.dir, 'History'))) {
    return path.join(cached.dir, 'History');
  }
  if (cached) fs.rmSync(cached.dir, { recursive: true, force: true });
  copies.delete(profileDir);
  // 0700, outside the profile (and so outside the data root's browser store).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-browser-history-'));
  try {
    fs.copyFileSync(source, path.join(dir, 'History'));
    const wal = `${source}-wal`;
    if (fs.existsSync(wal)) fs.copyFileSync(wal, path.join(dir, 'History-wal'));
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
  copies.set(profileDir, { dir, takenAt: now });
  return path.join(dir, 'History');
}

/** Drop every cached copy (on shutdown, and when a profile is cleared). */
export function forgetHistoryCopies(profileDir?: string): void {
  for (const [key, copy] of copies) {
    if (profileDir !== undefined && key !== profileDir) continue;
    fs.rmSync(copy.dir, { recursive: true, force: true });
    copies.delete(key);
  }
}

interface Row {
  url: string;
  title: string;
  visit_count: number;
  typed_count: number;
  last_visit_time: number | bigint;
}

/** The URL without its scheme and `www.`, which is what a person types. */
function bare(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

/**
 * Rank like an omnibox, roughly: a URL whose host starts with what was typed
 * first, then one whose URL or title contains it; within each, typed beats
 * visited beats recent.
 */
export function rankSuggestions(rows: Row[], query: string, limit = DEFAULT_LIMIT): BrowserSuggestion[] {
  const q = query.trim().toLowerCase();
  const scored = rows
    .filter((r) => /^https?:\/\//i.test(r.url))
    .map((r) => {
      const b = bare(r.url).toLowerCase();
      const prefix = q !== '' && b.startsWith(q.replace(/^https?:\/\//, '').replace(/^www\./, ''));
      const recent = Number(BigInt(r.last_visit_time) - WEBKIT_EPOCH_OFFSET_US) / 1000;
      return { r, score: (prefix ? 1e6 : 0) + r.typed_count * 1000 + r.visit_count * 10, recent };
    })
    .sort((a, b) => b.score - a.score || b.recent - a.recent);
  const seen = new Set<string>();
  const out: BrowserSuggestion[] = [];
  for (const { r } of scored) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({ url: r.url, title: r.title });
    if (out.length >= limit) break;
  }
  return out;
}

export function suggestFromHistory(
  profileDir: string,
  query: string,
  limit = DEFAULT_LIMIT,
  now = Date.now(),
): BrowserSuggestion[] {
  const file = freshCopy(profileDir, now);
  if (!file) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    db.defaultSafeIntegers(false);
    const q = query.trim().toLowerCase().slice(0, 200);
    // `instr` rather than LIKE: nothing typed needs escaping.
    const rows = (
      q === ''
        ? db
            .prepare(
              `SELECT url, title, visit_count, typed_count, last_visit_time FROM urls
               WHERE hidden = 0 ORDER BY typed_count DESC, visit_count DESC, last_visit_time DESC LIMIT ?`,
            )
            .all(CANDIDATES)
        : db
            .prepare(
              `SELECT url, title, visit_count, typed_count, last_visit_time FROM urls
               WHERE hidden = 0 AND (instr(lower(url), ?) > 0 OR instr(lower(title), ?) > 0)
               ORDER BY last_visit_time DESC LIMIT ?`,
            )
            .all(q, q, CANDIDATES)
    ) as Row[];
    return rankSuggestions(rows, q, limit);
  } catch {
    // A torn copy, or a schema this reader does not know: no suggestions.
    return [];
  } finally {
    db?.close();
  }
}
