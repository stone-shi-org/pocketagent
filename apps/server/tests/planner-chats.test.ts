import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannerLlmClient, PlannerLlmError } from '../src/planner/llm-client.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-6: the LLM client, the chat turn loop (phase 2), the read-only
 * tool-calling loop (phase 3), and the mutating-tool approval gate (phase
 * 4), all exercised through the `/api/planner/chats` HTTP surface.
 */

// ---- PlannerLlmClient, unit-level against an injected fetch ----------------

/** Joins fake SSE data frames (each already JSON-encoded) into one
    OpenAI-style streamed response body, terminated the standard way. */
function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakeCompletionResponse(content: string): Response {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

function fakeToolCallResponse(name: string, args: Record<string, unknown>, callId = 'call_1'): Response {
  return sseResponse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    }),
  ]);
}

/** Drains a `streamComplete` async generator into a plain array, since most
    assertions below want to inspect the whole sequence (or just its `done`
    tail) rather than react to each event as it arrives. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

describe('PlannerLlmClient', () => {
  it('sends the model, messages, and Authorization header, and streams the reply text', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('hello there'));
    const client = new PlannerLlmClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      fetchImpl,
    });

    const events = await collect(client.streamComplete('gpt-4o-mini', [{ role: 'user', content: 'hi' }]));

    expect(events).toEqual([
      { type: 'text_delta', text: 'hello there' },
      { type: 'done', content: 'hello there', toolCalls: [], usage: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('omits the Authorization header when no API key is configured', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await collect(client.streamComplete('m', []));
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('strips a trailing slash from baseUrl before appending the path', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com/v1/', apiKey: null, fetchImpl });
    await collect(client.streamComplete('m', []));
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('throws PlannerLlmError on a non-2xx response, including the status', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Response('server exploded', { status: 500 }));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(collect(client.streamComplete('m', []))).rejects.toThrow(PlannerLlmError);
    await expect(collect(client.streamComplete('m', []))).rejects.toMatchObject({ statusCode: 500 });
  });

  it('throws PlannerLlmError when the stream has no message content or tool calls', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => sseResponse([JSON.stringify({ choices: [{ delta: {} }] })]));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(collect(client.streamComplete('m', []))).rejects.toThrow(/no message content/);
  });

  it('throws PlannerLlmError when the stream has no chunks at all', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => sseResponse([]));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(collect(client.streamComplete('m', []))).rejects.toThrow(/empty stream/);
  });

  it('throws PlannerLlmError when fetch itself rejects (network failure)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(collect(client.streamComplete('m', []))).rejects.toThrow(/Could not reach/);
  });

  it('parses tool_calls out of the stream, with null content', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeToolCallResponse('list_workspaces', {}));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    const events = await collect(client.streamComplete('m', []));
    const done = events.find((e) => e.type === 'done') as { content: string | null; toolCalls: unknown[] };
    expect(done.content).toBeNull();
    expect(done.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'list_workspaces', arguments: '{}' } },
    ]);
  });

  it('sends a tools array only when tools are passed', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });

    await collect(client.streamComplete('m', []));
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).not.toHaveProperty('tools');

    await collect(client.streamComplete('m', [], [{ type: 'function', function: { name: 'x' } }]));
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body as string).tools).toHaveLength(1);
  });

  it('listModels GETs /models and returns the ids from the "data" array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', fetchImpl });
    const ids = await client.listModels();
    expect(ids).toEqual(['gpt-4o', 'gpt-4o-mini']);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/models');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('listModels throws PlannerLlmError when the response has no "data" array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'list' }), { status: 200 }),
    );
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(client.listModels()).rejects.toThrow(/no "data" array/);
  });

  it('listModels throws PlannerLlmError on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(client.listModels()).rejects.toMatchObject({ statusCode: 401 });
  });
});

// ---- HTTP surface -----------------------------------------------------------

/**
 * The streaming routes (`POST .../messages`, `POST .../approvals/:id`)
 * answer `text/event-stream`: newline-delimited `data: <json>\n\n` frames,
 * one per `AgentEvent`. `app.inject()` still buffers the whole response body
 * (it waits for the response to end either way), so a real turn's full event
 * sequence is available in one `res.payload` string — this just splits it
 * back into the array `PlannerChatService`'s generator actually yielded.
 */
