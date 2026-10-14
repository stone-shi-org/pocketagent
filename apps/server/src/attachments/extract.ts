import { execFile, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExtractedAttachmentFile, PromptAttachment } from '@pocketagent/protocol';
import { openExclusiveAttachment, type LandingTarget } from './index.js';
import type {
  ExtractFileKind,
  ExtractFileOutput,
  ExtractJob,
  ExtractKind,
  ExtractReply,
  ExtractTruncatedReason,
  ExtractWorkerMessage,
} from './extract-worker.js';

/**
 * PA-137 / PA-139: what happens to an attached file right after it lands.
 *
 * Two judgements, both made once and recorded on the `PromptAttachment`:
 *
 * - **Is it text?** (`text: true`) A UTF-8 file of a text type — Markdown,
 *   CSV, JSON, source code. A Pocket Agent may then put a small one straight
 *   into the message (`inline.ts`). Judged here rather than at context time
 *   so the per-turn path reads metadata, not bytes, until it actually
 *   inlines something.
 * - **Can its text be extracted?** A PDF, docx, xlsx or pptx gets a sidecar,
 *   `<landed name>.txt`, beside it (plus one `<landed name>.<Sheet>.csv` per
 *   worksheet for an xlsx, PA-139). That is what removes the dead end PA-136
 *   left: `read_file` refuses binaries and the image has no `pdftotext`, so a
 *   Pocket Agent could not read a PDF at all. The sidecars are plain text, so
 *   `read_file` pages through them with no shell and no approval.
 *
 * The document is a stranger's file, so the parse runs in a child process
 * with a CPU timeout, a memory cap and an output-bytes cap, streaming chunks
 * over IPC as each page, sheet or slide completes. If a cap stops the parse
 * partway through, the chunks already written stay on disk as a partial
 * extract and `truncatedReason` / `stoppedAt` record why and where it stopped.
 * See `extract-worker.ts` for what the parse may not do (fetch, eval).
 */

/** How long one document may take to parse (PA-139: raised from 10 s to 60 s; partial extracts are kept on timeout). */
export const EXTRACT_TIMEOUT_MS = 60_000;
/** V8 heap the parse may use, in MB. */
export const EXTRACT_MAX_HEAP_MB = 256;
/**
 * Resident memory the parse may reach, in MB, typed arrays included — the
 * cap that matters, since decompression happens outside the V8 heap. A 20 MB
 * PDF needs well under it; a decompression bomb reaches it and is killed.
 */
export const EXTRACT_MAX_RSS_MB = 768;
/**
 * Total UTF-8 bytes allowed across all extracted files of one upload (PA-139:
 * replaces the 500k-char and 200-page caps; `read_file` pages, so a large
 * extract costs disk rather than context).
 */
export const EXTRACT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** Declared uncompressed size a docx/xlsx/pptx may unpack to before it is refused unopened. */
export const EXTRACT_MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;
/** Parses that may run at once, so five PDFs in one message do not start five processes. */
const MAX_CONCURRENT_EXTRACTIONS = 2;

// ---- What a file is ----------------------------------------------------------

const execFileAsync = promisify(execFile);

const DOCUMENT_TYPES: Record<string, ExtractKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
const DOCUMENT_EXTENSIONS: Record<string, ExtractKind> = { '.pdf': 'pdf', '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };

/**
 * Which extractor a file goes to, or `null`. The name or the declared type
 * proposes a kind; the file's own first bytes must agree (`%PDF-`, or a zip's
 * `PK\3\4`), because both of the others are whatever the uploader said.
 */
export function documentKindFor(name: string, mediaType: string, head: Buffer): ExtractKind | null {
  const kind = DOCUMENT_EXTENSIONS[path.extname(name).toLowerCase()] ?? DOCUMENT_TYPES[mediaType] ?? null;
  if (!kind) return null;
  if (kind === 'pdf') return head.subarray(0, 1024).includes('%PDF-') ? 'pdf' : null;
  return head.length >= 4 && head.readUInt32BE(0) === 0x504b0304 ? kind : null;
}

const TEXT_EXTENSIONS = new Set(
  (
    'md markdown mdx txt text rst adoc org tex csv tsv psv json jsonl ndjson json5 yaml yml toml ini cfg conf ' +
    'properties env xml html htm xhtml svg css scss sass less js mjs cjs ts mts cts jsx tsx vue svelte astro py pyi ' +
    'rb go rs java kt kts scala groovy gradle c h cc cpp cxx hpp hh cs fs swift m mm php pl pm lua r jl dart ex exs ' +
    'erl hs clj elm ml zig nim v sh bash zsh fish ps1 bat cmd sql graphql gql proto thrift tf hcl nix dockerfile ' +
    'makefile mk cmake diff patch log srt vtt ics vcf bib'
  ).split(' '),
);
const TEXT_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/sql',
  'application/x-ndjson',
]);

