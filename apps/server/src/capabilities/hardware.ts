import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HostCapabilityGpu, HostCapabilityHardware } from '@pocketagent/protocol';
import { resolveExecutable } from '../agents/registry.js';
import { buildChildEnv } from '../sessions/env.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';

/**
 * PA-174: Auto-detected hardware facts for `HostCapabilities.hardware`.
 *
 * Invariants:
 * - **Zero subprocesses on read (`GET /api/capabilities`, `get_capabilities`).**
 *   Static facts (CPU model, thread count, host total RAM, static GPU list) and
 *   the one allowed subprocess probe (`nvidia-smi` for NVIDIA VRAM) are computed
 *   at boot and on explicit Refresh (`POST /api/agents/refresh` and
 *   `POST /api/capabilities/refresh`), cached in memory, and never spawned on a
 *   capability read.
 * - **Fixed argv, no shell.** The `nvidia-smi` probe uses `spawn` directly with
 *   `NVIDIA_SMI_ARGS` and a sanitized child environment (`buildChildEnv`). No
 *   caller-supplied path, executable, or argument is ever accepted.
 * - **Container-aware.** Re-reads cgroup v2/v1 CPU and memory limits and
 *   `/dev/nvidia<minor>` device presence on every read so a container that
 *   cannot access a host GPU never advertises it, and cgroup limits updated live
 *   (`docker update --memory …`) take effect immediately.
 */

export const NVIDIA_SMI_BIN = 'nvidia-smi';
export const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,memory.total',
  '--format=csv,noheader,nounits',
] as const;

const NVIDIA_SMI_TIMEOUT_MS = 5_000;
const NVIDIA_SMI_CAPTURE_CAP = 16 * 1024;

/**
 * Cgroup v1 represents "no memory limit" as a huge kernel sentinel near 2^63
 * (e.g. `9223372036854771712` = `0x7ffffffffffff000`). Anything at or above
 * 1 PiB (`2^50` bytes, well within `Number.MAX_SAFE_INTEGER`) is treated as
 * unlimited (`null`).
 */
const CGROUP_MEMORY_UNLIMITED_THRESHOLD = 1n << 50n;

const DEFAULT_CGROUP_DIR = '/sys/fs/cgroup';
const DEFAULT_PROC_SELF_CGROUP = '/proc/self/cgroup';
const DEFAULT_DOCKERENV_PATH = '/.dockerenv';
const DEFAULT_CONTAINERENV_PATH = '/run/.containerenv';
const DEFAULT_PROC_NVIDIA_GPUS_DIR = '/proc/driver/nvidia/gpus';
const DEFAULT_DEV_DIR = '/dev';
const DEFAULT_SYS_DRM_DIR = '/sys/class/drm';

/**
 * Small PCI device-id lookup table for common AMD (`0x1002`) and Intel (`0x8086`)
 * discrete and integrated GPUs on Linux. Unknown IDs fall back to their normalized
 * hex PCI device ID (e.g. `0x1234`).
 */
export const AMD_PCI_MODELS: Readonly<Record<string, string>> = {
  '0x7550': 'Radeon RX 9070 XT',
  '0x744c': 'Radeon RX 7900 XTX',
  '0x7448': 'Radeon PRO W7900',
  '0x747e': 'Radeon RX 7800 XT',
  '0x7480': 'Radeon RX 7600',
  '0x73bf': 'Radeon RX 6900 XT',
  '0x73af': 'Radeon RX 6900 XT',
  '0x73df': 'Radeon RX 6700 XT',
  '0x73ff': 'Radeon RX 6600',
  '0x74a0': 'Instinct MI300A',
  '0x74a1': 'Instinct MI300X',
  '0x74a2': 'Instinct MI308X',
  '0x7408': 'Instinct MI250X',
  '0x740c': 'Instinct MI250',
  '0x740f': 'Instinct MI210',
  '0x738c': 'Instinct MI100',
  '0x1586': 'Radeon 8060S',
  '0x15bf': 'Radeon 780M',
  '0x164c': 'Radeon 680M',
};

