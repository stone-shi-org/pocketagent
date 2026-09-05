import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlannerLlmClient, PlannerLlmError } from '../src/planner/llm-client.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-6, phase 2 (chat core): the LLM client, the chat turn loop, and the
 * `/api/planner/chats` HTTP surface. Still no tools and no approval gate —
 * see PA-6 for the phases that add them.
 */

// ---- PlannerLlmClient, unit-level against an injected fetch ----------------

function fakeCompletionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('PlannerLlmClient', () => {
  it('sends the model, messages, and Authorization header, and returns the reply text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('hello there'));
    const client = new PlannerLlmClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      fetchImpl,
    });

    const reply = await client.complete('gpt-4o-mini', [{ role: 'user', content: 'hi' }]);

    expect(reply).toBe('hello there');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('omits the Authorization header when no API key is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await client.complete('m', []);
    const [, init] = fetchImpl.mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('strips a trailing slash from baseUrl before appending the path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com/v1/', apiKey: null, fetchImpl });
    await client.complete('m', []);
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('throws PlannerLlmError on a non-2xx response, including the status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('server exploded', { status: 500 }));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(client.complete('m', [])).rejects.toThrow(PlannerLlmError);
    await expect(client.complete('m', [])).rejects.toMatchObject({ statusCode: 500 });
  });

  it('throws PlannerLlmError when the response has no message content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{}] }), { status: 200 }),
    );
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(client.complete('m', [])).rejects.toThrow(/no message content/);
  });

  it('throws PlannerLlmError when fetch itself rejects (network failure)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    await expect(client.complete('m', [])).rejects.toThrow(/Could not reach/);
  });
});

// ---- HTTP surface -----------------------------------------------------------

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

  it('creates a chat defaulting to the default workspace', async () => {
    t = await createTestApp();
    const created = await post(t, '/api/planner/chats', {});
    expect(created.statusCode).toBe(201);
    const chat = created.json();
    expect(chat.workspaceName).toBe('default');
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

  it('renames a chat and changes its model', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const renamed = await patch(t, `/api/planner/chats/${chat.id}`, { title: 'New title' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().title).toBe('New title');

    const modeled = await patch(t, `/api/planner/chats/${chat.id}`, { modelId: 'gpt-4o' });
    expect(modeled.json().lastModelId).toBe('gpt-4o');
  });

  it('deletes a chat', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    expect((await del(t, `/api/planner/chats/${chat.id}`)).statusCode).toBe(204);
    expect((await get(t, '/api/planner/chats')).json().chats).toHaveLength(0);
  });

  it('history is empty for a chat with no messages yet', async () => {
    t = await createTestApp();
    const chat = (await post(t, '/api/planner/chats', {})).json();
    const history = await get(t, `/api/planner/chats/${chat.id}/history`);
    expect(history.statusCode).toBe(200);
    expect(history.json().entries).toEqual([]);
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

  it('completes a turn end-to-end: persists both entries, updates the chat and the global last-used model', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(fakeCompletionResponse("Here's the plan."));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);

    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' });
    const model = await post(t, '/api/planner/models', { modelId: 'gpt-4o-mini', label: 'Fast' });
    const chat = (await post(t, '/api/planner/chats', { modelId: model.json().modelId })).json();

    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'plan my week' });
    expect(turn.statusCode).toBe(200);
    const body = turn.json();
    expect(body.userEntry).toMatchObject({ role: 'user', content: 'plan my week' });
    expect(body.assistantEntry).toMatchObject({ role: 'assistant', content: "Here's the plan." });

    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().entries;
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');

    const chats = (await get(t, '/api/planner/chats')).json().chats;
    expect(chats[0].lastModelId).toBe('gpt-4o-mini');
    expect(chats[0].lastActivityAt).toBe(body.assistantEntry.createdAt);

    const settings = (await get(t, '/api/planner/settings')).json();
    expect(settings.lastModelId).toBe('gpt-4o-mini');

    // The LLM was called with the running history including the just-sent
    // user message — not an empty or stale list.
    const sentMessages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(sentMessages).toEqual([{ role: 'user', content: 'plan my week' }]);
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

  it('502s when the configured LLM endpoint errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const res = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'hi' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('llm_error');
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
});
