import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectInfo } from '@pocketagent/protocol';
import { ProjectList, type ProjectsState } from './ProjectList.js';
import { HostProvider } from '../hosts/HostContext.js';
import { hostEndpoint } from '../api/host.js';
import { saveCollapsedProjects } from '../hosts/tree-pref.js';

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe('ProjectList tree status (PA-117)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dummyProject = {
    name: 'my-project',
    cwd: '/data/repo/my-project',
    chats: [
      {
        id: 'chat-1',
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        title: 'Project Chat 1',
        agent: 'claude',
        agentDisplayName: 'Claude Code',
        transport: 'structured',
        status: null,
        live: false,
        updatedAt: 1000,
        messageCount: 5,
        directoryBusy: false,
        busySince: null,
        adoptTargetId: null,
        cronJobId: null,
        webhookId: null,
        rateLimit: null,
        plannerChatId: null,
      },
    ],
    worktrees: [],
    cronJobs: [],
    webhooks: [],
    queued: [],
  } as unknown as ProjectInfo;

  const dummyState = {
    projects: [dummyProject],
    shells: [],
    host: null,
    hostCompatibility: null,
    error: null,
    refresh: async () => {},
    open: () => {},
  } as unknown as ProjectsState;

  it('renders project chats by default when no collapse preference exists', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ProjectList
          state={dummyState}
          search=""
          emptyHint="Nothing here"
          onAddProject={() => {}}
          onCompose={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    expect(html).toContain('Project Chat 1');
    expect(html).not.toContain('project-caret closed');
  });

  it('renders project collapsed when saved in tree preferences for this host', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveCollapsedProjects('host-1', ['/data/repo/my-project']);

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ProjectList
          state={dummyState}
          search=""
          emptyHint="Nothing here"
          onAddProject={() => {}}
          onCompose={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    expect(html).not.toContain('Project Chat 1');
    expect(html).toContain('project-caret closed');
  });

  it('preserves host isolation for collapsed project folders', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveCollapsedProjects('host-1', ['/data/repo/my-project']);

    const htmlHost2 = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-2', '/h/host-2')}>
        <ProjectList
          state={dummyState}
          search=""
          emptyHint="Nothing here"
          onAddProject={() => {}}
          onCompose={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    expect(htmlHost2).toContain('Project Chat 1');
    expect(htmlHost2).not.toContain('project-caret closed');
  });

  // PA-131: on a phone a long list put "Add a project folder" a full scroll
  // away, so it is the + on the Projects heading — and the old bottom row is gone.
  function render(search: string): string {
    return renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ProjectList
          state={dummyState}
          search={search}
          emptyHint="Nothing here"
          onAddProject={() => {}}
          onCompose={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );
  }

  it('puts the add-folder action on the Projects heading, before any project', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const html = render('');
    const add = html.indexOf('aria-label="Add a project folder"');
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeGreaterThan(html.indexOf('>Projects</h2>'));
    expect(add).toBeLessThan(html.indexOf('Project Chat 1'));
    expect(html).not.toContain('>Add a project folder<');
  });

  it('hides the add-folder action while the heading reads "Results"', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const html = render('Project');
    expect(html).toContain('>Results</h2>');
    expect(html).not.toContain('Add a project folder');
  });

  it('renders git icon, current branch, and git status badge for git projects (PA-173)', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const gitState = {
      ...dummyState,
      projects: [
        {
          ...dummyProject,
          name: 'git-repo',
          cwd: '/data/repo/git-repo',
          isGitRepo: true,
          gitBranch: 'feature/pa-173',
          gitStatus: 'dirty',
          worktrees: [
            {
              ...dummyProject,
              name: 'wt-1',
              cwd: '/data/repo/git-repo/.worktrees/wt-1',
              isGitRepo: true,
              gitBranch: 'worktree-branch',
              gitStatus: 'clean',
              worktrees: [],
            },
          ],
        },
        {
          ...dummyProject,
          name: 'plain-folder',
          cwd: '/data/repo/plain-folder',
          isGitRepo: false,
          gitBranch: null,
          gitStatus: null,
        },
      ],
    } as unknown as ProjectsState;

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ProjectList
          state={gitState}
          search=""
          emptyHint="Nothing here"
          onAddProject={() => {}}
          onCompose={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    expect(html).toContain('project-git-badge--dirty');
    expect(html).toContain('project-git-icon');
    expect(html).toContain('>feature/pa-173</span>');
    expect(html).toContain('project-git-status--dirty');
    expect(html).toContain('title="feature/pa-173 · Uncommitted changes"');

    // Non-git project does not render a git badge, and nested worktree uses its own branch row without duplicating the badge
    const badgeMatches = html.match(/class="project-git-badge/g) ?? [];
    expect(badgeMatches).toHaveLength(1);
  });
});
