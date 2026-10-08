import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { parseUsage } from '../src/planner/llm-client.js';
import { applyCacheControl, resolvePromptCaching } from '../src/planner/prompt-cache.js';
import { roundTripCostUsd } from '../src/planner/cost.js';
import { budgetContextImages, imageDimensions } from '../src/planner/image-budget.js';
import { plannerModelSupportsImages } from '@pocketagent/protocol';

function png(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

function jpeg(width: number, height: number): string {
  const app0 = Buffer.alloc(18);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc2, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff, 0xff]), sof]).toString('base64');
}

/**
 * PA-122: the Pocket Agent loop follow-ups — prompt caching, cost, image
 * budgeting and steering. The loop tests drive the real
 * `/api/planner/chats` HTTP surface against a scripted fake LLM endpoint
 * that records every request body, the same harness `planner-loop.test.ts`
 * uses.
 */

type Body = {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
  tools?: Array<Record<string, unknown>>;
};

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const reply = (content: string, usage?: Record<string, unknown>) =>
  sse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }, ...(usage ? [{ choices: [], usage }] : [])]);

const toolCall = (calls: Array<{ name: string; args: string; id?: string }>, usage?: Record<string, unknown>) =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((c, i) => ({
              index: i,
              id: c.id ?? `call_${i + 1}`,
              function: { name: c.name, arguments: c.args },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    ...(usage ? [{ choices: [], usage }] : []),
  ]);

function scripted(responses: Array<(body: Body) => Response | Promise<Response>>) {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    const next = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
    return next(body);
  });
  return { fetchImpl, bodies };
}

function parseEvents(payload: string): Array<{ kind: string; [key: string]: unknown }> {
  return payload
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.startsWith('data:'))
    .map((c) => JSON.parse(c.replace(/^data: /, '')));
}

