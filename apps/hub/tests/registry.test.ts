import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createTestHub,
  registerHost,
  startStubBackend,
  type StubBackend,
  type TestHub,
} from './helpers.js';

describe('the host registry', () => {
  let hub: TestHub;
  let backend: StubBackend;

  beforeEach(async () => {
    backend = await startStubBackend();
    hub = await createTestHub();
  });

  afterEach(async () => {
    await hub.cleanup();
    await backend.close();
  });

  const list = async (): Promise<{ hosts: { id: string; isDefault: boolean }[] }> => {
    const response = await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      headers: { cookie: hub.cookie },
    });
    return (await response.json()) as { hosts: { id: string; isDefault: boolean }[] };
  };

  const add = (id: string, baseUrl = backend.baseUrl): Promise<Response> =>
    fetch(`${hub.baseUrl}/api/hub/hosts`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id, label: id, baseUrl }),
    });

  it('makes the first host the default', async () => {
    await add('dev01');
    await add('dev02');
    const body = await list();
    expect(body.hosts.map((host) => host.id)).toEqual(['dev01', 'dev02']);
    expect(body.hosts.filter((host) => host.isDefault).map((host) => host.id)).toEqual(['dev01']);
  });

  it('refuses a duplicate id and a bad base URL', async () => {
    expect((await add('dev01')).status).toBe(200);
    expect((await add('dev01')).status).toBe(409);
    expect((await add('dev03', 'not-a-url')).status).toBe(400);
    expect((await add('dev04', 'ftp://x')).status).toBe(400);
    // A path on a base URL silently changes what every proxied request
    // resolves to, since `new URL('/api/x', base)` discards it.
    expect((await add('dev05', 'http://host:8787/prefix')).status).toBe(400);
  });

  it('refuses an id that is not a slug', async () => {
    expect((await add('Dev01')).status).toBe(400);
    expect((await add('dev_01')).status).toBe(400);
    expect((await add('../etc')).status).toBe(400);
  });

  it('keeps exactly one default when another is promoted', async () => {
    await add('dev01');
    await add('dev02');
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev02`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    const body = await list();
    expect(body.hosts.filter((host) => host.isDefault).map((host) => host.id)).toEqual(['dev02']);
  });

  it('promotes a survivor when the default is removed', async () => {
    // Otherwise the bare `/api/*` mount is unrouted and the Hub's own UI
    // cannot load, which presents as "the Hub is broken".
    await add('dev01');
    await add('dev02');
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    const body = await list();
    expect(body.hosts.filter((host) => host.isDefault).map((host) => host.id)).toEqual(['dev02']);
  });

  it('stops proxying immediately when a host is removed', async () => {
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl });
    expect(
      (await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } }))
        .status,
    ).toBe(200);
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    // No restart, no cache to invalidate: the row is read on every request.
    expect(
      (await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } }))
        .status,
    ).toBe(404);
  });

  it('destroys live sockets when a host is removed', async () => {
    // The registry alone cannot satisfy "removing a host stops all proxying
    // immediately": a spliced socket outlives the request that created it.
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl });
    const socket = new WebSocket(`${hub.baseUrl.replace('http', 'ws')}/h/dev01/api/ws?v=15`, {
      headers: { cookie: hub.cookie },
    });
    await new Promise((resolve) => socket.once('open', resolve));
    expect(hub.context.sockets.countFor('dev01')).toBeGreaterThan(0);

    const closed = new Promise((resolve) => socket.once('close', resolve));
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    await closed;
    expect(hub.context.sockets.countFor('dev01')).toBe(0);
  });

  it('destroys live sockets when a host is merely disabled', async () => {
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl });
    const socket = new WebSocket(`${hub.baseUrl.replace('http', 'ws')}/h/dev01/api/ws?v=15`, {
      headers: { cookie: hub.cookie },
    });
    await new Promise((resolve) => socket.once('open', resolve));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    await closed;
    expect(
      (await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, { headers: { cookie: hub.cookie } }))
        .status,
    ).toBe(404);
  });

  it('answers a disabled host and an unknown host identically', async () => {
    // So that reaching the Hub does not let someone enumerate which machines
    // are behind it — the same posture the backend takes for an unknown slug.
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl });
    await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'PATCH',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const disabled = await fetch(`${hub.baseUrl}/h/dev01/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    const unknown = await fetch(`${hub.baseUrl}/h/nope/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(disabled.status).toBe(unknown.status);
    expect(await disabled.text()).toBe(await unknown.text());
  });

  it('refuses to proxy an unbound host rather than dialing without a credential', async () => {
    // A dial without a credential lands on the backend as a 401, which would
    // read as the backend's fault instead of "this was never bound".
    await add('unbound');
    const response = await fetch(`${hub.baseUrl}/h/unbound/api/sessions`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(409);
    expect(backend.requests).toHaveLength(0);
  });

  it('reports latestRelease when configured, null otherwise', async () => {
    const body = (await (
      await fetch(`${hub.baseUrl}/api/hub/hosts`, { headers: { cookie: hub.cookie } })
    ).json()) as { latestRelease: string | null };
    expect(body.latestRelease).toBeNull();

    const configured = await createTestHub({ config: { latestRelease: '9.9.9' } });
    try {
      const other = (await (
        await fetch(`${configured.baseUrl}/api/hub/hosts`, { headers: { cookie: configured.cookie } })
      ).json()) as { latestRelease: string | null };
      expect(other.latestRelease).toBe('9.9.9');
    } finally {
      await configured.cleanup();
    }
  });
});
