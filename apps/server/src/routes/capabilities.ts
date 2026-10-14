import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import {
  CAPABILITIES_VERSION,
  DARWIN_ONLY_EXECUTABLES,
  NOTABLE_EXECUTABLES,
  type HostCapabilities,
  type NotableExecutable,
} from '@pocketagent/protocol';
import { deriveSetupState } from '../agents/auth-probe.js';
import { resolveExecutable } from '../agents/registry.js';
import { readAgentDefaults } from '../db/index.js';
import type { PocketContext } from '../types.js';

export interface BuildCapabilitiesOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  osVersion?: string;
  /**
   * Optional override for executable search directories in unit tests. When
   * omitted, `resolveExecutable(bin, platform)` walks `executableSearchDirs(platform)`.
   */
  searchDirs?: readonly string[];
}

/**
 * Computes this backend's `HostCapabilities` card (`GET /api/capabilities` and
 * the `get_capabilities` MCP tool).
 *
 * Invariants (PA-133):
 * - **Zero subprocesses on read.** Agent setup state comes from `deriveSetupState`
 *   and cached `agent_defaults.last_auth_*` columns; executables are checked via
 *   filesystem `accessSync`/`statSync` in `resolveExecutable`; git remotes are
 *   parsed directly from `.git/config`.
 * - **Closed executable list.** Only `NOTABLE_EXECUTABLES` are checked, and
 *   `DARWIN_ONLY_EXECUTABLES` (`xcodebuild`, `xcrun`) are skipped on non-darwin
 *   platforms even if a binary of the same name exists on `PATH`.
 * - **No secrets or full `PATH`.** Only executable names (never resolved paths)
 *   are returned, and any userinfo (`user:token@`) embedded in a git remote URL
 *   is stripped.
 */
export async function buildHostCapabilities(
  pocket: PocketContext,
  opts?: BuildCapabilitiesOptions,
): Promise<HostCapabilities> {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  const osVersion = opts?.osVersion ?? os.release();

  const agents = pocket.agents
    .list()
    .filter((agent) => agent.id !== 'shell')
    .map((agent) => {
      const cached = readAgentDefaults(pocket.db, agent.id);
      const setup = deriveSetupState(agent.available, {
        state: cached?.last_auth_state ?? null,
        detail: cached?.last_auth_detail ?? null,
      });
      return {
        id: agent.id,
        displayName: agent.displayName,
        available: agent.available,
        setupState: setup.setupState,
        setupDetail: setup.setupDetail,
        transports: agent.transports,
        structured: agent.transports.includes('structured'),
      };
    });

  const executables: NotableExecutable[] = [];
  for (const bin of NOTABLE_EXECUTABLES) {
    if (DARWIN_ONLY_EXECUTABLES.has(bin) && platform !== 'darwin') continue;
    const candidates = bin === 'libreoffice' ? ['libreoffice', 'soffice'] : [bin];
    const found =
      opts?.searchDirs !== undefined
        ? candidates.some((c) => hasExecutableInDirs(c, opts.searchDirs!))
        : candidates.some((c) => resolveExecutable(c, platform) !== null);
    if (found) {
      executables.push(bin);
    }
  }

  const roots = pocket.workspaces.getRoots();
  const projects = await Promise.all(
    roots.map(async (root) => ({
      path: root,
      name: path.basename(root) || root,
      label: pocket.workspaces.labelFor(root),
      gitRemoteUrl: await readGitOriginUrl(root),
    })),
  );

  const pocketAgents = pocket.plannerWorkspaces.list().map((ws) => ({
    id: ws.id,
    name: ws.name,
    defaultModelId: ws.defaultModelId,
    identityPrompt: ws.identityPrompt,
    enabledTools: pocket.plannerChats.enabledToolNamesFor(ws.id),
    skills: pocket.skills.listKnownSkills(ws.id).map((s) => s.name),
  }));

  return {
    capabilitiesVersion: CAPABILITIES_VERSION,
    platform,
    arch,
    osVersion,
    description: pocket.config.hostDescription,
    tags: [...pocket.config.hostTags],
    agents,
    executables,
    projects,
    pocketAgents,
  };
}

function hasExecutableInDirs(bin: string, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      // Not present or not executable in this directory.
    }
  }
  return false;
}

/**
 * Reads `remote.origin.url` from `<root>/.git/config` (or the common git dir
 * when `<root>/.git` is a worktree/submodule `gitdir:` pointer file) without
 * spawning `git`. Strips any embedded credentials from URL-shaped remotes.
 */
export async function readGitOriginUrl(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(dotGit);
  } catch {
    return null;
  }

  const configPaths: string[] = [];
  if (stat.isDirectory()) {
    configPaths.push(path.join(dotGit, 'config'));
  } else if (stat.isFile()) {
    try {
      const pointer = await fs.promises.readFile(dotGit, 'utf8');
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (!match?.[1]) return null;
      const gitDir = path.resolve(root, match[1].trim());
      configPaths.push(path.join(gitDir, 'config'));
      try {
        const commonRaw = (await fs.promises.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
        if (commonRaw) {
          const commonDir = path.resolve(gitDir, commonRaw);
          configPaths.push(path.join(commonDir, 'config'));
        }
      } catch {
        // Not a linked worktree with a separate commondir.
      }
    } catch {
      return null;
    }
  } else {
    return null;
  }

  for (const cfgPath of configPaths) {
    try {
      const content = await fs.promises.readFile(cfgPath, 'utf8');
      const url = parseGitOriginFromConfig(content);
      if (url !== null) return sanitizeGitRemoteUrl(url);
    } catch {
      // Try next candidate config path.
    }
  }
  return null;
}

function parseGitOriginFromConfig(content: string): string | null {
  let inOriginSection = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const header = line.slice(1, -1).trim();
      inOriginSection = /^remote\s+"origin"$/i.test(header);
      continue;
    }
    if (!inOriginSection) continue;
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv?.[1]) {
      const rawVal = kv[1].trim();
      const unquoted =
        rawVal.startsWith('"') && rawVal.endsWith('"') && rawVal.length >= 2
          ? rawVal.slice(1, -1)
          : rawVal;
      if (unquoted !== '') return unquoted;
    }
  }
  return null;
}

function sanitizeGitRemoteUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
  } catch {
    // SCP-like syntax (e.g. `git@github.com:org/repo.git`) is not a WHATWG URL.
  }
  return rawUrl;
}

export const capabilitiesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/capabilities', async () => buildHostCapabilities(app.pocket));
};
