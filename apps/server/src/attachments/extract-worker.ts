/**
 * PA-137 / PA-139: the child process that turns an attached document into
 * plain text (and, for a spreadsheet, one CSV per sheet).
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
 * PA-139 makes the worker stream its output over IPC as each page, sheet or
 * slide finishes, so a parse that hits the time, size or memory cap keeps a
 * partial extract on disk and records where and why it stopped.
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
 * - The OOXML readers (xlsx, pptx, and the auxiliary docx XML parts) are
 *   regular expressions over the XML text, never an XML engine that could
 *   resolve an entity or a DTD.
 */
import fs from 'node:fs';

export type ExtractKind = 'pdf' | 'docx' | 'xlsx' | 'pptx';
export type ExtractTruncatedReason = 'time' | 'size' | 'memory';
export type ExtractFileKind = 'overview' | 'sheet_csv' | 'formulas';

export interface ExtractJob {
  path: string;
  kind: ExtractKind;
  /** Total UTF-8 bytes allowed across all output files of this document. */
  maxOutputBytes: number;
  /** Optional character limit override (used by unit tests). */
  maxChars?: number | undefined;
  /** Optional page/sheet/slide limit override (used by unit tests). */
  maxPages?: number | undefined;
  /** Declared uncompressed bytes a zip may hold in total before it is refused unopened. */
  maxUnzippedBytes: number;
}

export interface ExtractFileOutput {
  stream: string;
  kind: ExtractFileKind;
  label: string;
  /** Suffix appended to `<landed name>`, e.g. `'.txt'` or `'.Budget.csv'`. */
  suffix: string;
  text: string;
}

export type ExtractWorkerMessage =
  | {
      type: 'chunk';
      stream: string;
      kind: ExtractFileKind;
      label: string;
      suffix: string;
      data: string;
      contentChars: number;
      pages: number;
      totalPages: number;
      stoppedAt?: string | undefined;
    }
  | {
      type: 'done';
      pages: number;
      totalPages: number;
      truncated: boolean;
      truncatedReason?: ExtractTruncatedReason | undefined;
      stoppedAt?: string | undefined;
      contentChars: number;
    }
  | { type: 'error'; error: string };

export type ExtractReply =
  | {
      ok: true;
      text: string;
      files?: ExtractFileOutput[] | undefined;
      pages: number;
      totalPages: number;
      truncated: boolean;
      truncatedReason?: ExtractTruncatedReason | undefined;
      stoppedAt?: string | undefined;
      /** Characters of document text, not counting the page and slide headings. */
      contentChars: number;
    }
  | { ok: false; error: string };

// No network, whatever a parser was going to do with it.
(globalThis as { fetch?: unknown }).fetch = () => Promise.reject(new Error('Network access is disabled while extracting text.'));

/** Truncates `value` to at most `maxBytes` of UTF-8 without splitting a code point. */
function sliceUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const buf = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  // Step back over any trailing continuation bytes (10xxxxxx) of a split character.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && buf[end - 1]! >= 0xc0) {
    const lead = buf[end - 1]!;
    const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (buf.length - (end - 1) < seqLen) end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

interface StreamMeta {
  kind: ExtractFileKind;
  label: string;
  suffix: string;
}

/**
 * Streams output chunks to the parent process over IPC while enforcing the
 * total output-bytes cap (and optional `maxChars` override) across all files
 * of the upload. Waiting for the IPC send callback after each unit of work
 * ensures the parent has already received and written earlier pages/sheets
 * if a later page triggers a timeout or RSS kill.
 */
class OutputStream {
  truncated = false;
  truncatedReason: ExtractTruncatedReason | undefined = undefined;
  stoppedAt: string | undefined = undefined;
  contentChars = 0;
  pages = 0;
  totalPages = 0;
  private totalBytes = 0;
  private totalChars = 0;
  private readonly maxOutputBytes: number;
  private readonly maxChars: number | undefined;

  constructor(job: ExtractJob) {
    this.maxOutputBytes = job.maxOutputBytes;
    this.maxChars = job.maxChars;
  }

  get full(): boolean {
    if (this.truncated) return true;
    if (this.totalBytes >= this.maxOutputBytes) return true;
    if (this.maxChars !== undefined && this.totalChars >= this.maxChars) return true;
    return false;
  }

  async push(
    stream: string,
    meta: StreamMeta,
    chunk: string,
    contentCharsDelta: number,
    stoppedAt?: string,
  ): Promise<void> {
    if (stoppedAt) this.stoppedAt = stoppedAt;
    if (this.truncated || chunk.length === 0) return;

    let piece = chunk;
    if (this.maxChars !== undefined) {
      const charRoom = this.maxChars - this.totalChars;
      if (piece.length > charRoom) {
        piece = piece.slice(0, Math.max(0, charRoom));
        this.truncated = true;
        this.truncatedReason = 'size';
      }
    }
    const byteRoom = this.maxOutputBytes - this.totalBytes;
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (pieceBytes > byteRoom) {
      piece = sliceUtf8(piece, Math.max(0, byteRoom));
      this.truncated = true;
      this.truncatedReason = 'size';
    }

    if (piece.length > 0) {
      this.totalChars += piece.length;
      this.totalBytes += Buffer.byteLength(piece, 'utf8');
      const ratio = chunk.length > 0 ? piece.length / chunk.length : 1;
      const addedContent = Math.max(contentCharsDelta > 0 ? 1 : 0, Math.round(contentCharsDelta * ratio));
      this.contentChars += addedContent;
      await sendIpc({
        type: 'chunk',
        stream,
        kind: meta.kind,
        label: meta.label,
        suffix: meta.suffix,
        data: piece,
        contentChars: addedContent,
        pages: this.pages,
        totalPages: this.totalPages,
        stoppedAt: this.stoppedAt,
      });
    } else if (this.truncated) {
      await sendIpc({
        type: 'chunk',
        stream,
        kind: meta.kind,
        label: meta.label,
        suffix: meta.suffix,
        data: '',
        contentChars: 0,
        pages: this.pages,
        totalPages: this.totalPages,
        stoppedAt: this.stoppedAt,
      });
    }
  }
}

