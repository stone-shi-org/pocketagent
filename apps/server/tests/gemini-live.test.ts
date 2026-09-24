import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';
import {
  GEMINI_TOKEN_NEW_SESSION_TTL_MS,
  GEMINI_TOKEN_TTL_MS,
  buildGeminiLiveTokenRequest,
  normalizeGeminiModel,
} from '../src/planner/gemini-live.js';
import { LIVE_AWAITING_APPROVAL_MESSAGE, LIVE_MODE_SYSTEM_INSTRUCTION, eventsToSeedTurns } from '../src/planner/chats.js';
import { PLANNER_TOOLS } from '../src/planner/tools.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-96: Gemini Live as a per-agent live-stream provider for Pocket Agent
 * chats. The browser-side WebSocket is exercised by `demo:gemini-live-ui`
 * against the real service; what is asserted here is everything the server
 * decides — the constraint set the token is locked to, that the key never
 * leaves the process, and that a Gemini tool call gets exactly the planner's
 * own gate.
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');
const GEMINI_KEY = 'AIzaTEST-not-a-real-key-0123456789';

// ---- the constraint builder --------------------------------------------------

describe('buildGeminiLiveTokenRequest', () => {
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  const decls = [{ name: 'list_workspaces', description: 'List', parametersJsonSchema: { type: 'object', properties: {} } }];

  it('locks the model, audio-only output, system instruction and exact tool list into the token', () => {
    const body = buildGeminiLiveTokenRequest({
      model: 'gemini-3.8-live',
      voice: 'Puck',
      systemInstruction: 'Be brief.',
      functionDeclarations: decls,
      now,
    });
    expect(body).toEqual({
      uses: 1,
      expireTime: new Date(now + GEMINI_TOKEN_TTL_MS).toISOString(),
      newSessionExpireTime: new Date(now + GEMINI_TOKEN_NEW_SESSION_TTL_MS).toISOString(),
      bidiGenerateContentSetup: {
        model: 'models/gemini-3.8-live',
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } } },
        },
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        sessionResumption: {},
        contextWindowCompression: { slidingWindow: {} },
        tools: [{ functionDeclarations: decls }],
      },
    });
    // No field mask: with a setup present and no mask, every field of that
    // setup is locked — a mask would unlock whatever it does not name.
    expect(body).not.toHaveProperty('fieldMask');
    expect(body).not.toHaveProperty('lockAdditionalFields');
  });

  it('keeps the token single-use with a ≤30 minute window', () => {
    const body = buildGeminiLiveTokenRequest({ model: 'm', voice: null, systemInstruction: 'x', functionDeclarations: [], now });
    expect(body.uses).toBe(1);
    expect(Date.parse(body.expireTime as string) - now).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(Date.parse(body.newSessionExpireTime as string) - now).toBeLessThanOrEqual(60 * 1000);
  });

  it('bakes a resumption handle into the token, since a client-supplied one is ignored', () => {
    const body = buildGeminiLiveTokenRequest({
      model: 'm',
      voice: null,
      systemInstruction: 'x',
      functionDeclarations: [],
      resumeHandle: 'handle-123',
      now,
    });
    const setup = body.bidiGenerateContentSetup as Record<string, unknown>;
    expect(setup.sessionResumption).toEqual({ handle: 'handle-123' });
    expect(setup).not.toHaveProperty('tools');
    expect((setup.generationConfig as Record<string, unknown>).speechConfig).toBeUndefined();
  });

  it('normalises the model id either way it was typed', () => {
    expect(normalizeGeminiModel('gemini-3.8-live')).toBe('models/gemini-3.8-live');
    expect(normalizeGeminiModel('models/gemini-3.8-live')).toBe('models/gemini-3.8-live');
  });

  it('passes every built-in tool schema through verbatim as JSON Schema', () => {
    // `parametersJsonSchema`, not the OpenAPI-subset `parameters`: all of these
    // were accepted as-is by the live service, so a conversion layer would only
    // be a place to lose information.
    const all = PLANNER_TOOLS.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters }));
    const body = buildGeminiLiveTokenRequest({ model: 'm', voice: null, systemInstruction: 'x', functionDeclarations: all, now });
    const tools = (body.bidiGenerateContentSetup as { tools: { functionDeclarations: unknown[] }[] }).tools;
    expect(tools[0]!.functionDeclarations).toHaveLength(PLANNER_TOOLS.length);
  });
});

