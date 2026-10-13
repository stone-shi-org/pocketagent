import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_PROTOCOL_RANGE } from '@pocketagent/protocol';
import { HealthPoller } from '../src/registry/health.js';
import { HostRegistry } from '../src/registry/store.js';
import { openHubDatabase } from '../src/db.js';
import { testEncKey } from './helpers.js';

function makeRegistry(): HostRegistry {
  return new HostRegistry(openHubDatabase(':memory:'), testEncKey());
}

/** A `fetch` that answers per-host, and can hang forever for one of them. */
function fakeFetch(
  routes: Record<string, () => Promise<Response> | Response>,
): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const signal = init?.signal;
        const answer = handler();
        if (answer instanceof Promise && signal) {
          return await Promise.race([
            answer,
            new Promise<Response>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
          ]);
        }
        return await answer;
      }
    }
    throw new Error(`unrouted ${url}`);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function healthBody(version: string): Response {
  return new Response(
    JSON.stringify({
      status: 'ok',
      version,
      protocol: SERVER_PROTOCOL_RANGE,
      uptimeSeconds: 1,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('the health poller', () => {
  let registry: HostRegistry;

  beforeEach(() => {
    registry = makeRegistry();
  });

  afterEach(() => {
    // no-op; each test stops its own poller
  });

  it('records version and protocol from a healthy backend', async () => {
    registry.create({ id: 'good', label: 'good', baseUrl: 'http://good.test' });
    const { impl } = fakeFetch({ 'http://good.test': () => healthBody('1.4.2') });
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();

    const entry = registry.list()[0]!;
    expect(entry.status.online).toBe(true);
    expect(entry.status.version).toBe('1.4.2');
    expect(entry.status.protocol).toEqual(SERVER_PROTOCOL_RANGE);
    expect(entry.status.error).toBeNull();
  });

  it('does not let one dead host delay or fail the others', async () => {
    // Acceptance criterion 5, and the reason this is one loop per host rather
    // than CronService's single shared tick: a shared tick awaiting each host
    // in turn would make one unresponsive machine delay every other dot by up
    // to its own timeout.
    registry.create({ id: 'slow', label: 'slow', baseUrl: 'http://slow.test' });
    registry.create({ id: 'fast', label: 'fast', baseUrl: 'http://fast.test' });
    const { impl } = fakeFetch({
      'http://slow.test': () => new Promise<Response>(() => undefined),
      'http://fast.test': () => healthBody('1.4.2'),
    });
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    // Deliberately not awaited: the point is that `fast` resolves while
    // `slow` is still hanging.
    void poller.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const byId = Object.fromEntries(registry.list().map((entry) => [entry.id, entry]));
    expect(byId.fast?.status.online).toBe(true);
    expect(byId.slow?.status.online).toBe(false);
    poller.stop();
  });

  it('reports an unreadable body as offline with a reason, not a crash', async () => {
    registry.create({ id: 'old', label: 'old', baseUrl: 'http://old.test' });
    const { impl } = fakeFetch({
      'http://old.test': () => new Response('<html>not json</html>', { status: 200 }),
    });
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();

    const entry = registry.list()[0]!;
    expect(entry.status.online).toBe(false);
    expect(entry.status.error).toContain('older build');
  });

  it('reports a non-200 with its status', async () => {
    registry.create({ id: 'bad', label: 'bad', baseUrl: 'http://bad.test' });
    const { impl } = fakeFetch({ 'http://bad.test': () => new Response('', { status: 503 }) });
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();
    expect(registry.list()[0]?.status.error).toContain('503');
  });

  it('probes without a credential, so an unbound host still shows up', async () => {
    // What makes "add by base URL, then bind" a two-step flow the UI can show
    // progress for: an unbound host is still reachable enough to tell the
    // operator whether the URL they typed is right.
    registry.create({ id: 'unbound', label: 'unbound', baseUrl: 'http://unbound.test' });
    let sawAuth = true;
    const impl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sawAuth = new Headers(init?.headers).has('authorization');
      return healthBody('1.4.2');
    }) as unknown as typeof fetch;
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();
    expect(sawAuth).toBe(false);
    expect(registry.list()[0]?.status.online).toBe(true);
  });

  it('stops probing a host that has been disabled', async () => {
    registry.create({ id: 'x', label: 'x', baseUrl: 'http://x.test' });
    const { impl, calls } = fakeFetch({ 'http://x.test': () => healthBody('1.0.0') });
    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    const before = calls.length;
    registry.update('x', { enabled: false });
    await poller.reconcile();
    poller.stop();
    expect(calls.length).toBe(before);
  });

  it('fetches and caches /api/capabilities for bound hosts with their credential (PA-133)', async () => {
    registry.create({ id: 'mac01', label: 'mac01', baseUrl: 'http://mac01.test' });
    registry.bind('mac01', { id: 'cred-1', token: 'pah_secret_token_for_mac01' }, 'host-mac01');

    let capAuthHeader: string | null = null;
    const { impl } = fakeFetch({
      'http://mac01.test/health': () => healthBody('1.5.0'),
      'http://mac01.test/api/capabilities': () =>
        new Response(
          JSON.stringify({
            capabilitiesVersion: 1,
            platform: 'darwin',
            arch: 'arm64',
            osVersion: '24.1.0',
            description: 'Mac mini build host',
            tags: ['ios-signing'],
            agents: [
              {
                id: 'claude',
                displayName: 'Claude Code',
                available: true,
                setupState: 'ready',
                setupDetail: null,
                transports: ['terminal', 'structured'],
                structured: true,
              },
            ],
            executables: ['xcodebuild', 'git', 'node'],
            projects: [
              {
                path: '/Users/dev/app',
                name: 'app',
                label: 'app',
                gitRemoteUrl: 'https://github.com/acme/app.git',
              },
            ],
            pocketAgents: [
              {
                id: 'pa-1',
                name: 'Pocket Agent',
                defaultModelId: 'claude-sonnet-4-5',
                identityPrompt: 'Default assistant',
                enabledTools: ['bash'],
                skills: ['ios-release'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    const wrappedImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).endsWith('/api/capabilities')) {
        capAuthHeader = new Headers(init?.headers).get('authorization');
      }
      return impl(input, init);
    }) as unknown as typeof fetch;

    const poller = new HealthPoller({ registry, fetchImpl: wrappedImpl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();

    expect(capAuthHeader).toBe('Bearer pah_secret_token_for_mac01');
    const entry = registry.list()[0]!;
    expect(entry.capabilities?.status).toBe('ok');
    if (entry.capabilities?.status === 'ok') {
      expect(entry.capabilities.card.platform).toBe('darwin');
      expect(entry.capabilities.card.executables).toContain('xcodebuild');
      expect(entry.capabilities.card.tags).toEqual(['ios-signing']);
      expect(entry.capabilities.fetchedAt).toBeGreaterThan(0);
    }
  });

  it('records capabilities as unavailable (not an error) when an older backend answers 404 (PA-133)', async () => {
    registry.create({ id: 'old01', label: 'old01', baseUrl: 'http://old01.test' });
    registry.bind('old01', { id: 'cred-2', token: 'pah_secret_token_for_old01' }, 'host-old01');

    const { impl } = fakeFetch({
      'http://old01.test/health': () => healthBody('1.3.0'),
      'http://old01.test/api/capabilities': () =>
        new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const poller = new HealthPoller({ registry, fetchImpl: impl, intervalMs: 60_000 });
    await poller.start();
    poller.stop();

    const entry = registry.list()[0]!;
    expect(entry.status.online).toBe(true);
    expect(entry.status.error).toBeNull();
    expect(entry.capabilities?.status).toBe('unavailable');
  });
});
