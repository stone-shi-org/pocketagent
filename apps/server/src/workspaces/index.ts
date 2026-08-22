import fs from 'node:fs/promises';
import { homedir } from 'node:os';
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

/**
 * The folders agents may run in.
 *
 * These used to be fixed in the environment. They are now a list the user
 * curates from the UI, stored in the database and seeded from configuration on
 * first run — a static list could not express "add this repo I just cloned"
 * without an ssh session and a restart.
 *
 * What did *not* change is the check itself: a session's working directory must
 * still resolve inside one of these. The browser cannot name an arbitrary path
 * and have an agent started there; it can only name one of the folders someone
 * deliberately added. That is a weaker boundary than a fixed allowlist and it
 * is worth being clear about, but it is the boundary the feature asks for, and
 * adding a folder stays an explicit, separately audited act.
 */
export class WorkspaceRegistry {
  private roots: string[];

  constructor(
    seed: readonly string[],
    private readonly store?: WorkspaceStore,
  ) {
    this.roots = store ? store.load([...seed]) : [...seed];
  }

  getRoots(): readonly string[] {
    return this.roots;
  }

  /**
   * Add a folder. Any absolute directory on this host is allowed — that is the
   * point — but it must exist, be a directory, and be readable, and `/` is
   * refused because "every file on the machine" is never a project.
   *
   * `create: true` makes a missing folder no longer an error: this is how the
   * picker offers "make a new folder and use it" without a separate mkdir
   * endpoint. Only a `not_found` is retried this way — a path that exists but
   * is not a directory, or is not accessible, fails exactly as before.
   */
  async add(requested: string, opts: { create?: boolean } = {}): Promise<string> {
    assertWellFormed(requested);
    let real: string;
    try {
      real = await this.canonicalDirectory(requested);
    } catch (err) {
      if (opts.create && err instanceof WorkspaceError && err.code === 'not_found') {
        const absolute = path.resolve(
          requested.startsWith('~') ? path.join(homedir(), requested.slice(1)) : requested,
        );
        try {
          await fs.mkdir(absolute, { recursive: true });
        } catch (mkdirErr) {
          throw new WorkspaceError(
            `Could not create folder: ${(mkdirErr as Error).message}`,
            'forbidden',
          );
        }
        real = await this.canonicalDirectory(requested);
      } else {
        throw err;
      }
    }
    if (real === '/') {
      throw new WorkspaceError('Refusing to use "/" as a project folder.', 'forbidden');
    }
    if (!this.roots.includes(real)) {
      this.roots = [...this.roots, real].sort();
      this.store?.add(real);
    }
    return real;
  }

  /** Forget a folder. Sessions already running in it are left alone. */
  remove(path: string): boolean {
    if (!this.roots.includes(path)) return false;
    this.roots = this.roots.filter((r) => r !== path);
    this.store?.remove(path);
    return true;
  }

  /** Resolve and validate a directory without adding it, for the picker. */
  async canonicalDirectory(requested: string): Promise<string> {
    const absolute = path.resolve(
      requested.startsWith('~') ? path.join(homedir(), requested.slice(1)) : requested,
    );
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceError(`Directory does not exist: ${requested}`, 'not_found');
      }
      throw new WorkspaceError('Directory is not accessible.', 'forbidden');
    }
    if (!(await fs.stat(real)).isDirectory()) {
      throw new WorkspaceError('Path is not a directory.', 'not_a_directory');
    }
    return real;
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

  /**
   * Short, unambiguous label: `~/src/project`.
   *
   * Folders are arbitrary now, so two of them can share a basename. The home
   * directory is abbreviated because that prefix is on almost every path here
   * and carries no information.
   */
  labelFor(canonicalPath: string): string {
    const home = homedir();
    if (canonicalPath === home) return '~';
    return canonicalPath.startsWith(`${home}/`)
      ? `~/${canonicalPath.slice(home.length + 1)}`
      : canonicalPath;
  }

  /**
   * The folders themselves — no longer their children.
   *
   * Listing every immediate subdirectory turned `venv`, `__pycache__` and
   * `test-reports` into projects, which is not what any of them are. A folder
   * is a project because someone added it.
   */
  async list(): Promise<WorkspaceEntry[]> {
    const entries: WorkspaceEntry[] = [];
    for (const root of this.roots) {
      entries.push({
        path: root,
        name: path.basename(root) || root,
        isRoot: true,
        isGitRepo: await isGitRepo(root),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Persistence seam, so the registry stays testable without a database. */
export interface WorkspaceStore {
  /** Returns the stored folders, seeding from `seed` the first time only. */
  load(seed: string[]): string[];
  add(path: string): void;
  remove(path: string): void;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Database-backed folder list.
 *
 * Seeds from configuration exactly once, tracked by a flag rather than by the
 * table being empty: removing your last folder must not resurrect the ones you
 * started with on the next boot.
 */
export function createWorkspaceStore(db: {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
  list: () => string[];
  insert: (path: string) => void;
  delete: (path: string) => boolean;
}): WorkspaceStore {
  const SEEDED = 'workspaces_seeded';
  return {
    load(seed) {
      if (db.read(SEEDED) === null) {
        for (const path of seed) db.insert(path);
        db.write(SEEDED, new Date().toISOString());
      }
      return db.list();
    },
    add: (path) => db.insert(path),
    remove: (path) => void db.delete(path),
  };
}
