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
        staticModels: modelListFrom(provider.models),
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
    'defaultModel' | 'defaultEffort' | 'cachedModels' | 'lastRefreshAt' | 'lastRefreshOk' | 'lastRefreshError'
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

/** Resolve a bare name against PATH and standard user bin dirs, or validate an absolute path. */
export function resolveExecutable(bin: string): string | null {
  const expanded = bin.startsWith('~') ? path.join(os.homedir(), bin.slice(1)) : bin;
  if (expanded.includes('/') || expanded.includes(path.sep)) {
    return isExecutable(expanded) ? path.resolve(expanded) : null;
  }
  const pathEnv = process.env.PATH ?? '';
  const searchDirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.cargo', 'bin'),
    path.join(os.homedir(), '.npm-global', 'bin'),
  ];
  for (const dir of searchDirs) {
    const candidate = path.join(dir, expanded);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

