import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  buildSummaryRequest,
  planCompaction,
  projectContext,
  serializeForSummary,
} from '../src/planner/compaction.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  TokenCalibration,
  compactionThreshold,
  estimateRequestTokens,
  knownModelLimits,
  resolveModelLimits,
} from '../src/planner/context-budget.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/** PA-121: token-budgeted context and compaction for Pocket Agent chats. */

// ---- fixtures ---------------------------------------------------------------

const user = (id: string, text: string): AgentEvent => ({ kind: 'user_prompt', id, text });
const say = (id: string, text: string, interim = false): AgentEvent => ({
  kind: 'text',
  id,
  text,
  ...(interim ? { interim: true } : {}),
});
const call = (id: string, name = 'read_file'): AgentEvent => ({
  kind: 'tool_use',
  id,
  name,
  input: { path: `/x/${id}` },
  summary: name,
  filePath: null,
});
const result = (id: string, toolUseId: string, content: string): AgentEvent => ({
  kind: 'tool_result',
  id,
  toolUseId,
  content,
  truncated: false,
  isError: false,
});
const done: AgentEvent = {
  kind: 'turn_complete',
  stopReason: 'end_turn',
  isError: false,
  numTurns: null,
  durationMs: 1,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
};
const big = (n: number) => 'w '.repeat(n * 2); // ≈ n tokens at chars÷4

// ---- context-budget ---------------------------------------------------------