function sendIpc(msg: ExtractWorkerMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof process.send === 'function') {
      process.send(msg, () => resolve());
    } else {
      resolve();
    }
  });
}

const MAIN_META: StreamMeta = { kind: 'overview', label: 'Extracted text', suffix: '.txt' };

// ---- PDF (PA-139 §5) ---------------------------------------------------------

interface PdfTextItem {
  str: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}

interface PdfAnnotation {
  subtype?: string;
  fieldName?: string;
  fieldValue?: unknown;
  buttonValue?: unknown;
  contents?: string;
  contentsObj?: { str?: string };
}

function renderPdfPageText(items: unknown[]): string {
  let pageText = '';
  let prevEndX: number | null = null;
  let prevTy: number | null = null;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || !('str' in raw)) continue;
    const item = raw as PdfTextItem;
    const str = item.str;
    const tr = item.transform;
    const em = tr ? Math.hypot(tr[0] ?? 0, tr[1] ?? 0) || Math.abs(tr[3] ?? 0) || 12 : 12;
    const tx = tr?.[4];
    const ty = tr?.[5];
    const width = typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : 0;

    if (prevTy !== null && ty !== undefined && Math.abs(ty - prevTy) > em * 0.5) {
      if (pageText.length > 0 && !pageText.endsWith('\n')) pageText += '\n';
      prevEndX = null;
    } else if (prevEndX !== null && tx !== undefined && str.length > 0) {
      const gap = tx - prevEndX;
      if (gap > 0.25 * em && !pageText.endsWith(' ') && !pageText.endsWith('\n') && !str.startsWith(' ')) {
        pageText += ' ';
      }
    }

    pageText += str;
    if (item.hasEOL) {
      if (!pageText.endsWith('\n')) pageText += '\n';
      prevEndX = null;
      prevTy = null;
    } else if (str.length > 0) {
      prevEndX = tx !== undefined ? tx + (width > 0 ? width : str.length * em * 0.5) : null;
      prevTy = ty ?? prevTy;
    }
  }
  return pageText.trim();
}

function renderPdfAnnotations(annotations: unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of annotations) {
    if (!raw || typeof raw !== 'object') continue;
    const ann = raw as PdfAnnotation;
    if (ann.subtype === 'Widget') {
      const name = typeof ann.fieldName === 'string' ? ann.fieldName.trim() : '';
      const rawVal = ann.fieldValue ?? ann.buttonValue;
      const val = Array.isArray(rawVal)
        ? rawVal.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ')
        : typeof rawVal === 'string' || typeof rawVal === 'number' || typeof rawVal === 'boolean'
          ? String(rawVal).trim()
          : '';
      if (val && val !== 'Off') {
        lines.push(`[Form: ${name ? `${name} = ` : ''}${val}]`);
      }
      continue;
    }
    const text =
      (typeof ann.contents === 'string' ? ann.contents : ann.contentsObj?.str ?? '').trim();
    if (text) lines.push(`[Annotation: ${text}]`);
  }
  return lines;
}

async function extractPdf(data: Uint8Array, out: OutputStream, job: ExtractJob): Promise<void> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(data, {
    disableFontFace: true,
    enableXfa: false,
    useSystemFonts: false,
    // A broken object should cost that page, not the whole document.
    stopAtErrors: false,
  });
  const totalPages = pdf.numPages;
  out.totalPages = totalPages;

  let wroteAny = false;
  try {
    const meta = await pdf.getMetadata?.();
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    const metaLines: string[] = [];
    if (typeof info.Title === 'string' && info.Title.trim()) metaLines.push(`Title: ${info.Title.trim()}`);
    if (typeof info.Author === 'string' && info.Author.trim()) metaLines.push(`Author: ${info.Author.trim()}`);
    if (metaLines.length > 0) {
      const header = metaLines.join('\n');
      await out.push('main', MAIN_META, header, header.length);
      wroteAny = true;
    }
  } catch {
    // Metadata dictionary is optional and may be malformed in hostile files.
  }

  let emptyPages = 0;
  for (let i = 1; i <= totalPages && !out.full; i++) {
    if (job.maxPages !== undefined && out.pages >= job.maxPages) {
      out.truncated = true;
      out.truncatedReason = 'size';
      break;
    }
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = renderPdfPageText(content.items);
    const annRaw = await (page as { getAnnotations?: () => Promise<unknown[]> }).getAnnotations?.().catch(() => []) ?? [];
    const annLines = renderPdfAnnotations(annRaw);
    page.cleanup();

    const parts = [pageText, ...annLines].filter(Boolean);
    const combined = parts.join('\n');
    if (combined.length === 0) emptyPages++;

    out.pages = i;
    const stopped = `page ${i} of ${totalPages}`;
    const prefix = wroteAny ? '\n\n' : '';
    wroteAny = true;
    await out.push('main', MAIN_META, `${prefix}--- Page ${i} ---\n${combined}`, combined.length, stopped);
  }

  if (!out.full && out.contentChars > 0 && emptyPages > 0 && emptyPages < out.pages) {
    const scanNote = `\n\n[Note: ${emptyPages} of ${totalPages} pages had no text layer (they may be scanned images).]`;
    await out.push('main', MAIN_META, scanNote, 0);
  }

  // Not every pdf.js build exposes the same teardown; the worker is
  // terminated right after this reply either way.
  await (pdf as { destroy?: () => Promise<void> }).destroy?.();
}

