import { describe, expect, it } from 'vitest';
import type { PlannerChat, ProjectInfo, QueuedRunSummary, SessionInfo } from '@pocketagent/protocol';
import { agentAccentClass, agentIconName } from './agent-icon.js';
import {
  activeFleetPlannerChats,
  buildFleetKanban,
  buildProjectContextMap,
  buildSessionProvenanceMap,
  extractFleetQueuedRuns,
  filterRunningFleetSessions,
  finishedFleetAgents,
  fleetSummary,
  formatElapsed,
  formatShortRelative,
  groupFleet,
  isFinishedFleetAgent,
  loadFleetGroupByProject,
  loadFleetHideIdle,
  loadFleetRunningOnly,
  POCKET_AGENTS_GROUP_KEY,
  resolveProjectContext,
  saveFleetGroupByProject,
  saveFleetHideIdle,
  saveFleetRunningOnly,
  sessionFleetDotState,
  stopAffordance,
  terminalKindTag,
} from './fleet-groups.js';

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: 's1',
    title: 'A chat',
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    cwd: '/w/p',
    workspaceLabel: 'p',
    status: 'running',
    cols: 0,
    rows: 0,
    pid: null,
    exitCode: null,
    exitSignal: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    lastActivityAt: null,
    attachedClients: 0,
    epoch: 'e1',
    backend: 'direct',
    transport: 'structured',
    agentSessionId: null,
    durable: false,
    adopted: false,
    adoptTargetId: null,
    skipPermissionsEnabled: false,
    busy: false,
    busySince: null,
    rateLimit: null,
    ...over,
  }) as SessionInfo;

describe('groupFleet', () => {
  it('splits by transport, agents first', () => {
    const groups = groupFleet([
      session({ id: 't1', transport: 'terminal' }),
      session({ id: 'a1', transport: 'structured' }),
      session({ id: 't2', transport: 'terminal' }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['agents', 'terminals']);
    expect(groups.map((g) => g.sessions.map((s) => s.id))).toEqual([['a1'], ['t1', 't2']]);
  });

  it('preserves the caller’s ordering within a group', () => {
    const groups = groupFleet([
      session({ id: 'a2', transport: 'structured' }),
      session({ id: 'a1', transport: 'structured' }),
    ]);
    expect(groups.flatMap((g) => g.sessions.map((s) => s.id))).toEqual(['a2', 'a1']);
  });

  // The page's own single empty state covers "nothing running"; two empty
  // panels would be worse than one.
  it('drops an empty group entirely', () => {
    expect(groupFleet([session({ transport: 'terminal' })]).map((g) => g.key)).toEqual(['terminals']);
    expect(groupFleet([])).toEqual([]);
  });
});

describe('fleetSummary', () => {
  it('names both kinds so a total cannot hide the split', () => {
    expect(
      fleetSummary([
        session({ id: 'a1', transport: 'structured' }),
        session({ id: 't1', transport: 'terminal' }),
        session({ id: 't2', transport: 'terminal' }),
      ]),
    ).toBe('1 agent · 2 terminals');
  });

  it('omits a kind that has nothing running', () => {
    expect(fleetSummary([session({ transport: 'structured' })])).toBe('1 agent');
    expect(fleetSummary([session({ transport: 'terminal' })])).toBe('1 terminal');
  });

  it('says nothing is running when nothing is', () => {
    expect(fleetSummary([])).toBe('Nothing running');
  });
});

describe('terminalKindTag', () => {
  it('names the backend holding the PTY', () => {
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'tmux' }))).toBe('tmux');
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'direct' }))).toBe('direct');
  });

  // The stronger fact: this pane is someone else's and must not be resized.
  it('prefers "adopted pane" over the backend name', () => {
    expect(terminalKindTag(session({ transport: 'terminal', backend: 'direct', adopted: true }))).toBe('adopted pane');
  });

  it('is null for a structured session', () => {
    expect(terminalKindTag(session({ transport: 'structured', backend: 'tmux' }))).toBeNull();
  });
});

