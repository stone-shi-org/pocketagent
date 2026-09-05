import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreatePlannerChatRequest,
  CreatePlannerModelRequest,
  CreatePlannerWorkspaceRequest,
  PlannerSendMessageRequest,
  ResolvePlannerApprovalRequest,
  UpdatePlannerChatRequest,
  UpdatePlannerSettingsRequest,
  type PlannerApiKeyRevealResponse,
  type PlannerChatHistoryResponse,
  type PlannerChatListResponse,
  type PlannerModelListResponse,
  type PlannerSendMessageResponse,
  type PlannerSettingsDto,
  type PlannerWorkspaceListResponse,
} from '@pocketagent/protocol';
import { PlannerWorkspaceError } from '../planner/workspaces.js';
import { PlannerChatError } from '../planner/chats.js';
import { PlannerLlmError } from '../planner/llm-client.js';
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

function mapChatError(reply: FastifyReply, err: unknown): FastifyReply | never {
  if (err instanceof PlannerChatError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'not_configured' ? 409 : 400;
    return reply.code(status).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof PlannerLlmError) {
    // 502: the request into this server was fine, the configured upstream
    // failed or is unreachable — not this server's own fault, and not the
    // caller's either.
    return reply.code(502).send({ error: { code: 'llm_error', message: err.message } });
  }
  throw err;
}

/**
 * PA-6: the planner. Phase 1 (foundation) added workspaces, the model
 * catalog, and provider settings. Phase 2 (chat core) adds chat CRUD and the
 * turn loop below — still no tools and no approval gate, see PA-6 for the
 * phases that add them.
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

  app.get('/api/planner/chats', async (request) => {
    const { workspaceId } = request.query as { workspaceId?: string };
    const response: PlannerChatListResponse = {
      chats: app.pocket.plannerChats.list(workspaceId),
    };
    return response;
  });

  app.post('/api/planner/chats', async (request, reply) => {
    const parsed = CreatePlannerChatRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const chat = app.pocket.plannerChats.create(parsed.data);
      return reply.code(201).send(chat);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.patch('/api/planner/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePlannerChatRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const { plannerChats } = app.pocket;
      let chat = plannerChats.get(id);
      if (!chat) return notFound(reply, 'Chat not found.');
      if (parsed.data.title !== undefined) chat = plannerChats.rename(id, parsed.data.title);
      if (parsed.data.modelId !== undefined) chat = plannerChats.setModel(id, parsed.data.modelId);
      return reply.send(chat);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.delete('/api/planner/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = app.pocket.plannerChats.remove(id);
    if (!removed) return notFound(reply, 'Chat not found.');
    return reply.code(204).send();
  });

  app.get('/api/planner/chats/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const response: PlannerChatHistoryResponse = {
        entries: await app.pocket.plannerChats.history(id),
      };
      return response;
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /**
   * Synchronous today: the response only arrives once the whole assistant
   * reply is in — see `llm-client.ts`'s doc comment for why phase 2 is
   * request/response rather than streamed. The frontend disables its
   * composer for the duration, the same "one turn in flight at a time"
   * discipline `PromptBox` already applies to a structured session.
   */
  app.post('/api/planner/chats/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PlannerSendMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const { userEntry, turn } = await app.pocket.plannerChats.sendMessage(
        id,
        parsed.data.content,
        parsed.data.modelId ? { modelId: parsed.data.modelId } : {},
      );
      const response: PlannerSendMessageResponse = { userEntry, turn };
      return response;
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /**
   * Resolves a turn paused on a mutating tool call with no remembered
   * decision (`PlannerTurnResult.status === 'approval_required'`). See
   * `planner/approval.ts`'s doc comment for why this is a second request
   * rather than the first one simply waiting: the planner chat has no live
   * transport yet to push the question to the browser and receive an answer
   * without a fresh HTTP round-trip.
   */
  app.post('/api/planner/chats/:id/approvals/:approvalId', async (request, reply) => {
    const { id, approvalId } = request.params as { id: string; approvalId: string };
    const parsed = ResolvePlannerApprovalRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const turn = await app.pocket.plannerChats.resolveApproval(id, approvalId, parsed.data.decision);
      return reply.send(turn);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });
};