// ---- Zip containers (docx, xlsx, pptx) ---------------------------------------

/**
 * Reads a zip's central directory and refuses it before inflating anything if
 * the declared sizes add up to more than the cap — the cheap half of the zip
 * bomb defence. The other half is the worker's RSS cap, because a declared
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

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** XML/HTML text content → string. Numeric references and predefined entities
    only; anything else stays as written, since there is no DTD. */
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

/** Text of every `<tag>`-like run inside `xml`, in order. */
function runs(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let text = '';
  for (const m of xml.matchAll(re)) text += decodeXml(m[1] ?? '');
  return text;
}

function byNumber(a: string, b: string): number {
  return Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
}

// ---- DOCX (PA-139 §3) --------------------------------------------------------

const SAFE_LINK_HREF = /^(?:https?:\/\/|mailto:|#)[^\s<>]*$/i;

/**
 * Converts inline HTML from Mammoth into Markdown using an emit-only allowlist
 * (the same posture as `telegram/format.ts`): plain-text runs are entity-decoded
 * only after tags are split out, and only allowlisted tags (`strong`/`b`,
 * `em`/`i`, `code`, `sup`, `br`, `a` with safe href) produce Markdown syntax.
 */
function mammothInlineToMarkdown(html: string): string {
  const tagRe = /<(\/?)([a-zA-Z0-9]+)(?:\s([^>]*))?>/g;
  let out = '';
  let lastIndex = 0;
  let linkHref: string | null = null;
  let linkText = '';
  let inLink = false;

  const appendText = (s: string): void => {
    if (inLink) linkText += s;
    else out += s;
  };

  for (const m of html.matchAll(tagRe)) {
    const idx = m.index ?? 0;
    if (idx > lastIndex) {
      appendText(decodeXml(html.slice(lastIndex, idx)));
    }
    lastIndex = idx + m[0].length;
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase();
    const attrs = m[3] ?? '';

    if (tag === 'br' && !closing) {
      appendText('\n');
    } else if (tag === 'strong' || tag === 'b') {
      appendText('**');
    } else if (tag === 'em' || tag === 'i') {
      appendText('*');
    } else if (tag === 'code') {
      appendText('`');
    } else if (tag === 'sup') {
      appendText(closing ? '' : '^');
    } else if (tag === 'a') {
      if (!closing) {
        const rawHref = decodeXml(/\bhref="([^"]*)"/i.exec(attrs)?.[1] ?? '').trim();
        inLink = true;
        linkHref = rawHref;
        linkText = '';
      } else if (inLink) {
        inLink = false;
        const label = linkText.trim() || (linkHref ?? '');
        if (linkHref && SAFE_LINK_HREF.test(linkHref)) {
          out += `[${label}](${linkHref})`;
        } else {
          out += label;
        }
        linkHref = null;
        linkText = '';
      }
    }
  }
  if (lastIndex < html.length) {
    appendText(decodeXml(html.slice(lastIndex)));
  }
  if (inLink) out += linkText;
  return out;
}

function renderHtmlTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  for (const tr of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] ?? '').matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)) {
      const cellMd = mammothInlineToMarkdown(
        (td[1] ?? '').replace(/<\/p>\s*<p\b[^>]*>/gi, ' ').replace(/<\/?p\b[^>]*>/gi, ''),
      )
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
      cells.push(cellMd);
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const formatRow = (r: string[]) => `| ${Array.from({ length: cols }, (_, c) => r[c] ?? '').join(' | ')} |`;
  const sep = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
  return [formatRow(rows[0]!), sep, ...rows.slice(1).map(formatRow)].join('\n');
}

