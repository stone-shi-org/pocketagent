import { describe, expect, it } from 'vitest';
import type { ChatSummary, ProjectInfo } from '@pocketagent/protocol';
import { filterLiveOnly, filterProjects } from './search.js';

function chat(title: string): ChatSummary {
  return {
    id: title,
    sessionId: null,
    conversationId: title,
    title,
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    transport: null,
    status: null,
    live: false,
    updatedAt: 0,
    messageCount: null,
    directoryBusy: false,
    busySince: null,
    adoptTargetId: null,
    cronJobId: null,
    webhookId: null,
    rateLimit: null,
    plannerChatId: null,
  };
}

function project(name: string, titles: string[], worktrees: ProjectInfo[] = []): ProjectInfo {
  return {
    cwd: `/w/${name}`,
    name,
    workspaceLabel: name,
    isGitRepo: false,
    gitBranch: null,
    gitStatus: null,
    hidden: false,
    isWorkspace: true,
    chats: titles.map(chat),
    subagents: [],
    cronJobs: [],
    webhooks: [],
    queued: [],
    worktrees,
  };
}

function worktree(branch: string, titles: string[]): ProjectInfo {
  return { ...project(branch, titles), name: `wt-${branch}`, gitBranch: branch, isWorkspace: false };
}

const projects = [
  project('notes-app', ['fix the sync bug', 'add dark mode']),
  project('interview-question-bank', ['where is the oauth callback set?']),
];

describe('filterProjects', () => {
  it('returns everything for an empty query', () => {
    expect(filterProjects(projects, '   ')).toBe(projects);
  });

  it('matches chat titles and drops projects with no match left', () => {
    const result = filterProjects(projects, 'oauth');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('interview-question-bank');
  });

  it('narrows a project to only its matching chats', () => {
    const result = filterProjects(projects, 'dark');
    expect(result[0]?.chats.map((c) => c.title)).toEqual(['add dark mode']);
  });

  it('keeps every chat when the folder name is what matched', () => {
    // Searching for a project means you want the project, not the subset of its
    // chats that happen to repeat its name.
    const result = filterProjects(projects, 'notes-app');
    expect(result[0]?.chats).toHaveLength(2);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(filterProjects(projects, '  OAuth ')).toHaveLength(1);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterProjects(projects, 'zzzz')).toEqual([]);
  });

  it('does not mutate the input', () => {
    filterProjects(projects, 'dark');
    expect(projects[0]?.chats).toHaveLength(2);
  });
});

describe('filterProjects with folded worktrees', () => {
  const withWorktrees = [
    project('agents-remote-control', ['fix the sync bug'], [
      worktree('feature-x', ['add dark mode']),
      worktree('feature-y', ['where is the oauth callback set?']),
    ]),
  ];

  it('narrows to only the worktree whose chats match, dropping its sibling', () => {
    const result = filterProjects(withWorktrees, 'oauth');
    expect(result).toHaveLength(1);
    expect(result[0]?.chats).toHaveLength(0);
    expect(result[0]?.worktrees.map((w) => w.gitBranch)).toEqual(['feature-y']);
  });

  it('matching a worktree by its branch name keeps all of that worktree’s chats', () => {
    const result = filterProjects(withWorktrees, 'feature-x');
    expect(result[0]?.worktrees).toHaveLength(1);
    expect(result[0]?.worktrees[0]?.chats).toHaveLength(1);
  });

  it('matching the main project keeps every worktree untouched', () => {
    const result = filterProjects(withWorktrees, 'agents-remote-control');
    expect(result[0]?.worktrees).toHaveLength(2);
  });
});

describe('filterLiveOnly (PA-167)', () => {
  it('keeps live chats, drops idle ones and empty folders, including nested worktrees', () => {
    const live = { ...chat('running'), live: true };
    const a = project('a', ['idle']);
    a.chats.push(live);
    const b = project('b', ['idle2']);
    const wt = project('wt', []);
    wt.chats.push({ ...chat('wt-live'), live: true });
    const c = project('c', ['idle3'], [wt]);
    const out = filterLiveOnly([a, b, c]);
    expect(out.map((p) => p.name)).toEqual(['a', 'c']);
    expect(out[0]!.chats.map((x) => x.title)).toEqual(['running']);
    expect(out[1]!.chats).toEqual([]);
    expect(out[1]!.worktrees[0]!.chats.map((x) => x.title)).toEqual(['wt-live']);
  });
});
