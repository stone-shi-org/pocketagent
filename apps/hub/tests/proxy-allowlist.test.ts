import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROXY_DENY_PREFIXES, resolveProxyTarget } from '../src/proxy/allowlist.js';
import { createTestHub, registerHost, startStubBackend, type StubBackend, type TestHub } from './helpers.js';

describe('resolveProxyTarget', () => {
  it('routes a host API path and keeps the query', () => {
    expect(resolveProxyTarget('/h/dev01/api/sessions?limit=5')).toEqual({
      kind: 'proxy',
      hostId: 'dev01',
      upstreamPath: '/api/sessions?limit=5',
    });
  });

  it('mounts the default host at the bare root (D6b)', () => {
    expect(resolveProxyTarget('/api/projects')).toEqual({
      kind: 'proxy',
      hostId: null,
      upstreamPath: '/api/projects',
    });
  });

  it("keeps the Hub's own namespaces away from the default host", () => {
    expect(resolveProxyTarget('/api/hub/hosts').kind).toBe('hub');
    expect(resolveProxyTarget('/api/auth/login').kind).toBe('hub');
    expect(resolveProxyTarget('/health').kind).toBe('hub');
  });

  it('proxies /health under a host prefix, for protocol negotiation', () => {
    expect(resolveProxyTarget('/h/dev01/health')).toEqual({
      kind: 'proxy',
      hostId: 'dev01',
      upstreamPath: '/health',
    });
  });

  it('serves everything else from the Hub bundle', () => {
    expect(resolveProxyTarget('/assets/index-abc.js').kind).toBe('static');
    expect(resolveProxyTarget('/').kind).toBe('static');
  });

  it('refuses a non-API path under a host prefix', () => {
    // A backend answers any non-API path with its own copy of the SPA shell
    // and a 200, so forwarding this would serve a second, differently-based
    // bundle from inside the Hub's origin.
    expect(resolveProxyTarget('/h/dev01/assets/x.js').kind).toBe('reject');
    expect(resolveProxyTarget('/h/dev01/').kind).toBe('reject');
  });

  it('refuses a percent-encoded host id rather than desynchronising the paths', () => {
    // `/h/%61bc/...` decodes to host `abc`; taking the offset from the decoded
    // id and slicing the raw path with it forwarded `bc/api/sessions` while
    // the deny list had been evaluated against `/api/sessions`.
    expect(resolveProxyTarget('/h/%61bc/api/sessions').kind).toBe('reject');
    expect(resolveProxyTarget('/h/de%7601/api/sessions').kind).toBe('reject');
  });

  it('keeps the validated path and the forwarded path in step', () => {
    // The property the above protects, stated directly: whatever is forwarded
    // must be what the deny list saw, modulo encoding that cannot change a
    // segment boundary.
    const target = resolveProxyTarget('/h/dev01/api/sessions/a%3Ab?x=1');
    expect(target).toEqual({
      kind: 'proxy',
      hostId: 'dev01',
      // `%3A` survives: re-encoding a decoded path is the lossy round trip
      // this module refuses to perform.
      upstreamPath: '/api/sessions/a%3Ab?x=1',
    });
  });

  it('refuses a host id that is not one', () => {
    expect(resolveProxyTarget('/h/UPPER/api/x').kind).toBe('reject');
    expect(resolveProxyTarget('/h/has_underscore/api/x').kind).toBe('reject');
    expect(resolveProxyTarget('/h//api/x').kind).toBe('reject');
  });

  describe('the hooks exclusion (PA-66 hard constraint #1)', () => {
    it('refuses the literal path', () => {
      expect(resolveProxyTarget('/h/dev01/api/hooks/foo').kind).toBe('reject');
      expect(resolveProxyTarget('/api/hooks/foo').kind).toBe('reject');
    });

    it('refuses every spelling that could decode to it', () => {
      // Reject-not-canonicalize: each of these is refused because of the
      // characters it contains, before any matching happens, so the deny
      // check below never has to reason about encodings.
      for (const url of [
        '/h/dev01/api/%68ooks/foo',
        '/h/dev01/api/hooks%2Ffoo',
        '/h/dev01/api/./hooks/foo',
        '/h/dev01/api/x/../hooks/foo',
        '/h/dev01/api/%2568ooks/foo',
        '/h/dev01/api\\hooks\\foo',
      ]) {
        expect(resolveProxyTarget(url).kind, url).toBe('reject');
      }
    });

    it('refuses the bare path with no trailing slash', () => {
      expect(resolveProxyTarget('/h/dev01/api/hooks').kind).toBe('reject');
      expect(resolveProxyTarget('/api/hooks').kind).toBe('reject');
    });

    it('refuses a case variant even though the backend would 404 it', () => {
      expect(resolveProxyTarget('/h/dev01/api/HOOKS/foo').kind).toBe('reject');
      expect(resolveProxyTarget('/h/dev01/api/Hooks/foo').kind).toBe('reject');
    });
  });

  it("refuses the rest of the backend's unauthenticated surface", () => {
    // The stated invariant is broader than hooks: nothing in a backend's
    // `PUBLIC_API_PATHS` is reachable through `/h/`.
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/hub-bind', '/api/auth/me']) {
      expect(resolveProxyTarget(`/h/dev01${path}`).kind, path).toBe('reject');
    }
  });

  it('still proxies per-host hub credential management', () => {
    // `/api/auth/hubs` is behind the gate and is what Settings → Hubs reads,
    // so it must not be caught by the `/api/auth/hub-bind` deny entry.
    expect(resolveProxyTarget('/h/dev01/api/auth/hubs').kind).toBe('proxy');
  });

  it('names a reason for every deny entry', () => {
    for (const entry of PROXY_DENY_PREFIXES) expect(entry.why.length).toBeGreaterThan(10);
  });
});

describe('the proxy refuses without dialing the backend', () => {
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

  it('404s a hooks delivery and never reaches the backend', async () => {
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/hooks/foo`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(404);
    // The assertion that matters. A 404 could also come *from* the backend;
    // what must be true is that nothing was forwarded at all.
    expect(backend.requests).toHaveLength(0);
  });

  it('refuses a hooks upgrade too', async () => {
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/hooks/foo`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(404);
    expect(backend.requests).toHaveLength(0);
  });

  it('answers a refused path and an unknown host identically', async () => {
    const refused = await fetch(`${hub.baseUrl}/h/dev01/api/hooks/foo`, {
      headers: { cookie: hub.cookie },
    });
    const unknown = await fetch(`${hub.baseUrl}/h/nosuchhost/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(refused.status).toBe(unknown.status);
    expect(await refused.text()).toBe(await unknown.text());
  });

  it('proxies an ordinary API path', async () => {
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(200);
    expect(backend.requests).toHaveLength(1);
    expect(backend.requests[0]?.url).toBe('/api/sessions');
  });
});
