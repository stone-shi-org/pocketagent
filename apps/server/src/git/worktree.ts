import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { findMainRepoCwd, readGitBranch } from '../projects/index.js';
import { parsePorcelainV2 } from './status.js';
import { worktreePathFor } from './worktree-paths.js';

const execFileAsync = promisify(execFile);

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
  constructor(
    message: string,
    readonly code:
      | 'not_a_repo'
      | 'invalid_branch'
      | 'branch_exists'
      | 'already_exists'
      | 'git_failed'
      | 'not_a_worktree'
      | 'dirty'
      | 'unmerged',
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
  /**
   * If true and the branch already exists:
   * - returns its `.worktrees/<slug>` checkout when that directory already exists;
   * - otherwise creates `.worktrees/<slug>` on the existing branch (fast-forwarding
   *   to `baseRef` via `-B` when the branch is already merged into `baseRef`, or
   *   checking out its existing tip when it carries unmerged commits);
   * - falls back to a suffixed branch name when the branch is already checked out
   *   in the main repo or another non-standard worktree path.
   */
  reuseExisting?: boolean;
}

export interface CreateWorktreeOutput {
  cwd: string;
  branch: string;
}

export interface WorktreeServiceOptions {
  workspaces: WorkspaceRegistry;
}

export interface RemoveWorktreeInput {
  /** Already resolved and workspace-validated, same as `create()`'s `projectCwd`. */
  worktreeCwd: string;
}

export interface RemoveWorktreeOutput {
  /** The local branch that was deleted along with the worktree. */
  branch: string;
  /** The main checkout this worktree belonged to. */
  mainCwd: string;
  /** Present only when the deleted branch had a remote-tracking branch. */
  remote: { remoteName: string; remoteBranch: string } | null;
}

export interface DeleteRemoteBranchInput {
  /** The main checkout — the worktree this branch came from is already gone by this point. */
  mainCwd: string;
  remoteName: string;
  remoteBranch: string;
}

