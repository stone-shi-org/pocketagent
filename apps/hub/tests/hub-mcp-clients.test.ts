import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HUB_FLEET_TOOL_NAMES, HUB_FLEET_TOOL_SCOPES, HUB_MCP_SCOPES } from '@pocketagent/protocol';
import { authHeaders } from '../../server/tests/helpers.js';
import { backendTokens, callHub, connectHub, hubRequest, startFleet, type AnyClient, type Era, type Fleet } from './fleet-helpers.js';

/**
 * PA-169: Hub MCP client tokens — one MCP entry for a coding agent, held to
 * its scopes and host allowlist by the Hub itself.
 *
 * Two real backends behind a real Hub, and deliberately **no Fleet agent
 * enabled**: a client token must work on its own, so the per-host dispatch
 * token is minted on first use. Real SDK clients, both protocol eras.
 */

let fleet: Fleet;

beforeAll(async () => {
  fleet = await startFleet(['mac01', 'linux01']);
});

afterAll(async () => {
  await fleet.cleanup();
});

async function mint(body: Record<string, unknown>): Promise<{ id: string; token: string; client: Record<string, unknown> }> {
  const res = await hubRequest(fleet.hub, 'POST', '/api/hub/mcp/tokens', body);
  if (res.status !== 201) throw new Error(`mint failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.client.id, token: res.body.token, client: res.body.client };
}

async function pocketAgentOn(i: number): Promise<string> {
  const b = fleet.backends[i]!;
  const res = await b.app.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(b.app.cookie) });
  return (res.json() as { workspaces: { id: string; name: string }[] }).workspaces.find((w) => w.name === 'Pocket Agent')!.id;
}

describe('the token routes', () => {
  it('mints a client token shown once, lists it by prefix, and stores only a digest', async () => {
    const { id, token, client } = await mint({ label: 'laptop claude', scopes: ['read', 'dispatch'] });
    expect(token).toMatch(/^phm_/);
    expect(client).toMatchObject({ label: 'laptop claude', kind: 'client', scopes: ['read', 'dispatch'], hosts: null });
    const list = await hubRequest(fleet.hub, 'GET', '/api/hub/mcp/tokens');
    expect(list.status).toBe(200);
    expect(list.body.path).toBe('/mcp');
    expect(JSON.stringify(list.body)).not.toContain(token);
    expect(list.body.tokens.find((t: { id: string }) => t.id === id).tokenPrefix).toBe(token.slice(0, 12));
    const rows = fleet.hub.context.db.prepare('SELECT * FROM hub_mcp_tokens').all() as Record<string, unknown>[];
    expect(JSON.stringify(rows)).not.toContain(token);
    await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
  });

  it('refuses no scopes, an unknown scope, an unknown host and an empty host list', async () => {
    for (const body of [
      { label: 'x', scopes: [] },
      { label: 'x', scopes: ['sessions'] },
      { label: 'x', scopes: ['read'], hosts: ['nope01'] },
      { label: 'x', scopes: ['read'], hosts: [] },
      { label: '', scopes: ['read'] },
    ]) {
      const res = await hubRequest(fleet.hub, 'POST', '/api/hub/mcp/tokens', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('cannot be reached with a phm_ bearer: a token can never mint, widen or revoke a token', async () => {
    const { id, token } = await mint({ label: 'leaky', scopes: ['read', 'dispatch', 'admin'] });
    const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const post = await fetch(`${fleet.hub.baseUrl}/api/hub/mcp/tokens`, {
      method: 'POST',
      headers: bearer,
      body: JSON.stringify({ label: 'successor', scopes: ['read'] }),
    });
    expect(post.status).toBe(401);
    const patch = await fetch(`${fleet.hub.baseUrl}/api/hub/mcp/tokens/${id}`, {
      method: 'PATCH',
      headers: bearer,
      body: JSON.stringify({ hosts: null }),
    });
    expect(patch.status).toBe(401);
    const del = await fetch(`${fleet.hub.baseUrl}/api/hub/mcp/tokens/${id}`, { method: 'DELETE', headers: bearer });
    expect(del.status).toBe(401);
    expect((await fetch(`${fleet.hub.baseUrl}/api/hub/mcp/tokens`, { headers: bearer })).status).toBe(401);
    await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
  });

  it('lists a coordinator token with every scope and host, and refuses to edit or revoke it here', async () => {
    const coordinator = fleet.hub.context.mcpTokens.mint('fleet:coordinator');
    const principal = fleet.hub.context.mcpTokens.validate(coordinator.token);
    expect(principal).toMatchObject({ kind: 'coordinator', scopes: [...HUB_MCP_SCOPES], hosts: null });
    const list = await hubRequest(fleet.hub, 'GET', '/api/hub/mcp/tokens');
    expect(list.body.tokens.find((t: { id: string }) => t.id === coordinator.id)).toMatchObject({
      kind: 'coordinator',
      scopes: [...HUB_MCP_SCOPES],
      hosts: null,
    });
    expect((await hubRequest(fleet.hub, 'PATCH', `/api/hub/mcp/tokens/${coordinator.id}`, { hosts: ['mac01'] })).status).toBe(409);
    expect((await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${coordinator.id}`)).status).toBe(409);
    expect(fleet.hub.context.mcpTokens.get(coordinator.id)).not.toBeNull();
    fleet.hub.context.mcpTokens.revoke(coordinator.id);
  });

  it('fails closed on a client row whose JSON columns are unreadable', () => {
    const { id, token } = fleet.hub.context.mcpTokens.mintClient('broken', ['read'], ['mac01']);
    fleet.hub.context.db.prepare('UPDATE hub_mcp_tokens SET scopes_json = ?, hosts_json = ? WHERE id = ?').run('nope', '{', id);
    expect(fleet.hub.context.mcpTokens.validate(token)).toMatchObject({ kind: 'client', scopes: [], hosts: [] });
    fleet.hub.context.db.prepare('UPDATE hub_mcp_tokens SET scopes_json = NULL WHERE id = ?').run(id);
    expect(fleet.hub.context.mcpTokens.validate(token)).toMatchObject({ scopes: [] });
    fleet.hub.context.mcpTokens.revoke(id);
  });
});

