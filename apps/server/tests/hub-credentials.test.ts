import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import {
  HUB_TOKEN_PREFIX_LENGTH,
  HUB_TOKEN_SCHEME_PREFIX,
  PROTOCOL_VERSION,
} from '@pocketagent/protocol';
import { createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

/**
 * PA-63: hub credentials.
 *
 * The five cases the ticket's acceptance criteria name — bind, use, revoke,
 * use-after-revoke, wrong master token — plus the ones that guard the
 * *reasoning* behind the design: the master token is not itself a bearer
 * credential, revocation needs no restart, nothing that leaves the server
 * carries token material, and the WebSocket upgrade authenticates the same way
 * every other route does (because it goes through the same `onRequest` gate,
 * which is the entire point of putting the check there).
 */
describe('hub credentials', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  async function bind(label = 'laptop hub', token = TEST_TOKEN) {
    return t.app.inject({
      method: 'POST',
      url: '/api/auth/hub-bind',
      payload: { token, label },
    });
  }

  it('mints a credential when the master token is correct', async () => {
    const res = await bind();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.label).toBe('laptop hub');
    expect(typeof body.id).toBe('string');
    expect(body.token.startsWith(HUB_TOKEN_SCHEME_PREFIX)).toBe(true);
    // The minted token must not be the master token under a new name.
    expect(body.token).not.toContain(TEST_TOKEN);
  });

  it('rejects a bind with the wrong master token, and mints nothing', async () => {
    const res = await bind('impostor', 'not-the-master-token-but-long-enough-xx');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');

    const list = await t.app.inject({
      method: 'GET',
      url: '/api/auth/hubs',
      headers: { cookie: t.cookie },
    });
    expect(list.json().hubs).toHaveLength(0);
  });

  it('authenticates a normal route with the credential, with no cookie at all', async () => {
    const { token } = (await bind()).json();

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    // And the same request with no credential is still closed, so the test
    // above is not passing because the route became public.
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('revokes immediately: the very next request with that token is rejected', async () => {
    const { id, token } = (await bind()).json();
    const authorization = `Bearer ${token}`;

    expect((await t.app.inject({ method: 'GET', url: '/api/projects', headers: { authorization } })).statusCode).toBe(200);

    const revoked = await t.app.inject({
      method: 'DELETE',
      url: `/api/auth/hubs/${id}`,
      headers: { cookie: t.cookie },
    });
    expect(revoked.statusCode).toBe(200);

    // No restart, no cache flush, no sleep: the lookup happens per request, so
    // the next one already fails. This is the acceptance criterion that a
    // cached roster would quietly break.
    const after = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization },
    });
    expect(after.statusCode).toBe(401);
  });

  it('revoking an unknown id is a 404 rather than a silent success', async () => {
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api/auth/hubs/does-not-exist',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('never accepts the master token as a bearer credential', async () => {
    // The master token authenticates `login` and `hub-bind` and nothing else.
    // Accepting it here would restore the permanent, unrevocable root
    // credential the whole feature exists to avoid.
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('does not accept a session id as a bearer credential either', async () => {
    const sid = /pocketagent_sid=([^;]+)/.exec(t.cookie)?.[1] ?? '';
    expect(sid).not.toBe('');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${sid}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists hubs without ever returning token material', async () => {
    const minted = (await bind('hub one')).json();
    await bind('hub two');

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/auth/hubs',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { hubs } = res.json();
    expect(hubs.map((h: { label: string }) => h.label).sort()).toEqual(['hub one', 'hub two']);

    // The prefix is the *only* part of a token that survives, and the full
    // token must appear nowhere in the payload.
    const row = hubs.find((h: { id: string }) => h.id === minted.id);
    expect(row.tokenPrefix).toBe(minted.token.slice(0, HUB_TOKEN_PREFIX_LENGTH));
    expect(res.body).not.toContain(minted.token);
    expect(res.body).not.toContain(TEST_TOKEN);
  });

  it('stores only a digest, so the database holds nothing presentable', async () => {
    const { token } = (await bind()).json();
    const rows = t.db.prepare('SELECT * FROM hub_credentials').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    // The token itself, and any suffix of it beyond the deliberately-public
    // prefix, must be absent — a copied database must not yield a credential.
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(token.slice(HUB_TOKEN_PREFIX_LENGTH));
    expect(rows[0]!.token_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records last seen only once a credential has actually been used', async () => {
    const { id, token } = (await bind()).json();
    const rowOf = (hubs: { id: string; lastSeenAt: number | null }[]) =>
      hubs.find((h) => h.id === id)!;
    const list = async () =>
      (
        await t.app.inject({ method: 'GET', url: '/api/auth/hubs', headers: { cookie: t.cookie } })
      ).json().hubs;

    expect(rowOf(await list()).lastSeenAt).toBeNull();

    await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rowOf(await list()).lastSeenAt).toBeGreaterThan(0);
  });

  it('is rate limited, so the master token cannot be ground down here', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await bind('x', 'wrong-token-wrong-token-wrong-token')).statusCode);
    }
    expect(codes).toContain(429);
  });
});

describe('hub credentials over the WebSocket upgrade', () => {
  let t: TestApp;
  let baseUrl: string;

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });
  afterEach(() => t.cleanup());

  /** Resolves to true when the socket opened, false when it was closed/errored. */
  function tryConnect(headers: Record<string, string>): Promise<boolean> {
    const ws = new WebSocket(`${baseUrl}/api/ws?v=${PROTOCOL_VERSION}`, { headers });
    return new Promise<boolean>((resolve) => {
      ws.once('open', () => {
        ws.close();
        resolve(true);
      });
      ws.once('close', () => resolve(false));
      ws.once('error', () => resolve(false));
    });
  }

  it('accepts a hub credential and rejects a revoked one', async () => {
    const { id, token } = (
      await t.app.inject({
        method: 'POST',
        url: '/api/auth/hub-bind',
        payload: { token: TEST_TOKEN, label: 'streaming hub' },
      })
    ).json();

    // A Hub proxying a terminal needs this to work: the upgrade is gated by the
    // same `onRequest` hook as every REST route, so it needs no separate path.
    expect(await tryConnect({ authorization: `Bearer ${token}` })).toBe(true);

    await t.app.inject({
      method: 'DELETE',
      url: `/api/auth/hubs/${id}`,
      headers: { cookie: t.cookie },
    });

    expect(await tryConnect({ authorization: `Bearer ${token}` })).toBe(false);
  });
});
