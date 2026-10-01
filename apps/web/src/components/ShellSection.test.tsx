import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ShellSessionSummary } from '@pocketagent/protocol';
import { ShellSection } from './ShellSection.js';
import type { ProjectsState } from './ProjectList.js';
import { HostProvider } from '../hosts/HostContext.js';
import { hostEndpoint } from '../api/host.js';
import { saveShellCollapsed } from '../hosts/tree-pref.js';

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

describe('ShellSection (PA-117)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const dummyShell = {
    id: 'shell-1',
    sessionId: 'session-1',
    conversationId: null,
    title: 'zsh',
    cwd: '/data/repo',
    cwdLabel: 'repo',
    live: true,
    adopted: false,
    adoptTargetId: null,
    updatedAt: 1000,
  } as unknown as ShellSessionSummary;

  const dummyState = {
    shells: [dummyShell],
    clearFinishedShells: async () => {},
    detachChat: async () => {},
    removeChat: async () => {},
    reattachChat: async () => {},
    recreateAndAttachChat: async () => {},
  } as unknown as ProjectsState;

  it('renders expanded by default when no preference is saved', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ShellSection
          state={dummyState}
          open={() => {}}
          onNewShell={() => {}}
        />
      </HostProvider>,
    );

    expect(html).toContain('zsh');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('project-caret closed');
  });

  it('renders collapsed when shellCollapsed is saved in tree preferences for this host', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveShellCollapsed('host-1', true);

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-1', '/h/host-1')}>
        <ShellSection
          state={dummyState}
          open={() => {}}
          onNewShell={() => {}}
        />
      </HostProvider>,
    );

    expect(html).not.toContain('zsh');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('project-caret closed');
  });

  it('preserves host isolation for shell section collapse state', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    saveShellCollapsed('host-1', true);
    // host-2 not collapsed

    const htmlHost2 = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-2', '/h/host-2')}>
        <ShellSection
          state={dummyState}
          open={() => {}}
          onNewShell={() => {}}
        />
      </HostProvider>,
    );

    expect(htmlHost2).toContain('zsh');
    expect(htmlHost2).toContain('aria-expanded="true"');
  });
});