describe('stopAffordance', () => {
  it('calls a structured session an agent', () => {
    const words = stopAffordance(session({ transport: 'structured', title: 'Fix the bug' }));
    expect(words.confirmTitle).toBe('Stop this agent?');
    expect(words.confirmBody).toBe('Fix the bug will be stopped.');
    expect(words.ariaLabel).toBe('Stop Fix the bug');
  });

  it('calls a terminal session a session, not an agent', () => {
    const words = stopAffordance(session({ transport: 'terminal' }));
    expect(words.confirmTitle).toBe('Terminate this session?');
    expect(words.confirmLabel).toBe('Terminate');
  });

  // Killing our tmux client must never read as terminating someone else's
  // work — the card has to say the same thing `TerminalPage` does.
  it('says an adopted pane only detaches', () => {
    const words = stopAffordance(session({ transport: 'terminal', adopted: true }));
    expect(words.confirmTitle).toBe('Detach from tmux session?');
    expect(words.confirmBody).toBe('The terminal client will detach. Your tmux session will remain running.');
    expect(words.confirmLabel).toBe('Detach');
    expect(words.busyLabel).toBe('Detaching…');
  });
});

describe('finishedFleetAgents (PA-172)', () => {
  it('selects idle structured agent sessions and excludes busy, approval-waiting, and terminal sessions', () => {
    const idleAgent = session({ id: 'a-idle', transport: 'structured', busy: false, pendingApprovalsCount: 0 });
    const busyAgent = session({ id: 'a-busy', transport: 'structured', busy: true, pendingApprovalsCount: 0 });
    const approvalAgent = session({ id: 'a-approval', transport: 'structured', busy: false, pendingApprovalsCount: 1 });
    const idleTerminal = session({ id: 't-idle', transport: 'terminal', busy: false });

    expect(isFinishedFleetAgent(idleAgent)).toBe(true);
    expect(isFinishedFleetAgent(busyAgent)).toBe(false);
    expect(isFinishedFleetAgent(approvalAgent)).toBe(false);
    expect(isFinishedFleetAgent(idleTerminal)).toBe(false);

    expect(
      finishedFleetAgents([idleAgent, busyAgent, approvalAgent, idleTerminal]).map((s) => s.id),
    ).toEqual(['a-idle']);
  });
});

describe('filterRunningFleetSessions (PA-172)', () => {
  it('returns all sessions when runningOnly is false, and filters out idle or approval-parked sessions when true', () => {
    const idleAgent = session({ id: 'a-idle', transport: 'structured', busy: false });
    const busyAgent = session({ id: 'a-busy', transport: 'structured', busy: true, pendingApprovalsCount: 0 });
    const approvalAgent = session({ id: 'a-approval', transport: 'structured', busy: true, pendingApprovalsCount: 1 });
    const busyTerminal = session({ id: 't-busy', transport: 'terminal', busy: true });
    const idleTerminal = session({ id: 't-idle', transport: 'terminal', busy: false });
    const all = [idleAgent, busyAgent, approvalAgent, busyTerminal, idleTerminal];

    expect(filterRunningFleetSessions(all, false).map((s) => s.id)).toEqual([
      'a-idle',
      'a-busy',
      'a-approval',
      't-busy',
      't-idle',
    ]);
    expect(filterRunningFleetSessions(all, true).map((s) => s.id)).toEqual(['a-busy', 't-busy']);
  });

  it('persists and reads the runningOnly preference when localStorage is available', () => {
    const store = new Map<string, string>();
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
    try {
      expect(loadFleetRunningOnly()).toBe(false);
      saveFleetRunningOnly(true);
      expect(loadFleetRunningOnly()).toBe(true);
      saveFleetRunningOnly(false);
      expect(loadFleetRunningOnly()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: orig });
    }
  });
});

// ---- PA-182: Kanban board, project context, status dots, Pocket Agents ----

const plannerChat = (over: Partial<PlannerChat> = {}): PlannerChat =>
  ({
    id: 'pc1',
    workspaceId: 'pw1',
    workspaceName: 'Chief of Staff',
    title: 'Weekly sync notes',
    lastModelId: 'gpt-4o',
    createdAt: 1_000,
    lastActivityAt: 2_000,
    skipToolApprovalsEnabled: false,
    busy: false,
    awaitingApproval: false,
    unread: false,
    ...over,
  }) as PlannerChat;