for (const era of ['legacy', 'modern'] as Era[]) {
  describe(`a client token on /mcp [${era}]`, () => {
    it('read-only: the catalog is the read tools, and dispatch is not there to call', async () => {
      const { id, token } = await mint({ label: `read-${era}`, scopes: ['read'] });
      const client = await connectHub(fleet.hub, token, era);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(HUB_FLEET_TOOL_NAMES.filter((n) => HUB_FLEET_TOOL_SCOPES[n] === 'read'));
        const res = await client
          .callTool({ name: 'dispatch_pocket_task', arguments: { host: 'mac01', pocketAgentId: 'x', prompt: 'y' } })
          .then((r) => r.isError === true)
          .catch(() => true);
        expect(res).toBe(true);
        const hosts = await callHub(client, 'list_hosts');
        expect(hosts.data.hosts.map((h: { id: string }) => h.id).sort()).toEqual(['linux01', 'mac01']);
      } finally {
        await client.close().catch(() => undefined);
        await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
      }
    });

    it('limited to mac01: cannot see linux01, and is refused on it naming the host', async () => {
      const { id, token } = await mint({ label: `mac-${era}`, scopes: ['read', 'dispatch'], hosts: ['mac01'] });
      const client = await connectHub(fleet.hub, token, era);
      try {
        const listed = await callHub(client, 'list_hosts');
        expect(listed.data.hosts.map((h: { id: string }) => h.id)).toEqual(['mac01']);
        expect(listed.data.hosts[0].dispatch).toBe('ready');

        for (const [tool, args] of [
          ['get_host_capabilities', { host: 'linux01' }],
          ['dispatch_pocket_task', { host: 'linux01', pocketAgentId: 'x', prompt: 'y' }],
          ['dispatch_coding_task', { host: 'linux01', cwd: '/tmp', agent: 'claude', prompt: 'y' }],
          ['wait', { host: 'linux01', ref: 'chat:abc' }],
          ['fleet_versions', { hosts: ['mac01', 'linux01'] }],
        ] as const) {
          const res = await callHub(client, tool, args);
          expect(res.isError, tool).toBe(true);
          expect(res.text, tool).toContain('"linux01"');
        }
        // An unknown host reads exactly like a forbidden one.
        const unknown = await callHub(client, 'get_host_capabilities', { host: 'ghost01' });
        expect(unknown.text).toContain('may not reach host "ghost01"');

        // Fan-outs see only the allowed host.
        const versions = await callHub(client, 'fleet_versions');
        expect(versions.data.hosts.map((h: { host: string }) => h.host)).toEqual(['mac01']);
        const approvals = await callHub(client, 'list_pending_approvals');
        expect(approvals.data.unavailable).toEqual([]);
        expect(approvals.data.approvals.every((a: { host: string }) => a.host === 'mac01')).toBe(true);
      } finally {
        await client.close().catch(() => undefined);
        await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
      }
    });
  });
}

