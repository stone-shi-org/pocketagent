import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const SubscribeBody = z.object({
  subscription: z.record(z.unknown()),
});

const UnsubscribeBody = z.object({
  endpoint: z.string().min(1).max(2048),
});

export const pushRoutes: FastifyPluginAsync = async (app) => {
  const { push } = app.pocket;

  /** The VAPID public key the browser needs to create a subscription. */
  app.get('/api/push/key', async () => ({
    publicKey: push.isEnabled() ? push.getPublicKey() : null,
  }));

  app.post('/api/push/subscribe', async (request, reply) => {
    const parsed = SubscribeBody.safeParse(request.body);
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
    const parsed = UnsubscribeBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Invalid endpoint.' } });
    }
    push.unsubscribe(parsed.data.endpoint);
    return reply.send({ ok: true });
  });

  /** Lets the UI show "push is on for N devices" and test delivery. */
  app.get('/api/push/status', async () => ({
    enabled: push.isEnabled(),
    subscriptions: push.count(),
  }));

  app.post('/api/push/test', async (_request, reply) => {
    const result = await push.send({
      title: 'PocketAgent',
      body: 'Push notifications are working.',
      url: '/',
      tag: 'pocketagent-test',
    });
    return reply.send(result);
  });
};
