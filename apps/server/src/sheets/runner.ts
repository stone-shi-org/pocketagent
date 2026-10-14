import { execFile, fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveExecutable } from '../agents/registry.js';
import {
  applyXmlSplices,
  findElements,
  findFirstElement,
  formatSheetEditResult,
  patchOpeningTagAttrs,
  type SheetCellEditInput,
  type SheetDiffPayload,
  type SheetDownstreamChange,
  type SheetErrorCell,
  type SheetWorkerRequest,
  type SheetWorkerResponse,
} from './sheet-worker.js';
import { readZipSafe, utf8, xmlEscape } from './xlsx-shared.js';

const execFileAsync = promisify(execFile);

/** Maximum wall-clock time for a single sheet worker invocation. */
export const SHEET_WORKER_TIMEOUT_MS = 30_000;
/** V8 heap cap for the sheet worker process, in MB. */
export const SHEET_WORKER_MAX_HEAP_MB = 256;
/** Resident set size cap for the sheet worker process, in MB. */
export const SHEET_WORKER_MAX_RSS_MB = 768;
/** Maximum declared uncompressed size of a workbook zip before refusing unopened. */
export const SHEET_MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;
/** Maximum wall-clock time for headless LibreOffice recalculation. */
export const LIBREOFFICE_TIMEOUT_MS = 30_000;
/** Maximum concurrent sheet worker child processes. */
const MAX_CONCURRENT_SHEET_WORKERS = 2;
/** How often the parent samples the child's resident memory. */
const RSS_POLL_MS = 50;

export interface SheetRunnerLimits {
  timeoutMs?: number;
  maxHeapMb?: number;
  maxRssMb?: number;
  maxUnzippedBytes?: number;
  libreOfficeTimeoutMs?: number;
  /** Optional override for the `soffice` / `libreoffice` binary path (or `null` to force unavailable). */
  sofficeBin?: string | null;
  libreOfficeBin?: string | null;
  /**
   * Allow in-place edits (`outputPath === path`) or overwriting an existing
   * `outputPath` when backed by Document Workspace version history (PA-143).
   */
  allowOverwrite?: boolean;
}

/**
 * Resolves the headless LibreOffice executable (`soffice` or `libreoffice`) on
 * the host, or `null` if LibreOffice is not installed.
 */
export function resolveLibreOfficeExecutable(override?: string | null): string | null {
  if (override !== undefined) return override;
  const envBin = process.env.POCKETAGENT_SOFFICE_BIN?.trim();
  if (envBin) {
    return resolveExecutable(envBin) ?? (fs.existsSync(envBin) ? envBin : null);
  }
  return resolveExecutable('soffice') ?? resolveExecutable('libreoffice');
}

/**
 * PA-145: Checks whether an Office or LibreOffice lock file (`~$book.xlsx`,
 * `~$doc.docx`, `.~lock.book.xlsx#`) exists alongside `absPath`.
 * Lock files indicate the document may be open in Excel/Word/LibreOffice on
 * this or a synced machine; callers warn in the approval card and tool result
 * without refusing (since lock files from crash/sync can be stale).
 */
export function detectOfficeLockFile(absPath: string): { lockFile: string; lockFileName: string; message: string } | null {
  const dir = path.dirname(absPath);
  const base = path.basename(absPath);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const candidates = new Set<string>([`~$${base}`, `.~lock.${base}#`]);
  if (stem.length >= 7) {
    candidates.add(`~$${stem.slice(1)}${ext}`);
  }
  if (stem.length >= 8) {
    candidates.add(`~$${stem.slice(2)}${ext}`);
  }
  for (const lockName of candidates) {
    try {
      if (fs.existsSync(path.join(dir, lockName))) {
        return {
          lockFile: lockName,
          lockFileName: lockName,
          message: `Warning: Office lock file "${lockName}" exists alongside ${base} — the file may be open in Excel/Word on this or a synced machine.`,
        };
      }
    } catch {
      // Ignore lock file probe errors.
    }
  }
  return null;
}

function workerScript(): { path: string; typescript: boolean } {
  const js = fileURLToPath(new URL('./sheet-worker.js', import.meta.url));
  if (fs.existsSync(js)) return { path: js, typescript: false };
  return { path: fileURLToPath(new URL('./sheet-worker.ts', import.meta.url)), typescript: true };
}

let runningWorkers = 0;
const waitingWorkers: Array<() => void> = [];