const queuedRun = (over: Partial<QueuedRunSummary> = {}): QueuedRunSummary =>
  ({
    id: 'q1',
    kind: 'webhook',
    title: '[PA-200] Fix build',
    webhookId: 'wh1',
    webhookName: 'Jira',
    sessionId: null,
    agent: 'agy',
    agentDisplayName: 'Antigravity',
    position: 1,
    queuedAt: 1_500,
    skipPermissionsEnabled: false,
    resumesConversationId: null,
    ...over,
  }) as QueuedRunSummary;

const projectInfo = (over: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    cwd: '/repos/pocketagent',
    name: 'pocketagent',
    workspaceLabel: 'repos/pocketagent',
    isGitRepo: true,
    gitBranch: 'main',
    gitStatus: null,
    hidden: false,
    isWorkspace: true,
    chats: [],
    cronJobs: [],
    webhooks: [],
    queued: [],
    subagents: [],
    worktrees: [],
    ...over,
  }) as ProjectInfo;

describe('PA-182: project context, provenance, and queued runs', () => {
  it('resolves parent project name, linked worktree name, and git branch by cwd', () => {
    const wt = projectInfo({
      cwd: '/repos/pocketagent/.worktrees/feature-ui',
      name: 'feature-ui',
      gitBranch: 'feature/ui',
    });
    const proj = projectInfo({ worktrees: [wt] });
    const map = buildProjectContextMap([proj]);

    expect(resolveProjectContext(session({ cwd: '/repos/pocketagent' }), map)).toEqual({
      projectName: 'pocketagent',
      projectKey: '/repos/pocketagent',
      worktreeName: null,
      gitBranch: 'main',
    });
    expect(resolveProjectContext(session({ cwd: wt.cwd }), map)).toEqual({
      projectName: 'pocketagent',
      projectKey: '/repos/pocketagent',
      worktreeName: 'feature-ui',
      gitBranch: 'feature/ui',
    });
    expect(
      resolveProjectContext(session({ cwd: '/other/foo', workspaceLabel: 'src/foo' }), map),
    ).toEqual({
      projectName: 'foo',
      projectKey: '/other/foo',
      worktreeName: null,
      gitBranch: null,
    });
  });

  it('extracts provenance from project chats, subagents, and worktrees', () => {
    const wt = projectInfo({
      cwd: '/repos/pocketagent/.worktrees/wt1',
      name: 'wt1',
      chats: [
        {
          id: 's-wh',
          sessionId: 's-wh',
          cronJobId: null,
          webhookId: 'wh-1',
          plannerChatId: null,
          mcpClient: null,
        } as never,
      ],
    });
    const proj = projectInfo({
      subagents: [
        {
          id: 's-sub',
          sessionId: 's-sub',
          cronJobId: null,
          webhookId: null,
          plannerChatId: 'pc-parent',
          mcpClient: 'cursor',
        } as never,
      ],
      worktrees: [wt],
    });

    const prov = buildSessionProvenanceMap([proj]);
    expect(prov.get('s-wh')?.webhookId).toBe('wh-1');
    expect(prov.get('s-sub')).toEqual({
      cronJobId: null,
      webhookId: null,
      plannerChatId: 'pc-parent',
      mcpClient: 'cursor',
    });
  });

  it('extracts queued runs across main checkout and worktrees in queue order', () => {
    const wt = projectInfo({
      cwd: '/repos/pocketagent/.worktrees/wt1',
      name: 'wt1',
      gitBranch: 'fix/wt1',
      queued: [queuedRun({ id: 'q2', position: 2, queuedAt: 2000 })],
    });
    const proj = projectInfo({
      queued: [queuedRun({ id: 'q1', position: 1, queuedAt: 3000 })],
      worktrees: [wt],
    });

    const items = extractFleetQueuedRuns([proj]);
    expect(items.map((q) => q.item.id)).toEqual(['q1', 'q2']);
    expect(items[1]!.project).toEqual({
      projectName: 'pocketagent',
      projectKey: '/repos/pocketagent',
      worktreeName: 'wt1',
      gitBranch: 'fix/wt1',
    });
  });
});

