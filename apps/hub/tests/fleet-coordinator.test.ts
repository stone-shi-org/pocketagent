import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_AGENT_NAME,
  FLEET_REGISTRY_NAME,
  HUB_FLEET_BACKEND_SCOPES,
  HUB_FLEET_TOOL_NAMES,
} from '@pocketagent/protocol';
import { authHeaders } from '../../server/tests/helpers.js';
import { FLEET_AGENT_TEMPLATE_ID, FLEET_REGISTRY_TEMPLATE_ID } from '../src/fleet/service.js';
import { CALL_MCP_TOOL_NAME } from '@pocketagent/protocol';
import { backendTokens, hubRequest, llmText, llmToolCall, startFleet, type Fleet } from './fleet-helpers.js';

/**
 * PA-134: enabling, moving and disabling the Fleet agent, against two real
 * backends behind a real Hub.
 *
 * The properties pinned here are the ticket's acceptance list for setup: the
 * dispatch token on every host is minted by that host's own route with
 * exactly `read, sessions, planner` and verified by asking it; the coordinator
 * gets an ordinary Pocket Agent plus an ordinary MCP registry, both recorded in
 * `hub_provisionings`; the coordinator's own registry really dials the Hub's
 * `/mcp`; and moving or disabling revokes what it should and keeps the agent.
 */
