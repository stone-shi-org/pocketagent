import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentError,
  AttachmentStaging,
  landAttachment,
  landStagedAttachments,
  plannerLandingTarget,
  sanitizeAttachmentName,
  saveAttachmentToWorkspace,
  sessionLandingTarget,
  uniqueAttachmentName,
} from '../src/attachments/index.js';
import { plannerAttachmentNote } from '../src/attachments/inline.js';

/**
 * PA-136: the half of attachments that writes a browser-named file into a
 * tree an agent treats as source. Most of these are about what must never
 * happen: a traversal, an overwrite, a write through a symlink.
 */

let root: string;
let cwd: string;
let outside: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-attach-')));
  cwd = path.join(root, 'repo');
  outside = path.join(root, 'outside');
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('sanitizeAttachmentName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['Q3 numbers.xlsx', 'Q3 numbers.xlsx'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\win.ini', 'win.ini'],
    ['/abs/path/notes.md', 'notes.md'],
    ['C:\\Users\\me\\doc.docx', 'doc.docx'],
    ['.env', 'env'],
    ['.bashrc', 'bashrc'],
    ['...', 'file'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['   ', 'file'],
    ['a/', 'file'],
    ['evil\u202Etxt.exe', 'eviltxt.exe'],
    ['zero\u200Bwidth.md', 'zerowidth.md'],
    ['new\nline\t.csv', 'newline.csv'],
    ['nul\u0000byte.txt', 'nulbyte.txt'],
    ['what?<>:"|*.txt', 'what_______.txt'],
    ['$(rm -rf).sh', '_(rm -rf).sh'],
    ['Résumé.pdf', 'Résumé.pdf'],
    ['README', 'README'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['UPPER.PDF', 'UPPER.pdf'],
    ['trailing dots...', 'trailing dots'],
  ])('%j → %j', (raw, expected) => {
    expect(sanitizeAttachmentName(raw)).toBe(expected);
  });

  it('caps a long name in bytes, keeping the extension', () => {
    const out = sanitizeAttachmentName(`${'x'.repeat(300)}.pdf`);
    expect(out.endsWith('.pdf')).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
  });

  it('never splits a multi-byte character when capping', () => {
    const out = sanitizeAttachmentName(`${'日本'.repeat(100)}.md`);
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(120);
    expect(out).not.toContain('\uFFFD');
    expect(out.endsWith('.md')).toBe(true);
  });

  it('drops an extension that does not look like one', () => {
    expect(sanitizeAttachmentName('weird.ext with spaces')).toBe('weird.ext with spaces');
    expect(sanitizeAttachmentName(`x.${'a'.repeat(30)}`)).toBe(`x.${'a'.repeat(30)}`);
  });
});

describe('uniqueAttachmentName', () => {
  it('stamps the time and a suffix before the extension', () => {
    const name = uniqueAttachmentName('report.pdf', new Date(2026, 9, 12, 14, 30, 5), 'a1b2');
    expect(name).toBe('report_20261012-143005_a1b2.pdf');
    expect(uniqueAttachmentName('README', new Date(2026, 0, 2, 3, 4, 5), 'ffff')).toBe('README_20260102-030405_ffff');
  });
});

