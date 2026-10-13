import type { FastifyPluginAsync } from 'fastify';
import { pendingPlannerApprovalPayloads } from '../push/planner-approvals.js';
import { z } from 'zod';
import { openSseStream } from './sse.js';

const SubscribeBody = z.object({
  subscription: z.record(z.unknown()),
});

const UnsubscribeBody = z.object({
  endpoint: z.string().min(1).max(2048),
});

export const pushRoutes: FastifyPluginAsync = async (app) => {
  const { push, sessions } = app.pocket;

  const activeStreams = new Set<ReturnType<typeof openSseStream>>();
  // `preClose`, not `onClose`: Fastify's own shutdown ends by calling the
  // underlying `http.Server.close()`, which does not resolve while a
  // connection is open and non-idle — exactly what a held-open SSE stream (the
  // Hub's `/api/push/events`, heartbeat every 15s) is. `onClose` hooks only
  // run *after* that call resolves, so ending the stream there never gets a
  // chance to run — the shutdown just hangs until the peer disconnects or
  // (in production) systemd's `TimeoutStopSec` SIGKILLs the process. `preClose`
  // runs first, for exactly this reason (see the Fastify docs' own worked
  // example: "Close all WebSocket connections so that server.close() can
  // complete").
  app.addHook('preClose', async () => {
    for (const stream of activeStreams) {
      stream.end();
    }
    activeStreams.clear();
  });

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

  /**
   * PA-73: Stream push events to an authenticated Hub.
   *
   * Backends behind a Hub deliver notification events (approvals, turn
   * completions, idle alerts) over this SSE stream. The Hub rewrites deep links
   * to carry the host ID and fans out push messages using the Hub origin's VAPID
   * key.
   *
   * Pending approvals are replayed immediately upon connection so a Hub restart
   * never drops an unanswered approval.
   */
  app.get('/api/push/events', async (request, reply) => {
    const stream = openSseStream(request, reply, {
      heartbeatMs: 15_000,
      onClose: () => {
        activeStreams.delete(stream);
        unsubscribe();
      },
    });
    activeStreams.add(stream);

    const unsubscribe = push.subscribeEvents((payload) => {
      stream.write(payload);
    });

    // Replay currently pending approvals on connect.
    const pending = [
      ...sessions.getPendingApprovals(),
      // PA-134: Pocket Agent chats an MCP client started, parked on approval.
      ...pendingPlannerApprovalPayloads(app.pocket.db, app.pocket.plannerChats),
    ];
    for (const payload of pending) {
      stream.write(payload);
    }
  });
};
