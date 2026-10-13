import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCustomClaudeProviderId, type AgentInfo } from '@pocketagent/protocol';
import type { AgentAdapter } from './types.js';
import { createShellAdapter } from './shell.js';
import { createClaudeAdapter } from './claude.js';
import { createAgyAdapter } from './agy.js';
import { createOpencodeAdapter } from './opencode.js';
import { createCodexAdapter } from './codex.js';
import { createPiAdapter } from './pi.js';
import { createClaudeProviderAdapter, modelListFrom } from './claude-provider.js';

/**
 * One custom Claude provider, resolved far enough to build an adapter from.
 *
 * Declared here rather than in `custom-providers-store.ts` so the dependency
 * runs one way only: the store imports the registry (it has to, it keeps the
 * registry in sync), and the registry must not import the store back.
 *
 * `apiKey` is the *decrypted* key, or `null` when it could not be decrypted —
 * a wrong or missing `POCKETAGENT_SETTINGS_ENC_KEY`. Null is registered rather
 * than skipped, so the provider still appears (greyed out, via
 * `isAvailable()`'s existing key check) instead of vanishing from the roster
 * while its row is plainly still there in Settings.
 */
export interface CustomClaudeProviderRegistration {
  /** Full agent id, `custom-claude:<...>`. */
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: string[];
  defaultModel: string;
  smallModel: string | null;
  allowUnattended: boolean;
  supportsEffort?: boolean;
}

