import { describe, expect, it } from 'vitest';
import type { ProjectInfo } from '@pocketagent/protocol';
import { DEFAULT_EXPORT_TARGETS, exportDestinations, previewExportPath } from './skill-export.js';

function project(cwd: string, name: string, extra: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    cwd,
    name,
    workspaceLabel: name,
    isGitRepo: true,
    gitBranch: null,
    gitStatus: null,
    hidden: false,
    isWorkspace: true,
    chats: [],
    cronJobs: [],
    webhooks: [],
    queued: [],
    subagents: [],
    worktrees: [],
    ...extra,
  };
}

describe('exportDestinations', () => {
  it('lists projects and their worktrees, skipping synthetic, hidden and deleted rows', () => {
    const projects = [
      project('/src/app', 'app', {
        gitBranch: 'main',
        worktrees: [
          project('/src/app/.worktrees/feat', 'feat', { gitBranch: 'feature/x' }),
          project('/src/app/.worktrees/gone', 'gone', { isDeleted: true }),
        ],
      }),
      project('virtual:webhooks', 'Webhooks'),
      project('/src/hidden', 'hidden', { hidden: true }),
    ];
    expect(exportDestinations(projects)).toEqual([
      { cwd: '/src/app', label: 'app (main)' },
      { cwd: '/src/app/.worktrees/feat', label: 'app › feat (feature/x)' },
    ]);
  });
});

describe('previewExportPath', () => {
  it('names the exact directory each target writes', () => {
    expect(previewExportPath('/src/app/', 'claude', 'deploy-notes')).toBe(
      '/src/app/.claude/skills/deploy-notes',
    );
    expect(previewExportPath('/src/app', 'agents', 'deploy-notes')).toBe(
      '/src/app/.agents/skills/deploy-notes',
    );
  });

  it('starts with both targets selected', () => {
    expect([...DEFAULT_EXPORT_TARGETS]).toEqual(['claude', 'agents']);
  });
});
