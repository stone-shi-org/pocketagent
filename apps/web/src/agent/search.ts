import type { ProjectInfo } from '@pocketagent/protocol';

/**
 * Filter the home screen by a free-text query.
 *
 * Matching a folder keeps all of its chats: if you searched for the project,
 * you want the project, not the subset of its chats that happen to repeat its
 * name in their titles.
 */
export function filterProjects(projects: ProjectInfo[], search: string): ProjectInfo[] {
  const needle = search.trim().toLowerCase();
  if (!needle) return projects;

  const out: ProjectInfo[] = [];
  for (const project of projects) {
    if (project.name.toLowerCase().includes(needle)) {
      out.push(project);
      continue;
    }
    const chats = project.chats.filter((c) => c.title.toLowerCase().includes(needle));
    if (chats.length > 0) out.push({ ...project, chats });
  }
  return out;
}
