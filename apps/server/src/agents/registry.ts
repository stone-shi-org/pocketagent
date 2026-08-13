import fs from 'node:fs';
import path from 'node:path';
import type { AgentInfo } from '@pocketagent/protocol';
import type { AgentAdapter } from './types.js';
import { createShellAdapter } from './shell.js';
import { createClaudeAdapter } from './claude.js';
import { createAgyAdapter } from './agy.js';
import { createOpencodeAdapter } from './opencode.js';

export class AgentRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentInfo[] {
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
}

export function createDefaultRegistry(options: RegistryOptions): AgentRegistry {
  const registry = new AgentRegistry();
  registry.register(createClaudeAdapter(options.claudeBin));
  registry.register(createAgyAdapter(options.agyBin));
  registry.register(createOpencodeAdapter(options.opencodeBin));
  registry.register(createShellAdapter(options.shell));
  return registry;
}

/** Resolve a bare name against PATH, or validate an absolute path. */
export function resolveExecutable(bin: string): string | null {
  if (bin.includes('/')) {
    return isExecutable(bin) ? path.resolve(bin) : null;
  }
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
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