function renderHtmlListToMarkdown(listHtml: string): string {
  const tokenRe = /<(\/?)(ul|ol|li)\b[^>]*>/gi;
  const stack: Array<{ kind: 'ul' | 'ol'; count: number }> = [];
  const lines: string[] = [];
  let lastIndex = 0;
  let currentItem = '';
  let inItem = false;

  const flushItem = (): void => {
    const text = mammothInlineToMarkdown(currentItem.replace(/<\/?p\b[^>]*>/gi, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    currentItem = '';
    if (!text) return;
    const depth = Math.max(0, stack.length - 1);
    const top = stack[stack.length - 1];
    const marker = top?.kind === 'ol' ? `${top.count}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
  };

  for (const m of listHtml.matchAll(tokenRe)) {
    const idx = m.index ?? 0;
    if (inItem && idx > lastIndex) {
      currentItem += listHtml.slice(lastIndex, idx);
    }
    lastIndex = idx + m[0].length;
    const closing = m[1] === '/';
    const tag = (m[2] ?? '').toLowerCase() as 'ul' | 'ol' | 'li';
    if (tag === 'ul' || tag === 'ol') {
      if (!closing) {
        if (inItem && currentItem.trim()) flushItem();
        stack.push({ kind: tag, count: 0 });
      } else {
        stack.pop();
      }
    } else if (tag === 'li') {
      if (!closing) {
        if (inItem && currentItem.trim()) flushItem();
        const top = stack[stack.length - 1];
        if (top) top.count++;
        inItem = true;
        currentItem = '';
      } else {
        if (inItem) flushItem();
        inItem = false;
      }
    }
  }
  if (inItem && currentItem.trim()) flushItem();
  return lines.join('\n');
}

/**
 * Converts Mammoth's HTML output into Markdown using an emit-only allowlist of
 * structural blocks (`h1`–`h6`, `table`, `ul`/`ol`/`li`, `blockquote`, `pre`, `p`).
 */
function mammothHtmlToMarkdown(html: string): string {
  // Replace tables and top-level lists first, then process headings/paragraphs.
  const blocks: string[] = [];
  const blockRe =
    /<(table|ul|ol|blockquote|pre|h[1-6]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let matchedAny = false;
  for (const m of html.matchAll(blockRe)) {
    matchedAny = true;
    const tag = (m[1] ?? '').toLowerCase();
    const inner = m[2] ?? '';
    if (tag === 'table') {
      const tbl = renderHtmlTableToMarkdown(m[0]);
      if (tbl) blocks.push(tbl);
    } else if (tag === 'ul' || tag === 'ol') {
      const list = renderHtmlListToMarkdown(m[0]);
      if (list) blocks.push(list);
    } else if (tag.startsWith('h')) {
      const level = Number(tag.slice(1)) || 1;
      const text = mammothInlineToMarkdown(inner).replace(/\s+/g, ' ').trim();
      if (text) blocks.push(`${'#'.repeat(level)} ${text}`);
    } else if (tag === 'blockquote') {
      const text = mammothInlineToMarkdown(inner).trim();
      if (text) blocks.push(text.split('\n').map((l) => `> ${l}`).join('\n'));
    } else if (tag === 'pre') {
      const code = decodeXml(inner.replace(/<\/?code\b[^>]*>/gi, '')).trimEnd();
      if (code) blocks.push(`\`\`\`\n${code}\n\`\`\``);
    } else {
      const text = mammothInlineToMarkdown(inner).trim();
      if (text) blocks.push(text);
    }
  }
  if (!matchedAny) {
    return mammothInlineToMarkdown(html).replace(/\n{3,}/g, '\n\n').trim();
  }
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractWordParagraphs(xml: string): string[] {
  const out: string[] = [];
  for (const p of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const text = runs(p[1] ?? '', 'w:t').trim();
    if (text) out.push(text);
  }
  return out;
}

async function extractDocx(data: Uint8Array, out: OutputStream, job: ExtractJob): Promise<void> {
  // Sized up front for zip-bomb defence, and read auxiliary XML parts Mammoth skips.
  const files = await readZip(
    data,
    job,
    (name) =>
      name === 'word/document.xml' ||
      name === 'word/comments.xml' ||
      /^word\/header\d*\.xml$/.test(name) ||
      /^word\/footer\d*\.xml$/.test(name),
  );
  const mammoth = (await import('mammoth')).default;
  const htmlResult = await mammoth.convertToHtml({
    buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
  });
  let bodyMd = mammothHtmlToMarkdown(htmlResult.value);
  if (!bodyMd) {
    const rawResult = await mammoth.extractRawText({
      buffer: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    });
    bodyMd = rawResult.value.replace(/\n{3,}/g, '\n\n').trim();
  }

  const sections: string[] = [];

  // Headers (`word/header*.xml`)
  const headers: string[] = [];
  const seenHeaders = new Set<string>();
  for (const name of Object.keys(files).filter((n) => /^word\/header\d*\.xml$/.test(n)).sort(byNumber)) {
    for (const line of extractWordParagraphs(utf8(files[name]))) {
      if (!seenHeaders.has(line)) {
        seenHeaders.add(line);
        headers.push(line);
      }
    }
  }
  if (headers.length > 0) sections.push(`## Headers\n${headers.join('\n')}`);

  if (bodyMd) sections.push(bodyMd);

  // Footers (`word/footer*.xml`)
  const footers: string[] = [];
  const seenFooters = new Set<string>();
  for (const name of Object.keys(files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).sort(byNumber)) {
    for (const line of extractWordParagraphs(utf8(files[name]))) {
      if (!seenFooters.has(line)) {
        seenFooters.add(line);
        footers.push(line);
      }
    }
  }
  if (footers.length > 0) sections.push(`## Footers\n${footers.join('\n')}`);

  // Tracked changes (`<w:ins>` and `<w:del>` in `word/document.xml`)
  const docXml = utf8(files['word/document.xml']);
  const changes: string[] = [];
  for (const ins of docXml.matchAll(/<w:ins\b([^>]*)>([\s\S]*?)<\/w:ins>/g)) {
    const author = decodeXml(/\bw:author="([^"]*)"/.exec(ins[1] ?? '')?.[1] ?? '').trim();
    const text = runs(ins[2] ?? '', 'w:t').trim();
    if (text) changes.push(`- [Inserted${author ? ` by ${author}` : ''}]: ${text}`);
  }
  for (const del of docXml.matchAll(/<w:del\b([^>]*)>([\s\S]*?)<\/w:del>/g)) {
    const author = decodeXml(/\bw:author="([^"]*)"/.exec(del[1] ?? '')?.[1] ?? '').trim();
    const text = runs(del[2] ?? '', 'w:delText').trim();
    if (text) changes.push(`- [Deleted${author ? ` by ${author}` : ''}]: ${text}`);
  }
  if (changes.length > 0) sections.push(`## Tracked Changes\n${changes.join('\n')}`);

  // Comments (`word/comments.xml`)
  const commentsXml = utf8(files['word/comments.xml']);
  const comments: string[] = [];
  for (const c of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const author = decodeXml(/\bw:author="([^"]*)"/.exec(c[1] ?? '')?.[1] ?? '').trim();
    const text = extractWordParagraphs(c[2] ?? '').join(' ').trim();
    if (text) comments.push(`- ${author ? `${author}: ` : ''}${text}`);
  }
  if (comments.length > 0) sections.push(`## Comments\n${comments.join('\n')}`);

  const fullText = sections.join('\n\n').trim();
  out.pages = 1;
  out.totalPages = 1;
  await out.push('main', MAIN_META, fullText, fullText.length, 'section 1 of 1');
}

