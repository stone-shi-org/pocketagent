import path from 'node:path';

/**
 * Pure path arithmetic for worktrees, in its own module on purpose.
 *
 * `git/worktree.ts` already imports from `projects/index.ts` (for
 * `findMainRepoCwd`), so putting these here — rather than in either of those —
 * is what lets `runs/queue.ts` and `projects/index.ts` both use them without
 * anyone importing a service to get a string function, and without an import
 * cycle. Nothing in this file touches the filesystem or spawns git.
 */

/** `feature/x` -> `feature-x`. A branch name is not a legal single path segment. */
export function slugifyBranch(branch: string): string {
  return branch.replace(/\//g, '-');
}

/**
 * Where `WorktreeService.create` will put the worktree for `branch`.
 *
 * Exported so the run queue can name the directory a delivery *will* occupy
 * before it exists. `WorktreeService.create` calls this too rather than
 * re-joining the same three segments: the queue key and the directory that
 * actually gets created have to be the same string, and two copies of this
 * formula would eventually disagree — the same argument that keeps
 * `cron-expr.ts` and `webhook-template.ts` in `packages/protocol` instead of
 * duplicated per side.
 */
export function worktreePathFor(projectCwd: string, branch: string): string {
  return path.join(projectCwd, '.worktrees', slugifyBranch(branch));
}

/**
 * If `dir` is inside a worktree (`<main>/.worktrees/<slug>/...`), returns the
 * worktree root `<main>/.worktrees/<slug>`.
 */
export function findWorktreeRoot(dir: string): string | null {
  const marker = `${path.sep}.worktrees${path.sep}`;
  const idx = dir.indexOf(marker);
  if (idx === -1) return null;
  const mainPart = dir.slice(0, idx);
  const after = dir.slice(idx + marker.length);
  const slug = after.split(path.sep)[0];
  if (!slug) return null;
  return path.join(mainPart, '.worktrees', slug);
}

/**
 * The working tree a directory belongs to — the worktree root when `dir` is
 * inside one, else `dir` itself.
 *
 * This is the identity the run queue serializes on. It is deliberately *not* a
 * containment test: a run in `<project>` does not conflict with a run in
 * `<project>/.worktrees/x`, because those are two separate checkouts and
 * blocking across them would serialize exactly the per-branch parallelism
 * worktrees exist to provide. Same working tree, or no conflict.
 *
 * A cwd *below* a tree root rolls up to it, so a session started in
 * `<tree>/apps/server` occupies `<tree>` — the same roll-up `ProjectService`
 * already applies to chat rows.
 */
export function treeRootOf(dir: string): string {
  const normalized = path.resolve(dir);
  return findWorktreeRoot(normalized) ?? normalized;
}
