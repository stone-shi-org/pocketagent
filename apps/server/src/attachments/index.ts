import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_NAME_CHARS,
  type PromptAttachment,
  type PromptImage,
  type UploadAttachmentResponse,
} from '@pocketagent/protocol';
import { isContained } from '../workspaces/index.js';

/**
 * PA-136: prompt attachments, from upload to the file an agent reads.
 *
 * Two halves, deliberately separate:
 *
 * - **Staging** (`AttachmentStaging`). `POST /api/attachments` streams the
 *   bytes into `<dataDir>/attachment-staging/` and mints an opaque id. Nothing
 *   is written into a working tree yet. A chip the user removes, a tab that
 *   closes, a prompt never sent all leave nothing behind in anybody's repo,
 *   and the staged copy is swept.
 * - **Landing** (`landAttachment`). When a prompt naming the id is handled,
 *   the staged file moves to its destination: `<cwd>/.pocketagent/attachments/`
 *   for a coding agent, `<planner workspace>/artifacts/uploads/` for a Pocket
 *   Agent.
 *
 * The rules a landing obeys, because this is the one place a file whose
 * *name* a browser chose is written into a tree an agent treats as source:
 * - The browser never supplies a path. A name is reduced to a sanitised
 *   basename (`sanitizeAttachmentName`), then given a timestamp and a random
 *   suffix.
 * - No existing file is ever overwritten. Every write is exclusive-create
 *   (`link`, `COPYFILE_EXCL` or `O_EXCL`), retried under a fresh suffix on
 *   `EEXIST`, so not even a racing writer can be clobbered.
 * - No symlink is followed on the way in. Each directory segment below the
 *   root is `lstat`ed and refused if it is a link, and the final directory is
 *   realpath'd and must still be inside the realpath'd root. This is PA-55's
 *   rule for skill export: a `.pocketagent` symlink pointing out of the repo
 *   passes a containment check made on the cwd alone.
 */

export type AttachmentErrorCode = 'not_found' | 'too_large' | 'too_many' | 'invalid' | 'forbidden';

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code: AttachmentErrorCode,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

// ---- Names -------------------------------------------------------------------

/** Longest sanitised name, in UTF-8 bytes, before the unique suffix is added.
    Leaves room for `_YYYYMMDD-HHmmss_xxxx` under the usual 255-byte limit. */
const MAX_SAFE_NAME_BYTES = 120;

/** An extension is kept only if it looks like one. */
const EXTENSION_RE = /^\.[A-Za-z0-9]{1,16}$/;

/**
 * Reduces whatever the browser called a file to a safe basename, or `file`.
 *
 * Split on both separators before taking the last segment, because a name
 * typed on Windows (`..\..\x`) means a path there even though `path.basename`
 * on Linux would keep it whole. Leading dots go, so the result is never `.`,
 * `..` or a hidden file such as `.env` or `.bashrc` that an agent's tools
 * treat specially. Invisible and control characters go, for the reason
 * `webhook-template.ts` strips them from Jira text: a filename is shown to the
 * agent inside its prompt.
 */