export const INTEL_PCI_MODELS: Readonly<Record<string, string>> = {
  '0xe20b': 'Arc B580',
  '0xe20c': 'Arc B570',
  '0x56a0': 'Arc A770',
  '0x56a1': 'Arc A750',
  '0x56a5': 'Arc A380',
  '0x5690': 'Arc A770M',
  '0x0bd5': 'Data Center GPU Max 1550',
  '0x7d55': 'Arc Graphics',
  '0x9a49': 'Iris Xe Graphics',
  '0x4680': 'UHD Graphics 770',
  '0xa780': 'UHD Graphics 770',
};

export interface NvidiaSmiGpuEntry {
  readonly model: string;
  readonly vramBytes: number | null;
}

export interface ProcNvidiaGpuEntry {
  readonly busLocation: string;
  readonly minor: number;
  readonly model: string;
}

export interface ProbeNvidiaSmiOptions {
  /** Optional override for `child_process.spawn` in unit tests. */
  readonly spawnImpl?: typeof spawn;
  /** Optional override for resolved `nvidia-smi` executable path in unit tests. */
  readonly executablePath?: string | null;
  readonly timeoutMs?: number;
}

export interface HardwareDetectOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly cpuModel?: string;
  readonly cpuThreads?: number;
  readonly totalMemoryBytes?: number;
  /** Override `/sys/fs/cgroup` directory in unit tests. */
  readonly cgroupDir?: string;
  /** Override `/proc/self/cgroup` path in unit tests. */
  readonly procSelfCgroupPath?: string;
  /** Override `/.dockerenv` path in unit tests. */
  readonly dockerEnvPath?: string;
  /** Override `/run/.containerenv` path in unit tests. */
  readonly containerEnvPath?: string;
  /** Override `/proc/driver/nvidia/gpus` directory in unit tests. */
  readonly procNvidiaGpusDir?: string;
  /** Override `/dev` directory in unit tests. */
  readonly devDir?: string;
  /** Override `/sys/class/drm` directory in unit tests. */
  readonly sysDrmDir?: string;
  /** Override cached `nvidia-smi` entries in unit tests. */
  readonly cachedNvidiaSmi?: readonly NvidiaSmiGpuEntry[] | null;
}

interface StaticHardwareFacts {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuThreads: number;
  readonly totalMemoryBytes: number;
  readonly procNvidiaGpus: readonly ProcNvidiaGpuEntry[];
  readonly sysfsDrmGpus: readonly HostCapabilityGpu[];
}

let cachedStaticFacts: StaticHardwareFacts | null = null;
let cachedNvidiaSmiEntries: readonly NvidiaSmiGpuEntry[] = [];
let bootProbePromise: Promise<void> | null = null;

function detectCpuModel(): string {
  const first = os.cpus()[0]?.model?.trim();
  return first && first.length > 0 ? first : 'Unknown';
}

function detectCpuThreads(): number {
  try {
    const avail = os.availableParallelism();
    if (Number.isInteger(avail) && avail > 0) return avail;
  } catch {
    // Fallback to os.cpus().length below.
  }
  return Math.max(1, os.cpus().length);
}

function readStaticHardwareFacts(): StaticHardwareFacts {
  const platform = process.platform;
  const arch = process.arch;
  const cpuModel = detectCpuModel();
  const cpuThreads = detectCpuThreads();
  const totalMemoryBytes = os.totalmem();
  const procNvidiaGpus = platform === 'linux' ? readProcNvidiaGpus(DEFAULT_PROC_NVIDIA_GPUS_DIR) : [];
  const sysfsDrmGpus = platform === 'linux' ? readSysfsDrmGpus(DEFAULT_SYS_DRM_DIR) : [];
  return {
    platform,
    arch,
    cpuModel,
    cpuThreads,
    totalMemoryBytes,
    procNvidiaGpus,
    sysfsDrmGpus,
  };
}

/**
 * Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
 * stdout into `{ model, vramBytes }[]`. `memory.total` with `nounits` is in MiB.
 */
export function parseNvidiaSmiCsv(stdout: string): NvidiaSmiGpuEntry[] {
  const entries: NvidiaSmiGpuEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const commaIdx = line.lastIndexOf(',');
    if (commaIdx === -1) {
      entries.push({ model: line, vramBytes: null });
      continue;
    }
    const model = line.slice(0, commaIdx).trim();
    const mibRaw = line.slice(commaIdx + 1).trim();
    if (!model) continue;
    const mib = Number(mibRaw);
    const vramBytes =
      mibRaw !== '' && Number.isFinite(mib) && mib > 0 ? Math.round(mib * 1024 * 1024) : null;
    entries.push({ model, vramBytes });
  }
  return entries;
}

