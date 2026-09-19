import type { FastifyPluginAsync } from 'fastify';
import { SubscribePushBody, UnsubscribePushBody } from '@pocketagent/protocol';

export const hubPushRoutes: FastifyPluginAsync = async (app) => {
  const { push, pushRelay } = app.hub;

  /** The VAPID public key the browser needs to create a subscription for the Hub origin. */
  app.get('/api/push/key', async () => ({
    publicKey: push.isEnabled() ? push.getPublicKey() : null,
  }));

  app.post('/api/push/subscribe', async (request, reply) => {
    const parsed = SubscribePushBody.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Invalid subscription.' } });
    }
    if (!push.subscribe(parsed.data.subscription)) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: 'Subscription is malformed.' } });
    }
    return reply.send({ ok: true });
  });

  app.post('/api/push/unsubscribe', async (request, reply) => {
    const parsed = UnsubscribePushBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid endpoint.' } });
    }
    push.unsubscribe(parsed.data.endpoint);
    return reply.send({ ok: true });
  });

  /**
   * Push status on the Hub: reports whether push is enabled, how many device
   * subscriptions are active, and the per-host push stream connection health.
   */
  app.get('/api/push/status', async () => ({
    enabled: push.isEnabled(),
    subscriptions: push.count(),
    hosts: pushRelay.getStatus(),
  }));

  app.post('/api/push/test', async (_request, reply) => {
    const result = await push.send({
      title: 'PocketAgent Hub',
      body: 'Push notifications are working across hosts.',
      url: '/',
      tag: 'pocketagent-test',
    });
    return reply.send(result);
  });
};