describe('PA-122 usage parsing and cache markers (pure)', () => {
  it('reads OpenAI-style cached tokens as a subset of prompt_tokens', () => {
    expect(
      parseUsage({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }),
    ).toEqual({ promptTokens: 1000, completionTokens: 50, cacheReadTokens: 800, cacheWriteTokens: null, costUsd: null });
  });

  it('normalises an Anthropic-style report whose prompt_tokens leaves the cache out', () => {
    const usage = parseUsage({
      prompt_tokens: 20,
      completion_tokens: 5,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
    })!;
    expect(usage.promptTokens).toBe(1020);
    expect(usage.cacheReadTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBe(100);
  });

  it('keeps an inclusive Anthropic-style passthrough as is, and reads a reported cost', () => {
    const usage = parseUsage({ prompt_tokens: 1000, completion_tokens: 5, cache_read_input_tokens: 600, cost: 0.0123 })!;
    expect(usage.promptTokens).toBe(1000);
    expect(usage.cacheReadTokens).toBe(600);
    expect(usage.costUsd).toBe(0.0123);
  });

  it('reports nothing about caching when the provider says nothing', () => {
    const usage = parseUsage({ prompt_tokens: 10, completion_tokens: 2 })!;
    expect(usage.cacheReadTokens).toBeNull();
    expect(usage.cacheWriteTokens).toBeNull();
  });

  it('turns caching on automatically only for Claude models, and lets the row decide', () => {
    expect(resolvePromptCaching('claude-sonnet-4-5', null)).toBe(true);
    expect(resolvePromptCaching('anthropic/claude-opus-4', undefined)).toBe(true);
    expect(resolvePromptCaching('gpt-4o', null)).toBe(false);
    expect(resolvePromptCaching('gpt-4o', true)).toBe(true);
    expect(resolvePromptCaching('claude-sonnet-4-5', false)).toBe(false);
  });

  it('marks the stable system prefix, the last tool and the last user/tool message', () => {
    const messages = [
      { role: 'system' as const, content: 'BASE\n\nMEMORIES' },
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: null, tool_calls: [] },
      { role: 'tool' as const, tool_call_id: 't1', content: 'result' },
    ];
    const tools = [{ type: 'function', function: { name: 'a' } }, { type: 'function', function: { name: 'b' } }];
    const out = applyCacheControl(messages, tools, 'BASE');
    expect(out.messages[0]!.content).toEqual([
      { type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\nMEMORIES' },
    ]);
    expect(out.messages[1]!.content).toBe('hi');
    expect(out.messages[3]!.content).toEqual([{ type: 'text', text: 'result', cache_control: { type: 'ephemeral' } }]);
    expect(out.tools[0]).not.toHaveProperty('cache_control');
    expect(out.tools[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    // The inputs are untouched, so they can be sent again unmarked.
    expect(messages[0]!.content).toBe('BASE\n\nMEMORIES');
    expect(tools[1]).not.toHaveProperty('cache_control');
  });

  it('marks the last part of a multi-part user message and the whole system message when nothing varies', () => {
    const out = applyCacheControl(
      [
        { role: 'system', content: 'BASE' },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
            { type: 'text', text: 'look' },
          ],
        },
      ],
      [],
      'BASE',
    );
    expect(out.messages[0]!.content).toEqual([{ type: 'text', text: 'BASE', cache_control: { type: 'ephemeral' } }]);
    expect(out.messages[1]!.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
      { type: 'text', text: 'look', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

describe('PA-122 cost (pure)', () => {
  const prices = {
    inputPricePerMTok: 3,
    outputPricePerMTok: 15,
    cacheReadPricePerMTok: 0.3,
    cacheWritePricePerMTok: 3.75,
  };

  it('prices uncached input, cache reads, cache writes and output separately', () => {
    const cost = roundTripCostUsd(
      { promptTokens: 1_000_000, completionTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 200_000 },
      prices,
    );
    // 300k uncached × $3 + 500k × $0.30 + 200k × $3.75 + 100k × $15
    expect(cost).toBeCloseTo(0.9 + 0.15 + 0.75 + 1.5, 10);
  });

  it('charges an unset cache price at the input price', () => {
    const cost = roundTripCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: null },
      { ...prices, cacheReadPricePerMTok: null },
    );
    expect(cost).toBeCloseTo(3, 10);
  });

  it('is null, never 0, without an input and output price or without usage', () => {
    const usage = { promptTokens: 10, completionTokens: 10 };
    expect(roundTripCostUsd(usage, null)).toBeNull();
    expect(roundTripCostUsd(usage, { ...prices, outputPricePerMTok: null })).toBeNull();
    expect(roundTripCostUsd(null, prices)).toBeNull();
  });

  it('believes a cost the provider reports over the configured prices', () => {
    expect(roundTripCostUsd({ promptTokens: 10, completionTokens: 10, costUsd: 0.5 }, prices)).toBe(0.5);
    expect(roundTripCostUsd({ promptTokens: 10, completionTokens: 10, costUsd: 0.5 }, null)).toBe(0.5);
  });
});

describe('PA-122 image budget (pure)', () => {
  it('reads dimensions from PNG, JPEG, GIF and WebP headers', () => {
    expect(imageDimensions('image/png', png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageDimensions('image/jpeg', jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    const gif = Buffer.from('GIF89a\x40\x01\xf0\x00', 'latin1');
    expect(imageDimensions('image/gif', gif.toString('base64'))).toEqual({ width: 320, height: 240 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(imageDimensions('image/webp', webp.toString('base64'))).toEqual({ width: 800, height: 600 });
  });

  it('answers null for bytes that are not the image they claim to be', () => {
    expect(imageDimensions('image/png', jpeg(10, 10))).toBeNull();
    expect(imageDimensions('image/jpeg', png(10, 10))).toBeNull();
    expect(imageDimensions('image/jpeg', Buffer.from('not an image').toString('base64'))).toBeNull();
  });

  const image = (data: string, type = 'image/png') => ({
    type: 'image_url' as const,
    image_url: { url: `data:${type};base64,${data}` },
  });

  it('replaces every image with a note for a model that cannot read them, as plain text', () => {
    const out = budgetContextImages(
      [{ role: 'user', content: [image(png(10, 10)), { type: 'text', text: 'what is this?' }] }],
      { supportsImages: false, modelId: 'deepseek-chat' },
    );
    expect(out[0]).toEqual({
      role: 'user',
      content: '[An image was attached here, but deepseek-chat cannot read images, so it was left out.]\n\nwhat is this?',
    });
  });

  it('sends only the newest images, and leaves out unreadable or oversized ones', () => {
    const messages = [1, 2, 3, 4, 5, 6].map((n) => ({
      role: 'user' as const,
      content: [image(png(100 * n, 100)), { type: 'text' as const, text: `image ${n}` }],
    }));
    messages[5]!.content[0] = image(png(9000, 100));
    messages[4]!.content[0] = image(Buffer.from('garbage').toString('base64'));
    const out = budgetContextImages(messages, { supportsImages: true, modelId: 'gpt-4o', maxImages: 2 });
    expect(String(out[5]!.content)).toMatch(/9000×100 it is too large/);
    expect(String(out[4]!.content)).toMatch(/could not be read/);
    expect(Array.isArray(out[3]!.content)).toBe(true);
    expect(Array.isArray(out[2]!.content)).toBe(true);
    for (const old of [out[0]!, out[1]!]) expect(String(old.content)).toMatch(/left out to save context/);
  });

  it('decides image support from the row, then a short text-only list, else yes', () => {
    expect(plannerModelSupportsImages('deepseek-chat', null)).toBe(false);
    expect(plannerModelSupportsImages('deepseek/deepseek-reasoner', undefined)).toBe(false);
    expect(plannerModelSupportsImages('deepseek-vl2', null)).toBe(true);
    expect(plannerModelSupportsImages('some-new-model', null)).toBe(true);
    expect(plannerModelSupportsImages('deepseek-chat', true)).toBe(true);
    expect(plannerModelSupportsImages('gpt-4o', false)).toBe(false);
  });
});

describe('PA-122 Pocket Agent loop', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  async function setup(
    fetchImpl: ReturnType<typeof vi.fn>,
    model: { modelId: string } & Record<string, unknown> = { modelId: 'gpt-4o' },
  ) {
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://llm.example.com' });
    const created = await post('/api/planner/models', { label: model.modelId, ...model });
    expect(created.statusCode).toBe(201);
    return (await post('/api/planner/chats', { modelId: model.modelId })).json() as { id: string; workspaceId: string };
  }

  async function send(chatId: string, content: string, extra: Record<string, unknown> = {}) {
    const res = await post(`/api/planner/chats/${chatId}/messages`, { content, ...extra });
    return parseEvents(res.payload);
  }

  // ---- Part 1: prompt caching -------------------------------------------------

  it('sends cache breakpoints to a Claude model and rolls the last one forward each round trip', async () => {
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'list_workspaces', args: '{}' }]),
      () => reply('done'),
    ]);
    const chat = await setup(fetchImpl, { modelId: 'claude-sonnet-4-5' });
    await send(chat.id, 'look around');

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const system = body.messages[0]!;
      expect(system.role).toBe('system');
      expect(Array.isArray(system.content)).toBe(true);
      expect((system.content as Array<Record<string, unknown>>)[0]).toMatchObject({
        type: 'text',
        cache_control: { type: 'ephemeral' },
      });
      expect(body.tools!.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });
      expect(body.tools!.slice(0, -1).some((tool) => 'cache_control' in tool)).toBe(false);
    }
    // First round trip: the prompt carries the rolling breakpoint.
    const firstUser = bodies[0]!.messages.at(-1)!;
    expect(firstUser.role).toBe('user');
    expect(firstUser.content).toEqual([{ type: 'text', text: 'look around', cache_control: { type: 'ephemeral' } }]);
    // Second: it has moved to the tool result, and the prompt is plain again.
    const second = bodies[1]!.messages;
    expect(second.at(-1)!.role).toBe('tool');
    expect(JSON.stringify(second.at(-1)!.content)).toContain('ephemeral');
    expect(second.find((m) => m.role === 'user')!.content).toBe('look around');
  });

  it('never sends cache_control to a model whose caching is off', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('hi')]);
    const chat = await setup(fetchImpl, { modelId: 'gpt-4o' });
    await send(chat.id, 'hello');
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
    expect(typeof bodies[0]!.messages[0]!.content).toBe('string');
  });

  it('honours an explicit per-model setting in both directions', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('hi')]);
    const chat = await setup(fetchImpl, { modelId: 'claude-sonnet-4-5', promptCaching: false });
    await send(chat.id, 'hello');
    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');

    const models = (await t.app.inject({ method: 'GET', url: '/api/planner/models', headers: authHeaders(t.cookie) })).json()
      .models as Array<{ id: string; promptCaching: boolean | null }>;
    expect(models[0]!.promptCaching).toBe(false);
    await patch(`/api/planner/models/${models[0]!.id}`, { promptCaching: null });
    await send(chat.id, 'again');
    expect(JSON.stringify(bodies[1])).toContain('cache_control');
  });

  it('retries without markers once when the endpoint refuses them, and says so', async () => {
    const { fetchImpl, bodies } = scripted([
      () =>
        new Response(JSON.stringify({ error: { message: 'Extra inputs are not permitted: cache_control' } }), {
          status: 400,
        }),
      () => toolCall([{ name: 'list_workspaces', args: '{}' }]),
      () => reply('ok'),
    ]);
    const chat = await setup(fetchImpl, { modelId: 'claude-sonnet-4-5' });
    const events = await send(chat.id, 'hello');

    expect(bodies).toHaveLength(3);
    expect(JSON.stringify(bodies[0])).toContain('cache_control');
    // Both later round trips of the same turn go unmarked.
    expect(JSON.stringify(bodies[1])).not.toContain('cache_control');
    expect(JSON.stringify(bodies[2])).not.toContain('cache_control');
    const notices = events.filter((e) => e.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ level: 'warn' });
    expect(String(notices[0]!.text)).toMatch(/refused prompt-caching markers/);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
  });

  it('adds the cached tokens of every round trip into turn_complete', async () => {
    const { fetchImpl } = scripted([
      () =>
        toolCall([{ name: 'list_workspaces', args: '{}' }], {
          prompt_tokens: 1000,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 0 },
          cache_creation_input_tokens: 900,
        }),
      () =>
        reply('done', {
          prompt_tokens: 1200,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900 },
        }),
    ]);
    const chat = await setup(fetchImpl, { modelId: 'claude-sonnet-4-5' });
    const events = await send(chat.id, 'go');
    expect(events.at(-1)).toMatchObject({
      kind: 'turn_complete',
      inputTokens: 2200,
      outputTokens: 30,
      cacheReadTokens: 900,
      cacheWriteTokens: 900,
    });
  });

  it('leaves the cache fields null when the provider never mentions caching', async () => {
    const { fetchImpl } = scripted([() => reply('hi', { prompt_tokens: 10, completion_tokens: 2 })]);
    const chat = await setup(fetchImpl);
    const events = await send(chat.id, 'hello');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', cacheReadTokens: null, cacheWriteTokens: null });
  });

  // ---- Part 2: cost ---------------------------------------------------------

  const priced = { inputPricePerMTok: 2, outputPricePerMTok: 10 };

  it('fills turn_complete.costUsd from the model prices across every round trip', async () => {
    const { fetchImpl } = scripted([
      () => toolCall([{ name: 'list_workspaces', args: '{}' }], { prompt_tokens: 100_000, completion_tokens: 1_000 }),
      () => reply('done', { prompt_tokens: 200_000, completion_tokens: 2_000 }),
    ]);
    const chat = await setup(fetchImpl, { modelId: 'gpt-4o', ...priced });
    const events = await send(chat.id, 'go');
    const done = events.at(-1)!;
    expect(done.kind).toBe('turn_complete');
    // 300k in × $2 + 3k out × $10, per million
    expect(done.costUsd as number).toBeCloseTo(0.6 + 0.03, 10);

    const preview = (
      await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/context-preview`, headers: authHeaders(t.cookie) })
    ).json();
    expect(preview.budget.spentUsd).toBeCloseTo(0.63, 10);
  });

  it('reports no cost for an unpriced model, or when a round trip reported no usage', async () => {
    const unpriced = scripted([() => reply('hi', { prompt_tokens: 10, completion_tokens: 2 })]);
    const chat = await setup(unpriced.fetchImpl, { modelId: 'gpt-4o' });
    expect((await send(chat.id, 'hello')).at(-1)).toMatchObject({ kind: 'turn_complete', costUsd: null });
    await t.cleanup();

    const partial = scripted([
      () => toolCall([{ name: 'list_workspaces', args: '{}' }], { prompt_tokens: 100, completion_tokens: 10 }),
      () => reply('done'),
    ]);
    const chat2 = await setup(partial.fetchImpl, { modelId: 'gpt-4o', ...priced });
    const done = (await send(chat2.id, 'go')).at(-1)!;
    expect(done.costUsd).toBeNull();
    // The tokens that were reported still are.
    expect(done.inputTokens).toBe(100);
  });

  it('keeps the cost of the turn so far when a parked approval is interrupted', async () => {
    const { fetchImpl } = scripted([
      () =>
        toolCall([{ name: 'write_file', args: JSON.stringify({ path: 'a.txt', content: 'x' }) }], {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
        }),
    ]);
    const chat = await setup(fetchImpl, { modelId: 'gpt-4o', ...priced });
    const events = await send(chat.id, 'write it');
    expect(events.some((e) => e.kind === 'permission_request')).toBe(true);
    await post(`/api/planner/chats/${chat.id}/interrupt`);
    const history = (
      await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/history`, headers: authHeaders(t.cookie) })
    ).json().events as Array<{ kind: string; costUsd?: number | null; stopReason?: string }>;
    const done = history.filter((e) => e.kind === 'turn_complete').at(-1)!;
    expect(done.stopReason).toBe('interrupted');
    expect(done.costUsd).toBeCloseTo(2, 10);
  });

  it('accepts, returns and clears the price fields', async () => {
    const { fetchImpl } = scripted([() => reply('hi')]);
    await setup(fetchImpl, { modelId: 'gpt-4o', ...priced, cacheReadPricePerMTok: 0.5 });
    const list = () =>
      t.app
        .inject({ method: 'GET', url: '/api/planner/models', headers: authHeaders(t.cookie) })
        .then((r) => r.json().models as Array<Record<string, unknown>>);
    const [model] = await list();
    expect(model).toMatchObject({
      inputPricePerMTok: 2,
      outputPricePerMTok: 10,
      cacheReadPricePerMTok: 0.5,
      cacheWritePricePerMTok: null,
    });
    expect((await patch(`/api/planner/models/${model!.id}`, { inputPricePerMTok: -1 })).statusCode).toBe(400);
    await patch(`/api/planner/models/${model!.id}`, { inputPricePerMTok: null });
    expect((await list())[0]!.inputPricePerMTok).toBeNull();
  });

  // ---- Part 3: images --------------------------------------------------------

  const attached = (data: string) => ({ image: { mediaType: 'image/png', data } });

  it('sends a text-only model a note instead of the image, and keeps the image in the chat', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('I cannot see it')]);
    const chat = await setup(fetchImpl, { modelId: 'deepseek-chat' });
    await send(chat.id, 'what is in this?', attached(png(800, 600)));

    const user = bodies[0]!.messages.find((m) => m.role === 'user')!;
    expect(user.content).toBe(
      '[An image was attached here, but deepseek-chat cannot read images, so it was left out.]\n\nwhat is in this?',
    );
    const history = (
      await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/history`, headers: authHeaders(t.cookie) })
    ).json().events as Array<{ kind: string; image?: unknown }>;
    expect(history.find((e) => e.kind === 'user_prompt')!.image).toMatchObject({ mediaType: 'image/png' });
  });

  it('re-sends only the newest four images of a long chat', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('ok')]);
    const chat = await setup(fetchImpl, { modelId: 'gpt-4o' });
    for (let n = 1; n <= 6; n++) await send(chat.id, `look at ${n}`, attached(png(100 * n, 100)));
    const last = bodies.at(-1)!;
    const imageParts = last.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type: string }>).filter((p) => p.type === 'image_url') : [],
    );
    expect(imageParts).toHaveLength(4);
    const firstUser = last.messages.find((m) => m.role === 'user')!;
    expect(String(firstUser.content)).toMatch(/left out to save context/);
  });

  it('accepts, returns and clears supportsImages', async () => {
    const { fetchImpl } = scripted([() => reply('hi')]);
    await setup(fetchImpl, { modelId: 'gpt-4o', supportsImages: false });
    const list = async () =>
      (await t.app.inject({ method: 'GET', url: '/api/planner/models', headers: authHeaders(t.cookie) })).json()
        .models as Array<{ id: string; supportsImages: boolean | null }>;
    const [model] = await list();
    expect(model!.supportsImages).toBe(false);
    await patch(`/api/planner/models/${model!.id}`, { supportsImages: null });
    expect((await list())[0]!.supportsImages).toBeNull();
  });

  // ---- Part 4: steering -----------------------------------------------------

  /** A response the test releases when it is ready, so a turn can be held
      mid-flight while a message is queued. */
  function deferred() {
    let release!: (r: Response) => void;
    const promise = new Promise<Response>((resolve) => (release = resolve));
    return { promise, release };
  }

  async function waitFor(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const history = async (chatId: string) =>
    (await get(`/api/planner/chats/${chatId}/history`)).json().events as Array<{ kind: string; [k: string]: unknown }>;
  const queue = (chatId: string, content: string) => post(`/api/planner/chats/${chatId}/queue`, { content });
  const userTexts = (body: Body) => body.messages.filter((m) => m.role === 'user').map((m) => m.content);

  it('delivers a message sent mid-turn after the current tool batch, never between a call and its result', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([
      () => first.promise,
      () => reply('done, and checked the config too'),
    ]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'look around');
    await waitFor(() => bodies.length === 1, 'the first request');

    const queued = await queue(chat.id, 'also check the config');
    expect(queued.statusCode).toBe(201);
    expect(queued.json().queuedPrompts).toHaveLength(1);
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts).toHaveLength(1);

    first.release(toolCall([{ name: 'list_workspaces', args: '{}' }]));
    const events = await turn;

    const second = bodies[1]!.messages;
    const roles = second.map((m) => m.role);
    expect(roles.slice(-4)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(second.at(-1)!.content).toBe('also check the config');
    // It reached the stream of the turn it steered, after the tool result.
    const kinds = events.map((e) => e.kind);
    expect(kinds.lastIndexOf('user_prompt')).toBeGreaterThan(kinds.indexOf('tool_result'));
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts).toEqual([]);
  });

  it('starts the next turn with a message queued while the model was writing its final answer', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise, () => reply('second answer')]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'first question');
    await waitFor(() => bodies.length === 1, 'the first request');
    await queue(chat.id, 'and a follow-up');
    first.release(reply('first answer'));
    await turn;

    await waitFor(async () => (await history(chat.id)).filter((e) => e.kind === 'turn_complete').length === 2, 'the follow-up turn');
    expect(userTexts(bodies[1]!)).toEqual(['first question', 'and a follow-up']);
    const events = await history(chat.id);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'text',
      'turn_complete',
      'user_prompt',
      'text',
      'turn_complete',
    ]);
  });

  it('delivers at once when the chat is idle by the time the message arrives', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('hi')]);
    const chat = await setup(fetchImpl);
    expect((await queue(chat.id, 'hello')).statusCode).toBe(201);
    await waitFor(async () => (await history(chat.id)).some((e) => e.kind === 'turn_complete'), 'the turn');
    expect(userTexts(bodies[0]!)).toEqual(['hello']);
  });

  it('never answers a pending approval, and is delivered after a human answers it', async () => {
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'write_file', args: JSON.stringify({ path: 'a.txt', content: 'x' }) }]),
      () => reply('written'),
    ]);
    const chat = await setup(fetchImpl);
    const events = await send(chat.id, 'write it');
    const request = events.find((e) => e.kind === 'permission_request')!;

    await queue(chat.id, 'use a.md instead if you can');
    // Still parked: nothing resolved it, nothing ran, the model was not asked again.
    expect(bodies).toHaveLength(1);
    expect((await history(chat.id)).some((e) => e.kind === 'permission_resolved')).toBe(false);
    expect((await get(`/api/planner/chats/${chat.id}`)).json()).toMatchObject({ busy: true });

    const resumed = await post(`/api/planner/chats/${chat.id}/approvals/${request.id as string}`, { decision: 'deny' });
    const after = parseEvents(resumed.payload);
    expect(after.find((e) => e.kind === 'permission_resolved')).toMatchObject({ decision: 'deny' });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'use a.md instead if you can' });
  });

  it('keeps the queue through an interrupt and runs it as the next turn', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise, () => reply('ok, doing that instead')]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'start the long thing');
    await waitFor(() => bodies.length === 1, 'the first request');
    await queue(chat.id, 'actually, do this instead');
    await post(`/api/planner/chats/${chat.id}/interrupt`);
    first.release(reply('too late'));
    await turn;

    await waitFor(() => bodies.length === 2, 'the follow-up request');
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'actually, do this instead' });
  });

  it('lets a queued message be cancelled, and /clear discards the queue', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise, () => reply('second')]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'go');
    await waitFor(() => bodies.length === 1, 'the first request');

    const a = (await queue(chat.id, 'cancel me')).json().prompt.id as string;
    await queue(chat.id, 'clear me');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/planner/chats/${chat.id}/queue/${a}`, headers: authHeaders(t.cookie) })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/planner/chats/${chat.id}/queue/${a}`, headers: authHeaders(t.cookie) })).statusCode).toBe(404);
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts.map((q: { text: string }) => q.text)).toEqual(['clear me']);

    await t.app.inject({ method: 'DELETE', url: `/api/planner/chats/${chat.id}/history`, headers: authHeaders(t.cookie) });
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts).toEqual([]);
    first.release(reply('first'));
    await turn;
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies).toHaveLength(1);
  });

  it('runs a queued message before a subagent wake, and only then the wake', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise, () => reply('answered you'), () => reply('noted the subagent')]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'start');
    await waitFor(() => bodies.length === 1, 'the first request');
    t.app.pocket.plannerChats.enqueueMailbox(chat.id, {
      kind: 'coding_agent',
      subagentId: 'sub-1',
      status: 'completed',
      summary: 'all green',
    });
    await queue(chat.id, 'my follow-up');
    first.release(reply('first'));
    await turn;

    await waitFor(() => bodies.length === 3, 'the follow-up and the wake');
    expect(bodies[1]!.messages.at(-1)).toMatchObject({ role: 'user', content: 'my follow-up' });
    expect(String(bodies[2]!.messages.at(-1)!.content)).toMatch(/^\[Subagent Notification\]/);
  });

  it('still answers 409 on POST /messages for a busy chat — only the queue steers', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'go');
    await waitFor(() => bodies.length === 1, 'the first request');
    const busy = await post(`/api/planner/chats/${chat.id}/messages`, { content: 'again' });
    expect(busy.statusCode).toBe(409);
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts).toEqual([]);
    first.release(reply('first'));
    await turn;
  });

  it('counts a queued message as planner work for Gemini Live', async () => {
    const first = deferred();
    const { fetchImpl, bodies } = scripted([() => first.promise]);
    const chat = await setup(fetchImpl);
    const turn = send(chat.id, 'go');
    await waitFor(() => bodies.length === 1, 'the first request');
    await queue(chat.id, 'queued');
    const service = t.app.pocket.plannerChats as unknown as {
      busyWithPlannerLoop(id: string): boolean;
      activeTurns: Map<string, number>;
    };
    // Simulate the instant between turns: no turn counted, a message queued.
    const saved = service.activeTurns.get(chat.id);
    service.activeTurns.delete(chat.id);
    expect(service.busyWithPlannerLoop(chat.id)).toBe(true);
    service.activeTurns.set(chat.id, saved!);
    await t.app.inject({ method: 'DELETE', url: `/api/planner/chats/${chat.id}/history`, headers: authHeaders(t.cookie) });
    first.release(reply('first'));
    await turn.catch(() => {});
  });

  it('delivers at boot what a forced restart left queued', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('picked it up')]);
    const chat = await setup(fetchImpl);
    const { insertPlannerQueuedPrompt } = await import('../src/planner/store.js');
    insertPlannerQueuedPrompt(t.app.pocket.db, {
      id: 'left-over',
      chatId: chat.id,
      content: 'sent just before the restart',
      image: null,
      createdAt: Date.now(),
    });
    t.app.pocket.plannerChats.resumeQueuedPrompts();
    await waitFor(() => bodies.length === 1, 'the delivered turn');
    expect(userTexts(bodies[0]!)).toEqual(['sent just before the restart']);
  });

  it('leaves a queue it cannot deliver visible instead of retrying forever', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('never')]);
    const chat = await setup(fetchImpl);
    await patch('/api/planner/settings', { baseUrl: '' });
    expect((await queue(chat.id, 'nowhere to go')).statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(bodies).toHaveLength(0);
    expect((await get(`/api/planner/chats/${chat.id}`)).json().queuedPrompts).toHaveLength(1);
  });
});
