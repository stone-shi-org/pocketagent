/**
 * PA-137: the child process that turns an attached document into plain text.
 *
 * Forked by `extract.ts`, which owns the timeout and the memory cap: the
 * document is a stranger's file, so the parse happens in a process that can
 * be killed outright. A process rather than a `worker_thread` (which the
 * ticket proposed) because `resourceLimits` caps only the V8 heap, and every
 * parser here decompresses into typed arrays, which live outside it — a test
 * inflated 200 MB inside a worker capped at 16 MB of heap. A child's memory
 * is its own, so the parent can watch its RSS and kill it, and the server's
 * heap never sees the document at all.
 *
 * Self-contained on purpose — node builtins and the three parsing libraries,
 * nothing from this repo — so the same file runs as compiled `.js` from
 * `dist/` and as `.ts` under Node's built-in type stripping in dev and tests,
 * with no loader. Only erasable TypeScript belongs here for that reason (no
 * enums, no parameter properties, no namespaces).
 *
 * Nothing the document says is executed or fetched:
 * - `fetch` is replaced before any library loads, so a parser that wanted to
 *   pull a font, a CMap or a linked resource gets a rejection, not a socket.
 * - pdf.js runs with no font face loading and no XFA forms. The pdf.js
 *   bundled by `unpdf` (5.x) no longer compiles font programs with `eval`
 *   at all, which is what CVE-2024-4367's `isEvalSupported` switch used to
 *   guard; keep `unpdf` current for the same reason.
 * - The OOXML readers (xlsx, pptx) are regular expressions over the XML text,
 *   never an XML engine that could resolve an entity or a DTD.
 */
import fs from 'node:fs';

export type ExtractKind = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export interface ExtractJob {
  path: string;
  kind: ExtractKind;
  maxChars: number;
  maxPages: number;
  /** Declared uncompressed bytes a zip may hold in total before it is refused unopened. */
  maxUnzippedBytes: number;
}

export type ExtractReply =
  | {
      ok: true;
      text: string;
      pages: number;
      totalPages: number;
      truncated: boolean;
      /** Characters of document text, not counting the page and slide headings. */
      contentChars: number;
    }
  | { ok: false; error: string };

// No network, whatever a parser was going to do with it.
(globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('Network access is disabled while extracting text.'));

/** Collects output up to `maxChars`, remembering whether anything was cut. */
class Output {
  text = '';
  truncated = false;
  contentChars = 0;
  readonly maxChars: number;
  constructor(maxChars: number) {
    this.maxChars = maxChars;
  }
  get full(): boolean {
    return this.text.length >= this.maxChars;
  }
  push(chunk: string): void {
    if (this.truncated) return;
    const room = this.maxChars - this.text.length;
    if (chunk.length > room) {
      this.text += chunk.slice(0, Math.max(0, room));
      this.truncated = true;
      return;
    }
    this.text += chunk;
  }
}

// ---- PDF ---------------------------------------------------------------------

async function extractPdf(data: Uint8Array, job: ExtractJob): Promise<ExtractReply> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(data, {
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    // A broken object should cost that page, not the whole document.
    stopAtErrors: false,
  });
  const totalPages = pdf.numPages;
  const out = new Output(job.maxChars);
  let pages = 0;
  for (let i = 1; i <= totalPages && i <= job.maxPages && !out.full; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (!('str' in item)) continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }
    page.cleanup();
    pages++;
    out.contentChars += pageText.trim().length;
    out.push(`${pages > 1 ? '\n\n' : ''}--- Page ${i} ---\n${pageText.trim()}`);
  }
  // Not every pdf.js build exposes the same teardown; the worker is
  // terminated right after this reply either way.
  await (pdf as { destroy?: () => Promise<void> }).destroy?.();
  return {
    ok: true,
    text: out.text,
    pages,
    totalPages,
    truncated: out.truncated || pages < totalPages,
    contentChars: out.contentChars,
  };
}

// ---- Zip containers (docx, xlsx, pptx) ---------------------------------------

/**
 * Reads a zip's central directory and refuses it before inflating anything if
 * the declared sizes add up to more than the cap — the cheap half of the zip
 * bomb defence. The other half is the worker's heap cap, because a declared
 * size is the attacker's own claim.
 */
async function readZip(data: Uint8Array, job: ExtractJob, want: (name: string) => boolean): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  let declared = 0;
  unzipSync(data, {
    filter(file) {
      declared += file.originalSize;
      return false;
    },
  });
  if (declared > job.maxUnzippedBytes) {
    throw new Error(
      `The document unpacks to ${Math.round(declared / (1024 * 1024))} MB, over the ${Math.round(job.maxUnzippedBytes / (1024 * 1024))} MB limit.`,
    );
  }
  return unzipSync(data, { filter: (file) => want(file.name) });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML text content → string. Numeric references and the five predefined
    entities only; anything else stays as written, since there is no DTD. */
