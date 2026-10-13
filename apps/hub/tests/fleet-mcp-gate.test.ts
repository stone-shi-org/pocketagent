import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HUB_FLEET_TOOL_NAMES } from '@pocketagent/protocol';
import { createTestHub, type TestHub } from './helpers.js';
import { connectHub, type Era } from './fleet-helpers.js';

/**
 * PA-134: the Hub's one bearer.
 *
 * The amended invariant is "the Hub answers to one bearer class (`phm_`), on
 * one exact-match path (`/mcp`), with no access to the registry, the proxy or
 * push" — so this suite is mostly the second half: a valid coordinator token
 * presented anywhere else is a 401, and the session cookie counts for nothing
 * on `/mcp`. A real socket throughout, like every other Hub suite.
 */
describe('the Hub /mcp gate', () => {
  let hub: TestHub;
  let token: string;
  let tokenId: string;

  beforeEach(async () => {
    hub = await createTestHub();
    const minted = hub.context.mcpTokens.mint('fleet:test');
    token = minted.token;
    tokenId = minted.id;
  });

  afterEach(async () => {
    await hub.cleanup();
  });

  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  for (const era of ['legacy', 'modern'] as Era[]) {
    it(`accepts a phm_ token on /mcp [${era}] and lists exactly the Fleet catalog`, async () => {
      const client = await connectHub(hub, token, era);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual([...HUB_FLEET_TOOL_NAMES]);
      await client.close();
    });
  }

  it('answers 401 on /mcp with no token, a wrong token, or a backend-shaped token', async () => {
    for (const headers of [{}, bearer('phm_not-a-real-token'), bearer('pam_xxxxxxxx'), bearer('pah_xxxxxxxx')]) {
      const res = await fetch(`${hub.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(401);
    }
  });

  it('does not accept the session cookie on /mcp', async () => {
    const res = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: hub.cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('is a 401 everywhere else on the Hub', async () => {
    const paths = [
      '/api/hub/hosts',
      '/api/hub/fleet',
      '/api/hub/templates',
      '/api/push/status',
      '/api/auth/me',
      '/h/dev01/api/projects',
      '/api/projects',
    ];
    for (const path of paths) {
      const res = await fetch(`${hub.baseUrl}${path}`, { headers: bearer(token) });
      // `/api/auth/me` is public and answers "not logged in" rather than 401.
      if (path === '/api/auth/me') {
        expect((await res.json()) as { authenticated?: boolean }).not.toMatchObject({ authenticated: true });
        continue;
      }
      expect(res.status, path).toBe(401);
    }
    const write = await fetch(`${hub.baseUrl}/api/hub/fleet/disable`, { method: 'POST', headers: bearer(token) });
    expect(write.status).toBe(401);
  });

  it('is not the gate for /mcpx or /mcp/x (exact match)', async () => {
    for (const path of ['/mcpx', '/mcp/x']) {
      const res = await fetch(`${hub.baseUrl}${path}`, { headers: bearer(token) });
      expect(res.status, path).not.toBe(200);
      expect(res.headers.get('content-type') ?? '').not.toContain('event-stream');
    }
  });

  it('refuses a WebSocket upgrade carrying the token', async () => {
    const outcome = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`${hub.baseUrl.replace('http', 'ws')}/h/dev01/api/ws`, { headers: bearer(token) });
      ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
    });
    expect(outcome).not.toBe('open');
  });

  it('a revoked token is refused on its next request and its session is closed', async () => {
    const client = await connectHub(hub, token, 'legacy');
    expect(hub.context.mcpServer.openSessions()).toBe(1);
    hub.context.mcpTokens.revoke(tokenId);
    await hub.context.mcpServer.revoke(tokenId);
    expect(hub.context.mcpServer.openSessions()).toBe(0);
    const res = await fetch(`${hub.baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(token) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    await client.close().catch(() => undefined);
  });

  it('stores only a digest of the token', () => {
    const rows = hub.context.db.prepare('SELECT * FROM hub_mcp_tokens').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    for (const value of Object.values(rows[0]!)) {
      if (typeof value === 'string') expect(value).not.toBe(token);
    }
    expect(token.startsWith(String(rows[0]!.token_prefix))).toBe(true);
  });
});
