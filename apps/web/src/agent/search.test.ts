import { describe, expect, it } from 'vitest';
import type { ChatSummary, ProjectInfo } from '@pocketagent/protocol';
import { filterProjects } from './search.js';

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
  };
}

function project(name: string, titles: string[]): ProjectInfo {
  return {
    cwd: `/w/${name}`,
    name,
    workspaceLabel: name,
    isGitRepo: false,
    gitBranch: null,
    hidden: false,
    isWorkspace: true,
    chats: titles.map(chat),
  };
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
