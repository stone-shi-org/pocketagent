import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentInfo } from '@pocketagent/protocol';
import type { AgentAdapter } from './types.js';
import { createShellAdapter } from './shell.js';
import { createClaudeAdapter } from './claude.js';
import { createAgyAdapter } from './agy.js';
import { createOpencodeAdapter } from './opencode.js';
import { createCodexAdapter } from './codex.js';
import { createPiAdapter } from './pi.js';

export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * `defaultModel`/`defaultEffort`/`cachedModels` are deliberately absent
   * here: this registry is a static, in-memory adapter list with no `db`
   * reference, while those three fields are a per-agent DB-backed cache (see
   * `agent_defaults` in db/index.ts). `GET /api/agents` — the only consumer —
   * merges them in at the route layer, the one place that already has both.
   */
  list(): Omit<AgentInfo, 'defaultModel' | 'defaultEffort' | 'cachedModels'>[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id,
      displayName: a.displayName,
      description: a.description,
      available: a.isAvailable?.() ?? true,
      transports: a.transports,
      defaultTransport: a.defaultTransport,
      supportsSkipPermissions: a.supportsSkipPermissions ?? false,
      forcesSkipPermissions: a.forcesSkipPermissions ?? false,
    }));
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
  const registry = new AgentRegistry();
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