describe('context-budget', () => {
  it('prefers the model row, then the known-family table, then the default', () => {
    expect(resolveModelLimits('gpt-4o', { contextWindow: 50_000, maxOutputTokens: null })).toMatchObject({
      contextWindow: 50_000,
      source: 'model',
    });
    expect(resolveModelLimits('openai/gpt-4o-mini', null)).toMatchObject({ contextWindow: 128_000, source: 'known' });
    expect(resolveModelLimits('claude-sonnet-4-5', null)).toMatchObject({ contextWindow: 200_000, source: 'known' });
    expect(resolveModelLimits('my-local-finetune', null)).toMatchObject({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    });
    expect(knownModelLimits('gemini-2.5-pro')?.contextWindow).toBe(1_048_576);
  });

  it('never puts the threshold below a quarter of the window', () => {
    expect(compactionThreshold(128_000, 16_384)).toBe(111_616);
    expect(compactionThreshold(8_000, 16_384)).toBe(2_000);
  });

  it('counts an image as a flat figure, not by its base64 length', () => {
    const huge = 'A'.repeat(400_000);
    const tokens = estimateRequestTokens(
      [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${huge}` } }] }],
      [],
    );
    expect(tokens).toBeLessThan(2_000);
  });

  it('calibrates later estimates by what the provider actually counted, within bounds', () => {
    const cal = new TokenCalibration();
    expect(cal.apply('c', 1000)).toBe(1000);
    cal.record('c', 1000, 2000);
    expect(cal.apply('c', 500)).toBe(1000);
    cal.record('c', 1000, 100_000);
    expect(cal.apply('c', 100)).toBe(400); // clamped at 4×
    cal.forget('c');
    expect(cal.apply('c', 100)).toBe(100);
  });
});

// ---- compaction planning ------------------------------------------------------

describe('planCompaction / projectContext', () => {
  it('keeps the most recent part verbatim and summarizes the rest, cutting at a user prompt', () => {
    const events = [
      user('u1', big(3000)), say('a1', big(3000)), done,
      user('u2', big(3000)), say('a2', big(3000)), done,
      user('u3', 'latest question'), say('a3', 'latest answer'), done,
    ];
    const plan = planCompaction(events, 4000)!;
    expect(plan.firstKeptEventId).toBe('u2');
    expect(plan.toSummarize.map((e) => ('id' in e ? e.id : e.kind))).toEqual(['u1', 'a1', 'turn_complete']);
    expect(plan.splitTurn).toBe(false);
    expect(plan.previousSummary).toBeNull();
  });

  it('never separates a tool call from its result', () => {
    const events = [
      user('u1', 'go'),
      say('n1', 'checking', true),
      call('c1'),
      call('c2'),
      result('r1', 'c1', big(3000)),
      result('r2', 'c2', big(3000)),
      say('a1', 'done'),
      done,
    ];
    for (const keep of [1, 100, 2000, 4000, 7000]) {
      const plan = planCompaction(events, keep);
      if (!plan) continue;
      const kept = plan.firstKeptEventId;
      // The kept part may start at a prompt, a text, or a batch's narration —
      // never at a tool call that has narration before it, a second call of
      // a batch, or a result.
      expect(['u1', 'n1', 'a1', null]).toContain(kept);
    }
  });

  it('marks a cut inside a turn as a split turn', () => {
    const events = [user('u1', 'build it'), say('n1', big(2000), true), call('c1'), result('r1', 'c1', big(2000)), say('n2', 'next step', true), call('c2'), result('r2', 'c2', 'ok')];
    const plan = planCompaction(events, 50)!;
    expect(plan.splitTurn).toBe(true);
    expect(plan.firstKeptEventId).toBe('n2');
  });

  it('returns null when everything already fits in what is kept', () => {
    expect(planCompaction([user('u1', 'hi'), say('a1', 'hello'), done], 20_000)).toBeNull();
    expect(planCompaction([], 1000)).toBeNull();
  });

  it('projects the latest summary plus the kept events, and a second compaction updates the first', () => {
    const events: AgentEvent[] = [
      user('u1', big(2000)), say('a1', big(2000)), done,
      user('u2', 'second'), say('a2', 'reply two'), done,
      { kind: 'context_compaction', id: 'cc1', summary: 'S1', firstKeptEventId: 'u2', tokensBefore: 9, tokensAfter: 3, reason: 'threshold' },
      user('u3', big(2000)), say('a3', big(2000)), done,
      user('u4', 'fourth'),
    ];
    const projection = projectContext(events);
    expect(projection.summary).toBe('S1');
    expect(projection.events[0]).toMatchObject({ id: 'u2' });
    expect(projection.events.some((e) => e.kind === 'context_compaction')).toBe(false);
    expect(projection.events.some((e) => 'id' in e && e.id === 'u1')).toBe(false);

    const plan = planCompaction(events, 10)!;
    expect(plan.previousSummary).toBe('S1');
    // Only what came after the first summary's cut is summarized again.
    expect(plan.toSummarize[0]).toMatchObject({ id: 'u2' });
  });

  it('serializes for the summarizer with tool output trimmed and the oldest part dropped when too long', () => {
    const text = serializeForSummary([user('u1', 'hi'), call('c1'), result('r1', 'c1', 'x'.repeat(10_000))], 100_000);
    expect(text).toContain('[User]: hi');
    expect(text).toContain('[Assistant tool call]: read_file(');
    expect(text).toContain('[Tool result from read_file]: ');
    expect(text).toContain('more characters truncated');
    const clipped = serializeForSummary([user('u1', 'OLDEST'), user('u2', 'y'.repeat(5000)), user('u3', 'NEWEST')], 1000);
    expect(clipped).not.toContain('OLDEST');
    expect(clipped).toContain('NEWEST');
  });

  it('asks for an update when there is a previous summary', () => {
    expect(buildSummaryRequest('conv', null, false, null)).toContain('Summarize the conversation above');
    const update = buildSummaryRequest('conv', 'old summary', true, 'the deploy');
    expect(update).toContain('<previous-summary>\nold summary\n</previous-summary>');
    expect(update).toContain('PRESERVE everything');
    expect(update).toContain('still being worked on');
    expect(update).toContain('Additional focus: the deploy');
  });
});

// ---- through the chat loop ----------------------------------------------------

type Body = { messages: Array<{ role: string; content: unknown }>; max_tokens?: number };

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const reply = (content: string, finish = 'stop') => sse([{ choices: [{ delta: { content }, finish_reason: finish }] }]);
const SUMMARY = '## Goal\nKeep chatting.\n\n## Critical Context\n- the secret word is PELICAN';

const isSummaryRequest = (body: Body) => body.messages[0]?.content === SUMMARIZATION_SYSTEM_PROMPT;

function parseEvents(payload: string): Array<{ kind: string; [key: string]: unknown }> {
  return payload
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.startsWith('data:'))
    .map((c) => JSON.parse(c.replace(/^data: /, '')));
}

describe('compaction in the Pocket Agent loop', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    t.app.inject({ method, url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });

  /**
   * A small model (4096-token window, the minimum reserve) and no tools, so a
   * few long replies are enough to cross the threshold.
   */
  async function setup(answer: (body: Body, n: number) => Response) {
    const bodies: Body[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      return answer(body, bodies.length);
    });
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await req('PATCH', '/api/planner/settings', {
      baseUrl: 'https://llm.example.com',
      compactionReserveTokens: 1024,
      compactionKeepRecentTokens: 1024,
    });
    for (const tool of (await req('GET', '/api/planner/tools')).json().tools as Array<{ name: string }>) {
      await req('PATCH', `/api/planner/tools/${tool.name}`, { enabled: false });
    }
    await req('POST', '/api/planner/models', { modelId: 'tiny', label: 'Tiny', contextWindow: 4096 });
    const chat = (await req('POST', '/api/planner/chats', { modelId: 'tiny' })).json() as { id: string };
    return { chat, bodies };
  }

  const send = async (chatId: string, content: string) =>
    parseEvents((await req('POST', `/api/planner/chats/${chatId}/messages`, { content })).payload);

  it('compacts once the context crosses the threshold, and later turns send the summary instead', async () => {
    const { chat, bodies } = await setup((body) => (isSummaryRequest(body) ? reply(SUMMARY) : reply(big(1500))));
    await send(chat.id, 'first ' + big(300));
    await send(chat.id, 'second ' + big(300));
    const third = await send(chat.id, 'third question');

    const summaryCalls = bodies.filter(isSummaryRequest);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
    const compaction = third.find((e) => e.kind === 'context_compaction');
    expect(compaction).toMatchObject({ summary: SUMMARY, reason: 'threshold' });
    expect(compaction!.tokensAfter as number).toBeLessThan(compaction!.tokensBefore as number);

    // The request after the compaction leads with the summary and no longer
    // carries the first exchange.
    const last = bodies.at(-1)!;
    expect(isSummaryRequest(last)).toBe(false);
    const sent = JSON.stringify(last.messages);
    expect(sent).toContain('PELICAN');
    expect(sent).not.toContain('first w');

    // The transcript keeps everything.
    const history = (await req('GET', `/api/planner/chats/${chat.id}/history`)).json().events as Array<{ kind: string; text?: string }>;
    expect(history.some((e) => e.kind === 'user_prompt' && e.text?.startsWith('first'))).toBe(true);

    // /context reports it.
    const preview = (await req('GET', `/api/planner/chats/${chat.id}/context-preview`)).json();
    expect(preview.budget).toMatchObject({ contextWindow: 4096, contextWindowSource: 'model', compactions: 1 });
  });

  it('recovers from a context-overflow error by compacting and retrying once', async () => {
    let overflowed = false;
    const { chat, bodies } = await setup((body, n) => {
      if (isSummaryRequest(body)) return reply(SUMMARY);
      if (n === 3 && !overflowed) {
        overflowed = true;
        return new Response('{"error":{"message":"This model\'s maximum context length is 4096 tokens"}}', { status: 400 });
      }
      return reply('short answer');
    });
    // Two short turns so nothing crosses the threshold on our own estimate.
    await send(chat.id, 'one');
    await send(chat.id, 'two');
    const events = await send(chat.id, 'three');
    expect(events.find((e) => e.kind === 'context_compaction')).toMatchObject({ reason: 'overflow' });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
    expect(events.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['short answer']);
    expect(bodies.filter(isSummaryRequest)).toHaveLength(1);
  });

  it('rejects a summary that was cut off, records no compaction, and carries on', async () => {
    const { chat, bodies } = await setup((body) =>
      isSummaryRequest(body) ? reply('## Goal\nhalf a summ', 'length') : reply(big(1500)),
    );
    await send(chat.id, 'first ' + big(300));
    await send(chat.id, 'second ' + big(300));
    const third = await send(chat.id, 'third');
    expect(bodies.some(isSummaryRequest)).toBe(true);
    expect(third.some((e) => e.kind === 'context_compaction')).toBe(false);
    expect(third.find((e) => e.kind === 'notice' && e.level === 'warn')?.text).toMatch(/cut off at the output limit/);
    expect(third.at(-1)).toMatchObject({ kind: 'turn_complete' });
  });

  it('/compact summarizes on request, with a focus', async () => {
    const { chat, bodies } = await setup((body) => (isSummaryRequest(body) ? reply(SUMMARY) : reply('ok')));
    await send(chat.id, 'remember the pelican');
    await send(chat.id, 'and the walrus');

    const res = await req('POST', `/api/planner/chats/${chat.id}/compact`, { focus: 'the animals' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ compacted: true });
    const summaryCall = bodies.find(isSummaryRequest)!;
    expect(JSON.stringify(summaryCall.messages)).toContain('Additional focus: the animals');

    await send(chat.id, 'what animals?');
    expect(JSON.stringify(bodies.at(-1)!.messages)).toContain('PELICAN');
  });

  it('/compact on an empty chat says there is nothing to do', async () => {
    const { chat } = await setup(() => reply('ok'));
    const res = await req('POST', `/api/planner/chats/${chat.id}/compact`, {});
    expect(res.json()).toMatchObject({ compacted: false, message: 'There is nothing to compact yet.' });
  });

  it('sends max_tokens only for a model whose row sets an output limit', async () => {
    const { chat, bodies } = await setup(() => reply('ok'));
    await send(chat.id, 'hi');
    expect(bodies.at(-1)).not.toHaveProperty('max_tokens');
    const models = (await req('GET', '/api/planner/models')).json().models as Array<{ id: string }>;
    await req('PATCH', `/api/planner/models/${models[0]!.id}`, { maxOutputTokens: 2048 });
    await send(chat.id, 'again');
    expect(bodies.at(-1)!.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(bodies.at(-1)!.max_tokens).toBeLessThanOrEqual(2048);
  });
});
