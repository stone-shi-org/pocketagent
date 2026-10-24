import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import { openDatabase, readWebhookDelivery, readWebhookIssueSession, type Db } from '../src/db/index.js';
import { remoteBranchBase } from '../src/webhooks/index.js';
import { remoteCapRefusal } from '../src/runs/remote.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-171: a webhook mapping row that names another host, dispatched through
 * the Hub's `/mcp`.
 *
 * The Hub here is a *real* MCP server (the official SDK, over real HTTP)
 * serving the four tools a remote webhook run calls, each scripted per test —
 * so the client, its era negotiation and its error handling are exercised on
 * the wire, and what this server sends the Hub is observed rather than
 * assumed. The Hub's own side (scopes, host allowlists, the dispatch origin it
 * states to the target) is `apps/hub/tests/hub-webhook-routing.test.ts`, and
 * the two halves together against real processes are `pnpm demo:fleet`.
 */

const ENC_KEY = Buffer.alloc(32, 0x55).toString('base64');
const HUB_TOKEN = `phm_${'a'.repeat(40)}`;
const TIMINGS = { pollMs: 20, approvalPollMs: 20, maxBackoffMs: 40, maxRejections: 3 };

type ToolResult = Record<string, unknown> | Error;

interface FakeHub {
  url: string;
  calls: { name: string; args: Record<string, unknown> }[];
  /** Per-tool handler; return an `Error` to answer `isError`. */
  handlers: {
    dispatch_coding_task: (args: Record<string, unknown>) => ToolResult;
    dispatch_pocket_task: (args: Record<string, unknown>) => ToolResult;
    dispatch_prompt: (args: Record<string, unknown>) => ToolResult;
    wait: (args: Record<string, unknown>) => ToolResult;
  };
  /** Answer 401 to everything (a revoked token). */
  reject: boolean;
  close: () => Promise<void>;
}

