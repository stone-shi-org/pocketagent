import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreatePlannerChatRequest,
  CreatePlannerModelRequest,
  CreatePlannerWorkspaceRequest,
  PlannerMemoryTier,
  RegisterPlannerSkillRequest,
  SetPlannerAgentSkillRequest,
  SetPlannerAgentToolRequest,
  SetPlannerSkillEnabledRequest,
  SetPlannerToolEnabledRequest,
  UpdatePlannerMemoryRequest,
  UpdatePlannerWorkspaceRequest,
  PlannerSendMessageRequest,
  ResolvePlannerApprovalRequest,
  SetPlannerToolApprovalRequest,
  UpdatePlannerChatRequest,
  UpdatePlannerSettingsRequest,
  type AgentEvent,
  type DeleteAllPlannerChatsResponse,
  type DiscoverPlannerModelsResponse,
  type PlannerAgentSkillsResponse,
  type PlannerAgentToolsResponse,
  type PlannerApiKeyRevealResponse,
  type PlannerChatHistoryResponse,
  type PlannerChatListResponse,
  type PlannerContextPreviewResponse,
  type PlannerEmbeddingApiKeyRevealResponse,
  type PlannerMemoryListResponse,
  type PlannerModelListResponse,
  type PlannerSettingsDto,
  type PlannerSkillListResponse,
  type PlannerToolApprovalListResponse,
  type PlannerToolApprovalRow,
  type PlannerToolListResponse,
  type PlannerWorkspaceListResponse,
  type TestPlannerEmbeddingResponse,
  type TestPlannerModelResponse,
  type TestPlannerUrlFetchResponse,
  type TestPlannerWebSearchResponse,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { PlannerWorkspaceError } from '../planner/workspaces.js';
