import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JIRA_SAMPLE_PAYLOAD } from '@pocketagent/protocol';
import { authHeaders } from '../../server/tests/helpers.js';
import { callHub, connectHub, hubRequest, startFleet, type Fleet } from './fleet-helpers.js';

/**
 * PA-171: one backend's webhook routing its runs to another host, through a
 * real Hub — two real backends, the Hub's real `/mcp`, the source's real
 * `HubDispatchClient`, the target's real `start_session` / Pocket Agent chat.
 *
 * The Claude SDK is mocked (both backends run in this process) so a coding
 * session on the target exists without a model; a Pocket Agent's LLM is the
 * fleet helpers' scripted fetch.
 */

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: `conv-${crypto.randomUUID()}` };
      await new Promise(() => {});
    },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    applyFlagSettings: async () => {},
  }),
}));

let fleet: Fleet;
const source = () => fleet.backends[0]!; // dev01 — receives the Jira webhook
const target = () => fleet.backends[1]!; // mac01 — runs the work

beforeAll(async () => {
  fleet = await startFleet(['dev01', 'mac01'], {
    remoteRunTimings: { pollMs: 25, approvalPollMs: 25, maxBackoffMs: 50, maxRejections: 3 },
  });
});

afterAll(async () => {
  await fleet.cleanup();
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function enable(allowedHosts = ['mac01']) {
  const res = await hubRequest(fleet.hub, 'PUT', '/api/hub/webhook-routing/dev01', {
    hubUrl: fleet.hub.baseUrl,
    allowedHosts,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

function webhookToken() {
  const row = fleet.hub.context.db.prepare("SELECT * FROM hub_mcp_tokens WHERE kind = 'webhook'").get() as
    | { id: string; scopes_json: string; hosts_json: string }
    | undefined;
  return row ?? null;
}

describe('turning webhook routing on for a backend', () => {
  it('mints a dispatch-only webhook token limited to the allowed hosts and hands it over once', async () => {
    const state = await enable();
    expect(state.hosts.find((h: { hostId: string }) => h.hostId === 'dev01')).toMatchObject({
      state: 'routed',
      allowedHosts: ['mac01'],
    });
    const row = webhookToken();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.scopes_json)).toEqual(['dispatch']);
    expect(JSON.parse(row!.hosts_json)).toEqual(['mac01']);

    const backendState = (
      await source().app.app.inject({ method: 'GET', url: '/api/webhook-routing', headers: authHeaders(source().app.cookie) })
    ).json();
    expect(backendState).toMatchObject({
      configured: true,
      url: `${fleet.hub.baseUrl}/mcp`,
      selfHostId: 'dev01',
      hosts: [{ id: 'mac01', label: 'mac01' }],
    });
  });

  it('refuses an empty allowlist and an unknown host', async () => {
    expect((await hubRequest(fleet.hub, 'PUT', '/api/hub/webhook-routing/dev01', { hubUrl: fleet.hub.baseUrl, allowedHosts: [] })).status).toBe(400);
    expect(
      (await hubRequest(fleet.hub, 'PUT', '/api/hub/webhook-routing/dev01', { hubUrl: fleet.hub.baseUrl, allowedHosts: ['nope01'] })).status,
    ).toBe(400);
  });

  it('is not editable or revocable from the MCP clients card', async () => {
    await enable();
    const row = webhookToken()!;
    expect((await hubRequest(fleet.hub, 'PATCH', `/api/hub/mcp/tokens/${row.id}`, { hosts: null })).status).toBe(409);
    expect((await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${row.id}`)).status).toBe(409);
  });
});

describe('a webhook token on the Hub /mcp', () => {
  it('can dispatch only, and only to its allowed hosts', async () => {
    await enable();
    const credential = source().app.context.webhookRouting.credential()!;
    const client = await connectHub(fleet.hub, credential.token, 'modern');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['dispatch_coding_task', 'dispatch_pocket_task', 'dispatch_prompt', 'wait']);
      const refused = await callHub(client, 'dispatch_coding_task', { host: 'dev01', cwd: '/tmp', agent: 'claude', prompt: 'x' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/may not reach host "dev01"/);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  it('carries a webhook origin the target honours only with its own switch on', async () => {
    await enable();
    const credential = source().app.context.webhookRouting.credential()!;
    const client = await connectHub(fleet.hub, credential.token, 'legacy');
    const start = async () => {
      const res = await callHub(client, 'dispatch_coding_task', {
        host: 'mac01',
        cwd: target().app.projectDir,
        agent: 'claude',
        prompt: 'hi',
      });
      expect(res.isError, res.text).toBe(false);
      return target().app.context.sessions.find(res.data.sessionId as string);
    };
    try {
      expect((await start())?.skipPermissionsEnabled).toBe(false);
      const on = await target().app.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: authHeaders(target().app.cookie),
        payload: { webhookDispatchSkipApprovals: true },
      });
      expect(on.statusCode).toBe(200);
      expect((await start())?.skipPermissionsEnabled).toBe(true);
      // The target's log names the source, so the bypass is on its own record.
      expect(target().logs.join('')).toMatch(/webhook run dispatched through the Hub skips approvals[^\n]*|"sourceHostId":"dev01"/);
    } finally {
      await target().app.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: authHeaders(target().app.cookie),
        payload: { webhookDispatchSkipApprovals: false },
      });
      for (const s of target().app.context.sessions.list()) {
        try {
          target().app.context.sessions.terminate(s.id);
        } catch {
          /* already gone */
        }
      }
      await client.close().catch(() => undefined);
    }
  });

  it('carries no origin for an ordinary client token, so the switch does not apply to it', async () => {
    await target().app.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: authHeaders(target().app.cookie),
      payload: { webhookDispatchSkipApprovals: true },
    });
    const minted = await hubRequest(fleet.hub, 'POST', '/api/hub/mcp/tokens', { label: 'coding agent', scopes: ['dispatch'] });
    const client = await connectHub(fleet.hub, minted.body.token, 'legacy');
    try {
      const res = await callHub(client, 'dispatch_coding_task', { host: 'mac01', cwd: target().app.projectDir, agent: 'claude', prompt: 'hi' });
      expect(res.isError, res.text).toBe(false);
      expect(target().app.context.sessions.find(res.data.sessionId as string)?.skipPermissionsEnabled).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${minted.body.client.id}`);
      await target().app.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: authHeaders(target().app.cookie),
        payload: { webhookDispatchSkipApprovals: false },
      });
    }
  });
});

describe('a target dispatch token minted before PA-171', () => {
  it('is replaced when routing is saved, so the origin counts; a current one is kept', async () => {
    await enable();
    const before = fleet.hub.context.registry.getRow('mac01')!.mcp_client_id!;
    // What an upgrade leaves behind: the backend cannot tell who minted it.
    target().app.db.prepare('UPDATE mcp_client_tokens SET minted_by_hub_id = NULL WHERE id = ?').run(before);
    await enable();
    const after = fleet.hub.context.registry.getRow('mac01')!.mcp_client_id!;
    expect(after).not.toBe(before);
    const row = target().app.db.prepare('SELECT minted_by_hub_id FROM mcp_client_tokens WHERE id = ?').get(after) as {
      minted_by_hub_id: string | null;
    };
    expect(row.minted_by_hub_id).not.toBeNull();
    await enable();
    expect(fleet.hub.context.registry.getRow('mac01')!.mcp_client_id).toBe(after);
  });
});

describe('a signed Jira delivery routed to the second backend', () => {
  it('runs on mac01, links there, and settles when its turn completes', async () => {
    await enable();
    const pocketAgents = (
      await target().app.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(target().app.cookie) })
    ).json() as { workspaces: { id: string; name: string }[] };
    const pocketId = pocketAgents.workspaces[0]!.id;

    const created = await source().app.app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: authHeaders(source().app.cookie),
      payload: {
        name: 'Routed',
        slug: 'routed',
        cwd: source().app.projectDir,
        agent: `pocket:${pocketId}`,
        config: { type: 'jira', filter: {} },
        hostId: 'mac01',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { webhook, secret } = created.json();

    const sample = structuredClone(JIRA_SAMPLE_PAYLOAD) as Record<string, unknown>;
    const body = JSON.stringify({ ...sample, timestamp: Date.now() });
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
    const res = await fetch(`${source().url}/api/hooks/routed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature': signature },
      body,
    });
    expect(res.status).toBe(202);

    const settled = await waitFor(async () => {
      const list = await source().app.app.inject({
        method: 'GET',
        url: `/api/webhooks/${webhook.id}/deliveries`,
        headers: authHeaders(source().app.cookie),
      });
      const d = (list.json().deliveries as Record<string, unknown>[])[0];
      return d && d.status !== 'running' && d.status !== 'starting' ? d : null;
    });
    expect(settled).toMatchObject({ status: 'succeeded', remoteHostId: 'mac01' });
    expect(String(settled.remoteRef)).toMatch(/^chat:/);
    // The chat really is on mac01, and not on dev01.
    expect(target().app.context.plannerChats.get(String(settled.plannerChatId))).toBeTruthy();
    expect(source().app.context.plannerChats.get(String(settled.plannerChatId))).toBeFalsy();
  });
});

describe('turning it off', () => {
  it('revokes the token on the Hub and clears the backend', async () => {
    await enable();
    const before = webhookToken()!;
    const res = await hubRequest(fleet.hub, 'DELETE', '/api/hub/webhook-routing/dev01');
    expect(res.status).toBe(200);
    expect(fleet.hub.context.mcpTokens.get(before.id)).toBeNull();
    expect(source().app.context.webhookRouting.state().configured).toBe(false);
  });
});
