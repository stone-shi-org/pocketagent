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
});
