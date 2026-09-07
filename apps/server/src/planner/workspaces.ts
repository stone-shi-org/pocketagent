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
  /** This agent's own default model, or `null` to fall back to the global
      last-used model (`readPlannerSettings().lastModelId`) — see
      `PlannerChatService.create`. No FK: a model removed from the catalog
      just means the fallback kicks in, never a broken reference. */
  defaultModelId: string | null;
  /** PA-29: whether this agent's memory system is on — see
      `PlannerMemory`'s (protocol package) doc comment for what this gates. */
  memoryEnabled: boolean;
  /** PA-29 phase 3: when `MemoryConsolidationService` last ran for this
      agent. `null` until its ticker has processed this agent at least once. */
  lastConsolidatedAt: number | null;
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
  setDefaultModelId(id: string, modelId: string | null): void;
  /** Re-points an existing row at a different (already realpath-resolved)
      directory — see `PlannerWorkspaceRegistry.setPath`'s doc comment. */
  setPath(id: string, newPath: string): void;
  /** PA-29 phase 4: the memory system's own on/off switch for one agent. */
  setMemoryEnabled(id: string, enabled: boolean): void;
  /** PA-29 phase 3: written by `MemoryConsolidationService` after it
      finishes processing this agent (including a cycle with nothing new to
      fold — see that service's own doc comment for why the marker still
      advances then). */
  setLastConsolidatedAt(id: string, at: number): void;
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
      defaultModelId: null,
      memoryEnabled: true,
      lastConsolidatedAt: null,
    };
    this.store.insert(row);
    this.rows = [...this.rows, row];
    this.store.markSeeded();
  }

  /**
   * Create a new planner workspace, either as a fresh directory under `root`
   * (the original behavior — the app decides where it lives, the caller only
   * names it, directory names slugified/de-duplicated so two workspaces can
   * share a display name without colliding on disk) or, when `opts.path` is
   * given, pointed at an arbitrary directory the caller chose.
   *
   * The latter is a deliberate widening, mirroring `WorkspaceRegistry.add`'s
   * own `create` flag for project folders: passing `opts.path` is the moment
   * this agent's tools (write_file, exec_command, rmdir, ...) are handed full
   * read/write/delete trust over that directory, forever — the same trust an
   * auto-created scratch folder already has, just for a directory a human
   * picked rather than one this app generated. `opts.create` allows a
   * not-yet-existing directory (mkdir'd here) the same way `WorkspaceRegistry
   * .add({create: true})` does; without it, the path must already exist.
   */
  async create(
    root: string,
    name: string,
    opts?: { path?: string; create?: boolean },
  ): Promise<PlannerWorkspaceRow> {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 128) {
      throw new PlannerWorkspaceError('Name must be 1-128 characters.', 'invalid');
    }

    let real: string;
    if (opts?.path) {
      real = await this.resolveWorkspaceDirectory(opts.path, !!opts.create);
    } else {
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
      real = await fs.realpath(dirPath);
    }

    const row: PlannerWorkspaceRow = {
      id: crypto.randomUUID(),
      name: trimmed,
      path: real,
      isDefault: false,
      createdAt: Date.now(),
      defaultModelId: null,
      memoryEnabled: true,
      lastConsolidatedAt: null,
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
   * Set (or clear, with `null`) this agent's own default model — the
   * "each agent should be able to configure their own model" half of PA-6
   * round 4's bigger ask. Deliberately not validated against the model
   * catalog: a model row can be deleted later without this having to be
   * cleaned up in lockstep, the same "dangling id just means the fallback
   * kicks in" reasoning `planner_chats.last_model_id` already relies on.
   */
  setDefaultModelId(id: string, modelId: string | null): PlannerWorkspaceRow {
    const row = this.get(id);
    if (!row) throw new PlannerWorkspaceError('Workspace not found.', 'not_found');
    this.store.setDefaultModelId(id, modelId);
    const updated = { ...row, defaultModelId: modelId };
    this.rows = this.rows.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  /**
   * PA-29 phase 4: turn this agent's memory system on or off — trivially
   * reversible (unlike `setPath`), so the editor needs no confirmation step,
   * only the standing disclosure text CLAUDE.md's PA-6-round-5 invariant
   * already requires for every persistent toggle in this feature.
   */
  setMemoryEnabled(id: string, enabled: boolean): PlannerWorkspaceRow {
    const row = this.get(id);
    if (!row) throw new PlannerWorkspaceError('Workspace not found.', 'not_found');
    this.store.setMemoryEnabled(id, enabled);
    const updated = { ...row, memoryEnabled: enabled };
    this.rows = this.rows.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  /**
   * PA-29 phase 3: record that `MemoryConsolidationService` just finished a
   * pass over this agent — called whether or not that pass actually wrote
   * any long-term memories, so "nothing new since last time" still advances
   * the marker instead of re-scanning the same growing window forever (see
   * that service's own doc comment).
   */
  setLastConsolidatedAt(id: string, at: number): PlannerWorkspaceRow {
    const row = this.get(id);
    if (!row) throw new PlannerWorkspaceError('Workspace not found.', 'not_found');
    this.store.setLastConsolidatedAt(id, at);
    const updated = { ...row, lastConsolidatedAt: at };
    this.rows = this.rows.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  /**
   * Re-point an *existing* agent at a different directory — PA-6 round 5:
   * "currently, it lacks a way to change existing agent workspace
   * directory." Same validation `create`'s `opts.path` branch already does
   * (must exist unless `opts.create` is set, must be a directory, must not
   * collide with another agent's directory).
   *
   * Deliberately does **not** move anything on disk. A chat's transcript
   * lives at `<path at the time>/.transcripts/<chatId>.jsonl`, and
   * `PlannerChatService.workspacePathFor` reads this row's `path` fresh on
   * every turn — so the moment this returns, every existing chat in this
   * agent starts reading and writing under the *new* directory, and
   * whatever transcripts sat under the old one are simply no longer
   * reachable through this agent (the files themselves are untouched,
   * exactly like removing a chat never deletes its transcript). The editor
   * is responsible for disclosing this before calling it — the same
   * "explicit action, and it's logged" posture as pointing a path at
   * creation, just for a repoint instead of a first pick.
   */
  async setPath(id: string, requested: string, opts?: { create?: boolean }): Promise<PlannerWorkspaceRow> {
    const row = this.get(id);
    if (!row) throw new PlannerWorkspaceError('Workspace not found.', 'not_found');
    const real = await this.resolveWorkspaceDirectory(requested, !!opts?.create, id);
    this.store.setPath(id, real);
    const updated = { ...row, path: real };
    this.rows = this.rows.map((r) => (r.id === id ? updated : r));
    return updated;
  }

  /**
   * Shared by `create`'s `opts.path` branch and `setPath`: resolve `requested`
   * to a real, existing directory (creating it first if `create` is true),
   * and reject it if it collides with another agent's directory.
   * `excludeId` lets `setPath` re-point an agent at the directory it already
   * has without tripping its own collision check.
   */
  private async resolveWorkspaceDirectory(requested: string, create: boolean, excludeId?: string): Promise<string> {
    const absolute = path.resolve(requested);
    if (create) {
      await fs.mkdir(absolute, { recursive: true });
    }
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw new PlannerWorkspaceError(`${requested} does not exist. Pass createPath to create it.`, 'invalid');
    }
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) {
      throw new PlannerWorkspaceError(`${requested} is not a directory.`, 'invalid');
    }
    if (this.rows.some((r) => r.path === real && r.id !== excludeId)) {
      throw new PlannerWorkspaceError('Another agent already uses this exact directory.', 'invalid');
    }
    return real;
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