describe('landAttachment', () => {
  it('lands into .pocketagent/attachments and writes a .gitignore once', () => {
    const first = landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('one') }, () => 'a.md');
    expect(first.relPath).toBe('.pocketagent/attachments/a.md');
    expect(fs.readFileSync(path.join(cwd, first.relPath), 'utf8')).toBe('one');
    const gitignore = path.join(cwd, '.pocketagent', '.gitignore');
    expect(fs.readFileSync(gitignore, 'utf8')).toMatch(/^\*$/m);

    fs.writeFileSync(gitignore, 'mine\n');
    landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('two') }, () => 'b.md');
    expect(fs.readFileSync(gitignore, 'utf8')).toBe('mine\n');
  });

  it('never overwrites an existing file, and retries under a new name', () => {
    const dir = path.join(cwd, '.pocketagent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'taken.md'), 'original');
    const names = ['taken.md', 'free.md'];
    const landed = landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('new') }, () => names.shift()!);
    expect(landed.relPath).toBe('.pocketagent/attachments/free.md');
    expect(fs.readFileSync(path.join(dir, 'taken.md'), 'utf8')).toBe('original');
  });

  it('does not overwrite when moving a staged file onto a taken name either', () => {
    const dir = path.join(cwd, '.pocketagent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'taken.pdf'), 'original');
    const staged = path.join(outside, 'staged');
    fs.writeFileSync(staged, 'upload');
    const names = ['taken.pdf', 'other.pdf'];
    const landed = landAttachment(sessionLandingTarget(cwd), { kind: 'file', path: staged }, () => names.shift()!);
    expect(landed.relPath).toBe('.pocketagent/attachments/other.pdf');
    expect(fs.readFileSync(path.join(dir, 'taken.pdf'), 'utf8')).toBe('original');
    expect(fs.readFileSync(path.join(dir, 'other.pdf'), 'utf8')).toBe('upload');
    // Moved, not copied.
    expect(fs.existsSync(staged)).toBe(false);
  });

  it('two concurrent landings of the same name both survive', () => {
    const a = landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('A') }, () => uniqueAttachmentName('same.md'));
    const b = landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('B') }, () => uniqueAttachmentName('same.md'));
    expect(a.relPath).not.toBe(b.relPath);
    expect(fs.readFileSync(path.join(cwd, a.relPath), 'utf8')).toBe('A');
    expect(fs.readFileSync(path.join(cwd, b.relPath), 'utf8')).toBe('B');
  });

  it('refuses a .pocketagent symlink pointing out of the tree, and writes nothing outside', () => {
    fs.symlinkSync(outside, path.join(cwd, '.pocketagent'));
    expect(() =>
      landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('x') }, () => 'x.md'),
    ).toThrow(AttachmentError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('refuses a symlinked attachments directory even when it points inside the tree', () => {
    fs.mkdirSync(path.join(cwd, '.pocketagent'));
    fs.mkdirSync(path.join(cwd, 'elsewhere'));
    fs.symlinkSync(path.join(cwd, 'elsewhere'), path.join(cwd, '.pocketagent', 'attachments'));
    expect(() =>
      landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('x') }, () => 'x.md'),
    ).toThrow(/not a plain directory/);
  });

  it('refuses to write through a planted file symlink, leaving its target untouched', () => {
    const dir = path.join(cwd, '.pocketagent', 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const victim = path.join(outside, 'victim');
    fs.writeFileSync(victim, 'precious');
    fs.symlinkSync(victim, path.join(dir, 'trap.md'));
    const names = ['trap.md', 'safe.md'];
    const landed = landAttachment(sessionLandingTarget(cwd), { kind: 'buffer', data: Buffer.from('x') }, () => names.shift()!);
    expect(landed.relPath).toBe('.pocketagent/attachments/safe.md');
    expect(fs.readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('lands a planner upload under artifacts/uploads with no .gitignore', () => {
    const ws = path.join(root, 'planner');
    fs.mkdirSync(path.join(ws, 'artifacts'), { recursive: true });
    const landed = landAttachment(plannerLandingTarget(ws), { kind: 'buffer', data: Buffer.from('x') }, () => 'n.md');
    expect(landed.relPath).toBe('artifacts/uploads/n.md');
    expect(fs.existsSync(path.join(ws, '.pocketagent'))).toBe(false);
  });

  it('answers not_found when the tree has gone', () => {
    expect(() =>
      landAttachment(sessionLandingTarget(path.join(root, 'gone')), { kind: 'buffer', data: Buffer.from('x') }, () => 'x'),
    ).toThrow(expect.objectContaining({ code: 'not_found' }));
  });
});

describe('saveAttachmentToWorkspace (images, as before)', () => {
  it('keeps the attachment_<ts>_<hex>.<ext> scheme', () => {
    const relPath = saveAttachmentToWorkspace(cwd, { mediaType: 'image/png', data: 'aGVsbG8=' });
    expect(relPath).toMatch(/^\.pocketagent\/attachments\/attachment_\d+_[a-f0-9]+\.png$/);
    expect(fs.readFileSync(path.join(cwd, relPath), 'utf8')).toBe('hello');
  });

  it('now refuses the symlink escape images used to follow', () => {
    fs.symlinkSync(outside, path.join(cwd, '.pocketagent'));
    expect(() => saveAttachmentToWorkspace(cwd, { mediaType: 'image/png', data: 'aGVsbG8=' })).toThrow(AttachmentError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe('AttachmentStaging', () => {
  let now = 1_000_000;
  let staging: AttachmentStaging;
  const stagingDir = (): string => path.join(root, 'staging');

  beforeEach(() => {
    now = 1_000_000;
    staging = new AttachmentStaging({ dir: stagingDir(), ttlMs: 60_000, maxBytes: 1024, maxPerPrincipal: 3, now: () => now });
    staging.init();
  });

  afterEach(() => staging.stop());

  const upload = (data: string | Buffer, name = 'doc.md', principal = 'session') =>
    staging.stage(Readable.from([Buffer.from(data)]), { name, mediaType: 'text/markdown; charset=utf-8', principal });

  it('empties the directory at init, since nothing staged survives a restart', () => {
    fs.writeFileSync(path.join(stagingDir(), 'att_leftover'), 'x');
    staging.init();
    expect(fs.readdirSync(stagingDir())).toEqual([]);
  });

  it('stages an upload privately and reports the sanitised name and normalised type', async () => {
    const res = await upload('# hi', '../../secret/notes.md');
    expect(res.attachmentId).toMatch(/^att_/);
    expect(res).toMatchObject({ name: 'notes.md', size: 4, mediaType: 'text/markdown' });
    const file = path.join(stagingDir(), res.attachmentId);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('cuts an oversized body off at the cap and keeps nothing', async () => {
    await expect(upload(Buffer.alloc(1025))).rejects.toMatchObject({ code: 'too_large' });
    expect(fs.readdirSync(stagingDir())).toEqual([]);
    expect(staging.size()).toBe(0);
    // Exactly at the cap is fine.
    await expect(upload(Buffer.alloc(1024))).resolves.toMatchObject({ size: 1024 });
  });

  it('turns an odd media type into octet-stream rather than trusting it', async () => {
    const res = await staging.stage(Readable.from([Buffer.from('x')]), { name: 'a', mediaType: 'not a type', principal: 'p' });
    expect(res.mediaType).toBe('application/octet-stream');
  });

  it('is single-use and principal-bound', async () => {
    const { attachmentId } = await upload('x');
    expect(() => staging.take([attachmentId], 'hub:other')).toThrow(/no longer available/);
    expect(staging.take([attachmentId], 'session')).toHaveLength(1);
    expect(() => staging.take([attachmentId], 'session')).toThrow(/no longer available/);
  });

  it('claims all ids or none', async () => {
    const { attachmentId } = await upload('x');
    expect(() => staging.take([attachmentId, 'att_doesnotexist000000'], 'session')).toThrow(AttachmentError);
    // The good one was not consumed by the failed claim.
    expect(staging.take([attachmentId], 'session')).toHaveLength(1);
  });

  it('sweeps an unsent upload after the TTL, file and all', async () => {
    const { attachmentId } = await upload('x');
    now += 60_001;
    staging.sweep();
    expect(fs.existsSync(path.join(stagingDir(), attachmentId))).toBe(false);
    expect(() => staging.take([attachmentId], 'session')).toThrow(/expired/);
  });

  it('bounds how many unsent uploads one principal may hold', async () => {
    await upload('1');
    await upload('2');
    await upload('3');
    await expect(upload('4')).rejects.toMatchObject({ code: 'too_many' });
    await expect(upload('4', 'x', 'hub:h1')).resolves.toBeDefined();
  });

  it('lands a taken upload under its sanitised name plus a unique suffix', async () => {
    const a = await upload('A', 'a.md');
    const landed = landStagedAttachments(staging, sessionLandingTarget(cwd), staging.take([a.attachmentId], 'session'));
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ name: 'a.md', size: 1, mediaType: 'text/markdown' });
    expect(landed[0]!.path).toMatch(/^\.pocketagent\/attachments\/a_\d{8}-\d{6}_[0-9a-f]{4}\.md$/);
    expect(fs.readFileSync(path.join(cwd, landed[0]!.path), 'utf8')).toBe('A');
    expect(fs.existsSync(path.join(stagingDir(), a.attachmentId))).toBe(false);
  });

  it('releases an upload whose landing failed, so a retry still finds it', async () => {
    const b = await upload('B', 'b.md');
    const entries = staging.take([b.attachmentId], 'session');
    // A plain file where the attachments directory has to go.
    fs.writeFileSync(path.join(cwd, '.pocketagent'), 'not a directory');
    expect(() => landStagedAttachments(staging, sessionLandingTarget(cwd), entries)).toThrow(AttachmentError);
    expect(staging.take([b.attachmentId], 'session')).toHaveLength(1);
  });

  it('rolls back files already landed when a later one fails', async () => {
    const a = await upload('A', 'a.md');
    const b = await upload('B', 'b.md');
    const entries = staging.take([a.attachmentId, b.attachmentId], 'session');
    // The second entry's staged file vanishes, so its landing throws.
    fs.rmSync(entries[1]!.stagedPath);
    expect(() => landStagedAttachments(staging, sessionLandingTarget(cwd), entries)).toThrow();
    expect(fs.readdirSync(path.join(cwd, '.pocketagent', 'attachments'))).toEqual([]);
    // The first is back in staging, file and all.
    expect(fs.readFileSync(entries[0]!.stagedPath, 'utf8')).toBe('A');
    expect(staging.take([a.attachmentId], 'session')).toHaveLength(1);
  });
});

describe('plannerAttachmentNote', () => {
  it('names each file with its size and type, and says a binary with no extract needs a command', () => {
    const note = plannerAttachmentNote([
      { name: 'r.pdf', path: 'artifacts/uploads/r_x.pdf', size: 2_500_000, mediaType: 'application/pdf' },
    ]);
    expect(note).toContain('[Attached file saved to: artifacts/uploads/r_x.pdf (r.pdf, 2.4 MB, application/pdf)]');
    expect(note).toMatch(/can only be read with a command/);
    // PA-137: an extracted document names its sidecar instead, and needs no command.
    const extracted = plannerAttachmentNote([
      {
        name: 'r.pdf',
        path: 'artifacts/uploads/r_x.pdf',
        size: 2_500_000,
        mediaType: 'application/pdf',
        extractedPath: 'artifacts/uploads/r_x.pdf.txt',
        extractedChars: 120_000,
        truncated: true,
      },
    ]);
    expect(extracted).toContain('[Its text was extracted to: artifacts/uploads/r_x.pdf.txt (120,000 characters; the document is longer');
    expect(extracted).not.toMatch(/with a command/);
    expect(plannerAttachmentNote([])).toBe('');
    expect(plannerAttachmentNote(undefined)).toBe('');
  });
});