import { PlannerChatError } from '../planner/chats.js';
import { PlannerLlmClient, PlannerLlmError } from '../planner/llm-client.js';
import { PLANNER_TOOLS, postJsonToIntegration } from '../planner/tools.js';
import { SkillRegistryError, type SkillSummary } from '../planner/skills.js';
import {
  deleteAllPlannerModels,
  deletePlannerModel,
  deletePlannerToolApproval,
  insertPlannerModel,
  nextPlannerModelSortOrder,
  readDisabledSkillNames,
  readDisabledToolNames,
  readGlobalDisabledSkillNames,
  readGlobalDisabledToolNames,
  readPlannerModels,
  readPlannerSettings,
  readPlannerToolApprovals,
  resolvePlannerUrlFetchApiKey,
  resolvePlannerWebSearchApiKey,
  revealPlannerApiKey,
  revealPlannerEmbeddingApiKey,
  setSkillEnabledForWorkspace,
  setSkillEnabledGlobally,
  setToolEnabledForWorkspace,
  setToolEnabledGlobally,
  writePlannerApiKey,
  writePlannerBaseUrl,
  writePlannerEmbeddingApiKey,
  writePlannerEmbeddingBaseUrl,
  writePlannerEmbeddingModelId,
  writePlannerToolApproval,
  writePlannerUrlFetchApiKey,
  writePlannerUrlFetchBaseUrl,
  writePlannerUrlFetchEnabled,
  writePlannerWebSearchApiKey,
  writePlannerWebSearchBaseUrl,
  writePlannerWebSearchEnabled,
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
      if (parsed.data.path !== undefined) {
        row = await app.pocket.plannerWorkspaces.setPath(id, parsed.data.path, {
          create: parsed.data.createPath,
        });
        app.log.warn(
          { id, path: row.path, created: !!parsed.data.createPath },
          'planner agent re-pointed at a different directory; its existing chats\' transcripts stay under the old one',
        );
      }
      // PA-29 phase 4: trivially reversible (unlike `path` above), so no log
      // line and no confirmation step — just the standing disclosure text
      // the editor renders whenever this is off.
      if (parsed.data.memoryEnabled !== undefined) {
        row = app.pocket.plannerWorkspaces.setMemoryEnabled(id, parsed.data.memoryEnabled);
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

  /**
   * Empty the catalog (PA-6 round 7's "delete all"). A distinct path from
   * `DELETE /:id` below rather than a magic `:id` value, so there is no way
   * for a stray/mistyped id to wipe every row.
   */
  app.delete('/api/planner/models', async (_request, reply) => {
    const removed = deleteAllPlannerModels(app.pocket.db);
    app.log.info({ removed }, 'planner model catalog emptied');
    return reply.code(204).send();
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
    const {
      baseUrl,
      apiKey,
      yoloEnabled,
      embeddingBaseUrl,
      embeddingApiKey,
      embeddingModelId,
      webSearchEnabled,
      webSearchBaseUrl,
      webSearchApiKey,
      urlFetchEnabled,
      urlFetchBaseUrl,
      urlFetchApiKey,
    } = parsed.data;
    if (baseUrl !== undefined) writePlannerBaseUrl(db, baseUrl);
    if (apiKey !== undefined) writePlannerApiKey(db, apiKey.length > 0 ? apiKey : null);
    if (yoloEnabled !== undefined) writePlannerYoloEnabled(db, yoloEnabled);
    // PA-29: the embedding provider's own settings, same "only touch what's
    // sent" idiom as the chat-settings fields above.
    if (embeddingBaseUrl !== undefined) writePlannerEmbeddingBaseUrl(db, embeddingBaseUrl);
    if (embeddingApiKey !== undefined) {
      writePlannerEmbeddingApiKey(db, embeddingApiKey.length > 0 ? embeddingApiKey : null);
    }
    if (embeddingModelId !== undefined) writePlannerEmbeddingModelId(db, embeddingModelId);
    // PA-31: the web_search/url_fetch tool providers, same idiom again.
    if (webSearchEnabled !== undefined) writePlannerWebSearchEnabled(db, webSearchEnabled);
    if (webSearchBaseUrl !== undefined) writePlannerWebSearchBaseUrl(db, webSearchBaseUrl);
    if (webSearchApiKey !== undefined) {
      writePlannerWebSearchApiKey(db, webSearchApiKey.length > 0 ? webSearchApiKey : null);
    }
    if (urlFetchEnabled !== undefined) writePlannerUrlFetchEnabled(db, urlFetchEnabled);
    if (urlFetchBaseUrl !== undefined) writePlannerUrlFetchBaseUrl(db, urlFetchBaseUrl);
    if (urlFetchApiKey !== undefined) {
      writePlannerUrlFetchApiKey(db, urlFetchApiKey.length > 0 ? urlFetchApiKey : null);
    }
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

  /** The embedding provider's own key reveal — same rate-limit/logging
      posture as the chat key's, at its own route/key. */
  app.post(
    '/api/planner/settings/embedding-api-key/reveal',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const apiKey = revealPlannerEmbeddingApiKey(app.pocket.db);
      if (apiKey === null) return notFound(reply, 'No embedding API key configured.');
      app.log.info('planner embedding API key revealed');
      const response: PlannerEmbeddingApiKeyRevealResponse = { apiKey };
      return noStore(reply).send(response);
    },
  );

  /**
   * Round-trips one trivial embedding request through the configured
   * embedding endpoint/model to confirm it actually works — mirrors
   * `POST /api/planner/models/:id/test` closely, but built inline (rather
   * than through `PlannerChatService`, which has no notion of embeddings)
   * since a fresh, throwaway `PlannerLlmClient` is all this needs. Reads
   * settings live (not through `plannerMemory`'s own, construction-time
   * embedding config — see that service's doc comment for why the two can
   * differ), so testing a just-changed setting never waits on a restart.
   * Swallows a failure into `ok: false` for the same reason `testModel`
   * does: a failed test (bad url, wrong model id) is this button's expected,
   * common outcome, not a server error.
   */
  app.post('/api/planner/settings/embeddings/test', async (_request, reply) => {
    const { db } = app.pocket;
    const settings = readPlannerSettings(db);
    const startedAt = Date.now();
    if (!settings.embeddingBaseUrl || !settings.embeddingModelId) {
      const response: TestPlannerEmbeddingResponse = {
        ok: false,
        message: 'Embeddings are not configured yet — set a base URL and a model id first.',
        dims: 0,
        latencyMs: 0,
      };
      return noStore(reply).send(response);
    }
    const client = new PlannerLlmClient({
      baseUrl: settings.embeddingBaseUrl,
      apiKey: revealPlannerEmbeddingApiKey(db),
      ...(app.pocket.plannerLlmFetch ? { fetchImpl: app.pocket.plannerLlmFetch } : {}),
    });
    try {
      const { embeddings } = await client.embed(settings.embeddingModelId, ['ok']);
      const dims = embeddings[0]?.length ?? 0;
      const response: TestPlannerEmbeddingResponse = {
        ok: true,
        message: `Received a ${dims}-dimension embedding.`,
        dims,
        latencyMs: Date.now() - startedAt,
      };
      return noStore(reply).send(response);
    } catch (err) {
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      const response: TestPlannerEmbeddingResponse = {
        ok: false,
        message,
        dims: 0,
        latencyMs: Date.now() - startedAt,
      };
      return noStore(reply).send(response);
    }
  });

  /**
   * PA-31 (reporter: "Saved, let's add test button to run a test search and
   * test fetch"): round-trips one canned search query through the
   * configured `web_search` provider, via the exact same
   * `postJsonToIntegration` helper the tool itself calls during a real
   * turn — so a green result here is a genuine guarantee the tool will work,
   * not a separately-implemented check that could drift from it. Mirrors
   * `POST /api/planner/settings/embeddings/test`'s shape: `ok: false` for
   * "not configured yet" and for a failed call are both this button's
   * ordinary, expected outcomes, not a server error.
   */
  app.post('/api/planner/settings/web-search/test', async (_request, reply) => {
    const { db } = app.pocket;
    const settings = readPlannerSettings(db);
    const startedAt = Date.now();
    if (!settings.webSearchEnabled || !settings.webSearchBaseUrl) {
      const response: TestPlannerWebSearchResponse = {
        ok: false,
        message: 'Web search is not configured yet — set a base URL and enable it first.',
        latencyMs: 0,
      };
      return noStore(reply).send(response);
    }
    const url = `${settings.webSearchBaseUrl.replace(/\/+$/, '')}/v1/search`;
    const result = await postJsonToIntegration(
      app.pocket.plannerLlmFetch ?? fetch,
      url,
      resolvePlannerWebSearchApiKey(db),
      { query: 'PocketAgent connection test', limit: 1 },
    );
    const response: TestPlannerWebSearchResponse = result.ok
      ? { ok: true, message: 'Received a response from the search endpoint.', latencyMs: Date.now() - startedAt }
      : { ok: false, message: result.message, latencyMs: Date.now() - startedAt };
    return noStore(reply).send(response);
  });

  /** `url_fetch`'s own connection test — same reasoning and shape as
      `POST /api/planner/settings/web-search/test`, one layer down. Fetches
      a fixed, stable target (`https://example.com`, IANA's reserved
      documentation domain — RFC 2606) rather than asking the caller for a
      URL: this button is testing *the configured provider*, not a
      particular page, and a canned target means a failure always means
      "the provider is misconfigured or unreachable," never "that page
      doesn't exist." */
  app.post('/api/planner/settings/url-fetch/test', async (_request, reply) => {
    const { db } = app.pocket;
    const settings = readPlannerSettings(db);
    const startedAt = Date.now();
    if (!settings.urlFetchEnabled || !settings.urlFetchBaseUrl) {
      const response: TestPlannerUrlFetchResponse = {
        ok: false,
        message: 'URL fetch is not configured yet — set a base URL and enable it first.',
        latencyMs: 0,
      };
      return noStore(reply).send(response);
    }
    const url = `${settings.urlFetchBaseUrl.replace(/\/+$/, '')}/v1/scrape`;
    const result = await postJsonToIntegration(
      app.pocket.plannerLlmFetch ?? fetch,
      url,
      resolvePlannerUrlFetchApiKey(db),
      { url: 'https://example.com' },
    );
    const response: TestPlannerUrlFetchResponse = result.ok
      ? { ok: true, message: 'Received a response from the fetch endpoint.', latencyMs: Date.now() - startedAt }
      : { ok: false, message: result.message, latencyMs: Date.now() - startedAt };
    return noStore(reply).send(response);
  });

  /**
   * The full tool catalog, native and MCP-derived alike (PA-37: "MCP treat
   * same as tools") — every reader below (both listing routes, and the two
   * `PATCH`/`POST` handlers' "is this a real tool name" checks) goes through
   * this instead of `PLANNER_TOOLS` directly, so an MCP tool is
   * indistinguishable from a native one anywhere a name is validated or
   * listed. An MCP tool's `name` is already namespaced
   * (`mcpQualifiedToolName`), so it cannot collide with a native one.
   */
  function fullToolCatalog(): { name: string; description: string; readOnly: boolean }[] {
    return [
      ...PLANNER_TOOLS.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
      ...app.pocket.mcpRegistry.listKnownTools().map((t) => ({
        name: t.qualifiedName,
        description: t.description,
        readOnly: t.readOnly,
      })),
    ];
  }

  /** The global catalog for a settings page — see `PlannerToolInfo`'s doc
      comment. `enabled` here is the global switch (PA-6 round 5); an
      agent's own, further-restricted view is `GET .../workspaces/:id/tools`
      below. */
  app.get('/api/planner/tools', async () => {
    const disabled = readGlobalDisabledToolNames(app.pocket.db);
    const response: PlannerToolListResponse = {
      tools: fullToolCatalog().map((t) => ({ ...t, enabled: !disabled.has(t.name) })),
    };
    return response;
  });

  app.patch('/api/planner/tools/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!fullToolCatalog().some((t) => t.name === name)) {
      return notFound(reply, `Unknown tool: ${name}`);
    }
    const parsed = SetPlannerToolEnabledRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    setToolEnabledGlobally(app.pocket.db, name, parsed.data.enabled);
    const disabled = readGlobalDisabledToolNames(app.pocket.db);
    const response: PlannerToolListResponse = {
      tools: fullToolCatalog().map((t) => ({ ...t, enabled: !disabled.has(t.name) })),
    };
    return response;
  });

  /** One agent's own tool subset — see `PlannerAgentToolInfo`'s doc comment.
      `enabled` is *effective* (global AND per-agent); `disabledGlobally`
      lets the editor grey out a checkbox the agent can't override. */
  function buildAgentToolsResponse(db: Db, workspaceId: string): PlannerAgentToolsResponse {
    const globalDisabled = readGlobalDisabledToolNames(db);
    const agentDisabled = readDisabledToolNames(db, workspaceId);
    return {
      tools: fullToolCatalog().map((t) => ({
        ...t,
        enabled: !globalDisabled.has(t.name) && !agentDisabled.has(t.name),
        disabledGlobally: globalDisabled.has(t.name),
      })),
    };
  }

  app.get('/api/planner/workspaces/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    return noStore(reply).send(buildAgentToolsResponse(app.pocket.db, id));
  });

  app.post('/api/planner/workspaces/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const parsed = SetPlannerAgentToolRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    if (!fullToolCatalog().some((t) => t.name === parsed.data.toolName)) {
      return notFound(reply, `Unknown tool: ${parsed.data.toolName}`);
    }
    setToolEnabledForWorkspace(app.pocket.db, id, parsed.data.toolName, parsed.data.enabled);
    return buildAgentToolsResponse(app.pocket.db, id);
  });

  // ---- Skills (PA-38) ---------------------------------------------------
  //
  // Mirrors the tool routes just above exactly — a global catalog with its
  // own on/off switch, and a per-agent view layering a second, narrower
  // switch on top — plus registration/deletion, which the tool catalog has
  // no equivalent of (a tool is code shipped with this server; a skill is a
  // directory an operator points this server at). `service.get(id)` is the
  // one place both listing routes and the mutating ones below resolve an id
  // through, so "unknown skill" is answered identically everywhere.

  function mapSkillError(reply: FastifyReply, err: unknown): FastifyReply | never {
    if (err instanceof SkillRegistryError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  }

  function toGlobalSkillInfo(s: SkillSummary, globalDisabled: ReadonlySet<string>): PlannerSkillListResponse['skills'][number] {
    return { ...s, enabled: !globalDisabled.has(s.id) };
  }

  /** The global catalog for a settings page — see `GET /api/planner/tools`'s
      own doc comment for the parallel reasoning; `enabled` here is the
      global switch (PA-6 round 5's tools pattern, one layer up). */
  app.get('/api/planner/skills', async () => {
    const { db, skills } = app.pocket;
    const globalDisabled = readGlobalDisabledSkillNames(db);
    const response: PlannerSkillListResponse = {
      skills: skills.listGlobalSkills().map((s) => toGlobalSkillInfo(s, globalDisabled)),
    };
    return response;
  });

  app.post('/api/planner/skills', async (request, reply) => {
    const parsed = RegisterPlannerSkillRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const summary = await app.pocket.skills.registerGlobalSkill(parsed.data.path);
      const globalDisabled = readGlobalDisabledSkillNames(app.pocket.db);
      return reply.code(201).send(toGlobalSkillInfo(summary, globalDisabled));
    } catch (err) {
      return mapSkillError(reply, err);
    }
  });

  app.delete('/api/planner/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await app.pocket.skills.removeGlobalSkill(id);
      return reply.code(204).send();
    } catch (err) {
      return mapSkillError(reply, err);
    }
  });

  app.post('/api/planner/skills/refresh', async () => {
    const { db, skills } = app.pocket;
    skills.refresh();
    const globalDisabled = readGlobalDisabledSkillNames(db);
    const response: PlannerSkillListResponse = {
      skills: skills.listGlobalSkills().map((s) => toGlobalSkillInfo(s, globalDisabled)),
    };
    return response;
  });

  app.patch('/api/planner/skills/:id/global-enabled', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, skills } = app.pocket;
    if (!skills.get(id)) return notFound(reply, `Unknown skill: ${id}`);
    const parsed = SetPlannerSkillEnabledRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    setSkillEnabledGlobally(db, id, parsed.data.enabled);
    const globalDisabled = readGlobalDisabledSkillNames(db);
    const response: PlannerSkillListResponse = {
      skills: skills.listGlobalSkills().map((s) => toGlobalSkillInfo(s, globalDisabled)),
    };
    return response;
  });

  /** One agent's own skill subset — see `PlannerAgentSkillInfo`'s doc
      comment (protocol package). `enabled` is *effective* (global AND
      per-agent); `disabledGlobally` lets the editor grey out a checkbox the
      agent can't override. */
  function buildAgentSkillsResponse(db: Db, workspaceId: string): PlannerAgentSkillsResponse {
    const globalDisabled = readGlobalDisabledSkillNames(db);
    const agentDisabled = readDisabledSkillNames(db, workspaceId);
    return {
      skills: app.pocket.skills.listVisibleTo(workspaceId).map((s) => ({
        ...s,
        enabled: !globalDisabled.has(s.id) && !agentDisabled.has(s.id),
        disabledGlobally: globalDisabled.has(s.id),
      })),
    };
  }

  app.get('/api/planner/workspaces/:id/skills', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    return noStore(reply).send(buildAgentSkillsResponse(app.pocket.db, id));
  });

  app.post('/api/planner/workspaces/:id/skills', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const parsed = SetPlannerAgentSkillRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    if (!app.pocket.skills.get(parsed.data.skillId)) {
      return notFound(reply, `Unknown skill: ${parsed.data.skillId}`);
    }
    setSkillEnabledForWorkspace(app.pocket.db, id, parsed.data.skillId, parsed.data.enabled);
    return buildAgentSkillsResponse(app.pocket.db, id);
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

  /**
   * PA-29 phase 4: browse one agent's own memories directly — the "user can
   * observe or modify" half of the memory system, alongside the automatic
   * fold/inject/consolidate machinery. `?tier=` narrows to one tier; omitted
   * lists both, most-recent-first (`PlannerMemoryService.list`'s own
   * ordering — no relevance scoring here, unlike a real turn's injection).
   */
  app.get('/api/planner/workspaces/:id/memories', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const { tier } = request.query as { tier?: string };
    if (tier !== undefined && !PlannerMemoryTier.safeParse(tier).success) {
      return badRequest(reply, 'tier must be "short" or "long".');
    }
    const response: PlannerMemoryListResponse = {
      memories: app.pocket.plannerMemory.list(id, tier as 'short' | 'long' | undefined),
    };
    return noStore(reply).send(response);
  });

  app.patch('/api/planner/memories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePlannerMemoryRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    if (!app.pocket.plannerMemory.get(id)) return notFound(reply, 'Memory not found.');
    const updated = app.pocket.plannerMemory.update(id, parsed.data);
    return reply.send(updated);
  });

  app.delete('/api/planner/memories/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = app.pocket.plannerMemory.remove(id);
    if (!removed) return notFound(reply, 'Memory not found.');
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

  /**
   * PA-35: "delete all finished chats" for one Pocket Agent, from the home
   * screen's "..." menu. A distinct path under `/workspaces/:id/`, not a
   * query param on `DELETE /api/planner/chats/:id`, for the same reason
   * `DELETE /api/planner/models` is its own path rather than a magic `:id` —
   * no stray/mistyped id can be misread as "delete everything".
   */
  app.delete('/api/planner/workspaces/:id/chats', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const removed = app.pocket.plannerChats.removeAllForWorkspace(id);
    const response: DeleteAllPlannerChatsResponse = { removed };
    return reply.send(response);
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
   * PA-29: a read-only "as if a turn were about to run" preview of the
   * memory ranking and rolling-window trimming the next real turn would
   * apply — see `PlannerChatService.previewContext`'s doc comment for why
   * this must never call the LLM or mutate anything (no memory writes, no
   * `last_accessed_at` bumps). `noStore` for the same reason every other
   * "read something that changes turn to turn" route in this file uses it.
   */
  app.get('/api/planner/chats/:id/context-preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const response: PlannerContextPreviewResponse = await app.pocket.plannerChats.previewContext(id);
      return noStore(reply).send(response);
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
