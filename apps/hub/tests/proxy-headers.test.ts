import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestHub,
  registerHost,
  startStubBackend,
  type StubBackend,
  type TestHub,
} from './helpers.js';

describe('header hygiene on the way up', () => {
  let hub: TestHub;
  let backend: StubBackend;

  beforeEach(async () => {
    backend = await startStubBackend();
    hub = await createTestHub();
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl, credential: 'pah_secret-cred' });
  });

  afterEach(async () => {
    await hub.cleanup();
    await backend.close();
  });

  it('presents the host credential and never the browser cookie', async () => {
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    const received = backend.requests[0];
    expect(received?.headers.authorization).toBe('Bearer pah_secret-cred');
    // The Hub's session cookie means nothing to a backend, and a credential
    // should only ever travel where it can be used.
    expect(received?.headers.cookie).toBeUndefined();
  });

  it('strips Origin rather than forwarding it', async () => {
    // The single likeliest way to get this whole feature subtly wrong.
    // `isOriginAllowed` falls back to comparing the Origin's host against the
    // `Host` the request was routed to — the backend's — so a forwarded
    // Origin 403s every write while every read keeps working.
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      method: 'POST',
      headers: {
        cookie: hub.cookie,
        origin: hub.baseUrl,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(backend.requests[0]?.headers.origin).toBeUndefined();
  });

  it('rewrites Host to the backend authority', async () => {
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } });
    expect(backend.requests[0]?.headers.host).toBe(new URL(backend.baseUrl).host);
  });

  it('replaces any client-supplied forwarding claim', async () => {
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie, 'x-forwarded-for': '203.0.113.9' },
    });
    // The Hub is the first hop that actually observed the peer, so it is the
    // only one entitled to assert this. A client's own claim is discarded.
    expect(backend.requests[0]?.headers['x-forwarded-for']).not.toBe('203.0.113.9');
    expect(backend.requests[0]?.headers['x-forwarded-proto']).toBe('http');
  });

  it("refuses a client's own bearer rather than relaying it", async () => {
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie, authorization: 'Bearer pah_someone-elses-token' },
    });
    expect(backend.requests[0]?.headers.authorization).toBe('Bearer pah_secret-cred');
  });

  it('forwards a request body byte-identically', async () => {
    // Not "the JSON is equivalent" — the bytes. A proxy that round-trips a
    // body through `JSON.parse`/`JSON.stringify` preserves key order but not
    // whitespace, unicode escaping or number formatting, which is the exact
    // failure `routes/webhook-delivery.ts` exists to avoid on the other side.
    const body = '{ "a" :  1,\n  "b": "\\u00e9\\ud83d\\ude00", "c": 1.50 }';
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body,
    });
    const received = backend.requests[0]?.body ?? Buffer.alloc(0);
    expect(crypto.createHash('sha256').update(received).digest('hex')).toBe(
      crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'),
    );
  });

  it('forwards a large binary body without buffering it into an object', async () => {
    const body = crypto.randomBytes(512 * 1024);
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/octet-stream' },
      body,
    });
    expect(backend.requests[0]?.body.equals(body)).toBe(true);
  });

  it('cannot be used to smuggle a second request onto the backend socket', async () => {
    // The whole allowlist is worthless if a body can carry a request line.
    // Node's `ClientRequest` does not set chunked framing by default for
    // GET/HEAD/DELETE/OPTIONS/TRACE, so stripping the client's
    // `content-length` and piping a body left those methods framed by
    // *nothing* — on a keep-alive pooled socket, which desyncs the connection
    // and makes the trailing bytes a second request the backend executes.
    // That request never passes `resolveProxyTarget`, so it reaches exactly
    // the routes the deny list exists to protect.
    const smuggled =
      'POST /api/hooks/evil HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n';
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie, 'content-type': 'text/plain' },
      body: smuggled,
    });
    // Give a smuggled request time to be parsed off the pooled socket.
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const urls = backend.requests.map((request) => request.url);
    expect(urls).not.toContain('/api/hooks/evil');
    expect(urls.every((url) => url === '/api/sessions')).toBe(true);
  });

  it('frames every method that can carry a body', async () => {
    for (const method of ['DELETE', 'POST', 'PUT', 'PATCH', 'OPTIONS']) {
      backend.requests.length = 0;
      await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
        method,
        headers: { cookie: hub.cookie, 'content-type': 'text/plain' },
        body: 'abcde',
      });
      const received = backend.requests[0];
      const framed =
        received?.headers['content-length'] !== undefined ||
        /chunked/i.test(String(received?.headers['transfer-encoding'] ?? ''));
      expect(framed, `${method} must be framed upstream`).toBe(true);
      expect(received?.body.toString(), method).toBe('abcde');
    }
  });

  it('sends no body, and no framing, when the client sent none', async () => {
    await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } });
    const received = backend.requests[0];
    expect(received?.headers['content-length']).toBeUndefined();
    expect(received?.headers['transfer-encoding']).toBeUndefined();
    expect(received?.body.length).toBe(0);
  });

  it('leaves sibling Hub routes parsing JSON as before', async () => {
    // The parser removal is scoped to the proxy's own plugin. If it ever
    // leaked, this registry POST would stop seeing a parsed body — the same
    // encapsulation assertion `webhooks.test.ts` makes on the backend.
    const response = await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev02', label: 'dev02', baseUrl: 'http://127.0.0.1:9' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('header hygiene on the way down', () => {
  let hub: TestHub;
  let backend: StubBackend;

  beforeEach(async () => {
    backend = await startStubBackend();
    hub = await createTestHub();
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl });
  });

  afterEach(async () => {
    await hub.cleanup();
    await backend.close();
  });

  it('never lets a backend set a cookie on the Hub origin', async () => {
    backend.respondWith((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'pocketagent_hub_sid=attacker; Path=/',
      });
      response.end('{}');
    });
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('streams a response through without buffering it', async () => {
    // `text/event-stream` is the case that matters: the planner's turns and
    // PA-68's install log both depend on chunks arriving as they are written.
    backend.respondWith((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: one\n\n');
      setTimeout(() => {
        response.write('data: two\n\n');
        response.end();
      }, 30);
    });
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/planner/stream`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    // Arrived before the backend had written the second frame, so nothing
    // waited for the response to complete.
    expect(new TextDecoder().decode(first.value)).toContain('one');
    await reader.cancel();
  });

  it('translates a rejected credential into 502, not 401', async () => {
    // PA-66 D21. `App.tsx` drops the *whole* app to the login screen on any
    // 401, so passing this through would sign the operator out of every other
    // host because one credential was revoked.
    backend.respondWith((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }));
    });
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('host_credential_rejected');
  });

  it('relays 403 domain errors as 403 without translating to 502', async () => {
    // A 403 from the backend is a domain error (e.g. directory outside roots,
    // forbidden path, bad CSRF origin), NOT a rejected Hub credential. The
    // Hub must relay it as 403 so the error message remains consistent.
    backend.respondWith((_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { code: 'forbidden', message: 'Directory is outside the configured workspace roots.' },
        }),
      );
    });
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/adoptable`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'shell', cwd: '/some/outside/path' }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toBe('Directory is outside the configured workspace roots.');
  });

  it("relays the backend's own security headers", async () => {
    // A proxied body is the backend's, so its `nosniff`/CSP should govern it.
    // `reply.hijack()` skips the Hub's own `onSend`, which is correct here
    // precisely because these come through instead of being replaced.
    backend.respondWith((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      response.end('{}');
    });
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it("hardens the Hub's own hijacked error responses", async () => {
    // These are the only bodies the Hub writes outside Fastify's lifecycle,
    // so without explicit headers they would be its only unhardened ones.
    registerHost(hub, { id: 'dead2', baseUrl: 'http://127.0.0.1:1' });
    const response = await fetch(`${hub.baseUrl}/h/dead2/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('rewrites a Location naming the backend, and leaves off-site ones alone', async () => {
    // A backend redirecting has no idea it is behind a gateway, so an
    // absolute Location names its own origin — which on the Hub's origin is
    // both an open redirect and a disclosure of the internal address.
    backend.respondWith((request, response) => {
      const to =
        request.url === '/api/away'
          ? 'https://example.com/elsewhere'
          : `${backend.baseUrl}/api/sessions/1?x=2`;
      response.writeHead(302, { location: to });
      response.end();
    });
    const mine = await fetch(`${hub.baseUrl}/h/dev01/api/go`, {
      headers: { cookie: hub.cookie },
      redirect: 'manual',
    });
    expect(mine.headers.get('location')).toBe('/h/dev01/api/sessions/1?x=2');

    const away = await fetch(`${hub.baseUrl}/h/dev01/api/away`, {
      headers: { cookie: hub.cookie },
      redirect: 'manual',
    });
    // A genuine off-site redirect is not ours to rewrite.
    expect(away.headers.get('location')).toBe('https://example.com/elsewhere');
  });

  it('answers 502 when the backend cannot be reached at all', async () => {
    registerHost(hub, { id: 'dead', baseUrl: 'http://127.0.0.1:1' });
    const response = await fetch(`${hub.baseUrl}/h/dead/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('host_unreachable');
  });
});
