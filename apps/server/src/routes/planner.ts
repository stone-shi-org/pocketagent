import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreatePlannerChatRequest,
  CreatePlannerModelRequest,
  CreatePlannerWorkspaceRequest,
  SetPlannerAgentToolRequest,
  UpdatePlannerWorkspaceRequest,
  PlannerSendMessageRequest,
  ResolvePlannerApprovalRequest,
  SetPlannerToolApprovalRequest,
  UpdatePlannerChatRequest,
  UpdatePlannerSettingsRequest,
  type AgentEvent,
  type DiscoverPlannerModelsResponse,
  type PlannerAgentToolsResponse,
  type PlannerApiKeyRevealResponse,
  type PlannerChatHistoryResponse,
  type PlannerChatListResponse,
  type PlannerModelListResponse,
  type PlannerSettingsDto,
  type PlannerToolApprovalListResponse,
  type PlannerToolApprovalRow,
  type PlannerToolListResponse,
  type PlannerWorkspaceListResponse,
  type TestPlannerModelResponse,
} from '@pocketagent/protocol';
import { PlannerWorkspaceError } from '../planner/workspaces.js';
import { PlannerChatError } from '../planner/chats.js';
import { PlannerLlmError } from '../planner/llm-client.js';
import { PLANNER_TOOLS } from '../planner/tools.js';
import {
  deletePlannerModel,
  deletePlannerToolApproval,
  insertPlannerModel,
  nextPlannerModelSortOrder,
  readDisabledToolNames,
  readPlannerModels,
  readPlannerSettings,
  readPlannerToolApprovals,
  revealPlannerApiKey,
  setToolEnabledForWorkspace,
  writePlannerApiKey,
  writePlannerBaseUrl,
  writePlannerToolApproval,
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
    // caller's either. In practice this branch is now unreachable from the
    // streaming routes below (`PlannerChatService.driveLoop` catches its own
    // `PlannerLlmError` and yields an in-band error event instead — see that
    // method's doc comment for why), but kept for any future caller that
    // still surfaces the LLM client's own error type as a rejection.
    return reply.code(502).send({ error: { code: 'llm_error', message: err.message } });
  }
  throw err;
}

/**
 * Drains an `AgentEvent` generator (`PlannerChatService.sendMessage` /
 * `.resolveApproval`) onto the response as newline-delimited SSE frames.
 *
 * The one call to `.next()` before anything is written is the load-bearing
 * part: both service methods validate synchronously (chat exists, an
 * approval id is still pending, an LLM endpoint is configured) *before*
 * their first `yield`, so a precondition failure rejects that first
 * `.next()` and this can still answer a normal HTTP error status — headers
 * are not sent yet. Once past that first event, the response is committed to
 * being a stream; nothing after this point can change the status code, which
 * is exactly why the service itself never throws past its own first yield
 * (see `driveLoop`'s doc comment) — an in-flight failure has to become an
 * event, not a rejection, because this function no longer has form left to
 * turn a promise rejection into.
 */