function resolveNvidiaSmiExecutable(override?: string | null): string | null {
  if (override !== undefined) return override;
  const fromPath = resolveExecutable(NVIDIA_SMI_BIN);
  if (fromPath !== null) return fromPath;
  for (const fallback of ['/usr/bin/nvidia-smi', '/usr/local/nvidia/bin/nvidia-smi']) {
    try {
      fs.accessSync(fallback, fs.constants.X_OK);
      if (fs.statSync(fallback).isFile()) return fallback;
    } catch {
      // Not present at this fallback path.
    }
  }
  return null;
}

/**
 * Runs the fixed-argv `nvidia-smi` probe once. Never rejects: missing binary,
 * non-zero exit, or timeout resolves to `[]` so `vramBytes` falls back to `null`.
 */
export async function probeNvidiaSmi(options?: ProbeNvidiaSmiOptions): Promise<NvidiaSmiGpuEntry[]> {
  if (options?.executablePath === undefined && options?.spawnImpl === undefined && process.platform !== 'linux') {
    return [];
  }
  const executable = resolveNvidiaSmiExecutable(options?.executablePath);
  if (executable === null) return [];

  const spawnFn = options?.spawnImpl ?? spawn;
  const timeoutMs = options?.timeoutMs ?? NVIDIA_SMI_TIMEOUT_MS;
  const cwd = usageProbeCwd();
  const env = buildChildEnv({ cwd });

  const result = await new Promise<{ stdout: string; code: number | null; timedOut: boolean }>((resolve) => {
    let child;
    try {
      child = spawnFn(executable, [...NVIDIA_SMI_ARGS], { cwd, env });
    } catch {
      resolve({ stdout: '', code: null, timedOut: false });
      return;
    }
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already exited.
      }
      resolve({ stdout, code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < NVIDIA_SMI_CAPTURE_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', () => {
      // Ignored: failure falls back to vramBytes: null.
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: '', code: null, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, code, timedOut: false });
    });
  });

  if (result.timedOut || result.code !== 0) return [];
  return parseNvidiaSmiCsv(result.stdout);
}

/**
 * Ensures static hardware facts and the initial `nvidia-smi` VRAM probe have
 * been computed once for this process. Safe to await during `buildApp`.
 */
export async function ensureHardwareProbed(): Promise<void> {
  if (cachedStaticFacts !== null && bootProbePromise !== null) {
    await bootProbePromise;
    return;
  }
  cachedStaticFacts = readStaticHardwareFacts();
  bootProbePromise = (async () => {
    cachedNvidiaSmiEntries = await probeNvidiaSmi();
  })();
  await bootProbePromise;
}

/**
 * Explicit Refresh action (`POST /api/agents/refresh`, `POST /api/capabilities/refresh`):
 * re-reads static GPU inventory and re-runs the fixed-argv `nvidia-smi` probe,
 * updating the in-memory cache that `GET /api/capabilities` reads from.
 */
export async function refreshHardwareProbe(options?: ProbeNvidiaSmiOptions): Promise<NvidiaSmiGpuEntry[]> {
  cachedStaticFacts = readStaticHardwareFacts();
  const entries = await probeNvidiaSmi(options);
  cachedNvidiaSmiEntries = entries;
  bootProbePromise = Promise.resolve();
  return entries;
}

function readTextSync(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function cgroupSubpaths(procSelfCgroupPath: string, controller: 'v2' | 'cpu' | 'memory'): string[] {
  const raw = readTextSync(procSelfCgroupPath);
  if (!raw) return [];
  const subpaths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parts = line.trim().split(':');
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? '';
    const cgPath = (parts.slice(2).join(':') || '/').trim();
    if (!cgPath || cgPath === '/') continue;
    const rel = cgPath.replace(/^\/+/, '');
    if (!rel || rel.includes('..')) continue;
    if (controller === 'v2' && parts[0] === '0' && controllers === '') {
      subpaths.push(rel);
    } else if (controller !== 'v2' && controllers.split(',').includes(controller)) {
      subpaths.push(rel);
    }
  }
  return subpaths;
}

