import { describe, it, expect, afterEach } from 'vitest';
import { truncate, truncateTail, extractResultSummary, lastMessageSummary, findPlannerTool } from '../src/planner/tools.js';
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

describe('PA-76: head vs tail truncate and result extraction', () => {
  it('truncate retains the head when length exceeds max (head-preserving)', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const truncated = truncate(text, 10);
    expect(truncated.startsWith('abcdefghij\n…(truncated, 16 more characters)')).toBe(true);
  });

  it('truncateTail retains the tail when length exceeds max (tail-preserving)', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const truncated = truncateTail(text, 10);
    expect(truncated).toContain('…(truncated, 16 earlier characters)\n');
    expect(truncated.endsWith('qrstuvwxyz')).toBe(true);
  });

  it('truncate and truncateTail return original text when length is within max', () => {
    const text = 'hello world';
    expect(truncate(text, 20)).toBe('hello world');
    expect(truncateTail(text, 20)).toBe('hello world');
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

  it('getOutcome respects kind to prevent id collision (Item 12)', async () => {
    t = await createTestApp();
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: () => {},
    });

    supervisor.trackCodingSubagent('common-id', 'parent-chat-1');

    // coding_agent query returns outcome
    expect(supervisor.getOutcome('coding_agent', 'common-id')).toEqual({
      status: 'running',
      summary: 'Still working on its assigned task.',
    });
    // pocket_agent query for same id returns null
    expect(supervisor.getOutcome('pocket_agent', 'common-id')).toBeNull();

    supervisor.dispose();
  });

  it('trackCodingSubagent disposes existing listener on reuse to prevent leak (Item 10)', async () => {
    t = await createTestApp();
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: () => {},
    });

    let disposedCount = 0;
    // Inject a dummy disposer into disposers map to verify it is called when re-tracking
    (supervisor as any).disposers.set('coding:sess-leak-check', () => {
      disposedCount++;
    });

    supervisor.trackCodingSubagent('sess-leak-check', 'parent-chat-1');
    expect(disposedCount).toBe(1);

    supervisor.dispose();
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

  it('onCodingSessionTurnComplete drops parent tracking link to prevent unbounded wake loop (Item 2)', async () => {
    t = await createTestApp();
    const enqueued: Array<{ chatId: string; message: any }> = [];
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: (chatId, message) => {
        enqueued.push({ chatId, message });
      },
    });

    supervisor.trackCodingSubagent('sess-turn-complete', 'parent-chat-1');

    // Trigger turn complete
    (supervisor as any).onCodingSessionTurnComplete('sess-turn-complete');
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].chatId).toBe('parent-chat-1');

    // Subsequent turn complete should NOT wake parent because codingParents was deleted
    (supervisor as any).onCodingSessionTurnComplete('sess-turn-complete');
    await new Promise((r) => setTimeout(r, 50));

    expect(enqueued).toHaveLength(1);

    supervisor.dispose();
  });

  it('handles session termination and forgotten hooks (Item 4)', async () => {
    t = await createTestApp();
    const enqueued: Array<{ chatId: string; message: any }> = [];
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: (chatId, message) => {
        enqueued.push({ chatId, message });
      },
    });

    // Test terminated hook
    supervisor.trackCodingSubagent('sess-term', 'parent-chat-1');
    (supervisor as any).onCodingSessionTerminated('sess-term');

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].message.status).toBe('exited');
    expect(supervisor.getOutcome('coding_agent', 'sess-term')?.status).toBe('exited');

    // Test forgotten hook
    supervisor.trackCodingSubagent('sess-forgotten', 'parent-chat-1');
    (supervisor as any).onCodingSessionForgotten('sess-forgotten');

    expect(enqueued).toHaveLength(2);
    expect(enqueued[1].message.status).toBe('gone');
    expect(supervisor.getOutcome('coding_agent', 'sess-forgotten')).toBeNull();

    supervisor.dispose();
  });

  it('forget() clears outcomes and prevents unbounded map growth (Item 5)', async () => {
    t = await createTestApp();
    const supervisor = new SubagentSupervisor({
      sessions: t.context.sessions,
      historyDeps: t.context.historyDeps,
      getPlannerChatHistory: async () => [],
      observePlannerChat: () => () => {},
      enqueueMailbox: () => {},
    });

    supervisor.trackPocketSubagent('child-pocket-1', 'parent-chat-1');
    expect(supervisor.getOutcome('pocket_agent', 'child-pocket-1')).toBeDefined();

    supervisor.forget('pocket_agent', 'child-pocket-1');
    expect(supervisor.getOutcome('pocket_agent', 'child-pocket-1')).toBeNull();

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
    const endMockTurn = (t.context.plannerChats as any).beginTurn(chat.id) as () => void;

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
    endMockTurn();
  });

  it('drainMailbox restores messages if wake turn fails (Item 8)', async () => {
    t = await createTestApp();
    const chat = t.context.plannerChats.create({ title: 'Parent Chat' });

    (t.context.plannerChats as any).mailboxByChat.set(chat.id, [
      {
        subagentId: 'sub-recover',
        kind: 'coding_agent',
        status: 'idle',
        summary: 'Done with work',
      },
    ]);

    // Force sendMessage to throw by putting chat in busy state right after drainMailbox checks
    const originalSendMessage = (t.context.plannerChats as any).sendMessage.bind(t.context.plannerChats);
    (t.context.plannerChats as any).sendMessage = () => {
      throw new Error('Simulated wake turn failure');
    };

    await (t.context.plannerChats as any).drainMailbox(chat.id);

    // Verify messages were restored to mailbox
    const queue = (t.context.plannerChats as any).mailboxByChat.get(chat.id);
    expect(queue).toBeDefined();
    expect(queue).toHaveLength(1);
    expect(queue[0].subagentId).toBe('sub-recover');

    // Verify a retry timer was scheduled with attempt count = 1 (R1)
    expect((t.context.plannerChats as any).drainRetryTimeouts.has(chat.id)).toBe(true);
    expect((t.context.plannerChats as any).drainRetryAttempts.get(chat.id)).toBe(1);

    // Restore sendMessage to succeed, and re-drain
    (t.context.plannerChats as any).sendMessage = async function* () {
      yield { kind: 'turn_complete', isError: false, completedAt: Date.now() };
    };
    await (t.context.plannerChats as any).drainMailbox(chat.id);

    // After successful drain, mailbox is empty, attempts are deleted, and retry timer is cleared
    expect((t.context.plannerChats as any).mailboxByChat.get(chat.id)).toBeUndefined();
    expect((t.context.plannerChats as any).drainRetryTimeouts.has(chat.id)).toBe(false);
    expect((t.context.plannerChats as any).drainRetryAttempts.has(chat.id)).toBe(false);

    (t.context.plannerChats as any).sendMessage = originalSendMessage;
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

    // Insert session into DB with running status and pending approvals count
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Subagent', 'shell', 'bash', ?, 'running', 'terminal', ?, 80, 24)`,
      )
      .run(sessionId, t.projectDir, Date.now());

    const result = JSON.parse(
      await tool.execute(
        depsFor(t, undefined, {
          sessions: {
            ...t.context.sessions,
            find: () => ({
              id: sessionId,
              status: 'running',
              pendingApprovalsCount: 2,
              busy: true,
            }),
          },
          subagents: {
            startPocketAgentChat: async () => ({ chatId: 'unused' }),
            pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
            pocketAgentEnabledTools: () => [],
            codingAgentStatus: () => null,
          },
        }),
        { kind: 'coding_agent', id: sessionId },
      ),
    );
    expect(result.status).toBe('paused_for_approval');
    expect(result.summary).toContain('Waiting on a human to approve 2 tool call(s)');
  });

  it('prioritizes live busy status over stale cached outcome in get_subagent_status (Item 3)', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('get_subagent_status')!;
    const sessionId = 'sess-busy-check';

    const result = JSON.parse(
      await tool.execute(
        depsFor(t, undefined, {
          sessions: {
            ...t.context.sessions,
            find: () => ({
              id: sessionId,
              status: 'running',
              pendingApprovalsCount: 0,
              busy: true,
            }),
          },
          subagents: {
            startPocketAgentChat: async () => ({ chatId: 'unused' }),
            pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
            pocketAgentEnabledTools: () => [],
            // Stale cache reports idle:
            codingAgentStatus: () => ({ status: 'idle', summary: 'Previous turn summary.' }),
          },
        }),
        { kind: 'coding_agent', id: sessionId },
      ),
    );
    // Because the live session is busy, it must report running rather than stale idle
    expect(result.status).toBe('running');
  });

  it('refuses start_subagent_session and send_instruction when wake budget is exhausted (Item 2)', async () => {
    t = await createTestApp();
    const startTool = findPlannerTool('start_subagent_session')!;
    const sendTool = findPlannerTool('send_instruction')!;

    const subagentsDeps = {
      startPocketAgentChat: async () => ({ chatId: 'unused' }),
      pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
      pocketAgentEnabledTools: () => [],
      wakeBudgetExhausted: () => true,
    };

    const startResult = await startTool.execute(
      depsFor(t, undefined, { subagents: subagentsDeps }),
      {
        kind: 'pocket_agent',
        workspaceId: t.context.plannerWorkspaces.getDefault()!.id,
        prompt: 'do a subtask',
      },
    );
    expect(startResult).toMatch(/wake-driven turns has been exhausted/);

    const sendResult = await sendTool.execute(
      depsFor(t, undefined, { subagents: subagentsDeps }),
      {
        sessionId: 'any-sess',
        prompt: 'do more work',
      },
    );
    expect(sendResult).toMatch(/wake-driven turns has been exhausted/);
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
    const endMockTurn = (t.context.plannerChats as any).beginTurn(chat.id) as () => void;

    const res = await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat.id}/messages`,
      headers: { cookie: t.cookie },
      payload: { content: 'hello' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('busy');

    // Clean up
    endMockTurn();
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