describe('Fleet agent setup', () => {
  let fleet: Fleet;

  afterEach(async () => {
    await fleet?.cleanup();
  });

  const enable = (hostId: string) =>
    hubRequest(fleet.hub, 'POST', '/api/hub/fleet/enable', { hostId, hubUrl: fleet.hub.baseUrl });

  async function registries(i: number) {
    const b = fleet.backends[i]!;
    const res = await b.app.app.inject({ method: 'GET', url: '/api/mcp-registries', headers: authHeaders(b.app.cookie) });
    return (res.json() as { registries: { id: string; name: string; toolCount: number; lastError: string | null }[] }).registries;
  }

  async function pocketAgents(i: number) {
    const b = fleet.backends[i]!;
    const res = await b.app.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(b.app.cookie) });
    return (res.json() as { workspaces: { id: string; name: string }[] }).workspaces;
  }

  it('refuses, naming the problem, when the coordinator has no LLM endpoint', async () => {
    fleet = await startFleet(['dev01'], { llm: false });
    const res = await enable('dev01');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('coordinator_no_llm');
    expect(res.body.error.message).toContain('dev01');
    // Nothing was written anywhere: no token minted, no agent, no registry.
    expect(await backendTokens(fleet.backends[0]!.app)).toHaveLength(0);
    expect((await pocketAgents(0)).map((w) => w.name)).not.toContain(FLEET_AGENT_NAME);
    expect(fleet.hub.context.db.prepare('SELECT COUNT(*) AS n FROM hub_mcp_tokens').get()).toEqual({ n: 0 });
  });

  it('enables: scoped tokens everywhere, a Fleet agent and a registry that really reaches the Hub', async () => {
    fleet = await startFleet(['dev01', 'mac01']);
    const res = await enable('dev01');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fleet).toMatchObject({ enabled: true, coordinatorHostId: 'dev01' });
    expect(res.body.fleet.hosts.map((h: { state: string }) => h.state)).toEqual(['ok', 'ok']);

    // Each host minted its own token with exactly the three scopes.
    for (const b of fleet.backends) {
      const tokens = await backendTokens(b.app);
      expect(tokens).toHaveLength(1);
      expect([...tokens[0]!.scopes].sort()).toEqual([...HUB_FLEET_BACKEND_SCOPES].sort());
      expect(tokens[0]!.scopes).not.toContain('admin');
    }

    // The coordinator got an ordinary Pocket Agent and an ordinary registry,
    // and the registry's own connection check reached the Hub's /mcp.
    expect((await pocketAgents(0)).map((w) => w.name)).toContain(FLEET_AGENT_NAME);
    expect((await pocketAgents(1)).map((w) => w.name)).not.toContain(FLEET_AGENT_NAME);
    const reg = (await registries(0)).find((r) => r.name === FLEET_REGISTRY_NAME)!;
    expect(reg.lastError).toBeNull();
    expect(reg.toolCount).toBe(HUB_FLEET_TOOL_NAMES.length);
    expect(await registries(1)).toHaveLength(0);

    // Recorded in the ledger like any provisioning, and hidden from the template list.
    const ledger = fleet.hub.context.db
      .prepare('SELECT template_id, host_id FROM hub_provisionings ORDER BY template_id')
      .all();
    expect(ledger).toEqual([
      { template_id: FLEET_AGENT_TEMPLATE_ID, host_id: 'dev01' },
      { template_id: FLEET_REGISTRY_TEMPLATE_ID, host_id: 'dev01' },
    ]);
    const templates = await hubRequest(fleet.hub, 'GET', '/api/hub/templates');
    expect(templates.body.templates).toHaveLength(0);
    const edit = await hubRequest(fleet.hub, 'DELETE', `/api/hub/templates/${FLEET_REGISTRY_TEMPLATE_ID}`);
    expect(edit.status).toBe(409);
  });

  it('never stores a raw dispatch or coordinator token in the clear', async () => {
    fleet = await startFleet(['dev01']);
    await enable('dev01');
    // The coordinator's registry holds the phm_ token; read it back the only
    // way it exists, by checking every Hub column for any token-shaped value.
    const tables = fleet.hub.context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      for (const row of fleet.hub.context.db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[]) {
        for (const value of Object.values(row)) {
          if (typeof value !== 'string') continue;
          // Prefixes are kept in the clear by design; a full token never is.
          expect(value).not.toMatch(/^(pam|phm)_[A-Za-z0-9_-]{30,}$/);
        }
      }
    }
  });

  it('moves the role: the old coordinator loses its route to the Hub and keeps its agent', async () => {
    fleet = await startFleet(['dev01', 'mac01']);
    await enable('dev01');
    const oldTokenId = fleet.hub.context.fleet.row()!.mcp_token_id!;

    const moved = await hubRequest(fleet.hub, 'POST', '/api/hub/fleet/move', { hostId: 'mac01' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body.fleet.coordinatorHostId).toBe('mac01');

    expect(fleet.hub.context.mcpTokens.get(oldTokenId)).toBeNull();
    expect((await registries(0)).map((r) => r.name)).not.toContain(FLEET_REGISTRY_NAME);
    expect((await pocketAgents(0)).map((w) => w.name)).toContain(FLEET_AGENT_NAME);
    expect((await registries(1)).find((r) => r.name === FLEET_REGISTRY_NAME)?.toolCount).toBe(HUB_FLEET_TOOL_NAMES.length);
    expect((await pocketAgents(1)).map((w) => w.name)).toContain(FLEET_AGENT_NAME);

    // Moving to where it already runs is refused rather than re-provisioned.
    const again = await hubRequest(fleet.hub, 'POST', '/api/hub/fleet/move', { hostId: 'mac01' });
    expect(again.status).toBe(409);
  });

  it('enabling a second coordinator is refused (move instead)', async () => {
    fleet = await startFleet(['dev01', 'mac01']);
    await enable('dev01');
    const second = await enable('mac01');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('fleet_already_enabled');
  });

  it('disables: every dispatch token revoked on its host, the registry removed, the agent kept', async () => {
    fleet = await startFleet(['dev01', 'mac01']);
    await enable('dev01');
    const res = await hubRequest(fleet.hub, 'POST', '/api/hub/fleet/disable');
    expect(res.status).toBe(200);
    expect(res.body.fleet.enabled).toBe(false);
    for (const b of fleet.backends) expect(await backendTokens(b.app)).toHaveLength(0);
    expect(res.body.fleet.hosts.map((h: { state: string }) => h.state)).toEqual(['missing', 'missing']);
    expect((await registries(0)).map((r) => r.name)).not.toContain(FLEET_REGISTRY_NAME);
    expect((await pocketAgents(0)).map((w) => w.name)).toContain(FLEET_AGENT_NAME);
    expect(fleet.hub.context.db.prepare('SELECT COUNT(*) AS n FROM hub_mcp_tokens').get()).toEqual({ n: 0 });
  });

  it('a token that reports more than read/sessions/planner is revoked and not used', async () => {
    fleet = await startFleet(['dev01']);
    // A backend that (wrongly) grants admin: simulated by widening the
    // request in flight, which is exactly what the verification step exists
    // to catch — the Hub must not trust the route's decision unseen.
    const original = fleet.hub.context.fetchImpl;
    const widening: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/api/mcp/tokens') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { scopes: string[] };
        return original(input, { ...init, body: JSON.stringify({ ...body, scopes: [...body.scopes, 'admin'] }) });
      }
      return original(input, init);
    };
    (fleet.hub.context as { fetchImpl: typeof fetch }).fetchImpl = widening;
    (fleet.hub.context.fleet as unknown as { opts: { fetchImpl: typeof fetch } }).opts.fetchImpl = widening;

    const res = await enable('dev01');
    const step = (res.body.steps as { label: string; ok: boolean; message: string }[]).find((s) =>
      s.label.startsWith('dispatch token on dev01'),
    )!;
    expect(step.ok).toBe(false);
    expect(step.message).toContain('admin');
    expect(await backendTokens(fleet.backends[0]!.app)).toHaveLength(0);
    expect(fleet.hub.context.registry.getRow('dev01')!.mcp_credential_enc).toBeNull();
  });

  it('a host bound after enabling gets its dispatch token; removing one revokes it there', async () => {
    fleet = await startFleet(['dev01']);
    await enable('dev01');
    const extra = await startFleet(['mac01']);
    try {
      const mac = extra.backends[0]!;
      await hubRequest(fleet.hub, 'POST', '/api/hub/hosts', { id: 'mac01', label: 'mac01', baseUrl: mac.url });
      const { TEST_TOKEN } = await import('../../server/tests/helpers.js');
      await hubRequest(fleet.hub, 'POST', '/api/hub/hosts/mac01/bind', { token: TEST_TOKEN, label: 'test hub' });
      // `extra`'s own Hub bound mac01 too, so filter to this Hub's token.
      const minted = (await backendTokens(mac.app)).filter((t) => t.label === 'Hub fleet dispatch');
      expect(minted.length).toBeGreaterThanOrEqual(1);
      expect(fleet.hub.context.registry.mcpTokenState(fleet.hub.context.registry.getRow('mac01')!)).toBe('ok');

      const before = minted.length;
      await hubRequest(fleet.hub, 'DELETE', '/api/hub/hosts/mac01');
      const after = (await backendTokens(mac.app)).filter((t) => t.label === 'Hub fleet dispatch');
      expect(after.length).toBe(before - 1);
    } finally {
      await extra.cleanup();
    }
  });

  it('end to end: the Fleet agent dispatches through the Hub, gated per host on the coordinator', async () => {
    fleet = await startFleet(['dev01', 'mac01']);
    const enabled = await enable('dev01');
    const { pocketAgentId, registryId } = enabled.body.fleet as { pocketAgentId: string; registryId: string };
    const coord = fleet.backends[0]!;
    const mac = fleet.backends[1]!;
    const post = (url: string, payload?: unknown) =>
      coord.app.app.inject({ method: 'POST', url, headers: authHeaders(coord.app.cookie), ...(payload === undefined ? {} : { payload }) });
    const parse = (payload: string) =>
      payload
        .split('\n\n')
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => JSON.parse(c.replace(/^data: /, '')) as { kind: string; [k: string]: unknown });

    const macAgent = (
      (await mac.app.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(mac.app.cookie) })).json() as {
        workspaces: { id: string; name: string }[];
      }
    ).workspaces.find((w) => w.name === 'Pocket Agent')!.id;
    const qualified = `mcp__${registryId}__dispatch_pocket_task`;
    const dispatch = (id: string) =>
      llmToolCall(CALL_MCP_TOOL_NAME, { tool: qualified, arguments: { host: 'mac01', pocketAgentId: macAgent, prompt: 'build the iOS app' } }, id);

    const chat = (await post('/api/planner/chats', { workspaceId: pocketAgentId, modelId: 'gpt-4o' })).json() as { id: string };
    coord.llm.mockResolvedValueOnce(dispatch('c1'));
    const first = parse((await post(`/api/planner/chats/${chat.id}/messages`, { content: 'Build the iOS app.' })).payload);
    const request = first.find((e) => e.kind === 'permission_request')!;
    // The Hub's annotation reached the coordinator through its registry: the
    // approval is for this tool *on mac01*, and cannot be remembered globally.
    expect(request.toolName).toBe(`${qualified}@host:mac01`);
    expect(request.rememberScopes).toEqual(['workspace']);
    // Nothing reached mac01 yet.
    expect(mac.llm).not.toHaveBeenCalled();

    mac.llm.mockResolvedValueOnce(llmText('Built.'));
    coord.llm.mockResolvedValueOnce(llmText('Dispatched to mac01.'));
    const resumed = parse(
      (await post(`/api/planner/chats/${chat.id}/approvals/${String(request.id)}`, { decision: 'allow_once' })).payload,
    );
    const result = resumed.find((e) => e.kind === 'tool_result')!;
    expect(result.isError).toBe(false);
    expect(String(result.content)).toContain('"host": "mac01"');
    expect(String(result.content)).toMatch(/"ref": "chat:/);
  });
});