/**
 * Reads the effective CPU thread limit from cgroup v2 `cpu.max` (`<quota> <period>`)
 * with fallback to cgroup v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`.
 * Returns `null` when unlimited (`max` or `-1`) or unreadable.
 */
export function readCgroupCpuLimitThreads(
  cgroupDir: string = DEFAULT_CGROUP_DIR,
  procSelfCgroupPath: string = DEFAULT_PROC_SELF_CGROUP,
): number | null {
  const v2Subpaths = cgroupSubpaths(procSelfCgroupPath, 'v2');
  const v2Candidates = [
    ...v2Subpaths.map((rel) => path.join(cgroupDir, rel, 'cpu.max')),
    path.join(cgroupDir, 'cpu.max'),
  ];
  for (const filePath of v2Candidates) {
    const raw = readTextSync(filePath);
    if (raw === null) continue;
    const [quotaRaw, periodRaw] = raw.split(/\s+/);
    if (!quotaRaw || quotaRaw === 'max') continue;
    const quota = Number(quotaRaw);
    const period = periodRaw ? Number(periodRaw) : 100_000;
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      const limit = Math.round((quota / period) * 100) / 100;
      if (limit > 0) return limit;
    }
  }

  const v1Subpaths = cgroupSubpaths(procSelfCgroupPath, 'cpu');
  const v1Dirs = [
    ...v1Subpaths.map((rel) => path.join(cgroupDir, 'cpu', rel)),
    ...v1Subpaths.map((rel) => path.join(cgroupDir, 'cpu,cpuacct', rel)),
    path.join(cgroupDir, 'cpu'),
    path.join(cgroupDir, 'cpu,cpuacct'),
    cgroupDir,
  ];
  for (const dir of v1Dirs) {
    const quotaRaw = readTextSync(path.join(dir, 'cpu.cfs_quota_us'));
    if (quotaRaw === null) continue;
    const quota = Number(quotaRaw);
    if (!Number.isFinite(quota) || quota <= 0) continue;
    const periodRaw = readTextSync(path.join(dir, 'cpu.cfs_period_us'));
    const period = periodRaw !== null ? Number(periodRaw) : 100_000;
    if (Number.isFinite(period) && period > 0) {
      const limit = Math.round((quota / period) * 100) / 100;
      if (limit > 0) return limit;
    }
  }

  return null;
}

/**
 * Reads the effective memory limit in bytes from cgroup v2 `memory.max` with
 * fallback to cgroup v1 `memory.limit_in_bytes`.
 * Returns `null` when unlimited (`max` or `>= 1 PiB`) or unreadable.
 */
export function readCgroupMemoryLimitBytes(
  cgroupDir: string = DEFAULT_CGROUP_DIR,
  procSelfCgroupPath: string = DEFAULT_PROC_SELF_CGROUP,
): number | null {
  const v2Subpaths = cgroupSubpaths(procSelfCgroupPath, 'v2');
  const v2Candidates = [
    ...v2Subpaths.map((rel) => path.join(cgroupDir, rel, 'memory.max')),
    path.join(cgroupDir, 'memory.max'),
  ];
  for (const filePath of v2Candidates) {
    const parsed = parseCgroupMemoryBytes(readTextSync(filePath));
    if (parsed !== null) return parsed;
  }

  const v1Subpaths = cgroupSubpaths(procSelfCgroupPath, 'memory');
  const v1Candidates = [
    ...v1Subpaths.map((rel) => path.join(cgroupDir, 'memory', rel, 'memory.limit_in_bytes')),
    path.join(cgroupDir, 'memory', 'memory.limit_in_bytes'),
    path.join(cgroupDir, 'memory.limit_in_bytes'),
  ];
  for (const filePath of v1Candidates) {
    const parsed = parseCgroupMemoryBytes(readTextSync(filePath));
    if (parsed !== null) return parsed;
  }

  return null;
}

