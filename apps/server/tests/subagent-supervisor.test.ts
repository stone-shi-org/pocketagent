import { describe, it, expect, afterEach } from 'vitest';
import { truncate, extractResultSummary, lastMessageSummary, findPlannerTool } from '../src/planner/tools.js';
import { SubagentSupervisor } from '../src/planner/supervisor.js';
import { buildWakePrompt } from '../src/planner/chats.js';
import { createTestApp, type TestApp } from './helpers.js';
import type { AgentEvent } from '@pocketagent/protocol';

function depsFor(
  t: TestApp,
  plannerChatId?: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    db: t.db,
    config: t.context.config,
    workspaces: t.context.workspaces,
    plannerWorkspaces: t.context.plannerWorkspaces,
    sessions: t.context.sessions,
    historyDeps: t.context.historyDeps,
    plannerChatId: plannerChatId ?? 'root-chat-id',
    ...overrides,
  };
}

describe('PA-76: tail-preserving truncate and result extraction', () => {
  it('truncate retains the tail when length exceeds max', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const truncated = truncate(text, 10);
    expect(truncated).toContain('…(truncated, 16 earlier characters)\n');
    expect(truncated.endsWith('qrstuvwxyz')).toBe(true);
  });

  it('truncate returns original text when length is within max', () => {
    const text = 'hello world';
    expect(truncate(text, 20)).toBe('hello world');
  });

  it('extractResultSummary extracts summary following ## RESULT', () => {
    const text = `Working on tasks...\nDone!\n\n## RESULT\nFixed 3 bugs and added tests.`;
    const summary = extractResultSummary(text);
    expect(summary).toBe('Fixed 3 bugs and added tests.');
  });

  it('extractResultSummary extracts <result> tags if present', () => {
    const text = 'Here is what happened:\n<result>Refactored user authentication</result>';
    expect(extractResultSummary(text)).toBe('Refactored user authentication');
  });

  it('extractResultSummary returns null when no trailer or tag is present', () => {
    const text = 'Just some output with no special markers.';
    expect(extractResultSummary(text)).toBeNull();
  });

  it('lastMessageSummary extracts trailer or falls back to tail', () => {
    const eventsWithTrailer: AgentEvent[] = [
      {
        kind: 'text',
        id: '1',
        text: `Doing work...\n\n## RESULT\nCompleted successfully.`,
      },
    ];
    expect(lastMessageSummary(eventsWithTrailer)).toBe('Completed successfully.');

    const eventsWithoutTrailer: AgentEvent[] = [
      {
        kind: 'text',
        id: '2',
        text: 'Finished task without trailer.',
      },
    ];
    expect(lastMessageSummary(eventsWithoutTrailer)).toBe('Finished task without trailer.');
  });
});

describe('PA-76: SubagentSupervisor and Mailbox', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('caches coding agent status on permission change', async () => {
    t = await createTestApp();
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: () => {},
    });

    supervisor.trackCodingSubagent('sess-1', 'parent-chat-1');
    t.context.sessions.notifySessionPermissionChange('sess-1', 2);

    const cached = supervisor.getOutcome('coding_agent', 'sess-1');
    expect(cached).toBeDefined();
    expect(cached?.status).toBe('paused_for_approval');

    supervisor.dispose();
  });

  it('enqueues mailbox message and updates outcome on pocket agent turn complete', async () => {
    t = await createTestApp();
    const enqueued: Array<{ chatId: string; message: any }> = [];
    let observerListener: ((event: AgentEvent) => void) | null = null;

    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [
        {
          kind: 'text',
          id: '1',
          text: `Subagent response.\n\n## RESULT\nSubagent finished its job.`,
        },
      ],
      observePlannerChat: (_chatId, listener) => {
        observerListener = listener;
        return () => {
          observerListener = null;
        };
      },
      enqueueMailbox: (chatId, message) => {
        enqueued.push({ chatId, message });
      },
    });

    supervisor.trackPocketSubagent('child-chat-1', 'parent-chat-1');
    expect(observerListener).toBeDefined();

    // Trigger turn_complete on child chat via the observer
    observerListener!({
      kind: 'turn_complete',
      stopReason: 'end_turn',
      isError: false,
      numTurns: 1,
      durationMs: 100,
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 10,
    });

    // Wait a tick for async onPocketChatTurnComplete
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].chatId).toBe('parent-chat-1');
    expect(enqueued[0].message.subagentId).toBe('child-chat-1');
    expect(enqueued[0].message.kind).toBe('pocket_agent');
    expect(enqueued[0].message.summary).toBe('Subagent finished its job.');

    const cached = supervisor.getOutcome('pocket_agent', 'child-chat-1');
    expect(cached).toBeDefined();
    expect(cached?.status).toBe('done');
    expect(cached?.summary).toBe('Subagent finished its job.');

    supervisor.dispose();
  });

  it('enqueues multiple completions to mailbox and coalesces them into a single wake prompt', async () => {
    t = await createTestApp();
    const chat = t.context.plannerChats.create({ title: 'Parent Chat' });

    // Mock an active turn on parent chat so incoming mailbox messages are queued
    (t.context.plannerChats as any).activeTurns.add(chat.id);

    // Enqueue two subagent completion messages
    (t.context.plannerChats as any).enqueueMailbox(chat.id, {
      subagentId: 'sub-1',
      kind: 'coding_agent',
      status: 'idle',
      summary: 'Task 1 completed successfully.',
    });
    (t.context.plannerChats as any).enqueueMailbox(chat.id, {
      subagentId: 'sub-2',
      kind: 'pocket_agent',
      status: 'done',
      summary: 'Task 2 finished research.',
    });

    const queue = (t.context.plannerChats as any).mailboxByChat.get(chat.id);
    expect(queue).toHaveLength(2);

    const wakePrompt = buildWakePrompt(queue);
    expect(wakePrompt).toContain('[Subagent Notifications]');
    expect(wakePrompt).toContain('2 subagents have finished:');
    expect(wakePrompt).toContain('- Coding subagent "sub-1" (idle):');
    expect(wakePrompt).toContain('Task 1 completed successfully.');
    expect(wakePrompt).toContain('- Pocket agent subagent "sub-2" (done):');
    expect(wakePrompt).toContain('Task 2 finished research.');

    // Cleanup mock turn
    (t.context.plannerChats as any).activeTurns.delete(chat.id);
  });
});