describe('dispatch with no Fleet agent enabled', () => {
  it('mints the scoped per-host dispatch token on first use and runs the task there', async () => {
    expect(fleet.hub.context.fleet.state().enabled).toBe(false);
    const { id, token } = await mint({ label: 'ci', scopes: ['read', 'dispatch'], hosts: ['mac01'] });
    const client = await connectHub(fleet.hub, token, 'legacy');
    try {
      const started = await callHub(client, 'dispatch_pocket_task', {
        host: 'mac01',
        pocketAgentId: await pocketAgentOn(0),
        prompt: 'build the iOS app',
      });
      expect(started.isError, started.text).toBe(false);
      expect(started.data.deepLink).toBe(`/#/h/mac01/planner/${started.data.chatId}`);
      let state = 'still_running';
      for (let i = 0; i < 20 && (state === 'still_running' || state === 'queued'); i += 1) {
        const waited = await callHub(client, 'wait', { host: 'mac01', ref: started.data.ref, timeoutSeconds: 5 });
        expect(waited.isError, waited.text).toBe(false);
        state = waited.data.state;
      }
      expect(state).toBe('complete');
      // Exactly the PA-134 dispatch token on mac01, never admin — and nothing on linux01.
      const macTokens = await backendTokens(fleet.backends[0]!.app);
      expect(macTokens.map((t) => t.label)).toEqual(['Hub fleet dispatch']);
      expect(macTokens[0]!.scopes).not.toContain('admin');
      expect(await backendTokens(fleet.backends[1]!.app)).toEqual([]);
    } finally {
      await client.close().catch(() => undefined);
      await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
    }
  });
});

describe('narrowing and revocation take effect on the next call, with no restart', () => {
  it('a narrowed host list and scope bite inside an open session; a revoked token is a 401', async () => {
    const { id, token } = await mint({ label: 'narrowed', scopes: ['read', 'dispatch'] });
    const client: AnyClient = await connectHub(fleet.hub, token, 'legacy');
    try {
      expect((await callHub(client, 'get_host_capabilities', { host: 'linux01' })).isError).toBe(false);

      const narrowHosts = await hubRequest(fleet.hub, 'PATCH', `/api/hub/mcp/tokens/${id}`, { hosts: ['mac01'] });
      expect(narrowHosts.status).toBe(200);
      expect(narrowHosts.body.client.hosts).toEqual(['mac01']);
      const refused = await callHub(client, 'get_host_capabilities', { host: 'linux01' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('"linux01"');
      expect((await callHub(client, 'list_hosts')).data.hosts.map((h: { id: string }) => h.id)).toEqual(['mac01']);

      // `wait` is still in this session's catalog; the scope check is per call.
      await hubRequest(fleet.hub, 'PATCH', `/api/hub/mcp/tokens/${id}`, { scopes: ['read'] });
      const noScope = await callHub(client, 'wait', { host: 'mac01', ref: 'chat:abc' });
      expect(noScope.isError).toBe(true);
      expect(noScope.text).toMatch(/needs the "dispatch" scope/);

      const del = await hubRequest(fleet.hub, 'DELETE', `/api/hub/mcp/tokens/${id}`);
      expect(del.status).toBe(204);
      expect(fleet.hub.context.mcpServer.openSessions()).toBe(0);
      const res = await fetch(`${fleet.hub.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});

describe('Phase 3: offering /mcp to the sessions on each backend', () => {
  it('hands each backend its own read+dispatch token, which works on /mcp, and withdraws it', async () => {
    const enabled = await hubRequest(fleet.hub, 'POST', '/api/hub/mcp/attach/enable', { hubUrl: fleet.hub.baseUrl });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
    expect(enabled.body.enabled).toBe(true);
    expect(enabled.body.hosts.map((h: { state: string }) => h.state)).toEqual(['attached', 'attached']);

    const tokens: string[] = [];
    for (const backend of fleet.backends) {
      const state = await backend.app.app.inject({ method: 'GET', url: '/api/fleet-mcp', headers: authHeaders(backend.app.cookie) });
      expect(state.json()).toMatchObject({ configured: true, url: `${fleet.hub.baseUrl}/mcp` });
      const credential = backend.app.context.fleetMcp.credential()!;
      expect(state.body).not.toContain(credential.token);
      tokens.push(credential.token);
      const principal = fleet.hub.context.mcpTokens.validate(credential.token)!;
      expect(principal).toMatchObject({ kind: 'client', scopes: ['read', 'dispatch'], hosts: null });
    }
    expect(new Set(tokens).size).toBe(2);
    // The backend's audit line names the Hub.
    expect(fleet.backends[0]!.logs.join('')).toContain('fleet mcp attach configured');

    const client = await connectHub(fleet.hub, tokens[0]!, 'legacy');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('update_webhook');
    expect((await callHub(client, 'list_hosts')).isError).toBe(false);
    await client.close().catch(() => undefined);

    const disabled = await hubRequest(fleet.hub, 'POST', '/api/hub/mcp/attach/disable');
    expect(disabled.body.enabled).toBe(false);
    for (const [i, backend] of fleet.backends.entries()) {
      expect(backend.app.context.fleetMcp.credential()).toBeNull();
      expect(fleet.hub.context.mcpTokens.validate(tokens[i]!)).toBeNull();
    }
  });
});
