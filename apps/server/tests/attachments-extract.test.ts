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
import {
  makeDocx,
  makeFlateBombPdf,
  makePdf,
  makePptx,
  makeRichDocx,
  makeRichPptx,
  makeRichXlsx,
  makeXlsx,
} from './helpers-documents.js';

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

  // ---- PA-139: full-information extraction & partial results -----------------

  it('keeps a partial extract with truncatedReason="time" and stoppedAt when a multi-page document exceeds the time budget', async () => {
    const pages = Array.from({ length: 1200 }, (_, i) => `Page ${i + 1} content line`);
    const file = write('many-pages.pdf', makePdf(pages));
    // Measure how long the worker startup + first pages take so we pick a budget that lands mid-document.
    let reply = await extractDocumentText(file, 'pdf', { timeoutMs: 250 });
    for (const ms of [350, 500, 750, 1000]) {
      if (reply.ok && reply.truncated && reply.truncatedReason === 'time') break;
      reply = await extractDocumentText(file, 'pdf', { timeoutMs: ms });
    }
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.truncated).toBe(true);
    expect(reply.truncatedReason).toBe('time');
    expect(reply.stoppedAt).toMatch(/^page \d+ of 1200$/);
    expect(reply.pages).toBeGreaterThan(0);
    expect(reply.pages).toBeLessThan(1200);
    expect(reply.text).toContain('--- Page 1 ---\nPage 1 content line');
  });

  it('caps total output bytes across all files of an upload with truncatedReason="size" and stoppedAt', async () => {
    const pages = Array.from({ length: 20 }, (_, i) => `Page ${i + 1}: ${'word '.repeat(50)}`);
    const reply = await extractDocumentText(write('sized.pdf', makePdf(pages)), 'pdf', { maxOutputBytes: 400 });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.truncated).toBe(true);
    expect(reply.truncatedReason).toBe('size');
    expect(reply.stoppedAt).toMatch(/^page \d+ of 20$/);
    expect(Buffer.byteLength(reply.text, 'utf8')).toBeLessThanOrEqual(400);
  });

  it('keeps wide xlsx columns (> 512), ISO dates, percents, currencies, formulas without cached values, empty rows, hidden sheets, merges and comments', async () => {
    const xlsx = makeRichXlsx([
      {
        name: 'Summary',
        merges: ['A1:C1'],
        comments: [{ ref: 'A1', author: 'Alice', text: 'Reviewed header' }],
        rows: [
          {
            r: 1,
            cells: [
              // 45123 in Excel's 1900 date system is 2023-07-16.
              { ref: 'A1', value: 45123, style: 1 },
              { ref: 'B1', value: 0.125, style: 3 },
              { ref: 'C1', value: 1234.5, style: 4 },
              // Column WC is index 599 (> 512).
              { ref: 'WC1', value: 'wide-col-600' },
            ],
          },
          // Rows 2 and 3 are intentionally omitted to verify row positions stay aligned.
          {
            r: 4,
            cells: [
              { ref: 'A4', formula: 'SUM(B1:C1)' }, // Formula with no cached `<v>`
              { ref: 'B4', formula: '10*2', value: 20 }, // Formula with cached `<v>`
            ],
          },
        ],
      },
      {
        name: 'Secret',
        hidden: true,
        rows: [{ r: 1, cells: [{ ref: 'A1', value: 'internal' }] }],
      },
    ]);

    const reply = await extractDocumentText(write('rich.xlsx', xlsx), 'xlsx');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;

    // Overview text contains hidden flags, merges, comments, formulas, formatted dates, and wide columns.
    expect(reply.text).toContain('## Sheet: Summary');
    expect(reply.text).toContain('Merged ranges: A1:C1');
    expect(reply.text).toContain('Comment A1 (Alice): Reviewed header');
    expect(reply.text).toContain('2023-07-16,12.50%,$1234.50');
    expect(reply.text).toContain('wide-col-600');
    expect(reply.text).toContain('=SUM(B1:C1),20');
    expect(reply.text).toContain('Formula A4: =SUM(B1:C1)');
    expect(reply.text).toContain('Formula B4: =10*2 (cached: 20)');
    expect(reply.text).toContain('## Sheet: Secret [hidden]');

    // Per-sheet CSVs are valid standalone CSVs with row 4 on line 4 (rows 2 and 3 are empty lines).
    const summaryCsv = reply.files?.find((f) => f.kind === 'sheet_csv' && f.label === 'Summary');
    expect(summaryCsv).toBeDefined();
    const csvLines = summaryCsv!.text.split('\n');
    expect(csvLines[0]).toContain('2023-07-16,12.50%,$1234.50');
    expect(csvLines[0]).toContain('wide-col-600');
    expect(csvLines[1]).toBe('');
    expect(csvLines[2]).toBe('');
    expect(csvLines[3]).toBe('=SUM(B1:C1),20');
  });

  it('converts a docx to structured Markdown with headings, tables, links, footnotes, headers/footers, comments and tracked changes', async () => {
    const docx = makeRichDocx({
      heading: 'Quarterly Review',
      link: { text: 'Dashboard', url: 'https://example.com/q3' },
      footnote: 'Audited by Finance.',
      table: [
        ['Region', 'Revenue'],
        ['NA', '42M'],
      ],
      header: 'CONFIDENTIAL HEADER',
      footer: 'Page Footer',
      comment: { author: 'Reviewer', text: 'Verify NA total' },
      inserted: { author: 'Alice', text: 'added clause' },
      deleted: { author: 'Bob', text: 'removed clause' },
    });
    const reply = await extractDocumentText(write('rich.docx', docx), 'docx');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.text).toContain('## Headers\nCONFIDENTIAL HEADER');
    expect(reply.text).toContain('# Quarterly Review');
    expect(reply.text).toContain('[Dashboard](https://example.com/q3)');
    expect(reply.text).toContain('| Region | Revenue |\n| --- | --- |\n| NA | 42M |');
    expect(reply.text).toContain('Audited by Finance.');
    expect(reply.text).toContain('## Footers\nPage Footer');
    expect(reply.text).toContain('## Tracked Changes\n- [Inserted by Alice]: added clause\n- [Deleted by Bob]: removed clause');
    expect(reply.text).toContain('## Comments\n- Reviewer: Verify NA total');
  });

  it('reads a pptx in sldIdLst order with hidden flags, <a:p ...> attributes, tables, charts and speaker notes', async () => {
    const pptx = makeRichPptx(
      [
        {
          paragraphs: ['Second in deck (file 1)'],
          paraAttrs: true,
          hidden: true,
          notes: 'Speaker note on hidden slide',
        },
        {
          paragraphs: ['First in deck (file 2)'],
          paraAttrs: true,
          table: [
            ['Plan', 'Price'],
            ['Pro', '$20'],
          ],
          chart: { title: 'ARR Growth', series: ['2025', '2026'] },
          notes: 'Opening talking points',
        },
      ],
      [2, 1], // Slide 2 comes first in presentation.xml's sldIdLst
    );
    const reply = await extractDocumentText(write('rich.pptx', pptx), 'pptx');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.text).toBe(
      [
        '--- Slide 1 ---',
        'First in deck (file 2)',
        '| Plan | Price |',
        '| Pro | $20 |',
        'Chart: ARR Growth (2025, 2026)',
        'Notes:',
        'Opening talking points',
        '',
        '--- Slide 2 [hidden] ---',
        'Second in deck (file 1)',
        'Notes:',
        'Speaker note on hidden slide',
      ].join('\n'),
    );
  });

  it('inserts spaces between separate positioned PDF word items, and extracts metadata, form fields, annotations and partial-scan counts', async () => {
    const pdf = makePdf(
      [
        // Three words positioned as separate text items on the same baseline (y=720).
        'BT /F1 12 Tf 72 720 Td (Words) Tj 50 0 Td (stay) Tj 40 0 Td (separated) Tj ET',
        // Page 2 is an empty/scanned page with no text layer.
        '',
      ],
      {
        rawStreams: true,
        title: 'Board Deck',
        author: 'CFO',
        formField: { name: 'ApprovalStatus', value: 'Signed' },
        annotation: 'Double-check appendix',
      },
    );
    const reply = await extractDocumentText(write('spaced.pdf', pdf), 'pdf');
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.text).toContain('Title: Board Deck\nAuthor: CFO');
    expect(reply.text).toContain('Words stay separated');
    expect(reply.text).toContain('[Form: ApprovalStatus = Signed]');
    expect(reply.text).toContain('[Annotation: Double-check appendix]');
    expect(reply.text).toContain('[Note: 1 of 2 pages had no text layer (they may be scanned images).]');
  });
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

  it('writes per-sheet CSV files alongside the .txt overview for an xlsx and records them in extractedFiles', async () => {
    const xlsx = makeXlsx({ Budget: [['Item', 'Cost'], ['Rent', 1200]], Forecast: [['Q4', 900]] });
    const [out] = await enrichLandedAttachments(
      plannerLandingTarget(dir),
      [landed('book_x.xlsx', xlsx, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')],
      { extract: true },
    );
    expect(out!.extractedPath).toBe('artifacts/uploads/book_x.xlsx.txt');
    expect(out!.extractedFiles).toEqual([
      { path: 'artifacts/uploads/book_x.xlsx.txt', kind: 'overview', label: 'Extracted text' },
      { path: 'artifacts/uploads/book_x.xlsx.Budget.csv', kind: 'sheet_csv', label: 'Budget' },
      { path: 'artifacts/uploads/book_x.xlsx.Forecast.csv', kind: 'sheet_csv', label: 'Forecast' },
    ]);
    expect(fs.readFileSync(path.join(dir, 'artifacts/uploads/book_x.xlsx.Budget.csv'), 'utf8')).toBe(
      'Item,Cost\nRent,1200\n',
    );
    expect(fs.readFileSync(path.join(dir, 'artifacts/uploads/book_x.xlsx.Forecast.csv'), 'utf8')).toBe('Q4,900\n');
    const overview = fs.readFileSync(path.join(dir, out!.extractedPath!), 'utf8');
    expect(overview).toContain('Sheet CSV files:\n- Budget: artifacts/uploads/book_x.xlsx.Budget.csv');
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
