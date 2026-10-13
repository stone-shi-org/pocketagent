import fs from 'node:fs';
import path from 'node:path';
import { ATTACHED_FILE_NOTE_PREFIX, EXTRACTED_TEXT_NOTE_PREFIX, PromptAttachment } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { isContained } from '../workspaces/index.js';
import { PLANNER_UPLOADS_DIR, SESSION_ATTACHMENTS_DIR } from './index.js';

/**
 * PA-137: deleting landed attachments after `attachmentRetentionDays`.
 *
 * Off by default (`0`, the reporter's choice on the ticket), because a file
 * may be the very input a chat still needs: nothing here can know whether an
 * agent will read `report.pdf` again next week. When it is on, a sweep runs
 * a minute after boot and then every few hours, and deletes regular files
 * older than the limit from two kinds of directory only:
 *
 * - `<cwd>/.pocketagent/attachments/` of every directory a coding-agent
 *   prompt has landed a file in (`attachment_roots`, recorded at landing,
 *   plus every session row's cwd for files landed before the table existed);
 * - `<planner workspace>/artifacts/uploads/` of every Pocket Agent.
 *
 * Three rules keep it from deleting the wrong thing. A file a *queued* prompt
 * still names is kept, whatever its age — that prompt has not been sent, so
 * nothing has read it yet. Nothing is followed through a symlink: each
 * directory is realpath'd and must be the one it claims to be, and each entry
 * is `lstat`ed and skipped unless it is a regular file. And the sweep logs
 * counts only, never a name: a filename is something the user may not want
 * in a log.
 */

const FIRST_SWEEP_DELAY_MS = 60_000;
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Records that a coding-agent prompt landed files under `root` (its cwd). */
export function recordAttachmentRoot(db: Db, root: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO attachment_roots (root, last_landed_at) VALUES (?, ?)
     ON CONFLICT (root) DO UPDATE SET last_landed_at = excluded.last_landed_at`,
  ).run(root, now);
}

export interface AttachmentRetentionOptions {
  db: Db;
  /** Read on every sweep, so a Settings change applies with no restart. */
  retentionDays: () => number;
  plannerRoots: () => string[];
  logger?: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
  now?: () => number;
}

export interface RetentionSweepResult {
  removed: number;
  kept: number;
  directories: number;
}

export class AttachmentRetentionService {
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: AttachmentRetentionOptions) {
    this.now = opts.now ?? Date.now;
  }

  init(): void {
    this.timer = setTimeout(() => this.runQuietly(), FIRST_SWEEP_DELAY_MS);
    this.timer.unref();
    this.interval = setInterval(() => this.runQuietly(), SWEEP_INTERVAL_MS);
    this.interval.unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  private runQuietly(): void {
    try {
      this.sweep();
    } catch (err) {
      this.opts.logger?.warn({ err }, 'attachment retention sweep failed');
    }
  }

  /** One pass. A no-op returning zeros when retention is off. */
  sweep(): RetentionSweepResult {
    const days = this.opts.retentionDays();
    const result: RetentionSweepResult = { removed: 0, kept: 0, directories: 0 };
    if (!Number.isInteger(days) || days <= 0) return result;
    const cutoff = this.now() - days * DAY_MS;
    const protectedNames = this.queuedNames();

    const dirs = new Set<string>();
    for (const root of this.sessionRoots()) dirs.add(path.join(root, ...SESSION_ATTACHMENTS_DIR.split('/')));
    for (const root of this.opts.plannerRoots()) dirs.add(path.join(root, ...PLANNER_UPLOADS_DIR.split('/')));

    for (const dir of dirs) {
      const root = path.dirname(path.dirname(dir));
      let realRoot: string;
      let realDir: string;
      try {
        realRoot = fs.realpathSync(root);
        realDir = fs.realpathSync(dir);
      } catch {
        continue; // never landed anything, or the tree is gone
      }
      // The directory itself must be exactly where it should be: a
      // `.pocketagent` or `artifacts` symlink pointing elsewhere is skipped,
      // the same rule landing applies before writing.
      if (realDir !== path.join(realRoot, path.relative(root, dir)) || !isContained(realRoot, realDir)) continue;
      result.directories++;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(realDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const abs = path.join(realDir, entry.name);
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.mtimeMs >= cutoff) continue;
        if (protectedNames.has(entry.name)) {
          result.kept++;
          continue;
        }
        try {
          fs.unlinkSync(abs);
          result.removed++;
        } catch {
          // Gone already, or not ours to delete; the next sweep tries again.
        }
      }
    }
    if (result.removed > 0 || result.kept > 0) {
      this.opts.logger?.info({ ...result, retentionDays: days }, 'attachment retention sweep');
    }
    return result;
  }

  private sessionRoots(): string[] {
    const roots = new Set<string>();
    for (const row of this.opts.db.prepare('SELECT root FROM attachment_roots').all() as { root: string }[]) {
      roots.add(row.root);
    }
    for (const row of this.opts.db.prepare('SELECT DISTINCT cwd FROM sessions').all() as { cwd: string }[]) {
      roots.add(row.cwd);
    }
    return [...roots];
  }

  /**
   * Basenames a queued prompt still names. Landed names carry a timestamp
   * and a random suffix, so a basename identifies one landing; matching on
   * it means a queued message's file is kept wherever the queue row says it
   * landed, with no path arithmetic to get wrong.
   */
  private queuedNames(): Set<string> {
    const names = new Set<string>();
    const add = (rel: string | undefined): void => {
      const base = rel?.split('/').pop();
      if (base) names.add(base);
    };
    for (const row of this.opts.db.prepare('SELECT text FROM session_prompt_queue').all() as { text: string }[]) {
      for (const line of row.text.split('\n')) {
        for (const prefix of [ATTACHED_FILE_NOTE_PREFIX, EXTRACTED_TEXT_NOTE_PREFIX, '[Attached image saved to: ']) {
          if (line.startsWith(prefix) && line.endsWith(']')) {
            add(line.slice(prefix.length, -1).replace(/ \(truncated(?:\s[\s\S]*)?\)$/, ''));
          }
        }
      }
    }
    const planner = this.opts.db
      .prepare('SELECT attachments_json FROM planner_prompt_queue WHERE attachments_json IS NOT NULL')
      .all() as { attachments_json: string }[];
    for (const row of planner) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.attachments_json);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        const attachment = PromptAttachment.safeParse(item);
        if (!attachment.success) continue;
        add(attachment.data.path);
        add(attachment.data.extractedPath);
        for (const file of attachment.data.extractedFiles ?? []) {
          add(file.path);
        }
      }
    }
    return names;
  }
}
