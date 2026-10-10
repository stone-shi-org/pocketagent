import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlannerChat, PlannerWorkspace } from '@pocketagent/protocol';
import { PocketAgentsSection } from './PocketAgentsSection.js';

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

describe('PocketAgentsSection (PA-106)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const workspaces: PlannerWorkspace[] = [
    {
      id: 'ws-1',
      name: 'Agent Alpha',
      path: '/path/alpha',
      isDefault: true,
      createdAt: 1000,
      defaultModelId: null,
      memoryEnabled: false,
      lastConsolidatedAt: null,
      mcpEnabled: false,
      identityPrompt: null,
      liveProvider: 'pipeline',
    },
  ];

  it('renders regular chats directly and does not render scheduled jobs folder when none exist', () => {
    const chats: PlannerChat[] = [
      {
        id: 'chat-1',
        workspaceId: 'ws-1',
        workspaceName: 'Agent Alpha',
        title: 'Regular Chat 1',
        lastModelId: null,
        createdAt: 1000,
        lastActivityAt: 1000,
        skipToolApprovalsEnabled: false,
        busy: false,
        thinkingEnabled: true,
      },
    ];

    const html = renderToStaticMarkup(
      <PocketAgentsSection
        workspaces={workspaces}
        chats={chats}
        refresh={async () => {}}
        onOpenChat={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('Regular Chat 1');
    expect(html).not.toContain('Scheduled jobs');
  });

  it('renders scheduled jobs in collapsible subfolder and limits to latest 10', () => {
    const chats: PlannerChat[] = [];

    // 1 regular chat
    chats.push({
      id: 'reg-1',
      workspaceId: 'ws-1',
      workspaceName: 'Agent Alpha',
      title: 'Interactive Chat',
      lastModelId: null,
      createdAt: 5000,
      lastActivityAt: 5000,
      skipToolApprovalsEnabled: false,
      busy: false,
      thinkingEnabled: true,
    });

    // 15 scheduled chats with timestamps
    for (let i = 1; i <= 15; i++) {
      chats.push({
        id: `cron-chat-${i}`,
        workspaceId: 'ws-1',
        workspaceName: 'Agent Alpha',
        title: `Nightly Sync #${i} (2026-09-26 00:${String(i).padStart(2, '0')})`,
        lastModelId: null,
        createdAt: 1000 + i * 10,
        lastActivityAt: 1000 + i * 10,
        skipToolApprovalsEnabled: false,
        cronJobId: 'job-1',
        busy: false,
        thinkingEnabled: true,
      });
    }

    // When rendered with activeChatId matching one of the cron chats, the group auto-expands
    const html = renderToStaticMarkup(
      <PocketAgentsSection
        workspaces={workspaces}
        chats={chats}
        activeChatId="cron-chat-1"
        refresh={async () => {}}
        onOpenChat={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('Interactive Chat');
    expect(html).toContain('Scheduled jobs');
    // Count badge displays total (15)
    expect(html).toContain('15');
    // First 10 visible
    expect(html).toContain('Nightly Sync #1 (2026-09-26 00:01)');
    expect(html).toContain('Nightly Sync #10 (2026-09-26 00:10)');
    // 11th through 15th are omitted due to max 10 limit
    expect(html).not.toContain('Nightly Sync #11');
    expect(html).not.toContain('Nightly Sync #15');
    // Hint displayed
    expect(html).toContain('Showing latest 10 runs');
  });

  it('renders collapsed workspace when saved in tree preferences for this host', async () => {
    const { saveCollapsedPocketAgents } = await import('../hosts/tree-pref.js');
    const { HostProvider } = await import('../hosts/HostContext.js');
    const { hostEndpoint } = await import('../api/host.js');

    const chats: PlannerChat[] = [
      {
        id: 'chat-1',
        workspaceId: 'ws-1',
        workspaceName: 'Agent Alpha',
        title: 'Regular Chat 1',
        lastModelId: null,
        createdAt: 1000,
        lastActivityAt: 1000,
        skipToolApprovalsEnabled: false,
        busy: false,
        thinkingEnabled: true,
      },
    ];

    vi.stubGlobal('localStorage', fakeStorage());
    saveCollapsedPocketAgents('host-alpha', ['ws-1']);

    const html = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-alpha', '/h/host-alpha')}>
        <PocketAgentsSection
          workspaces={workspaces}
          chats={chats}
          refresh={async () => {}}
          onOpenChat={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    // Collapsed: shows caret closed and doesn't render chat rows
    expect(html).toContain('project-caret closed');
    expect(html).not.toContain('Regular Chat 1');

    // Another host is not collapsed
    const htmlBeta = renderToStaticMarkup(
      <HostProvider endpoint={hostEndpoint('host-beta', '/h/host-beta')}>
        <PocketAgentsSection
          workspaces={workspaces}
          chats={chats}
          refresh={async () => {}}
          onOpenChat={() => {}}
          onApiError={() => {}}
        />
      </HostProvider>,
    );

    expect(htmlBeta).not.toContain('project-caret closed');
    expect(htmlBeta).toContain('Regular Chat 1');
  });

  it('renders code-server button pointing to workspace folder when codeServerBaseUrl is configured (PA-130)', () => {
    const htmlWithoutCodeServer = renderToStaticMarkup(
      <PocketAgentsSection
        workspaces={workspaces}
        chats={[]}
        refresh={async () => {}}
        onOpenChat={() => {}}
        onApiError={() => {}}
        codeServerBaseUrl={null}
      />,
    );
    expect(htmlWithoutCodeServer).not.toContain('Open Agent Alpha in code-server');

    const htmlWithCodeServer = renderToStaticMarkup(
      <PocketAgentsSection
        workspaces={workspaces}
        chats={[]}
        refresh={async () => {}}
        onOpenChat={() => {}}
        onApiError={() => {}}
        codeServerBaseUrl="https://code.example.com"
      />,
    );
    expect(htmlWithCodeServer).toContain('aria-label="Open Agent Alpha in code-server"');
    expect(htmlWithCodeServer).toContain('href="https://code.example.com/?folder=%2Fpath%2Falpha"');
  });
});
