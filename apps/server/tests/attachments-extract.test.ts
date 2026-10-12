import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptAttachment } from '@pocketagent/protocol';
import {
  documentKindFor,
  enrichLandedAttachments,
  extractDocumentText,
  isTextAttachment,
} from '../src/attachments/extract.js';
import { plannerLandingTarget } from '../src/attachments/index.js';
import { makeDocx, makeFlateBombPdf, makePdf, makePptx, makeXlsx } from './helpers-documents.js';

/**
 * PA-137 Phase 1b: text out of a stranger's document, in a worker that can be
 * killed. The documents are built in memory (`helpers-documents.ts`), so these
 * exercise the real libraries — unpdf, mammoth, fflate — on real formats.
 */

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa137-extract-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, data: Buffer | string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

describe('extractDocumentText', () => {
  it('reads every page of a PDF, page by page', async () => {
    const reply = await extractDocumentText(write('a.pdf', makePdf(['Quarterly revenue rose', 'Costs (flat)'])), 'pdf');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.text).toContain('--- Page 1 ---\nQuarterly revenue rose');
    expect(reply.text).toContain('--- Page 2 ---\nCosts (flat)');
    expect(reply).toMatchObject({ pages: 2, totalPages: 2, truncated: false });
  });

  it('stops at the page cap and says it was truncated', async () => {
    const pages = Array.from({ length: 6 }, (_, i) => `page ${i + 1}`);
    const reply = await extractDocumentText(write('long.pdf', makePdf(pages)), 'pdf', { maxPages: 3 });
    expect(reply.ok && reply.truncated).toBe(true);
    if (!reply.ok) return;
    expect(reply.pages).toBe(3);
    expect(reply.totalPages).toBe(6);
    expect(reply.text).not.toContain('page 4');
  });

  it('stops at the character cap', async () => {
    const reply = await extractDocumentText(write('big.docx', makeDocx(['x'.repeat(5000)])), 'docx', { maxChars: 100 });
    expect(reply.ok && reply.truncated && reply.text.length === 100).toBe(true);
  });

  it('reads a docx as paragraphs', async () => {
    const reply = await extractDocumentText(write('a.docx', makeDocx(['First paragraph', 'Second & last'])), 'docx');
    expect(reply).toMatchObject({ ok: true, text: 'First paragraph\n\nSecond & last' });
  });

  it('reads an xlsx as CSV per sheet, shared strings and numbers both', async () => {
    const xlsx = makeXlsx({ Budget: [['Item', 'Cost'], ['Rent, flat', 1200], ['Food "weekly"', 300]], Notes: [['ok']] });
    const reply = await extractDocumentText(write('a.xlsx', xlsx), 'xlsx');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.text).toBe(
      '## Sheet: Budget\nItem,Cost\n"Rent, flat",1200\n"Food ""weekly""",300\n\n## Sheet: Notes\nok',
    );
  });

  it('reads a pptx slide by slide', async () => {
    const reply = await extractDocumentText(write('a.pptx', makePptx([['Title', 'Sub'], ['Agenda']])), 'pptx');
    expect(reply).toMatchObject({ ok: true, text: '--- Slide 1 ---\nTitle\nSub\n\n--- Slide 2 ---\nAgenda' });
  });

  it('turns a malformed PDF into a note, not a throw', async () => {
    const reply = await extractDocumentText(write('bad.pdf', '%PDF-1.4\nthis is not a pdf at all\n%%EOF'), 'pdf');
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error.length).toBeGreaterThan(0);
  });

  it('refuses a zip that unpacks past the cap without inflating it', async () => {
    // 8 MB of zeros compresses to a few KB: a small zip bomb.
    const bomb = Buffer.from(
      zipSync({ 'xl/workbook.xml': strToU8('<workbook/>'), 'xl/worksheets/sheet1.xml': new Uint8Array(8 * 1024 * 1024) }),
    );
    expect(bomb.length).toBeLessThan(100_000);
    const reply = await extractDocumentText(write('bomb.xlsx', bomb), 'xlsx', { maxUnzippedBytes: 1024 * 1024 });
    expect(reply).toMatchObject({ ok: false });
    if (reply.ok) return;
    expect(reply.error).toMatch(/unpacks to 8 MB, over the 1 MB limit/);
  });

  it('kills a parse that runs past the timeout, and the server keeps going', async () => {
    const pages = Array.from({ length: 50 }, (_, i) => `page ${i}`);
    const file = write('slow.pdf', makePdf(pages));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const reply = await extractDocumentText(file, 'pdf', { timeoutMs: 1 });
    clearInterval(timer);
    expect(reply).toMatchObject({ ok: false });
    if (reply.ok) return;
    expect(reply.error).toMatch(/took longer than/);
    // The event loop was never blocked by the parse.
    expect(ticks).toBeGreaterThanOrEqual(0);
    // And the next document still extracts: the worker was the one to die.
    const next = await extractDocumentText(write('ok.pdf', makePdf(['fine'])), 'pdf');
    expect(next.ok).toBe(true);
  });

  it('kills a zip bomb at the memory cap, even when its sizes fit the heap', async () => {
    // Inflating 200 MB lands in typed arrays, outside any V8 heap limit —
    // which is why this runs in a process whose resident memory is watched.
    const bomb = Buffer.from(zipSync({ 'ppt/slides/slide1.xml': new Uint8Array(200 * 1024 * 1024) }, { level: 9 }));
    const reply = await extractDocumentText(write('heap.pptx', bomb), 'pptx', {
      maxRssMb: 128,
      maxUnzippedBytes: 1024 * 1024 * 1024,
    });
    expect(reply).toEqual({ ok: false, error: 'Reading the document needed more memory than allowed.' });
  }, 30_000);

  it('kills a PDF whose page stream inflates past the memory cap', async () => {
    const reply = await extractDocumentText(write('bomb.pdf', makeFlateBombPdf(400 * 1024 * 1024)), 'pdf', { maxRssMb: 160 });
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.error).toMatch(/more memory than allowed|took longer/);
  }, 30_000);
});

