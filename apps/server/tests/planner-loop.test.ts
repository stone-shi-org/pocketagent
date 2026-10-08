import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { MAX_TOOL_OUTPUT_CHARS, capToolOutput } from '../src/planner/chats.js';

/**
 * PA-121: the Pocket Agent turn loop's handling of tool calls and context —
 * argument validation, truncated replies, narration, error marking, the
 * result-size backstop, and transcript robustness. Driven through the real
 * `/api/planner/chats` HTTP surface against a scripted fake LLM endpoint,
 * which records every request body so a test can assert what the model was
 * actually shown.
 */

type Body = {
  model: string;
  messages: Array<{ role: string; content: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }>;
  tools?: unknown[];
  max_tokens?: number;
};

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const reply = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }) =>
  sse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }, ...(usage ? [{ choices: [], usage }] : [])]);

const toolCall = (
  calls: Array<{ name: string; args: string; id?: string }>,
  opts: { content?: string; finishReason?: string } = {},
) =>
  sse([
    ...(opts.content ? [{ choices: [{ delta: { content: opts.content } }] }] : []),
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
          finish_reason: opts.finishReason ?? 'tool_calls',
        },
      ],
    },
  ]);

/** A fake endpoint answering each request with the next scripted response,
    and the final one for everything after. */