function parseCgroupMemoryBytes(raw: string | null): number | null {
  if (raw === null || raw === '' || raw === 'max') return null;
  if (!/^\d+$/.test(raw)) return null;
  try {
    const bytes = BigInt(raw);
    if (bytes <= 0n || bytes >= CGROUP_MEMORY_UNLIMITED_THRESHOLD) return null;
    return Number(bytes);
  } catch {
    return null;
  }
}

/**
 * Detects whether this backend is running inside a Linux container (`/.dockerenv`,
 * `/run/.containerenv`, or container cgroup markers in `/proc/self/cgroup`).
 */
export function detectContainerized(options?: {
  dockerEnvPath?: string;
  containerEnvPath?: string;
  procSelfCgroupPath?: string;
}): boolean {
  const dockerEnvPath = options?.dockerEnvPath ?? DEFAULT_DOCKERENV_PATH;
  const containerEnvPath = options?.containerEnvPath ?? DEFAULT_CONTAINERENV_PATH;
  const procSelfCgroupPath = options?.procSelfCgroupPath ?? DEFAULT_PROC_SELF_CGROUP;

  try {
    if (fs.existsSync(dockerEnvPath)) return true;
  } catch {
    // Ignore permission errors.
  }
  try {
    if (fs.existsSync(containerEnvPath)) return true;
  } catch {
    // Ignore permission errors.
  }
  const cgroupText = readTextSync(procSelfCgroupPath);
  if (cgroupText && /(?:docker|containerd|kubepods|lxc|libpod|buildkit)/i.test(cgroupText)) {
    return true;
  }
  return false;
}

/**
 * Parses a single `/proc/driver/nvidia/gpus/<bus>/information` file.
 */
export function parseProcNvidiaGpuInfo(content: string, fallbackMinor: number): {
  model: string;
  minor: number;
  excluded: boolean;
} | null {
  let model: string | null = null;
  let minor = fallbackMinor;
  let excluded = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const modelMatch = /^Model:\s*(.+)$/i.exec(line);
    if (modelMatch?.[1]) {
      model = modelMatch[1].trim();
      continue;
    }
    const minorMatch = /^Device Minor:\s*(\d+)$/i.exec(line);
    if (minorMatch?.[1]) {
      const parsed = Number(minorMatch[1]);
      if (Number.isInteger(parsed) && parsed >= 0) minor = parsed;
      continue;
    }
    const excludedMatch = /^GPU Excluded:\s*(.+)$/i.exec(line);
    if (excludedMatch?.[1] && /^yes$/i.test(excludedMatch[1].trim())) {
      excluded = true;
    }
  }

  if (!model) return null;
  return { model, minor, excluded };
}

/**
 * Reads `/proc/driver/nvidia/gpus/<bus>/information` entries on Linux.
 * Filtering against `/dev/nvidia<minor>` happens per request in `filterAccessibleNvidiaGpus`.
 */
export function readProcNvidiaGpus(
  procNvidiaGpusDir: string = DEFAULT_PROC_NVIDIA_GPUS_DIR,
): ProcNvidiaGpuEntry[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(procNvidiaGpusDir).sort();
  } catch {
    return [];
  }

  const gpus: ProcNvidiaGpuEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const busLocation = entries[i]!;
    const infoPath = path.join(procNvidiaGpusDir, busLocation, 'information');
    const content = readTextSync(infoPath);
    if (content === null) continue;
    const parsed = parseProcNvidiaGpuInfo(content, i);
    if (parsed === null || parsed.excluded) continue;
    gpus.push({
      busLocation,
      minor: parsed.minor,
      model: parsed.model,
    });
  }
  return gpus;
}

/**
 * Filters `/proc/driver/nvidia/gpus` entries to those with a matching
 * `/dev/nvidia<minor>` device node and merges cached `nvidia-smi` VRAM.
 *
 * When `/proc/driver/nvidia/gpus` is absent inside a container but `/dev/nvidia<N>`
 * device nodes and cached `nvidia-smi` entries exist, falls back to the cached
 * `nvidia-smi` entries for the exposed device nodes.
 */