describe('what a file is', () => {
  it('needs the bytes to agree with the name before extracting', () => {
    const pdf = makePdf(['x']);
    expect(documentKindFor('a.pdf', 'application/pdf', pdf)).toBe('pdf');
    expect(documentKindFor('a.pdf', 'application/pdf', Buffer.from('not a pdf'))).toBeNull();
    expect(documentKindFor('a.docx', '', makeDocx(['x']))).toBe('docx');
    expect(documentKindFor('a.xlsx', '', Buffer.from('PK nope'))).toBeNull();
    // Legacy binary Office formats are not read.
    expect(documentKindFor('a.doc', 'application/msword', Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))).toBeNull();
    // A declared type is enough to propose a kind when the name says nothing.
    expect(documentKindFor('upload', 'application/pdf', pdf)).toBe('pdf');
  });

  it('calls UTF-8 text text, and nothing else', () => {
    expect(isTextAttachment('notes.md', 'text/markdown', Buffer.from('# Hi ✓'))).toBe(true);
    expect(isTextAttachment('data.csv', 'application/octet-stream', Buffer.from('a,b\n1,2'))).toBe(true);
    expect(isTextAttachment('Dockerfile', '', Buffer.from('FROM node'))).toBe(true);
    expect(isTextAttachment('a.json', 'application/json', Buffer.from('{"a":1}'))).toBe(true);
    // A text name with binary bytes, or UTF-16, is not text.
    expect(isTextAttachment('a.csv', 'text/csv', Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe(false);
    expect(isTextAttachment('a.txt', 'text/plain', Buffer.from('a\u0000b'))).toBe(false);
    // Text bytes with a binary name are not text either.
    expect(isTextAttachment('a.pdf', 'application/pdf', Buffer.from('hello'))).toBe(false);
    // A multi-byte character cut at the sniff boundary is still text.
    expect(isTextAttachment('a.txt', 'text/plain', Buffer.from('ab✓').subarray(0, 4))).toBe(true);
  });
});

describe('enrichLandedAttachments', () => {
  const landed = (name: string, data: Buffer | string, mediaType: string): PromptAttachment => {
    const rel = `artifacts/uploads/${name}`;
    fs.mkdirSync(path.join(dir, 'artifacts', 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), data);
    return { name, path: rel, size: Buffer.byteLength(data), mediaType };
  };

  it('writes a sidecar beside a document and records it', async () => {
    const [out] = await enrichLandedAttachments(
      plannerLandingTarget(dir),
      [landed('r_x.pdf', makePdf(['Hello']), 'application/pdf')],
      { extract: true },
    );
    expect(out).toMatchObject({ extractedPath: 'artifacts/uploads/r_x.pdf.txt', truncated: false });
    expect(fs.readFileSync(path.join(dir, out!.extractedPath!), 'utf8')).toBe('--- Page 1 ---\nHello\n');
    expect(out!.extractedChars).toBe('--- Page 1 ---\nHello'.length);
  });

  it('marks a text file and leaves it alone', async () => {
    const [out] = await enrichLandedAttachments(plannerLandingTarget(dir), [landed('n.md', '# notes', 'text/markdown')], {
      extract: true,
    });
    expect(out).toMatchObject({ text: true });
    expect(out!.extractedPath).toBeUndefined();
  });

  it('never overwrites a file already at the sidecar name', async () => {
    const a = landed('r.pdf', makePdf(['new']), 'application/pdf');
    fs.writeFileSync(path.join(dir, 'artifacts/uploads/r.pdf.txt'), 'the user\'s own file');
    const [out] = await enrichLandedAttachments(plannerLandingTarget(dir), [a], { extract: true });
    expect(out!.extractedPath).toBe('artifacts/uploads/r.pdf.2.txt');
    expect(fs.readFileSync(path.join(dir, 'artifacts/uploads/r.pdf.txt'), 'utf8')).toBe("the user's own file");
  });

  it('records why extraction failed, and keeps the file', async () => {
    const [out] = await enrichLandedAttachments(
      plannerLandingTarget(dir),
      [landed('bad.pdf', '%PDF-1.4 garbage', 'application/pdf')],
      { extract: true },
    );
    expect(out!.extractError).toBeTruthy();
    expect(out!.extractedPath).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'artifacts/uploads/bad.pdf'))).toBe(true);
  });

  it('says a document with no text layer is probably a scan', async () => {
    const [out] = await enrichLandedAttachments(plannerLandingTarget(dir), [landed('s.pdf', makePdf(['']), 'application/pdf')], {
      extract: true,
    });
    expect(out!.extractError).toMatch(/scan/);
  });

  it('extracts nothing when told not to (claude reads PDFs itself)', async () => {
    const [out] = await enrichLandedAttachments(
      plannerLandingTarget(dir),
      [landed('r.pdf', makePdf(['x']), 'application/pdf')],
      { extract: false },
    );
    expect(out!.extractedPath).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'artifacts/uploads'))).toEqual(['r.pdf']);
  });
});