async function streamPlannerEvents(
  reply: FastifyReply,
  generator: AsyncGenerator<AgentEvent>,
): Promise<void> {
  let first: IteratorResult<AgentEvent>;
  try {
    first = await generator.next();
  } catch (err) {
    mapChatError(reply, err);
    return;
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const write = (event: AgentEvent): void => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    if (!first.done) write(first.value);
    for await (const event of generator) {
      write(event);
    }
  } catch (err) {
    // Not expected in normal operation (see this function's doc comment),
    // but if something still throws mid-stream there is no status left to
    // change — a final in-band notice is the only way left to say so.
    write({ kind: 'notice', level: 'error', text: `Unexpected error: ${(err as Error).message}` });
  }
  reply.raw.end();
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
      const row = await plannerWorkspaces.create(plannerWorkspacesRoot, parsed.data.name, {
        path: parsed.data.path,
        create: parsed.data.createPath,
      });
      if (parsed.data.path) {
        // Same disclosure `POST /api/workspaces/add` logs for a project
        // folder — this is the moment full read/write/delete trust over
        // `row.path` is granted to this agent's own tools.
        app.log.warn(
          { path: row.path, created: !!parsed.data.createPath },
          'planner agent pointed at an existing directory; its tools may now freely modify it',
        );
      }
      return reply.code(201).send(row);
    } catch (err) {
      return mapWorkspaceError(reply, err);
    }
  });

  app.patch('/api/planner/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePlannerWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      let row = app.pocket.plannerWorkspaces.get(id);
      if (!row) return notFound(reply, 'Workspace not found.');
      if (parsed.data.name !== undefined) {
        row = app.pocket.plannerWorkspaces.rename(id, parsed.data.name);
      }
      // Distinguishes "clear it" (`defaultModelId: null`, sent) from "leave
      // it alone" (the field omitted) — the same "only touch what's sent"
      // convention `UpdatePlannerSettingsRequest`'s own PATCH already uses.
      if (parsed.data.defaultModelId !== undefined) {
        row = app.pocket.plannerWorkspaces.setDefaultModelId(id, parsed.data.defaultModelId);
      }
      return reply.send(row);
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

  // A static segment ('discover'), not a param — Fastify routes it distinctly
  // from `DELETE /:id` above regardless of registration order.
  app.get('/api/planner/models/discover', async (_request, reply) => {
    try {
      const modelIds = await app.pocket.plannerChats.discoverModels();
      const response: DiscoverPlannerModelsResponse = { modelIds };
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/models/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const model = readPlannerModels(app.pocket.db).find((m) => m.id === id);
    if (!model) return notFound(reply, 'Model not found.');
    try {
      const result = await app.pocket.plannerChats.testModel(model.modelId);
      const response: TestPlannerModelResponse = result;
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
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

  /** The catalog for a settings page — see `PlannerToolInfo`'s doc comment. */
  app.get('/api/planner/tools', async () => {
    const response: PlannerToolListResponse = {
      tools: PLANNER_TOOLS.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    };
    return response;
  });

  /** One agent's own tool subset — see `PlannerAgentToolInfo`'s doc comment. */
  app.get('/api/planner/workspaces/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const disabled = readDisabledToolNames(app.pocket.db, id);
    const response: PlannerAgentToolsResponse = {
      tools: PLANNER_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        enabled: !disabled.has(t.name),
      })),
    };
    return noStore(reply).send(response);
  });

  app.post('/api/planner/workspaces/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const parsed = SetPlannerAgentToolRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    if (!PLANNER_TOOLS.some((t) => t.name === parsed.data.toolName)) {
      return notFound(reply, `Unknown tool: ${parsed.data.toolName}`);
    }
    setToolEnabledForWorkspace(app.pocket.db, id, parsed.data.toolName, parsed.data.enabled);
    const disabled = readDisabledToolNames(app.pocket.db, id);
    const response: PlannerAgentToolsResponse = {
      tools: PLANNER_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        readOnly: t.readOnly,
        enabled: !disabled.has(t.name),
      })),
    };
    return response;
  });

  app.get('/api/planner/tool-approvals', async () => {
    const response: PlannerToolApprovalListResponse = {
      approvals: readPlannerToolApprovals(app.pocket.db),
    };
    return response;
  });

  /**
   * Pre-configure a remembered decision from the settings page — the same
   * row the chat's own approval card writes via "remember", just triggered
   * without needing a live chat to pause first first. `scope: 'workspace'`
   * validates `workspaceId` against the real registry, same as every other
   * route that accepts one.
   */
  app.post('/api/planner/tool-approvals', async (request, reply) => {
    const parsed = SetPlannerToolApprovalRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { scope, toolName, decision } = parsed.data;
    let workspaceId: string | null = null;
    if (scope === 'workspace') {
      if (!parsed.data.workspaceId) {
        return badRequest(reply, 'workspaceId is required when scope is "workspace".');
      }
      if (!app.pocket.plannerWorkspaces.get(parsed.data.workspaceId)) {
        return notFound(reply, 'Planner workspace not found.');
      }
      workspaceId = parsed.data.workspaceId;
    }
    writePlannerToolApproval(app.pocket.db, scope, workspaceId, toolName, decision);
    const row = readPlannerToolApprovals(app.pocket.db).find(
      (r) => r.scope === scope && r.workspaceId === workspaceId && r.toolName === toolName,
    ) as PlannerToolApprovalRow;
    return reply.code(201).send(row);
  });

  app.delete('/api/planner/tool-approvals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = deletePlannerToolApproval(app.pocket.db, id);
    if (!removed) return notFound(reply, 'No such remembered decision.');
    return reply.code(204).send();
  });

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
        events: await app.pocket.plannerChats.history(id),
      };
      return response;
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /**
   * Streams one turn as it happens — see `streamPlannerEvents`'s doc comment
   * for the precondition-vs-in-band-error split this depends on, and
   * `PlannerChatHistoryResponse`'s doc comment (protocol package) for what
   * "streamed" does and does not mean here. The frontend disables its
   * composer for the duration, the same "one turn in flight at a time"
   * discipline `PromptBox` already applies to a structured session.
   */
  app.post('/api/planner/chats/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PlannerSendMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const generator = app.pocket.plannerChats.sendMessage(
      id,
      parsed.data.content,
      parsed.data.modelId ? { modelId: parsed.data.modelId } : {},
    );
    await streamPlannerEvents(reply, generator);
  });

  /**
   * Resolves a turn paused on a mutating tool call with no remembered
   * decision (a `permission_request` event with no matching
   * `permission_resolved` yet — see `PlannerChatService.processToolCalls`).
   * See `planner/approval.ts`'s doc comment for why this is a second request
   * rather than the first one simply waiting: the planner chat has no live
   * bidirectional transport, only a one-way event stream down to the
   * browser, so resuming needs its own request the same way it did before
   * streaming existed — only the response shape (another event stream, not
   * one JSON object) changed.
   */
  app.post('/api/planner/chats/:id/approvals/:approvalId', async (request, reply) => {
    const { id, approvalId } = request.params as { id: string; approvalId: string };
    const parsed = ResolvePlannerApprovalRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const generator = app.pocket.plannerChats.resolveApproval(id, approvalId, parsed.data.decision);
    await streamPlannerEvents(reply, generator);
  });
};
