import type { ProjectInfo } from '@pocketagent/protocol';

/**
 * Filter the home screen by a free-text query.
 *
 * Matching a folder (by name, or a folded worktree by branch — the label
 * `ProjectList` actually shows for it) keeps everything under it, worktrees
 * included: if you searched for the project, you want the project, not the
 * subset of its chats that happen to repeat its name in their titles. When
 * the project itself does not match, its worktrees are narrowed on their own
 * terms — a query that only hits one worktree's chats should not drag its
 * siblings along, nor get dropped just because the parent folder's name
 * didn't match.
 */
export function filterProjects(projects: ProjectInfo[], search: string): ProjectInfo[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return projects;
  return filterSections(projects, needle);
}

function filterSections(projects: ProjectInfo[], needle: string): ProjectInfo[] {
  const out: ProjectInfo[] = [];
  for (const project of projects) {
    if (matchesWholesale(project, needle)) {
      out.push(project);
      continue;
    }
    const chats = project.chats.filter((c) => c.title.toLowerCase().includes(needle));
    // Specs are searchable too, and they have to be: a project whose only
    // contents are a scheduled job or a webhook would otherwise vanish from a
    // search that matched its name, which is precisely when you are looking for
    // it. Non-matching specs are filtered out of the kept project rather than
    // carried along, so a hit shows only what matched.
    const cronJobs = project.cronJobs.filter((j) => j.name.toLowerCase().includes(needle));
    const webhooks = project.webhooks.filter((w) => w.name.toLowerCase().includes(needle));
    // Queued work is searchable on the same argument, one step further: a
    // directory whose only contents are a waiting delivery is exactly the thing
    // someone typing an issue key into the box is trying to find.
    const queued = project.queued.filter(
      (q) =>
        q.title.toLowerCase().includes(needle) ||
        (q.webhookName ?? '').toLowerCase().includes(needle),
    );
    const worktrees = filterSections(project.worktrees, needle);
    if (
      chats.length > 0 ||
      cronJobs.length > 0 ||
      webhooks.length > 0 ||
      queued.length > 0 ||
      worktrees.length > 0
    ) {
      out.push({ ...project, chats, cronJobs, webhooks, queued, worktrees });
    }
  }
  return out;
}

/** A folder's own name, or a worktree's own branch, is a match for the whole subtree. */
function matchesWholesale(project: ProjectInfo, needle: string): boolean {
  return (
    project.name.toLowerCase().includes(needle) ||
    (project.gitBranch?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Every project and every worktree folded into one, as a flat list keyed by
 * `cwd` — for the handful of places that need to look a directory up by its
 * own path (e.g. "what branch is checked out at this cwd?") rather than walk
 * the tree `ProjectList` renders. A folded worktree does not stop being a
 * real, addressable directory just because the home screen groups it under
 * its main checkout.
 */
export function flattenProjects(projects: ProjectInfo[]): ProjectInfo[] {
  return projects.flatMap((p) => [p, ...flattenProjects(p.worktrees)]);
}