function buildLinuxNvidiaGpus(
  procGpus: readonly ProcNvidiaGpuEntry[],
  devDir: string,
  smiEntries: readonly NvidiaSmiGpuEntry[],
): HostCapabilityGpu[] {
  const accessibleProc = procGpus.filter((gpu) => {
    try {
      return fs.existsSync(path.join(devDir, `nvidia${gpu.minor}`));
    } catch {
      return false;
    }
  });

  if (accessibleProc.length > 0) {
    const usedSmi = new Set<number>();
    return accessibleProc.map((procGpu, idx) => {
      let smiIdx = smiEntries.findIndex(
        (s, i) => !usedSmi.has(i) && s.model.toLowerCase() === procGpu.model.toLowerCase(),
      );
      if (smiIdx === -1 && idx < smiEntries.length && !usedSmi.has(idx)) {
        smiIdx = idx;
      }
      if (smiIdx !== -1) {
        usedSmi.add(smiIdx);
        const smi = smiEntries[smiIdx]!;
        if (smi.vramBytes !== null) {
          return {
            vendor: 'nvidia',
            model: procGpu.model,
            vramBytes: smi.vramBytes,
            source: 'smi',
          };
        }
      }
      return {
        vendor: 'nvidia',
        model: procGpu.model,
        vramBytes: null,
        source: 'proc',
      };
    });
  }

  // Fallback when `/proc/driver/nvidia` is not visible inside a container
  // runtime, gated on `/dev/nvidia<minor>` device presence.
  if (smiEntries.length > 0) {
    let devCount = 0;
    try {
      devCount = fs.readdirSync(devDir).filter((name) => /^nvidia\d+$/.test(name)).length;
    } catch {
      devCount = 0;
    }
    if (devCount > 0) {
      return smiEntries.slice(0, devCount).map((smi) => ({
        vendor: 'nvidia',
        model: smi.model,
        vramBytes: smi.vramBytes,
        source: 'smi',
      }));
    }
  }

  return [];
}

/**
 * Resolves an AMD or Intel PCI device ID (e.g. `0x744c`) against the built-in
 * table, falling back to the normalized hex device ID.
 */
export function resolvePciGpuModel(vendor: 'amd' | 'intel', rawDeviceId: string): string {
  const normalized = normalizePciHexId(rawDeviceId);
  const table = vendor === 'amd' ? AMD_PCI_MODELS : INTEL_PCI_MODELS;
  return table[normalized] ?? normalized;
}

function normalizePciHexId(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(trimmed)) return trimmed;
  if (/^[0-9a-f]+$/.test(trimmed)) return `0x${trimmed}`;
  return trimmed || 'unknown';
}

/**
 * Reads AMD (`0x1002`) and Intel (`0x8086`) GPUs from `/sys/class/drm/card<N>/device`.
 * NVIDIA (`0x10de`) and server BMC / virtual display adapters are skipped here so
 * NVIDIA detection stays strictly gated on `/proc/driver/nvidia` + `/dev/nvidia<minor>`.
 */
export function readSysfsDrmGpus(sysDrmDir: string = DEFAULT_SYS_DRM_DIR): HostCapabilityGpu[] {
  let entries: string[];
  try {
    entries = fs
      .readdirSync(sysDrmDir)
      .filter((name) => /^card\d+$/.test(name))
      .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  } catch {
    return [];
  }

  const gpus: HostCapabilityGpu[] = [];
  for (const card of entries) {
    const deviceDir = path.join(sysDrmDir, card, 'device');
    const rawVendor = readTextSync(path.join(deviceDir, 'vendor'));
    if (rawVendor === null) continue;
    const vendorHex = normalizePciHexId(rawVendor);
    const vendor: 'amd' | 'intel' | null =
      vendorHex === '0x1002' ? 'amd' : vendorHex === '0x8086' ? 'intel' : null;
    if (vendor === null) continue;

    const rawDevice = readTextSync(path.join(deviceDir, 'device')) ?? 'unknown';
    const model = resolvePciGpuModel(vendor, rawDevice);

    const rawVram = readTextSync(path.join(deviceDir, 'mem_info_vram_total'));
    let vramBytes: number | null = null;
    if (rawVram !== null && /^\d+$/.test(rawVram)) {
      const parsed = Number(rawVram);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        vramBytes = parsed;
      }
    }

    gpus.push({
      vendor,
      model,
      vramBytes,
      source: 'sysfs',
    });
  }
  return gpus;
}