// ---- XLSX (PA-139 §2) --------------------------------------------------------

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

/** Zero-based column index → Excel column letters (`0` → `A`, `26` → `AA`). */
function columnLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** PA-139: raised from 512 to Excel's own 16,384-column (`XFD`) limit; output-bytes cap bounds total size. */
const MAX_COLUMNS = 16_384;
/** Maximum consecutive blank lines emitted for an empty row gap in one sheet. */
const MAX_EMPTY_ROW_GAP = 5_000;

type XlsxNumberStyle =
  | { kind: 'general' }
  | { kind: 'date' }
  | { kind: 'datetime' }
  | { kind: 'time' }
  | { kind: 'percent'; decimals: number }
  | { kind: 'currency'; symbol: string; decimals: number };

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 32, 33, 34, 35, 45, 46, 47]);
const BUILTIN_CURRENCY_IDS = new Set([5, 6, 7, 8, 37, 38, 39, 40, 41, 42, 43, 44]);

function classifyNumberFormat(numFmtId: number, formatCode: string | undefined): XlsxNumberStyle {
  if (BUILTIN_DATE_IDS.has(numFmtId)) return { kind: 'date' };
  if (numFmtId === 22) return { kind: 'datetime' };
  if (BUILTIN_TIME_IDS.has(numFmtId)) return { kind: 'time' };
  if (numFmtId === 9) return { kind: 'percent', decimals: 0 };
  if (numFmtId === 10) return { kind: 'percent', decimals: 2 };
  if (BUILTIN_CURRENCY_IDS.has(numFmtId)) {
    return { kind: 'currency', symbol: '$', decimals: numFmtId === 5 || numFmtId === 6 || numFmtId === 37 || numFmtId === 38 ? 0 : 2 };
  }
  if (!formatCode) return { kind: 'general' };

  // Inspect first format section, stripping quoted literals and escapes.
  let bracketCurrency: string | null = null;
  const cleaned = (formatCode.split(';')[0] ?? '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
      if (inner.startsWith('$') && inner.length > 1) {
        const sym = inner.slice(1).split('-')[0] ?? '';
        if (sym) bracketCurrency = sym;
      }
      return '';
    });

  if (cleaned.includes('%')) {
    const decMatch = /\.(0+)/.exec(cleaned);
    return { kind: 'percent', decimals: decMatch ? decMatch[1]!.length : 0 };
  }

  const hasDate = /[yYdD]/.test(cleaned) || (/m+/i.test(cleaned) && !/[#0]/.test(cleaned));
  const hasTime = /[hHsS]/.test(cleaned);
  if ((hasDate || hasTime) && !/[#]/.test(cleaned)) {
    if (hasDate && hasTime) return { kind: 'datetime' };
    if (hasTime) return { kind: 'time' };
    return { kind: 'date' };
  }

  const currencySymbol = bracketCurrency ?? (/([$€£¥])/.exec(cleaned)?.[1] ?? null);
  if (currencySymbol) {
    const decMatch = /\.(0+)/.exec(cleaned);
    return { kind: 'currency', symbol: currencySymbol, decimals: decMatch ? decMatch[1]!.length : 0 };
  }

  return { kind: 'general' };
}

function parseXlsxStyles(stylesXml: string): XlsxNumberStyle[] {
  if (!stylesXml) return [];
  const customFmts = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    const code = decodeXml(/\bformatCode="([^"]*)"/.exec(attrs)?.[1] ?? '');
    if (Number.isFinite(id) && code) customFmts.set(id, code);
  }
  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const styles: XlsxNumberStyle[] = [];
  for (const m of cellXfsBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const attrs = m[1] ?? '';
    const numFmtId = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0);
    styles.push(classifyNumberFormat(numFmtId, customFmts.get(numFmtId)));
  }
  return styles;
}

