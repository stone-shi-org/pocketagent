import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannerLlmClient, PlannerLlmError } from '../src/planner/llm-client.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

function startFakeLiveStt(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

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
  const sendMessage = async (
    t2: TestApp,
    chatId: string,
    content: string,
    extra?: { voiceMode?: boolean; modelId?: string },
  ) => {
    const res = await post(t2, `/api/planner/chats/${chatId}/messages`, { content, ...extra });
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

  it('clears chat history via DELETE /api/planner/chats/:id/history', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'first message');
    let history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().events;
    expect(history.length).toBeGreaterThan(0);

    const delRes = await del(t, `/api/planner/chats/${chat.id}/history`);
    expect(delRes.statusCode).toBe(204);

    history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().events;
    expect(history).toEqual([]);
  });

  it('sends an image attachment as multimodal user prompt to LLM and includes it in history', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('I see the image!'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const image = { mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
    const res = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'Describe this', image });
    expect(res.statusCode).toBe(200);
    const events = parseEvents(res);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'Describe this', image });

    const sentBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(sentBody.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
          { type: 'text', text: 'Describe this' },
        ],
      },
    ]);
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

  // ---- PA-59: context-preview reports system prompt / window / tool footprint

  it('context-preview omits systemPrompt sections and reports zero tools when nothing is configured and every tool is disabled', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const globalNames: string[] = (await get(t, '/api/planner/tools')).json().tools.map(
      (info: { name: string }) => info.name,
    );
    for (const name of globalNames) {
      await patch(t, `/api/planner/tools/${name}`, { enabled: false });
    }

    const res = await get(t, `/api/planner/chats/${chat.id}/context-preview`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.systemPrompt).toEqual([]);
    // `enabledTools` is `[]`; `JSON.stringify([])` is the 2-char string
    // `"[]"`, which `estimateTokens` rounds up to 1 — not literally zero,
    // since the estimator works on serialized text, not tool count.
    expect(body.tools).toEqual({ enabledCount: 0, tokens: 1, mcpActive: false, skillsActive: false });
    // No messages sent yet either, so `eventsToLlmMessages` also serializes
    // to `"[]"` — same one-token floor, not literally zero.
    expect(body.window.tokens).toBe(1);
    // Nothing configured, nothing in the window, no memory candidates: the
    // headline total is just the two one-token floors above.
    expect(body.totalTokens).toBe(body.window.tokens + body.tools.tokens);
  });

  it("context-preview reports the identity/about/toolsEnvironment sections with non-negative token counts, mirroring buildPersonaSystemMessage's own sections", async () => {
    t = await createTestApp();
    await patch(t, '/api/planner/settings', {
      meInstruction: 'My name is Stone.',
      toolsInstruction: 'BAMBOO_TOKEN holds the Bamboo CI token.',
    });
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Coder' })).json();
    await patch(t, `/api/planner/workspaces/${ws.id}`, {
      identityPrompt: 'I am a coding assistant for this repo.',
    });
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id })).json();

    const body = (await get(t, `/api/planner/chats/${chat.id}/context-preview`)).json();
    const byId = Object.fromEntries(body.systemPrompt.map((s: { id: string; text: string }) => [s.id, s]));
    expect(byId.identity).toMatchObject({ label: 'Who you are', text: 'I am a coding assistant for this repo.' });
    expect(byId.about).toMatchObject({
      label: 'About the person you are helping',
      text: 'My name is Stone.',
    });
    expect(byId.toolsEnvironment).toMatchObject({
      label: 'About their tools and environment',
      text: 'BAMBOO_TOKEN holds the Bamboo CI token.',
    });
    for (const section of body.systemPrompt) {
      expect(section.tokens).toBeGreaterThan(0);
    }
    // The catalog is enabled by default, so an "internal tools" section
    // should also be present, and the tools footprint non-trivial.
    expect(byId.internalTools).toBeDefined();
    expect(body.tools.enabledCount).toBeGreaterThan(0);
    expect(body.tools.tokens).toBeGreaterThan(0);
    const systemPromptTokens = body.systemPrompt.reduce((sum: number, s: { tokens: number }) => sum + s.tokens, 0);
    expect(body.totalTokens).toBe(systemPromptTokens + body.window.tokens + body.tools.tokens);
  });

  it('context-preview totalTokens counts only selected memory candidates, not the whole preview list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const { insertPlannerMemory } = await import('../src/planner/store.js');
    insertPlannerMemory(t.db, {
      id: 'mem-selected',
      workspaceId: ws.id,
      tier: 'long',
      content: 'The user prefers concise answers.',
      importance: 5,
      sourceChatId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id, modelId: 'gpt-4o' })).json();
    await sendMessage(t, chat.id, 'concise answers');

    const body = (await get(t, `/api/planner/chats/${chat.id}/context-preview`)).json();
    expect(body.candidates.length).toBeGreaterThan(0);
    const selectedTokens = body.candidates
      .filter((c: { selected: boolean }) => c.selected)
      .reduce((sum: number, c: { tokens: number }) => sum + c.tokens, 0);
    const unselectedTokens = body.candidates
      .filter((c: { selected: boolean }) => !c.selected)
      .reduce((sum: number, c: { tokens: number }) => sum + c.tokens, 0);
    const systemPromptTokens = body.systemPrompt.reduce((sum: number, s: { tokens: number }) => sum + s.tokens, 0);
    expect(body.totalTokens).toBe(systemPromptTokens + body.window.tokens + selectedTokens + body.tools.tokens);
    if (unselectedTokens > 0) {
      // Sanity check the exclusion actually matters for this fixture, not
      // just that the arithmetic happens to work out with zero either way.
      expect(body.totalTokens).not.toBe(
        systemPromptTokens + body.window.tokens + selectedTokens + unselectedTokens + body.tools.tokens,
      );
    }
  });

  it('context-preview reports a per-memory token count on each candidate', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const { insertPlannerMemory } = await import('../src/planner/store.js');
    insertPlannerMemory(t.db, {
      id: 'mem-1',
      workspaceId: ws.id,
      tier: 'long',
      content: 'The user prefers concise answers.',
      importance: 5,
      sourceChatId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    const chat = (await post(t, '/api/planner/chats', { workspaceId: ws.id, modelId: 'gpt-4o' })).json();
    await sendMessage(t, chat.id, 'concise answers');

    const body = (await get(t, `/api/planner/chats/${chat.id}/context-preview`)).json();
    expect(body.memoryEnabled).toBe(true);
    expect(body.candidates.length).toBeGreaterThan(0);
    for (const c of body.candidates) {
      expect(c.tokens).toBeGreaterThanOrEqual(0);
    }
    const match = body.candidates.find((c: { memory: { id: string } }) => c.memory.id === 'mem-1');
    expect(match?.tokens).toBe(Math.ceil('The user prefers concise answers.'.length / 4));
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
    // Pin the cap explicitly rather than relying on the default (20) so this
    // test stays fast and its assertion below stays exact regardless of what
    // the default happens to be.
    await patch(t, '/api/planner/settings', { maxToolIterations: 3 });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { res: turn, events } = await sendMessage(t, chat.id, 'loop forever');
    expect(turn.statusCode).toBe(200);
    const textEvent = findEvent(events, 'text');
    expect(textEvent?.text).toMatch(/too many tool calls/);
    const doneEvent = findEvent(events, 'turn_complete');
    expect(doneEvent).toMatchObject({ isError: true });
    // Capped, not unbounded.
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('maxToolIterations defaults to 20 and is configurable over the settings route', async () => {
    t = await createTestApp();
    const initial = (await get(t, '/api/planner/settings')).json();
    expect(initial.maxToolIterations).toBe(20);

    const updated = (await patch(t, '/api/planner/settings', { maxToolIterations: 5 })).json();
    expect(updated.maxToolIterations).toBe(5);

    const reread = (await get(t, '/api/planner/settings')).json();
    expect(reread.maxToolIterations).toBe(5);
  });

  it('maxSubagentSpawnsPerTurn defaults to 3 and is configurable over the settings route', async () => {
    t = await createTestApp();
    const initial = (await get(t, '/api/planner/settings')).json();
    expect(initial.maxSubagentSpawnsPerTurn).toBe(3);

    const updated = (await patch(t, '/api/planner/settings', { maxSubagentSpawnsPerTurn: 7 })).json();
    expect(updated.maxSubagentSpawnsPerTurn).toBe(7);

    const reread = (await get(t, '/api/planner/settings')).json();
    expect(reread.maxSubagentSpawnsPerTurn).toBe(7);
  });

  it('commandTimeoutSeconds defaults to 300 and is configurable over the settings route', async () => {
    t = await createTestApp();
    const initial = (await get(t, '/api/planner/settings')).json();
    expect(initial.commandTimeoutSeconds).toBe(300);

    const updated = (await patch(t, '/api/planner/settings', { commandTimeoutSeconds: 600 })).json();
    expect(updated.commandTimeoutSeconds).toBe(600);

    const reread = (await get(t, '/api/planner/settings')).json();
    expect(reread.commandTimeoutSeconds).toBe(600);
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

  // ---- PA-44: start_subagent_session's pocket_agent branch, end to end ------

  /**
   * The background pump `PlannerChatService.startSubagentChatForTool` kicks
   * off is a *separate* promise chain from the one `app.inject()` above is
   * waiting on (the parent turn's own SSE response) — nothing here awaits
   * the child's turn before the parent's HTTP response resolves, by design
   * (that's the whole point of "returns a handle immediately"). So this
   * polls the child's own transcript for a little while rather than assuming
   * it is already done the instant the parent's request returns.
   */
  async function waitForChatDone(t2: TestApp, chatId: string, timeoutMs = 2000): Promise<unknown[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = (await get(t2, `/api/planner/chats/${chatId}/history`)).json().events as Array<{
        kind: string;
      }>;
      if (events.some((e) => e.kind === 'turn_complete')) return events;
      if (Date.now() > deadline) {
        throw new Error(`Subagent chat ${chatId} never reached turn_complete within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('spawns a Pocket Agent subagent chat and can later check that it finished', async () => {
    const helperWorkspace = { id: '' };
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (lastUser?.content === 'spawn a helper' && !hasToolResult) {
        return fakeToolCallResponse('start_subagent_session', {
          kind: 'pocket_agent',
          workspaceId: helperWorkspace.id,
          prompt: 'sub task',
        });
      }
      if (lastUser?.content === 'spawn a helper' && hasToolResult) {
        return fakeCompletionResponse('ok, spawned it');
      }
      // The subagent chat's own first (and only) turn.
      return fakeCompletionResponse('sub task done');
    });
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const helper = (await post(t, '/api/planner/workspaces', { name: 'Helper' })).json();
    helperWorkspace.id = helper.id;
    // A spawned chat's own turn resolves its model the same way any new chat
    // in this workspace would (`create`'s own `defaultModelId ?? global
    // last-used` fallback) — with no turn having completed yet in this fresh
    // app, the global last-used model is still unset, so the helper agent
    // needs its own default for the spawned chat to have a model to run with.
    await patch(t, `/api/planner/workspaces/${helper.id}`, { defaultModelId: 'gpt-4o' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { res, events } = await sendMessage(t, chat.id, 'spawn a helper');
    expect(res.statusCode).toBe(200);
    const toolResult = events.find(
      (e) => e.kind === 'tool_result' && String(e.content).includes('"kind":"pocket_agent"'),
    );
    expect(toolResult).toBeDefined();
    const handle = JSON.parse(String(toolResult!.content)) as { id: string };
    expect(handle.id).not.toBe(chat.id);

    // The parent's own turn already finished (it never blocked on the
    // subagent) — its final reply says so.
    expect(findEvent(events, 'text')?.text).toBe('ok, spawned it');

    // The subagent's own turn finishes on its own, in the background.
    const childEvents = await waitForChatDone(t, handle.id);
    expect(childEvents.map((e: { kind: string }) => e.kind)).toContain('turn_complete');

    const allChats = (await get(t, '/api/planner/chats')).json().chats as Array<{
      id: string;
      workspaceId: string | null;
    }>;
    expect(allChats.find((c) => c.id === handle.id)?.workspaceId).toBe(helper.id);
  });

  it('refuses a pocket_agent spawn once the depth limit is reached', async () => {
    // `MAX_SUBAGENT_SPAWN_DEPTH` is 2, so a chain of three spawns is needed to
    // observe a refusal: root (depth 0) spawning chat B (depth 1) is allowed,
    // B (depth 1) spawning chat C (depth 2) is *also* allowed — the limit is
    // "already at the limit", not "about to cross it" — and only C (depth 2)
    // attempting to spawn a fourth chat is refused, inline, by the tool
    // itself, before it ever calls into `PlannerChatService`.
    let workspaceId = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (lastUser?.content?.startsWith('continue the chain') && !hasToolResult) {
        return fakeToolCallResponse('start_subagent_session', {
          kind: 'pocket_agent',
          workspaceId,
          prompt: 'continue the chain',
        });
      }
      return fakeCompletionResponse('done');
    });
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const ws = (await post(t, '/api/planner/workspaces', { name: 'Chain' })).json();
    workspaceId = ws.id;
    // See the identical note in the test above — every spawned chat in this
    // chain lands in the same workspace, so it needs its own default model.
    await patch(t, `/api/planner/workspaces/${workspaceId}`, { defaultModelId: 'gpt-4o' });
    const root = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    /** Extracts the spawned chat's id from a chat's own tool_result. */
    function spawnedIdFrom(chatEvents: Array<{ kind: string; content?: unknown }>): string {
      const toolResult = chatEvents.find((e) => e.kind === 'tool_result')!;
      return (JSON.parse(String(toolResult.content)) as { id: string }).id;
    }

    const { events: rootEvents } = await sendMessage(t, root.id, 'continue the chain');
    const chatB = spawnedIdFrom(rootEvents); // depth 1

    const chatBEvents = await waitForChatDone(t, chatB);
    const chatC = spawnedIdFrom(chatBEvents as Array<{ kind: string; content?: unknown }>); // depth 2

    const chatCEvents = (await waitForChatDone(t, chatC)) as Array<{ kind: string; content?: unknown }>;
    const chatCToolResult = chatCEvents.find((e) => e.kind === 'tool_result');
    expect(String(chatCToolResult?.content)).toMatch(/depth limit/);
  });

  it('prevents duplicate coding_agent subagent spawns into the same working tree and returns existing handle with status', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (lastUser?.content === 'spawn subagent' && !hasToolResult && callCount === 0) {
        callCount++;
        return fakeToolCallResponse('start_subagent_session', {
          kind: 'coding_agent',
          path: t.projectDir,
          agent: 'claude',
          prompt: 'first task',
        });
      }
      if (lastUser?.content === 'spawn subagent' && hasToolResult && callCount === 1) {
        callCount++;
        // Second tool call in the same turn into the same working tree!
        return fakeToolCallResponse('start_subagent_session', {
          kind: 'coding_agent',
          path: t.projectDir,
          agent: 'claude',
          prompt: 'second task in same tree',
        });
      }
      return fakeCompletionResponse('all done');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { res, events } = await sendMessage(t, chat.id, 'spawn subagent');
    expect(res.statusCode).toBe(200);

    const toolResults = events.filter((e) => e.kind === 'tool_result');
    expect(toolResults.length).toBe(2);

    const firstResult = JSON.parse(String(toolResults[0]!.content));
    expect(firstResult).toMatchObject({ kind: 'coding_agent' });
    const firstSessionId = firstResult.id;

    // Second call should NOT have created a new session — should return the existing session id!
    const secondResult = JSON.parse(String(toolResults[1]!.content));
    expect(secondResult).toMatchObject({
      kind: 'coding_agent',
      id: firstSessionId,
    });
    expect(secondResult.message).toContain('already has an active subagent session');
    expect(secondResult.message).toContain('get_subagent_status');
  });

  it('terminates live coding_agent subagents when the owning planner chat is deleted', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (lastUser?.content === 'spawn subagent' && !hasToolResult) {
        return fakeToolCallResponse('start_subagent_session', {
          kind: 'coding_agent',
          path: t.projectDir,
          agent: 'claude',
          prompt: 'task',
        });
      }
      return fakeCompletionResponse('spawned');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'spawn subagent');
    const toolResult = events.find((e) => e.kind === 'tool_result')!;
    const spawnedId = (JSON.parse(String(toolResult.content)) as { id: string }).id;

    // Subagent session should exist and be alive
    const sessionBefore = t.context.sessions.find(spawnedId);
    expect(sessionBefore).toBeDefined();

    // Delete the planner chat
    const delRes = await del(t, `/api/planner/chats/${chat.id}`);
    expect(delRes.statusCode).toBe(204);

    // Subagent session should now be terminated / in terminal status
    const sessionAfter = t.context.sessions.find(spawnedId);
    expect(sessionAfter?.status).toBe('killed');
  });

  it('prevents spin-polling by short-circuiting unchanged get_subagent_status calls within the same turn', async () => {
    let spawnedId = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const toolResults = body.messages.filter((m) => m.role === 'tool');

      if (lastUser?.content === 'run task' && toolResults.length === 0) {
        return fakeToolCallResponse(
          'start_subagent_session',
          {
            kind: 'coding_agent',
            path: t.projectDir,
            agent: 'claude',
            prompt: 'task',
          },
          'call_spawn',
        );
      }
      if (toolResults.length === 1) {
        const spawnRes = JSON.parse(toolResults[0]!.content!) as { id: string };
        spawnedId = spawnRes.id;
        return fakeToolCallResponse(
          'get_subagent_status',
          {
            kind: 'coding_agent',
            id: spawnedId,
          },
          'call_status_1',
        );
      }
      if (toolResults.length === 2) {
        // Second get_subagent_status call in the same turn without any output changes!
        return fakeToolCallResponse(
          'get_subagent_status',
          {
            kind: 'coding_agent',
            id: spawnedId,
          },
          'call_status_2',
        );
      }
      return fakeCompletionResponse('ending turn now');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'run task');
    const toolResults = events.filter((e) => e.kind === 'tool_result');
    expect(toolResults.length).toBe(3);

    // Call 1 was spawn
    expect(JSON.parse(String(toolResults[0]!.content))).toMatchObject({ kind: 'coding_agent', id: spawnedId });
    // Call 2 was first get_subagent_status
    expect(JSON.parse(String(toolResults[1]!.content))).toMatchObject({ status: 'running' });
    // Call 3 was second get_subagent_status -> refused by short-circuit!
    const thirdResult = String(toolResults[2]!.content);
    expect(thirdResult).toContain('Unchanged since your last check');
    expect(thirdResult).toContain('end your turn now');
  });

  it('check_back_in schedules a non-blocking timer wake notification', async () => {
    let wakeTurnSeen = false;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const toolResults = body.messages.filter((m) => m.role === 'tool');

      if (lastUser?.content === 'wait for it' && toolResults.length === 0) {
        return fakeToolCallResponse('check_back_in', { seconds: 1 }, 'call_wait');
      }
      if (lastUser?.content === 'wait for it' && toolResults.length === 1) {
        return fakeCompletionResponse('timer set, waiting');
      }
      if (lastUser?.content?.includes('[Timer Notification]')) {
        wakeTurnSeen = true;
        return fakeCompletionResponse('timer wake processed');
      }
      return fakeCompletionResponse('ok');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'wait for it');
    const toolResult = events.find((e) => e.kind === 'tool_result');
    expect(String(toolResult?.content)).toContain('Timer scheduled to wake in 1 second(s)');

    // Wait for the timer wake to drain and trigger a new turn
    const deadline = Date.now() + 4000;
    while (!wakeTurnSeen && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(wakeTurnSeen).toBe(true);
  });

  it('stop_subagent terminates a live coding subagent session', async () => {
    let spawnedId = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const lastMsg = body.messages[body.messages.length - 1];

      if (lastUser?.content === 'spawn subagent' && lastMsg?.role === 'user') {
        return fakeToolCallResponse(
          'start_subagent_session',
          {
            kind: 'coding_agent',
            path: t.projectDir,
            agent: 'claude',
            prompt: 'task',
          },
          'call_spawn',
        );
      }
      if (lastUser?.content === 'spawn subagent' && lastMsg?.role === 'tool') {
        spawnedId = (JSON.parse(lastMsg.content!) as { id: string }).id;
        return fakeCompletionResponse('spawned');
      }
      if (lastUser?.content === 'stop it' && lastMsg?.role === 'user') {
        return fakeToolCallResponse(
          'stop_subagent',
          {
            kind: 'coding_agent',
            id: spawnedId,
          },
          'call_stop',
        );
      }
      if (lastUser?.content === 'stop it' && lastMsg?.role === 'tool') {
        return fakeCompletionResponse('stopped subagent');
      }
      return fakeCompletionResponse('ok');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    await sendMessage(t, chat.id, 'spawn subagent');
    expect(spawnedId).not.toBe('');
    expect(t.context.sessions.find(spawnedId)?.status).toBe('running');

    const { events } = await sendMessage(t, chat.id, 'stop it');
    const toolResult = events.find((e) => e.kind === 'tool_result')!;
    expect(String(toolResult.content)).toContain(`Terminated coding subagent session ${spawnedId}`);
    expect(t.context.sessions.find(spawnedId)?.status).toBe('killed');
  });

  it('stop_subagent refuses to terminate a session not owned by the caller chat', async () => {
    const unownedSessionId = 'unrelated-human-session';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const lastMsg = body.messages[body.messages.length - 1];

      if (lastUser?.content === 'stop unowned' && lastMsg?.role === 'user') {
        return fakeToolCallResponse(
          'stop_subagent',
          {
            kind: 'coding_agent',
            id: unownedSessionId,
          },
          'call_stop',
        );
      }
      return fakeCompletionResponse('done');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });

    // Seed an unrelated session not owned by the planner chat
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Human session', 'shell', 'bash', ?, 'running', 'terminal', ?, 80, 24)`,
      )
      .run(unownedSessionId, t.projectDir, Date.now());

    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'stop unowned');
    const toolResult = events.find((e) => e.kind === 'tool_result')!;
    expect(String(toolResult.content)).toContain('Refusing to terminate session');
    expect(String(toolResult.content)).toContain('session was not started by this chat');
    // Ensure the unrelated session was NOT terminated
    expect(t.context.sessions.find(unownedSessionId)?.status).toBe('running');
  });

  it('stop_subagent cleanly refuses pocket_agent subagent termination', async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const lastMsg = body.messages[body.messages.length - 1];

      if (lastUser?.content === 'stop pocket' && lastMsg?.role === 'user') {
        return fakeToolCallResponse(
          'stop_subagent',
          {
            kind: 'pocket_agent',
            id: 'some-pocket-chat-id',
          },
          'call_stop_pocket',
        );
      }
      return fakeCompletionResponse('done');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'stop pocket');
    const toolResult = events.find((e) => e.kind === 'tool_result')!;
    expect(String(toolResult.content)).toContain('Stopping pocket_agent subagents is not supported');
  });

  it('poll check short-circuit resets repeat count when null baseline receives activity', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const chatsService = t.context.plannerChats;

    // Check 1: baseline with null lastActivityAt
    const res1 = (chatsService as any).checkSubagentStatusTurnForChat(chat.id, 'coding_agent', 'sub-1', {
      busy: true,
      lastActivityAt: null,
    });
    expect(res1.shortCircuit).toBe(false);

    // Check 2: repeated check with still null activity -> short circuits
    const res2 = (chatsService as any).checkSubagentStatusTurnForChat(chat.id, 'coding_agent', 'sub-1', {
      busy: true,
      lastActivityAt: null,
    });
    expect(res2.shortCircuit).toBe(true);
    expect(res2.message).toContain('Unchanged since your last check');

    // Check 3: new activity arrives (null -> timestamp) -> resets repeat count
    const activityTimestamp = Date.now();
    const res3 = (chatsService as any).checkSubagentStatusTurnForChat(chat.id, 'coding_agent', 'sub-1', {
      busy: true,
      lastActivityAt: activityTimestamp,
    });
    expect(res3.shortCircuit).toBe(false);

    // Check 4: repeated check with same timestamp -> short circuits again
    const res4 = (chatsService as any).checkSubagentStatusTurnForChat(chat.id, 'coding_agent', 'sub-1', {
      busy: true,
      lastActivityAt: activityTimestamp,
    });
    expect(res4.shortCircuit).toBe(true);
  });

  it('approval pause preserves turn poll check state across resolution', async () => {
    let spawnedId = '';
    let approvalId = '';
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
      };
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const toolResults = body.messages.filter((m) => m.role === 'tool');

      if (lastUser?.content === 'test approval pause' && toolResults.length === 0) {
        return fakeToolCallResponse(
          'start_subagent_session',
          {
            kind: 'coding_agent',
            path: t.projectDir,
            agent: 'claude',
            prompt: 'task',
          },
          'call_spawn',
        );
      }
      if (lastUser?.content === 'test approval pause' && toolResults.length === 1) {
        spawnedId = (JSON.parse(toolResults[0]!.content!) as { id: string }).id;
        return fakeToolCallResponse(
          'get_subagent_status',
          { kind: 'coding_agent', id: spawnedId },
          'call_status_1',
        );
      }
      if (lastUser?.content === 'test approval pause' && toolResults.length === 2) {
        return fakeToolCallResponse(
          'mkdir',
          { path: path.join(t.projectDir, 'pausedir') },
          'call_mkdir',
        );
      }
      if (lastUser?.content === 'test approval pause' && toolResults.length === 3) {
        return fakeToolCallResponse(
          'get_subagent_status',
          { kind: 'coding_agent', id: spawnedId },
          'call_status_2',
        );
      }
      return fakeCompletionResponse('turn finished');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: false });
    await post(t, '/api/planner/tool-approvals', { scope: 'global', toolName: 'start_subagent_session', decision: 'allow' });
    const fixedActivityAt = Date.now() - 5000;
    const origFind = t.context.sessions.find.bind(t.context.sessions);
    vi.spyOn(t.context.sessions, 'find').mockImplementation((id: string) => {
      const info = origFind(id);
      if (info && spawnedId && info.id === spawnedId) {
        return { ...info, lastActivityAt: fixedActivityAt, busy: true };
      }
      return info;
    });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'test approval pause');
    const req = events.find((e) => e.kind === 'permission_request');
    expect(req).toBeDefined();
    approvalId = req!.id;

    // Resolve approval; turn resumes and executes call_status_2
    const { events: resumedEvents } = await resolve(t, chat.id, approvalId, 'allow_once');
    const resumedToolResults = resumedEvents.filter((e) => e.kind === 'tool_result');
    const secondStatusResult = resumedToolResults[resumedToolResults.length - 1];
    expect(String(secondStatusResult?.content)).toContain('Unchanged since your last check');
    expect(String(secondStatusResult?.content)).toContain('end your turn now');
  });

  it('appends spoken summary instruction when voiceMode is enabled and cleans auto-derived title (PA-89)', async () => {
    let capturedUserContent = '';
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      const lastUser = body.messages.filter((m: { role: string }) => m.role === 'user').pop();
      capturedUserContent = lastUser?.content ?? '';
      return fakeCompletionResponse('I will help you plan your week.');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'Plan my week', { voiceMode: true });

    // The user_prompt event emitted to client includes the instruction
    const userPrompt = events.find((e) => e.kind === 'user_prompt');
    expect(userPrompt).toBeDefined();
    expect((userPrompt as { text: string }).text).toContain('Plan my week');
    expect((userPrompt as { text: string }).text).toContain('<speak>');

    // The LLM received the spoken summary instruction
    expect(capturedUserContent).toContain('Plan my week');
    expect(capturedUserContent).toContain('<speak>');

    // But the auto-derived chat title stripped the instruction!
    const list = (await get(t, '/api/planner/chats')).json().chats;
    const found = list.find((c: { id: string }) => c.id === chat.id);
    expect(found.title).toBe('Plan my week');
  });

  it('streams tts_audio events when voiceMode is enabled and model produces speak tags (PA-89)', async () => {
    const fakePcm = Buffer.from(new Int16Array([100, 200, 300, 400]).buffer);
    const liveStt = await startFakeLiveStt((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/pcm' });
        res.end(fakePcm);
        return;
      }
      res.writeHead(404).end();
    });

    try {
      const fetchImpl = vi.fn().mockImplementation(() => {
        return fakeCompletionResponse('Here is the plan. <speak>The week has been planned.</speak>');
      });

      t = await createTestApp(
        { POCKETAGENT_LIVE_STT_URL: liveStt.url },
        undefined,
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
      const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

      const { events } = await sendMessage(t, chat.id, 'Plan my week', { voiceMode: true });

      const ttsEvents = events.filter((e) => e.kind === 'tts_audio');
      expect(ttsEvents.length).toBeGreaterThan(0);
      const audioEvent = ttsEvents[0] as {
        kind: 'tts_audio';
        id: string;
        chunk: { data: string; sampleRateHz: number };
      };
      expect(audioEvent.chunk.sampleRateHz).toBe(24000);
      expect(audioEvent.chunk.data).toBe(fakePcm.toString('base64'));
    } finally {
      await liveStt.close();
    }
  });

  it('streams tts_audio events when synthesis completes within the extended pump timeout (PA-93)', async () => {
    const fakePcm = Buffer.from(new Int16Array([100, 200, 300, 400]).buffer);
    const liveStt = await startFakeLiveStt((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        // Simulate synthesis latency (e.g. Kokoro takes several seconds per sentence)
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'audio/pcm' });
          res.end(fakePcm);
        }, 150);
        return;
      }
      res.writeHead(404).end();
    });

    try {
      const fetchImpl = vi.fn().mockImplementation(() => {
        return fakeCompletionResponse('<speak>The weather today is cloudy with a high around 65.</speak>\n\nFull forecast follows.');
      });

      t = await createTestApp(
        { POCKETAGENT_LIVE_STT_URL: liveStt.url },
        undefined,
        undefined,
        undefined,
        fetchImpl as unknown as typeof fetch,
      );
      await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
      const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

      const { events } = await sendMessage(t, chat.id, 'What is the weather today?', { voiceMode: true });

      const ttsEvents = events.filter((e) => e.kind === 'tts_audio');
      expect(ttsEvents.length).toBeGreaterThan(0);
      const audioEvent = ttsEvents[0] as {
        kind: 'tts_audio';
        id: string;
        chunk: { data: string; sampleRateHz: number };
      };
      expect(audioEvent.chunk.sampleRateHz).toBe(24000);
      expect(audioEvent.chunk.data).toBe(fakePcm.toString('base64'));
    } finally {
      await liveStt.close();
    }
  });

  it('omits legacy exec_command from LLM tool specs when bash is active and resolves exec_command calls to bash', async () => {
    let capturedTools: Array<{ function: { name: string } }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string) as {
        tools?: Array<{ function: { name: string } }>;
        messages: Array<{ role: string; content: string | null }>;
      };
      if (body.tools) {
        capturedTools = body.tools;
      }
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (!hasToolResult) {
        // Return legacy exec_command call to verify resolveEnabledTool handles it
        return fakeToolCallResponse('exec_command', { command: 'echo resolved_via_exec_command' });
      }
      return fakeCompletionResponse('finished execution');
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com', yoloEnabled: true });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const { events } = await sendMessage(t, chat.id, 'run a test command');

    // Verify bash is in LLM tool specs but exec_command is omitted
    const toolNames = capturedTools.map((t) => t.function.name);
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('exec_command');

    // Verify exec_command executed successfully via bash alias
    const toolResult = events.find((e) => e.kind === 'tool_result') as {
      content: string;
      isError: boolean;
    };
    expect(toolResult).toBeDefined();
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content).toContain('resolved_via_exec_command');
  });

  it('interrupts an in-flight LLM stream and emits turn_complete with stopReason interrupted (PA-99)', async () => {
    let streamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn().mockImplementation((_url: string | URL, init?: RequestInit) => {
      streamSignal = init?.signal;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'starting response...' } }] })}\n\n`,
            ),
          );
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const gen = t.context.plannerChats.sendMessage(chat.id, 'do something');
    const first = await gen.next();
    expect(first.value?.kind).toBe('user_prompt');

    // Advance into driveLoop to start streaming from the LLM
    const second = await gen.next();
    expect(second.value?.kind).toBe('text_delta');

    // The chat is currently busy
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(true);

    // Call interrupt
    const interrupted = await t.context.plannerChats.interrupt(chat.id);
    expect(interrupted).toBe(true);
    expect(streamSignal?.aborted).toBe(true);

    // Drain remaining events
    const remaining: Array<{ kind: string; [key: string]: unknown }> = [];
    for await (const event of gen) remaining.push(event);

    const complete = remaining.find((e) => e.kind === 'turn_complete') as {
      kind: string;
      stopReason: string | null;
      isError: boolean;
    };
    expect(complete).toBeDefined();
    expect(complete.stopReason).toBe('interrupted');
    expect(complete.isError).toBe(false);

    // The chat is no longer busy
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(false);
  });

  it('interrupts an active turn via POST /api/planner/chats/:id/interrupt (PA-99)', async () => {
    const fetchImpl = vi.fn().mockImplementation((_url: string | URL, init?: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'chunk 1' } }] })}\n\n`,
            ),
          );
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    // Idle chat returns interrupted: false
    const idleRes = await post(t, `/api/planner/chats/${chat.id}/interrupt`);
    expect(idleRes.statusCode).toBe(200);
    expect(idleRes.json()).toEqual({ ok: true, interrupted: false });

    // Start a turn
    const gen = t.context.plannerChats.sendMessage(chat.id, 'do something');
    await gen.next(); // user_prompt
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(true);

    // Interrupt via HTTP route
    const busyRes = await post(t, `/api/planner/chats/${chat.id}/interrupt`);
    expect(busyRes.statusCode).toBe(200);
    expect(busyRes.json()).toEqual({ ok: true, interrupted: true });

    // Drain
    for await (const _ of gen) {
      // drain
    }
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(false);
  });

  it('interrupts a turn waiting on tool approval and emits turn_complete (PA-99)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => {
      return fakeToolCallResponse('bash', { command: 'rm -rf /tmp/test' });
    });

    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    // Start turn with mutating tool needing approval
    const { events } = await sendMessage(t, chat.id, 'run rm');
    const permReq = events.find((e) => e.kind === 'permission_request');
    expect(permReq).toBeDefined();
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(true);

    // Interrupt while paused on approval
    const res = await post(t, `/api/planner/chats/${chat.id}/interrupt`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, interrupted: true });

    expect(t.context.plannerChats.isBusy(chat.id)).toBe(false);

    // History should have permission_resolved deny and turn_complete interrupted
    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().events;
    const resolved = history.find((e: { kind: string }) => e.kind === 'permission_resolved');
    expect(resolved).toBeDefined();
    expect(resolved.decision).toBe('deny');

    const complete = history.find((e: { kind: string }) => e.kind === 'turn_complete');
    expect(complete).toBeDefined();
    expect(complete.stopReason).toBe('interrupted');
  });
});