describe('eventsToSeedTurns', () => {
  it('turns a transcript into alternating text turns, tool calls narrated', () => {
    const turns = eventsToSeedTurns([
      { kind: 'user_prompt', id: 'u1', text: 'what workspaces do I have?' },
      { kind: 'tool_use', id: 't1', name: 'list_workspaces', input: {}, summary: 'list_workspaces()', filePath: null },
      { kind: 'tool_result', id: 'r1', toolUseId: 't1', content: 'alpha, beta', truncated: false, isError: false },
      { kind: 'text', id: 'a1', text: '<speak>Two of them.</speak>You have alpha and beta.' },
      { kind: 'turn_complete', stopReason: 'end_turn', isError: false, numTurns: null, durationMs: 1, costUsd: null },
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'what workspaces do I have?' },
      { role: 'model', text: '[I called list_workspaces(): alpha, beta]\nYou have alpha and beta.' },
    ]);
  });

  it('truncates a long tool result and drops the oldest turns past the cap', () => {
    const long = 'x'.repeat(5000);
    const turns = eventsToSeedTurns([
      { kind: 'tool_use', id: 't1', name: 'read_file', input: {}, summary: 'read_file()', filePath: null },
      { kind: 'tool_result', id: 'r1', toolUseId: 't1', content: long, truncated: false, isError: false },
    ]);
    expect(turns[0]!.text.length).toBeLessThan(1700);

    const many = Array.from({ length: 200 }, (_, i) => [
      { kind: 'user_prompt' as const, id: `u${i}`, text: `q${i} ${'y'.repeat(400)}` },
      { kind: 'text' as const, id: `a${i}`, text: `a${i} ${'z'.repeat(400)}` },
    ]).flat();
    const capped = eventsToSeedTurns(many);
    expect(capped.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(60_000);
    expect(capped[capped.length - 1]!.text.startsWith('a199')).toBe(true);
  });
});

// ---- HTTP surface --------------------------------------------------------------