function scripted(responses: Array<(body: Body) => Response>) {
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

describe('Pocket Agent turn loop (PA-121)', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  async function setup(fetchImpl: ReturnType<typeof vi.fn>, settings: Record<string, unknown> = {}) {
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://llm.example.com', ...settings });
    return (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json() as { id: string; workspaceId: string };
  }

  async function send(chatId: string, content: string) {
    const res = await post(`/api/planner/chats/${chatId}/messages`, { content });
    return parseEvents(res.payload);
  }

  async function history(chatId: string) {
    return (await get(`/api/planner/chats/${chatId}/history`)).json().events as Array<{ kind: string; [k: string]: unknown }>;
  }

  async function workspacePath(workspaceId: string): Promise<string> {
    const list = (await get('/api/planner/workspaces')).json().workspaces as Array<{ id: string; path: string }>;
    return list.find((w) => w.id === workspaceId)!.path;
  }

  // ---- argument validation --------------------------------------------------

  it('answers invalid tool-call JSON with the parse error, never runs the tool, and keeps the raw text', async () => {
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'read_file', args: '{"path": "notes.txt"' }]),
      () => reply('fixed it'),
    ]);
    const chat = await setup(fetchImpl);
    const events = await send(chat.id, 'read my notes');

    const use = events.find((e) => e.kind === 'tool_use')!;
    expect(use.input).toEqual({ _invalidArguments: '{"path": "notes.txt"' });
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(result.isError).toBe(true);
    expect(String(result.content)).toMatch(/^Invalid JSON in the arguments for tool "read_file"/);

    // The second round trip shows the model its own malformed call and the error.
    const second = bodies[1]!;
    const assistant = second.messages.find((m) => m.tool_calls)!;
    expect(JSON.parse(assistant.tool_calls![0]!.function.arguments)).toEqual({
      _invalidArguments: '{"path": "notes.txt"',
    });
    const tool = second.messages.find((m) => m.role === 'tool')!;
    expect(String(tool.content)).toMatch(/^Error: Invalid JSON/);
  });

  it('refuses a mutating call with invalid arguments without asking a human to approve it', async () => {
    const { fetchImpl } = scripted([
      () => toolCall([{ name: 'write_file', args: '{"content":"x"}' }]),
      () => reply('ok'),
    ]);
    const chat = await setup(fetchImpl);
    const events = await send(chat.id, 'write it');
    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(String(result.content)).toContain('path: is required');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
  });

  // ---- truncated replies ----------------------------------------------------

  it('never executes tool calls from a reply cut off at the output-token limit', async () => {
    let target = '';
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'mkdir', args: JSON.stringify({ path: target }) }], { finishReason: 'length' }),
      () => reply('trying again later'),
    ]);
    const chat = await setup(fetchImpl, { yoloEnabled: true });
    target = path.join(await workspacePath(chat.workspaceId), 'never-created');
    const events = await send(chat.id, 'make a dir');
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('hit the output token limit');
    expect(bodies).toHaveLength(2);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  // ---- narration ------------------------------------------------------------

  it('persists text written before a tool call as interim, and replays it with the call', async () => {
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'get_current_time', args: '{}' }], { content: 'Let me check the clock.' }),
      () => reply('It is now.'),
    ]);
    const chat = await setup(fetchImpl);
    await send(chat.id, 'what time is it');

    const events = await history(chat.id);
    const texts = events.filter((e) => e.kind === 'text');
    expect(texts.map((e) => [e.text, e.interim ?? false])).toEqual([
      ['Let me check the clock.', true],
      ['It is now.', false],
    ]);

    const assistant = bodies[1]!.messages.find((m) => m.tool_calls)!;
    expect(assistant.content).toBe('Let me check the clock.');
    // No separate assistant message duplicating it.
    expect(bodies[1]!.messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  // ---- error marking and missing results -----------------------------------

  it('marks failed tool results as errors in what the model sees', async () => {
    const { fetchImpl, bodies } = scripted([
      () => toolCall([{ name: 'nonexistent_tool', args: '{}' }]),
      () => reply('ok'),
    ]);
    const chat = await setup(fetchImpl);
    await send(chat.id, 'go');
    const tool = bodies[1]!.messages.find((m) => m.role === 'tool')!;
    expect(tool.content).toBe('Error: Unknown tool: nonexistent_tool');
  });

  it('tells the model a tool call with no recorded result did not run, rather than sending ""', async () => {
    const { fetchImpl, bodies } = scripted([() => reply('ok')]);
    const chat = await setup(fetchImpl);
    // A transcript as a restart mid-approval leaves it: a tool_use, no result.
    const dir = path.join(await workspacePath(chat.workspaceId), '.transcripts');
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { kind: 'user_prompt', id: 'u1', text: 'make a dir' },
      { kind: 'tool_use', id: 'call_x', name: 'mkdir', input: { path: 'a' }, summary: 'mkdir', filePath: null },
      { kind: 'permission_request', id: 'p1', toolName: 'mkdir', input: {}, title: 'Run mkdir', displayName: null, filePath: null, reason: null, canAllowForSession: false, questions: null },
    ];
    await fs.writeFile(path.join(dir, `${chat.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    await send(chat.id, 'did it work?');
    const tool = bodies[0]!.messages.find((m) => m.role === 'tool')!;
    expect(String(tool.content)).toContain('No result was recorded for this tool call');
  });

  // ---- result-size backstop -------------------------------------------------

  it('caps any single tool result, keeping both ends', () => {
    const big = 'HEAD' + 'x'.repeat(MAX_TOOL_OUTPUT_CHARS * 2) + 'TAIL';
    const capped = capToolOutput(big);
    expect(capped.truncated).toBe(true);
    expect(capped.content.startsWith('HEAD')).toBe(true);
    expect(capped.content.endsWith('TAIL')).toBe(true);
    expect(capped.content.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARS + 300);
    expect(capped.content).toContain('characters omitted');
    expect(capToolOutput('small')).toEqual({ content: 'small', truncated: false });
  });

  // ---- LLM resilience (phase 2) ---------------------------------------------

  it('retries a transient LLM failure inside the turn and says so with an info notice', async () => {
    const { fetchImpl, bodies } = scripted([
      () => new Response('overloaded', { status: 503, headers: { 'retry-after-ms': '1' } }),
      () => reply('recovered'),
    ]);
    const chat = await setup(fetchImpl);
    const events = await send(chat.id, 'hello');
    const notice = events.find((e) => e.kind === 'notice')!;
    expect(notice).toMatchObject({ level: 'info' });
    expect(String(notice.text)).toMatch(/retrying in 1s \(attempt 1 of 3\)/);
    expect(events.filter((e) => e.kind === 'text').map((e) => e.text)).toEqual(['recovered']);
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
    expect(bodies).toHaveLength(2);
    // The notice is history, not context: the next turn does not send it.
    await send(chat.id, 'again');
    expect(JSON.stringify(bodies.at(-1)!.messages)).not.toContain('retrying');
  });

  it('keeps an LLM failure out of what the model is sent on the next turn', async () => {
    const { fetchImpl, bodies } = scripted([
      () => new Response('bad request', { status: 400 }),
      () => reply('fine now'),
    ]);
    const chat = await setup(fetchImpl);
    const first = await send(chat.id, 'one');
    expect(first.find((e) => e.kind === 'notice')).toMatchObject({ level: 'error' });
    await send(chat.id, 'two');
    const sent = bodies.at(-1)!.messages;
    expect(sent.filter((m) => m.role === 'assistant')).toHaveLength(0);
    expect(JSON.stringify(sent)).not.toContain('Could not reach');
  });

  // ---- transcript robustness ------------------------------------------------

  it('skips an unreadable transcript line instead of making the chat unusable', async () => {
    const { fetchImpl } = scripted([() => reply('still here')]);
    const chat = await setup(fetchImpl);
    await send(chat.id, 'first');
    const file = path.join(await workspacePath(chat.workspaceId), '.transcripts', `${chat.id}.jsonl`);
    await fs.appendFile(file, '{"kind":"text","id":"cut-off-by-a-cra\n');

    const hist = await get(`/api/planner/chats/${chat.id}/history`);
    expect(hist.statusCode).toBe(200);
    const events = await send(chat.id, 'second');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
  });

  it('clearing history resets the memory fold marker', async () => {
    const { fetchImpl } = scripted([() => reply('ok')]);
    const chat = await setup(fetchImpl);
    await send(chat.id, 'hi');
    t.db.prepare('UPDATE planner_chats SET memory_folded_turns = 7 WHERE id = ?').run(chat.id);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/planner/chats/${chat.id}/history`,
      headers: authHeaders(t.cookie),
    });
    expect(res.statusCode).toBeLessThan(300);
    const row = t.db.prepare('SELECT memory_folded_turns AS n FROM planner_chats WHERE id = ?').get(chat.id) as { n: number };
    expect(row.n).toBe(0);
  });
});