async function withWorkerSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (runningWorkers >= MAX_CONCURRENT_SHEET_WORKERS) {
    await new Promise<void>((resolve) => waitingWorkers.push(resolve));
  }
  runningWorkers++;
  try {
    return await fn();
  } finally {
    runningWorkers--;
    waitingWorkers.shift()?.();
  }
}

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
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Runs a single `SheetWorkerRequest` in a sandboxed child process (`env: {}`,
 * no network, RSS cap, wall timeout).
 */
export function invokeSheetWorker(
  req: SheetWorkerRequest,
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  const timeoutMs = limits.timeoutMs ?? SHEET_WORKER_TIMEOUT_MS;
  const maxHeapMb = limits.maxHeapMb ?? SHEET_WORKER_MAX_HEAP_MB;
  const maxRssBytes = (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024;

  return withWorkerSlot(
    () =>
      new Promise<SheetWorkerResponse>((resolve) => {
        const script = workerScript();
        const execArgv = [`--max-old-space-size=${maxHeapMb}`, '--stack-size=4000'];
        if (script.typescript && !(process.features as { typescript?: unknown }).typescript) {
          execArgv.push('--experimental-strip-types', '--no-warnings');
        }

        let child: ChildProcess;
        try {
          child = fork(script.path, [], {
            execArgv,
            env: {},
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          });
        } catch (err) {
          resolve({
            ok: false,
            error: `Spreadsheet worker could not start: ${(err as Error).message}`,
          });
          return;
        }

        let settled = false;
        let sampling = false;
        let killedForMemory = false;

        const finish = (res: SheetWorkerResponse): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearInterval(watch);
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
          resolve(res);
        };

        const timer = setTimeout(() => {
          finish({
            ok: false,
            error: `Spreadsheet operation timed out after ${Math.round(timeoutMs / 1000)}s.`,
          });
        }, timeoutMs);
        timer.unref();

        const watch = setInterval(() => {
          if (sampling || settled || !child.pid) return;
          sampling = true;
          void residentBytes(child.pid).then((rss) => {
            sampling = false;
            if (rss !== null && rss > maxRssBytes) {
              killedForMemory = true;
              finish({
                ok: false,
                error: `Spreadsheet exceeded the ${limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB} MB memory limit.`,
              });
            }
          });
        }, RSS_POLL_MS);
        watch.unref();

        child.on('message', (msg: SheetWorkerResponse) => {
          finish(msg);
        });

        child.on('error', (err) => {
          finish({ ok: false, error: `Spreadsheet worker failed: ${err.message}` });
        });

        child.on('exit', (code, signal) => {
          if (settled) return;
          if (killedForMemory || code === 2 || signal === 'SIGABRT') {
            finish({
              ok: false,
              error: `Spreadsheet exceeded the ${limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB} MB memory limit.`,
            });
            return;
          }
          finish({
            ok: false,
            error: `Spreadsheet worker exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}).`,
          });
        });

        child.send(req);
      }),
  );
}

/**
 * Prepares a scratch copy of `xlsxPath` with `<calcPr fullCalcOnLoad="1"/>`,
 * no `xl/calcChain.xml`, and cached `<v>` elements stripped from formula cells
 * so headless LibreOffice is forced to evaluate every formula on open.
 */
async function prepareScratchWorkbookForRecalc(
  sourcePath: string,
  destPath: string,
  maxUnzippedBytes: number,
): Promise<void> {
  const { zipSync } = await import('fflate');
  const raw = await fsp.readFile(sourcePath);
  const files = await readZipSafe(raw, maxUnzippedBytes);
  const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  delete files['xl/calcChain.xml'];

  const wbXml = utf8(files['xl/workbook.xml']);
  if (wbXml) {
    const calcPrSpan = findFirstElement(wbXml, 'calcPr');
    if (calcPrSpan) {
      files['xl/workbook.xml'] = encodeUtf8(
        applyXmlSplices(wbXml, [
          patchOpeningTagAttrs(wbXml, calcPrSpan, { fullCalcOnLoad: '1' }, xmlEscape),
        ]),
      );
    } else {
      const wbRoot = findFirstElement(wbXml, 'workbook');
      if (wbRoot && !wbRoot.selfClosing) {
        files['xl/workbook.xml'] = encodeUtf8(
          applyXmlSplices(wbXml, [
            {
              start: wbRoot.innerEnd,
              end: wbRoot.innerEnd,
              replacement: '<calcPr fullCalcOnLoad="1"/>',
            },
          ]),
        );
      }
    }
  }

  for (const key of Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))) {
    const xml = utf8(files[key]);
    const splices: Array<{ start: number; end: number; replacement: string }> = [];
    for (const cSpan of findElements(xml, 'c')) {
      if (cSpan.selfClosing) continue;
      const fSpan = findFirstElement(xml, 'f', cSpan.innerStart, cSpan.innerEnd);
      if (!fSpan) continue;
      const vSpan = findFirstElement(xml, 'v', cSpan.innerStart, cSpan.innerEnd);
      if (vSpan) {
        splices.push({ start: vSpan.openStart, end: vSpan.closeEnd, replacement: '' });
      }
    }
    if (splices.length > 0) {
      files[key] = encodeUtf8(applyXmlSplices(xml, splices));
    }
  }

  await fsp.writeFile(destPath, zipSync(files, { level: 1 }));
}

