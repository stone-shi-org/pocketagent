import fs from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceEntry } from '@pocketagent/protocol';

export class WorkspaceError extends Error {
  override readonly name = 'WorkspaceError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'not_a_directory' | 'invalid',
  ) {
    super(message);
  }
}

/**
 * True when `target` is `root` itself or lives beneath it.
 *
 * Both arguments must already be canonicalized (symlinks resolved). We compare
 * with `path.relative` rather than `startsWith` so that `/home/me/srcEVIL` is
 * not treated as being inside `/home/me/src`.
 */
export function isContained(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Reject NUL bytes and other things that have no business in a path. */
function assertWellFormed(requested: string): void {
  if (requested.includes('\0')) {
    throw new WorkspaceError('Path contains a NUL byte.', 'invalid');
  }
  if (requested.trim().length === 0) {
    throw new WorkspaceError('Path is empty.', 'invalid');
  }
}

export class WorkspaceRegistry {
  constructor(private readonly roots: readonly string[]) {
    if (roots.length === 0) throw new Error('WorkspaceRegistry requires at least one root');
  }

  getRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Resolve a browser-supplied directory to a canonical absolute path that is
   * provably inside a configured root.
   *
   * The order matters: we resolve the *whole* path with realpath first and only
   * then test containment. Checking containment on the un-resolved string would
   * let a symlink inside a root point anywhere on the filesystem.
   */
  async resolveWorkspacePath(requested: string): Promise<string> {
    assertWellFormed(requested);

    const absolute = path.resolve(requested);

    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceError(`Directory does not exist: ${requested}`, 'not_found');
      }
      if (code === 'EACCES' || code === 'EPERM') {
        // Do not leak whether the path exists.
        throw new WorkspaceError('Directory is not accessible.', 'forbidden');
      }
      if (code === 'ELOOP') {
        throw new WorkspaceError('Too many symbolic links in path.', 'invalid');
      }
      throw new WorkspaceError(`Cannot resolve path: ${requested}`, 'invalid');
    }

    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new WorkspaceError('Path is not a directory.', 'not_a_directory');
    }

    const allowed = this.roots.some((root) => isContained(root, real));
    if (!allowed) {
      throw new WorkspaceError(
        'Directory is outside the configured workspace roots.',
        'forbidden',
      );
    }

    return real;
  }

  /** Best-effort label for the UI, e.g. `src/project` for root `/home/me`. */
  labelFor(canonicalPath: string): string {
    for (const root of this.roots) {
      if (canonicalPath === root) return path.basename(root);
      if (isContained(root, canonicalPath)) {
        return path.join(path.basename(root), path.relative(root, canonicalPath));
      }
    }
    return canonicalPath;
  }

  /**
   * Roots plus their immediate child directories. Children whose canonical path
   * escapes the root (dangling or outward-pointing symlinks) are dropped rather
   * than shown-and-then-rejected at session start.
   */
  async list(): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    const seen = new Set<string>();

    for (const root of this.roots) {
      if (!seen.has(root)) {
        seen.add(root);
        entries.push({
          path: root,
          name: root,
          isRoot: true,
          isGitRepo: await isGitRepo(root),
        });
      }

      let dirents;
      try {
        dirents = await fs.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }

      const children = dirents
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        const childPath = path.join(root, child.name);
        let real: string;
        try {
          real = await fs.realpath(childPath);
          if (!(await fs.stat(real)).isDirectory()) continue;
        } catch {
          continue;
        }
        if (!isContained(root, real) || seen.has(real)) continue;
        seen.add(real);
        entries.push({
          path: real,
          name: child.name,
          isRoot: false,
          isGitRepo: await isGitRepo(real),
        });
      }
    }

    return entries;
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}