describe('PA-182: sessionFleetDotState & activeFleetPlannerChats', () => {
  it('maps live sessions to the four PA-165 dot states in precedence order', () => {
    expect(
      sessionFleetDotState(
        session({ busy: true, busySince: 100, pendingApprovalsCount: 1, unread: true }),
      ),
    ).toBe('approval');
    expect(
      sessionFleetDotState(session({ busy: true, busySince: 100, pendingApprovalsCount: 0 }), true),
    ).toBe('approval');
    expect(sessionFleetDotState(session({ busy: true, busySince: 100, unread: true }))).toBe(
      'running',
    );
    expect(sessionFleetDotState(session({ busy: false, busySince: null, unread: true }))).toBe(
      'unread',
    );
    expect(sessionFleetDotState(session({ busy: false, busySince: null, unread: false }))).toBe(
      'idle',
    );
  });

  it('includes only active or unread Pocket Agent chats (excluding read idle chats)', () => {
    const active = activeFleetPlannerChats([
      plannerChat({ id: 'idle', busy: false, unread: false, awaitingApproval: false }),
      plannerChat({ id: 'unread', unread: true, lastActivityAt: 100 }),
      plannerChat({ id: 'running', busy: true, lastActivityAt: 300 }),
      plannerChat({ id: 'approval', busy: true, awaitingApproval: true, lastActivityAt: 200 }),
    ]);
    expect(active.map((c) => c.id)).toEqual(['running', 'approval', 'unread']);
  });

  it('excludes unread Pocket Agent scheduled-job chats (and their unread subagent chats) while keeping running/approval ones', () => {
    const active = activeFleetPlannerChats([
      plannerChat({ id: 'cron-unread', cronJobId: 'job-1', unread: true, lastActivityAt: 500 }),
      plannerChat({
        id: 'cron-sub-unread',
        parentChatId: 'cron-unread',
        unread: true,
        lastActivityAt: 450,
      }),
      plannerChat({ id: 'cron-running', cronJobId: 'job-2', busy: true, lastActivityAt: 400 }),
      plannerChat({
        id: 'cron-approval',
        cronJobId: 'job-3',
        busy: true,
        awaitingApproval: true,
        lastActivityAt: 350,
      }),
      plannerChat({ id: 'regular-unread', unread: true, lastActivityAt: 300 }),
    ]);
    expect(active.map((c) => c.id)).toEqual(['cron-running', 'cron-approval', 'regular-unread']);
  });
});