export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  /**
   * The `claude` binary custom providers are built against. They are the same
   * CLI as the stock adapter with an environment block in front, so the
   * registry has to remember which binary that is in order to build one after
   * boot, when `RegistryOptions` is long out of scope.
   */
  constructor(private readonly claudeBin: string = 'claude') {}

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * The adapters themselves, in `list()`'s order.
   *
   * `list()` returns the browser-facing projection, which deliberately drops
   * the server-internal fields (`structuredKind`, `requiresAttendedUse`,
   * `authProbe`). PA-68's authentication probe needs one of those, so it needs
   * the adapters rather than their projection — kept read-only, and in the
   * same order, so a caller iterating this sees the picker's ordering too.
   */
  listAdapters(): readonly AgentAdapter[] {
    return this.ordered();
  }

  /**
   * Insert or replace a user-managed Claude provider (PA-28), live.
   *
   * This is the one dynamic part of an otherwise static registry, and it is
   * what makes "add a provider in Settings and use it immediately" work: the
   * store calls this inside the same request that wrote the row, so the very
   * next `GET /api/agents` already reflects it. Replacing rather than merging,
   * because the row *is* the whole definition — an edit that dropped a model
   * from the list must not leave the old adapter's catalog behind.
   */
  registerCustomProvider(provider: CustomClaudeProviderRegistration): void {
    this.register(
      createClaudeProviderAdapter({
        id: provider.id,
        displayName: provider.name,
        description: `Claude Code running against ${provider.name}`,
        // Reads naturally in the disclosure sentence, which is the only place
        // this is used: "runs Claude Code against <label>, not Anthropic."
        providerLabel: `${provider.name} (${provider.baseUrl})`,
        bin: this.claudeBin,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.defaultModel,
        smallModel: provider.smallModel,
        staticModels: modelListFrom(provider.models, provider.supportsEffort !== false),
        // The per-provider opt-in, straight through the field the route checks
        // already read (`structuredAgentProblem`). Off means the PA-19
        // behaviour exactly: refused for cron jobs and inbound webhooks.
        requiresAttendedUse: !provider.allowUnattended,
      }),
    );
  }

  /** Forget a custom provider. A no-op for an id that was never registered. */
  unregisterCustomProvider(id: string): void {
    // Guarded, so a caller passing a built-in id by mistake cannot delete a
    // real agent out of the roster for the rest of the process's life.
    if (!isCustomClaudeProviderId(id)) return;
    this.adapters.delete(id);
  }

  /**
   * `defaultModel`/`defaultEffort`/`cachedModels`/`lastRefreshAt`/
   * `lastRefreshOk`/`lastRefreshError` are deliberately absent here: all six
   * fields are a per-agent DB-backed cache (see `agent_defaults` in
   * db/index.ts) and this registry holds no `db` reference. `GET /api/agents`
   * (and `POST /api/agents/refresh`, which answers the same shape) — the only
   * consumers — merge them in at the route layer, the one place that already
   * has both.
   */
  list(): Omit<
    AgentInfo,
    | 'defaultModel'
    | 'defaultEffort'
    | 'cachedModels'
    | 'lastRefreshAt'
    | 'lastRefreshOk'
    | 'lastRefreshError'
    | 'setupState'
    | 'setupDetail'
    | 'lastInstallAt'
    | 'lastInstallOk'
    | 'lastInstallError'
    | 'installedVersion'
    | 'latestVersion'
    | 'hasUpdate'
    | 'resolvedPath'
    | 'officialInstall'
    | 'otherCopies'
  >[] {
    return this.ordered().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      available: a.isAvailable?.() ?? true,
      transports: a.transports,
      defaultTransport: a.defaultTransport,
      supportsSkipPermissions: a.supportsSkipPermissions ?? false,
      forcesSkipPermissions: a.forcesSkipPermissions ?? false,
      staticModels: a.staticModels ?? [],
      providerDisclosure: a.providerDisclosure ?? null,
      binOverridden: isExplicitPath(a.bin),
    }));
  }

  /**
   * Built-ins in registration order, with custom providers spliced in
   * immediately *after* `claude` — the PA-19 ordering rule, preserved now that
   * a provider can arrive long after boot instead of during it. Together in
   * the picker so the family reads as one, but never before stock `claude`:
   * `ComposerPage` defaults to the first available agent, and a provider must
   * not become the default flavour for new chats just by existing.
   */
  private ordered(): AgentAdapter[] {
    const all = [...this.adapters.values()];
    const custom = all
      .filter((a) => isCustomClaudeProviderId(a.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
    if (custom.length === 0) return all;
    const builtIn = all.filter((a) => !isCustomClaudeProviderId(a.id));
    const afterClaude = builtIn.findIndex((a) => a.id === 'claude') + 1;
    return [...builtIn.slice(0, afterClaude), ...custom, ...builtIn.slice(afterClaude)];
  }
}

export interface RegistryOptions {
  shell: string;
  claudeBin: string;
  agyBin: string;
  opencodeBin: string;
  codexBin: string;
  piBin: string;
}

export function createDefaultRegistry(options: RegistryOptions): AgentRegistry {
  const registry = new AgentRegistry(options.claudeBin);
  registry.register(createClaudeAdapter(options.claudeBin));
  registry.register(createAgyAdapter(options.agyBin));
  registry.register(createOpencodeAdapter(options.opencodeBin));
  registry.register(createCodexAdapter(options.codexBin));
  registry.register(createPiAdapter(options.piBin));
  registry.register(createShellAdapter(options.shell));
  return registry;
}

/**
 * Whether a configured executable names an explicit path rather than a bare
 * name to be resolved.
 *
 * The distinction is load-bearing for PA-68 rather than cosmetic: an explicit
 * path takes the early return in `resolveExecutable` below, so none of the
 * fallback directories — including the on-demand install prefix — is ever
 * consulted for that agent. An install would then succeed and stay invisible.
 * Shared with `AgentRegistry.list`'s `binOverridden` so the rule is stated
 * once. `undefined` (an adapter that declares no `bin`) is not an override.
 */
export function isExplicitPath(bin: string | undefined): boolean {
  if (bin === undefined) return false;
  const expanded = bin.startsWith('~') ? path.join(os.homedir(), bin.slice(1)) : bin;
  return expanded.includes('/') || expanded.includes(path.sep);
}

/**
 * Where the agents' *official* installers put their launchers, in the order a
 * login shell sees them (PA-104).
 *
 * These come **before** the server's own `PATH`, and that is the fix for
 * PA-104 rather than a preference. The server has to run the same binary a
 * human gets from `bash -lc <agent>` on the same host, and the official
 * installers make that true for a login shell by prepending exactly these
 * directories (opencode's installer writes `~/.opencode/bin` into the shell
 * rc; claude's, codex's and agy's link into `~/.local/bin`; pi's managed mode
 * links into `~/.local/bin`, or `~/.pi/agent/bin` when nothing better is on
 * PATH). A service manager's `PATH` usually lacks all of them and carries
 * `/usr/bin` instead — where stale system-npm copies live (`/usr/bin/codex`
 * 0.147.0 on stone-dev01, while the official copy was 0.157.0) — so trusting
 * `PATH` first would pick the wrong copy for the same reason PA-92's
 * "install prefix first" rule did.
 *
 * `~/.opencode/bin` precedes `~/.local/bin` because that is the order the
 * installers leave in a login PATH; no agent currently installs into both.
 */
export function officialAgentBinDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.pi', 'agent', 'bin'),
  ];
}

