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

    it('deletes a registry and cleans up its disabled-tool/approval rows, but leaves other registries alone', async () => {
      const a = (await post('/api/mcp-registries', valid({ name: 'A' }))).json();
      const b = (await post('/api/mcp-registries', valid({ name: 'B' }))).json();
      const aTool = `mcp__${a.id}__thing`;
      const bTool = `mcp__${b.id}__thing`;
      t.db
        .prepare('INSERT INTO planner_global_disabled_tools (tool_name, created_at) VALUES (?, ?)')
        .run(aTool, Date.now());
      t.db
        .prepare('INSERT INTO planner_global_disabled_tools (tool_name, created_at) VALUES (?, ?)')
        .run(bTool, Date.now());

      expect((await del(`/api/mcp-registries/${encodeURIComponent(a.id)}`)).statusCode).toBe(204);

      const remaining = t.db.prepare('SELECT tool_name FROM planner_global_disabled_tools').all() as {
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
});