/**
 * Creates git worktrees for existing projects, one branch each.
 *
 * Worktrees are always created nested at `<project>/.worktrees/<slug>` rather
 * than beside the project or somewhere user-chosen: a subdirectory of a
 * folder that is already a workspace root automatically satisfies
 * `WorkspaceRegistry.resolveWorkspacePath`'s containment check, so this needs
 * no new registration step and no new place the browser can point a session
 * at. It also means `ProjectService.list`'s `gitdir:`-based detection finds
 * its way back to the main checkout for free, so the worktree folds into that
 * project's card (`ProjectInfo.worktrees`) instead of showing up as an
 * unrelated one.
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
    let attachExistingBranch: 'as-is' | 'reset-to-base' | null = null;
    if (input.branchMode === 'new') {
      const requested = input.branchName?.trim() ?? '';
      await assertValidBranchName(requested);
      const exists = await branchExists(projectCwd, requested);
      if (exists) {
        if (!input.reuseExisting) {
          throw new WorktreeError(`Branch "${requested}" already exists.`, 'branch_exists');
        }
        const existingPath = worktreePathFor(projectCwd, requested);
        if (await pathExists(existingPath)) {
          if (await pathExists(path.join(existingPath, '.git'))) {
            const resolved = await this.workspaces.resolveWorkspacePath(existingPath);
            return { cwd: resolved, branch: requested };
          }
          // Broken worktree directory without a `.git` pointer — clean it up so
          // the worktree can be recreated cleanly below.
          await fs.rm(existingPath, { recursive: true, force: true });
        }
        // The local branch exists, but its `.worktrees/<slug>` directory does not
        // (e.g. a previous worktree was removed via `git worktree remove` or
        // `rm -rf` without deleting the branch ref, or the branch was created in
        // the main repo). Prune any stale worktree registration first so
        // `git worktree add` does not refuse a missing-but-registered checkout.
        await pruneWorktrees(projectCwd);
        if (await isBranchCheckedOut(projectCwd, requested)) {
          // Git refuses to check one branch out in two worktrees at once (e.g.
          // `requested` is currently checked out in the main repo or another
          // non-standard worktree path). Mint a suffixed branch off `baseRef`
          // rather than failing an unattended run.
          branch = `${requested}-${crypto.randomBytes(3).toString('hex')}`;
        } else {
          branch = requested;
          // If every commit on `requested` is already reachable from `baseRef`
          // (an older merged worktree branch left behind as `master` moved on),
          // fast-forward/reset it to `baseRef` (`-B`) so the new worktree starts
          // on current code rather than a stale ancestor. If it has unmerged
          // commits, attach to its existing tip so no work is lost.
          const merged = await isMergedInto(projectCwd, requested, baseRef).catch(() => false);
          attachExistingBranch = merged ? 'reset-to-base' : 'as-is';
        }
      } else {
        branch = requested;
      }
    } else {
      // Git refuses to check a branch out in two worktrees at once, so
      // reusing `currentBranch` here is not an option — mint a new branch
      // from the same tip instead. A short random suffix is enough to dodge
      // a same-second collision; a real collision still surfaces as a clear
      // git error rather than silently overwriting something.
      const base = currentBranch ?? 'detached';
      branch = `wt/${base}-${crypto.randomBytes(3).toString('hex')}`;
    }

    const worktreePath = worktreePathFor(projectCwd, branch);
    if (await pathExists(worktreePath)) {
      if (input.reuseExisting) {
        if (await pathExists(path.join(worktreePath, '.git'))) {
          const resolved = await this.workspaces.resolveWorkspacePath(worktreePath);
          return { cwd: resolved, branch };
        }
        await fs.rm(worktreePath, { recursive: true, force: true });
      } else {
        throw new WorktreeError(
          `${worktreePath} already exists. Remove it or pick a different branch name.`,
          'already_exists',
        );
      }
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    const addArgs =
      attachExistingBranch === 'as-is'
        ? ['worktree', 'add', worktreePath, branch]
        : attachExistingBranch === 'reset-to-base'
          ? ['worktree', 'add', '-B', branch, worktreePath, baseRef]
          : ['worktree', 'add', '-b', branch, worktreePath, baseRef];
    try {
      await execFileAsync('git', addArgs, {
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

  /**
   * Removes a linked worktree and its local branch — never a main checkout,
   * never anything with unsaved or unmerged work.
   *
   * Both gates below (uncommitted changes, then mergeability) run *before*
   * anything on disk changes, and in that order deliberately: this used to
   * remove the worktree first and delete the branch second, which was fine
   * with `git branch -D` (never fails) but turned every ordinary call into a
   * half-finished state once branch deletion became `-d` (safe) — `-d`
   * refuses anything not merged into its target, and most worktree branches
   * are, by definition, still unmerged at delete-time (that is usually the
   * whole reason a worktree for one still exists). Checking mergeability
   * first keeps the action atomic: either everything below happens, or
   * nothing does.
   */
  async remove(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutput> {
    const { worktreeCwd } = input;

    const mainCwd = await findMainRepoCwd(worktreeCwd);
    if (!mainCwd) {
      throw new WorktreeError(`${worktreeCwd} is not a linked git worktree.`, 'not_a_worktree');
    }
    const exists = await pathExists(worktreeCwd);
    if (!exists) {
      const branchName = path.basename(worktreeCwd);
      if (await branchExists(mainCwd, branchName)) {
        try {
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: mainCwd });
        } catch {
          /* ignore if branch cannot be deleted */
        }
      }
      return { branch: branchName, mainCwd, remote: null };
    }

    const hasGit = await pathExists(path.join(worktreeCwd, '.git'));
    if (!hasGit) {
      // Broken worktree directory without .git pointer. Clean up the directory and local branch.
      await fs.rm(worktreeCwd, { recursive: true, force: true });
      const branchName = path.basename(worktreeCwd);
      if (await branchExists(mainCwd, branchName)) {
        try {
          await execFileAsync('git', ['branch', '-D', branchName], { cwd: mainCwd });
        } catch {
          /* ignore if branch cannot be deleted */
        }
      }
      try {
        await execFileAsync('git', ['worktree', 'prune'], { cwd: mainCwd });
      } catch {
        /* ignore */
      }
      return { branch: branchName, mainCwd, remote: null };
    }

    const branch = await readGitBranch(worktreeCwd);
    if (!branch) {
      // A detached-HEAD worktree — never produced by `create()`, which always
      // checks out a named branch, but a worktree could have been made by
      // hand outside this app. There is no branch to delete alongside it, so
      // this is refused rather than guessing at "just remove the worktree".
      throw new WorktreeError(
        `${worktreeCwd} has no branch checked out (detached HEAD); not removable from here.`,
        'not_a_worktree',
      );
    }

    // Fresh, uncached — this feeds a destructive decision, unlike
    // `GitStatusTracker`'s 15s-stale reads for the home-screen poll.
    if ((await freshGitStatus(worktreeCwd)) === 'dirty') {
      throw new WorktreeError('Worktree has uncommitted changes. Commit or discard them first.', 'dirty');
    }

    const remote = await readUpstream(mainCwd, branch);

    // Merge target: the branch's own upstream if it has one, else the main
    // checkout's current branch — the base a worktree is normally forked
    // from (see `create()`'s `baseRef`). Falls back to the main checkout's
    // raw `HEAD` if that, too, is detached.
    const mergeTarget = remote
      ? `${remote.remoteName}/${remote.remoteBranch}`
      : ((await readGitBranch(mainCwd)) ?? 'HEAD');

    if (!(await isMergedInto(mainCwd, branch, mergeTarget))) {
      throw new WorktreeError(
        `Branch "${branch}" has commits not merged into ${mergeTarget}. Merge it, or delete the branch manually, before deleting this worktree.`,
        'unmerged',
      );
    }

    try {
      await execFileAsync('git', ['worktree', 'remove', worktreeCwd], { cwd: mainCwd });
    } catch (err) {
      throw new WorktreeError(gitErrorMessage(err), 'git_failed');
    }

    try {
      await execFileAsync('git', ['branch', '-d', branch], { cwd: mainCwd });
    } catch (err) {
      // The worktree is already gone at this point — the mergeability check
      // above should make this unreachable outside a same-instant race (a
      // commit landing on `branch` between that check and this delete).
      throw new WorktreeError(gitErrorMessage(err), 'git_failed');
    }

    return { branch, mainCwd, remote };
  }

  /**
   * Deletes a branch on a remote. Only ever called with the exact
   * `{ remoteName, remoteBranch }` pair `remove()` itself returned moments
   * earlier — never a name the browser invents — after the user opts in to
   * a follow-up prompt.
   */
  async deleteRemoteBranch(input: DeleteRemoteBranchInput): Promise<void> {
    try {
      await execFileAsync('git', ['push', input.remoteName, '--delete', input.remoteBranch], {
        cwd: input.mainCwd,
      });
    } catch (err) {
      throw new WorktreeError(gitErrorMessage(err), 'git_failed');
    }
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
 * Best-effort `git worktree prune`, so a worktree directory that was deleted
 * out-of-band (`rm -rf`) does not leave a stale `.git/worktrees/<slug>` entry
 * that makes `git worktree add` or `git worktree list` think the branch is
 * still checked out.
 */
async function pruneWorktrees(projectCwd: string): Promise<void> {
  try {
    await execFileAsync('git', ['worktree', 'prune'], { cwd: projectCwd });
  } catch {
    // Best-effort — see comment above.
  }
}

/**
 * Whether `branch` is currently checked out in any live worktree (including
 * the main checkout). Must be called after `pruneWorktrees` so missing
 * directories do not count as checked out.
 */
async function isBranchCheckedOut(projectCwd: string, branch: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectCwd,
    });
    const targetLine = `branch refs/heads/${branch}`;
    return stdout.split('\n').some((line) => line.trim() === targetLine);
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

