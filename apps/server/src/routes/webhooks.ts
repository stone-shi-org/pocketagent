import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  AcceptWebhookRouteRequest,
  CreateWebhookRequest,
  DEFAULT_BAMBOO_PROMPT_TEMPLATE,
  DEFAULT_JIRA_PROMPT_TEMPLATE,
  UpdateWebhookRequest,
  WEBHOOK_RESERVED_SLUGS,
  WEBHOOK_SLUG_RE,
  WebhookTestRequest,
  parsePocketAgentId,
} from '@pocketagent/protocol';
import type {
  BambooPlanMapEntry,
  BambooPromptTemplateMapEntry,
  JiraProjectMapEntry,
  JiraPromptTemplateMapEntry,
} from '@pocketagent/protocol';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { WorkspaceError } from '../workspaces/index.js';
import type { Db, WebhookRow } from '../db/index.js';
import type { WebhookSpec, WebhookSpecCommon } from '../webhooks/index.js';
import { WebhookServiceError } from '../webhooks/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PlannerWorkspaceRegistry } from '../planner/workspaces.js';
import { unattendedPlannerModelProblem } from '../planner/store.js';
import type { WebhookRoutingStore } from '../webhooks/routing-store.js';
import { auditConfigChange, webhookAgentProblem } from './shared.js';
import { webhookDeliveryRoutes } from './webhook-delivery.js';

/** Default page size for a delivery list. */
const DEFAULT_DELIVERY_LIMIT = 50;
const MAX_DELIVERY_LIMIT = 200;

function badRequest(reply: FastifyReply, message: string, code = 'bad_request'): FastifyReply {
  return reply.code(400).send({ error: { code, message } });
}

export interface WebhookUpdateDeps {
  workspaces: WorkspaceRegistry;
  agents: AgentRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  db?: Db;
  /** PA-171: which hosts a row may name. Absent = every row must be local. */
  webhookRouting?: WebhookRoutingStore;
}

type TargetResult =
  | { ok: true; cwd: string; hostId: string | null }
  | {
      ok: false;
      error: string;
      code?: string;
      /** A local containment refusal's own code, so create can answer 403/404 as it always has. */
      workspaceCode?: string;
    };

/**
 * PA-171: validate one run target — a directory, and the host it is on.
 *
 * A local target is containment-checked exactly as before. A remote one cannot
 * be: this server cannot see that machine's folders. It is checked for shape
 * (an absolute path) and for permission (the Hub listed that host for this
 * server's webhooks), and the target's own `start_session` re-resolves it
 * against *its* workspace folders when the run starts, refusing anything
 * outside them. A host naming this server itself is local.
 */
async function resolveTarget(
  deps: WebhookUpdateDeps,
  cwd: string,
  rawHostId: string | null | undefined,
): Promise<TargetResult> {
  const selfHostId = deps.webhookRouting?.selfHostId() ?? null;
  const hostId = rawHostId === undefined || rawHostId === null || rawHostId === selfHostId ? null : rawHostId;
  if (hostId === null) {
    try {
      return { ok: true, cwd: await deps.workspaces.resolveWorkspacePath(cwd), hostId: null };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, error: err.message, workspaceCode: err.code };
      throw err;
    }
  }
  if (deps.webhookRouting === undefined || !deps.webhookRouting.allows(hostId)) {
    return {
      ok: false,
      code: 'remote_host_not_allowed',
      error:
        `This server’s webhooks may not dispatch to "${hostId}". ` +
        'Turn webhook routing on for this server on the Hub page and allow that host.',
    };
  }
  if (!path.posix.isAbsolute(cwd) || cwd.includes('\0')) {
    return { ok: false, error: `A directory on ${hostId} must be an absolute path on that host.` };
  }
  return { ok: true, cwd, hostId };
}

/** A create-time target refusal, with the status a containment refusal always had. */
function targetRefusal(
  reply: FastifyReply,
  problem: { error: string; code?: string; workspaceCode?: string },
): FastifyReply {
  if (problem.workspaceCode !== undefined) {
    const status = problem.workspaceCode === 'forbidden' ? 403 : problem.workspaceCode === 'not_found' ? 404 : 400;
    return reply.code(status).send({ error: { code: problem.workspaceCode, message: problem.error } });
  }
  return badRequest(reply, problem.error, problem.code);
}

