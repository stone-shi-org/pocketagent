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

function fakeCompletionResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeToolCallResponse(name: string, args: Record<string, unknown>, callId = 'call_1'): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
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

    expect(reply).toEqual({ content: 'hello there', toolCalls: [] });
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

  it('parses tool_calls out of the response, with null content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeToolCallResponse('list_workspaces', {}));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });
    const completion = await client.complete('m', []);
    expect(completion.content).toBeNull();
    expect(completion.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'list_workspaces', arguments: '{}' } },
    ]);
  });

  it('sends a tools array only when tools are passed', async () => {
    // `mockImplementation`, not `mockResolvedValue`: a `Response` body can
    // only be read once, and this test drives two calls through the mock.
    const fetchImpl = vi.fn().mockImplementation(() => fakeCompletionResponse('ok'));
    const client = new PlannerLlmClient({ baseUrl: 'https://api.example.com', apiKey: null, fetchImpl });

    await client.complete('m', []);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body as string)).not.toHaveProperty('tools');

    await client.complete('m', [], [{ type: 'function', function: { name: 'x' } }]);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body as string).tools).toHaveLength(1);
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
    expect(body.turn.status).toBe('completed');
    expect(body.turn.assistantEntry).toMatchObject({ role: 'assistant', content: "Here's the plan." });

    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().entries;
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');

    const chats = (await get(t, '/api/planner/chats')).json().chats;
    expect(chats[0].lastModelId).toBe('gpt-4o-mini');
    expect(chats[0].lastActivityAt).toBe(body.turn.assistantEntry.createdAt);

    const settings = (await get(t, '/api/planner/settings')).json();
    expect(settings.lastModelId).toBe('gpt-4o-mini');

    // The LLM was called with the running history including the just-sent
    // user message — not an empty or stale list.
    const sentMessages = JSON.parse(fetchImpl.mock.calls[0]![1].body as string).messages;
    expect(sentMessages).toEqual([{ role: 'user', content: 'plan my week' }]);
  });

  it('executes a read-only tool call immediately (no approval) and feeds the result back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('list_workspaces', {}))
      .mockResolvedValueOnce(fakeCompletionResponse('You have one workspace: project.'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, {
      content: 'what workspaces do I have?',
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().turn).toMatchObject({
      status: 'completed',
      assistantEntry: { content: 'You have one workspace: project.' },
    });
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

    // Only the user message and the final text reply land in the persisted
    // transcript — the tool exchange is scratch work for this turn only.
    const history = (await get(t, `/api/planner/chats/${chat.id}/history`)).json().entries;
    expect(history).toHaveLength(2);
    expect(history.map((e: { role: string }) => e.role)).toEqual(['user', 'assistant']);
  });

  it('gives up after too many tool-call iterations rather than looping forever', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => fakeToolCallResponse('list_workspaces', {}));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();

    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'loop forever' });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().turn.assistantEntry.content).toMatch(/too many tool calls/);
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

  // ---- PA-6 phase 4: mutating tools pause for approval ---------------------

  async function mkdirPending(fetchImpl: ReturnType<typeof vi.fn>) {
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch(t, '/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const chat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'make a directory' });
    return { chat, turn: turn.json() };
  }

  it('pauses a mutating tool call with no remembered decision', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'a-new-dir' }));
    const { turn } = await mkdirPending(fetchImpl);

    expect(turn.turn.status).toBe('approval_required');
    expect(turn.turn.toolName).toBe('mkdir');
    expect(JSON.parse(turn.turn.argsSummary)).toEqual({ path: 'a-new-dir' });
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
    const turn = (await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'make a directory' })).json();

    const resolved = await post(t, `/api/planner/chats/${chat.id}/approvals/${turn.turn.approvalId}`, {
      decision: 'allow_once',
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ status: 'completed', assistantEntry: { content: 'Made it.' } });
    expect((await fs.stat(targetDir)).isDirectory()).toBe(true);

    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const secondTurn = await post(t, `/api/planner/chats/${secondChat.id}/messages`, { content: 'again' });
    expect(secondTurn.json().turn.status).toBe('approval_required');
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
    const { chat, turn } = await mkdirPending(fetchImpl);

    const resolved = await post(t, `/api/planner/chats/${chat.id}/approvals/${turn.turn.approvalId}`, {
      decision: 'allow_workspace',
    });
    expect(resolved.json().status).toBe('completed');

    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const secondTurn = await post(t, `/api/planner/chats/${secondChat.id}/messages`, { content: 'again' });
    expect(secondTurn.json().turn).toMatchObject({ status: 'completed', assistantEntry: { content: 'Done twice.' } });
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const otherWs = (await post(t, '/api/planner/workspaces', { name: 'Other' })).json();
    const otherChat = (await post(t, '/api/planner/chats', { workspaceId: otherWs.id, modelId: 'gpt-4o' })).json();
    const otherTurn = await post(t, `/api/planner/chats/${otherChat.id}/messages`, { content: 'go' });
    expect(otherTurn.json().turn.status).toBe('approval_required');
  });

  it('allow_global remembers the decision for every workspace', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'global-remembered' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Done.'))
      // A chat in a *different* workspace: no pause — the decision is global.
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'still-global' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Also done.'));
    const { chat, turn } = await mkdirPending(fetchImpl);
    await post(t, `/api/planner/chats/${chat.id}/approvals/${turn.turn.approvalId}`, {
      decision: 'allow_global',
    });

    const otherWs = (await post(t, '/api/planner/workspaces', { name: 'Elsewhere' })).json();
    const otherChat = (await post(t, '/api/planner/chats', { workspaceId: otherWs.id, modelId: 'gpt-4o' })).json();
    const otherTurn = await post(t, `/api/planner/chats/${otherChat.id}/messages`, { content: 'go' });
    expect(otherTurn.json().turn).toMatchObject({ status: 'completed', assistantEntry: { content: 'Also done.' } });
  });

  it('deny records a denial as the tool result and lets the model try again', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-dir' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Understood, not creating it.'));
    const { chat, turn } = await mkdirPending(fetchImpl);

    const resolved = await post(t, `/api/planner/chats/${chat.id}/approvals/${turn.turn.approvalId}`, {
      decision: 'deny',
    });
    expect(resolved.json()).toMatchObject({
      status: 'completed',
      assistantEntry: { content: 'Understood, not creating it.' },
    });
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
    const { turn } = await mkdirPending(fetchImpl);
    const otherChat = (await post(t, '/api/planner/chats', {})).json();
    const res = await post(t, `/api/planner/chats/${otherChat.id}/approvals/${turn.turn.approvalId}`, {
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

    const turn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'go' });
    expect(turn.json().turn).toMatchObject({
      status: 'completed',
      assistantEntry: { content: 'Done, no questions asked.' },
    });
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
    await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'go' });

    await patch(t, '/api/planner/settings', { yoloEnabled: false });
    const secondChat = (await post(t, '/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const secondTurn = await post(t, `/api/planner/chats/${secondChat.id}/messages`, { content: 'go again' });
    expect(secondTurn.json().turn.status).toBe('approval_required');
  });

  it('yolo mode overrides even a remembered deny', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-then-yolo' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Denied as expected.'))
      .mockResolvedValueOnce(fakeToolCallResponse('mkdir', { path: 'denied-then-yolo-2' }))
      .mockResolvedValueOnce(fakeCompletionResponse('Ran anyway.'));
    const { chat, turn } = await mkdirPending(fetchImpl);
    await post(t, `/api/planner/chats/${chat.id}/approvals/${turn.turn.approvalId}`, { decision: 'deny' });

    // Nothing was remembered by a plain 'deny' (only allow_workspace/allow_global
    // persist), so pre-configure a global deny via the settings surface instead.
    await post(t, '/api/planner/tool-approvals', { scope: 'global', toolName: 'mkdir', decision: 'deny' });
    await patch(t, '/api/planner/settings', { yoloEnabled: true });

    const secondTurn = await post(t, `/api/planner/chats/${chat.id}/messages`, { content: 'try again' });
    expect(secondTurn.json().turn).toMatchObject({ status: 'completed', assistantEntry: { content: 'Ran anyway.' } });
  });
});
