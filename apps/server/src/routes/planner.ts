import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreatePlannerModelRequest,
  CreatePlannerWorkspaceRequest,
  UpdatePlannerSettingsRequest,
  type PlannerApiKeyRevealResponse,
  type PlannerModelListResponse,
  type PlannerSettingsDto,
  type PlannerWorkspaceListResponse,
} from '@pocketagent/protocol';
import { PlannerWorkspaceError } from '../planner/workspaces.js';
import {
  deletePlannerModel,
  insertPlannerModel,
  nextPlannerModelSortOrder,
  readPlannerModels,
  readPlannerSettings,
  revealPlannerApiKey,
  writePlannerApiKey,
  writePlannerBaseUrl,
  writePlannerYoloEnabled,
} from '../planner/store.js';

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: { code: 'bad_request', message } });
}

function notFound(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(404).send({ error: { code: 'not_found', message } });
}

function noStore(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'no-store');
}

function mapWorkspaceError(reply: FastifyReply, err: unknown): FastifyReply | never {
  if (err instanceof PlannerWorkspaceError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400;
    return reply.code(status).send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}

/**
 * PA-6, phase 1 (foundation): planner workspaces, the model catalog for the
 * single configured LLM provider, and that provider's settings. No chat, no
 * tools, no approval gate yet — those are later phases, tracked on PA-6.
 */
export const plannerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/planner/workspaces', async () => {
    const response: PlannerWorkspaceListResponse = {
      workspaces: app.pocket.plannerWorkspaces.list(),
    };
    return response;
  });

  app.post('/api/planner/workspaces', async (request, reply) => {
    const parsed = CreatePlannerWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { plannerWorkspaces, plannerWorkspacesRoot } = app.pocket;
    try {
      const row = await plannerWorkspaces.create(plannerWorkspacesRoot, parsed.data.name);
      return reply.code(201).send(row);
    } catch (err) {
      return mapWorkspaceError(reply, err);
    }
  });

  app.delete('/api/planner/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const removed = app.pocket.plannerWorkspaces.remove(id);
      if (!removed) return notFound(reply, 'Workspace not found.');
      return reply.code(204).send();
    } catch (err) {
      return mapWorkspaceError(reply, err);
    }
  });

  app.get('/api/planner/models', async () => {
    const response: PlannerModelListResponse = { models: readPlannerModels(app.pocket.db) };
    return response;
  });

  app.post('/api/planner/models', async (request, reply) => {
    const parsed = CreatePlannerModelRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db } = app.pocket;
    const row = {
      id: crypto.randomUUID(),
      modelId: parsed.data.modelId,
      label: parsed.data.label,
      sortOrder: nextPlannerModelSortOrder(db),
      createdAt: Date.now(),
    };
    insertPlannerModel(db, row);
    return reply.code(201).send(row);
  });

  app.delete('/api/planner/models/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = deletePlannerModel(app.pocket.db, id);
    if (!removed) return notFound(reply, 'Model not found.');
    return reply.code(204).send();
  });

  app.get('/api/planner/settings', async () => {
    const dto: PlannerSettingsDto = readPlannerSettings(app.pocket.db);
    return dto;
  });

  /**
   * Partial update, same discipline as `PATCH /api/settings`: only keys
   * present in the body are touched. `apiKey` omitted leaves the stored key
   * untouched; `apiKey: ''` clears it.
   */
  app.patch('/api/planner/settings', async (request, reply) => {
    const parsed = UpdatePlannerSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db } = app.pocket;
    const { baseUrl, apiKey, yoloEnabled } = parsed.data;
    if (baseUrl !== undefined) writePlannerBaseUrl(db, baseUrl);
    if (apiKey !== undefined) writePlannerApiKey(db, apiKey.length > 0 ? apiKey : null);
    if (yoloEnabled !== undefined) writePlannerYoloEnabled(db, yoloEnabled);
    const dto: PlannerSettingsDto = readPlannerSettings(db);
    return reply.send(dto);
  });

  /**
   * The one response that carries the key, mirroring
   * `POST /api/webhooks/:id/secret/reveal` exactly: rate-limited, logged, and
   * reachable only from an explicit user action — never from a list or the
   * plain `GET` above.
   */
  app.post(
    '/api/planner/settings/api-key/reveal',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const apiKey = revealPlannerApiKey(app.pocket.db);
      if (apiKey === null) return notFound(reply, 'No API key configured.');
      app.log.info('planner API key revealed');
      const response: PlannerApiKeyRevealResponse = { apiKey };
      return noStore(reply).send(response);
    },
  );
};
