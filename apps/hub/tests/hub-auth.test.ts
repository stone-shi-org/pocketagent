import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUB_AUTH_COOKIE_NAME } from '../src/auth.js';
import {
  HUB_TOKEN,
  createTestHub,
  registerHost,
  startStubBackend,
  type StubBackend,
  type TestHub,
} from './helpers.js';

describe('single sign-on', () => {
  let hub: TestHub;
  let a: StubBackend;
  let b: StubBackend;

  beforeEach(async () => {
    a = await startStubBackend();
    b = await startStubBackend();
    hub = await createTestHub();
    registerHost(hub, { id: 'dev01', baseUrl: a.baseUrl });
    registerHost(hub, { id: 'dev02', baseUrl: b.baseUrl });
  });

  afterEach(async () => {
    await hub.cleanup();
    await a.close();
    await b.close();
  });

  it('reaches every bound host from one login, with no second prompt', async () => {
    // Acceptance criterion 1. The cookie came from one `POST
    // /api/auth/login` in the helper; nothing else was authenticated.
    for (const id of ['dev01', 'dev02']) {
      const response = await fetch(`${hub.baseUrl}/h/${id}/api/sessions`, {
        headers: { cookie: hub.cookie },
      });
      expect(response.status, id).toBe(200);
    }
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('uses the shapes the shipped bundle already posts to', async () => {
    // The whole of SSO on the client side is that there is no client side:
    // `LoginPage` and `App.tsx` speak these three routes unmodified.
    const me = await fetch(`${hub.baseUrl}/api/auth/me`, { headers: { cookie: hub.cookie } });
    expect(await me.json()).toMatchObject({ authenticated: true });

    const anonymous = await fetch(`${hub.baseUrl}/api/auth/me`);
    expect(await anonymous.json()).toMatchObject({ authenticated: false });

    const logout = await fetch(`${hub.baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: hub.cookie },
    });
    expect(logout.status).toBe(200);
    const after = await fetch(`${hub.baseUrl}/api/auth/me`, { headers: { cookie: hub.cookie } });
    expect(await after.json()).toMatchObject({ authenticated: false });
  });

  it('uses its own cookie name, because cookies are not port-scoped', async () => {
    // A Hub on one port and a backend on another share a cookie jar, so a
    // shared name would have them silently overwrite each other's session.
    const login = await fetch(`${hub.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: HUB_TOKEN }),
    });
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${HUB_AUTH_COOKIE_NAME}=`);
    expect(setCookie).not.toContain('pocketagent_sid=');
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('answers /api/auth/me itself rather than proxying it', async () => {
    // Proxied, the backend would report cookie sessions only and tell a
    // per-host `me()` the operator is signed out of a host they can reach.
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/auth/me`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(404);
    expect(a.requests).toHaveLength(0);
  });

  it('refuses everything under /h/ without a session', async () => {
    for (const path of ['/h/dev01/api/sessions', '/h/dev01/health']) {
      const response = await fetch(`${hub.baseUrl}${path}`);
      expect(response.status, path).toBe(401);
    }
    // Not even a reachability probe: the Hub must not become an
    // unauthenticated port scanner for whoever can reach it.
    expect(a.requests).toHaveLength(0);
  });

  it('keeps the Hub session when one backend rejects its credential', async () => {
    // PA-66 D21, from the browser's point of view: the operator stays signed
    // in to the Hub and to every other host.
    a.respondWith((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const rejected = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(rejected.status).toBe(502);

    const me = await fetch(`${hub.baseUrl}/api/auth/me`, { headers: { cookie: hub.cookie } });
    expect(await me.json()).toMatchObject({ authenticated: true });
    const other = await fetch(`${hub.baseUrl}/h/dev02/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(other.status).toBe(200);
  });

  it('rate-limits login and rejects a wrong token', async () => {
    const bad = await fetch(`${hub.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong-but-long-enough-to-be-a-token' }),
    });
    expect(bad.status).toBe(401);

    let sawLimit = false;
    for (let i = 0; i < 12; i += 1) {
      const response = await fetch(`${hub.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'wrong-but-long-enough-to-be-a-token' }),
      });
      if (response.status === 429) sawLimit = true;
    }
    expect(sawLimit).toBe(true);
  });

  it('enforces the Origin check on the Hub, where the cookie is', async () => {
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      method: 'POST',
      headers: {
        cookie: hub.cookie,
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(a.requests).toHaveLength(0);
  });
});

describe('the Hub’s own unauthenticated surface', () => {
  let hub: TestHub;

  beforeEach(async () => {
    hub = await createTestHub();
  });

  afterEach(async () => {
    await hub.cleanup();
  });

  it('is /health plus the two login routes, and nothing else', async () => {
    const health = await fetch(`${hub.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(Object.keys((await health.json()) as object).sort()).toEqual([
      'protocol',
      'status',
      'uptimeSeconds',
      'version',
    ]);

    for (const path of ['/api/hub/hosts', '/api/auth/logout']) {
      const response = await fetch(`${hub.baseUrl}${path}`, { method: 'POST' });
      expect(response.status, path).not.toBe(200);
    }
    expect((await fetch(`${hub.baseUrl}/api/hub/hosts`)).status).toBe(401);
  });

  it('does not accept a bearer credential of its own', async () => {
    // A Hub presents credentials; it does not accept them. Adding a bearer
    // branch would make the Hub itself something that can be fronted, which
    // would need its own revocation story and nothing asks for it.
    const response = await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      headers: { authorization: `Bearer ${HUB_TOKEN}` },
    });
    expect(response.status).toBe(401);
  });
});