/**
 * The live `agentInstallPrefix`, supplied by `app.ts` after the config exists
 * (a module-level default, because `resolveExecutable` is called from adapter
 * code with no config in scope). Read on every resolution, so changing the
 * setting takes effect without a restart — the same `live: true` promise the
 * install service's own `installPrefix` closure keeps.
 */
let installPrefixes: () => string[] = () => [];

export function setAgentInstallPrefixSource(source: () => string[]): void {
  installPrefixes = source;
}

/**
 * `<prefix>/bin` for npm-method installs: `~/.npm-global/bin` always (the
 * default prefix, and where every pre-PA-104 Settings install went) plus the
 * configured `agentInstallPrefix` when it differs.
 *
 * These are searched **last**, after `PATH`, and are removed from their
 * position in `PATH` if a deployment put them there (the container image
 * used to put `~/.npm-global/bin` first). That is PA-104's "no
 * `~/.npm-global` copy may shadow the official one", stated as an ordering:
 * a copy here is found only when nothing else is, which is exactly the
 * npm-fallback case, and otherwise it is reported as an extra copy.
 */
export function installPrefixBinDirs(): string[] {
  const home = os.homedir();
  // An operator who pointed the prefix at `~/.local` must not thereby demote
  // `~/.local/bin`, which is where the official installs live.
  const official = new Set(officialAgentBinDirs().map(normalizeDir));
  return unique([
    path.join(home, '.npm-global', 'bin'),
    ...installPrefixes().map((p) => path.join(p.replace(/\/+$/, ''), 'bin')),
  ]).filter((dir) => !official.has(normalizeDir(dir)));
}

/**
 * Directories searched in addition to `PATH` for a bare executable name.
 *
 * Exported because an npm-method install prefix has to be one of these or an
 * install lands somewhere this server never looks — `GET
 * /api/agents/installable` reports that as `prefixDetectable: false`.
 * `~/.cargo/bin` is kept from before; `~/.bun/bin` and `~/.deno/bin` stay
 * absent — this list grows on evidence, not on speculation.
 */
export function agentBinSearchDirs(): string[] {
  const home = os.homedir();
  return unique([...officialAgentBinDirs(), path.join(home, '.cargo', 'bin'), ...installPrefixBinDirs()]);
}

/**
 * Homebrew bin directories on macOS (`/opt/homebrew/bin` on Apple Silicon,
 * `/usr/local/bin` on Intel) (PA-126).
 *
 * `launchd` starts services with a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * and macOS's `/usr/libexec/path_helper` reads `/etc/paths` (`/usr/local/bin`,
 * `/usr/bin`, …) which omits `/opt/homebrew/bin`. When the server's `PATH`
 * carries `/usr/bin` — a real system `PATH`, not a test fixture's isolated
 * scratch directory — Homebrew's bin directories are placed ahead of `/usr/bin`
 * on `darwin` (still after `officialAgentBinDirs()`, which always win).
 */
export function darwinSystemBinDirs(
  pathDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'darwin') return [];
  if (!pathDirs.some((dir) => normalizeDir(dir) === '/usr/bin')) return [];
  return ['/opt/homebrew/bin', '/usr/local/bin'];
}

/**
 * The full search order for a bare name: official locations, then `PATH`
 * (minus the install-prefix directories, plus Homebrew on `darwin`), then
 * `~/.cargo/bin`, then the install prefix. One function so resolution, the
 * "other copies" report and post-install verification cannot disagree about
 * which copy runs.
 */
