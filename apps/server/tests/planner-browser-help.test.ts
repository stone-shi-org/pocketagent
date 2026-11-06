import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExecutable } from '../src/agents/registry.js';
import { PLANNER_TOOLS } from '../src/planner/tools.js';
import { authHeaders, createTestApp, waitFor, type TestApp } from './helpers.js';
import { startFakeChromium, type FakeChromium } from './helpers-browser.js';

/**
 * PA-178: `request_browser_help` — a Pocket Agent handing its shared browser
 * to a person. It parks the turn like an approval (no timeout, `busy`,
 * pending lists, a push deep-linked to the viewer) and resumes on Done or
 * Cancel; it can never be answered as an approval, and MCP cannot answer it.
 */

type Body = { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> };

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const reply = (content: string) => sse([{ choices: [{ delta: { content }, finish_reason: 'stop' }] }]);
const call = (name: string, args: unknown) =>
  sse([
    {
      choices: [
        {
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
  ]);

function scripted(responses: Array<() => Response>) {
  const bodies: Body[] = [];
  const fetchImpl = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return responses[Math.min(bodies.length - 1, responses.length - 1)]!();
  });
  return { fetchImpl, bodies };
}

function parseEvents(payload: string): Array<{ kind: string; [key: string]: unknown }> {
  return payload
    .split('\n\n')
    .map((c) => c.trim())
    .filter((c) => c.startsWith('data:'))
    .map((c) => JSON.parse(c.replace(/^data: /, '')));
}

describe('request_browser_help (PA-178)', () => {
  let t: TestApp;
  let fake: FakeChromium;
  afterEach(async () => {
    await t?.cleanup();
    await fake?.close();
  });

  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });

  async function setup(fetchImpl: ReturnType<typeof vi.fn>, withBrowser = true) {
    fake = await startFakeChromium();
    t = await createTestApp(
      {},
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      withBrowser ? { browserOptions: fake.options } : {},
    );
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://llm.example.com' },
    });
    return (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json() as { id: string; workspaceId: string };
  }

  async function parkedChat() {
    const llm = scripted([
      () => call('request_browser_help', { reason: 'Please sign in to the dashboard', url: 'https://example.com/login' }),
      () => reply('Signed in, thanks — continuing.'),
    ]);
    const chat = await setup(llm.fetchImpl);
    const events = parseEvents((await post(`/api/planner/chats/${chat.id}/messages`, { content: 'check my dashboard' })).payload);
    const request = events.find((e) => e.kind === 'browser_help_request')!;
    return { llm, chat, events, request, browserId: `pocket-${chat.workspaceId}` };
  }

  it('is offered only where a shared browser can exist', async () => {
    const llm = scripted([() => reply('hi')]);
    const chat = await setup(llm.fetchImpl, false);
    await post(`/api/planner/chats/${chat.id}/messages`, { content: 'hello' });
    const names = llm.bodies[0]!.tools!.map((x) => x.function.name);
    expect(names).not.toContain('request_browser_help');
    expect(names).not.toContain('browser_endpoint');
    expect(JSON.stringify(llm.bodies[0]!.messages[0])).not.toContain('request_browser_help');
    // Both are read-only: they ask, or report an endpoint; they change nothing.
    for (const name of ['request_browser_help', 'browser_endpoint']) {
      expect(PLANNER_TOOLS.find((x) => x.name === name)!.readOnly).toBe(true);
    }
  });

  it('parks the turn with no approval card, opens the page, and holds the browser', async () => {
    const { chat, events, request, browserId } = await parkedChat();
    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
    expect(request).toMatchObject({ browserId, reason: 'Please sign in to the dashboard', url: 'https://example.com/login' });
    expect(fake.commands.find((c) => c.method === 'Target.createTarget')!.params).toEqual({ url: 'https://example.com/login' });
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(true);
    expect(t.context.browsers.info(browserId)).toMatchObject({ state: 'running', pendingHelp: 1 });
    // No timeout: still parked, and the idle sweep leaves the browser alone.
    await t.context.browsers.runIdleSweep();
    expect(t.context.browsers.info(browserId)!.state).toBe('running');
    expect(t.context.plannerChats.pendingBrowserHelp()).toHaveLength(1);
    // The browser cannot be stopped from under the person being asked.
    expect((await post(`/api/browsers/${browserId}/stop`)).statusCode).toBe(409);
  });

  it('cannot be answered as an approval', async () => {
    const { chat, request } = await parkedChat();
    const res = await post(`/api/planner/chats/${chat.id}/approvals/${request.id}`, { decision: 'allow_once' });
    expect(res.statusCode).toBe(404);
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(true);
  });

  it('resumes on Done with the page the person left, and the turn finishes', async () => {
    const { llm, chat, request, browserId } = await parkedChat();
    const events = parseEvents((await post(`/api/planner/chats/${chat.id}/browser-help/${request.id}`, { outcome: 'done' })).payload);
    expect(events[0]).toMatchObject({ kind: 'browser_help_resolved', id: request.id, outcome: 'done' });
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain('pressed Done');
    expect(String(result.content)).toContain('https://example.com/login');
    expect(String(result.content)).toContain('playwright-cli attach --cdp=http://127.0.0.1:');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
    expect(llm.bodies).toHaveLength(2);
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(false);
    expect(t.context.browsers.info(browserId)!.pendingHelp).toBe(0);
    // A second answer finds nothing.
    expect((await post(`/api/planner/chats/${chat.id}/browser-help/${request.id}`, { outcome: 'done' })).statusCode).toBe(404);
  });

  it('resumes on Cancel with a refusal the model can act on', async () => {
    const { chat, request } = await parkedChat();
    const events = parseEvents((await post(`/api/planner/chats/${chat.id}/browser-help/${request.id}`, { outcome: 'cancel' })).payload);
    const result = events.find((e) => e.kind === 'tool_result')!;
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('Cancel');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete' });
  });

  it('can be answered from the viewer, which drives the rest of the turn itself', async () => {
    const { chat, request, browserId } = await parkedChat();
    const res = await post(`/api/browsers/${browserId}/help/${request.id}`, { outcome: 'done' });
    expect(res.statusCode).toBe(202);
    await waitFor(() => !t.context.plannerChats.isBusy(chat.id));
    const history = (await get(`/api/planner/chats/${chat.id}/history`)).json().events as Array<{ kind: string }>;
    expect(history.map((e) => e.kind)).toEqual(expect.arrayContaining(['browser_help_request', 'browser_help_resolved', 'turn_complete']));
  });

  it('is released by an interrupt, recorded as a cancel', async () => {
    const { chat, request, browserId } = await parkedChat();
    expect(await t.context.plannerChats.interrupt(chat.id)).toBe(true);
    expect(t.context.plannerChats.isBusy(chat.id)).toBe(false);
    expect(t.context.browsers.info(browserId)!.pendingHelp).toBe(0);
    const history = (await get(`/api/planner/chats/${chat.id}/history`)).json().events as Array<{ kind: string; [k: string]: unknown }>;
    expect(history.find((e) => e.kind === 'browser_help_resolved')).toMatchObject({ id: request.id, outcome: 'cancel' });
    expect(history.some((e) => e.kind === 'permission_resolved')).toBe(false);
  });

  it('is listed, read-only, for MCP clients and the attention snapshot, with the viewer link', async () => {
    const { chat, browserId } = await parkedChat();
    const pending = t.context.plannerChats.pendingBrowserHelp();
    expect(pending[0]).toMatchObject({ chatId: chat.id, browserId, reason: 'Please sign in to the dashboard' });
  });

  it('refuses a non-http(s) url without parking', async () => {
    const llm = scripted([() => call('request_browser_help', { reason: 'x', url: 'file:///etc/passwd' }), () => reply('ok')]);
    const chat = await setup(llm.fetchImpl);
    const events = parseEvents((await post(`/api/planner/chats/${chat.id}/messages`, { content: 'go' })).payload);
    expect(events.some((e) => e.kind === 'browser_help_request')).toBe(false);
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: true });
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete' });
  });

  it('browser_endpoint starts the browser and names its loopback endpoint', async () => {
    const llm = scripted([() => call('browser_endpoint', {}), () => reply('done')]);
    const chat = await setup(llm.fetchImpl);
    const events = parseEvents((await post(`/api/planner/chats/${chat.id}/messages`, { content: 'go' })).payload);
    const result = events.find((e) => e.kind === 'tool_result')!;
    const parsed = JSON.parse(String(result.content)) as { endpoint: string; attach: string };
    expect(parsed.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(parsed.attach).toBe(`playwright-cli attach --cdp=${parsed.endpoint}`);
    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    // The base prompt names the shared browser where it exists — with
    // playwright-cli to drive it, which only some hosts have.
    if (resolveExecutable('playwright-cli') !== null) {
      expect(JSON.stringify(llm.bodies[0]!.messages[0])).toContain('request_browser_help');
    }
  });
});
