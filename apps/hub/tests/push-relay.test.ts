import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PushPayload } from '@pocketagent/protocol';
import { createTestHub, type TestHub } from './helpers.js';
import type { HubPushService } from '../src/push/service.js';
import { PushNotificationRelay } from '../src/push/relay.js';

describe('HubPushService & PushNotificationRelay', () => {
  let hub: TestHub;

  beforeEach(async () => {
    hub = await createTestHub();
  });

  afterEach(async () => {
    await hub.cleanup();
  });

  describe('HubPushService', () => {
    it('initializes and generates a persistent VAPID keypair', () => {
      const push = hub.context.push;
      expect(push.isEnabled()).toBe(true);
      const pubKey = push.getPublicKey();
      expect(pubKey).toBeTruthy();
      expect(typeof pubKey).toBe('string');
    });

    it('manages browser push subscriptions', () => {
      const push = hub.context.push;
      expect(push.count()).toBe(0);

      const sub = {
        endpoint: 'https://push.example.com/sub/1',
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QT9t0448G3RnzBxCmXjYWWDz01HZC0ghomStVZOW8KICu1zE',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      };

      const ok = push.subscribe(sub);
      expect(ok).toBe(true);
      expect(push.count()).toBe(1);

      push.unsubscribe('https://push.example.com/sub/1');
      expect(push.count()).toBe(0);
    });
  });

  describe('PushNotificationRelay', () => {
    it('rewrites notification URLs and titles for non-default hosts', async () => {
      const sentPayloads: PushPayload[] = [];
      const mockPushService = {
        send: async (p: PushPayload) => {
          sentPayloads.push(p);
          return { sent: 1, pruned: 0 };
        },
      } as unknown as HubPushService;

      // Add default host first, then dev02 as non-default
      hub.context.registry.create({
        id: 'dev01',
        label: 'default-local',
        baseUrl: 'http://127.0.0.1:8888',
      });
      hub.context.registry.create({
        id: 'dev02',
        label: 'dev02-remote',
        baseUrl: 'http://127.0.0.1:9999',
      });

      // Deliver SSE frame via fake fetchImpl
      const fakeFetch: typeof fetch = (async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes('/api/push/events')) {
          const stream = new ReadableStream({
            start(controller) {
              const payload: PushPayload = {
                title: 'Approval needed',
                body: 'Agent requires confirmation',
                url: '/#/s/session-abc',
                tag: 'approval-session-abc',
              };
              controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;

      // Manually set credential so host looks bound
      hub.context.registry.bind('dev02', {
        id: 'cred-1',
        token: 'pah_dummy_token',
      }, 'host-1');

      const relay = new PushNotificationRelay({
        registry: hub.context.registry,
        pushService: mockPushService,
        fetchImpl: fakeFetch,
      });

      await relay.start();

      // Wait a tick for frame processing
      await new Promise((r) => setTimeout(r, 100));

      expect(sentPayloads).toHaveLength(1);
      const forwarded = sentPayloads[0]!;
      expect(forwarded.title).toBe('[dev02-remote] Approval needed');
      expect(forwarded.body).toBe('Agent requires confirmation');
      expect(forwarded.url).toBe('/#/h/dev02/s/session-abc');
      expect(forwarded.tag).toBe('dev02-approval-session-abc');

      relay.stop();
    });

    it('tracks host push stream status (connected, unsupported, unbound)', async () => {
      // 1. Unbound host
      hub.context.registry.create({
        id: 'unbound-host',
        label: 'Unbound Host',
        baseUrl: 'http://127.0.0.1:9001',
      });

      // 2. Bound host with unsupported backend (404 on /api/push/events)
      hub.context.registry.create({
        id: 'old-host',
        label: 'Old Host',
        baseUrl: 'http://127.0.0.1:9002',
      });
      hub.context.registry.bind('old-host', {
        id: 'cred-old',
        token: 'pah_token_old',
      }, 'old-id');

      const fakeFetch: typeof fetch = (async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes(':9002/api/push/events')) {
          return new Response('Not Found', { status: 404 });
        }
        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;

      const relay = new PushNotificationRelay({
        registry: hub.context.registry,
        pushService: hub.context.push,
        fetchImpl: fakeFetch,
      });

      await relay.start();
      await new Promise((r) => setTimeout(r, 50));

      const status = relay.getStatus();
      expect(status['unbound-host']).toMatchObject({
        ok: false,
        status: 'unbound',
      });
      expect(status['old-host']).toMatchObject({
        ok: false,
        status: 'unsupported',
      });

      relay.stop();
    });
  });

  describe('/api/push endpoints on Hub', () => {
    it('exposes VAPID key and status with per-host health', async () => {
      const keyRes = await fetch(`${hub.baseUrl}/api/push/key`, {
        headers: { cookie: hub.cookie },
      });
      expect(keyRes.status).toBe(200);
      const keyBody = (await keyRes.json()) as { publicKey: string };
      expect(keyBody.publicKey).toBeTruthy();

      const statusRes = await fetch(`${hub.baseUrl}/api/push/status`, {
        headers: { cookie: hub.cookie },
      });
      expect(statusRes.status).toBe(200);
      const statusBody = (await statusRes.json()) as {
        enabled: boolean;
        subscriptions: number;
        hosts: Record<string, unknown>;
      };
      expect(statusBody.enabled).toBe(true);
      expect(statusBody.subscriptions).toBe(0);
      expect(statusBody.hosts).toBeDefined();
    });
  });
});