async function startFakeHub(): Promise<FakeHub> {
  const hub: FakeHub = {
    url: '',
    calls: [],
    reject: false,
    handlers: {
      dispatch_coding_task: (args) => ({
        host: args.host,
        ref: 'session:remote-1',
        sessionId: 'remote-1',
        cwd: args.cwd,
        state: 'running',
        skipPermissionsEnabled: false,
      }),
      dispatch_pocket_task: (args) => ({ host: args.host, ref: 'chat:chat-1', chatId: 'chat-1', state: 'still_running' }),
      dispatch_prompt: (args) => ({ host: args.host, ref: args.ref, state: 'running' }),
      wait: (args) => ({ host: args.host, ref: args.ref, state: 'complete', isError: false }),
    },
    close: async () => undefined,
  };
  const build = (): McpServer => {
    const server = new McpServer({ name: 'fake-hub', version: '1.0.0' });
    const loose = { host: z.string() } as const;
    for (const name of ['dispatch_coding_task', 'dispatch_pocket_task', 'dispatch_prompt', 'wait'] as const) {
      server.registerTool(
        name,
        { description: name, inputSchema: { ...loose, ref: z.string().optional(), cwd: z.string().optional(), agent: z.string().optional(), prompt: z.string().optional(), title: z.string().optional(), worktree: z.string().optional(), model: z.string().optional(), branchBase: z.string().optional(), pocketAgentId: z.string().optional(), modelId: z.string().optional(), timeoutSeconds: z.number().optional() } },
        async (args: Record<string, unknown>) => {
          hub.calls.push({ name, args });
          const out = hub.handlers[name](args);
          if (out instanceof Error) return { isError: true, content: [{ type: 'text' as const, text: out.message }] };
          return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out };
        },
      );
    }
    return server;
  };
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = http.createServer((req, res) => {
    if (hub.reject || req.headers.authorization !== `Bearer ${HUB_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    const sessionHeader = req.headers['mcp-session-id'];
    const existing = typeof sessionHeader === 'string' ? transports.get(sessionHeader) : undefined;
    if (existing) {
      void existing.handleRequest(req, res);
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => {
      if (transport.sessionId) transports.delete(transport.sessionId);
    };
    void build()
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const { port } = httpServer.address() as AddressInfo;
  hub.url = `http://127.0.0.1:${port}/mcp`;
  hub.close = async () => {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  return hub;
}

let ctx: TestApp;
let hub: FakeHub;
let db: Db;

beforeEach(async () => {
  hub = await startFakeHub();
  db = openDatabase(':memory:');
  ctx = await createTestApp(
    { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
    db,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { remoteRunTimings: TIMINGS },
  );
});

afterEach(async () => {
  await ctx.cleanup();
  await hub.close();
});

const req = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, headers: authHeaders(ctx.cookie), ...(payload !== undefined ? { payload } : {}) });

async function enableRouting(hosts = [{ id: 'mac01', label: 'Mac 01' }]): Promise<void> {
  const res = await req('POST', '/api/webhook-routing', { url: hub.url, token: HUB_TOKEN, selfHostId: 'dev01', hosts });
  expect(res.statusCode, res.body).toBe(200);
}

async function createWebhook(over: Record<string, unknown> = {}): Promise<{ id: string; slug: string; secret: string }> {
  const res = await req('POST', '/api/webhooks', {
    name: 'Triage',
    slug: 'triage',
    cwd: ctx.projectDir,
    agent: 'claude',
    overlapPolicy: 'allow',
    config: {
      type: 'jira',
      filter: {},
      projectMap: [
        { projectKey: 'PA', cwd: ctx.projectDir },
        { projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac01' },
      ],
    },
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  return { id: body.webhook.id, slug: body.webhook.slug, secret: body.secret };
}

function payloadFor(issueKey: string, over: Record<string, unknown> = {}): string {
  const sample = structuredClone(JIRA_SAMPLE_PAYLOAD) as Record<string, unknown> & {
    issue: { key: string; fields: { project: { key: string } } };
  };
  sample.issue.key = issueKey;
  sample.issue.fields.project.key = issueKey.split('-')[0] as string;
  return JSON.stringify({ ...sample, timestamp: Date.now(), ...over });
}

function deliver(slug: string, secret: string, body: string) {
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  return ctx.app.inject({
    method: 'POST',
    url: `/api/hooks/${slug}`,
    headers: { 'content-type': 'application/json', 'x-hub-signature': signature },
    payload: body,
  });
}

async function deliveries(id: string): Promise<Record<string, unknown>[]> {
  const res = await req('GET', `/api/webhooks/${id}/deliveries?noise=true`);
  return res.json().deliveries as Record<string, unknown>[];
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function deliveryFor(id: string, issueKey: string, pred: (d: Record<string, unknown>) => boolean) {
  return waitFor(async () => (await deliveries(id)).find((d) => d.issueKey === issueKey && pred(d)));
}

// ---------------------------------------------------------------------------

describe('webhook routing store (PA-171)', () => {
  it('stores the token encrypted, never returns it, and drops this server from its own target list', async () => {
    await enableRouting([
      { id: 'mac01', label: 'Mac 01' },
      { id: 'dev01', label: 'Dev 01' },
    ]);
    const state = (await req('GET', '/api/webhook-routing')).json();
    expect(state.configured).toBe(true);
    expect(state.tokenPrefix).toBe(HUB_TOKEN.slice(0, 12));
    expect(JSON.stringify(state)).not.toContain(HUB_TOKEN);
    expect(state.hosts).toEqual([{ id: 'mac01', label: 'Mac 01' }]);
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'webhook_routing_token_enc'").get() as { value: string };
    expect(stored.value).not.toContain(HUB_TOKEN);
  });

  it('is unavailable, not plaintext, without an encryption key', async () => {
    const plain = await createTestApp({});
    try {
      const res = await plain.app.inject({
        method: 'POST',
        url: '/api/webhook-routing',
        headers: authHeaders(plain.cookie),
        payload: { url: hub.url, token: HUB_TOKEN, selfHostId: 'dev01', hosts: [] },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('encryption_unavailable');
    } finally {
      await plain.cleanup();
    }
  });
});

describe('remote mapping rows: validation (PA-171)', () => {
  it('refuses a host this server was not given, and accepts one it was', async () => {
    const refused = await req('POST', '/api/webhooks', {
      name: 'x',
      cwd: ctx.projectDir,
      agent: 'claude',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac01' }] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('remote_host_not_allowed');

    await enableRouting();
    const { id } = await createWebhook();
    const webhook = (await req('GET', `/api/webhooks/${id}`)).json();
    expect(webhook.config.projectMap).toEqual([
      { projectKey: 'PA', cwd: expect.any(String) },
      { projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac01' },
    ]);
  });

  it('wants an absolute path on the remote host, and refuses current-branch there', async () => {
    await enableRouting();
    const relative = await req('POST', '/api/webhooks', {
      name: 'x',
      cwd: ctx.projectDir,
      agent: 'claude',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: 'srv/xy', hostId: 'mac01' }] },
    });
    expect(relative.statusCode).toBe(400);
    const currentBranch = await req('POST', '/api/webhooks', {
      name: 'y',
      cwd: ctx.projectDir,
      agent: 'claude',
      worktreeMode: 'current-branch',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac01' }] },
    });
    expect(currentBranch.statusCode).toBe(400);
    expect(currentBranch.json().error.code).toBe('remote_worktree_mode');
  });

  it('treats a row naming this server itself as local, containment check included', async () => {
    await enableRouting();
    const res = await req('POST', '/api/webhooks', {
      name: 'x',
      cwd: ctx.projectDir,
      agent: 'claude',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: '/etc', hostId: 'dev01' }] },
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it('skips the local agent check only when every target is remote', async () => {
    await enableRouting();
    const allRemote = await req('POST', '/api/webhooks', {
      name: 'remote-only',
      cwd: '/srv/xy',
      hostId: 'mac01',
      agent: 'some-agent-only-mac01-has',
      config: { type: 'jira', filter: {} },
    });
    expect(allRemote.statusCode, allRemote.body).toBe(201);
    expect(allRemote.json().webhook.hostId).toBe('mac01');
    const mixed = await req('POST', '/api/webhooks', {
      name: 'mixed',
      cwd: ctx.projectDir,
      agent: 'some-agent-only-mac01-has',
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac01' }] },
    });
    expect(mixed.statusCode).toBe(400);
  });
});

describe('remote runs (PA-171)', () => {
  it('dispatches a remote row through the Hub and settles when the target completes', async () => {
    await enableRouting();
    let waits = 0;
    hub.handlers.wait = (args) => {
      waits += 1;
      return { host: args.host, ref: args.ref, state: waits < 3 ? 'still_running' : 'complete' };
    };
    const { id, slug, secret } = await createWebhook({ skipPermissions: true, worktreeMode: 'new-branch' });
    const res = await deliver(slug, secret, payloadFor('XY-7'));
    expect(res.statusCode).toBe(202);

    const done = await deliveryFor(id, 'XY-7', (d) => d.status === 'succeeded');
    expect(done.remoteHostId).toBe('mac01');
    expect(done.remoteRef).toBe('session:remote-1');
    expect(done.sessionId).toBe('remote-1');
    expect(done.remoteState).toBeNull();
    // The webhook's own toggle never crosses: only the target's answer counts.
    expect(done.skipPermissionsEnabled).toBe(false);

    const dispatch = hub.calls.find((c) => c.name === 'dispatch_coding_task');
    expect(dispatch?.args).toMatchObject({
      host: 'mac01',
      cwd: '/srv/xy',
      agent: 'claude',
      worktree: 'new-branch',
      title: 'Triage · XY-7',
      branchBase: remoteBranchBase('Triage', 'XY-7'),
    });
    expect(String(dispatch?.args.prompt)).toContain('XY-7');
    expect(Object.keys(dispatch?.args ?? {})).not.toContain('skipPermissions');
  });

  it('runs a local row here and a remote row there, from one webhook', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook();
    await deliver(slug, secret, payloadFor('PA-1'));
    await deliver(slug, secret, payloadFor('XY-1'));
    const local = await deliveryFor(id, 'PA-1', (d) => d.sessionId !== null || d.status === 'failed');
    expect(local.remoteHostId).toBeNull();
    expect(hub.calls.filter((c) => c.name.startsWith('dispatch_')).map((c) => c.args.cwd)).toEqual(['/srv/xy']);
    const remote = await deliveryFor(id, 'XY-1', (d) => d.status === 'succeeded');
    expect(remote.remoteHostId).toBe('mac01');
  });

  it('records what the target started the run with, not what the webhook asked for', async () => {
    await enableRouting();
    hub.handlers.dispatch_coding_task = (args) => ({
      host: args.host,
      ref: 'session:remote-1',
      sessionId: 'remote-1',
      state: 'running',
      skipPermissionsEnabled: true,
    });
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: 'still_running' });
    const { id, slug, secret } = await createWebhook();
    await deliver(slug, secret, payloadFor('XY-2'));
    const running = await deliveryFor(id, 'XY-2', (d) => d.remoteRef !== null);
    expect(running.skipPermissionsEnabled).toBe(true);
  });

  it('keeps a delivery running while the target waits on an approval, with no timeout', async () => {
    await enableRouting();
    let answered = false;
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: answered ? 'complete' : 'awaiting_approval' });
    const { id, slug, secret } = await createWebhook();
    await deliver(slug, secret, payloadFor('XY-3'));
    const parked = await deliveryFor(id, 'XY-3', (d) => d.remoteState === 'awaiting_approval');
    expect(parked.status).toBe('running');
    // Many polls later, still parked: nothing decays into a failure.
    const before = hub.calls.filter((c) => c.name === 'wait').length;
    await waitFor(() => hub.calls.filter((c) => c.name === 'wait').length > before + 5);
    expect((await deliveries(id)).find((d) => d.issueKey === 'XY-3')?.status).toBe('running');
    answered = true;
    await deliveryFor(id, 'XY-3', (d) => d.status === 'succeeded');
  });

  it('shows queued (remote) while the target queues it, and fails an ended session', async () => {
    await enableRouting();
    let ended = false;
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: ended ? 'ended' : 'queued' });
    const { id, slug, secret } = await createWebhook();
    await deliver(slug, secret, payloadFor('XY-4'));
    await deliveryFor(id, 'XY-4', (d) => d.remoteState === 'queued');
    ended = true;
    const failed = await deliveryFor(id, 'XY-4', (d) => d.status === 'failed');
    expect(failed.error).toMatch(/session on mac01 ended/);
  });

  it('gives each failure its own reason, never falls back to a local folder, and lets a human retry', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook();
    const reasons: string[] = [];

    hub.handlers.dispatch_coding_task = () => new Error('mac01 cannot be dispatched to: it is offline.');
    await deliver(slug, secret, payloadFor('XY-10'));
    reasons.push(String((await deliveryFor(id, 'XY-10', (d) => d.status === 'failed')).error));

    hub.handlers.dispatch_coding_task = () =>
      new Error('start_session failed: /srv/xy is not inside any project folder on this host.');
    await deliver(slug, secret, payloadFor('XY-11'));
    reasons.push(String((await deliveryFor(id, 'XY-11', (d) => d.status === 'failed')).error));

    hub.reject = true;
    await deliver(slug, secret, payloadFor('XY-12'));
    reasons.push(String((await deliveryFor(id, 'XY-12', (d) => d.status === 'failed')).error));
    hub.reject = false;

    await hub.close();
    await deliver(slug, secret, payloadFor('XY-13'));
    reasons.push(String((await deliveryFor(id, 'XY-13', (d) => d.status === 'failed')).error));

    expect(reasons[0]).toMatch(/^mac01: .*offline/);
    expect(reasons[1]).toMatch(/^mac01: .*not inside any project folder/);
    expect(reasons[2]).toMatch(/rejected .*401/);
    expect(reasons[3]).toMatch(/unreachable/);
    expect(new Set(reasons).size).toBe(4);

    const all = await deliveries(id);
    for (const key of ['XY-10', 'XY-11', 'XY-12', 'XY-13']) {
      const row = all.find((d) => d.issueKey === key);
      expect(row?.retryProblem, key).toBeNull();
      expect(row?.sessionId, key).toBeNull();
    }
    // No local session was ever made for an XY issue.
    const sessions = (await req('GET', '/api/sessions')).json() as { cwd: string }[] | { sessions: { cwd: string }[] };
    const list = Array.isArray(sessions) ? sessions : sessions.sessions;
    expect(list.filter((s) => s.cwd.includes('xy'))).toEqual([]);
  });

  it('fails with a reason when routing is not set up, rather than running locally', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook();
    await req('DELETE', '/api/webhook-routing');
    await deliver(slug, secret, payloadFor('XY-20'));
    const failed = await deliveryFor(id, 'XY-20', (d) => d.status === 'failed');
    expect(failed.error).toMatch(/not set up on this server/);
    expect(hub.calls).toEqual([]);
  });

  it('records a cap refusal as throttled, answered 2xx and retryable', async () => {
    await enableRouting();
    hub.handlers.dispatch_coding_task = () =>
      new Error('This MCP client already has 3 live sessions. Stop one (stop_session) before starting another.');
    const { id, slug, secret } = await createWebhook();
    const res = await deliver(slug, secret, payloadFor('XY-30'));
    expect(res.statusCode).toBe(202);
    const throttled = await deliveryFor(id, 'XY-30', (d) => d.status === 'throttled');
    expect(throttled.retryProblem).toBeNull();
    expect(remoteCapRefusal('The Hub already has 3 dispatch or wait calls in flight to mac01.')).toBe(true);
    expect(remoteCapRefusal('mac01 is offline')).toBe(false);
  });

  it('counts a remote run against its own webhook cap', async () => {
    await enableRouting();
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: 'still_running' });
    const { id, slug, secret } = await createWebhook({ maxConcurrent: 1 });
    await deliver(slug, secret, payloadFor('XY-40'));
    await deliveryFor(id, 'XY-40', (d) => d.remoteRef !== null);
    await deliver(slug, secret, payloadFor('XY-41'));
    const second = await deliveryFor(id, 'XY-41', (d) => d.status === 'throttled');
    expect(second.reason).toMatch(/limit 1/);
  });

  it('takes no local directory-queue key for a remote run', async () => {
    await enableRouting();
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: 'still_running' });
    let n = 0;
    hub.handlers.dispatch_coding_task = (args) => {
      n += 1;
      return { host: args.host, ref: `session:r${n}`, sessionId: `r${n}`, state: 'running' };
    };
    const { id, slug, secret } = await createWebhook({ directoryPolicy: 'queue', maxConcurrent: 5 });
    await deliver(slug, secret, payloadFor('XY-50'));
    await deliver(slug, secret, payloadFor('XY-51'));
    await deliveryFor(id, 'XY-51', (d) => d.remoteRef !== null);
    const rows = (await deliveries(id)).filter((d) => String(d.issueKey).startsWith('XY-5'));
    expect(rows.every((d) => d.status === 'running' && d.queueKey === null)).toBe(true);
  });

  it('dispatches a pocket: agent on the target as a Pocket Agent task', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook({
      agent: 'pocket:remote-agent',
      cwd: '/srv/xy',
      hostId: 'mac01',
      config: { type: 'jira', filter: {} },
    });
    await deliver(slug, secret, payloadFor('XY-60'));
    const done = await deliveryFor(id, 'XY-60', (d) => d.status === 'succeeded');
    expect(done.remoteRef).toBe('chat:chat-1');
    expect(done.plannerChatId).toBe('chat-1');
    expect(hub.calls.find((c) => c.name === 'dispatch_pocket_task')?.args).toMatchObject({
      host: 'mac01',
      pocketAgentId: 'remote-agent',
    });
  });
});

