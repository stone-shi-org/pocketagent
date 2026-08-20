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
    const worktrees = filterSections(project.worktrees, needle);
    if (chats.length > 0 || worktrees.length > 0) out.push({ ...project, chats, worktrees });
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
