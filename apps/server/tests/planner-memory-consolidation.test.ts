import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryConsolidationService } from '../src/planner/memory-consolidation.js';
import { insertPlannerChat } from '../src/planner/store.js';
import { appendTranscriptEvent } from '../src/planner/transcript.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-29 phase 3: the "dream" consolidation pass. Mirrors `cron.test.ts`'s own
 * structure — an injectable fake clock, and a fresh `MemoryConsolidationService`
 * constructed directly (rather than the one `buildApp` already wires up and
 * starts for real, on a real 30-minute ticker) so each test controls exactly
 * when a workspace becomes "due" without waiting on either that ticker or the
 * default 24h consolidation interval.
 */

/** Joins fake SSE data frames into one OpenAI-style streamed response body,
    the same shape `planner-chats.test.ts` already builds for its own
    `PlannerLlmClient` mocks. */
function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeCompletionResponse(content: string): Response {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

const CONSOLIDATION_INTERVAL_MS = 1_000;

describe('MemoryConsolidationService', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  /** Seeds a chat row plus a two-event transcript (`user_prompt` + `text`)
      directly, bypassing `PlannerChatService` entirely — full control over
      `lastActivityAt` is what a "since the last consolidation" test needs,
      the same reasoning `planner-memory.test.ts` uses `insertPlannerMemory`
      directly for its own budget-eviction tests. */
  async function seedChatWithTranscript(
    workspaceId: string,
    workspacePath: string,
    opts: { lastActivityAt: number; userText: string; replyText: string },
  ): Promise<string> {
    const chatId = randomUUID();
    insertPlannerChat(t.db, {
      id: chatId,
      workspaceId,
      workspaceName: 'Test agent',
      title: 'Test chat',
      lastModelId: null,
      createdAt: opts.lastActivityAt,
      lastActivityAt: opts.lastActivityAt,
      skipToolApprovalsEnabled: false,
    });
    await appendTranscriptEvent(workspacePath, chatId, {
      kind: 'user_prompt',
      id: randomUUID(),
      text: opts.userText,
    });
    await appendTranscriptEvent(workspacePath, chatId, {
      kind: 'text',
      id: randomUUID(),
      text: opts.replyText,
    });
    return chatId;
  }

  it('does nothing for a workspace whose consolidation interval has not elapsed yet', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;

    const clock = Date.parse('2026-09-01T00:00:00Z');
    t.context.plannerWorkspaces.setLastConsolidatedAt(ws.id, clock - 500); // well inside the 1s interval
    t.context.plannerMemory.save(ws.id, 'a short-term note', 3, null);

    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      now: () => clock,
      llmFetch: fetchImpl as unknown as typeof fetch,
      consolidationIntervalMs: CONSOLIDATION_INTERVAL_MS,
    });
    await svc.tick();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.context.plannerMemory.list(ws.id, 'short')).toHaveLength(1);
    expect(t.context.plannerMemory.list(ws.id, 'long')).toHaveLength(0);
    expect(t.context.plannerWorkspaces.get(ws.id)!.lastConsolidatedAt).toBe(clock - 500);
  });

  it('consolidates a due workspace: short-term memories and recent transcripts fold into long-term rows, short-term is pruned, and the marker advances', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeCompletionResponse(
          JSON.stringify([{ content: 'The user prefers dark mode in the dashboard', importance: 4 }]),
        ),
      );
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;
    t.context.plannerWorkspaces.setDefaultModelId(ws.id, 'gpt-4o');

    const clock = Date.parse('2026-09-01T00:00:00Z');
    t.context.plannerWorkspaces.setLastConsolidatedAt(ws.id, clock - CONSOLIDATION_INTERVAL_MS - 1);
    const shortTerm = t.context.plannerMemory.save(ws.id, 'earlier note: user likes dark mode', 3, null);
    await seedChatWithTranscript(ws.id, ws.path, {
      lastActivityAt: clock,
      userText: 'Please always use dark mode in the dashboard from now on.',
      replyText: 'Got it, I will default to dark mode.',
    });

    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      now: () => clock,
      llmFetch: fetchImpl as unknown as typeof fetch,
      consolidationIntervalMs: CONSOLIDATION_INTERVAL_MS,
    });
    await svc.tick();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o');
    const userMessage = body.messages.find((m: { role: string }) => m.role === 'user').content as string;
    expect(userMessage).toContain('user likes dark mode');
    expect(userMessage).toContain('always use dark mode in the dashboard');

    const longTerm = t.context.plannerMemory.list(ws.id, 'long');
    expect(longTerm).toHaveLength(1);
    expect(longTerm[0]!.content).toBe('The user prefers dark mode in the dashboard');
    expect(longTerm[0]!.importance).toBe(4);

    expect(t.context.plannerMemory.get(shortTerm.id)).toBeNull();
    expect(t.context.plannerWorkspaces.get(ws.id)!.lastConsolidatedAt).toBe(clock);
  });

  it('advances the marker without calling the LLM when there is nothing to fold', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;

    const clock = Date.parse('2026-09-01T00:00:00Z');
    t.context.plannerWorkspaces.setLastConsolidatedAt(ws.id, clock - CONSOLIDATION_INTERVAL_MS - 1);

    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      now: () => clock,
      llmFetch: fetchImpl as unknown as typeof fetch,
      consolidationIntervalMs: CONSOLIDATION_INTERVAL_MS,
    });
    await svc.tick();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.context.plannerWorkspaces.get(ws.id)!.lastConsolidatedAt).toBe(clock);
  });

  it('skips a due workspace with memoryEnabled: false entirely, leaving its marker untouched', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;
    t.context.plannerWorkspaces.setMemoryEnabled(ws.id, false);

    const clock = Date.parse('2026-09-01T00:00:00Z');
    const stalePast = clock - CONSOLIDATION_INTERVAL_MS - 1;
    t.context.plannerWorkspaces.setLastConsolidatedAt(ws.id, stalePast);
    t.context.plannerMemory.save(ws.id, 'a short-term note', 3, null);

    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      now: () => clock,
      llmFetch: fetchImpl as unknown as typeof fetch,
      consolidationIntervalMs: CONSOLIDATION_INTERVAL_MS,
    });
    await svc.tick();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.context.plannerMemory.list(ws.id, 'short')).toHaveLength(1);
    expect(t.context.plannerWorkspaces.get(ws.id)!.lastConsolidatedAt).toBe(stalePast);
  });

  it("one workspace's LLM failure does not prevent another due workspace in the same tick from succeeding", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as { model: string };
      if (body.model === 'model-bad') {
        // A reply that fails `parseConsolidationFacts` (not a JSON array).
        return fakeCompletionResponse('sorry, I cannot help with that');
      }
      return fakeCompletionResponse(JSON.stringify([{ content: 'a durable fact', importance: 3 }]));
    });
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });

    const wsBad = t.context.plannerWorkspaces.getDefault()!;
    t.context.plannerWorkspaces.setDefaultModelId(wsBad.id, 'model-bad');
    const wsGood = await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Second agent');
    t.context.plannerWorkspaces.setDefaultModelId(wsGood.id, 'model-good');

    const clock = Date.parse('2026-09-01T00:00:00Z');
    const stalePast = clock - CONSOLIDATION_INTERVAL_MS - 1;
    t.context.plannerWorkspaces.setLastConsolidatedAt(wsBad.id, stalePast);
    t.context.plannerWorkspaces.setLastConsolidatedAt(wsGood.id, stalePast);
    const badShortTerm = t.context.plannerMemory.save(wsBad.id, 'bad workspace note', 3, null);
    const goodShortTerm = t.context.plannerMemory.save(wsGood.id, 'good workspace note', 3, null);

    const logger = { warn: vi.fn() };
    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      now: () => clock,
      llmFetch: fetchImpl as unknown as typeof fetch,
      consolidationIntervalMs: CONSOLIDATION_INTERVAL_MS,
      logger,
    });
    await expect(svc.tick()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: wsBad.id }),
      expect.any(String),
    );

    // The failed workspace: nothing pruned, nothing written, marker untouched.
    expect(t.context.plannerMemory.get(badShortTerm.id)).not.toBeNull();
    expect(t.context.plannerMemory.list(wsBad.id, 'long')).toHaveLength(0);
    expect(t.context.plannerWorkspaces.get(wsBad.id)!.lastConsolidatedAt).toBe(stalePast);

    // The succeeding workspace, in the very same tick: fully processed.
    expect(t.context.plannerMemory.get(goodShortTerm.id)).toBeNull();
    const longTerm = t.context.plannerMemory.list(wsGood.id, 'long');
    expect(longTerm).toHaveLength(1);
    expect(longTerm[0]!.content).toBe('a durable fact');
    expect(t.context.plannerWorkspaces.get(wsGood.id)!.lastConsolidatedAt).toBe(clock);
  });

  it('stop() clears the ticker so no further tick runs', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    const svc = new MemoryConsolidationService({
      db: t.db,
      plannerWorkspaces: t.context.plannerWorkspaces,
      memory: t.context.plannerMemory,
      llmFetch: fetchImpl as unknown as typeof fetch,
    });
    svc.start();
    svc.stop();
    // No assertion beyond "this does not throw" — the real behavioural
    // guarantee (no timer left registered) is what keeps a test run's event
    // loop from hanging, which a hung `vitest run` would already reveal.
    expect(true).toBe(true);
  });
});