/** How much of a file is read to decide it is UTF-8 text. */
const TEXT_SNIFF_BYTES = 64 * 1024;

/**
 * A text type by name or declared type, *and* bytes that decode as UTF-8 with
 * no NUL in the first 64 KB. The type alone is a claim; a `.csv` that is
 * really UTF-16 or a renamed binary would inline as noise.
 */
export function isTextAttachment(name: string, mediaType: string, head: Buffer): boolean {
  const ext = path.extname(name).slice(1).toLowerCase();
  const base = name.toLowerCase();
  const typed =
    TEXT_EXTENSIONS.has(ext) ||
    TEXT_EXTENSIONS.has(base) ||
    mediaType.startsWith('text/') ||
    TEXT_MEDIA_TYPES.has(mediaType) ||
    /\+(json|xml)$/.test(mediaType);
  if (!typed) return false;
  return isUtf8Text(head.subarray(0, TEXT_SNIFF_BYTES), true);
}

/** Valid UTF-8 and no NUL. `partial` allows a sequence cut off at the end, for a prefix. */
export function isUtf8Text(bytes: Buffer, partial = false): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
    return true;
  } catch {
    return false;
  }
}

export function readHead(absPath: string, bytes = TEXT_SNIFF_BYTES): Buffer {
  const fd = fs.openSync(absPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// ---- The child process -------------------------------------------------------

/** `.js` beside this file once built; `.ts` in dev and tests, run by Node's own
    type stripping (the child imports nothing from this repo, so no loader is
    needed). */
function childScript(): { path: string; typescript: boolean } {
  const js = fileURLToPath(new URL('./extract-worker.js', import.meta.url));
  if (fs.existsSync(js)) return { path: js, typescript: false };
  return { path: fileURLToPath(new URL('./extract-worker.ts', import.meta.url)), typescript: true };
}

let running = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_EXTRACTIONS) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/** How often the parent samples the child's resident memory. */
const RSS_POLL_MS = 50;

/** Resident set size of `pid` in bytes, or `null` when it cannot be read. */
async function residentBytes(pid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    try {
      const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb ? Number(kb) * 1024 : null;
    } catch {
      return null;
    }
  }
  try {
    // macOS and the BSDs: argv only, no shell.
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

export interface ExtractLimits {
  timeoutMs?: number;
  /** V8 heap for the child, in MB. */
  maxHeapMb?: number;
  /** Resident memory the child may reach, in MB, before it is killed. */
  maxRssMb?: number;
  /** Total UTF-8 output bytes across all extracted files of one upload. */
  maxOutputBytes?: number;
  /** Optional page/sheet/slide limit override. */
  maxPages?: number;
  /** Optional character limit override. */
  maxChars?: number;
  maxUnzippedBytes?: number;
  /**
   * Optional streaming sink called as each chunk arrives from the child.
   * When provided (`enrichLandedAttachments`), chunks go straight to disk and
   * are not accumulated in the parent's heap.
   */
  onChunk?: (chunk: ExtractWorkerMessage & { type: 'chunk' }) => void;
}

/**
 * Parses one document in a child process. Never throws: a complete failure is
 * `{ ok: false }` with a sentence the model can be shown, while a timeout or
 * memory cap reached *after* earlier pages/sheets were already streamed keeps
 * the partial extract (`{ ok: true, truncated: true, truncatedReason, stoppedAt }`).
 *
 * The child gets an empty environment (so not even the `POCKETAGENT_*`
 * stripping in `sessions/env.ts` is needed: there is nothing to strip), no
 * stdin, no inherited flags, and its output discarded.
 */
export function extractDocumentText(absPath: string, kind: ExtractKind, limits: ExtractLimits = {}): Promise<ExtractReply> {
  const timeoutMs = limits.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const maxRssBytes = (limits.maxRssMb ?? EXTRACT_MAX_RSS_MB) * 1024 * 1024;
  const job: ExtractJob = {
    path: absPath,
    kind,
    maxOutputBytes: limits.maxOutputBytes ?? EXTRACT_MAX_OUTPUT_BYTES,
    ...(limits.maxChars !== undefined ? { maxChars: limits.maxChars } : {}),
    ...(limits.maxPages !== undefined ? { maxPages: limits.maxPages } : {}),
    maxUnzippedBytes: limits.maxUnzippedBytes ?? EXTRACT_MAX_UNZIPPED_BYTES,
  };
  return withSlot(
    () =>
      new Promise<ExtractReply>((resolve) => {
        const script = childScript();
        const execArgv = [`--max-old-space-size=${limits.maxHeapMb ?? EXTRACT_MAX_HEAP_MB}`, '--stack-size=4000'];
        // Node 22.6–22.17 strip types only behind the flag; later ones by default.
        if (script.typescript && !(process.features as { typescript?: unknown }).typescript) {
          execArgv.push('--experimental-strip-types', '--no-warnings');
        }
        let child: ChildProcess;
        try {
          child = fork(script.path, [], { execArgv, env: {}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        } catch (err) {
          resolve({ ok: false, error: `The text extractor could not start: ${(err as Error).message}` });
          return;
        }
        let settled = false;
        let sampling = false;

        // State accumulated from streaming chunks so a mid-parse timeout or
        // memory kill still returns what was already extracted.
        const bufferedStreams = new Map<string, ExtractFileOutput>();
        let contentChars = 0;
        let pages = 0;
        let totalPages = 0;
        let stoppedAt: string | undefined;

        const buildPartialOrFullReply = (
          truncated: boolean,
          truncatedReason?: ExtractTruncatedReason,
          finalStoppedAt?: string,
        ): ExtractReply => {
          const files = [...bufferedStreams.values()].map((f) => ({
            ...f,
            text: kind === 'xlsx' ? f.text.replace(/\n$/, '') : f.text,
          }));
          const mainText = bufferedStreams.get('main')?.text ?? '';
          const text = kind === 'xlsx' ? mainText.replace(/\n$/, '') : mainText;
          const resolvedStoppedAt = finalStoppedAt ?? stoppedAt;
          return {
            ok: true,
            text,
            ...(files.length > 0 ? { files } : {}),
            pages,
            totalPages,
            truncated,
            ...(truncated && truncatedReason ? { truncatedReason } : {}),
            ...(truncated && resolvedStoppedAt ? { stoppedAt: resolvedStoppedAt } : {}),
            contentChars,
          };
        };

        const finish = (reply: ExtractReply): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(watch);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve(reply);
        };

        const finishCap = (reason: 'time' | 'memory', errorMsg: string): void => {
          if (contentChars > 0) {
            finish(buildPartialOrFullReply(true, reason, stoppedAt));
          } else {
            finish({ ok: false, error: errorMsg });
          }
        };

        const timer = setTimeout(
          () => finishCap('time', `Reading the document took longer than ${Math.round(timeoutMs / 1000)} s.`),
          timeoutMs,
        );
        const watch = setInterval(() => {
          if (sampling || child.pid === undefined) return;
          sampling = true;
          void residentBytes(child.pid).then((rss) => {
            sampling = false;
            if (rss !== null && rss > maxRssBytes) {
              finishCap('memory', 'Reading the document needed more memory than allowed.');
            }
          });
        }, RSS_POLL_MS);

        child.on('message', (msg: ExtractWorkerMessage | ExtractReply) => {
          // Support both the streaming protocol and legacy single-message replies.
          if ('ok' in msg) {
            finish(msg);
            return;
          }
          if (msg.type === 'chunk') {
            contentChars += msg.contentChars;
            pages = msg.pages;
            totalPages = msg.totalPages;
            if (msg.stoppedAt) stoppedAt = msg.stoppedAt;
            if (limits.onChunk) {
              limits.onChunk(msg);
            } else {
              const existing = bufferedStreams.get(msg.stream);
              if (existing) {
                existing.text += msg.data;
              } else {
                bufferedStreams.set(msg.stream, {
                  stream: msg.stream,
                  kind: msg.kind,
                  label: msg.label,
                  suffix: msg.suffix,
                  text: msg.data,
                });
              }
            }
            return;
          }
          if (msg.type === 'done') {
            pages = msg.pages;
            totalPages = msg.totalPages;
            contentChars = msg.contentChars;
            if (msg.stoppedAt) stoppedAt = msg.stoppedAt;
            const reason: ExtractTruncatedReason | undefined = msg.truncated
              ? (msg.truncatedReason ?? 'size')
              : undefined;
            finish(buildPartialOrFullReply(msg.truncated, reason, msg.stoppedAt));
            return;
          }
          if (msg.type === 'error') {
            finish({ ok: false, error: msg.error });
          }
        });
        child.on('error', (err) => finish({ ok: false, error: `The text extractor failed: ${err.message.slice(0, 200)}` }));
        child.on('exit', (code, signal) => {
          if (code === 134 || signal === 'SIGABRT') {
            finishCap('memory', 'Reading the document needed more memory than allowed.');
            return;
          }
          finish({
            ok: false,
            error: `The text extractor stopped unexpectedly (${signal ?? `exit ${code}`}).`,
          });
        });
        child.send(job);
      }),
  );
}

// ---- After landing -------------------------------------------------------------

export interface EnrichOptions {
  /** Extract documents into sidecars. */
  extract: boolean;
  /**
   * PA-139 §6: document kinds to skip extracting (e.g. `['pdf']` for `claude`,
   * whose native `Read` tool reads PDFs but cannot read `.docx`/`.xlsx`/`.pptx`).
   */
  skipKinds?: readonly ExtractKind[];
  limits?: ExtractLimits;
  logger?: { info?: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}

/**
 * The sidecar name for a landed file and suffix:
 * - `('report_…_a1b2.pdf', '.txt', 0)` → `'report_…_a1b2.pdf.txt'`
 * - `('report_…_a1b2.pdf', '.txt', 1)` → `'report_…_a1b2.pdf.2.txt'`
 * - `('book_…_a1b2.xlsx', '.Budget.csv', 0)` → `'book_…_a1b2.xlsx.Budget.csv'`
 */
function sidecarName(landedRelPath: string, suffix: string, attempt: number): string {
  const base = landedRelPath.split('/').pop() ?? 'file';
  if (attempt === 0) return `${base}${suffix}`;
  const dot = suffix.lastIndexOf('.');
  if (dot <= 0) return `${base}.${attempt + 1}${suffix}`;
  return `${base}${suffix.slice(0, dot)}.${attempt + 1}${suffix.slice(dot)}`;
}

interface DiskStream {
  fd: number;
  absPath: string;
  relPath: string;
  kind: ExtractFileKind;
  label: string;
  suffix: string;
  chars: number;
  endsWithNewline: boolean;
  closed: boolean;
}

function closeAndRemoveStreams(streams: Iterable<DiskStream>): void {
  for (const s of streams) {
    if (!s.closed) {
      s.closed = true;
      try {
        fs.closeSync(s.fd);
      } catch {
        // Ignore close error.
      }
    }
    try {
      fs.unlinkSync(s.absPath);
    } catch {
      // Ignore unlink error.
    }
  }
}

/**
 * Marks text files and extracts documents for files that just landed in
 * `target`, returning the attachments with what was learned. A file that
 * cannot be judged keeps its PA-136 metadata unchanged, and an extraction
 * that fails records why: nothing here refuses the prompt, because the file
 * itself is already where the agent was told it is.
 */
export async function enrichLandedAttachments(
  target: LandingTarget,
  landed: readonly PromptAttachment[],
  opts: EnrichOptions,
): Promise<PromptAttachment[]> {
  const out: PromptAttachment[] = [];
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(target.root);
  } catch {
    return [...landed];
  }
  for (const attachment of landed) {
    const absPath = path.join(realRoot, ...attachment.path.split('/'));
    let head: Buffer;
    try {
      head = readHead(absPath);
    } catch {
      out.push(attachment);
      continue;
    }
    if (isTextAttachment(attachment.name, attachment.mediaType, head)) {
      out.push({ ...attachment, text: true });
      continue;
    }
    const kind = opts.extract ? documentKindFor(attachment.name, attachment.mediaType, head) : null;
    if (!kind || opts.skipKinds?.includes(kind)) {
      out.push(attachment);
      continue;
    }
    const startedAt = Date.now();
    const opened = new Map<string, DiskStream>();
    let writeFailed = false;

    const onChunk = (msg: ExtractWorkerMessage & { type: 'chunk' }): void => {
      if (writeFailed || msg.data.length === 0) return;
      let ds = opened.get(msg.stream);
      if (!ds) {
        try {
          let attempt = 0;
          const { fd, absPath: streamAbs, relPath } = openExclusiveAttachment(target, () =>
            sidecarName(attachment.path, msg.suffix, attempt++),
          );
          ds = {
            fd,
            absPath: streamAbs,
            relPath,
            kind: msg.kind,
            label: msg.label,
            suffix: msg.suffix,
            chars: 0,
            endsWithNewline: false,
            closed: false,
          };
          opened.set(msg.stream, ds);
        } catch (err) {
          writeFailed = true;
          opts.logger?.warn({ err, kind }, 'could not open sidecar file for extracted text');
          return;
        }
      }
      try {
        fs.writeSync(ds.fd, msg.data, null, 'utf8');
        ds.chars += msg.data.length;
        ds.endsWithNewline = msg.data.endsWith('\n');
      } catch (err) {
        writeFailed = true;
        opts.logger?.warn({ err, kind }, 'could not write chunk to extracted text sidecar');
      }
    };

    const reply = await extractDocumentText(absPath, kind, { ...opts.limits, onChunk });
    if (writeFailed) {
      closeAndRemoveStreams(opened.values());
      out.push({ ...attachment, extractError: 'The extracted text could not be saved.' });
      continue;
    }
    if (!reply.ok) {
      closeAndRemoveStreams(opened.values());
      opts.logger?.warn({ kind, size: attachment.size, ms: Date.now() - startedAt }, 'attachment text extraction failed');
      out.push({ ...attachment, extractError: reply.error.slice(0, 300) });
      continue;
    }
    const mainStream = opened.get('main');
    if (reply.contentChars === 0 || !mainStream || mainStream.chars === 0) {
      closeAndRemoveStreams(opened.values());
      // A scanned PDF has no text layer; OCR is out of scope, so say so.
      out.push({ ...attachment, extractError: 'No text was found in the document (it may be a scan, which is not read).' });
      continue;
    }

    try {
      const sheetStreams = [...opened.values()].filter((s) => s.kind === 'sheet_csv');
      if (sheetStreams.length > 0) {
        const pointerLines = [
          mainStream.endsWithNewline ? '' : '\n',
          '\nSheet CSV files:\n',
          ...sheetStreams.map((s) => `- ${s.label}: ${s.relPath}\n`),
        ].join('');
        fs.writeSync(mainStream.fd, pointerLines, null, 'utf8');
        mainStream.chars += pointerLines.length;
        mainStream.endsWithNewline = true;
      }

      for (const s of opened.values()) {
        if (!s.endsWithNewline) {
          fs.writeSync(s.fd, '\n', null, 'utf8');
        }
        s.closed = true;
        fs.closeSync(s.fd);
      }

      // Trim any trailing newline from `extractedChars` to match the content length before the final `\n`.
      const extractedChars = mainStream.endsWithNewline ? Math.max(0, mainStream.chars - 1) : mainStream.chars;
      const extractedFiles: ExtractedAttachmentFile[] = [...opened.values()].map((s) => ({
        path: s.relPath,
        kind: s.kind,
        label: s.label,
      }));

      // Metadata only, like every other attachment log line.
      opts.logger?.info?.(
        {
          kind,
          size: attachment.size,
          chars: extractedChars,
          files: extractedFiles.length,
          pages: reply.pages,
          truncated: reply.truncated,
          ...(reply.truncatedReason ? { truncatedReason: reply.truncatedReason } : {}),
          ms: Date.now() - startedAt,
        },
        'attachment text extracted',
      );
      out.push({
        ...attachment,
        extractedPath: mainStream.relPath,
        ...(extractedFiles.length > 0 ? { extractedFiles } : {}),
        extractedChars,
        truncated: reply.truncated,
        ...(reply.truncated && reply.truncatedReason ? { truncatedReason: reply.truncatedReason } : {}),
        ...(reply.truncated && reply.stoppedAt ? { stoppedAt: reply.stoppedAt } : {}),
      });
    } catch (err) {
      closeAndRemoveStreams(opened.values());
      opts.logger?.warn({ err, kind }, 'could not write the extracted text of an attachment');
      out.push({ ...attachment, extractError: 'The extracted text could not be saved.' });
    }
  }
  return out;
}
