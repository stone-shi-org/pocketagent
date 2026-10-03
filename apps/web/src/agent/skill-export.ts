import {
  SKILL_PROJECT_DIRS,
  type ProjectInfo,
  type SkillExportTarget,
} from '@pocketagent/protocol';

/**
 * PA-55: the pure half of the "Export to project…" dialog, kept out of the
 * component so it can be tested in this project's node-only environment.
 */

export interface ExportDestination {
  cwd: string;
  /** What the picker shows: the project's name, and the branch for a worktree. */
  label: string;
}

/**
 * Every directory the home screen lists as a project, worktrees included, in
 * the order it lists them. Synthetic rows (`virtual:` cwds such as the
 * webhooks group) and deleted worktrees are left out: neither is a directory
 * a skill could be written into. The server re-checks containment on every
 * export anyway, so this list is a convenience, not the boundary.
 */
export function exportDestinations(projects: readonly ProjectInfo[]): ExportDestination[] {
  const out: ExportDestination[] = [];
  const seen = new Set<string>();
  const visit = (p: ProjectInfo, parent: ProjectInfo | null): void => {
    if (p.cwd.startsWith('virtual:') || p.isDeleted || p.hidden) return;
    if (!seen.has(p.cwd)) {
      seen.add(p.cwd);
      const branch = p.gitBranch ? ` (${p.gitBranch})` : '';
      out.push({
        cwd: p.cwd,
        label: parent ? `${parent.name} › ${p.name}${branch}` : `${p.name}${branch}`,
      });
    }
    for (const wt of p.worktrees) visit(wt, p);
  };
  for (const p of projects) visit(p, null);
  return out;
}

/** Where one target will put the skill. Mirrors the server's `path.join`
    (`SKILL_PROJECT_DIRS` is the shared table), shown before anything is
    written, so the user sees the exact path they are approving. */
export function previewExportPath(
  projectPath: string,
  target: SkillExportTarget,
  slug: string,
): string {
  const base = projectPath.replace(/\/+$/, '');
  return `${base}/${SKILL_PROJECT_DIRS[target]}/${slug}`;
}

/** Both targets start on: the reviewer asked for both by default with the
    user choosing (PA-55), rather than this app picking one convention. */
export const DEFAULT_EXPORT_TARGETS: readonly SkillExportTarget[] = ['claude', 'agents'];

export const EXPORT_TARGET_LABELS: Readonly<Record<SkillExportTarget, string>> = {
  claude: 'Claude Code',
  agents: 'Codex and other agents',
};