/** Every row of a project/plan map through `resolveTarget`, keys normalised. */
async function resolveRouteMap<K extends 'projectKey' | 'planKey'>(
  deps: WebhookUpdateDeps,
  key: K,
  entries: ({ cwd: string; hostId?: string | undefined } & Record<K, string>)[],
): Promise<
  | { ok: true; map: ({ cwd: string; hostId?: string } & Record<K, string>)[] }
  | { ok: false; error: string; code?: string; workspaceCode?: string }
> {
  const map: ({ cwd: string; hostId?: string } & Record<K, string>)[] = [];
  for (const entry of entries) {
    const target = await resolveTarget(deps, entry.cwd, entry.hostId);
    if (!target.ok) return target;
    map.push({
      [key]: entry[key].trim().toUpperCase(),
      cwd: target.cwd,
      ...(target.hostId !== null ? { hostId: target.hostId } : {}),
    } as { cwd: string; hostId?: string } & Record<K, string>);
  }
  return { ok: true, map };
}

/**
 * PA-171: the cross-field rules a remote target adds, given the webhook's
 * effective configuration after this request.
 *
 * - The agent is checked here only when something runs *here*. A webhook whose
 *   every target is remote names an agent (or a `pocket:` agent) on those
 *   hosts, which their own `start_session` / `create_pocket_chat` validate.
 * - `current-branch` cannot cross: the Hub's dispatch takes `none` or
 *   `new-branch` only, because the target mints every branch itself.
 */
function remoteTargetProblem(
  deps: WebhookUpdateDeps,
  effective: {
    agent: string;
    model: string | null;
    worktreeMode: string;
    hostId: string | null;
    map: { hostId?: string | undefined }[];
  },
): { error: string; code?: string } | null {
  const anyRemote = effective.hostId !== null || effective.map.some((e) => e.hostId !== undefined);
  const anyLocal = effective.hostId === null || effective.map.some((e) => e.hostId === undefined);
  if (anyRemote && effective.worktreeMode === 'current-branch') {
    return {
      error:
        'A webhook with a target on another host can use worktree mode "none" or "new-branch" only — ' +
        'the other host mints its branches itself.',
      code: 'remote_worktree_mode',
    };
  }
  if (!anyLocal) return null;
  const agentProblem = webhookAgentProblem(deps.agents, deps.plannerWorkspaces, effective.agent);
  if (agentProblem !== null) return { error: agentProblem };
  const plannerWsId = parsePocketAgentId(effective.agent);
  if (plannerWsId !== null && deps.db) {
    const plannerWs = deps.plannerWorkspaces.get(plannerWsId);
    const modelProblem = unattendedPlannerModelProblem(deps.db, {
      workspaceDefaultModelId: plannerWs?.defaultModelId ?? null,
      modelId: effective.model,
      noun: 'triggered by a webhook',
    });
    if (modelProblem !== null) return { error: modelProblem };
  }
  return null;
}

export type WebhookUpdatePatchResult =
  | {
      ok: true;
      patch: Partial<WebhookSpecCommon> & {
        filter?: WebhookSpec['filter'];
        routeMap?: JiraProjectMapEntry[] | BambooPlanMapEntry[];
        promptTemplateMap?: JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[];
      };
    }
  | { ok: false; error: string; code?: string };

/**
 * PA-56: the validated-patch half of `PATCH /api/webhooks/:id`, pulled out so
 * `update_webhook` (a planner tool, `planner/tools.ts`) runs through the
 * exact same checks — slug format, cwd containment, agent-transport rules,
 * Bamboo/hmac rejection, project/plan-map dedup — rather than a second,
 * inevitably-drifting copy. Takes `existing` rather than an id so a caller
 * that already fetched the row (both do) does not fetch it twice, and
 * returns a result instead of writing to a `FastifyReply`, since the tool
 * has no reply to write to.
 */
