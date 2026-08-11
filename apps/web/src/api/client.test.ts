import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client.js';

function mockFetch(
  status: number,
  body: unknown,
): { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      } as Response;
    }),
  );
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('api.login', () => {
  it('posts the token and never stores it', async () => {
    const { calls } = mockFetch(200, { ok: true, expiresAt: 123 });
    await api.login('secret-token');

    expect(calls[0]?.url).toBe('/api/auth/login');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ token: 'secret-token' }));
    // Cookies do the work; nothing is persisted client-side.
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('surfaces an invalid token as a typed error', async () => {
    mockFetch(401, { error: { code: 'invalid_token', message: 'Invalid access token.' } });

    await expect(api.login('nope')).rejects.toThrow(ApiError);
    await expect(api.login('nope')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_token',
      message: 'Invalid access token.',
      isUnauthorized: true,
    });
  });

  it('surfaces rate limiting distinctly', async () => {
    mockFetch(429, { error: { code: 'rate_limited', message: 'Too many requests' } });
    await expect(api.login('nope')).rejects.toMatchObject({ status: 429 });
  });

  it('does not mistake a non-JSON error page for a valid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway' }) as Response),
    );
    await expect(api.login('x')).rejects.toMatchObject({ code: 'bad_response', status: 502 });
  });
});

describe('api.listSessions', () => {
  it('returns the session array', async () => {
    mockFetch(200, { sessions: [{ id: 'a' }, { id: 'b' }] });
    const result = await api.listSessions();
    expect(result.sessions).toHaveLength(2);
  });

  it('reports an expired cookie as unauthorized', async () => {
    mockFetch(401, { error: { code: 'unauthorized', message: 'Authentication required.' } });
    await expect(api.listSessions()).rejects.toMatchObject({ isUnauthorized: true });
  });
});

describe('api.createSession', () => {
  it('sends only agent, cwd and size — never a command', async () => {
    const { calls } = mockFetch(201, { id: 'new' });
    await api.createSession({ agent: 'claude', cwd: '/home/me/src/app', cols: 100, rows: 30 });

    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({ agent: 'claude', cwd: '/home/me/src/app', cols: 100, rows: 30 });
    expect(Object.keys(body)).not.toContain('command');
  });

  it('propagates a workspace rejection', async () => {
    mockFetch(403, {
      error: { code: 'forbidden', message: 'Directory is outside the configured workspace roots.' },
    });
    await expect(
      api.createSession({ agent: 'shell', cwd: '/etc', cols: 80, rows: 24 }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('api.deleteSession', () => {
  it('URL-encodes the session id', async () => {
    const { calls } = mockFetch(200, { id: 'a/b' });
    await api.deleteSession('a/b');
    expect(calls[0]?.url).toBe('/api/sessions/a%2Fb');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});
