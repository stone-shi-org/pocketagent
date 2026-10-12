import { execFile, fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PromptAttachment } from '@pocketagent/protocol';
import { landAttachment, type LandingTarget } from './index.js';
import type { ExtractJob, ExtractKind, ExtractReply } from './extract-worker.js';

/**
 * PA-137: what happens to an attached file right after it lands.
 *
 * Two judgements, both made once and recorded on the `PromptAttachment`:
 *
 * - **Is it text?** (`text: true`) A UTF-8 file of a text type — Markdown,
 *   CSV, JSON, source code. A Pocket Agent may then put a small one straight
 *   into the message (`inline.ts`). Judged here rather than at context time
 *   so the per-turn path reads metadata, not bytes, until it actually
 *   inlines something.
 * - **Can its text be extracted?** A PDF, docx, xlsx or pptx gets a sidecar,
 *   `<landed name>.txt`, beside it. That is what removes the dead end PA-136
 *   left: `read_file` refuses binaries and the image has no `pdftotext`, so a
 *   Pocket Agent could not read a PDF at all. The sidecar is plain text, so
 *   `read_file` pages through it with no shell and no approval.
 *
 * The document is a stranger's file, so the parse runs in a child process
 * with a CPU timeout, a memory cap and output caps, and its failure is a note,
 * never a refused prompt. See `extract-worker.ts` for what the parse may not
 * do (fetch, eval).
 */

/** How long one document may take to parse. */
export const EXTRACT_TIMEOUT_MS = 10_000;
/** V8 heap the parse may use, in MB. */
export const EXTRACT_MAX_HEAP_MB = 256;
/**
 * Resident memory the parse may reach, in MB, typed arrays included — the
 * cap that matters, since decompression happens outside the V8 heap. A 20 MB
 * PDF needs well under it; a decompression bomb reaches it and is killed.
 */
export const EXTRACT_MAX_RSS_MB = 768;
export const EXTRACT_MAX_PAGES = 200;
export const EXTRACT_MAX_CHARS = 500_000;
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

function readHead(absPath: string, bytes = TEXT_SNIFF_BYTES): Buffer {
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
  maxPages?: number;
  maxChars?: number;
  maxUnzippedBytes?: number;
}

/**
 * Parses one document in a child process. Never throws: every failure — a
 * timeout, the memory cap, a document the library cannot read — is
 * `{ ok: false }` with a sentence the model can be shown.
 *
 * The child gets an empty environment (so not even the `POCKETAGENT_*`
 * stripping in `sessions/env.ts` is needed: there is nothing to strip), no
 * stdin, no inherited flags, and its output discarded. It reads one file and
 * sends one message back.
 */
export function extractDocumentText(absPath: string, kind: ExtractKind, limits: ExtractLimits = {}): Promise<ExtractReply> {
  const timeoutMs = limits.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const maxRssBytes = (limits.maxRssMb ?? EXTRACT_MAX_RSS_MB) * 1024 * 1024;
  const job: ExtractJob = {
    path: absPath,
    kind,
    maxChars: limits.maxChars ?? EXTRACT_MAX_CHARS,
    maxPages: limits.maxPages ?? EXTRACT_MAX_PAGES,
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
        const finish = (reply: ExtractReply): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(watch);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          resolve(reply);
        };
        const timer = setTimeout(
          () => finish({ ok: false, error: `Reading the document took longer than ${Math.round(timeoutMs / 1000)} s.` }),
          timeoutMs,
        );
        const watch = setInterval(() => {
          if (sampling || child.pid === undefined) return;
          sampling = true;
          void residentBytes(child.pid).then((rss) => {
            sampling = false;
            if (rss !== null && rss > maxRssBytes) {
              finish({ ok: false, error: 'Reading the document needed more memory than allowed.' });
            }
          });
        }, RSS_POLL_MS);
        child.on('message', (reply: ExtractReply) => finish(reply));
        child.on('error', (err) => finish({ ok: false, error: `The text extractor failed: ${err.message.slice(0, 200)}` }));
        child.on('exit', (code, signal) =>
          finish({
            ok: false,
            error:
              code === 134 || signal === 'SIGABRT'
                ? 'Reading the document needed more memory than allowed.'
                : `The text extractor stopped unexpectedly (${signal ?? `exit ${code}`}).`,
          }),
        );
        child.send(job);
      }),
  );
}

// ---- After landing -------------------------------------------------------------

export interface EnrichOptions {
  /** Extract documents into sidecars. Off for claude, whose `Read` handles a PDF itself. */
  extract: boolean;
  limits?: ExtractLimits;
  logger?: { info?: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}

/** The sidecar for a landed file: `report_…_a1b2.pdf` → `report_…_a1b2.pdf.txt`. */
function sidecarName(landedRelPath: string, attempt: number): string {
  const base = landedRelPath.split('/').pop() ?? 'file';
  return attempt === 0 ? `${base}.txt` : `${base}.${attempt + 1}.txt`;
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
    if (!kind) {
      out.push(attachment);
      continue;
    }
    const startedAt = Date.now();
    const reply = await extractDocumentText(absPath, kind, opts.limits);
    if (!reply.ok) {
      opts.logger?.warn({ kind, size: attachment.size, ms: Date.now() - startedAt }, 'attachment text extraction failed');
      out.push({ ...attachment, extractError: reply.error.slice(0, 300) });
      continue;
    }
    const text = reply.text.trim();
    if (reply.contentChars === 0 || text.length === 0) {
      // A scanned PDF has no text layer; OCR is out of scope, so say so.
      out.push({ ...attachment, extractError: 'No text was found in the document (it may be a scan, which is not read).' });
      continue;
    }
    try {
      let attempt = 0;
      const { relPath } = landAttachment(target, { kind: 'buffer', data: Buffer.from(`${text}\n`, 'utf8') }, () =>
        sidecarName(attachment.path, attempt++),
      );
      // Metadata only, like every other attachment log line.
      opts.logger?.info?.(
        { kind, size: attachment.size, chars: text.length, pages: reply.pages, truncated: reply.truncated, ms: Date.now() - startedAt },
        'attachment text extracted',
      );
      out.push({ ...attachment, extractedPath: relPath, extractedChars: text.length, truncated: reply.truncated });
    } catch (err) {
      opts.logger?.warn({ err, kind }, 'could not write the extracted text of an attachment');
      out.push({ ...attachment, extractError: 'The extracted text could not be saved.' });
    }
  }
  return out;
}
