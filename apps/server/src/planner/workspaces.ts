import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isContained } from '../workspaces/index.js';

export class PlannerWorkspaceError extends Error {
  override readonly name = 'PlannerWorkspaceError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'forbidden' | 'invalid',
  ) {
    super(message);
  }
}

export interface PlannerWorkspaceRow {
  id: string;
  name: string;
  path: string;
  isDefault: boolean;
  createdAt: number;
}

/** Persistence seam, so the registry stays testable without a database. */
export interface PlannerWorkspaceStore {
  list(): PlannerWorkspaceRow[];
  insert(row: PlannerWorkspaceRow): void;
  delete(id: string): boolean;
  /** Only the display name changes — the on-disk directory keeps its
      original (slugified) name, so nothing that already resolved this
      workspace's path needs to change with it. */
  rename(id: string, name: string): void;
  /** Whether `ensureDefaultWorkspace` has already run, ever — see its doc comment. */
  isSeeded(): boolean;
  markSeeded(): void;
}

/**
 * The planner's own app-owned scratch/skills directories.
 *
 * Deliberately a second registry rather than reusing `WorkspaceRegistry`
 * (`workspaces/index.ts`): that one protects the user's real code repos —
 * PocketAgent only ever reads inside a root and checks containment, never
 * writes there unasked. A planner workspace inverts that: this app creates
 * it, and the planner's own file/exec tools (a later phase) are allowed to
 * write and delete inside it freely, the same ownership `data/pocketagent.db`
 * already has. Conflating the two would mean either loosening the guarantee
 * project workspaces give today, or refusing the planner permissions the
 * feature explicitly asks for — two different threat models, two registries.
 */
export class PlannerWorkspaceRegistry {
  private rows: PlannerWorkspaceRow[];

  constructor(private readonly store: PlannerWorkspaceStore) {
    this.rows = store.list();
  }

  list(): PlannerWorkspaceRow[] {
    return [...this.rows].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  get(id: string): PlannerWorkspaceRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  getDefault(): PlannerWorkspaceRow | undefined {
    return this.rows.find((r) => r.isDefault);
  }

  /**
   * Idempotent: creates `<root>/default` on disk and records it the first
   * time only. Seeding is tracked by a settings flag rather than "the table
   * is empty", so a user who deliberately removes the default workspace
   * later does not get it silently recreated on the next boot — the same
   * discipline `workspaces_seeded` already applies to project folders.
   *
   * The seeded *display* name is "Pocket Agent" — the on-disk directory
   * stays `default` regardless (nothing needs the two to match; `name` is
   * purely presentational and renamable, see `rename` below), but the name a
   * user actually sees for their first agent should read as one, not as an
   * implementation detail.
   */
  async ensureDefaultWorkspace(root: string): Promise<void> {
    if (this.store.isSeeded()) return;
    const defaultPath = path.join(root, 'default');
    await fs.mkdir(defaultPath, { recursive: true });
    const real = await fs.realpath(defaultPath);
    const row: PlannerWorkspaceRow = {
      id: crypto.randomUUID(),
      name: 'Pocket Agent',
      path: real,
      isDefault: true,
      createdAt: Date.now(),
    };
    this.store.insert(row);
    this.rows = [...this.rows, row];
    this.store.markSeeded();
  }

  /**
   * Create a new planner workspace as a fresh directory under `root`.
   *
   * Unlike a project workspace, the caller does not name an arbitrary
   * absolute path — a planner workspace is app-owned scratch space, so the
   * app decides where on disk it lives; the caller only names it. Directory
   * names are slugified and de-duplicated so two workspaces can share a
   * display name without colliding on disk.
   */
  async create(root: string, name: string): Promise<PlannerWorkspaceRow> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new PlannerWorkspaceError('Name must be 1-128 characters.', 'invalid');
    }
    const slug = slugify(trimmed);
    if (slug.length === 0) {
      throw new PlannerWorkspaceError(
        'Name must contain at least one letter or digit.',
        'invalid',
      );
    }
    const existingDirNames = new Set(this.rows.map((r) => path.basename(r.path)));
    let dirName = slug;
    let suffix = 2;
    while (existingDirNames.has(dirName)) {
      dirName = `${slug}-${suffix++}`;
    }
    const dirPath = path.join(root, dirName);
    await fs.mkdir(dirPath, { recursive: true });
    const real = await fs.realpath(dirPath);
    const row: PlannerWorkspaceRow = {
      id: crypto.randomUUID(),
      name: trimmed,
      path: real,
      isDefault: false,
      createdAt: Date.now(),
    };
    this.store.insert(row);
    this.rows = [...this.rows, row];
    return row;
  }

  /**
   * Forget a planner workspace. Refuses the default one — there must always
   * be at least one planner workspace for a new chat to land in. Does not
   * delete the directory itself or its `.transcripts/` (a later phase): the
   * same "removing a chat never deletes a transcript" discipline the rest of
   * this codebase applies to project chats.
   */
  remove(id: string): boolean {
    const row = this.get(id);
    if (!row) return false;
    if (row.isDefault) {
      throw new PlannerWorkspaceError('The default workspace cannot be removed.', 'forbidden');
    }
    this.store.delete(id);
    this.rows = this.rows.filter((r) => r.id !== id);
    return true;
  }

  /**
   * Rename an agent. Only the display name (`name`) changes — the on-disk
   * directory is never renamed, so every chat's stored `workspacePath` (and
   * every tool call that resolved a path against it) keeps working
   * unaffected by a purely cosmetic rename.
   */
  rename(id: string, name: string): PlannerWorkspaceRow {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new PlannerWorkspaceError('Name must be 1-128 characters.', 'invalid');
    }
    const row = this.get(id);
    if (!row) throw new PlannerWorkspaceError('Workspace not found.', 'not_found');
    this.store.rename(id, trimmed);
    const updated = { ...row, name: trimmed };
    this.rows = this.rows.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  /**
   * True when `target` (already canonicalized by the caller) resolves inside
   * one of the planner's own workspace roots. Reuses `WorkspaceRegistry`'s
   * exact containment primitive (`fs.realpath` + `path.relative`, never a
   * string prefix) rather than reimplementing it — the "did this path escape
   * the sandbox" check is identical even though the two registries guard
   * different directories. Exported for the file/exec tools a later phase
   * adds; unused by any route in phase 1.
   */
  contains(target: string): boolean {
    return this.rows.some((r) => isContained(r.path, target));
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
