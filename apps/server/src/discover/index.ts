import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Folders you have already worked in, found by asking the agents.
 *
 * Both Claude Code and Codex record the working directory of every session they
 * run, which makes their history the best available answer to "which folders
 * does this person actually use" — better than scanning the disk for anything
 * that looks like a repository, and far better than an empty picker.
 *
 * Read-only, and only ever used to *suggest* a folder. Nothing here grants
 * access to anything; adding a folder is still a separate, deliberate act.
 */

export interface DiscoveredFolder {
  path: string;
  /** Which agents have run here. */
  agents: string[];
  /** Most recent session in this directory. */
  lastUsedAt: number;
  sessions: number;
}

export interface DiscoverOptions {
  /** Defaults to `~/.claude/projects`. */
  claudeProjectsDir?: string;
  /** Defaults to `~/.codex/sessions`. */
  codexSessionsDir?: string;
  /** Bounds the scan on an install with a long history. */
  limit?: number;
}

export async function discoverFolders(
  options: DiscoverOptions = {},
): Promise<DiscoveredFolder[]> {
  const home = os.homedir();
  const claudeDir = options.claudeProjectsDir ?? path.join(home, '.claude', 'projects');
  const codexDir = options.codexSessionsDir ?? path.join(home, '.codex', 'sessions');

  const found = new Map<string, DiscoveredFolder>();
  const record = (cwd: string, agent: string, at: number): void => {
    const existing = found.get(cwd);
    if (existing) {
      if (!existing.agents.includes(agent)) existing.agents.push(agent);
      existing.lastUsedAt = Math.max(existing.lastUsedAt, at);
      existing.sessions++;
    } else {
      found.set(cwd, { path: cwd, agents: [agent], lastUsedAt: at, sessions: 1 });
    }
  };

  for (const file of await jsonlFiles(claudeDir, options.limit ?? 200)) {
    const cwd = await firstMatch(file.path, (r) =>
      typeof r.cwd === 'string' && r.cwd ? r.cwd : null,
    );
    if (cwd) record(cwd, 'claude', file.mtime);
  }

  for (const file of await jsonlFiles(codexDir, options.limit ?? 200)) {
    // Codex writes a `session_meta` header as the first record, with the cwd
    // in its payload rather than at the top level.
    const cwd = await firstMatch(file.path, (r) => {
      if (r.type !== 'session_meta') return null;
      const payload = r.payload;
      if (typeof payload !== 'object' || payload === null) return null;
      const value = (payload as Record<string, unknown>).cwd;
      return typeof value === 'string' && value ? value : null;
    });
    if (cwd) record(cwd, 'codex', file.mtime);
  }

  // Drop anything that has since been deleted or moved; suggesting a folder
  // that cannot be added is worse than not suggesting it.
  const alive: DiscoveredFolder[] = [];
  for (const folder of found.values()) {
    try {
      if ((await fs.stat(folder.path)).isDirectory()) alive.push(folder);
    } catch {
      /* gone */
    }
  }

  return alive.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Every `.jsonl` under a directory tree, newest first. */
async function jsonlFiles(
  root: string,
  limit: number,
): Promise<{ path: string; mtime: number }[]> {
  const out: { path: string; mtime: number }[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || out.length >= limit * 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Codex nests by year/month/day, so this has to recurse rather than
        // read one level the way the Claude store allows.
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.stat(full);
          if (stat.size > 0) out.push({ path: full, mtime: stat.mtimeMs });
        } catch {
          /* vanished */
        }
      }
    }
  };

  await walk(root, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** Read just enough of a transcript to answer one question about it. */
const HEAD_BYTES = 128 * 1024;

async function firstMatch(
  file: string,
  pick: (record: Record<string, unknown>) => string | null,
): Promise<string | null> {
  let text: string;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // The last line of a head read is usually cut in half.
      continue;
    }
    if (typeof record !== 'object' || record === null) continue;
    const value = pick(record as Record<string, unknown>);
    if (value) return value;
  }
  return null;
}

/**
 * Subdirectories of a path, for navigating to a folder to add.
 *
 * Dotfiles and the usual build output are left out: this is for finding a
 * project, and a picker that opens onto `.git` and `node_modules` buries the
 * thing you are looking for.
 */
export interface BrowseEntry {
  path: string;
  name: string;
  isGitRepo: boolean;
}

const BROWSE_SKIP = new Set([
  'node_modules',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  'target',
  'coverage',
]);

export async function browseDirectory(dir: string): Promise<BrowseEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: BrowseEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || BROWSE_SKIP.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    try {
      const real = await fs.realpath(full);
      if (!(await fs.stat(real)).isDirectory()) continue;
      out.push({ path: real, name: entry.name, isGitRepo: await isGitRepo(real) });
    } catch {
      /* unreadable or dangling */
    }
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
