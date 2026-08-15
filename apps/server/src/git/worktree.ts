import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { readGitBranch } from '../projects/index.js';

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
  constructor(
    message: string,
    readonly code: 'not_a_repo' | 'invalid_branch' | 'branch_exists' | 'already_exists' | 'git_failed',
  ) {
    super(message);
  }
}

export interface CreateWorktreeInput {
  /** Already resolved and workspace-validated, same as `SessionManager.create`'s `cwd`. */
  projectCwd: string;
  branchMode: 'new' | 'current';
  /** Required when `branchMode` is `'new'`. */
  branchName?: string;
}

export interface CreateWorktreeOutput {
  cwd: string;
  branch: string;
}

export interface WorktreeServiceOptions {
  workspaces: WorkspaceRegistry;
}

/**
 * Creates git worktrees for existing projects, one branch each.
 *
 * Worktrees are always created nested at `<project>/.worktrees/<slug>` rather
 * than beside the project or somewhere user-chosen: a subdirectory of a
 * folder that is already a workspace root automatically satisfies
 * `WorkspaceRegistry.resolveWorkspacePath`'s containment check, so this needs
 * no new registration step and no new place the browser can point a session
 * at. It also means a created worktree shows up as its own project row for
 * free (a project is a folder you added, or a directory inside one).
 */
export class WorktreeService {
  private readonly workspaces: WorkspaceRegistry;

  constructor(options: WorktreeServiceOptions) {
    this.workspaces = options.workspaces;
  }

  async create(input: CreateWorktreeInput): Promise<CreateWorktreeOutput> {
    const { projectCwd } = input;
    if (!(await isGitRepo(projectCwd))) {
      throw new WorktreeError('Not a git repository.', 'not_a_repo');
    }

    const currentBranch = await readGitBranch(projectCwd);
    const baseRef = currentBranch ?? 'HEAD';

    let branch: string;
    if (input.branchMode === 'new') {
      const requested = input.branchName?.trim() ?? '';
      await assertValidBranchName(requested);
      if (await branchExists(projectCwd, requested)) {
        throw new WorktreeError(`Branch "${requested}" already exists.`, 'branch_exists');
      }
      branch = requested;
    } else {
      // Git refuses to check a branch out in two worktrees at once, so
      // reusing `currentBranch` here is not an option — mint a new branch
      // from the same tip instead. A short random suffix is enough to dodge
      // a same-second collision; a real collision still surfaces as a clear
      // git error rather than silently overwriting something.
      const base = currentBranch ?? 'detached';
      branch = `wt/${base}-${crypto.randomBytes(3).toString('hex')}`;
    }

    const worktreePath = path.join(projectCwd, '.worktrees', slugify(branch));
    if (await pathExists(worktreePath)) {
      throw new WorktreeError(
        `${worktreePath} already exists. Remove it or pick a different branch name.`,
        'already_exists',
      );
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    try {
      await execFileAsync('git', ['worktree', 'add', '-b', branch, worktreePath, baseRef], {
        cwd: projectCwd,
      });
    } catch (err) {
      throw new WorktreeError(gitErrorMessage(err), 'git_failed');
    }

    await excludeWorktreesDir(projectCwd);

    // Belt-and-suspenders: this should always be contained since it's nested
    // under an already-validated project directory, but every other endpoint
    // that hands a directory to `sessions.create` re-resolves it, and this
    // one is no exception.
    const resolved = await this.workspaces.resolveWorkspacePath(worktreePath);
    return { cwd: resolved, branch };
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Directory-segment-safe form of a branch name: hierarchical refs like `feature/x` collapse to one segment. */
function slugify(branch: string): string {
  return branch.replace(/\//g, '-');
}

/** Lets git itself be the source of truth for ref-name rules rather than reinventing them. */
async function assertValidBranchName(name: string): Promise<void> {
  if (!name) throw new WorktreeError('A branch name is required.', 'invalid_branch');
  try {
    await execFileAsync('git', ['check-ref-format', '--branch', name]);
  } catch {
    throw new WorktreeError(`"${name}" is not a valid branch name.`, 'invalid_branch');
  }
}

async function branchExists(projectCwd: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: projectCwd,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort: keeps `.worktrees/` out of the user's own `git status` without
 * touching a tracked `.gitignore`. Never fails the request — a worktree that
 * shows up as untracked is a cosmetic problem, not a reason to roll back a
 * `git worktree add` that already succeeded.
 */
async function excludeWorktreesDir(projectCwd: string): Promise<void> {
  const excludePath = path.join(projectCwd, '.git', 'info', 'exclude');
  try {
    const existing = await fs.readFile(excludePath, 'utf8').catch(() => '');
    if (existing.split('\n').some((line) => line.trim() === '.worktrees/')) return;
    const withNewline = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, `${withNewline}.worktrees/\n`);
  } catch {
    // Not fatal — see comment above.
  }
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  return err instanceof Error ? err.message : 'git worktree add failed.';
}