/**
 * Runs headless LibreOffice (`soffice --headless --convert-to xlsx`) on a
 * scratch copy of `xlsxPath` with an isolated throwaway `UserInstallation`
 * profile, returning the recalculated `.xlsx` bytes or `null` if LibreOffice
 * is unavailable or fails.
 */
export async function recalculateWorkbookWithLibreOffice(
  xlsxPath: string,
  limits: SheetRunnerLimits = {},
): Promise<{ available: boolean; recalculatedBytes: Uint8Array | null; error?: string }> {
  const binOverride = limits.sofficeBin !== undefined ? limits.sofficeBin : limits.libreOfficeBin;
  const soffice = resolveLibreOfficeExecutable(binOverride);
  if (!soffice) {
    return { available: false, recalculatedBytes: null };
  }

  const maxUnzippedBytes = limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES;
  const timeoutMs = limits.libreOfficeTimeoutMs ?? LIBREOFFICE_TIMEOUT_MS;
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-sheet-recalc-'));

  try {
    const profileDir = path.join(tmpRoot, 'profile');
    const inDir = path.join(tmpRoot, 'in');
    const outDir = path.join(tmpRoot, 'out');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(inDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    const scratchInPath = path.join(inDir, 'workbook.xlsx');
    const scratchOutPath = path.join(outDir, 'workbook.xlsx');
    await prepareScratchWorkbookForRecalc(xlsxPath, scratchInPath, maxUnzippedBytes);

    const profileUrl = `file://${profileDir}`;
    const args = [
      '--headless',
      '--norestore',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${profileUrl}`,
      '--convert-to',
      'xlsx',
      '--outdir',
      outDir,
      scratchInPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(soffice, args, {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: profileDir,
          TMPDIR: tmpRoot,
          LANG: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`LibreOffice recalculation timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`LibreOffice exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        resolve();
      });
    });

    const recalculatedBytes = new Uint8Array(await fsp.readFile(scratchOutPath));
    return { available: true, recalculatedBytes };
  } catch (err) {
    return {
      available: true,
      recalculatedBytes: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function assertZipMagic(absPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Workbook not found: ${absPath}`);
    if (code === 'ELOOP') throw new Error(`Refusing symlinked workbook path: ${absPath}`);
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${absPath}`);
    }
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    if (n < 4 || head.readUInt32BE(0) !== 0x504b0304) {
      throw new Error(`File is not a valid OOXML (.xlsx / .xlsm) zip archive.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

export async function executeSheetInfo(
  absPath: string,
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return invokeSheetWorker(
    {
      op: 'sheet_info',
      filePath: absPath,
      maxUnzippedBytes: limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES,
      maxRssBytes: (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024,
    },
    limits,
  );
}

export async function executeSheetRead(
  absPath: string,
  sheet: string,
  range?: string,
  include?: string[],
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return invokeSheetWorker(
    {
      op: 'sheet_read',
      filePath: absPath,
      sheet,
      range,
      include,
      maxUnzippedBytes: limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES,
      maxRssBytes: (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024,
    },
    limits,
  );
}

export async function executeSheetFind(
  absPath: string,
  query: string,
  scope?: 'values' | 'formulas' | 'both',
  sheet?: string,
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  return invokeSheetWorker(
    {
      op: 'sheet_find',
      filePath: absPath,
      query,
      scope,
      sheet,
      maxUnzippedBytes: limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES,
      maxRssBytes: (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024,
    },
    limits,
  );
}

export async function executeSheetCheck(
  absPath: string,
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const recalc = await recalculateWorkbookWithLibreOffice(absPath, limits);
  let tmpRecalcPath: string | undefined;
  let tmpDir: string | undefined;

  try {
    if (recalc.recalculatedBytes) {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-sheet-check-'));
      tmpRecalcPath = path.join(tmpDir, 'recalc.xlsx');
      await fsp.writeFile(tmpRecalcPath, recalc.recalculatedBytes);
    }

    return await invokeSheetWorker(
      {
        op: 'sheet_check',
        filePath: absPath,
        recalculatedPath: tmpRecalcPath,
        libreOfficeAvailable: recalc.available,
        maxUnzippedBytes: limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES,
        maxRssBytes: (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024,
      },
      limits,
    );
  } finally {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function previewSheetEdit(
  absPath: string,
  outputAbsPath: string,
  edits: SheetCellEditInput[],
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
    if (!limits.allowOverwrite) {
      if (path.resolve(absPath) === path.resolve(outputAbsPath)) {
        return {
          ok: false,
          error: 'outputPath must be a new file path; sheet_edit never overwrites the original workbook.',
        };
      }
      if (fs.existsSync(outputAbsPath)) {
        return {
          ok: false,
          error: `Refusing to overwrite existing file at outputPath: ${outputAbsPath}`,
        };
      }
    }
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  return invokeSheetWorker(
    {
      op: 'sheet_edit_preview',
      filePath: absPath,
      outputPath: outputAbsPath,
      edits,
      maxUnzippedBytes: limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES,
      maxRssBytes: (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024,
    },
    limits,
  );
}

export async function executeSheetEdit(
  absPath: string,
  outputAbsPath: string,
  displayOutputPath: string,
  edits: SheetCellEditInput[],
  limits: SheetRunnerLimits = {},
): Promise<SheetWorkerResponse> {
  try {
    assertZipMagic(absPath);
    if (!limits.allowOverwrite) {
      if (path.resolve(absPath) === path.resolve(outputAbsPath)) {
        return {
          ok: false,
          error: 'outputPath must be a new file path; sheet_edit never overwrites the original workbook.',
        };
      }
      if (fs.existsSync(outputAbsPath)) {
        return {
          ok: false,
          error: `Refusing to overwrite existing file at outputPath: ${displayOutputPath}`,
        };
      }
    }
    await fsp.mkdir(path.dirname(outputAbsPath), { recursive: true });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const maxUnzippedBytes = limits.maxUnzippedBytes ?? SHEET_MAX_UNZIPPED_BYTES;
  const maxRssBytes = (limits.maxRssMb ?? SHEET_WORKER_MAX_RSS_MB) * 1024 * 1024;
  const stageToTemp = Boolean(limits.allowOverwrite && fs.existsSync(outputAbsPath));
  const stagedOutputPath = stageToTemp
    ? `${outputAbsPath}.stage.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
    : outputAbsPath;

  const applyRes = await invokeSheetWorker(
    {
      op: 'sheet_edit_apply',
      filePath: absPath,
      outputPath: stagedOutputPath,
      edits,
      maxUnzippedBytes,
      maxRssBytes,
    },
    limits,
  );

  if (!applyRes.ok) {
    if (stageToTemp) {
      await fsp.rm(stagedOutputPath, { force: true }).catch(() => {});
    }
    return applyRes;
  }

  // If LibreOffice is available on the host, recalculate a scratch copy of the
  // newly written output workbook and back-patch cached `<v>` values into it.
  const recalc = await recalculateWorkbookWithLibreOffice(stagedOutputPath, limits);
  let downstreamChanges: SheetDownstreamChange[] = [];
  let newErrors: SheetErrorCell[] = [];
  let recalculated = false;

  if (recalc.recalculatedBytes) {
    let tmpDir: string | undefined;
    try {
      tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-sheet-bp-'));
      const tmpRecalcPath = path.join(tmpDir, 'recalc.xlsx');
      await fsp.writeFile(tmpRecalcPath, recalc.recalculatedBytes);

      const bpRes = await invokeSheetWorker(
        {
          op: 'sheet_edit_backpatch',
          originalPath: absPath,
          patchedPath: stagedOutputPath,
          recalculatedPath: tmpRecalcPath,
          directlyEditedCells: applyRes.directlyEditedCells ?? [],
          maxUnzippedBytes,
          maxRssBytes,
        },
        limits,
      );
      if (bpRes.ok) {
        recalculated = true;
        downstreamChanges = bpRes.downstreamChanges ?? [];
        newErrors = bpRes.newErrors ?? [];
      }
    } finally {
      if (tmpDir) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  if (stageToTemp) {
    await fsp.rename(stagedOutputPath, outputAbsPath);
  }

  const diff: SheetDiffPayload = applyRes.diff ?? { before: '', after: '', lines: [] };
  const warnings = applyRes.warnings ?? [];
  const text = formatSheetEditResult(
    displayOutputPath,
    diff,
    downstreamChanges,
    newErrors,
    warnings,
    recalculated,
  );

  return {
    ok: true,
    text,
    diff,
    directlyEditedCells: applyRes.directlyEditedCells,
    formulaChanged: applyRes.formulaChanged,
    downstreamChanges,
    newErrors,
    warnings,
  };
}