function formatExcelDate(serial: number, kind: 'date' | 'datetime' | 'time', date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  if (kind === 'time') {
    const frac = ((serial % 1) + 1) % 1;
    const totalSec = Math.round(frac * 86_400) % 86_400;
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }
  // Excel 1900 epoch has the Lotus 1-2-3 leap-year bug at serial 60 (1900-02-29).
  const epochOffset = date1904 ? 24_107 : serial >= 60 ? 25_569 : 25_568;
  const totalSeconds = Math.round((serial - epochOffset) * 86_400);
  const d = new Date(totalSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const datePart = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const daySec = ((totalSeconds % 86_400) + 86_400) % 86_400;
  if (kind === 'datetime' || daySec !== 0) {
    const hh = Math.floor(daySec / 3600);
    const mm = Math.floor((daySec % 3600) / 60);
    const ss = daySec % 60;
    return `${datePart}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }
  return datePart;
}

function formatXlsxNumber(raw: string, style: XlsxNumberStyle | undefined, date1904: boolean): string {
  if (!style || style.kind === 'general' || raw === '') return raw;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (style.kind === 'date' || style.kind === 'datetime' || style.kind === 'time') {
    return formatExcelDate(num, style.kind, date1904) ?? raw;
  }
  if (style.kind === 'percent') {
    const scaled = num * 100;
    const formatted = style.decimals > 0 ? scaled.toFixed(style.decimals) : String(Math.round(scaled * 1e6) / 1e6);
    return `${formatted}%`;
  }
  if (style.kind === 'currency') {
    const sign = num < 0 ? '-' : '';
    const abs = Math.abs(num);
    const formatted = style.decimals > 0 ? abs.toFixed(style.decimals) : String(Math.round(abs));
    return `${sign}${style.symbol}${formatted}`;
  }
  return raw;
}

function safeSheetFilePart(name: string, index: number, used: Set<string>): string {
  const cleaned =
    name
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || `Sheet${index + 1}`;
  let candidate = cleaned;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${cleaned}_${n++}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function parseWorksheetComments(
  sheetFile: string,
  files: Record<string, Uint8Array>,
): Array<{ ref: string; author?: string | undefined; text: string }> {
  const m = /^xl\/worksheets\/(sheet\d+\.xml)$/.exec(sheetFile);
  if (!m) return [];
  const relsXml = utf8(files[`xl/worksheets/_rels/${m[1]}.rels`]);
  const commentTargets: string[] = [];
  for (const rel of relsXml.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const target = /\bTarget="([^"]*)"/.exec(rel[1] ?? '')?.[1] ?? '';
    if (/comments\d*\.xml$|threadedComment\d*\.xml$/i.test(target)) {
      const normalized = target.replace(/^(?:\.\.\/)+/, 'xl/').replace(/^\/?(xl\/)?/, 'xl/');
      commentTargets.push(normalized);
    }
  }
  if (commentTargets.length === 0) {
    const num = /sheet(\d+)\.xml$/.exec(sheetFile)?.[1];
    if (num && files[`xl/comments${num}.xml`]) commentTargets.push(`xl/comments${num}.xml`);
  }

  const out: Array<{ ref: string; author?: string | undefined; text: string }> = [];
  for (const target of commentTargets) {
    const xml = utf8(files[target]);
    if (!xml) continue;
    const authors: string[] = [];
    for (const a of xml.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)) {
      authors.push(decodeXml(a[1] ?? '').trim());
    }
    for (const c of xml.matchAll(/<(?:comment|threadedComment)\b([^>]*)>([\s\S]*?)<\/(?:comment|threadedComment)>/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /\bref="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const authorId = /\bauthorId="(\d+)"/.exec(attrs)?.[1];
      const author = authorId !== undefined ? authors[Number(authorId)] : undefined;
      const text = runs(body.replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't').trim();
      if (ref && text) out.push({ ref, ...(author ? { author } : {}), text });
    }
  }
  return out;
}

async function extractXlsx(data: Uint8Array, out: OutputStream, job: ExtractJob): Promise<void> {
  const files = await readZip(
    data,
    job,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/styles.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name) ||
      /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name) ||
      /^xl\/comments\d*\.xml$/.test(name) ||
      /^xl\/threadedComments\/threadedComment\d*\.xml$/.test(name),
  );

  const shared: string[] = [];
  for (const m of utf8(files['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    // Phonetic guides (`rPh`) repeat the text in another script; skip them.
    shared.push(runs((m[1] ?? '').replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't'));
  }

  const workbookXml = utf8(files['xl/workbook.xml']);
  const date1904 = /<workbookPr\b[^>]*?\bdate1904="(?:1|true)"/i.test(workbookXml);
  const styles = parseXlsxStyles(utf8(files['xl/styles.xml']));

  // Sheet order, names and hidden flags come from the workbook; the file for each, from its rels.
  const rels = new Map<string, string>();
  for (const m of utf8(files['xl/_rels/workbook.xml.rels']).matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const sheets: Array<{ name: string; file: string; hidden: boolean }> = [];
  for (const m of workbookXml.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Sheet${sheets.length + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const state = /\bstate="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const hidden = state === 'hidden' || state === 'veryHidden';
    const file = rels.get(rid) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, file, hidden });
  }
  if (sheets.length === 0) {
    for (const name of Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber)) {
      sheets.push({ name: name.replace(/^.*\/|\.xml$/g, ''), file: name, hidden: false });
    }
  }

  out.totalPages = sheets.length;
  const usedSheetSuffixes = new Set<string>();
  let done = 0;

  for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
    const sheet = sheets[sheetIdx]!;
    if (out.full) break;
    if (job.maxPages !== undefined && done >= job.maxPages) {
      out.truncated = true;
      out.truncatedReason = 'size';
      break;
    }

    const xml = utf8(files[sheet.file]);
    const safePart = safeSheetFilePart(sheet.name, sheetIdx, usedSheetSuffixes);
    const csvSuffix = `.${safePart}.csv`;
    const sheetStream = `sheet:${sheetIdx}`;
    const sheetMeta: StreamMeta = { kind: 'sheet_csv', label: sheet.name, suffix: csvSuffix };

    const merges: string[] = [];
    for (const mc of xml.matchAll(/<mergeCell\b[^>]*?\bref="([^"]+)"/g)) {
      if (mc[1]) merges.push(mc[1]);
    }
    const comments = parseWorksheetComments(sheet.file, files);
    const formulas: Array<{ ref: string; formula: string; cached: string }> = [];

    const headerLines: string[] = [
      `${done > 0 ? '\n' : ''}## Sheet: ${sheet.name}${sheet.hidden ? ' [hidden]' : ''}`,
    ];
    if (merges.length > 0) headerLines.push(`Merged ranges: ${merges.join(', ')}`);
    if (comments.length > 0) {
      for (const c of comments) {
        headerLines.push(`Comment ${c.ref}${c.author ? ` (${c.author})` : ''}: ${c.text}`);
      }
    }
    await out.push(
      'main',
      MAIN_META,
      `${headerLines.join('\n')}\n`,
      comments.reduce((n, c) => n + c.text.length, 0) + merges.join('').length,
      `sheet ${sheetIdx + 1} of ${sheets.length} (${sheet.name})`,
    );

    let lastRowNum = 0;
    let csvWroteAny = false;
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      if (out.full) break;
      const rowAttrs = row[1] ?? '';
      const rowBody = row[2] ?? '';
      const declaredRow = Number(/\br="(\d+)"/.exec(rowAttrs)?.[1] ?? 0);
      const rowNum = declaredRow > lastRowNum ? declaredRow : lastRowNum + 1;

      // Preserve row positions: emit blank lines for skipped empty rows.
      if (rowNum > lastRowNum + 1) {
        const gap = Math.min(rowNum - lastRowNum - 1, MAX_EMPTY_ROW_GAP);
        const blanks = '\n'.repeat(gap);
        await out.push(sheetStream, sheetMeta, blanks, 0, `sheet ${sheetIdx + 1} of ${sheets.length}, row ${rowNum}`);
        await out.push('main', MAIN_META, blanks, 0, `sheet ${sheetIdx + 1} of ${sheets.length}, row ${rowNum}`);
      }
      lastRowNum = rowNum;

      const cells: string[] = [];
      for (const c of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const fullRef = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const colLetters = fullRef ? /^[A-Z]+/.exec(fullRef)?.[0] : undefined;
        const col = colLetters ? columnIndex(colLetters) : cells.length;
        if (col < 0 || col >= MAX_COLUMNS) continue;
        const cellRef = fullRef ?? `${columnLetters(col)}${rowNum}`;
        const type = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? 'n';
        const styleIdx = /\bs="(\d+)"/.exec(attrs)?.[1];
        const style = styleIdx !== undefined ? styles[Number(styleIdx)] : undefined;
        const formulaMatch = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body);
        const formula = formulaMatch ? decodeXml(formulaMatch[1] ?? '').trim() : '';

        let value: string;
        if (type === 'inlineStr') {
          value = runs(body, 't');
        } else {
          const v = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v;
          else if (type === 'n') value = formatXlsxNumber(v, style, date1904);
          else value = v;
        }

        if (formula) {
          formulas.push({ ref: cellRef, formula, cached: value });
          if (value === '') value = `=${formula}`;
        }

        while (cells.length < col) cells.push('');
        cells[col] = csvCell(value);
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      const line = cells.join(',');
      const lineChars = line.replace(/,/g, '').length;
      const stopped = `sheet ${sheetIdx + 1} of ${sheets.length}, row ${rowNum}`;
      await out.push(sheetStream, sheetMeta, `${line}\n`, lineChars, stopped);
      await out.push('main', MAIN_META, `${line}\n`, 0, stopped);
      csvWroteAny = true;
    }

    if (!csvWroteAny && !out.full) {
      await out.push(sheetStream, sheetMeta, '\n', 0, `sheet ${sheetIdx + 1} of ${sheets.length}`);
    }

    if (formulas.length > 0 && !out.full) {
      const formulaLines = formulas.map(
        (f) => `Formula ${f.ref}: =${f.formula}${f.cached && f.cached !== `=${f.formula}` ? ` (cached: ${f.cached})` : ''}`,
      );
      const block = `${formulaLines.join('\n')}\n`;
      await out.push('main', MAIN_META, block, block.length, `sheet ${sheetIdx + 1} of ${sheets.length}`);
    }

    done++;
    out.pages = done;
  }
}