describe('PA-76: Tool checks for paused_for_approval and wake budget', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('reports paused_for_approval when pending approvals count > 0', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('get_subagent_status')!;
    const sessionId = 'sess-approval-1';

    // Insert session into DB with pendingApprovalsCount
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Subagent', 'shell', 'bash', ?, 'running', 'terminal', ?, 80, 24)`,
      )
      .run(sessionId, t.projectDir, Date.now());

    // With codingAgentStatus returning paused_for_approval
    const result = JSON.parse(
      await tool.execute(
        depsFor(t, undefined, {
          subagents: {
            startPocketAgentChat: async () => ({ chatId: 'unused' }),
            pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
            pocketAgentEnabledTools: () => [],
            codingAgentStatus: () => ({ status: 'paused_for_approval', summary: 'Waiting for approval.' }),
          },
        }),
        { kind: 'coding_agent', id: sessionId },
      ),
    );
    expect(result.status).toBe('paused_for_approval');
    expect(result.summary).toBe('Waiting for approval.');
  });

  it('refuses start_subagent_session when wake budget is exhausted', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('start_subagent_session')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        subagents: {
          startPocketAgentChat: async () => ({ chatId: 'unused' }),
          pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
          pocketAgentEnabledTools: () => [],
          wakeBudgetExhausted: () => true,
        },
      }),
      {
        kind: 'pocket_agent',
        workspaceId: t.context.plannerWorkspaces.getDefault()!.id,
        prompt: 'do a subtask',
      },
    );
    expect(result).toMatch(/wake-driven turns has been exhausted/);
  });
});

describe('PA-76: Concurrency guard and SSE endpoint over HTTP', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('returns 409 busy when a turn is already running', async () => {
    t = await createTestApp();
    const chat = t.context.plannerChats.create({ title: 'Test Chat' });

    // Mark chat as busy
    (t.context.plannerChats as any).activeTurns.add(chat.id);

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat.id}/messages`,
      headers: { cookie: t.cookie },
      payload: { content: 'hello' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('busy');

    // Clean up
    (t.context.plannerChats as any).activeTurns.delete(chat.id);
  });

  it('GET /api/planner/chats/:id/events connects to SSE stream', async () => {
    t = await createTestApp();
    const chat = t.context.plannerChats.create({ title: 'Test Chat' });

    let unobserve: (() => void) | null = null;
    const receivedEvents: any[] = [];
    unobserve = t.context.plannerChats.observe(chat.id, (ev) => {
      receivedEvents.push(ev);
    });

    // Notify via observer
    (t.context.plannerChats as any).notify(chat.id, {
      kind: 'notice',
      level: 'info',
      text: 'Test notice via SSE',
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].text).toBe('Test notice via SSE');
    unobserve();
  });
});
