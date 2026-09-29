import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlannerChat, PlannerWorkspace } from '@pocketagent/protocol';
import { PocketAgentsSection } from './PocketAgentsSection.js';

describe('PocketAgentsSection (PA-106)', () => {
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
});