// ---- PPTX (PA-139 §4) --------------------------------------------------------

function extractPptxSlideBody(xml: string): string {
  const blocks: string[] = [];
  // Match either an entire `<a:tbl>` or a standalone `<a:p ...>` in document order.
  const tokenRe = /(<a:tbl\b[^>]*>[\s\S]*?<\/a:tbl>)|(<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>)/g;
  for (const m of xml.matchAll(tokenRe)) {
    if (m[1]) {
      const tblXml = m[1];
      const rows: string[] = [];
      for (const tr of tblXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
        const cells: string[] = [];
        for (const tc of (tr[1] ?? '').matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)) {
          const cellParas: string[] = [];
          for (const p of (tc[1] ?? '').matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
            const t = runs(p[1] ?? '', 'a:t').trim();
            if (t) cellParas.push(t);
          }
          cells.push(cellParas.join(' ').replace(/\|/g, '\\|'));
        }
        if (cells.length > 0) rows.push(`| ${cells.join(' | ')} |`);
      }
      if (rows.length > 0) blocks.push(rows.join('\n'));
    } else {
      const text = runs(m[3] ?? '', 'a:t').trim();
      if (text) blocks.push(text);
    }
  }
  return blocks.join('\n');
}

function extractPptxNotes(notesXml: string): string {
  if (!notesXml) return '';
  const paras: string[] = [];
  const shapes = [...notesXml.matchAll(/<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/g)];
  const sources =
    shapes.length > 0
      ? shapes
          .map((s) => s[1] ?? '')
          .filter((s) => !/<p:ph\b[^>]*?\btype="(?:sldNum|hdr|ftr|dt)"/i.test(s))
      : [notesXml];
  for (const src of sources) {
    for (const p of src.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g)) {
      const text = runs(p[1] ?? '', 'a:t').trim();
      if (text) paras.push(text);
    }
  }
  return paras.join('\n');
}

