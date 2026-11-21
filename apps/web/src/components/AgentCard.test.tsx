import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PlannerChat, SessionInfo } from '@pocketagent/protocol';
import { hostEndpoint } from '../api/host.js';
import { HostProvider } from '../hosts/HostContext.js';
import { AgentCard } from './AgentCard.js';
import { PlannerAgentCard } from './PlannerAgentCard.js';
import { QueuedRunCard } from './QueuedRunCard.js';

const endpoint = hostEndpoint('local', '');

const makeSession = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: 's1',
    title: 'Investigate why Kanban card titles were truncated on the Agents board',
    agent: 'agy',
    agentDisplayName: 'Antigravity',
    cwd: '/repos/pocketagent/.worktrees/feature-ui',
    workspaceLabel: 'repos/pocketagent/.worktrees/feature-ui',
    status: 'running',
    cols: 0,
    rows: 0,
    pid: 123,
    exitCode: null,
    exitSignal: null,
    createdAt: Date.now() - 120_000,
    startedAt: Date.now() - 120_000,
    endedAt: null,
    lastActivityAt: Date.now() - 10_000,
    attachedClients: 0,
    epoch: 'e1',
    backend: 'direct',
    transport: 'structured',
    agentSessionId: null,
    durable: false,
    adopted: false,
    adoptTargetId: null,
    skipPermissionsEnabled: false,
    providerDisclosure: null,
    voiceModeEnabled: false,
    busy: false,
    busySince: null,
    rateLimit: null,
    pendingApprovalsCount: 0,
    lastTurnEndedAt: null,
    unread: false,
    ...over,
  }) as SessionInfo;

const renderWithHost = (node: JSX.Element): string =>
  renderToStaticMarkup(<HostProvider endpoint={endpoint}>{node}</HostProvider>);

describe('AgentCard (PA-182)', () => {
  it('puts agent display name on the icon tooltip and shows project, worktree, and branch in the subtitle', () => {
    const html = renderWithHost(
      <AgentCard
        session={makeSession({ unread: true })}
        project={{
          projectName: 'pocketagent',
          projectKey: '/repos/pocketagent',
          worktreeName: 'feature-ui',
          gitBranch: 'feature/ui',
        }}
        provenance={{ cronJobId: null, webhookId: 'wh-1', plannerChatId: null, mcpClient: null }}
        onOpen={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('title="Antigravity"');
    expect(html).toContain('<span class="agent-card-project">pocketagent</span>');
    expect(html).toContain('/ feature-ui');
    expect(html).toContain('<span>feature/ui</span>');
    // Stock agent name is not repeated inside the subtitle meta
    expect(html).not.toContain('Antigravity ·');
    // PA-165 unread green dot + unread card border class
    expect(html).toContain('live-dot--unread');
    expect(html).toContain('agent-card--unread');
    // Provenance badge
    expect(html).toContain('<span>Webhook</span>');
  });

  it('renders yellow approval dot, approval card highlight, and auto-approve badge', () => {
    const html = renderWithHost(
      <AgentCard
        session={makeSession({
          busy: true,
          busySince: Date.now() - 60_000,
          pendingApprovalsCount: 2,
          skipPermissionsEnabled: true,
        })}
        onOpen={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('live-dot--approval');
    expect(html).toContain('agent-card--approval');
    expect(html).toContain('2 approvals');
    expect(html).toContain('Auto-approve');
  });

  it('surfaces custom Claude provider name tag in subtitle while keeping Claude mascot tint', () => {
    const html = renderWithHost(
      <AgentCard
        session={makeSession({
          agent: 'custom-claude:deepseek',
          agentDisplayName: 'Claude (DeepSeek)',
        })}
        onOpen={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('agent-mascot--claude');
    expect(html).toContain('Claude (DeepSeek)');
  });
});

describe('PlannerAgentCard (PA-182)', () => {
  const makeChat = (over: Partial<PlannerChat> = {}): PlannerChat =>
    ({
      id: 'pc-1',
      workspaceId: 'pw-1',
      workspaceName: 'Chief of Staff',
      title: 'Draft weekly roadmap update',
      lastModelId: 'gpt-4o',
      createdAt: Date.now() - 600_000,
      lastActivityAt: Date.now() - 30_000,
      skipToolApprovalsEnabled: false,
      busy: false,
      awaitingApproval: false,
      unread: true,
      docWorkspaceName: 'Q4-Docs',
      ...over,
    }) as PlannerChat;

  it('renders unread Pocket Agent card without a destructive corner button', () => {
    const html = renderWithHost(
      <PlannerAgentCard chat={makeChat({ unread: true, busy: false })} onOpen={() => {}} onApiError={() => {}} />,
    );

    expect(html).toContain('Draft weekly roadmap update');
    expect(html).toContain('Chief of Staff');
    expect(html).toContain('/ Q4-Docs');
    expect(html).toContain('live-dot--unread');
    expect(html).toContain('agent-card--unread');
    expect(html).not.toContain('agent-card-stop');
  });

  it('renders interrupt button and running dot while a Pocket Agent turn is busy', () => {
    const html = renderWithHost(
      <PlannerAgentCard
        chat={makeChat({ busy: true, unread: false, skipToolApprovalsEnabled: true })}
        onOpen={() => {}}
        onApiError={() => {}}
      />,
    );

    expect(html).toContain('live-dot--running');
    expect(html).toContain('agent-card-stop');
    expect(html).toContain('Interrupt current turn');
    expect(html).toContain('Auto-approve');
  });
});

describe('QueuedRunCard (PA-182)', () => {
  it('renders queue position, project/branch, and webhook label', () => {
    const html = renderWithHost(
      <QueuedRunCard
        queued={{
          cwd: '/repos/pocketagent',
          project: {
            projectName: 'pocketagent',
            projectKey: '/repos/pocketagent',
            worktreeName: null,
            gitBranch: 'main',
          },
          item: {
            id: 'q-1',
            kind: 'webhook',
            title: '[PA-182] Add more information on Agents view',
            webhookId: 'wh-jira',
            webhookName: 'Jira Intake',
            sessionId: null,
            agent: 'agy',
            agentDisplayName: 'Antigravity',
            position: 1,
            queuedAt: Date.now() - 60_000,
            skipPermissionsEnabled: false,
            resumesConversationId: null,
          },
        }}
        onOpenSession={() => {}}
        onOpenWebhook={() => {}}
      />,
    );

    expect(html).toContain('agent-card--queued');
    expect(html).toContain('#1');
    expect(html).toContain('pocketagent');
    expect(html).toContain('main');
    expect(html).toContain('Jira Intake');
  });
});