/**
 * Builds the `HostCapabilityHardware` object for `GET /api/capabilities` and
 * `get_capabilities`. Spawns zero subprocesses.
 */
export function buildHostHardware(options?: HardwareDetectOptions): HostCapabilityHardware {
  if (cachedStaticFacts === null && options === undefined) {
    cachedStaticFacts = readStaticHardwareFacts();
  }
  const base = cachedStaticFacts ?? readStaticHardwareFacts();

  const platform = options?.platform ?? base.platform;
  const cpuModel = options?.cpuModel ?? base.cpuModel;
  const cpuThreads = options?.cpuThreads ?? base.cpuThreads;
  const totalMemoryBytes = options?.totalMemoryBytes ?? base.totalMemoryBytes;

  if (platform === 'darwin') {
    return {
      cpu: {
        model: cpuModel,
        threads: cpuThreads,
        limitThreads: null,
      },
      memory: {
        totalBytes: totalMemoryBytes,
        limitBytes: null,
      },
      gpus: [
        {
          vendor: 'apple',
          model: cpuModel,
          vramBytes: null,
          source: 'sysfs',
        },
      ],
      containerized: false,
    };
  }

  if (platform !== 'linux') {
    return {
      cpu: {
        model: cpuModel,
        threads: cpuThreads,
        limitThreads: null,
      },
      memory: {
        totalBytes: totalMemoryBytes,
        limitBytes: null,
      },
      gpus: [],
      containerized: false,
    };
  }

  const cgroupDir = options?.cgroupDir ?? DEFAULT_CGROUP_DIR;
  const procSelfCgroupPath =
    options?.procSelfCgroupPath ??
    (options?.cgroupDir !== undefined ? path.join(options.cgroupDir, '__nonexistent_proc_self_cgroup__') : DEFAULT_PROC_SELF_CGROUP);

  const limitThreads = readCgroupCpuLimitThreads(cgroupDir, procSelfCgroupPath);
  const limitBytes = readCgroupMemoryLimitBytes(cgroupDir, procSelfCgroupPath);

  const containerized = detectContainerized({
    dockerEnvPath:
      options?.dockerEnvPath ??
      (options?.cgroupDir !== undefined && options?.procSelfCgroupPath === undefined
        ? path.join(options.cgroupDir, '__nonexistent_dockerenv__')
        : DEFAULT_DOCKERENV_PATH),
    containerEnvPath:
      options?.containerEnvPath ??
      (options?.cgroupDir !== undefined && options?.procSelfCgroupPath === undefined
        ? path.join(options.cgroupDir, '__nonexistent_containerenv__')
        : DEFAULT_CONTAINERENV_PATH),
    procSelfCgroupPath,
  });

  const isFixtureOverride =
    options?.cgroupDir !== undefined ||
    options?.procNvidiaGpusDir !== undefined ||
    options?.devDir !== undefined ||
    options?.sysDrmDir !== undefined;

  const procNvidiaGpus =
    options?.procNvidiaGpusDir !== undefined
      ? readProcNvidiaGpus(options.procNvidiaGpusDir)
      : isFixtureOverride
        ? []
        : base.procNvidiaGpus;

  const devDir =
    options?.devDir ??
    (isFixtureOverride && options?.procNvidiaGpusDir === undefined
      ? path.join(cgroupDir, '__nonexistent_dev__')
      : DEFAULT_DEV_DIR);

  const smiEntries =
    options?.cachedNvidiaSmi !== undefined
      ? (options.cachedNvidiaSmi ?? [])
      : isFixtureOverride
        ? []
        : cachedNvidiaSmiEntries;

  const nvidiaGpus = buildLinuxNvidiaGpus(procNvidiaGpus, devDir, smiEntries);

  const drmGpus =
    options?.sysDrmDir !== undefined
      ? readSysfsDrmGpus(options.sysDrmDir)
      : isFixtureOverride
        ? []
        : base.sysfsDrmGpus;

  return {
    cpu: {
      model: cpuModel,
      threads: cpuThreads,
      limitThreads,
    },
    memory: {
      totalBytes: totalMemoryBytes,
      limitBytes,
    },
    gpus: [...nvidiaGpus, ...drmGpus],
    containerized,
  };
}