/**
 * A fresh, uncached `git status`, for the one caller (`remove()`) that must
 * never act on a stale "clean" reading. Deliberately bypasses
 * `GitStatusTracker` — see that class's own doc comment for why its 15s
 * cache is fine for a 5s home-screen poll but wrong for a destructive
 * decision.
 */
async function freshGitStatus(cwd: string) {
  const { stdout } = await execFileAsync(
    'git',
    ['status', '--porcelain=2', '--branch', '--untracked-files=normal'],
    { cwd },
  );
  return parsePorcelainV2(stdout);
}

/**
 * A branch's remote-tracking branch, or `null` if it has none. Queried via
 * `for-each-ref` rather than `rev-parse @{u}` so a missing upstream is a
 * blank field rather than a thrown error to catch.
 */
async function readUpstream(
  repoCwd: string,
  branch: string,
): Promise<{ remoteName: string; remoteBranch: string } | null> {
  const { stdout } = await execFileAsync(
    'git',
    ['for-each-ref', '--format=%(upstream:remotename)\t%(upstream:remoteref)', `refs/heads/${branch}`],
    { cwd: repoCwd },
  );
  const [remoteName = '', remoteRef = ''] = stdout.trim().split('\t');
  if (!remoteName || !remoteRef) return null;
  return { remoteName, remoteBranch: remoteRef.replace(/^refs\/heads\//, '') };
}

/** Whether every commit on `branch` is reachable from `target` — i.e. `git branch -d branch` would succeed. */
async function isMergedInto(repoCwd: string, branch: string, target: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', branch, target], { cwd: repoCwd });
    return true;
  } catch (err) {
    // Exit code 1 is `git merge-base --is-ancestor`'s documented "no" answer,
    // not a failure — anything else (e.g. `target` doesn't resolve) must not
    // be silently read as "merged".
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 1) {
      return false;
    }
    throw new WorktreeError(gitErrorMessage(err), 'git_failed');
  }
}

function gitErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  return err instanceof Error ? err.message : 'git worktree add failed.';
}