function extractPptxChart(chartXml: string): string {
  if (!chartXml) return '';
  const titleMatch = /<c:title\b[^>]*>([\s\S]*?)<\/c:title>/.exec(chartXml);
  const title = titleMatch ? (runs(titleMatch[1] ?? '', 'a:t') || runs(titleMatch[1] ?? '', 'c:v')).trim() : '';
  const labels: string[] = [];
  for (const ser of chartXml.matchAll(/<c:ser\b[^>]*>([\s\S]*?)<\/c:ser>/g)) {
    const tx = /<c:tx\b[^>]*>([\s\S]*?)<\/c:tx>/.exec(ser[1] ?? '');
    if (tx) {
      const name = (runs(tx[1] ?? '', 'c:v') || runs(tx[1] ?? '', 'a:t')).trim();
      if (name) labels.push(name);
    }
  }
  if (labels.length === 0) {
    for (const pt of chartXml.matchAll(/<c:strCache\b[^>]*>([\s\S]*?)<\/c:strCache>/g)) {
      for (const v of (pt[1] ?? '').matchAll(/<c:v\b[^>]*>([\s\S]*?)<\/c:v>/g)) {
        const val = decodeXml(v[1] ?? '').trim();
        if (val && !labels.includes(val)) labels.push(val);
      }
    }
  }
  if (!title && labels.length === 0) return '';
  return `Chart${title ? `: ${title}` : ''}${labels.length > 0 ? ` (${labels.join(', ')})` : ''}`;
}

async function extractPptx(data: Uint8Array, out: OutputStream, job: ExtractJob): Promise<void> {
  const files = await readZip(
    data,
    job,
    (name) =>
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels' ||
      /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name) ||
      /^ppt\/charts\/chart\d+\.xml$/.test(name),
  );

  // Slide order from `ppt/presentation.xml` `<p:sldIdLst>` + `ppt/_rels/presentation.xml.rels`.
  const presRels = new Map<string, string>();
  for (const m of utf8(files['ppt/_rels/presentation.xml.rels']).matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    if (id && target) presRels.set(id, target.replace(/^\/?(ppt\/)?/, 'ppt/'));
  }
  const orderedSlides: string[] = [];
  const sldIdLst = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(utf8(files['ppt/presentation.xml']))?.[1] ?? '';
  for (const m of sldIdLst.matchAll(/<p:sldId\b([^>]*?)\/?>/g)) {
    const rid = /\br:id="([^"]*)"/.exec(m[1] ?? '')?.[1] ?? '';
    const target = presRels.get(rid);
    if (target && files[target]) orderedSlides.push(target);
  }
  const names =
    orderedSlides.length > 0
      ? orderedSlides
      : Object.keys(files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);

  out.totalPages = names.length;
  let done = 0;
  for (const name of names) {
    if (out.full) break;
    if (job.maxPages !== undefined && done >= job.maxPages) {
      out.truncated = true;
      out.truncatedReason = 'size';
      break;
    }
    const xml = utf8(files[name]);
    const hidden = /<p:sld\b[^>]*?\bshow="(?:0|false)"/i.test(xml);
    const body = extractPptxSlideBody(xml);

    // Follow slide relationships for speaker notes and charts.
    const slideBase = name.split('/').pop() ?? '';
    const slideRelsXml = utf8(files[`ppt/slides/_rels/${slideBase}.rels`]);
    const notesTargets: string[] = [];
    const chartTargets: string[] = [];
    for (const rel of slideRelsXml.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
      const target = /\bTarget="([^"]*)"/.exec(rel[1] ?? '')?.[1] ?? '';
      const normalized = target.replace(/^(?:\.\.\/)+/, 'ppt/').replace(/^\/?(ppt\/)?/, 'ppt/');
      if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(normalized)) notesTargets.push(normalized);
      else if (/^ppt\/charts\/chart\d+\.xml$/.test(normalized)) chartTargets.push(normalized);
    }
    if (notesTargets.length === 0) {
      const num = /slide(\d+)\.xml$/.exec(slideBase)?.[1];
      if (num && files[`ppt/notesSlides/notesSlide${num}.xml`]) {
        notesTargets.push(`ppt/notesSlides/notesSlide${num}.xml`);
      }
    }

    const parts: string[] = [];
    if (body) parts.push(body);
    for (const ct of chartTargets) {
      const chartText = extractPptxChart(utf8(files[ct]));
      if (chartText) parts.push(chartText);
    }
    for (const nt of notesTargets) {
      const notesText = extractPptxNotes(utf8(files[nt]));
      if (notesText) parts.push(`Notes:\n${notesText}`);
    }

    done++;
    out.pages = done;
    const slideContent = parts.join('\n');
    const heading = `--- Slide ${done}${hidden ? ' [hidden]' : ''} ---`;
    const stopped = `slide ${done} of ${names.length}`;
    await out.push(
      'main',
      MAIN_META,
      `${done > 1 ? '\n\n' : ''}${heading}\n${slideContent}`,
      slideContent.length,
      stopped,
    );
  }
}

// ---- Entry -------------------------------------------------------------------

async function run(job: ExtractJob): Promise<void> {
  const data = new Uint8Array(fs.readFileSync(job.path));
  const out = new OutputStream(job);
  switch (job.kind) {
    case 'pdf':
      await extractPdf(data, out, job);
      break;
    case 'docx':
      await extractDocx(data, out, job);
      break;
    case 'xlsx':
      await extractXlsx(data, out, job);
      break;
    case 'pptx':
      await extractPptx(data, out, job);
      break;
    default:
      await sendIpc({ type: 'error', error: 'Unsupported document type.' });
      return;
  }
  await sendIpc({
    type: 'done',
    pages: out.pages,
    totalPages: out.totalPages,
    truncated: out.truncated || out.pages < out.totalPages,
    truncatedReason: out.truncatedReason,
    stoppedAt: out.stoppedAt,
    contentChars: out.contentChars,
  });
}

// One job per process: the parent sends it, this streams chunks and exits.
if (typeof process.send === 'function') {
  process.once('message', (job: ExtractJob) => {
    run(job).then(
      () => process.exit(0),
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void sendIpc({ type: 'error', error: message.slice(0, 200) }).then(() => process.exit(0));
      },
    );
  });
  // The parent going away (a server shutdown mid-parse) ends this too.
  process.once('disconnect', () => process.exit(0));
}
