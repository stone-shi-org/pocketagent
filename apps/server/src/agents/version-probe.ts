import { spawn } from 'node:child_process';
import { compareSemver, INSTALLABLE_AGENT_IDS, isCustomClaudeProviderId, type InstallableAgentId } from '@pocketagent/protocol';
import { buildChildEnv } from '../sessions/env.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';
import { recordAgentVersion, type Db } from '../db/index.js';
import type { AgentAdapter } from './types.js';
import { resolveExecutable, type AgentRegistry } from './registry.js';
import { catalogEntry } from './catalog.js';

/**
 * Generous for `<bin> --version`, which responds in <100ms for every adapter.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const CAPTURE_CAP = 16 * 1024;

/**
 * Extracts a semver string from CLI `--version` output (PA-90).
 *
 * Tolerates prefixes like 'v', words like 'codex-cli', or trailing text like '(Claude Code)'.
 * Examples:
 *   '2.1.278 (Claude Code)' -> '2.1.278'
 *   'codex-cli 0.155.1'     -> '0.155.1'
 *   'opencode v2.0.14'      -> '2.0.14'
 *   '0.85.1'                -> '0.85.1'
 *   '1.2.9'                 -> '1.2.9'
 */
export function parseCliVersion(output: string): string | null {
  const match = /(?:^|[\s/v])(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(output.trim());
  return match ? (match[1] ?? null) : null;
}

function isInstallableId(id: string): id is InstallableAgentId {
  return (INSTALLABLE_AGENT_IDS as readonly string[]).includes(id);
}

/**
 * Probes the installed CLI version by executing `<bin> --version`.
 *
 * Runs outside any workspace (in `usageProbeCwd()`) with a 5s timeout.
 * Returns null if the binary is missing, hangs, errors, or prints unparseable output.
 */
export async function probeAgentVersion(adapter: AgentAdapter): Promise<string | null> {
  if (adapter.bin === undefined) return null;
  const executable = resolveExecutable(adapter.bin);
  if (executable === null) return null;

  const cwd = usageProbeCwd();
  return new Promise<string | null>((resolve) => {
    let child;
    try {
      child = spawn(executable, ['--version'], {
        cwd,
        env: buildChildEnv({ cwd }),
      });
    } catch {
      resolve(null);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone
      }
      resolve(null);
    }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stdin?.end();
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < CAPTURE_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < CAPTURE_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const version = parseCliVersion(stdout) ?? parseCliVersion(stderr);
      resolve(version);
    });
  });
}

/**
 * Fetches the latest published version of an npm package via registry.npmjs.org.
 */
export async function fetchLatestNpmVersion(
  packageName: string,
  timeoutMs = 4000,
): Promise<string | null> {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === 'string' ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Checks what the latest available version is for an agent and whether an update is available.
 *
 * Since PA-104 the npm registry is consulted only as a *version-number
 * source*: claude, codex, opencode and pi publish the same release numbers to
 * npm as to their own installers, and it is the one uniform, unauthenticated
 * "what is latest?" endpoint all four share. Nothing is ever installed from it
 * for an official-script agent — "Update" runs the vendor's own update path
 * (`catalog.ts`). `agy` has no npm package, so it gets no hint and the UI
 * offers "Update now" regardless.
 */
export async function checkAgentLatestVersion(
  agentId: string,
  currentVersion: string | null,
  npmFetcher: (pkg: string) => Promise<string | null> = fetchLatestNpmVersion,
): Promise<{ latestVersion: string | null; hasUpdate: boolean }> {
  if (!isInstallableId(agentId)) {
    return { latestVersion: null, hasUpdate: false };
  }
  const entry = catalogEntry(agentId);
  const versionSource =
    entry.method === 'npm' ? entry.packageName : (entry.npmVersionPackage ?? entry.legacyNpmPackage);
  if (versionSource === null) return { latestVersion: null, hasUpdate: false };
  let latest = await npmFetcher(versionSource);
  if (!latest && entry.method === 'npm') {
    // Offline: an npm-method entry still has its own pin to compare against.
    latest = entry.version;
  }
  if (!currentVersion || !latest) {
    return { latestVersion: latest, hasUpdate: false };
  }
  const cmp = compareSemver(latest, currentVersion);
  return {
    latestVersion: latest,
    hasUpdate: cmp !== null && cmp > 0,
  };
}

/**
 * Re-probes version and update status for all built-in structured coding agents.
 */
export async function refreshAgentVersions(
  db: Db,
  agents: AgentRegistry,
  npmFetcher: (pkg: string) => Promise<string | null> = fetchLatestNpmVersion,
): Promise<void> {
  const adapters = agents
    .listAdapters()
    .filter((a) => a.transports.includes('structured') && !isCustomClaudeProviderId(a.id));

  await Promise.allSettled(
    adapters.map(async (adapter) => {
      const version = await probeAgentVersion(adapter);
      const { latestVersion, hasUpdate } = await checkAgentLatestVersion(adapter.id, version, npmFetcher);
      recordAgentVersion(db, adapter.id, { version, latestVersion, hasUpdate });
    }),
  );
}

/**
 * Probes and records version & update status for a single agent (used immediately post-install).
 */
export async function probeAndRecordAgentVersion(
  db: Db,
  adapter: AgentAdapter | undefined,
  npmFetcher: (pkg: string) => Promise<string | null> = fetchLatestNpmVersion,
): Promise<void> {
  if (!adapter) return;
  const version = await probeAgentVersion(adapter);
  const { latestVersion, hasUpdate } = await checkAgentLatestVersion(adapter.id, version, npmFetcher);
  recordAgentVersion(db, adapter.id, { version, latestVersion, hasUpdate });
}