describe('remote per-issue conversations (PA-171 × PA-26)', () => {
  it('prompts the same remote session on the next delivery for the issue', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook({ conversationMode: 'per-issue' });
    await deliver(slug, secret, payloadFor('XY-70'));
    await deliveryFor(id, 'XY-70', (d) => d.status === 'succeeded');
    const cached = readWebhookIssueSession(db, id, 'XY-70');
    expect(cached?.host_id).toBe('mac01');
    expect(cached?.session_id).toBe('remote-1');

    hub.handlers.dispatch_prompt = (args) => ({ host: args.host, ref: 'session:remote-2', sessionId: 'remote-2', state: 'running' });
    await deliver(slug, secret, payloadFor('XY-70', { changelog: { items: [{ field: 'status' }] } }));
    await waitFor(() => hub.calls.some((c) => c.name === 'dispatch_prompt'));
    expect(hub.calls.find((c) => c.name === 'dispatch_prompt')?.args).toMatchObject({ host: 'mac01', ref: 'session:remote-1' });
    expect(hub.calls.filter((c) => c.name === 'dispatch_coding_task')).toHaveLength(1);
    // A resumed session's new id becomes the issue's conversation.
    await waitFor(() => readWebhookIssueSession(db, id, 'XY-70')?.session_id === 'remote-2');
  });

  it('starts fresh when the remote session is gone', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook({ conversationMode: 'per-issue' });
    await deliver(slug, secret, payloadFor('XY-71'));
    await deliveryFor(id, 'XY-71', (d) => d.status === 'succeeded');
    hub.handlers.dispatch_prompt = () => new Error('send_prompt failed: No session remote-1.');
    await deliver(slug, secret, payloadFor('XY-71', { changelog: { items: [{ field: 'labels' }] } }));
    await waitFor(() => hub.calls.filter((c) => c.name === 'dispatch_coding_task').length === 2);
  });

  it('starts fresh, and forgets the old row, when the issue moves to another host', async () => {
    await enableRouting([
      { id: 'mac01', label: 'Mac 01' },
      { id: 'mac02', label: 'Mac 02' },
    ]);
    const { id, slug, secret } = await createWebhook({ conversationMode: 'per-issue' });
    await deliver(slug, secret, payloadFor('XY-72'));
    await deliveryFor(id, 'XY-72', (d) => d.status === 'succeeded');
    const patch = await req('PATCH', `/api/webhooks/${id}`, {
      config: { type: 'jira', filter: {}, projectMap: [{ projectKey: 'XY', cwd: '/srv/xy', hostId: 'mac02' }] },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    await deliver(slug, secret, payloadFor('XY-72', { changelog: { items: [{ field: 'summary' }] } }));
    await waitFor(() => hub.calls.filter((c) => c.name === 'dispatch_coding_task').length === 2);
    expect(hub.calls.filter((c) => c.name === 'dispatch_prompt')).toEqual([]);
    expect(hub.calls.filter((c) => c.name === 'dispatch_coding_task')[1]?.args.host).toBe('mac02');
    await waitFor(() => readWebhookIssueSession(db, id, 'XY-72')?.host_id === 'mac02');
  });

  it('never follows up a local conversation (a row with no host) on a remote host', async () => {
    await enableRouting();
    const { id, slug, secret } = await createWebhook({ conversationMode: 'per-issue' });
    // What every row written before PA-171 looks like: no host, so this server.
    db.prepare(
      `INSERT INTO webhook_issue_sessions (webhook_id, issue_key, agent_session_id, session_id, planner_chat_id, agent, cwd, created_at, updated_at)
       VALUES (?, 'XY-73', 'conv-1', 'local-session', NULL, 'claude', '/srv/xy', 1, 1)`,
    ).run(id);
    await deliver(slug, secret, payloadFor('XY-73'));
    await deliveryFor(id, 'XY-73', (d) => d.status === 'succeeded');
    expect(hub.calls.filter((c) => c.name === 'dispatch_prompt')).toEqual([]);
    expect(hub.calls.filter((c) => c.name === 'dispatch_coding_task')).toHaveLength(1);
    const row = readWebhookIssueSession(db, id, 'XY-73');
    expect(row?.host_id).toBe('mac01');
    expect(row?.agent_session_id).toBeNull();
  });
});

describe('remote runs survive a restart (PA-171)', () => {
  it('resumes waiting from the stored ref instead of failing the row', async () => {
    await enableRouting();
    let finish = false;
    hub.handlers.wait = (args) => ({ host: args.host, ref: args.ref, state: finish ? 'complete' : 'still_running' });
    const { id, slug, secret } = await createWebhook();
    await deliver(slug, secret, payloadFor('XY-80'));
    const running = await deliveryFor(id, 'XY-80', (d) => d.remoteRef !== null);
    const deliveryId = String(running.id);

    // Close the app but keep the database: what a restart leaves behind.
    await ctx.app.close();
    expect(readWebhookDelivery(db, deliveryId)?.status).toBe('running');
    ctx = await createTestApp(
      { POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY },
      db,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { remoteRunTimings: TIMINGS },
    );
    expect(readWebhookDelivery(db, deliveryId)?.status).toBe('running');
    finish = true;
    await waitFor(() => readWebhookDelivery(db, deliveryId)?.status === 'succeeded');
  });
});
