import type { FastifyPluginAsync } from 'fastify';

/**
 * Inbound webhook deliveries — the only unauthenticated route in this server.
 *
 * Two things make this file unusual, and both are deliberate.
 *
 * **It has its own plugin scope, and replaces its content-type parsers.** HMAC
 * has to be computed over the exact bytes the sender signed, and Fastify's JSON
 * parser hands back an object whose re-serialization is *not* byte-identical:
 * key order survives `JSON.stringify` but whitespace, unicode escaping and
 * number formatting do not. Verifying against a re-serialized parse validates
 * cleanly in a unit test with canonical JSON and then fails on every real Jira
 * payload. Content-type parsers in Fastify are encapsulated per plugin scope
 * exactly like hooks, so removing the inherited JSON parser here and installing
 * a buffer passthrough leaves every sibling plugin — including the webhook
 * *management* routes that register this one — parsing JSON as before. There is
 * a test that POSTs JSON to a management route from inside the same app to prove
 * the encapsulation actually held.
 *
 * **It lives under `/api/`, in its own flat namespace.** Under `/api/` because
 * `app.ts`'s not-found handler answers anything *outside* `/api/` with the SPA
 * shell and a 200 — so a delivery endpoint at `/hooks/:slug` would answer
 * 200-HTML for an unknown slug and 401 for a known one, which is a slug
 * enumeration oracle. In its own namespace rather than under `/api/webhooks/`
 * because that path also holds management CRUD, and an auth exemption that has
 * to tell a slug from an `:id` from `:id/deliveries` is one bad `startsWith`
 * away from opening `DELETE /api/webhooks/:id` to the internet.
 * `grep '/api/hooks/'` must enumerate the entire unauthenticated surface,
 * forever. Nothing else may ever be mounted here.
 */

/**
 * Deliberately larger than `app.ts`'s 1 MB instance limit, and set explicitly
 * rather than inherited: a Jira payload with a long description, many custom
 * fields and a changelog can be a few hundred KB, and a future change to the
 * global limit must not silently change this endpoint's behaviour. Over this,
 * Fastify answers 413 — which loses the event, since Jira Data Center does not
 * retry, so the ceiling is generous on purpose.
 */
const MAX_DELIVERY_BYTES = 2 * 1024 * 1024;

export const webhookDeliveryRoutes: FastifyPluginAsync = async (app) => {
  const { webhooks } = app.pocket;

  // Remove before adding: `addContentTypeParser` throws
  // FST_ERR_CTP_ALREADY_PRESENT against the inherited `application/json`.
  app.removeAllContentTypeParsers();
  // A catch-all rather than `application/json` alone: a sender with a wrong or
  // missing Content-Type should get a signature verdict, not a 415 it cannot
  // interpret.
  app.addContentTypeParser<Buffer>(
    '*',
    { parseAs: 'buffer', bodyLimit: MAX_DELIVERY_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Params: { slug: string }; Body: Buffer }>(
    '/api/hooks/:slug',
    {
      bodyLimit: MAX_DELIVERY_BYTES,
      // The real defence against a delivery storm is here, not in the body
      // limit: HMAC over 2 MB is microseconds, but every delivery can spawn a
      // process. Keyed by IP, and the service applies its own per-webhook and
      // global session caps behind this.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);

      const outcome = await webhooks.deliver({
        slug: request.params.slug,
        rawBody: raw,
        signatureHeader: firstHeader(
          request.headers['x-hub-signature-256'] ?? request.headers['x-hub-signature'],
        ),
        bearerToken: bearerFrom(firstHeader(request.headers.authorization)),
        // Kept only for correlating with Jira's own delivery log. It is a
        // header, therefore outside the signature, therefore attacker-mutable —
        // never a defence. Replay is stopped by the body hash.
        deliveryHeader: firstHeader(request.headers['x-atlassian-webhook-identifier']),
      });

      // An unknown slug, a disabled webhook and a bad signature are answered
      // identically from outside, so this endpoint cannot be used to discover
      // which webhooks exist.
      if (outcome.httpStatus === 404) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      if (outcome.httpStatus === 401) {
        return reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'Signature verification failed.' } });
      }
      if (outcome.httpStatus === 400) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: outcome.reason ?? 'Unusable payload.' },
        });
      }

      // Everything from here is a success as far as the sender is concerned,
      // including `filtered` and `throttled`. A 4xx/5xx on those would make Jira
      // retry with backoff and, past a threshold, disable the webhook at its
      // end — so work we deliberately declined must never look like failure.
      return reply.code(outcome.httpStatus).send({
        deliveryId: outcome.deliveryId,
        status: outcome.status,
        sessionId: outcome.sessionId,
        reason: outcome.reason,
        duplicate: outcome.duplicate,
      });
    },
  );
};

function firstHeader(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function bearerFrom(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}
