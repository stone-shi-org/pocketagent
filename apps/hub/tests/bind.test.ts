import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HUB_TOKEN_SCHEME_PREFIX } from '@pocketagent/protocol';
import { createTestApp, TEST_TOKEN, type TestApp } from '../../server/tests/helpers.js';
import { createTestHub, type TestHub } from './helpers.js';

/**
 * The one suite that talks to a **real** PocketAgent backend rather than the
 * stub, because what it verifies is the PA-63 contract itself: that
 * `POST /api/auth/hub-bind` really does exchange a master token for a
 * revocable credential, that the credential really does authenticate
 * subsequent requests, and that revoking it from the backend really does take
 * effect on the Hub's next call. A stub could only prove the Hub sends the
 * shapes it believes in.
 */
describe('binding a host, against a real backend', () => {
  let backend: TestApp;
  let backendUrl: string;
  let hub: TestHub;

  beforeEach(async () => {
    backend = await createTestApp();
    await backend.app.listen({ host: '127.0.0.1', port: 0 });
    const address = backend.app.server.address() as AddressInfo;
    backendUrl = `http://127.0.0.1:${address.port}`;
    hub = await createTestHub();
    await fetch(`${hub.baseUrl}/api/hub/hosts`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'dev01', label: 'dev01', baseUrl: backendUrl }),
    });
  });

  afterEach(async () => {
    await hub.cleanup();
    await backend.cleanup();
  });

  const bind = (token: string): Promise<Response> =>
    fetch(`${hub.baseUrl}/api/hub/hosts/dev01/bind`, {
      method: 'POST',
      headers: { cookie: hub.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ token, label: 'test hub' }),
    });

  it('exchanges the master token for a scoped credential', async () => {
    const response = await bind(TEST_TOKEN);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      host: { boundAt: number | null; credentialPrefix: string | null };
    };
    expect(body.host.boundAt).not.toBeNull();
    expect(body.host.credentialPrefix).toContain(HUB_TOKEN_SCHEME_PREFIX);

    // The backend now lists it, which is the property the master token could
    // never offer: visibility, and a way to cut this Hub off.
    const hubs = (await (
      await fetch(`${backendUrl}/api/auth/hubs`, { headers: { cookie: backend.cookie } })
    ).json()) as { hubs: { label: string }[] };
    expect(hubs.hubs.map((row) => row.label)).toContain('test hub');
  });

  it('never writes the master token anywhere in its database', async () => {
    await bind(TEST_TOKEN);
    // Scanned, not assumed. Every value of every column of every row.
    const tables = hub.context.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    let scanned = 0;
    for (const table of tables) {
      const rows = hub.context.db.prepare(`SELECT * FROM "${table.name}"`).all() as Record<
        string,
        unknown
      >[];
      for (const row of rows) {
        for (const value of Object.values(row)) {
          scanned += 1;
          if (typeof value === 'string') expect(value).not.toContain(TEST_TOKEN);
        }
      }
    }
    expect(scanned).toBeGreaterThan(0);
  });

  it('stores the credential encrypted, not in the clear', async () => {
    await bind(TEST_TOKEN);
    const row = hub.context.registry.getRow('dev01')!;
    const plaintext = hub.context.registry.credentialFor(row)!;
    expect(plaintext.startsWith(HUB_TOKEN_SCHEME_PREFIX)).toBe(true);
    // The stored form is the AES-GCM envelope, and the token is not a
    // substring of it.
    expect(row.credential_enc).not.toBeNull();
    expect(row.credential_enc).not.toContain(plaintext);
    expect(row.credential_prefix).toBe(plaintext.slice(0, row.credential_prefix!.length));
  });

  it('proxies with the minted credential once bound', async () => {
    await bind(TEST_TOKEN);
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/hosts`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { hosts: { id: string }[] };
    expect(body.hosts).toHaveLength(1);
  });

  it('records the backend host id for the identity-drift check', async () => {
    await bind(TEST_TOKEN);
    const row = hub.context.registry.getRow('dev01')!;
    expect(row.backend_host_id).not.toBeNull();
    expect(hub.context.registry.entryFor(row).identityChanged).toBe(false);
  });

  it('rejects a wrong master token without binding', async () => {
    const response = await bind('definitely-not-the-token-but-long-enough');
    expect(response.status).toBe(401);
    expect(hub.context.registry.getRow('dev01')?.bound_at).toBeNull();
  });

  it('stops working the moment the backend revokes the credential', async () => {
    await bind(TEST_TOKEN);
    const hubs = (await (
      await fetch(`${backendUrl}/api/auth/hubs`, { headers: { cookie: backend.cookie } })
    ).json()) as { hubs: { id: string }[] };
    const credentialId = hubs.hubs[0]!.id;

    await fetch(`${backendUrl}/api/auth/hubs/${credentialId}`, {
      method: 'DELETE',
      headers: { cookie: backend.cookie },
    });

    // No restart on either side: the backend validates the row per request,
    // and the Hub reports the rejection as 502 rather than passing a 401 on.
    const response = await fetch(`${hub.baseUrl}/h/dev01/api/hosts`, {
      headers: { cookie: hub.cookie },
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('host_credential_rejected');
  });

  it('revokes on the backend when a host is removed, and says whether it did', async () => {
    await bind(TEST_TOKEN);
    const response = await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    expect(await response.json()).toMatchObject({ ok: true, revokedOnBackend: true });
    const hubs = (await (
      await fetch(`${backendUrl}/api/auth/hubs`, { headers: { cookie: backend.cookie } })
    ).json()) as { hubs: unknown[] };
    expect(hubs.hubs).toHaveLength(0);
  });

  it('still removes a host whose backend is unreachable, and says it did not revoke', async () => {
    // Blocking here would mean a machine that is *down* — precisely when an
    // operator most wants it gone — could not be removed.
    await bind(TEST_TOKEN);
    await backend.app.close();
    const response = await fetch(`${hub.baseUrl}/api/hub/hosts/dev01`, {
      method: 'DELETE',
      headers: { cookie: hub.cookie },
    });
    expect(await response.json()).toMatchObject({ ok: true, revokedOnBackend: false });
    expect(hub.context.registry.getRow('dev01')).toBeNull();
  });

  it('lists a host whose credential will not decrypt, rather than dropping it', async () => {
    await bind(TEST_TOKEN);
    // Simulate a rotated POCKETAGENT_SETTINGS_ENC_KEY by replacing the stored
    // envelope with one encrypted under a different key.
    const other = crypto.randomBytes(32);
    const { encryptSecret } = await import('@pocketagent/node-kit');
    hub.context.db
      .prepare('UPDATE hub_hosts SET credential_enc = ? WHERE id = ?')
      .run(encryptSecret('pah_whatever', other), 'dev01');

    const listed = (await (
      await fetch(`${hub.baseUrl}/api/hub/hosts`, { headers: { cookie: hub.cookie } })
    ).json()) as { hosts: { id: string }[] };
    // Listed and visibly unbound, not vanished — a rotated key must look like
    // a repairable state, not like a host that disappeared.
    expect(listed.hosts.map((host) => host.id)).toEqual(['dev01']);

    const proxied = await fetch(`${hub.baseUrl}/h/dev01/api/hosts`, {
      headers: { cookie: hub.cookie },
    });
    expect(proxied.status).toBe(409);
  });
});