export async function resolveWebhookUpdatePatch(
  deps: WebhookUpdateDeps,
  existing: WebhookRow,
  body: UpdateWebhookRequest,
): Promise<WebhookUpdatePatchResult> {
  if (body.slug !== undefined) {
    const slugProblem = checkSlug(body.slug);
    if (slugProblem !== null) return { ok: false, error: slugProblem };
  }

  // PA-171: the top-level target is re-validated whenever its directory *or*
  // its host changes, since a path valid on one machine says nothing about
  // another.
  let cwd: string | undefined;
  let hostId: string | null | undefined;
  if (body.cwd !== undefined || body.hostId !== undefined) {
    const target = await resolveTarget(
      deps,
      body.cwd ?? existing.cwd,
      body.hostId !== undefined ? body.hostId : (existing.host_id ?? null),
    );
    if (!target.ok) return { ok: false, error: target.error, ...(target.code ? { code: target.code } : {}) };
    cwd = target.cwd;
    hostId = target.hostId;
  }

  const effectiveAuthMode = body.authMode ?? existing.auth_mode;
  if (existing.type === 'bamboo' && effectiveAuthMode === 'hmac') {
    return {
      ok: false,
      error:
        'A Bamboo webhook can only use bearer-token auth: Bamboo has no way to sign a request body, only to send a static header.',
      code: 'bamboo_requires_bearer',
    };
  }

  let routeMap: JiraProjectMapEntry[] | BambooPlanMapEntry[] | undefined;
  let promptTemplateMap: JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[] | undefined;
  if (body.config !== undefined) {
    if (body.config.type === 'bamboo') {
      const dupProblem = checkPlanMapDuplicates(body.config.planMap);
      if (dupProblem !== null) return { ok: false, error: dupProblem };
      const resolved = await resolveRouteMap(deps, 'planKey', body.config.planMap);
      if (!resolved.ok) return { ok: false, error: resolved.error, ...(resolved.code ? { code: resolved.code } : {}) };
      routeMap = resolved.map;
      const templateDup = checkBambooPromptTemplateMapDuplicates(body.config.promptTemplateMap);
      if (templateDup !== null) return { ok: false, error: templateDup };
      promptTemplateMap = body.config.promptTemplateMap;
    } else {
      const dupProblem = checkProjectMapDuplicates(body.config.projectMap);
      if (dupProblem !== null) return { ok: false, error: dupProblem };
      const resolved = await resolveRouteMap(deps, 'projectKey', body.config.projectMap);
      if (!resolved.ok) return { ok: false, error: resolved.error, ...(resolved.code ? { code: resolved.code } : {}) };
      routeMap = resolved.map;
      const templateDup = checkPromptTemplateMapDuplicates(body.config.promptTemplateMap);
      if (templateDup !== null) return { ok: false, error: templateDup };
      promptTemplateMap = body.config.promptTemplateMap;
    }
  }

  // The rules that depend on the whole effective configuration, checked once
  // every changed piece of it has been resolved.
  const effectiveMap: { hostId?: string | undefined }[] =
    routeMap ?? (JSON.parse(existing.project_map_json || '[]') as { hostId?: string }[]);
  const targetProblem = remoteTargetProblem(deps, {
    agent: body.agent ?? existing.agent,
    model: (body.model !== undefined ? body.model : existing.model) ?? null,
    worktreeMode: body.worktreeMode ?? existing.worktree_mode,
    hostId: hostId !== undefined ? hostId : (existing.host_id ?? null),
    map: effectiveMap,
  });
  if (targetProblem !== null) {
    return { ok: false, error: targetProblem.error, ...(targetProblem.code ? { code: targetProblem.code } : {}) };
  }

  const patch = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.slug !== undefined ? { slug: body.slug } : {}),
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.config !== undefined ? { filter: body.config.filter, routeMap, promptTemplateMap } : {}),
    ...(body.authMode !== undefined ? { authMode: body.authMode } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(hostId !== undefined ? { hostId } : {}),
    ...(body.agent !== undefined ? { agent: body.agent } : {}),
    ...(body.worktreeMode !== undefined ? { worktreeMode: body.worktreeMode } : {}),
    ...(body.model !== undefined ? { model: body.model } : {}),
    // `in`, not a null check: an explicit null means "the model's own
    // default", which is a different thing from an omitted key.
    ...('effort' in body ? { effort: body.effort ?? null } : {}),
    ...(body.skipPermissions !== undefined ? { skipPermissions: body.skipPermissions } : {}),
    ...(body.autoSelectAgentModel !== undefined
      ? { autoSelectAgentModel: body.autoSelectAgentModel }
      : {}),
    ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
    ...(body.conversationMode !== undefined ? { conversationMode: body.conversationMode } : {}),
    ...(body.overlapPolicy !== undefined ? { overlapPolicy: body.overlapPolicy } : {}),
    ...(body.directoryPolicy !== undefined ? { directoryPolicy: body.directoryPolicy } : {}),
    ...(body.skipQueueLabelEnabled !== undefined
      ? { skipQueueLabelEnabled: body.skipQueueLabelEnabled }
      : {}),
    ...(body.agentIdentity !== undefined ? { agentIdentity: body.agentIdentity } : {}),
    ...(body.autoRoute !== undefined ? { autoRoute: body.autoRoute } : {}),
    ...(body.maxConcurrent !== undefined ? { maxConcurrent: body.maxConcurrent } : {}),
    ...(body.storePayloads !== undefined ? { storePayloads: body.storePayloads } : {}),
  };
  return { ok: true, patch };
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  const { webhooks, workspaces, agents, plannerWorkspaces, db, webhookRouting } = app.pocket;
  const deps: WebhookUpdateDeps = { workspaces, agents, plannerWorkspaces, db, webhookRouting };

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

    const target = await resolveTarget(deps, body.cwd, body.hostId);
    if (!target.ok) return targetRefusal(reply, target);
    const cwd = target.cwd;

    // Bamboo cannot compute a request signature — it only supports a static
    // custom header — so `hmac` would 401 every real delivery forever with no
    // way for the operator to diagnose why. Reject the configuration outright
    // rather than accept one that can never work.
    if (body.config.type === 'bamboo' && body.authMode === 'hmac') {
      return badRequest(
        reply,
        'A Bamboo webhook can only use bearer-token auth: Bamboo has no way to sign a request body, only to send a static header.',
        'bamboo_requires_bearer',
      );
    }

    const dupProblem =
      body.config.type === 'bamboo'
        ? checkPlanMapDuplicates(body.config.planMap)
        : checkProjectMapDuplicates(body.config.projectMap);
    if (dupProblem !== null) return badRequest(reply, dupProblem);
    const resolvedMap =
      body.config.type === 'bamboo'
        ? await resolveRouteMap(deps, 'planKey', body.config.planMap)
        : await resolveRouteMap(deps, 'projectKey', body.config.projectMap);
    if (!resolvedMap.ok) return targetRefusal(reply, resolvedMap);
    const routeMap = resolvedMap.map as JiraProjectMapEntry[] | BambooPlanMapEntry[];

    const targetProblem = remoteTargetProblem(deps, {
      agent: body.agent,
      model: body.model ?? null,
      worktreeMode: body.worktreeMode,
      hostId: target.hostId,
      map: routeMap,
    });
    if (targetProblem !== null) return badRequest(reply, targetProblem.error, targetProblem.code);

    const templateMapDup =
      body.config.type === 'bamboo'
        ? checkBambooPromptTemplateMapDuplicates(body.config.promptTemplateMap)
        : checkPromptTemplateMapDuplicates(body.config.promptTemplateMap);
    if (templateMapDup !== null) return badRequest(reply, templateMapDup);

    try {
      const created = webhooks.create(specFrom(body, routeMap, body.config.promptTemplateMap, slug, cwd, target.hostId));
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
    try {
      const existing = webhooks.get(request.params.id);
      const result = await resolveWebhookUpdatePatch(deps, existing, parsed.data);
      if (!result.ok) return badRequest(reply, result.error, result.code);
      const updated = webhooks.update(request.params.id, result.patch);
      auditConfigChange(request, 'webhook updated', {
        webhookId: request.params.id,
        fields: Object.keys(result.patch),
      });
      return reply.send(webhooks.toWebhook(updated));
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
   * Act on a delivery waiting for a working tree (PA-11).
   *
   * `cancel` records it as `skipped` — which already means "never started, on
   * purpose" — and `front` moves it to the head of its own line. There is
   * deliberately **no** action that starts it while another agent holds the
   * tree: that is the corruption this feature exists to prevent, and the one
   * override lives on a human's own prompt over the WebSocket, where a person
   * is present to own the consequence.
   *
   * A POST so the Origin check covers it, like every other mutating route here.
   */
  app.post<{ Params: { id: string; deliveryId: string }; Body: { action?: string } }>(
    '/api/webhooks/:id/deliveries/:deliveryId/queue',
    async (request, reply) => {
      try {
        const row = webhooks.delivery(request.params.deliveryId);
        if (row.webhook_id !== request.params.id) {
          return reply
            .code(404)
            .send({ error: { code: 'not_found', message: 'No such delivery.' } });
        }
        const action = request.body?.action;
        if (action !== 'cancel' && action !== 'front') {
          return reply.code(400).send({
            error: { code: 'bad_request', message: 'action must be "cancel" or "front".' },
          });
        }
        if (!webhooks.resolveQueued(request.params.deliveryId, action)) {
          return reply.code(409).send({
            error: {
              code: 'conflict',
              message: 'That delivery is no longer waiting — it may have already started.',
            },
          });
        }
        return reply.send({ ok: true });
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * Re-run a failed, throttled or skipped delivery's stored payload (PA-125).
   *
   * Answers 202 with the *new* delivery's outcome, like `/test`: the retry is
   * its own row, and the original stays as it was. 409 when the delivery is
   * not retryable (status, or no complete stored payload). Rate-limited like
   * `/test`, since each one can start an agent, and a POST so the Origin check
   * covers it.
   */
  app.post<{ Params: { id: string; deliveryId: string } }>(
    '/api/webhooks/:id/deliveries/:deliveryId/retry',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const outcome = await webhooks.retry(request.params.id, request.params.deliveryId);
        auditConfigChange(request, 'webhook delivery retried', {
          webhookId: request.params.id,
          retryOf: request.params.deliveryId,
          deliveryId: outcome.deliveryId,
          status: outcome.status,
        });
        return reply.code(202).send(outcome);
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
   * PA-170: explicit "Re-detect" button in the webhook editor. Scans workspace
   * repositories and past deliveries for unmapped project/plan keys and returns
   * the refreshed `webhook_route_cache` entries.
   */
  app.post<{ Params: { id: string } }>(
    '/api/webhooks/:id/routes/detect',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      try {
        const entries = await webhooks.detectRoutes(request.params.id);
        return reply.send({ entries });
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  /**
   * PA-170: accept a route suggestion for `:routeKey`. Writes an explicit
   * `projectMap` / `planMap` row, stamps `confirmed_at` / `confirmed_by` in
   * `webhook_route_cache`, and audits the change.
   */
  app.post<{ Params: { id: string; routeKey: string } }>(
    '/api/webhooks/:id/routes/:routeKey/accept',
    async (request, reply) => {
      const parsed = AcceptWebhookRouteRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      try {
        const result = await webhooks.acceptRoute(request.params.id, request.params.routeKey, {
          ...(parsed.data.cwd !== undefined ? { cwd: parsed.data.cwd } : {}),
          confirmedBy: 'operator',
        });
        auditConfigChange(request, 'webhook route suggestion accepted', {
          webhookId: request.params.id,
          routeKey: request.params.routeKey.trim().toUpperCase(),
          cwd: result.entry?.cwd ?? parsed.data.cwd ?? null,
          source: result.entry?.source ?? 'manual',
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return badRequest(reply, err.message);
        }
        return mapError(reply, err);
      }
    },
  );

  /**
   * PA-170: dismiss a route suggestion for `:routeKey`.
   */
  app.post<{ Params: { id: string; routeKey: string } }>(
    '/api/webhooks/:id/routes/:routeKey/dismiss',
    async (request, reply) => {
      try {
        const result = webhooks.dismissRoute(request.params.id, request.params.routeKey);
        auditConfigChange(request, 'webhook route suggestion dismissed', {
          webhookId: request.params.id,
          routeKey: request.params.routeKey.trim().toUpperCase(),
          cwd: result.entry.cwd,
          source: result.entry.source,
        });
        return reply.send(result);
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

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
 * Reject a blank or (case-insensitively) duplicate plan key — the Bamboo
 * equivalent of `checkProjectMapDuplicates`.
 */
function checkPlanMapDuplicates(entries: { planKey: string }[]): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = entry.planKey.trim().toUpperCase();
    if (key === '') return 'A plan mapping needs a plan key.';
    if (seen.has(key)) return `Plan "${key}" is mapped more than once.`;
    seen.add(key);
  }
  return null;
}

/** Shared by `checkPromptTemplateMapDuplicates` and its Bamboo counterpart below. */
function checkTemplateMapDuplicates<T>(
  entries: T[],
  keyOf: (entry: T) => string,
  keyLabel: string,
): string | null {
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = keyOf(entry);
    const key = raw.trim().toLowerCase();
    if (key === '') return `A prompt template mapping needs a${/^[aeiou]/i.test(keyLabel) ? 'n' : ''} ${keyLabel}.`;
    if (seen.has(key)) {
      const article = keyLabel[0]?.toUpperCase() + keyLabel.slice(1);
      return `${article} "${raw.trim()}" is mapped more than once.`;
    }
    seen.add(key);
  }
  return null;
}

/**
 * Reject a blank or duplicate issue type in prompt template map.
 */
function checkPromptTemplateMapDuplicates(entries: JiraPromptTemplateMapEntry[]): string | null {
  return checkTemplateMapDuplicates(entries, (e) => e.issueType, 'issue type');
}

/** Reject a blank or duplicate build state in a Bamboo prompt template map. */
function checkBambooPromptTemplateMapDuplicates(entries: BambooPromptTemplateMapEntry[]): string | null {
  return checkTemplateMapDuplicates(entries, (e) => e.buildState, 'build state');
}

/** The reveal/rotate responses must never sit in an intermediary's cache. */
function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

/**
 * Build the complete create spec from a validated request.
 *
 * Takes `slug`/`cwd` directly and returns a whole `WebhookSpec`, rather than
 * an `Omit<WebhookSpec, 'slug' | 'cwd'>` spread together with them at the call
 * site: `Omit` is defined via `keyof`, which does not distribute over a union
 * the way a plain object literal return does, so it quietly erases
 * `WebhookSpec`'s discriminated-union shape and makes every member look like
 * it needs every field. Returning the literal directly keeps the type checker
 * able to tell "this object has `type: 'bamboo'`, so it needs `planMap`" from
 * "this one has `type: 'jira'`, so it needs `projectMap`".
 *
 * `promptTemplate` has no schema-level default any more (see
 * `CreateWebhookRequest` in `packages/protocol/src/webhooks.ts`): a `.default()`
 * cannot see `body.config.type` to pick between `DEFAULT_JIRA_PROMPT_TEMPLATE`
 * and `DEFAULT_BAMBOO_PROMPT_TEMPLATE`, so that choice is made here instead,
 * the same way agent-transport and slug-uniqueness checks already live at the
 * route rather than in the schema.
 */
function specFrom(
  body: CreateWebhookRequest,
  routeMap: JiraProjectMapEntry[] | BambooPlanMapEntry[],
  promptTemplateMap: JiraPromptTemplateMapEntry[] | BambooPromptTemplateMapEntry[],
  slug: string,
  cwd: string,
  hostId: string | null,
): WebhookSpec {
  const common = {
    slug,
    cwd,
    hostId,
    name: body.name,
    enabled: body.enabled,
    authMode: body.authMode,
    agent: body.agent,
    worktreeMode: body.worktreeMode,
    model: body.model ?? null,
    ...('effort' in body ? { effort: body.effort ?? null } : {}),
    skipPermissions: body.skipPermissions,
    autoSelectAgentModel: body.autoSelectAgentModel,
    promptTemplate:
      body.promptTemplate ??
      (body.config.type === 'bamboo' ? DEFAULT_BAMBOO_PROMPT_TEMPLATE : DEFAULT_JIRA_PROMPT_TEMPLATE),
    conversationMode: body.conversationMode,
    overlapPolicy: body.overlapPolicy,
    directoryPolicy: body.directoryPolicy,
    skipQueueLabelEnabled: body.skipQueueLabelEnabled,
    agentIdentity: body.agentIdentity,
    autoRoute: body.autoRoute,
    maxConcurrent: body.maxConcurrent,
    storePayloads: body.storePayloads,
  };

  if (body.config.type === 'bamboo') {
    return {
      ...common,
      type: 'bamboo',
      filter: body.config.filter,
      planMap: routeMap as BambooPlanMapEntry[],
      promptTemplateMap: promptTemplateMap as BambooPromptTemplateMapEntry[],
    };
  }
  return {
    ...common,
    type: 'jira',
    filter: body.config.filter,
    projectMap: routeMap as JiraProjectMapEntry[],
    promptTemplateMap: promptTemplateMap as JiraPromptTemplateMapEntry[],
  };
}

function parseLimit(raw: string | undefined): number {
  const n = raw === undefined ? DEFAULT_DELIVERY_LIMIT : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DELIVERY_LIMIT;
  return Math.min(Math.floor(n), MAX_DELIVERY_LIMIT);
}
