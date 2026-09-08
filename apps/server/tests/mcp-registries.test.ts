import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { startStreamableHttpTestServer, startSseTestServer, type TestMcpServerHandle } from './helpers-mcp-server.js';
import { SECRET_KEY_BYTES, decryptSecret } from '../src/crypto/secret-box.js';

/**
 * PA-37: MCP registry CRUD, encrypted auth secrets, and the "Test
 * connection"/"Refresh tools" round trip against genuine servers on both
 * transports the reporter asked for.
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');

describe('MCP registry routes', () => {
  let t: TestApp;
  let mcpServer: TestMcpServerHandle | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    mcpServer = undefined;
    if (t) await t.cleanup();
  });

  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });
  const del = (url: string) => t.app.inject({ method: 'DELETE', url, headers: authHeaders(t.cookie) });

  describe('CRUD and secret handling', () => {
    beforeEach(async () => {
      t = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY });
    });

    const valid = (over: Record<string, unknown> = {}) => ({
      name: 'Jira MCP',
      transport: 'streamable_http',
      url: 'https://mcp.example.com/jira',
      authKind: 'bearer',
      bearerToken: 'sk-jira-token',
      ...over,
    });

    it('creates a registry in the reserved id namespace', async () => {
      const res = await post('/api/mcp-registries', valid());
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().id).toMatch(/^mcp:jira-mcp-[0-9a-f]{8}$/);
    });

    it('never returns the bearer token or header value, in any shape, from any route', async () => {
      const created = (await post('/api/mcp-registries', valid())).json();
      const withHeader = (
        await post('/api/mcp-registries', valid({ name: 'Header one', authKind: 'header', headerName: 'X-API-Key', headerValue: 'super-secret', bearerToken: undefined }))
      ).body;
      const listed = (await get('/api/mcp-registries')).body;
      const patched = (await patch(`/api/mcp-registries/${encodeURIComponent(created.id)}`, { name: 'Renamed' })).body;
      for (const body of [withHeader, listed, patched]) {
        expect(body).not.toContain('sk-jira-token');
        expect(body).not.toContain('super-secret');
        expect(body).not.toContain('bearerToken');
        expect(body).not.toContain('headerValue');
        expect(body).not.toContain('ciphertext');
      }
    });

    it('stores the bearer token encrypted, not in the clear, and it decrypts back correctly', async () => {
      const created = (await post('/api/mcp-registries', valid())).json();
      const row = t.db
        .prepare('SELECT bearer_token_ciphertext FROM mcp_registries WHERE id = ?')
        .get(created.id) as { bearer_token_ciphertext: string };
      expect(row.bearer_token_ciphertext).not.toContain('sk-jira-token');
      expect(decryptSecret(row.bearer_token_ciphertext, Buffer.from(ENC_KEY, 'base64'))).toBe('sk-jira-token');
    });

    it('requires a bearer token when authKind is bearer, and a header name+value when authKind is header', async () => {
      expect((await post('/api/mcp-registries', valid({ bearerToken: undefined }))).statusCode).toBe(400);
      expect(
        (await post('/api/mcp-registries', valid({ authKind: 'header', bearerToken: undefined, headerName: 'X-Key' }))).statusCode,
      ).toBe(400);
    });

    it('refuses to create a bearer/header registry with no encryption key configured, but allows authKind none', async () => {
      const noKey = await createTestApp();
      try {
        const bearerRes = await noKey.app.inject({
          method: 'POST',
          url: '/api/mcp-registries',
          headers: authHeaders(noKey.cookie),
          payload: valid(),
        });
        expect(bearerRes.statusCode).toBe(409);

        const noneRes = await noKey.app.inject({
          method: 'POST',
          url: '/api/mcp-registries',
          headers: authHeaders(noKey.cookie),
          payload: { name: 'Open server', transport: 'streamable_http', url: 'https://open.example.com', authKind: 'none' },
        });
        expect(noneRes.statusCode, noneRes.body).toBe(201);
      } finally {
        await noKey.cleanup();
      }
    });

    it('keeps the stored bearer token when an edit leaves the field blank', async () => {
      const created = (await post('/api/mcp-registries', valid())).json();
      for (const payload of [{ name: 'A' }, { name: 'B', bearerToken: '' }]) {
        const res = await patch(`/api/mcp-registries/${encodeURIComponent(created.id)}`, payload);
        expect(res.statusCode, res.body).toBe(200);
        const row = t.db
          .prepare('SELECT bearer_token_ciphertext FROM mcp_registries WHERE id = ?')
          .get(created.id) as { bearer_token_ciphertext: string };
        expect(decryptSecret(row.bearer_token_ciphertext, Buffer.from(ENC_KEY, 'base64'))).toBe('sk-jira-token');
      }
    });

    it('deletes a registry and cleans up its remembered approval decisions, but leaves other registries alone', async () => {
      // PA-37 follow-up: MCP tools are no longer listed in
      // planner_global_disabled_tools/planner_agent_disabled_tools at all
      // (enablement is whole-MCP now, not per-tool) — the only per-tool
      // config left to clean up on delete is a remembered `call_mcp_tool`
      // approval decision (`planner_tool_approvals`), from the dynamic
      // approval-gating special case.
      const a = (await post('/api/mcp-registries', valid({ name: 'A' }))).json();
      const b = (await post('/api/mcp-registries', valid({ name: 'B' }))).json();
      const aTool = `mcp__${a.id}__thing`;
      const bTool = `mcp__${b.id}__thing`;
      t.db
        .prepare(
          "INSERT INTO planner_tool_approvals (id, scope, workspace_id, tool_name, decision, created_at) VALUES (?, 'global', NULL, ?, 'allow', ?)",
        )
        .run('approval-a', aTool, Date.now());
      t.db
        .prepare(
          "INSERT INTO planner_tool_approvals (id, scope, workspace_id, tool_name, decision, created_at) VALUES (?, 'global', NULL, ?, 'allow', ?)",
        )
        .run('approval-b', bTool, Date.now());

      expect((await del(`/api/mcp-registries/${encodeURIComponent(a.id)}`)).statusCode).toBe(204);

      const remaining = t.db.prepare('SELECT tool_name FROM planner_tool_approvals').all() as {
        tool_name: string;
      }[];
      expect(remaining.map((r) => r.tool_name)).toEqual([bTool]);
    });

    it('404s a test/refresh/patch/delete against an unknown id', async () => {
      expect((await post('/api/mcp-registries/does-not-exist/test')).statusCode).toBe(404);
      expect((await post('/api/mcp-registries/does-not-exist/refresh-tools')).statusCode).toBe(404);
      expect((await patch('/api/mcp-registries/does-not-exist', { name: 'x' })).statusCode).toBe(404);
      expect((await del('/api/mcp-registries/does-not-exist')).statusCode).toBe(404);
    });
  });

  describe('connecting to a real server', () => {
    beforeEach(async () => {
      t = await createTestApp();
    });

    it('connects and caches tools automatically on create, with no separate Test click required', async () => {
      mcpServer = await startStreamableHttpTestServer();
      const created = (
        await post('/api/mcp-registries', {
          name: 'Auto-tested server',
          transport: 'streamable_http',
          url: mcpServer.url,
          authKind: 'none',
        })
      ).json();

      // The create response itself already reflects a successful connection —
      // this is what fixes "I added MCP, Pocket Agent is not aware of it."
      expect(created.toolCount).toBe(2);
      expect(created.lastConnectedAt).not.toBeNull();
      expect(created.lastError).toBeNull();

      const listed = (await get('/api/mcp-registries')).json().registries[0];
      expect(listed.toolCount).toBe(2);
    });

    it('still creates the row when the automatic first connection fails, recording lastError rather than blocking the save', async () => {
      const created = (
        await post('/api/mcp-registries', {
          name: 'Unreachable server',
          transport: 'streamable_http',
          url: 'http://127.0.0.1:1/mcp',
          authKind: 'none',
        })
      ).json();

      expect(created.name).toBe('Unreachable server');
      expect(created.toolCount).toBe(0);
      expect(created.lastError).not.toBeNull();
    });

    it('tests and caches tools over Streamable HTTP', async () => {
      mcpServer = await startStreamableHttpTestServer();
      const created = (
        await post('/api/mcp-registries', {
          name: 'Streamable server',
          transport: 'streamable_http',
          url: mcpServer.url,
          authKind: 'none',
        })
      ).json();

      const tested = await post(`/api/mcp-registries/${encodeURIComponent(created.id)}/test`);
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toMatchObject({ ok: true, toolCount: 2 });

      const listed = (await get('/api/mcp-registries')).json().registries[0];
      expect(listed.toolCount).toBe(2);
      expect(listed.lastConnectedAt).not.toBeNull();
      expect(listed.lastError).toBeNull();
    });

    it('tests and caches tools over HTTP+SSE', async () => {
      mcpServer = await startSseTestServer();
      const created = (
        await post('/api/mcp-registries', {
          name: 'SSE server',
          transport: 'sse',
          url: mcpServer.url,
          authKind: 'none',
        })
      ).json();

      const tested = await post(`/api/mcp-registries/${encodeURIComponent(created.id)}/refresh-tools`);
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json()).toMatchObject({ ok: true, toolCount: 2 });
    });

    it('sends the configured bearer token to the wire, over both transports', async () => {
      const ctx = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY });
      try {
        mcpServer = await startStreamableHttpTestServer({
          requireHeader: { name: 'authorization', value: 'Bearer wire-secret' },
        });
        const withAuthHeaders = (extra: Record<string, string>) => ({ ...authHeaders(ctx.cookie), ...extra });
        const created = (
          await ctx.app.inject({
            method: 'POST',
            url: '/api/mcp-registries',
            headers: withAuthHeaders({}),
            payload: {
              name: 'Auth needed',
              transport: 'streamable_http',
              url: mcpServer.url,
              authKind: 'bearer',
              bearerToken: 'wire-secret',
            },
          })
        ).json();

        // Without the header, the test server 401s — the client wrapper must
        // surface that as a clean failed test, never an uncaught throw.
        const unauthedServer = await startStreamableHttpTestServer({
          requireHeader: { name: 'authorization', value: 'Bearer something-else' },
        });
        try {
          const failed = await ctx.app.inject({
            method: 'PATCH',
            url: `/api/mcp-registries/${encodeURIComponent(created.id)}`,
            headers: withAuthHeaders({}),
            payload: { url: unauthedServer.url },
          });
          expect(failed.statusCode).toBe(200);
          const failedTest = await ctx.app.inject({
            method: 'POST',
            url: `/api/mcp-registries/${encodeURIComponent(created.id)}/test`,
            headers: withAuthHeaders({}),
          });
          expect(failedTest.json()).toMatchObject({ ok: false, toolCount: null });
        } finally {
          await unauthedServer.close();
        }

        // Pointed back at the real, matching server: succeeds and the server
        // genuinely observed the header.
        await ctx.app.inject({
          method: 'PATCH',
          url: `/api/mcp-registries/${encodeURIComponent(created.id)}`,
          headers: withAuthHeaders({}),
          payload: { url: mcpServer.url },
        });
        const ok = await ctx.app.inject({
          method: 'POST',
          url: `/api/mcp-registries/${encodeURIComponent(created.id)}/test`,
          headers: withAuthHeaders({}),
        });
        expect(ok.json()).toMatchObject({ ok: true, toolCount: 2 });
        expect(
          mcpServer.requestsSeen.some((h) => h.authorization === 'Bearer wire-secret'),
        ).toBe(true);
      } finally {
        await ctx.cleanup();
      }
    });

    it('a failed test records lastError but does not clear a previously-cached tool count', async () => {
      mcpServer = await startStreamableHttpTestServer();
      const created = (
        await post('/api/mcp-registries', {
          name: 'Flaky server',
          transport: 'streamable_http',
          url: mcpServer.url,
          authKind: 'none',
        })
      ).json();
      expect((await post(`/api/mcp-registries/${encodeURIComponent(created.id)}/test`)).json().ok).toBe(true);

      await mcpServer.close();
      const failed = await post(`/api/mcp-registries/${encodeURIComponent(created.id)}/test`);
      expect(failed.json().ok).toBe(false);

      const listed = (await get('/api/mcp-registries')).json().registries[0];
      expect(listed.toolCount).toBe(2);
      expect(listed.lastError).not.toBeNull();
    });
  });

  // PA-37 follow-up round two (reporter: "we can globally disable bamboo
  // mcp but allow Jira mcp. Same concept for per agent base - enable/disable
  // all AND separate enable/disable for each mcp"): per-registry enablement,
  // both layers — mirrors `planner-skills.test.ts`'s own
  // "GET/POST .../skills reflect the per-agent view" test almost exactly,
  // one level up (a whole registry rather than one skill).
  describe('per-registry enablement (global via registry.enabled, per-agent via workspaces/:id/mcp-registries)', () => {
    beforeEach(async () => {
      t = await createTestApp();
    });

    async function createRegistry(name: string): Promise<string> {
      const res = await post('/api/mcp-registries', { name, transport: 'streamable_http', url: 'https://example.com/mcp', authKind: 'none' });
      return res.json().id as string;
    }

    it('GET/POST /api/planner/workspaces/:id/mcp-registries reflect the per-agent view, greying out a globally disabled one', async () => {
      const id = await createRegistry('Jira MCP');
      const wsId = t.context.plannerWorkspaces.getDefault()!.id;

      const before = (await get(`/api/planner/workspaces/${wsId}/mcp-registries`)).json();
      expect(before.registries).toEqual([
        expect.objectContaining({ id, name: 'Jira MCP', enabled: true, disabledGlobally: false }),
      ]);

      // Global off (the registry's own `enabled`, not a new deny-list table).
      await patch(`/api/mcp-registries/${encodeURIComponent(id)}`, { enabled: false });
      const globallyOff = (await get(`/api/planner/workspaces/${wsId}/mcp-registries`)).json();
      expect(globallyOff.registries).toEqual([
        expect.objectContaining({ id, enabled: false, disabledGlobally: true }),
      ]);

      // Back on globally, then disabled for just this agent.
      await patch(`/api/mcp-registries/${encodeURIComponent(id)}`, { enabled: true });
      const setDisabled = await post(`/api/planner/workspaces/${wsId}/mcp-registries`, { registryId: id, enabled: false });
      expect(setDisabled.json().registries).toEqual([
        expect.objectContaining({ id, enabled: false, disabledGlobally: false }),
      ]);

      // Re-enabling for the agent restores it.
      const setEnabled = await post(`/api/planner/workspaces/${wsId}/mcp-registries`, { registryId: id, enabled: true });
      expect(setEnabled.json().registries).toEqual([expect.objectContaining({ id, enabled: true })]);
    });

    it('404s an unknown registry id or workspace id', async () => {
      const wsId = t.context.plannerWorkspaces.getDefault()!.id;
      expect(
        (await post(`/api/planner/workspaces/${wsId}/mcp-registries`, { registryId: 'does-not-exist', enabled: false }))
          .statusCode,
      ).toBe(404);
      expect((await get('/api/planner/workspaces/does-not-exist/mcp-registries')).statusCode).toBe(404);
    });

    it('disabling one registry for an agent leaves a second registry, and every other agent, unaffected', async () => {
      const jiraId = await createRegistry('Jira MCP');
      const bambooId = await createRegistry('Bamboo MCP');
      const wsId = t.context.plannerWorkspaces.getDefault()!.id;
      const otherWs = (await post('/api/planner/workspaces', { name: 'Other agent' })).json();

      await post(`/api/planner/workspaces/${wsId}/mcp-registries`, { registryId: bambooId, enabled: false });

      const mine = (await get(`/api/planner/workspaces/${wsId}/mcp-registries`)).json().registries;
      expect(mine.find((r: { id: string }) => r.id === jiraId)).toMatchObject({ enabled: true });
      expect(mine.find((r: { id: string }) => r.id === bambooId)).toMatchObject({ enabled: false });

      const others = (await get(`/api/planner/workspaces/${otherWs.id}/mcp-registries`)).json().registries;
      expect(others.find((r: { id: string }) => r.id === bambooId)).toMatchObject({ enabled: true });
    });

    it('deleting a registry cascades away its per-agent disabled rows (no orphaned config)', async () => {
      const id = await createRegistry('Temp MCP');
      const wsId = t.context.plannerWorkspaces.getDefault()!.id;
      await post(`/api/planner/workspaces/${wsId}/mcp-registries`, { registryId: id, enabled: false });
      expect(
        (t.db.prepare('SELECT COUNT(*) AS n FROM planner_agent_disabled_mcp_registries').get() as { n: number }).n,
      ).toBe(1);

      expect((await del(`/api/mcp-registries/${encodeURIComponent(id)}`)).statusCode).toBe(204);

      expect(
        (t.db.prepare('SELECT COUNT(*) AS n FROM planner_agent_disabled_mcp_registries').get() as { n: number }).n,
      ).toBe(0);
    });
  });
});