export function executableSearchDirs(platform: NodeJS.Platform = process.platform): string[] {
  const home = os.homedir();
  const prefixBins = installPrefixBinDirs();
  const demoted = new Set(prefixBins.map(normalizeDir));
  const pathDirs = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .filter((dir) => !demoted.has(normalizeDir(dir)));
  return unique([
    ...officialAgentBinDirs(),
    ...darwinSystemBinDirs(pathDirs, platform),
    ...pathDirs,
    path.join(home, '.cargo', 'bin'),
    ...prefixBins,
  ]);
}

/**
 * Re-applies the server's agent `PATH` priority inside a POSIX login shell
 * (`sh`, `bash`, `zsh`, `dash`, `ksh`) before running `command` (PA-104, PA-126).
 *
 * The Docker image achieves this with `/etc/profile.d/10-pocketagent-path.sh`
 * and `/etc/zsh/zshenv`. Neither exists on a bare-metal Linux or macOS host:
 * `/etc/profile` on Debian/Ubuntu overwrites `PATH` unconditionally, and on
 * macOS `/etc/zprofile` and `/etc/profile` run `/usr/libexec/path_helper -s`
 * (which moves `/usr/local/bin:/usr/bin:/bin` to the front of `PATH`, pushing
 * `~/.opencode/bin`, `~/.local/bin`, `~/.pi/agent/bin` and `/opt/homebrew/bin`
 * behind them), while `zsh -lc` is non-interactive and never sources
 * `~/.zshrc` (where the official installers write their `PATH` exports on
 * macOS). Prepending the high-priority directories and appending the fallback
 * directories after `-l` has finished sourcing profiles keeps `exec_command` /
 * `bash` and `resolveExecutable` in agreement on bare metal without needing
 * container-only `/etc` files.
 */
export function wrapLoginShellCommand(
  shell: string,
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const base = path.basename(shell);
  if (!['sh', 'bash', 'zsh', 'dash', 'ksh'].includes(base)) {
    return command;
  }
  const home = os.homedir();
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const prepend = unique([...officialAgentBinDirs(), ...darwinSystemBinDirs(pathDirs, platform)]);
  const append = unique([path.join(home, '.cargo', 'bin'), ...installPrefixBinDirs()]);
  const quote = (dirs: string[]) =>
    dirs.map((d) => `'${d.replace(/'/g, "'\\''")}'`).join(path.delimiter);
  return `export PATH=${quote(prepend)}:"$PATH":${quote(append)}\n${command}`;
}

/** Resolve a bare name against the search order above, or validate an explicit path. */
export function resolveExecutable(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return findExecutableCandidates(bin, platform)[0]?.path ?? null;
}

/**
 * Every executable a bare name resolves to, in search order — the first is the
 * one that runs (PA-104). An explicit path yields at most itself.
 *
 * Deduplicated by directory, not by real path: two entries that resolve to the
 * same file are both returned, so a caller can tell "a second copy" (different
 * `realPath`) from "a second link to the same copy" and only report the first.
 */
export function findExecutableCandidates(
  bin: string,
  platform: NodeJS.Platform = process.platform,
): { path: string; realPath: string }[] {
  const expanded = bin.startsWith('~') ? path.join(os.homedir(), bin.slice(1)) : bin;
  if (isExplicitPath(bin)) {
    return isExecutable(expanded) ? [withRealPath(path.resolve(expanded))] : [];
  }
  const found: { path: string; realPath: string }[] = [];
  for (const dir of executableSearchDirs(platform)) {
    const candidate = path.join(dir, expanded);
    if (isExecutable(candidate)) found.push(withRealPath(candidate));
  }
  return found;
}

function withRealPath(candidate: string): { path: string; realPath: string } {
  try {
    return { path: candidate, realPath: fs.realpathSync(candidate) };
  } catch {
    return { path: candidate, realPath: candidate };
  }
}

function normalizeDir(dir: string): string {
  return path.resolve(dir).replace(/\/+$/, '');
}

function unique(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const key = normalizeDir(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