export function sanitizeAttachmentName(raw: string): string {
  let name = raw.normalize('NFC');
  name = name.split(/[/\\]/).pop() ?? '';
  name = name
    // C0/C1 controls, including NUL, \n and \t: none belongs in a filename.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    // Zero-width, BOM, bidi overrides and isolates.
    .replace(/[\u200B-\u200F\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    // Reserved on some filesystem or shell somewhere, and never needed.
    .replace(/[<>:"|?*`$]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  if (name.length === 0) return 'file';

  const rawExt = path.extname(name);
  const ext = EXTENSION_RE.test(rawExt) ? rawExt.toLowerCase() : '';
  let stem = ext ? name.slice(0, -rawExt.length) : name;
  stem = stem.replace(/[.\s]+$/, '');
  if (stem.length === 0) stem = 'file';
  stem = truncateUtf8(stem, MAX_SAFE_NAME_BYTES - Buffer.byteLength(ext));
  return `${stem}${ext}`;
}

/** Truncates to at most `maxBytes` of UTF-8 without splitting a character. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let out = '';
  for (const char of value) {
    if (Buffer.byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out.replace(/[.\s]+$/, '') || 'file';
}

function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

/** `report.pdf` → `report_20261012-143005_a1b2.pdf`. */
export function uniqueAttachmentName(safeName: string, now = new Date(), hex = crypto.randomBytes(2).toString('hex')): string {
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  return `${stem}_${stamp(now)}_${hex}${ext}`;
}

// ---- Landing -----------------------------------------------------------------

export interface LandingTarget {
  /** The tree the file lands in: a session's cwd, or a planner workspace. */
  root: string;
  /** Directory below `root`, with `/` separators, e.g. `.pocketagent/attachments`. */
  dir: string;
  /**
   * A directory below `root` that gets a `.gitignore` of `*` the first time
   * anything lands. Keeps attachments out of `git status` without editing
   * `.git/info/exclude`, and works the same in a linked worktree, where `.git`
   * is a file rather than a directory.
   */
  gitignoreDir?: string;
}

/** Where a coding agent's attachments land, relative to its cwd. */
export const SESSION_ATTACHMENTS_DIR = '.pocketagent/attachments';
/** Where a Pocket Agent's land, relative to its workspace: inside PA-128's
    `artifacts/`, so the Artifacts panel lists, downloads and deletes them. */
export const PLANNER_UPLOADS_DIR = 'artifacts/uploads';

export function sessionLandingTarget(cwd: string): LandingTarget {
  return { root: cwd, dir: SESSION_ATTACHMENTS_DIR, gitignoreDir: '.pocketagent' };
}

export function plannerLandingTarget(workspacePath: string): LandingTarget {
  return { root: workspacePath, dir: PLANNER_UPLOADS_DIR };
}

/**
 * Creates `target.dir` below `target.root` one segment at a time, refusing any
 * segment that is a symlink or not a directory, and returns the realpath'd
 * directory along with the realpath'd root.
 *
 * Walked rather than `mkdir -p`'d, because `mkdir -p` follows a symlinked
 * segment and would create directories *outside* the tree before a later
 * containment check refused the write. The realpath check at the end is
 * still made, as a backstop.
 */
function prepareLandingDir(target: LandingTarget): { realRoot: string; realDir: string } {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(target.root);
  } catch {
    throw new AttachmentError('The directory this chat runs in no longer exists.', 'not_found');
  }
  let current = realRoot;
  for (const segment of target.dir.split('/').filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (stat === null) {
      try {
        fs.mkdirSync(current);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new AttachmentError(
        `Refusing to save an attachment: ${path.relative(realRoot, current)} is not a plain directory.`,
        'forbidden',
      );
    }
  }
  const realDir = fs.realpathSync(current);
  if (!isContained(realRoot, realDir)) {
    throw new AttachmentError('Refusing to save an attachment outside the chat\'s directory.', 'forbidden');
  }
  if (target.gitignoreDir) writeGitignoreOnce(realRoot, target.gitignoreDir);
  return { realRoot, realDir };
}

function writeGitignoreOnce(realRoot: string, dir: string): void {
  const file = path.join(realRoot, dir, '.gitignore');
  let fd: number;
  try {
    fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    // Already there — whatever it says is the user's business now.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw err;
  }
  try {
    fs.writeSync(
      fd,
      '# Written by PocketAgent: files attached to prompts land here (PA-136).\n' +
        '# Ignored so they never show up as changes in this repository.\n*\n',
    );
  } finally {
    fs.closeSync(fd);
  }
}

export type LandingSource = { kind: 'file'; path: string } | { kind: 'buffer'; data: Buffer };

const MAX_NAME_ATTEMPTS = 8;

/**
 * Writes `source` into the target directory under a name from `nameFor`
 * (called again, for a fresh suffix, whenever the name is taken), never
 * overwriting anything. A staged file is *moved*: hard-linked (atomic and
 * exclusive), then unlinked; across filesystems it is copied with
 * `COPYFILE_EXCL` instead.
 *
 * Returns the landed file's path relative to `target.root`, with `/`
 * separators — what the agent is told.
 */
export function landAttachment(
  target: LandingTarget,
  source: LandingSource,
  nameFor: () => string,
): { absPath: string; relPath: string } {
  const { realRoot, realDir } = prepareLandingDir(target);
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    const absPath = path.join(realDir, nameFor());
    try {
      writeExclusive(source, absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    return { absPath, relPath: path.relative(realRoot, absPath).split(path.sep).join('/') };
  }
  throw new AttachmentError('Could not find a free name for the attachment.', 'invalid');
}

function writeExclusive(source: LandingSource, dest: string): void {
  if (source.kind === 'buffer') {
    const fd = fs.openSync(
      dest,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o644,
    );
    try {
      fs.writeSync(fd, source.data);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  try {
    fs.linkSync(source.path, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw err;
    // EXDEV: staging is on another filesystem. EPERM/ENOTSUP: a filesystem
    // without hard links. Either way, an exclusive copy says the same thing.
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EMLINK') throw err;
    fs.copyFileSync(source.path, dest, fs.constants.COPYFILE_EXCL);
  }
  // Staged files are private (0600); a landed one is an ordinary file in the
  // user's tree.
  fs.chmodSync(dest, 0o644);
  fs.rmSync(source.path, { force: true });
}

// ---- Images (the pre-PA-136 path, unchanged in shape) ------------------------

const IMAGE_EXTENSIONS: Record<PromptImage['mediaType'], string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Saves a prompt image under `<cwd>/.pocketagent/attachments/` and returns its
 * path relative to `cwd`, e.g. `.pocketagent/attachments/attachment_1786772000_a1b2c3d4.png`.
 *
 * The name scheme is the one images always had; what PA-136 changed is that it
 * now goes through the same symlink, containment and no-overwrite rules as a
 * file, and that a failure throws instead of being logged and dropped.
 */
export function saveAttachmentToWorkspace(cwd: string, image: PromptImage): string {
  const ext = IMAGE_EXTENSIONS[image.mediaType] ?? '.png';
  return landAttachment(
    sessionLandingTarget(cwd),
    { kind: 'buffer', data: Buffer.from(image.data, 'base64') },
    () => `attachment_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`,
  ).relPath;
}

// ---- Staging -----------------------------------------------------------------

export interface StagedAttachment {
  id: string;
  /** Already sanitised. */
  name: string;
  size: number;
  mediaType: string;
  stagedPath: string;
  /** Who uploaded it; an id is unknown to anybody else. */
  principal: string;
  createdAt: number;
}

export interface AttachmentStagingOptions {
  dir: string;
  /** How long an unsent upload is kept. Default one hour. */
  ttlMs?: number;
  /** Most uploads one principal may hold unsent at once. */
  maxPerPrincipal?: number;
  maxBytes?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PER_PRINCIPAL = 40;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Uploads waiting for the prompt that names them.
 *
 * In memory on purpose. A staged upload is a few seconds of state between two
 * requests from the same page, so after a restart the page has to re-upload
 * either way, and the directory is emptied at boot rather than recovered. The
 * TTL is not the approval no-decay rule bending: an unsent upload is nobody's
 * decision, the same reasoning PA-68 gives for bounding a wedged installer.
 * And a prompt naming an expired id is refused visibly, never sent without
 * its file.
 */
export class AttachmentStaging {
  private readonly entries = new Map<string, StagedAttachment>();
  private readonly ttlMs: number;
  private readonly maxPerPrincipal: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: AttachmentStagingOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPerPrincipal = opts.maxPerPrincipal ?? DEFAULT_MAX_PER_PRINCIPAL;
    this.maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.now = opts.now ?? Date.now;
  }

  get dir(): string {
    return this.opts.dir;
  }

  /** Empties the staging directory (nothing in it can be claimed after a
      restart) and starts the sweep. */
  init(): void {
    fs.rmSync(this.opts.dir, { recursive: true, force: true });
    fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Streams one upload to disk, enforcing the size cap while it streams, so an
   * oversized body is cut off at the cap rather than read to the end.
   */
  async stage(
    body: Readable,
    opts: { name: string; mediaType: string; principal: string },
  ): Promise<UploadAttachmentResponse> {
    this.sweep();
    let held = 0;
    for (const entry of this.entries.values()) if (entry.principal === opts.principal) held++;
    if (held >= this.maxPerPrincipal) {
      throw new AttachmentError(
        `Too many files are waiting to be sent (${this.maxPerPrincipal}). Send or remove some first.`,
        'too_many',
      );
    }

    const id = `att_${crypto.randomBytes(18).toString('base64url')}`;
    const stagedPath = path.join(this.opts.dir, id);
    await fsp.mkdir(this.opts.dir, { recursive: true, mode: 0o700 });

    let size = 0;
    const maxBytes = this.maxBytes;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(new AttachmentError(tooLargeMessage(maxBytes), 'too_large'));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(body, counter, fs.createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      await fsp.rm(stagedPath, { force: true });
      throw err;
    }

    const entry: StagedAttachment = {
      id,
      name: sanitizeAttachmentName(opts.name),
      size,
      mediaType: normalizeMediaType(opts.mediaType),
      stagedPath,
      principal: opts.principal,
      createdAt: this.now(),
    };
    this.entries.set(id, entry);
    return { attachmentId: id, name: entry.name, size: entry.size, mediaType: entry.mediaType };
  }

  /**
   * Claims every id, or none: one missing id refuses the whole prompt, which
   * must never go out with a file silently left off. A claimed entry is gone
   * from the map, so an id is single-use. If the caller then fails before
   * landing, `release` puts the entries back for a retry.
   */
  take(ids: readonly string[], principal: string): StagedAttachment[] {
    if (ids.length === 0) return [];
    this.sweep();
    const unique = [...new Set(ids)];
    const found: StagedAttachment[] = [];
    for (const id of unique) {
      const entry = this.entries.get(id);
      if (!entry || entry.principal !== principal) {
        throw new AttachmentError(
          'An attached file is no longer available (it expired, or the server restarted). Attach it again.',
          'not_found',
        );
      }
      found.push(entry);
    }
    for (const entry of found) this.entries.delete(entry.id);
    return found;
  }

  /** PA-137: drops uploads that will never be sent (a Telegram message that
      failed halfway), file and all. Unknown ids are ignored. */
  discard(ids: readonly string[], principal: string): void {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.principal !== principal) continue;
      this.entries.delete(id);
      fs.rmSync(entry.stagedPath, { force: true });
    }
  }

  /** Undo a `take` whose landing never happened. */
  release(entries: readonly StagedAttachment[]): void {
    for (const entry of entries) {
      if (fs.existsSync(entry.stagedPath)) this.entries.set(entry.id, entry);
    }
  }

  /** Drop expired uploads, and their files. */
  sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.entries) {
      if (entry.createdAt >= cutoff) continue;
      this.entries.delete(id);
      fs.rmSync(entry.stagedPath, { force: true });
    }
  }

  /** For tests. */
  size(): number {
    return this.entries.size;
  }
}

export function tooLargeMessage(maxBytes = MAX_ATTACHMENT_BYTES): string {
  return `That file is too large — files can be at most ${Math.floor(maxBytes / (1024 * 1024))} MB.`;
}

/** Informational only (shown on the chip, recorded in the transcript), never
    used to pick a handler, so anything odd becomes octet-stream. */
function normalizeMediaType(raw: string): string {
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(base)
    ? base
    : 'application/octet-stream';
}

/**
 * Lands every staged entry into `target` and returns what the transcript
 * records about each. All-or-nothing in the sense that matters: on a failure,
 * the files already landed are removed again and the rest released back to
 * staging, so the prompt is refused with nothing half-delivered.
 */
export function landStagedAttachments(
  staging: AttachmentStaging,
  target: LandingTarget,
  entries: readonly StagedAttachment[],
): PromptAttachment[] {
  const landed: Array<{ entry: StagedAttachment; absPath: string; attachment: PromptAttachment }> = [];
  try {
    for (const entry of entries) {
      const { absPath, relPath } = landAttachment(target, { kind: 'file', path: entry.stagedPath }, () =>
        uniqueAttachmentName(entry.name),
      );
      landed.push({
        entry,
        absPath,
        attachment: {
          name: entry.name.slice(0, MAX_ATTACHMENT_NAME_CHARS),
          path: relPath,
          size: entry.size,
          mediaType: entry.mediaType,
        },
      });
    }
  } catch (err) {
    // A landed file was *moved* out of staging, so on rollback it is moved
    // back rather than deleted: the retry the error invites must still find it.
    for (const done of landed) {
      try {
        fs.renameSync(done.absPath, done.entry.stagedPath);
      } catch {
        fs.rmSync(done.absPath, { force: true });
      }
    }
    staging.release(entries);
    throw err;
  }
  return landed.map((l) => l.attachment);
}

// ---- Removing landed files (PA-137) -------------------------------------------

/**
 * Deletes landed attachments — each file and its extracted-text sidecar — from
 * `root`, and nothing else. Every path is resolved inside the realpath'd root
 * and must be a regular file reached through no symlink, so a transcript entry
 * (or an agent that edited one) can never point this at anything outside the
 * landing directories. Returns how many files went.
 */
export function removeLandedAttachments(root: string, attachments: readonly PromptAttachment[]): number {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return 0;
  }
  const allowed = [SESSION_ATTACHMENTS_DIR, PLANNER_UPLOADS_DIR].map((dir) => path.join(realRoot, ...dir.split('/')));
  let removed = 0;
  for (const attachment of attachments) {
    for (const rel of [attachment.path, attachment.extractedPath]) {
      if (!rel) continue;
      const abs = path.resolve(realRoot, ...rel.split('/'));
      if (!allowed.some((dir) => path.dirname(abs) === dir)) continue;
      try {
        if (fs.realpathSync(path.dirname(abs)) !== path.dirname(abs)) continue;
        const stat = fs.lstatSync(abs);
        if (!stat.isFile()) continue;
        fs.unlinkSync(abs);
        removed++;
      } catch {
        // Already gone, or never landed: nothing to do.
      }
    }
  }
  return removed;
}
