import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateWebhookRequest,
  UpdateWebhookRequest,
  WEBHOOK_RESERVED_SLUGS,
  WEBHOOK_SLUG_RE,
  WebhookTestRequest,
} from '@pocketagent/protocol';
import type { JiraProjectMapEntry } from '@pocketagent/protocol';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { WebhookSpec } from '../webhooks/index.js';
import { WebhookServiceError } from '../webhooks/index.js';
import { resolveWorkspaceCwdOrReply, structuredAgentProblem } from './shared.js';
import { webhookDeliveryRoutes } from './webhook-delivery.js';

/** Default page size for a delivery list. */
const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const { webhooks, workspaces, agents } = app.pocket;

  const mapError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof WebhookServiceError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };

  app.get('/api/webhooks', async () => ({
    webhooks: webhooks.list().map((row) => webhooks.toWebhook(row)),
  }));

  /**
   * One chronological feed across every webhook, including calls that matched
   * none at all. A static path, so it is never shadowed by `:id` below —
   * Fastify's router prioritizes an exact segment over a parametric one
   * regardless of registration order, unlike the browser's own regex-based
   * hash router, which needs the same care spelled out explicitly.
   */
  app.get<{ Querystring: { limit?: string; noise?: string } }>(
    '/api/webhooks/history',
    async (request, reply) =>
      reply.send(
        webhooks.history({
          limit: parseLimit(request.query.limit),
          includeNoise: request.query.noise !== 'false',
        }),
      ),
  );

  app.get<{ Params: { id: string } }>('/api/webhooks/:id', async (request, reply) => {
    try {
      return reply.send(webhooks.toWebhook(webhooks.get(request.params.id)));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  /**
   * Create a webhook.
   *
   * Validation order matches `routes/cron.ts`: the thing most likely to be wrong
   * is reported first. The slug is checked before the directory because it is
   * the only field with a uniqueness constraint, and a 409 after a successful
   * containment check reads like the directory was the problem.
   */
  app.post('/api/webhooks', async (request, reply) => {
    const parsed = CreateWebhookRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const body = parsed.data;

    const slug = body.slug ?? deriveSlug(body.name);
    const slugProblem = checkSlug(slug);
    if (slugProblem !== null) return badRequest(reply, slugProblem);

    const cwd = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
    if (cwd === null) return reply;

    const agentProblem = structuredAgentProblem(agents, body.agent, 'triggered by a webhook');
    if (agentProblem !== null) return badRequest(reply, agentProblem);

    const projectMap = await resolveProjectMap(workspaces, body.config.projectMap, reply);
    if (projectMap === null) return reply;

    try {
      const created = webhooks.create({
        ...specFrom(body, projectMap),
        slug,
        cwd,
      });
      return reply.code(201).send({
        webhook: webhooks.toWebhook(created.row),
        secret: created.secret,
        ...(created.token !== undefined ? { token: created.token } : {}),
      });
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/webhooks/:id', async (request, reply) => {
    const parsed = UpdateWebhookRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const body = parsed.data;

    if (body.slug !== undefined) {
      const slugProblem = checkSlug(body.slug);
      if (slugProblem !== null) return badRequest(reply, slugProblem);
    }

    let cwd: string | undefined;
    if (body.cwd !== undefined) {
      const resolved = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
      if (resolved === null) return reply;
      cwd = resolved;
    }

    if (body.agent !== undefined) {
      const agentProblem = structuredAgentProblem(agents, body.agent, 'triggered by a webhook');
      if (agentProblem !== null) return badRequest(reply, agentProblem);
    }

    // `config` replaces wholesale, so the project map is re-resolved in full
    // whenever it is sent — same as the filter object just above it.
    let projectMap: JiraProjectMapEntry[] | undefined;
    if (body.config !== undefined) {
      const resolved = await resolveProjectMap(workspaces, body.config.projectMap, reply);
      if (resolved === null) return reply;
      projectMap = resolved;
    }

    try {
      const patch: Partial<WebhookSpec> = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.config !== undefined ? { filter: body.config.filter, projectMap } : {}),
        ...(body.authMode !== undefined ? { authMode: body.authMode } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(body.agent !== undefined ? { agent: body.agent } : {}),
        ...(body.worktreeMode !== undefined ? { worktreeMode: body.worktreeMode } : {}),
        ...(body.model !== undefined ? { model: body.model } : {}),
        // `in`, not a null check: an explicit null means "the model's own
        // default", which is a different thing from an omitted key.
        ...('effort' in body ? { effort: body.effort ?? null } : {}),
        ...(body.skipPermissions !== undefined ? { skipPermissions: body.skipPermissions } : {}),
        ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
        ...(body.conversationMode !== undefined
          ? { conversationMode: body.conversationMode }
          : {}),
        ...(body.overlapPolicy !== undefined ? { overlapPolicy: body.overlapPolicy } : {}),
        ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
        ...(body.debounceSeconds !== undefined ? { debounceSeconds: body.debounceSeconds } : {}),
        ...(body.storePayloads !== undefined ? { storePayloads: body.storePayloads } : {}),
      };
      return reply.send(webhooks.toWebhook(webhooks.update(request.params.id, patch)));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  /** Deleting a webhook keeps its delivery history — see the migration comment. */
  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (request, reply) => {
    try {
      const { deliveriesKept } = webhooks.remove(request.params.id);
      return reply.send({ ok: true, deliveriesKept });
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string; noise?: string } }>(
    '/api/webhooks/:id/deliveries',
    async (request, reply) => {
      try {
        const hook = webhooks.get(request.params.id);
        const rows = webhooks.deliveries({
          webhookId: hook.id,
          limit: parseLimit(request.query.limit),
          includeNoise: request.query.noise !== 'false',
        });
        return reply.send({
          deliveries: rows.map((row) => webhooks.toDelivery(row)),
          counts: webhooks.countsFor(hook.id),
        });
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id/deliveries', async (request, reply) => {
    try {
      return reply.send({ ok: true, ...webhooks.clearDeliveries(request.params.id) });
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get<{ Params: { id: string; deliveryId: string } }>(
    '/api/webhooks/:id/deliveries/:deliveryId',
    async (request, reply) => {
      try {
        const row = webhooks.delivery(request.params.deliveryId);
        if (row.webhook_id !== request.params.id) {
          return reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'No such delivery.' } });
        }
        return reply.send(webhooks.toDeliveryDetail(row));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * Reveal the secret.
   *
   * A POST rather than a GET on purpose. `app.ts`'s Origin check only runs on
   * non-GET/HEAD methods, so `GET .../secret` would be CSRF-reachable and
   * cacheable by any intermediary. Rate-limited and logged, the same "granting
   * access is the moment it is logged" discipline `workspaces` uses.
   *
   * That the secret is retrievable at all is a consequence of HMAC, not a
   * weakening: verification needs the plaintext, so the database holds it either
   * way. Making it unrecoverable in the UI would cost the user their afternoon
   * for no security gain — see the schema comment.
   */
  app.post<{ Params: { id: string } }>(
    '/api/webhooks/:id/secret/reveal',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const revealed = webhooks.revealSecret(request.params.id);
        return noStore(reply).send(revealed);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * Rotate the secret. No grace period: an overlap window where both the old and
   * new secrets verify doubles the exposure window to save one paste into one
   * field. A botched rotation is made loud instead — `rejected` rows appear in
   * the delivery list within one Jira event.
   */
  app.post<{ Params: { id: string } }>(
    '/api/webhooks/:id/secret/rotate',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        return noStore(reply).send(webhooks.rotateSecret(request.params.id));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * Run a payload through the real pipeline with auth skipped.
   *
   * The `POST /api/cron/jobs/:id/run` analogue, and the only way to debug a
   * filter or a template without a round trip through Jira's admin UI. Answers
   * 202 with the delivery row rather than 201 with a session, because a failure
   * *inside* the run is still a delivery that happened.
   */
  app.post<{ Params: { id: string } }>(
    '/api/webhooks/:id/test',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = WebhookTestRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      try {
        const outcome = await webhooks.test(request.params.id, parsed.data.payload);
        return reply.code(202).send(outcome);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /** Render without running, so the editor never re-implements the renderer. */
  app.post<{ Params: { id: string } }>('/api/webhooks/:id/preview', async (request, reply) => {
    const parsed = WebhookTestRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      return reply.send(
        webhooks.preview(request.params.id, {
          ...(parsed.data.payload !== undefined ? { payload: parsed.data.payload } : {}),
          ...(parsed.data.promptTemplate !== undefined
            ? { promptTemplate: parsed.data.promptTemplate }
            : {}),
        }),
      );
    } catch (err) {
      return mapError(reply, err);
    }
  });

  /**
   * The delivery endpoint, registered *inside* this plugin.
   *
   * Nested rather than added to `app.ts`'s list so the encapsulation
   * relationship is visible in one file: that plugin replaces its own
   * content-type parsers, and being a child of this scope is what keeps the
   * change from reaching these routes. See `webhook-delivery.ts`.
   */
  await app.register(webhookDeliveryRoutes);
};

/** `Triage new bugs` → `triage-new-bugs-a3f9`. */
function deriveSlug(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'hook';
  // A random suffix rather than a bare slug: two webhooks named "Deploy" must
  // not collide, and a path that is not trivially guessable is free defence in
  // depth on an endpoint anyone can reach.
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

function checkSlug(slug: string): string | null {
  if (!WEBHOOK_SLUG_RE.test(slug)) {
    return 'A webhook path uses 1–64 lowercase letters, digits and hyphens, not starting or ending with a hyphen.';
  }
  if (WEBHOOK_RESERVED_SLUGS.includes(slug)) {
    return `"${slug}" is reserved. Pick another path.`;
  }
  return null;
}

/**
 * Reject a blank or (case-insensitively) duplicate project key.
 *
 * Uniqueness lives here rather than in the Zod schema for the same reason
 * slug uniqueness does: a discriminated-union member can't carry a
 * `.refine()` without losing its literal discriminant, so cross-row checks on
 * `config` belong at the route, same as everywhere else this file says so.
 */
function checkProjectMapDuplicates(entries: { projectKey: string }[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.projectKey.trim().toUpperCase();
    if (key === '') return 'A project mapping needs a project key.';
    if (seen.has(key)) return `Project "${key}" is mapped more than once.`;
    seen.add(key);
  }
  return null;
}

/**
 * Validate and resolve every row of a project map, the same way the
 * webhook's own `cwd` is resolved — each directory must be inside a
 * workspace folder. Returns `null` once the reply has already been sent;
 * callers should `return reply` in that case, exactly like
 * `resolveWorkspaceCwdOrReply`.
 */
async function resolveProjectMap(
  workspaces: WorkspaceRegistry,
  entries: { projectKey: string; cwd: string }[],
  reply: FastifyReply,
): Promise<JiraProjectMapEntry[] | null> {
  const dupProblem = checkProjectMapDuplicates(entries);
  if (dupProblem !== null) {
    badRequest(reply, dupProblem);
    return null;
  }
  const resolved: JiraProjectMapEntry[] = [];
  for (const entry of entries) {
    const cwd = await resolveWorkspaceCwdOrReply(workspaces, entry.cwd, reply);
    if (cwd === null) return null;
    resolved.push({ projectKey: entry.projectKey.trim().toUpperCase(), cwd });
  }
  return resolved;
}

/** The reveal/rotate responses must never sit in an intermediary's cache. */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function specFrom(
  body: CreateWebhookRequest,
  projectMap: JiraProjectMapEntry[],
): Omit<WebhookSpec, 'slug' | 'cwd'> {
  return {
    name: body.name,
    enabled: body.enabled,
    type: 'jira',
    filter: body.config.filter,
    projectMap,
    authMode: body.authMode,
    agent: body.agent,
    worktreeMode: body.worktreeMode,
    model: body.model ?? null,
    ...('effort' in body ? { effort: body.effort ?? null } : {}),
    skipPermissions: body.skipPermissions,
    promptTemplate: body.promptTemplate,
    conversationMode: body.conversationMode,
    overlapPolicy: body.overlapPolicy,
    maxConcurrent: body.maxConcurrent,
    debounceSeconds: body.debounceSeconds,
    storePayloads: body.storePayloads,
  };
}

function parseLimit(raw: string | undefined): number {
  const n = raw === undefined ? DEFAULT_DELIVERY_LIMIT : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DELIVERY_LIMIT;
  return Math.min(Math.floor(n), MAX_DELIVERY_LIMIT);
}
