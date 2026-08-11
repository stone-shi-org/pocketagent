import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_COOKIE_NAME } from '@pocketagent/protocol';
import { createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';
import { isOriginAllowed, safeTokenEqual } from '../src/auth/index.js';

describe('safeTokenEqual', () => {
  it('matches identical tokens and rejects everything else', () => {
    expect(safeTokenEqual('abc123', 'abc123')).toBe(true);
    expect(safeTokenEqual('abc123', 'abc124')).toBe(false);
    // Must not throw on a length mismatch — that was the classic timingSafeEqual bug.
    expect(safeTokenEqual('abc123', '')).toBe(false);
    expect(safeTokenEqual('abc123', 'a'.repeat(5000))).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows same-origin requests', () => {
    expect(isOriginAllowed('http://127.0.0.1:8787', null, '127.0.0.1:8787')).toBe(true);
  });

  it('blocks a cross-site origin', () => {
    expect(isOriginAllowed('https://evil.example', null, '127.0.0.1:8787')).toBe(false);
  });

  it('allows non-browser clients that send no Origin', () => {
    expect(isOriginAllowed(undefined, null, '127.0.0.1:8787')).toBe(true);
  });

  it('honours an explicit allowlist', () => {
    expect(isOriginAllowed('https://pocket.ts.net', ['https://pocket.ts.net'], 'other')).toBe(true);
    expect(isOriginAllowed('https://evil.example', ['https://pocket.ts.net'], 'other')).toBe(false);
  });
});

describe('authentication routes', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('issues an HttpOnly SameSite cookie on a correct token', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: TEST_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });

    const cookie = res.cookies[0];
    expect(cookie?.name).toBe(AUTH_COOKIE_NAME);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Strict');
    expect(cookie?.path).toBe('/');
    // The master token must never come back to the client.
    expect(res.body).not.toContain(TEST_TOKEN);
    expect(cookie?.value).not.toBe(TEST_TOKEN);
  });

  it('rejects a wrong token with 401 and no cookie', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'wrong-token-wrong-token-wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_token');
    expect(res.cookies).toHaveLength(0);
  });

  it('rejects a malformed login body', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { nope: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it('rate-limits repeated login attempts', async () => {
    const attempts = [];
    for (let i = 0; i < 12; i++) {
      attempts.push(
        await t.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { token: 'bad-token-bad-token-bad-token-bad' },
        }),
      );
    }
    expect(attempts.some((r) => r.statusCode === 429)).toBe(true);
  });

  it('protects every API route except health and the auth endpoints', async () => {
    for (const url of ['/api/sessions', '/api/workspaces', '/api/agents']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }

    const health = await t.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('ok');
  });

  it('accepts a valid cookie', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a forged cookie', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: `${AUTH_COOKIE_NAME}=not-a-real-session-id` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('invalidates the session on logout', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
    });
    expect(before.statusCode).toBe(200);

    await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: t.cookie } });

    const after = await t.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('expires sessions', async () => {
    const { auth } = t.context;
    const session = auth.createSession(null, Date.now() - 1000 * 60 * 60 * 24 * 400);
    expect(auth.validateSession(session.id)).toBeNull();
  });

  it('reports authentication state via /api/auth/me without requiring auth', async () => {
    const anon = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anon.statusCode).toBe(200);
    expect(anon.json().authenticated).toBe(false);

    const authed = await t.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: t.cookie },
    });
    expect(authed.json().authenticated).toBe(true);
  });

  it('blocks state-changing requests from a foreign origin (CSRF)', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie, origin: 'https://evil.example', host: '127.0.0.1:8787' },
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden_origin');
  });

  it('sets hardening headers', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
