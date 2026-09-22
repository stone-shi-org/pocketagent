import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, createApiClient } from './client.js';
import { DEFAULT_HOST, hostEndpoint } from './host.js';

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

// PA-60: the host is an explicit endpoint rather than the page's own origin.
describe('createApiClient: host base path', () => {
  it('emits byte-identical URLs for the default host', async () => {
    const { calls } = mockFetch(200, { sessions: [] });
    await createApiClient(DEFAULT_HOST).listSessions();
    // The whole point of an empty base path: nothing about the wire changed.
    expect(calls[0]?.url).toBe('/api/sessions');
  });

  it("is indistinguishable from the module-level `api` for the default host", async () => {
    const { calls } = mockFetch(200, { sessions: [] });
    await api.listSessions();
    await createApiClient(DEFAULT_HOST).listSessions();
    expect(calls[0]?.url).toBe(calls[1]?.url);
  });

  it('prefixes every request for a non-empty base path', async () => {
    const { calls } = mockFetch(200, { sessions: [] });
    const client = createApiClient(hostEndpoint('workbench-02', '/h/workbench-02'));
    await client.listSessions();
    expect(calls[0]?.url).toBe('/h/workbench-02/api/sessions');
  });

  it('keeps the base path in front of an encoded path segment', async () => {
    const { calls } = mockFetch(200, { id: 'a/b' });
    const client = createApiClient(hostEndpoint('h2', '/h/h2'));
    await client.deleteSession('a/b');
    expect(calls[0]?.url).toBe('/h/h2/api/sessions/a%2Fb');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('still authenticates same-origin, since a base path is a prefix not an origin', async () => {
    const { calls } = mockFetch(200, { ok: true });
    await createApiClient(hostEndpoint('h2', '/h/h2')).logout();
    // A cross-origin base URL would have to switch to `credentials: 'include'`
    // plus CORS; the path-prefix design is what keeps the cookie model intact.
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('routes two clients independently from one module', async () => {
    const { calls } = mockFetch(200, { sessions: [] });
    await createApiClient(DEFAULT_HOST).listSessions();
    await createApiClient(hostEndpoint('h2', '/h/h2')).listSessions();
    expect(calls.map((c) => c.url)).toEqual(['/api/sessions', '/h/h2/api/sessions']);
  });

  it('prefixes the streamed planner endpoint too, which builds its own fetch', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        return { ok: true, status: 200, body: null } as unknown as Response;
      }),
    );
    await createApiClient(hostEndpoint('h2', '/h/h2')).sendPlannerMessage(
      'chat-1',
      { content: 'hi' },
      () => {},
    );
    expect(calls[0]).toBe('/h/h2/api/planner/chats/chat-1/messages');
  });
});

describe('api voice test methods (PA-81)', () => {
  it('testVoiceStt posts model and liveSttUrl payload', async () => {
    const { calls } = mockFetch(200, { ok: true, transcript: 'hello', durationMs: 120 });
    const res = await api.testVoiceStt({ liveSttUrl: 'http://10.0.0.1:8000', model: 'whisper' });

    expect(calls[0]?.url).toBe('/api/voice/test-stt');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      liveSttUrl: 'http://10.0.0.1:8000',
      model: 'whisper',
    });
    expect(res).toEqual({ ok: true, transcript: 'hello', durationMs: 120 });
  });

  it('testVoiceTts posts model and liveSttUrl payload', async () => {
    const { calls } = mockFetch(200, { ok: true, audio: 'abc', sampleRateHz: 24000, durationMs: 150 });
    const res = await api.testVoiceTts({ liveSttUrl: 'http://10.0.0.1:8000', model: 'kokoro' });

    expect(calls[0]?.url).toBe('/api/voice/test-tts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      liveSttUrl: 'http://10.0.0.1:8000',
      model: 'kokoro',
    });
    expect(res).toEqual({ ok: true, audio: 'abc', sampleRateHz: 24000, durationMs: 150 });
  });

  it('listVoiceModels fetches /api/voice/models', async () => {
    const { calls } = mockFetch(200, { models: [{ id: 'm1', type: 'asr' }] });
    const res = await api.listVoiceModels();

    expect(calls[0]?.url).toBe('/api/voice/models');
    expect(res.models).toHaveLength(1);
  });
});