describe('PA-182: buildFleetKanban', () => {
  it('buckets sessions, Pocket Agents, and queued runs into 3 columns with project sub-groups and separates terminals', () => {
    const projA = projectInfo({
      cwd: '/repos/alpha',
      name: 'alpha',
      gitBranch: 'main',
      queued: [queuedRun({ id: 'q1', position: 1, queuedAt: 500 })],
    });
    const projB = projectInfo({
      cwd: '/repos/beta',
      name: 'beta',
      gitBranch: 'feat/x',
    });

    const sApproval = session({
      id: 's-app',
      cwd: '/repos/alpha',
      busy: true,
      busySince: 900,
      pendingApprovalsCount: 1,
    });
    const sRunning = session({
      id: 's-run',
      cwd: '/repos/beta',
      busy: true,
      busySince: 800,
    });
    const sUnread = session({
      id: 's-unr',
      cwd: '/repos/alpha',
      busy: false,
      lastTurnEndedAt: 400,
      unread: true,
    });
    const sIdle = session({
      id: 's-idl',
      cwd: '/repos/alpha',
      busy: false,
      lastTurnEndedAt: 700,
      unread: false,
    });
    const sTerm = session({
      id: 't-1',
      cwd: '/repos/beta',
      transport: 'terminal',
      backend: 'tmux',
    });

    const pRunning = plannerChat({ id: 'p-run', busy: true, lastActivityAt: 1000 });
    const pUnread = plannerChat({ id: 'p-unr', unread: true, lastActivityAt: 500 });
    const pIdle = plannerChat({ id: 'p-idl', busy: false, unread: false });

    const board = buildFleetKanban({
      sessions: [sApproval, sRunning, sUnread, sIdle, sTerm],
      plannerChats: [pRunning, pUnread, pIdle],
      projects: [projA, projB],
    });

    const [pending, inProgress, idle] = board.columns;
    expect(pending!.key).toBe('pending');
    // Approvals sort ahead of queued runs
    expect(pending!.items.map((i) => i.id)).toEqual(['session:s-app', 'queued:q1']);
    expect(pending!.subGroups.map((g) => g.label)).toEqual(['alpha']);

    expect(inProgress!.key).toBe('in_progress');
    expect(inProgress!.items.map((i) => i.id)).toEqual(['planner:p-run', 'session:s-run']);
    expect(inProgress!.subGroups.map((g) => g.label)).toEqual(['Pocket Agents', 'beta']);

    expect(idle!.key).toBe('idle');
    // Unread items (green dot) always sort ahead of read idle sessions (grey/steady dot)
    expect(idle!.items.map((i) => i.id)).toEqual([
      'planner:p-unr',
      'session:s-unr',
      'session:s-idl',
    ]);

    // Terminals stay separate from the Kanban board
    expect(board.terminals.map((t) => t.session.id)).toEqual(['t-1']);
    expect(board.summary).toBe('2 pending · 2 running · 2 unread · 1 idle · 1 terminal');
  });

  it('supports hideIdle and projectFilter while keeping projectOptions complete', () => {
    const projA = projectInfo({ cwd: '/repos/alpha', name: 'alpha' });
    const projB = projectInfo({ cwd: '/repos/beta', name: 'beta' });
    const sIdleA = session({ id: 's-idle-a', cwd: '/repos/alpha', busy: false, unread: false });
    const sUnreadA = session({ id: 's-unr-a', cwd: '/repos/alpha', busy: false, unread: true });
    const sRunB = session({ id: 's-run-b', cwd: '/repos/beta', busy: true, busySince: 500 });
    const pRun = plannerChat({ id: 'p-1', busy: true });

    const hiddenIdle = buildFleetKanban({
      sessions: [sIdleA, sUnreadA, sRunB],
      plannerChats: [pRun],
      projects: [projA, projB],
      hideIdle: true,
    });
    expect(hiddenIdle.columns[2]!.items.map((i) => i.id)).toEqual(['session:s-unr-a']);

    const filtered = buildFleetKanban({
      sessions: [sIdleA, sUnreadA, sRunB],
      plannerChats: [pRun],
      projects: [projA, projB],
      projectFilter: POCKET_AGENTS_GROUP_KEY,
    });
    expect(filtered.columns[1]!.items.map((i) => i.id)).toEqual(['planner:p-1']);
    expect(filtered.columns[2]!.items).toEqual([]);
    expect(filtered.projectOptions.map((o) => o.label)).toEqual(['alpha', 'beta', 'Pocket Agents']);
  });
});

describe('PA-182: formatting, custom-claude icon, and storage prefs', () => {
  it('formats elapsed and short relative times cleanly', () => {
    const now = 10_000_000;
    expect(formatElapsed(now - 30_000, now)).toBe('<1m');
    expect(formatElapsed(now - 5 * 60_000, now)).toBe('5m');
    expect(formatElapsed(now - 75 * 60_000, now)).toBe('1h 15m');
    expect(formatShortRelative(now - 10_000, now)).toBe('just now');
    expect(formatShortRelative(now - 12 * 60_000, now)).toBe('12m ago');
    expect(formatShortRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
  });

  it('gives custom-claude:* agents the Claude icon and accent class', () => {
    expect(agentIconName('custom-claude:deepseek')).toBe('agent-claude');
    expect(agentAccentClass('custom-claude:deepseek')).toBe('agent-mascot--claude');
  });

  it('persists groupByProject (default true) and hideIdle (default false)', () => {
    const store = new Map<string, string>();
    const orig = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
    try {
      expect(loadFleetGroupByProject()).toBe(true);
      saveFleetGroupByProject(false);
      expect(loadFleetGroupByProject()).toBe(false);
      saveFleetGroupByProject(true);
      expect(loadFleetGroupByProject()).toBe(true);

      expect(loadFleetHideIdle()).toBe(false);
      saveFleetHideIdle(true);
      expect(loadFleetHideIdle()).toBe(true);
      saveFleetHideIdle(false);
      expect(loadFleetHideIdle()).toBe(false);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: orig });
    }
  });
});