function tokenFetch(): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify({ name: 'auth_tokens/abc123' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

describe('Gemini Live routes', () => {
  let t: TestApp;
  let logs: string;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  async function boot(opts: { encrypted?: boolean; gemini?: ReturnType<typeof vi.fn>; llm?: ReturnType<typeof vi.fn> } = {}) {
    logs = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        logs += chunk.toString();
        cb();
      },
    });
    t = await createTestApp(
      opts.encrypted === false ? {} : { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      undefined,
      undefined,
      undefined,
      opts.llm as unknown as typeof fetch | undefined,
      undefined,
      undefined,
      stream,
      opts.gemini as unknown as typeof fetch | undefined,
    );
  }

  /** A Gemini-Live agent with a stored key and one chat. */
  async function liveChat() {
    await patch('/api/planner/gemini-live', { apiKey: GEMINI_KEY });
    const { workspaces } = (await get('/api/planner/workspaces')).json();
    const workspace = workspaces[0];
    const updated = await patch(`/api/planner/workspaces/${workspace.id}`, { liveProvider: 'gemini-live' });
    expect(updated.json().liveProvider).toBe('gemini-live');
    const chat = (await post('/api/planner/chats', { workspaceId: workspace.id })).json();
    return { workspace, chat };
  }

  const history = async (chatId: string) => (await get(`/api/planner/chats/${chatId}/history`)).json().events as Array<Record<string, unknown>>;

  it('defaults every agent to the existing pipeline', async () => {
    await boot();
    const { workspaces } = (await get('/api/planner/workspaces')).json();
    expect(workspaces[0].liveProvider).toBe('pipeline');
  });

  it('never returns the key — not from GET, not from PATCH — and never logs it', async () => {
    await boot();
    const initial = (await get('/api/planner/gemini-live')).json();
    expect(initial).toMatchObject({ encryptionAvailable: true, hasApiKey: false, available: false, model: 'gemini-3.8-live' });

    const set = await patch('/api/planner/gemini-live', { apiKey: GEMINI_KEY, voice: 'Puck', idleMinutes: 3 });
    expect(set.statusCode).toBe(200);
    expect(set.payload).not.toContain(GEMINI_KEY);
    expect(set.json()).toMatchObject({ hasApiKey: true, available: true, voice: 'Puck', idleMinutes: 3 });
    expect((await get('/api/planner/gemini-live')).payload).not.toContain(GEMINI_KEY);

    // Stored encrypted: the plaintext is nowhere in the settings table.
    const rows = t.db.prepare("SELECT value FROM settings WHERE key LIKE 'planner_gemini%'").all() as { value: string }[];
    expect(rows.some((r) => r.value.includes(GEMINI_KEY))).toBe(false);
    expect(logs).not.toContain(GEMINI_KEY);
  });

  it('keeps the stored key on a blank save, and removes it only when asked', async () => {
    await boot();
    await patch('/api/planner/gemini-live', { apiKey: GEMINI_KEY });
    expect((await patch('/api/planner/gemini-live', { apiKey: '', model: 'gemini-2.5-flash-native-audio-latest' })).json()).toMatchObject({
      hasApiKey: true,
      model: 'gemini-2.5-flash-native-audio-latest',
    });
    expect((await patch('/api/planner/gemini-live', { clearApiKey: true })).json()).toMatchObject({ hasApiKey: false, available: false });
  });

  it('is unavailable without an encryption key, and refuses to store one rather than failing the boot', async () => {
    await boot({ encrypted: false });
    expect((await get('/api/planner/gemini-live')).json()).toMatchObject({ encryptionAvailable: false, available: false });
    const res = await patch('/api/planner/gemini-live', { apiKey: GEMINI_KEY });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('encryption_unavailable');
  });

  it("refuses a token unless the chat's agent is set to Gemini Live", async () => {
    const gemini = tokenFetch();
    await boot({ gemini });
    await patch('/api/planner/gemini-live', { apiKey: GEMINI_KEY });
    const chat = (await post('/api/planner/chats', {})).json();
    const res = await post(`/api/planner/chats/${chat.id}/live/token`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_gemini_live');
    expect(gemini).not.toHaveBeenCalled();
  });

  it('refuses a token when no key is configured', async () => {
    const gemini = tokenFetch();
    await boot({ gemini });
    const { chat } = await liveChat();
    await patch('/api/planner/gemini-live', { clearApiKey: true });
    const res = await post(`/api/planner/chats/${chat.id}/live/token`, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('not_configured');
    expect(gemini).not.toHaveBeenCalled();
  });

  it("mints a token seeded with the chat's real context, the key only in the outbound header", async () => {
    const gemini = tokenFetch();
    await boot({ gemini });
    const { workspace, chat } = await liveChat();
    await patch(`/api/planner/workspaces/${workspace.id}`, { identityPrompt: 'I am the release-notes agent.' });
    // Disabled at both layers — neither may reach Gemini's tool list.
    await patch('/api/planner/tools/exec_command', { enabled: false });
    await post(`/api/planner/workspaces/${workspace.id}/tools`, { toolName: 'write_file', enabled: false });
    // Some prior history, persisted the way a live turn records it.
    await post(`/api/planner/chats/${chat.id}/live/transcript`, { userText: 'my dog is Biscuit', modelText: 'Lovely name.' });

    const res = await post(`/api/planner/chats/${chat.id}/live/token`, {});
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      token: 'auth_tokens/abc123',
      model: 'models/gemini-3.8-live',
      resumed: false,
      seedTurns: [
        { role: 'user', text: 'my dog is Biscuit' },
        { role: 'model', text: 'Lovely name.' },
      ],
    });
    expect(body.wsUrl).toContain('BidiGenerateContentConstrained');
    expect(res.payload).not.toContain(GEMINI_KEY);

    const [url, init] = gemini.mock.calls[0]!;
    expect(url).toBe('https://generativelanguage.googleapis.com/v1alpha/auth_tokens');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(GEMINI_KEY);
    const sent = JSON.parse(init.body as string);
    const setup = sent.bidiGenerateContentSetup;
    const instruction: string = setup.systemInstruction.parts[0].text;
    expect(instruction).toContain(LIVE_MODE_SYSTEM_INSTRUCTION);
    expect(instruction).toContain('I am the release-notes agent.');
    const names: string[] = setup.tools[0].functionDeclarations.map((d: { name: string }) => d.name);
    expect(names).toContain('list_workspaces');
    expect(names).toContain('mkdir');
    expect(names).not.toContain('exec_command');
    expect(names).not.toContain('write_file');
    // Logged by chat id; the token and the key appear in no log line.
    expect(logs).toContain('gemini live token minted');
    expect(logs).not.toContain('auth_tokens/abc123');
    expect(logs).not.toContain(GEMINI_KEY);
  });

  it('resumes by baking the handle into a fresh token, with no seed history', async () => {
    const gemini = tokenFetch();
    await boot({ gemini });
    const { chat } = await liveChat();
    await post(`/api/planner/chats/${chat.id}/live/transcript`, { userText: 'hello' });
    const res = await post(`/api/planner/chats/${chat.id}/live/token`, { resumeHandle: 'h-42' });
    expect(res.json()).toMatchObject({ resumed: true, seedTurns: [] });
    const sent = JSON.parse(gemini.mock.calls[0]![1].body as string);
    expect(sent.bidiGenerateContentSetup.sessionResumption).toEqual({ handle: 'h-42' });
  });

  it('surfaces a Gemini refusal as 502 without echoing the key', async () => {
    const gemini = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: 'API key not valid.' } }), { status: 400 }),
    );
    await boot({ gemini });
    const { chat } = await liveChat();
    const res = await post(`/api/planner/chats/${chat.id}/live/token`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error.message).toContain('API key not valid.');
    expect(res.payload).not.toContain(GEMINI_KEY);
  });

  // ---- the tool bridge ---------------------------------------------------------

  it('runs a read-only call at once and persists it like a planner tool call', async () => {
    await boot();
    const { chat } = await liveChat();
    const res = await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [{ id: 'call_1', name: 'list_workspaces', args: {} }],
    });
    expect(res.statusCode).toBe(200);
    const [result] = res.json().results;
    expect(result).toMatchObject({ callId: 'call_1', name: 'list_workspaces', status: 'completed', approvalId: null });
    // The persisted id is minted server-side, not Gemini's short per-session id.
    expect(result.toolUseId).toMatch(/^live_/);
    const events = await history(chat.id);
    expect(events.map((e) => e.kind)).toEqual(['tool_use', 'tool_result']);
    expect(events[0]).toMatchObject({ id: result.toolUseId, name: 'list_workspaces' });
    expect(events[1]).toMatchObject({ toolUseId: result.toolUseId, isError: false, content: result.output });
  });

  it('refuses unknown and disabled tools in the transcript’s own words', async () => {
    await boot();
    const { workspace, chat } = await liveChat();
    await patch('/api/planner/tools/read_file', { enabled: false });
    await post(`/api/planner/workspaces/${workspace.id}/tools`, { toolName: 'list_sessions', enabled: false });
    const res = await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [
        { id: 'a', name: 'format_disk', args: {} },
        { id: 'b', name: 'read_file', args: { path: 'x' } },
        { id: 'c', name: 'list_sessions', args: {} },
      ],
    });
    const outputs = res.json().results.map((r: { status: string; output: string }) => [r.status, r.output]);
    expect(outputs).toEqual([
      ['refused', 'Unknown tool: format_disk'],
      ['refused', 'Tool "read_file" is disabled globally.'],
      ['refused', 'Tool "list_sessions" is disabled for this agent.'],
    ]);
  });

  it('parks a mutating call on the approval card, answers Gemini at once, and runs it only on approval', async () => {
    const llm = vi.fn();
    await boot({ llm });
    const { chat } = await liveChat();
    const target = path.join(t.workspaceRoot, 'live-made');
    const res = await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [{ id: 'call_mk', name: 'mkdir', args: { path: target } }],
    });
    const [result] = res.json().results;
    expect(result.status).toBe('awaiting_approval');
    expect(result.output).toBe(LIVE_AWAITING_APPROVAL_MESSAGE);
    expect(result.approvalId).toBeTruthy();
    // Nothing ran.
    expect(fs.existsSync(target)).toBe(false);
    expect((await history(chat.id)).map((e) => e.kind)).toEqual(['tool_use', 'permission_request']);

    // A parked live approval blocks a restart (PA-69) and marks the chat busy.
    expect(t.context.plannerChats.inFlightTurns()).toEqual([
      expect.objectContaining({ chatId: chat.id, reason: 'awaiting_approval' }),
    ]);

    const resolved = await post(`/api/planner/chats/${chat.id}/approvals/${result.approvalId}`, { decision: 'allow_once' });
    expect(resolved.statusCode).toBe(200);
    const kinds = resolved.payload
      .split('\n\n')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => JSON.parse(c.replace(/^data: /, '')).kind);
    // The call runs and its result is persisted — and that is all: there is
    // no planner-LLM continuation, because Gemini holds the conversation.
    expect(kinds).toEqual(['permission_resolved', 'tool_result']);
    expect(fs.existsSync(target)).toBe(true);
    expect(llm).not.toHaveBeenCalled();
    expect(t.context.plannerChats.inFlightTurns()).toEqual([]);
    const events = await history(chat.id);
    expect(events[events.length - 1]).toMatchObject({ kind: 'tool_result', toolUseId: result.toolUseId, isError: false });
  });

  it('a denied live approval runs nothing', async () => {
    await boot();
    const { chat } = await liveChat();
    const target = path.join(t.workspaceRoot, 'live-denied');
    const [result] = (
      await post(`/api/planner/chats/${chat.id}/live/tool-calls`, { calls: [{ id: 'x', name: 'mkdir', args: { path: target } }] })
    ).json().results;
    await post(`/api/planner/chats/${chat.id}/approvals/${result.approvalId}`, { decision: 'deny' });
    expect(fs.existsSync(target)).toBe(false);
    const events = await history(chat.id);
    expect(events[events.length - 1]).toMatchObject({ kind: 'tool_result', content: 'Denied by the user.', isError: true });
  });

  it('honours yolo and a remembered deny exactly as the planner loop does', async () => {
    await boot();
    const { chat } = await liveChat();
    await post('/api/planner/tool-approvals', { scope: 'global', toolName: 'mkdir', decision: 'deny' });
    const denied = (
      await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
        calls: [{ id: 'd', name: 'mkdir', args: { path: path.join(t.workspaceRoot, 'nope') } }],
      })
    ).json().results[0];
    expect(denied).toMatchObject({ status: 'refused', output: 'Denied by a remembered decision.' });

    await patch('/api/planner/settings', { yoloEnabled: true });
    const target = path.join(t.workspaceRoot, 'yolo-live');
    const ran = (await post(`/api/planner/chats/${chat.id}/live/tool-calls`, { calls: [{ id: 'y', name: 'mkdir', args: { path: target } }] }))
      .json().results[0];
    expect(ran.status).toBe('completed');
    expect(fs.existsSync(target)).toBe(true);
  });

  it('the request schema has no way to claim an approval', async () => {
    await boot();
    const { chat } = await liveChat();
    const target = path.join(t.workspaceRoot, 'claimed');
    const res = await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [{ id: 'z', name: 'mkdir', args: { path: target }, approved: true, decision: 'allow_global' }],
      approved: true,
    });
    expect(res.json().results[0].status).toBe('awaiting_approval');
    expect(fs.existsSync(target)).toBe(false);
  });

  // ---- transcript persistence ---------------------------------------------------

  it('persists speech as ordinary events, titles the chat, and hands the history to the planner LLM', async () => {
    const llm = vi.fn().mockImplementation(async () =>
      new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Biscuit.' } }] })}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await boot({ llm });
    const { chat } = await liveChat();
    const res = await post(`/api/planner/chats/${chat.id}/live/transcript`, {
      userText: 'My dog is called Biscuit',
      modelText: 'What a lovely name.',
      turnComplete: { inputTokens: 120, outputTokens: 30, durationMs: 900 },
    });
    expect(res.statusCode).toBe(204);
    const events = await history(chat.id);
    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'text', 'turn_complete']);
    expect(events[2]).toMatchObject({ inputTokens: 120, outputTokens: 30, durationMs: 900, stopReason: 'end_turn' });
    const chats = (await get('/api/planner/chats')).json().chats;
    expect(chats.find((c: { id: string }) => c.id === chat.id).title).toBe('My dog is called Biscuit');

    // Live mode off: the very same history reaches the normal planner model.
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    await post(`/api/planner/chats/${chat.id}/messages`, { content: "What's my dog called?", modelId: 'gpt-4o' });
    const sent = JSON.parse(llm.mock.calls[0]![1].body as string);
    const contents = sent.messages.map((m: { role: string; content: string }) => [m.role, m.content]);
    expect(contents).toEqual(
      expect.arrayContaining([
        ['user', 'My dog is called Biscuit'],
        ['assistant', 'What a lovely name.'],
        ['user', "What's my dog called?"],
      ]),
    );
  });

  it('rejects an empty transcript report and anything shaped like a tool event', async () => {
    await boot();
    const { chat } = await liveChat();
    expect((await post(`/api/planner/chats/${chat.id}/live/transcript`, {})).statusCode).toBe(400);
    await post(`/api/planner/chats/${chat.id}/live/transcript`, {
      userText: 'hi',
      kind: 'tool_result',
      events: [{ kind: 'permission_resolved', decision: 'allow' }],
    });
    expect((await history(chat.id)).map((e) => e.kind)).toEqual(['user_prompt']);
  });

  it('refuses to go live, act, or record while the planner LLM owns the chat', async () => {
    const llm = vi.fn().mockImplementation(async () =>
      new Response(
        `data: ${JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'mkdir', arguments: '{"path":"x"}' } }] } }],
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    await boot({ llm, gemini: tokenFetch() });
    const { chat } = await liveChat();
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    // A typed turn parks on an approval — the planner LLM owns this chat now.
    await post(`/api/planner/chats/${chat.id}/messages`, { content: 'make a dir', modelId: 'gpt-4o' });
    expect((await post(`/api/planner/chats/${chat.id}/live/token`, {})).statusCode).toBe(409);
    expect(
      (await post(`/api/planner/chats/${chat.id}/live/tool-calls`, { calls: [{ id: 'q', name: 'list_workspaces', args: {} }] }))
        .statusCode,
    ).toBe(409);
    expect((await post(`/api/planner/chats/${chat.id}/live/transcript`, { userText: 'hi' })).statusCode).toBe(409);
  });

  it('a parked live approval blocks a typed message until it is decided', async () => {
    await boot();
    const { chat } = await liveChat();
    await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [{ id: 'm', name: 'mkdir', args: { path: path.join(t.workspaceRoot, 'blocked') } }],
    });
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const res = await post(`/api/planner/chats/${chat.id}/messages`, { content: 'hello', modelId: 'gpt-4o' });
    expect(res.statusCode).toBe(409);
    // …but a second live call in the same session is not refused by it.
    const second = await post(`/api/planner/chats/${chat.id}/live/tool-calls`, {
      calls: [{ id: 'n', name: 'list_workspaces', args: {} }],
    });
    expect(second.statusCode).toBe(200);
  });
});