function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return safeCodePoint(Number.parseInt(ref.slice(2), 16)) ?? whole;
    if (ref.startsWith('#')) return safeCodePoint(Number.parseInt(ref.slice(1), 10)) ?? whole;
    return ENTITIES[ref] ?? whole;
  });
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

function utf8(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
}

/** Text of every `<t>`-like run inside `xml`, in order. */
function runs(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let text = '';
  for (const m of xml.matchAll(re)) text += decodeXml(m[1] ?? '');
  return text;
}

async function extractDocx(data: Uint8Array, job: ExtractJob): Promise<ExtractReply> {
  // Sized up front, for the zip-bomb reason in `readZip`; mammoth then reads
  // the archive itself.
  await readZip(data, job, () => false);
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength) });
  const out = new Output(job.maxChars);
  const text = result.value.replace(/\n{3,}/g, '\n\n').trim();
  out.push(text);
  return { ok: true, text: out.text, pages: 1, totalPages: 1, truncated: out.truncated, contentChars: text.length };
}

/** `B12` → 1 (zero-based column). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Most columns one row may span; a cell at `XFD1` should not make a 16k-comma line. */
const MAX_COLUMNS = 512;

async function extractXlsx(data: Uint8Array, job: ExtractJob): Promise<ExtractReply> {
  const files = await readZip(
    data,
    job,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
  );

  const shared: string[] = [];
  for (const m of utf8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Phonetic guides (`rPh`) repeat the text in another script; skip them.
    shared.push(runs((m[1] ?? '').replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't'));
  }

  // Sheet order and names come from the workbook; the file for each, from its rels.
  const rels = new Map<string, string>();
  for (const m of utf8(files['xl/_rels/workbook.xml.rels']).matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const sheets: Array<{ name: string; file: string }> = [];
  for (const m of utf8(files['xl/workbook.xml']).matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const file = rels.get(rid) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, file });
  }
  if (sheets.length === 0) {
    for (const name of Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort(byNumber)) {
      sheets.push({ name: name.replace(/^.*\/|\.xml$/g, ''), file: name });
    }
  }

  const out = new Output(job.maxChars);
  let done = 0;
  for (const sheet of sheets) {
    if (done >= job.maxPages || out.full) break;
    const xml = utf8(files[sheet.file]);
    out.push(`${done > 0 ? '\n' : ''}## Sheet: ${sheet.name}\n`);
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (out.full) break;
      const cells: string[] = [];
      for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        if (col < 0 || col >= MAX_COLUMNS) continue;
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
        let value: string;
        if (type === 'inlineStr') value = runs(body, 't');
        else {
          const v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
          else value = v;
        }
        while (cells.length < col) cells.push('');
        cells[col] = csvCell(value);
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length > 0) {
        const line = cells.join(',');
        out.contentChars += line.replace(/,/g, '').length;
        out.push(`${line}\n`);
      }
    }
    done++;
  }
  return {
    ok: true,
    text: out.text.trimEnd(),
    pages: done,
    totalPages: sheets.length,
    truncated: out.truncated || done < sheets.length,
    contentChars: out.contentChars,
  };
}

function byNumber(a: string, b: string): number {
  return Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
}

async function extractPptx(data: Uint8Array, job: ExtractJob): Promise<ExtractReply> {
  const files = await readZip(data, job, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const names = Object.keys(files).sort(byNumber);
  const out = new Output(job.maxChars);
  let done = 0;
  for (const name of names) {
    if (done >= job.maxPages || out.full) break;
    const xml = utf8(files[name]);
    const paragraphs: string[] = [];
    for (const p of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
      const text = runs(p[1] ?? '', 'a:t').trim();
      if (text) paragraphs.push(text);
    }
    done++;
    const body = paragraphs.join('\n');
    out.contentChars += body.length;
    out.push(`${done > 1 ? '\n\n' : ''}--- Slide ${done} ---\n${body}`);
  }
  return {
    ok: true,
    text: out.text,
    pages: done,
    totalPages: names.length,
    truncated: out.truncated || done < names.length,
    contentChars: out.contentChars,
  };
}

// ---- Entry -------------------------------------------------------------------

async function run(job: ExtractJob): Promise<ExtractReply> {
  const data = new Uint8Array(fs.readFileSync(job.path));
  switch (job.kind) {
    case 'pdf':
      return extractPdf(data, job);
    case 'docx':
      return extractDocx(data, job);
    case 'xlsx':
      return extractXlsx(data, job);
    case 'pptx':
      return extractPptx(data, job);
    default:
      return { ok: false, error: 'Unsupported document type.' };
  }
}

// One job per process: the parent sends it, this answers once and exits.
if (typeof process.send === 'function') {
  process.once('message', (job: ExtractJob) => {
    const reply = (value: ExtractReply): void => {
      process.send!(value, () => process.exit(0));
    };
    run(job).then(reply, (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      reply({ ok: false, error: message.slice(0, 200) });
    });
  });
  // The parent going away (a server shutdown mid-parse) ends this too.
  process.once('disconnect', () => process.exit(0));
}