function parseEvents(res: { payload: string }): Array<{ kind: string; [key: string]: unknown }> {
  return res.payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}

function findEvent(
  events: Array<{ kind: string; [key: string]: unknown }>,
  kind: string,
): { kind: string; [key: string]: unknown } | undefined {
  return events.find((e) => e.kind === kind);
}

/** `text_delta` events stream live but are never persisted (see `driveLoop`'s
    doc comment) — so a comparison against the on-disk history has to ignore
    them, the same way the persistence layer itself does. */
function dropTextDeltas(
  events: Array<{ kind: string; [key: string]: unknown }>,
): Array<{ kind: string; [key: string]: unknown }> {
  return events.filter((e) => e.kind !== 'text_delta');
}

describe('planner chat routes over HTTP', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const get = (t2: TestApp, url: string) =>
    t2.app.inject({ method: 'GET', url, headers: authHeaders(t2.cookie) });
  const post = (t2: TestApp, url: string, payload?: unknown) =>
    t2.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(t2.cookie),
      ...(payload !== undefined ? { payload } : {}),
    });
  const patch = (t2: TestApp, url: string, payload: unknown) =>
    t2.app.inject({ method: 'PATCH', url, headers: authHeaders(t2.cookie), payload });
  const del = (t2: TestApp, url: string) =>
    t2.app.inject({ method: 'DELETE', url, headers: authHeaders(t2.cookie) });

  /** Sends a message and returns the turn's full parsed event sequence. */
  const sendMessage = async (t2: TestApp, chatId: string, content: string) => {
    const res = await post(t2, `/api/planner/chats/${chatId}/messages`, { content });
    return { res, events: parseEvents(res) };
  };

  /** Resolves a paused approval and returns the rest of the turn's events. */
  const resolve = async (t2: TestApp, chatId: string, approvalId: string, decision: string) => {
    const res = await post(t2, `/api/planner/chats/${chatId}/approvals/${approvalId}`, { decision });
    return { res, events: parseEvents(res) };
  };

  it('creates a chat defaulting to the default workspace', async () => {
    t = await createTestApp();
    const created = await post(t, '/api/planner/chats', {});
    expect(created.statusCode).toBe(201);
    const chat = created.json();
    expect(chat.workspaceName).toBe('Pocket Agent');
    expect(chat.title).toBeNull();
    expect(chat.lastModelId).toBeNull();

    const list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(chat.id);
  });

  it('creates a chat in an explicit workspace and with an explicit title', async () => {
    t = await createTestApp();
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Research' })).json();
    const created = await post(t, '/api/planner/chats', { workspaceId: ws.id, title: 'Digging into X' });
    expect(created.statusCode).toBe(201);
    expect(created.json().workspaceName).toBe('Research');
    expect(created.json().title).toBe('Digging into X');
  });

  it('404s creating a chat in an unknown workspace', async () => {
    t = await createTestApp();
    const res = await post(t, '/api/planner/chats', { workspaceId: 'does-not-exist' });
    expect(res.statusCode).toBe(404);
  });

  it("a new chat's model defaults to its agent's own configured model over the global last-used one", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });

    // Complete one turn with an explicit model to seed the *global*
    // last-used setting (only a completed turn writes it — creating a chat
    // alone does not).
    const plainChat = (await post(t, '/api/planner/chats', { modelId: 'global-default' })).json();
    await sendMessage(t, plainChat.id, 'hi');
    expect((await get(t, '/api/planner/settings')).json().lastModelId).toBe('global-default');

    const ws = (await post(t, '/api/planner/workspaces', { name: 'Coder' })).json();
    await patch(t, `/api/planner/workspaces/${ws.id}`, { defaultModelId: 'agent-specific-model' });

    // No explicit modelId on the request — should pick up the agent's own
    // default, not the global last-used model.
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id })).json();
    expect(chat.lastModelId).toBe('agent-specific-model');
  });

  it('renames a chat and changes its model', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const renamed = await patch(t, `/api/planner/chats/${chat.id}`, { title: 'New title' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe('New title');

    const modeled = await patch(t, `/api/planner/chats/${chat.id}`, { modelId: 'gpt-4o' });
    expect(modeled.json().lastModelId).toBe('gpt-4o');

    // Clearing it back to untitled — the frontend's rename-to-empty affordance.
    const cleared = await patch(t, `/api/planner/chats/${chat.id}`, { title: null });
    expect(cleared.json().title).toBeNull();
  });

  // ---- PA-6 round 6: auto-titling an untitled chat from its first prompt ----

  it("auto-titles an untitled chat from its first prompt's first line", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    expect(chat.title).toBeNull();

    await sendMessage(t, chat.id, 'Plan my week\nwith some extra detail on the second line');
    const list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list.find((c: { id: string }) => c.id === chat.id).title).toBe('Plan my week');
  });

  it('truncates a long first line to 80 characters with an ellipsis', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const longPrompt = 'x'.repeat(120);
    await sendMessage(t, chat.id, longPrompt);
    const list = (await get(t, '/api/planner/chats')).json().chats;
    const title = list.find((c: { id: string }) => c.id === chat.id).title as string;
    expect(title).toHaveLength(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never overwrites a title once set, including one the auto-titler picked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'first message sets the title');
    await sendMessage(t, chat.id, 'a totally different second message');
    const list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list.find((c: { id: string }) => c.id === chat.id).title).toBe('first message sets the title');
  });

  it('does not overwrite a title a user set manually before ever sending a message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o', title: 'My own title' })).json();

    await sendMessage(t, chat.id, 'hello');
    const list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list.find((c: { id: string }) => c.id === chat.id).title).toBe('My own title');
  });

  it('leaves an all-whitespace first prompt untitled and tries again on the next message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, '   ');
    let list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list.find((c: { id: string }) => c.id === chat.id).title).toBeNull();

    await sendMessage(t, chat.id, 'now a real prompt');
    list = (await get(t, '/api/planner/chats')).json().chats;
    expect(list.find((c: { id: string }) => c.id === chat.id).title).toBe('now a real prompt');
  });

  it('deletes a chat', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    expect((await del(t, `/api/planner/chats/${chat.id}`)).statusCode).toBe(204);
    expect((await get(t, '/api/planner/chats')).json().chats).toHaveLength(0);
  });

  // ---- PA-35: bulk-delete a workspace's chats, from the "..." menu --------

  it("deletes every chat in one workspace, leaving another agent's chats alone", async () => {
    t = await createTestApp();
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Research' })).json();
    const inWs1 = (await post(t, '/api/planner/chats', { workspaceId: ws.id })).json();
    const inWs2 = (await post(t, '/api/planner/chats', { workspaceId: ws.id })).json();
    const elsewhere = (await post(t, '/api/planner/chats', {})).json();

    const res = await del(t, `/api/planner/workspaces/${ws.id}/chats`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 2 });

    const remaining = (await get(t, '/api/planner/chats')).json().chats;
    expect(remaining.map((c: { id: string }) => c.id)).toEqual([elsewhere.id]);
    expect(remaining.map((c: { id: string }) => c.id)).not.toContain(inWs1.id);
    expect(remaining.map((c: { id: string }) => c.id)).not.toContain(inWs2.id);
  });

  it('bulk-delete on a workspace with no chats reports zero removed', async () => {
    t = await createTestApp();
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Research' })).json();
    const res = await del(t, `/api/planner/workspaces/${ws.id}/chats`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: 0 });
  });

  it('404s bulk-deleting chats for an unknown workspace', async () => {
    t = await createTestApp();
    const res = await del(t, '/api/planner/workspaces/does-not-exist/chats');
    expect(res.statusCode).toBe(404);
  });

  it('history is empty for a chat with no messages yet', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const history = await get(t, `/api/planner/chats/${chat.id}/history`);
    expect(history.statusCode).toBe(200);
    expect(history.json().events).toEqual([]);
  });

  it('404s sending a message to an unknown chat', async () => {
    t = await createTestApp();
    const res = await post(t, '/api/planner/chats/does-not-exist/messages', { content: 'hi' });
    expect(res.statusCode).toBe(404);
  });

  it('409s sending a message before the LLM endpoint is configured', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const res = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'hi' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_configured');
  });

  it('409s sending a message with an endpoint configured but no model anywhere', async () => {
    t = await createTestApp();
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const res = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'hi' });
    expect(res.statusCode).toBe(409);
  });

  it('completes a turn end-to-end: streams user_prompt/text/turn_complete, updates the chat and the global last-used model', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeCompletionResponse("Here's the plan."));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);

    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' });
    const model = await post(t, '/api/planner/models', { modelId: 'gpt-4o-mini', label: 'Fast' });
    const chat = (await post(t, '/api/planner/chats', { modelId: model.json().modelId })).json();

    const { res: turn, events } = await sendMessage(t, chat.id, 'plan my week');
    expect(turn.statusCode).toBe(200);
    expect(turn.headers['content-type']).toMatch(/text\/event-stream/);
    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'text_delta', 'text', 'turn_complete']);
    expect(events[0]).toMatchObject({ text: 'plan my week' });
    expect(findEvent(events, 'text_delta')).toMatchObject({ text: "Here's the plan." });
    expect(findEvent(events, 'text')).toMatchObject({ text: "Here's the plan." });
    expect(findEvent(events, 'turn_complete')).toMatchObject({ isError: false });

    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().events;
    expect(history).toEqual(dropTextDeltas(events));

    const chats = (await get(t, '/api/planner/chats')).json().chats;
    expect(chats[0].lastModelId).toBe('gpt-4o-mini');
    expect(chats[0].lastActivityAt).toBeGreaterThan(0);

    const settings = (await get(t, '/api/planner/settings')).json();
    expect(settings.lastModelId).toBe('gpt-4o-mini');

    // The LLM was called with the running history including the just-sent
    // user message — not an empty or stale list.
    const sentMessages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(sentMessages).toEqual([{ role: 'user', content: 'plan my week' }]);
  });

  it('turn_complete carries durationMs, token usage, and a completedAt timestamp when the provider reports usage', async () => {
    const fetchImpl = vi.fn().mockImplementation(() =>
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
        JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } }),
      ]),
    );
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const before = Date.now();
    const { events } = await sendMessage(t, chat.id, 'hi');
    const turnComplete = findEvent(events, 'turn_complete')!;
    expect(turnComplete.inputTokens).toBe(10);
    expect(turnComplete.outputTokens).toBe(3);
    expect(turnComplete.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(turnComplete.completedAt as number).toBeGreaterThanOrEqual(before);

    // The client always opts into usage reporting.
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('turn_complete sums token usage across every LLM round trip a tool-calling turn made', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        sseResponse([
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'list_workspaces', arguments: '{}' } }] } }],
          }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
        ]),
      )
      .mockResolvedValueOnce(
        sseResponse([
          JSON.stringify({ choices: [{ delta: { content: 'done' } }] }),
          JSON.stringify({ choices: [], usage: { prompt_tokens: 25, completion_tokens: 5 } }),
        ]),
      );
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'what workspaces do I have?');
    const turnComplete = findEvent(events, 'turn_complete')!;
    expect(turnComplete.inputTokens).toBe(35); // 10 + 25
    expect(turnComplete.outputTokens).toBe(7); // 2 + 5
  });

  // ---- PA-6 round 4: per-agent tool subset -----------------------------------

  it('excludes a disabled tool from what is offered to the model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await post(t, `/api/planner/workspaces/${chat.workspaceId}/tools`, {
      toolName: 'write_file',
      enabled: false,
    });

    await sendMessage(t, chat.id, 'hi');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const toolNames = body.tools.map((spec: { function: { name: string } }) => spec.function.name);
    expect(toolNames).not.toContain('write_file');
    expect(toolNames).toContain('list_workspaces');
  });

  it('refuses to execute a disabled tool even if the model calls it anyway, without pausing for approval', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('write_file', { path: 'x', content: 'y' }))
      .mockResolvedValueOnce(fakeCompletionResponse('ok, understood'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    await post(t, `/api/planner/workspaces/${chat.workspaceId}/tools`, {
      toolName: 'write_file',
      enabled: false,
    });

    const { events } = await sendMessage(t, chat.id, 'write a file anyway');
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    const result = findEvent(events, 'tool_result')!;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/disabled for this agent/);
    expect(findEvent(events, 'permission_request')).toBeUndefined();
  });

  // ---- PA-6 round 5: global tool disable, layered on top of per-agent -------

  // ---- PA-45: identity/"me"/"tools" context, prepended as a system message -

  it('sends no persona system message when identity/me/tools are all unset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'hi');
    const messages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it("prepends this agent's identity, the global me instruction, and the global tools instruction as one system message, in that order", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', {
      baseUrl: 'https://api.example.com',
      meInstruction: 'My name is Stone.',
      toolsInstruction: 'BAMBOO_TOKEN holds the Bamboo CI token.',
    });
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Coder' })).json();
    await patch(t, `/api/planner/workspaces/${ws.id}`, {
      identityPrompt: 'I am a coding assistant for this repo.',
    });
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id, modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'hi');
    const messages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(
      'Who you are:\nI am a coding assistant for this repo.\n\n' +
        'About the person you are helping:\nMy name is Stone.\n\n' +
        'About their tools and environment:\nBAMBOO_TOKEN holds the Bamboo CI token.',
    );
    expect(messages[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('omits a persona section that is unset while still including the ones that are', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', {
      baseUrl: 'https://api.example.com',
      meInstruction: 'My name is Stone.',
    });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'hi');
    const messages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(messages[0]).toEqual({
      role: 'system',
      content: 'About the person you are helping:\nMy name is Stone.',
    });
  });

  it('excludes a globally-disabled tool from what is offered, even for an agent that never touched it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    await patch(t, '/api/planner/tools/write_file', { enabled: false });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'hi');
    const body = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    const toolNames = body.tools.map((spec: { function: { name: string } }) => spec.function.name);
    expect(toolNames).not.toContain('write_file');
  });

  it('refuses a globally-disabled tool with a distinct "disabled globally" message, not "disabled for this agent"', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('write_file', { path: 'x', content: 'y' }))
      .mockResolvedValueOnce(fakeCompletionResponse('ok, understood'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    await patch(t, '/api/planner/tools/write_file', { enabled: false });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'write a file anyway');
    const result = findEvent(events, 'tool_result')!;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/disabled globally/);
    expect(result.content).not.toMatch(/disabled for this agent/);
  });

  it('executes a read-only tool call immediately (no approval), streaming tool_use/tool_result, and persists them', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('list_workspaces', {}))
      .mockResolvedValueOnce(fakeCompletionResponse('You have one workspace: project.'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { res: turn, events } = await sendMessage(t, chat.id, 'what workspaces do I have?');
    expect(turn.statusCode).toBe(200);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(events[1]).toMatchObject({ name: 'list_workspaces', input: {} });
    expect(findEvent(events, 'text')).toMatchObject({ text: 'You have one workspace: project.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The second call carries the assistant's tool-call message and the
    // executed tool's result, in addition to the original user turn.
    const secondCallMessages = JSON.parse(fetchImpl.mock.calls[1]![1].body as string).messages;
    expect(secondCallMessages).toHaveLength(3);
    expect(secondCallMessages[0]).toEqual({ role: 'user', content: 'what workspaces do I have?' });
    expect(secondCallMessages[1]).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [{ function: { name: 'list_workspaces' } }],
    });
    expect(secondCallMessages[2].role).toBe('tool');
    // `createTestApp` registers `t.workspaceRoot` itself as the workspace
    // root — see the identical note in `planner-tools.test.ts`.
    expect(JSON.parse(secondCallMessages[2].content)).toEqual([
      { path: t.workspaceRoot, name: path.basename(t.workspaceRoot), isGitRepo: false },
    ]);

    // Every event — including the tool call and its result — is now visible
    // on reload, unlike phase 3/4's design: the whole point of this fix.
    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().events;
    expect(history).toEqual(dropTextDeltas(events));
  });

  it('gives up after too many tool-call iterations rather than looping forever', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeToolCallResponse('list_workspaces', {}));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { res: turn, events } = await sendMessage(t, chat.id, 'loop forever');
    expect(turn.statusCode).toBe(200);
    const textEvent = findEvent(events, 'text');
    expect(textEvent?.text).toMatch(/too many tool calls/);
    const doneEvent = findEvent(events, 'turn_complete');
    expect(doneEvent).toMatchObject({ isError: true });
    // Capped, not unbounded.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('a second turn sends the full prior history to the LLM', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeCompletionResponse('first reply'))
      .mockResolvedValueOnce(fakeCompletionResponse('second reply'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'first message' });
    await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'second message' });

    const secondCallBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string);
    expect(secondCallBody.messages).toEqual([
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'second message' },
    ]);
  });

  it('turns an LLM failure into an in-band error event, not an HTTP error status', async () => {
    // Once the stream has started (right after `user_prompt`), the response
    // status is already committed — see `streamPlannerEvents`'s doc comment
    // for why an upstream failure has to become a `text`/`turn_complete`
    // event instead of a different HTTP status the way a pre-phase-6 502
    // once did.
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { res, events } = await sendMessage(t, chat.id, 'hi');
    expect(res.statusCode).toBe(200);
    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'text', 'turn_complete']);
    expect(findEvent(events, 'text')?.text).toMatch(/Could not reach the LLM endpoint/);
    expect(findEvent(events, 'turn_complete')).toMatchObject({ isError: true });
  });

  it('a chat surviving its workspace deletion still has a readable, appendable transcript', async () => {
    // `mockImplementation`, not `mockResolvedValue`: a `Response` body can only
    // be read once, and this test drives two turns through the same mock.
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Temp' })).json();
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id, modelId: 'gpt-4o' })).json();
    await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'before deletion' });

    expect((await del(t, `/api/planner/workspaces/${ws.id}`)).statusCode).toBe(204);

    // The chat row survives (workspace_id set NULL, workspace_name copied).
    const chats = (await get(t, '/api/planner/chats')).json().chats;
    expect(chats.find((c: { id: string }) => c.id === chat.id)?.workspaceName).toBe('Temp');

    // A further turn still works, landing in the default workspace instead.
    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'after deletion' });
    expect(turn.statusCode).toBe(200);
  });

  // ---- PA-6 phase 4: mutating tools pause for approval ---------------------

  async function mkdirPending(fetchImpl: ReturnType<typeof vi.fn>) {
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events } = await sendMessage(t, chat.id, 'make a directory');
    const pending = findEvent(events, 'permission_request');
    return { chat, events, pending: pending as { id: string; toolName: string; input: unknown } };
  }

  it('pauses a mutating tool call with no remembered decision', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'a-new-dir' }));
    const { events, pending } = await mkdirPending(fetchImpl);

    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_use', 'permission_request']);
    expect(pending.toolName).toBe('mkdir');
    expect(pending.input).toEqual({ path: 'a-new-dir' });
    // The pause happens before the mutating action runs.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('allow_once runs the tool without remembering anything', async () => {
    // Two-phase setup: the mocked tool call needs an absolute path inside
    // `t.workspaceRoot` to prove the real filesystem effect happened, but
    // that root only exists once `createTestApp` has run — so the app is
    // built with an as-yet-unconfigured mock, then the mock's responses are
    // queued using the now-known root.
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    const targetDir = path.join(t.workspaceRoot, 'made-once');
    fetchImpl
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: targetDir }))
      .mockResolvedValueOnce(fakeCompletionResponse('Made it.'))
      // A second, unrelated chat in the same workspace still has to ask —
      // nothing was remembered.
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: path.join(t.workspaceRoot, 'made-twice') }));

    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events: firstEvents } = await sendMessage(t, chat.id, 'make a directory');
    const pending = findEvent(firstEvents, 'permission_request')!;

    const { res: resolved, events: resumedEvents } = await resolve(t, chat.id, pending.id as string, 'allow_once');
    expect(resolved.statusCode).toBe(200);
    expect(resumedEvents.map((e) => e.kind)).toEqual([
      'permission_resolved',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(findEvent(resumedEvents, 'text')?.text).toBe('Made it.');
    expect((await fs.stat(targetDir)).isDirectory()).toBe(true);

    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events: secondEvents } = await sendMessage(t, secondChat.id, 'again');
    expect(findEvent(secondEvents, 'permission_request')).toBeDefined();
  });

  it('allow_workspace remembers the decision for every chat in that workspace, but not elsewhere', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'ws-remembered' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done once.'))
      // Second chat, same (default) workspace: the tool call and the final
      // reply happen in one round trip now — no pause, no separate approval call.
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'ws-remembered-2' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done twice.'))
      // Third chat, a *different* workspace: still has to ask.
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'elsewhere' }));
    const { chat, pending } = await mkdirPending(fetchImpl);

    const { events: resumedEvents } = await resolve(t, chat.id, pending.id as string, 'allow_workspace');
    expect(findEvent(resumedEvents, 'turn_complete')).toMatchObject({ isError: false });

    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events: secondEvents } = await sendMessage(t, secondChat.id, 'again');
    expect(secondEvents.map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(findEvent(secondEvents, 'text')?.text).toBe('Done twice.');
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const otherWs = (await post(t, '/api/planner/workspaces', { name: 'Other' })).json();
    const otherChat = (await post(t, '/api/planner/chats', { workspaceId: otherWs.id, modelId: 'gpt-4o' })).json();
    const { events: otherEvents } = await sendMessage(t, otherChat.id, 'go');
    expect(findEvent(otherEvents, 'permission_request')).toBeDefined();
  });

  it('allow_global remembers the decision for every workspace', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'global-remembered' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done.'))
      // A chat in a *different* workspace: no pause — the decision is global.
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'still-global' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Also done.'));
    const { chat, pending } = await mkdirPending(fetchImpl);
    await resolve(t, chat.id, pending.id as string, 'allow_global');

    const otherWs = (await post(t, '/api/planner/workspaces', { name: 'Elsewhere' })).json();
    const otherChat = (await post(t, '/api/planner/chats', { workspaceId: otherWs.id, modelId: 'gpt-4o' })).json();
    const { events: otherEvents } = await sendMessage(t, otherChat.id, 'go');
    expect(findEvent(otherEvents, 'text')?.text).toBe('Also done.');
  });

  it('deny records a denial as the tool result and lets the model try again', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-dir' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Understood, not creating it.'));
    const { chat, pending } = await mkdirPending(fetchImpl);

    const { events: resumedEvents } = await resolve(t, chat.id, pending.id as string, 'deny');
    expect(resumedEvents.map((e) => e.kind)).toEqual([
      'permission_resolved',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(findEvent(resumedEvents, 'permission_resolved')).toMatchObject({ decision: 'deny' });
    expect(findEvent(resumedEvents, 'tool_result')).toMatchObject({ isError: true });
    expect(findEvent(resumedEvents, 'text')?.text).toBe('Understood, not creating it.');
    await expect(fs.stat(path.join(t.workspaceRoot, 'denied-dir'))).rejects.toThrow();

    const secondCallMessages = JSON.parse(fetchImpl.mock.calls[1]![1].body as string).messages;
    const toolMessage = secondCallMessages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage.content).toMatch(/Denied/);
  });

  it('404s resolving an unknown approval id', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const res = await post(t, `/api/planner/chats/${chat.id}/approvals/does-not-exist`, {
      decision: 'deny',
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s resolving an approval id that belongs to a different chat", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'x' }));
    const { pending } = await mkdirPending(fetchImpl);
    const otherChat = (await post(t, '/api/planner/chats', {})).json();
    const res = await post(t, `/api/planner/chats/${otherChat.id}/approvals/${pending.id}`, {
      decision: 'deny',
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- PA-6 phase 5: yolo mode ------------------------------------------

  it('yolo mode runs a mutating tool immediately, with no pause', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'yolo-dir' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done, no questions asked.'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'go');
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(findEvent(events, 'text')?.text).toBe('Done, no questions asked.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('yolo mode does not remember anything — turning it off asks again', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'yolo-dir-1' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done once.'))
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'yolo-dir-2' }));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    await sendMessage(t, chat.id, 'go');

    await patch(t, '/api/planner/settings', { yoloEnabled: false });
    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events: secondEvents } = await sendMessage(t, secondChat.id, 'go again');
    expect(findEvent(secondEvents, 'permission_request')).toBeDefined();
  });

  it('yolo mode overrides even a remembered deny', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-then-yolo' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Denied as expected.'))
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-then-yolo-2' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Ran anyway.'));
    const { chat, pending } = await mkdirPending(fetchImpl);
    await resolve(t, chat.id, pending.id as string, 'deny');

    // Nothing was remembered by a plain 'deny' (only allow_workspace/allow_global
    // persist), so pre-configure a global deny via the settings surface instead.
    await post(t, '/api/planner/tool-approvals', { scope: 'global', toolName: 'mkdir', decision: 'deny' });
    await patch(t, '/api/planner/settings', { yoloEnabled: true });

    const { events: secondEvents } = await sendMessage(t, chat.id, 'try again');
    expect(findEvent(secondEvents, 'text')?.text).toBe('Ran anyway.');
  });

  // ---- PA-6 round 4: model discovery + test buttons -------------------------

  function fakeModelsListResponse(ids: string[]): Response {
    return new Response(
      JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  it('discovers models from the endpoint without touching the catalog', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeModelsListResponse(['gpt-4o', 'gpt-4o-mini']));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com/v1' });

    const res = await get(t, '/api/planner/models/discover');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ modelIds: ['gpt-4o', 'gpt-4o-mini'] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/models');
    expect(fetchImpl.mock.calls[0]![1].method).toBe('GET');

    // Discovery itself never creates catalog rows — the editor decides that.
    expect((await get(t, '/api/planner/models')).json().models).toEqual([]);
  });

  it('409s discovering models before the endpoint is configured', async () => {
    t = await createTestApp();
    const res = await get(t, '/api/planner/models/discover');
    expect(res.statusCode).toBe(409);
  });

  it('502s discovering models when the endpoint fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const res = await get(t, '/api/planner/models/discover');
    expect(res.statusCode).toBe(502);
  });

  it('tests a model with a minimal round trip, returning ok and a latency', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const model = (await post(t, '/api/planner/models', { modelId: 'gpt-4o', label: 'Fast' })).json();

    const res = await post(t, `/api/planner/models/${model.id}/test`, undefined);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, message: 'ok' });
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);

    // Tests the *model id*, not the catalog row id.
    const sentBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(sentBody.model).toBe('gpt-4o');
  });

  it('a failed test reports ok: false with the endpoint error, not an HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const model = (await post(t, '/api/planner/models', { modelId: 'gpt-4o', label: 'Fast' })).json();

    const res = await post(t, `/api/planner/models/${model.id}/test`, undefined);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false });
  });

  it('404s testing an unknown model', async () => {
    t = await createTestApp();
    const res = await post(t, '/api/planner/models/does-not-exist/test', undefined);
    expect(res.statusCode).toBe(404);
  });

  it('409s testing a model before the endpoint is configured', async () => {
    t = await createTestApp();
    // No baseUrl configured, but a model row can still exist.
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    const model = (await post(t, '/api/planner/models', { modelId: 'gpt-4o', label: 'Fast' })).json();
    const res = await post(t, `/api/planner/models/${model.id}/test`, undefined);
    expect(res.statusCode).toBe(409);
  });
});
