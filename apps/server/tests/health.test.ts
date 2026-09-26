import { describe, expect, it } from 'vitest';
import { HealthResponse, SERVER_PROTOCOL_RANGE } from '@pocketagent/protocol';
import { createTestApp, type TestApp } from './helpers.js';
import { resolveServerVersion } from '../src/version.js';

describe('resolveServerVersion', () => {
  it('prefers the build stamp', () => {
    // How PA-65's image build sets the version without editing a tracked file.
    expect(resolveServerVersion({ POCKETAGENT_BUILD_VERSION: '1.4.2' }).version).toBe('1.4.2');
  });

  it('accepts a prerelease and build-metadata stamp', () => {
    // A CI pipeline will want to stamp something like `1.4.2-rc.1+abc1234`,
    // and rejecting it would push it back to inventing a plain version.
    expect(resolveServerVersion({ POCKETAGENT_BUILD_VERSION: '1.4.2-rc.1+abc1234' }).version).toBe(
      '1.4.2-rc.1+abc1234',
    );
  });

  it('falls back to a real semver when nothing is stamped', () => {
    const { version, warning } = resolveServerVersion({});
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(warning).toBeNull();
  });

  it('ignores a malformed stamp and warns rather than throwing', () => {
    // A bad build stamp is a cosmetic CI bug. Refusing to boot over it would
    // turn that into an outage — but it must not be silent either, or a whole
    // fleet quietly reports the checkout's version and drift detection stops
    // working with no clue why.
    const { version, warning } = resolveServerVersion({ POCKETAGENT_BUILD_VERSION: 'not-a-version' });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(warning).toMatch(/not a valid semver/i);
  });

  it('treats an empty stamp as absent', () => {
    // An unset variable in a shell script is usually an empty string, not a
    // missing key, so this is the common case rather than an edge one.
    expect(resolveServerVersion({ POCKETAGENT_BUILD_VERSION: '  ' }).warning).toBeNull();
  });

  it('appends git short sha when unstamped in a git checkout (PA-108)', () => {
    const { version, warning } = resolveServerVersion({}, () => 'b8f907bc');
    expect(version).toMatch(/^\d+\.\d+\.\d+\+b8f907bc$/);
    expect(warning).toBeNull();
  });

  it('falls back to plain package.json version when git sha is unavailable (PA-108)', () => {
    const { version, warning } = resolveServerVersion({}, () => null);
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(warning).toBeNull();
  });
});

describe('GET /health', () => {
  let t: TestApp;

  async function withApp<T>(fn: (app: TestApp) => Promise<T>): Promise<T> {
    t = await createTestApp();
    try {
      return await fn(t);
    } finally {
      await t.cleanup();
    }
  }

  it('answers without a cookie and matches its own schema', async () => {
    await withApp(async (app) => {
      // Unauthenticated by design: a Hub has to decide whether a backend is
      // usable before it can present a credential to it. `HealthResponse` is
      // parsed rather than eyeballed because the schema is now load-bearing —
      // the browser's own probe parses it, and a host whose shape fails it is
      // reported unreachable.
      const res = await app.app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const parsed = HealthResponse.safeParse(res.json());
      expect(parsed.success).toBe(true);
    });
  });

  it('reports a real semver, not a hardcoded literal', async () => {
    await withApp(async (app) => {
      const res = await app.app.inject({ method: 'GET', url: '/health' });
      expect(res.json().version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  it('reports the protocol range the socket actually enforces', async () => {
    await withApp(async (app) => {
      const res = await app.app.inject({ method: 'GET', url: '/health' });
      expect(res.json().protocol).toEqual(SERVER_PROTOCOL_RANGE);
      expect(res.json().protocol.min).toBeLessThanOrEqual(res.json().protocol.max);
    });
  });

  it('exposes nothing beyond the four documented fields', async () => {
    await withApp(async (app) => {
      // The acceptance criterion, as an assertion rather than a promise:
      // `/health` is unauthenticated, so anything added here is readable by
      // anyone who can reach the port. A git SHA, build host, Node version,
      // config value or path belongs behind the cookie instead. If this fails,
      // the question is not "update the test" but "should that be public?".
      const res = await app.app.inject({ method: 'GET', url: '/health' });
      expect(Object.keys(res.json()).sort()).toEqual([
        'protocol',
        'status',
        'uptimeSeconds',
        'version',
      ]);
    });
  });

  it('is reported identically on HostInfo, so the two cannot drift', async () => {
    await withApp(async (app) => {
      // `/health` is the pre-auth view and `/api/hosts` the post-auth one; a
      // client that negotiated against one and connected using the other would
      // be making a decision on stale facts.
      const health = await app.app.inject({ method: 'GET', url: '/health' });
      const hosts = await app.app.inject({
        method: 'GET',
        url: '/api/hosts',
        headers: { cookie: app.cookie },
      });
      const host = hosts.json().hosts[0];
      expect(host.protocol).toEqual(health.json().protocol);
      expect(host.version).toEqual(health.json().version);
    });
  });
});
