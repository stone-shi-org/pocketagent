import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { BROWSER_PROTOCOL_VERSION, type BrowserServerMessage } from '@pocketagent/protocol';
import { MCP_TOOLS } from '../src/mcp-server/tools.js';
import { authHeaders, createTestApp, waitFor, type TestApp } from './helpers.js';
import { startFakeChromium, type FakeChromium } from './helpers-browser.js';

/**
 * PA-178: the live browser view's routes, against a fake Chromium — who may
 * open it, that frames flow only while visible, that input reaches the page,
 * that the URL bar is http(s) only, and that nothing a person types or sees
 * is ever logged.
 */

const TYPED_SECRET = 'hunter2-correct-horse-PA178';

describe('live browser view (PA-178)', () => {
  let t: TestApp;
  let fake: FakeChromium;
  let baseUrl: string;
  let browserId: string;
  let logs: string;

  beforeEach(async () => {
    fake = await startFakeChromium();
    logs = '';
    const loggerStream = new Writable({
      write(chunk, _enc, cb) {
        logs += chunk.toString();
        cb();
      },
    });
    t = await createTestApp(
      { LOG_LEVEL: 'debug' },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loggerStream,
      undefined,
      undefined,
      undefined,
      { browserOptions: fake.options },
    );
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
    const workspaces = (
      await t.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(t.cookie) })
    ).json().workspaces as { id: string }[];
    browserId = `pocket-${workspaces[0]!.id}`;
  });

  afterEach(async () => {
    await t.cleanup();
    await fake.close();
  });

  interface Viewer {
    ws: WebSocket;
    messages: BrowserServerMessage[];
    send: (m: unknown) => void;
    frames: () => number;
  }

  function open(headers: Record<string, string> = { cookie: t.cookie }): Promise<Viewer> {
    const ws = new WebSocket(`${baseUrl}/api/browser/${browserId}/ws?v=${BROWSER_PROTOCOL_VERSION}`, { headers });
    const messages: BrowserServerMessage[] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as BrowserServerMessage));
    return new Promise((resolve, reject) => {
      ws.once('open', () =>
        resolve({
          ws,
          messages,
          send: (m) => ws.send(JSON.stringify(m)),
          frames: () => messages.filter((m) => m.type === 'frame').length,
        }),
      );
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  async function mintMcpToken(): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/mcp/tokens',
      headers: authHeaders(t.cookie),
      payload: { label: 'pa178', scopes: ['read', 'sessions', 'planner', 'admin'] },
    });
    return (res.json() as { token: string }).token;
  }

  it('lists the browsers of every Pocket Agent and project folder for a person', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/browsers', headers: authHeaders(t.cookie) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { available: boolean; browsers: { id: string; kind: string; state: string }[] };
    expect(body.available).toBe(true);
    expect(body.browsers.find((b) => b.id === browserId)).toMatchObject({ kind: 'pocket', state: 'stopped' });
    expect(body.browsers.some((b) => b.kind === 'project')).toBe(true);
  });

  it('refuses the REST routes and the viewer to an MCP token and to nobody', async () => {
    const token = await mintMcpToken();
    const bearer = { authorization: `Bearer ${token}` };
    for (const [method, url] of [
      ['GET', '/api/browsers'],
      ['POST', `/api/browsers/${browserId}/start`],
      ['POST', `/api/browsers/${browserId}/stop`],
      ['POST', `/api/browsers/${browserId}/clear-data`],
    ] as const) {
      expect((await t.app.inject({ method, url, headers: bearer })).statusCode, url).toBe(401);
      expect((await t.app.inject({ method, url })).statusCode, url).toBe(401);
    }
    await expect(open(bearer)).rejects.toThrow('HTTP 401');
    await expect(open({})).rejects.toThrow('HTTP 401');
    expect(fake.launches).toHaveLength(0);
  });

  it('offers no MCP tool that streams frames, sends input or answers a handoff', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.name, tool.name).not.toMatch(/browser|screencast|frame|input/i);
      for (const key of Object.keys(tool.input ?? {})) expect(key, `${tool.name}.${key}`).not.toMatch(/browser|cdp|helpId/i);
    }
  });

  it('starts the browser on open and streams frames only while the page is visible', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'hello'));
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    expect(fake.launches).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 250));
    expect(v.frames()).toBe(0);

    v.send({ type: 'visible', visible: true });
    await waitFor(() => v.frames() >= 2);
    // ≈10 fps at most: the fake sends a frame every 10 ms.
    const before = v.frames();
    await new Promise((r) => setTimeout(r, 500));
    expect(v.frames() - before).toBeLessThanOrEqual(7);

    v.send({ type: 'visible', visible: false });
    await waitFor(() => fake.commands.some((c) => c.method === 'Page.stopScreencast'));
    await new Promise((r) => setTimeout(r, 150));
    const stopped = v.frames();
    await new Promise((r) => setTimeout(r, 300));
    expect(v.frames()).toBe(stopped);
    v.ws.close();
  });

  it('fits the page to the viewer on its own session, and passes input straight through', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    v.send({ type: 'resize', width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
    v.send({ type: 'mouse', event: 'mousePressed', x: 10, y: 20 });
    v.send({ type: 'mouse', event: 'mouseReleased', x: 10, y: 20 });
    v.send({ type: 'insertText', text: TYPED_SECRET });
    v.send({ type: 'key', event: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' });
    await waitFor(() => fake.commands.some((c) => c.method === 'Input.dispatchKeyEvent'));

    const metrics = fake.commands.find((c) => c.method === 'Emulation.setDeviceMetricsOverride')!;
    expect(metrics.params).toMatchObject({ width: 390, height: 760, mobile: true });
    expect(metrics.sessionId).toBeTruthy();
    const press = fake.commands.find((c) => c.method === 'Input.dispatchMouseEvent')!;
    expect(press.params).toMatchObject({ type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 });
    expect(fake.commands.find((c) => c.method === 'Input.insertText')!.params).toEqual({ text: TYPED_SECRET });
    expect(fake.commands.find((c) => c.method === 'Input.dispatchKeyEvent')!.params).toMatchObject({ type: 'keyDown', text: '\r' });
    v.ws.close();
  });

  it('tells a phone when the tapped element takes typing, and keeps that field in view on a resize', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    fake.setEditable(true);
    v.send({ type: 'mouse', event: 'mousePressed', x: 10, y: 20 });
    v.send({ type: 'mouse', event: 'mouseReleased', x: 10, y: 20 });
    await waitFor(() => v.messages.some((m) => m.type === 'editable' && m.editable));
    const probes = (): string[] =>
      fake.commands.filter((c) => c.method === 'Runtime.evaluate').map((c) => String(c.params.expression));
    // A tap only asks; it never scrolls the page under the person's finger.
    expect(probes().at(-1)).toContain('ok && false');
    expect(fake.commands.some((c) => c.method === 'Runtime.enable')).toBe(false);

    // The keyboard opening shrinks the viewer: the field is scrolled back into view.
    v.send({ type: 'resize', width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
    v.send({ type: 'resize', width: 390, height: 400, deviceScaleFactor: 2, mobile: true });
    await waitFor(() => probes().some((p) => p.includes('ok && true')));
    // Growing back (the keyboard closing) leaves the person's scroll alone.
    const centred = probes().filter((p) => p.includes('ok && true')).length;
    v.send({ type: 'resize', width: 390, height: 760, deviceScaleFactor: 2, mobile: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(probes().filter((p) => p.includes('ok && true')).length).toBe(centred);

    fake.setEditable(false);
    v.send({ type: 'mouse', event: 'mouseReleased', x: 10, y: 300 });
    await waitFor(() => v.messages.at(-1)?.type === 'editable' && !(v.messages.at(-1) as { editable: boolean }).editable);
    v.ws.close();
  });

  it("suggests addresses from the browser's own history, for a person only", async () => {
    const dir = path.join(fake.dataDir, 'browser-profiles', browserId, 'Default');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'History'));
    db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR,
      visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL,
      last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`);
    const insert = db.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)');
    const now = 13_400_000_000_000_000;
    insert.run('https://docs.example.com/guide', 'Example docs', 2, 0, now, 0);
    insert.run('https://example.com/', 'Example Domain', 5, 3, now - 1000, 0);
    insert.run('https://login.example.com/hidden', 'Hidden', 9, 9, now, 1);
    insert.run('file:///etc/passwd', 'example local file', 9, 9, now, 0);
    insert.run('https://other.org/', 'Other', 1, 0, now, 0);
    db.close();

    const res = await t.app.inject({ method: 'GET', url: `/api/browsers/${browserId}/suggest?q=exa`, headers: authHeaders(t.cookie) });
    expect(res.statusCode).toBe(200);
    const urls = (res.json() as { suggestions: { url: string }[] }).suggestions.map((s) => s.url);
    // A host that starts with what was typed first; hidden rows and non-http(s) never.
    expect(urls).toEqual(['https://example.com/', 'https://docs.example.com/guide']);

    const token = await mintMcpToken();
    const refused = await t.app.inject({
      method: 'GET',
      url: `/api/browsers/${browserId}/suggest?q=exa`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/api/browsers/pocket-nope/suggest?q=x', headers: authHeaders(t.cookie) })).statusCode).toBe(404);
  });

  it('puts each folder\'s browser id and the running browsers on the home screen', async () => {
    const before = (await t.app.inject({ method: 'GET', url: '/api/projects', headers: authHeaders(t.cookie) })).json() as {
      projects: { browserId?: string | null }[];
      browsers?: { id: string; state: string }[];
    };
    expect(before.browsers).toEqual([]);
    for (const p of before.projects) expect(p.browserId).toMatch(/^project-[0-9a-f]{16}$/);

    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    const after = (await t.app.inject({ method: 'GET', url: '/api/projects', headers: authHeaders(t.cookie) })).json() as {
      browsers: { id: string; kind: string; state: string; pendingHelp: number }[];
    };
    expect(after.browsers).toEqual([expect.objectContaining({ id: browserId, kind: 'pocket', state: 'running', pendingHelp: 0 })]);
    v.ws.close();
  });

  it('opens only http(s) from the URL bar', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    v.send({ type: 'navigate', url: 'file:///etc/passwd' });
    v.send({ type: 'navigate', url: 'javascript:alert(1)' });
    v.send({ type: 'navigate', url: 'https://example.com/login' });
    await waitFor(() => fake.commands.some((c) => c.method === 'Page.navigate'));
    const navigations = fake.commands.filter((c) => c.method === 'Page.navigate').map((c) => c.params.url);
    expect(navigations).toEqual(['https://example.com/login']);
    expect(v.messages.filter((m) => m.type === 'error')).toHaveLength(2);
    v.ws.close();
  });

  it('tells the viewer when the agent navigates, but not when the viewer did', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    // Nobody in this viewer has acted yet: a navigation is the agent's.
    fake.navigateTarget('T1', 'https://agent.example/dashboard');
    await waitFor(() => v.messages.some((m) => m.type === 'agent-activity'));
    expect(v.messages.find((m) => m.type === 'agent-activity')).toMatchObject({ url: 'https://agent.example/dashboard' });
    // The viewer's own navigation is not flagged.
    v.send({ type: 'navigate', url: 'https://example.com/' });
    await waitFor(() => fake.commands.some((c) => c.method === 'Page.navigate'));
    await new Promise((r) => setTimeout(r, 100));
    expect(v.messages.filter((m) => m.type === 'agent-activity')).toHaveLength(1);
    v.ws.close();
  });

  it('relays a page dialog and answers it only when the person does', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    fake.openDialog('confirm', 'Leave?');
    await waitFor(() => v.messages.some((m) => m.type === 'dialog'));
    expect(v.messages.find((m) => m.type === 'dialog')).toMatchObject({ dialogType: 'confirm', message: 'Leave?' });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.commands.some((c) => c.method === 'Page.handleJavaScriptDialog')).toBe(false);
    v.send({ type: 'dialog-dismiss' });
    await waitFor(() => fake.commands.some((c) => c.method === 'Page.handleJavaScriptDialog'));
    expect(fake.commands.find((c) => c.method === 'Page.handleJavaScriptDialog')!.params).toEqual({ accept: false });
    v.ws.close();
  });

  it('never logs what a person typed or saw', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    v.send({ type: 'visible', visible: true });
    v.send({ type: 'insertText', text: TYPED_SECRET });
    v.send({ type: 'navigate', url: `https://example.com/?q=${TYPED_SECRET}` });
    await waitFor(() => v.frames() > 2 && fake.commands.some((c) => c.method === 'Page.navigate'));
    v.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(logs).toContain('browser viewer opened');
    expect(logs).not.toContain(TYPED_SECRET);
    // The JPEG magic in base64 — no frame reached the log.
    expect(logs).not.toContain('/9j/');
  });

  it('refuses to stop a browser an agent is waiting on, and clears data only once stopped', async () => {
    const v = await open();
    await waitFor(() => v.messages.some((m) => m.type === 'tabs'));
    const release = t.context.browsers.holdForHelp(browserId);
    const refused = await t.app.inject({ method: 'POST', url: `/api/browsers/${browserId}/stop`, headers: authHeaders(t.cookie) });
    expect(refused.statusCode).toBe(409);
    release();
    const clearWhileRunning = await t.app.inject({
      method: 'POST',
      url: `/api/browsers/${browserId}/clear-data`,
      headers: authHeaders(t.cookie),
    });
    expect(clearWhileRunning.statusCode).toBe(409);
    const stopped = await t.app.inject({ method: 'POST', url: `/api/browsers/${browserId}/stop`, headers: authHeaders(t.cookie) });
    expect(stopped.statusCode).toBe(200);
    await waitFor(() => v.messages.some((m) => m.type === 'closed'));
    const cleared = await t.app.inject({ method: 'POST', url: `/api/browsers/${browserId}/clear-data`, headers: authHeaders(t.cookie) });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ hasProfile: false });
  });
});
