import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { openSseStream } from './sse.js';
import {
  CALL_MCP_TOOL_NAME,
  ClaudeOAuthExchangeRequest,
  CodexDeviceCodeExchangeRequest,
  CodexDeviceCodePollRequest,
  CreatePlannerChatRequest,
  CreatePlannerModelRequest,
  CreatePlannerProviderRequest,
  CreatePlannerWorkspaceRequest,
  GeminiLiveTokenRequest,
  GeminiLiveToolCallsRequest,
  GeminiLiveTranscriptRequest,
  UpdateGeminiLiveSettingsRequest,
  LIST_MCP_TOOLS_NAME,
  PlannerMemoryTier,
  ExportPlannerSkillRequest,
  ImportPlannerSkillRequest,
  RegisterPlannerSkillRequest,
  SetPlannerAgentMcpRegistryRequest,
  SetPlannerAgentSkillRequest,
  SetPlannerAgentToolRequest,
  SetPlannerSkillEnabledRequest,
  SetPlannerToolEnabledRequest,
  UpdatePlannerMemoryRequest,
  UpdatePlannerProviderRequest,
  UpdatePlannerWorkspaceRequest,
  PlannerSendMessageRequest,
  QueuePlannerPromptRequest,
  type QueuePlannerPromptResponse,
  ResolvePlannerApprovalRequest,
  SetPlannerToolApprovalRequest,
  UpdatePlannerChatRequest,
  UpdatePlannerModelRequest,
  UpdatePlannerSettingsRequest,
  type AgentEvent,
  type ClaudeOAuthAuthorizeResponse,
  type ClaudeProviderUsageResponse,
  type CodexDeviceCodePollResponse,
  type CodexDeviceCodeStartResponse,
  type DeleteAllPlannerChatsResponse,
  type DiscoverPlannerModelsResponse,
  type GeminiLiveSettingsDto,
  type GeminiLiveTokenResponse,
  type GeminiLiveToolCallsResponse,
  type InterruptPlannerChatResponse,
  CompactPlannerChatRequest,
  type CompactPlannerChatResponse,
  type PlannerAgentMcpRegistriesResponse,
  type PlannerAgentSkillsResponse,
  type PlannerAgentToolsResponse,
  type PlannerChatHistoryResponse,
  type PlannerChatListResponse,
  type DiscoverablePlannerSkillsResponse,
  type ExportPlannerSkillResponse,
  type PlannerContextPreviewResponse,
  type PlannerEmbeddingApiKeyRevealResponse,
  type PlannerMemoryListResponse,
  type PlannerModelListResponse,
  type PlannerProvider,
  type PlannerProviderListResponse,
  type PlannerSettingsDto,
  type PlannerSkillDetailResponse,
  type PlannerSkillListResponse,
  type PlannerToolApprovalListResponse,
  type PlannerToolApprovalRow,
  type PlannerToolListResponse,
  type PlannerWorkspaceListResponse,
  type PlannerArtifact,
  type PlannerArtifactsResponse,
  type DeletePlannerArtifactResponse,
  type TestPlannerEmbeddingResponse,
  type TestPlannerModelResponse,
  type TestPlannerUrlFetchResponse,
  type TestPlannerWebSearchResponse,
  UndoTurnRequest,
  type UndoTurnResponse,
  LIMITS,
  type PromptAttachment,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import { DocWorkspaceNotFoundError, DocWorkspaceValidationError } from '../doc-workspaces/index.js';
import { PlannerWorkspaceError } from '../planner/workspaces.js';
import { PlannerChatError } from '../planner/chats.js';
import {
  exchangeAntigravityOAuthCode,
  fetchAntigravityOAuthUsage,
  hasLocalAgyCliToken,
  importLocalAgyCliTokenForProvider,
  startAntigravityOAuthAuthorization,
} from '../planner/antigravity-oauth.js';
import {
  exchangeClaudeOAuthCode,
  fetchClaudeOAuthUsage,
  startClaudeOAuthAuthorization,
  validateClaudeSetupToken,
} from '../planner/claude-oauth.js';
import {
  completeCodexBrowserDeviceFlow,
  fetchCodexOAuthUsage,
  pollCodexDeviceFlow,
  readCodexCliAuthJson,
  startCodexDeviceFlow,
} from '../planner/codex-oauth.js';
import { GEMINI_LIVE_WS_URL, GeminiLiveError } from '../planner/gemini-live.js';
import { PlannerLlmClient, PlannerLlmError } from '../planner/llm-client.js';
import { PLANNER_TOOLS, postJsonToIntegration } from '../planner/tools.js';
import { SkillRegistryError, type SkillSummary } from '../planner/skills.js';
import { auditConfigChange } from './shared.js';
import { attachmentPrincipal, sendAttachmentError } from './attachments.js';
import { AttachmentError } from '../attachments/index.js';
import { ARTIFACT_CSP } from '../security-headers.js';
import { isContained, WorkspaceError } from '../workspaces/index.js';
import { treeRootOf } from '../git/worktree-paths.js';
import { createLiveSttClient } from '../voice/live-stt-client.js';
import { SpokenTextPipeline } from '../voice/spoken-text-pipeline.js';
import { TurnTtsPump } from '../voice/turn-tts-pump.js';
import type { Config } from '../config/index.js';
import {
  DEFAULT_ANTIGRAVITY_OAUTH_BASE_URL,
  DEFAULT_CLAUDE_OAUTH_BASE_URL,
  DEFAULT_CODEX_OAUTH_BASE_URL,
  PlannerProviderStoreError,
  decryptAntigravityOAuthCredentials,
  decryptCodexOAuthCredentials,
  deleteAllPlannerModels,
  deletePlannerModel,
  deletePlannerProvider,
  deletePlannerToolApproval,
  encryptClaudeOAuthCredentials,
  encryptCodexOAuthCredentials,
  encryptPlannerProviderSecret,
  ensureDefaultPlannerProvider,
  insertPlannerModel,
  insertPlannerProvider,
  nextPlannerModelSortOrder,
  nextPlannerProviderSortOrder,
  readDisabledSkillNames,
  readDisabledToolNames,
  readGlobalDisabledSkillNames,
  readGlobalDisabledToolNames,
  readPlannerModels,
  readPlannerProvider,
  readPlannerProviders,
  readPlannerSettings,
  readPlannerToolApprovals,
  requirePlannerProviderEncKey,
  resolvePlannerUrlFetchApiKey,
  resolvePlannerWebSearchApiKey,
  revealPlannerEmbeddingApiKey,
  setMcpRegistryEnabledForWorkspace,
  setSkillEnabledForWorkspace,
  setSkillEnabledGlobally,
  setToolEnabledForWorkspace,
  setToolEnabledGlobally,
  toPlannerProviderDto,
  updatePlannerModel,
  updatePlannerProvider,
  writePlannerApiKey,
  writePlannerBaseUrl,
  writePlannerEmbeddingApiKey,
  writePlannerEmbeddingBaseUrl,
  writePlannerEmbeddingModelId,
  writePlannerMaxToolIterations,
  writePlannerMaxSubagentSpawnsPerTurn,
  writePlannerCommandTimeoutSeconds,
  writePlannerLlmIdleTimeoutSeconds,
  writePlannerAttachmentInlineCaps,
  writePlannerCompactionSettings,
  writePlannerMcpEnabled,
  writePlannerMeInstruction,
  writePlannerToolsInstruction,
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

function forbidden(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(403).send({ error: { code: 'forbidden', message } });
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

function mapGeminiError(reply: FastifyReply, err: unknown): FastifyReply | never {
  if (err instanceof GeminiLiveError) {
    return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  return mapChatError(reply, err);
}

function mapChatError(reply: FastifyReply, err: unknown): FastifyReply | never {
  if (err instanceof PlannerProviderStoreError) {
    return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof PlannerChatError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'not_configured' || err.code === 'busy' ? 409 : 400;
    return reply.code(status).send({ error: { code: err.code, message: err.message } });
  }
  if (err instanceof PlannerLlmError) {
    if (err.statusCode === 400) {
      return reply.code(400).send({ error: { code: 'bad_request', message: err.message } });
    }
    // 502: the request into this server was fine, the configured upstream
    // failed or is unreachable — not this server's own fault, and not the
    // caller's either.
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
/**
 * How long the response is held open after the turn's last event purely so
 * queued TTS audio can still be written (PA-89).
 *
 * Unlike a coding session — whose audio rides a WebSocket that outlives the
 * turn — a Pocket Agent turn's audio can only reach the browser on *this*
 * request's SSE stream. So when the generator ends, any sentence still being
 * synthesized is in a race against the response closing, and `SseStream.write`
 * silently no-ops once it has.
 *
 * This was a flat 5s, which is shorter than one synthesis: live-stt on a CPU
 * backend takes ~9.5s for a one-sentence `<speak>` summary (measured against
 * this deployment, 2026-09-23, and confirmed live — the stream closed at
 * `turn_complete` + exactly 5.00s). The summary was therefore always dropped
 * without a trace: no error, no log, just silence, which reads as "talk-back
 * is broken" and is exactly the failure PA-85's own invariant says must never
 * be silent. It went unnoticed while untagged scratchpad text was still spoken
 * *mid-turn*, because that audio was synthesized early enough to land before
 * the close; holding untagged text back removed the only thing masking it.
 *
 * It scales with the queue rather than being one number, because the two paths
 * have genuinely different shapes. A compliant `<speak>` summary is one or two
 * sentences. An *untagged* reply is held in full and released in one go at
 * `turn_complete` (see `SpokenTextPipeline.push`), so its whole length lands on
 * a pump that synthesizes strictly serially — a flat budget generous enough for
 * that case would hold the response open for minutes when a single sentence is
 * outstanding and the voice service has wedged.
 *
 * A bound is still required at all: `LiveSttClient.synthesize` puts no timeout
 * on its `fetch`, so waiting unconditionally would hand a hung voice service
 * the ability to pin a request open forever. This is the PA-68 "a wedged
 * network call is nobody's decision" case, not the approval no-decay rule — it
 * ends a *network wait* and never answers anything on a human's behalf.
 */
const TTS_DRAIN_BASE_MS = 10_000;
/** Per queued sentence, with headroom over the measured ~9.5s CPU synthesis so
 *  a slower backend than this one still drains rather than truncating. */
const TTS_DRAIN_PER_SENTENCE_MS = 15_000;
/** Absolute ceiling, so a pathological reply cannot hold a socket for ever. */
const TTS_DRAIN_HARD_CAP_MS = 180_000;

/** The drain budget for a pump with `pendingSentences` still to synthesize. */
export function ttsDrainBudgetMs(pendingSentences: number): number {
  return Math.min(
    TTS_DRAIN_HARD_CAP_MS,
    TTS_DRAIN_BASE_MS + Math.max(0, pendingSentences) * TTS_DRAIN_PER_SENTENCE_MS,
  );
}

async function streamPlannerEvents(
  request: FastifyRequest,
  reply: FastifyReply,
  generator: AsyncGenerator<AgentEvent>,
  options?: {
    voiceMode?: boolean;
    config?: Config;
    ttsTimeoutMs?: number;
  },
): Promise<void> {
  let first: IteratorResult<AgentEvent>;
  try {
    first = await generator.next();
  } catch (err) {
    mapChatError(reply, err);
    return;
  }

  // No heartbeat and no disconnect handler, deliberately — see
  // `openSseStream`'s doc comment. A chat turn is short and the browser is
  // watching it; adding either here as a side effect of PA-68 extracting this
  // writer would change behaviour this path has shipped and been tested with.
  const stream = openSseStream(request, reply);

  const liveSttUrl = options?.config?.liveSttUrl;
  const useTts = Boolean(options?.voiceMode && liveSttUrl);
  let pipeline: SpokenTextPipeline | null = null;
  let pump: TurnTtsPump | null = null;
  let pumpFinishPromise: Promise<void> | null = null;

  if (useTts && liveSttUrl) {
    const client = createLiveSttClient(liveSttUrl);
    pipeline = new SpokenTextPipeline();
    let resolveFinish: () => void = () => {};
    pumpFinishPromise = new Promise<void>((resolve) => {
      resolveFinish = resolve;
    });
    pump = new TurnTtsPump(
      crypto.randomUUID(),
      (sentence) => client.synthesize(sentence, options.config?.liveSttTtsModel),
      (chunk) => {
        if (!chunk.done) {
          // A chunk that misses the stream is the one TTS failure with no
          // exception behind it, so it has to announce itself: `write` is a
          // no-op once the response is gone, which is silence that looks
          // identical to a broken microphone. See `ttsDrainBudgetMs`.
          if (stream.closed) {
            request.log.warn(
              { bytes: chunk.data.length },
              'planner turn TTS audio discarded: the response stream closed before synthesis finished',
            );
            return;
          }
          stream.write({
            kind: 'tts_audio',
            id: crypto.randomUUID(),
            chunk: { data: chunk.data, sampleRateHz: chunk.sampleRateHz },
          } as AgentEvent);
        } else {
          resolveFinish();
        }
      },
      (err) => {
        request.log.warn({ err }, 'planner turn TTS synthesis failed');
      },
    );

    request.raw.on('close', () => {
      pump?.cancel();
      resolveFinish();
    });
  }

  try {
    const handleEvent = (event: AgentEvent) => {
      if (pump && pipeline) {
        if (event.kind === 'tool_use') {
          // PA-89: `driveLoop` streams the content of a round trip that ends
          // in tool calls as `text_delta` and then never emits it as a `text`
          // event — so the only trace of "I need to fetch the URL…" is in the
          // audio. The pipeline holds untagged text instead of speaking it,
          // so dropping it here is enough; the pump keeps whatever tagged
          // `<speak>` lede it was already given.
          pipeline.reset();
        } else if (event.kind === 'text_delta') {
          const sentences = pipeline.push(event.text);
          for (const s of sentences) pump.push(s);
        } else if (event.kind === 'turn_complete') {
          const sentences = pipeline.flush();
          for (const s of sentences) pump.push(s);
          pump.finish();
        }
      }
    };

    if (!first.done) {
      handleEvent(first.value);
      stream.write(first.value);
    }
    for await (const event of generator) {
      handleEvent(event);
      stream.write(event);
    }
    if (pumpFinishPromise && pump) {
      // Measured now rather than earlier: every sentence this turn produced has
      // been pushed by the time the generator is done, and an untagged reply
      // pushes all of them here at `turn_complete`.
      const pendingSentences = pump.pendingSentences;
      const budgetMs = options?.ttsTimeoutMs ?? ttsDrainBudgetMs(pendingSentences);
      let drained = false;
      void pumpFinishPromise.then(() => {
        drained = true;
      });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        pumpFinishPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, budgetMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (!drained) {
        request.log.warn(
          { budgetMs, pendingSentences },
          'planner turn TTS did not finish within its drain budget; remaining audio is lost',
        );
      }
    }
  } catch (err) {
    pump?.cancel();
    // Not expected in normal operation (see this function's doc comment),
    // but if something still throws mid-stream there is no status left to
    // change — a final in-band notice is the only way left to say so.
    stream.write({
      kind: 'notice',
      level: 'error',
      text: `Unexpected error: ${(err as Error).message}`,
    } satisfies AgentEvent);
  }
  stream.end();
}

/**
 * PA-6: the planner. Phase 1 (foundation) added workspaces, the model
 * catalog, and provider settings. Phase 2 (chat core) adds chat CRUD and the
 * turn loop below — still no tools and no approval gate, see PA-6 for the
 * phases that add them.
 */
export const plannerRoutes: FastifyPluginAsync = async (app) => {
  /**
   * PA-136: claims a message's uploads and lands them in the chat's workspace,
   * or answers the error itself and returns `null`. Runs after the body has
   * validated and after the chat's own preconditions, so a refused message
   * lands nothing; any failure past that point hands the uploads back to
   * staging, so the retry the error invites still finds them.
   *
   * Also why the two routes carry `bodyLimit: LIMITS.maxMessageBytes`: an
   * image still rides inline as base64, the browser shrinks one to about
   * 4.5 MB of it, and the server's 1 MiB default answered 413 to any image
   * over roughly 750 KB — every phone photo, in practice.
   */
  async function landPlannerFiles(
    request: FastifyRequest,
    reply: FastifyReply,
    chatId: string,
    ids: string[] | undefined,
    mode: 'send' | 'queue',
  ): Promise<PromptAttachment[] | null> {
    if (!ids || ids.length === 0) return [];
    try {
      app.pocket.plannerChats.assertCanAcceptFiles(chatId, mode);
      const staged = app.pocket.attachmentStaging.take(ids, attachmentPrincipal(request));
      // PA-137: awaits text extraction for any document, which is bounded per
      // file (`EXTRACT_TIMEOUT_MS`) and never fails the message.
      const landed = await app.pocket.plannerChats.landAttachments(chatId, app.pocket.attachmentStaging, staged);
      request.log.info(
        { chatId, files: landed.length, bytes: landed.reduce((n, f) => n + f.size, 0) },
        'planner attachments landed',
      );
      return landed;
    } catch (err) {
      if (err instanceof AttachmentError) {
        sendAttachmentError(reply, err);
        return null;
      }
      mapChatError(reply, err);
      return null;
    }
  }

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
      auditConfigChange(request, 'pocket agent created', {
        workspace: row.id,
        name: row.name,
        // Whether this agent's tools got trust over a directory a human
        // named, rather than app-owned scratch space. A Hub provisioning a
        // template can never set this — the template schema has no `path`.
        userChosenPath: !!parsed.data.path,
      });
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
      // PA-37 follow-up: same trivially-reversible posture as `memoryEnabled`
      // above — this agent's own half of the whole-MCP on/off switch.
      if (parsed.data.mcpEnabled !== undefined) {
        row = app.pocket.plannerWorkspaces.setMcpEnabled(id, parsed.data.mcpEnabled);
      }
      // PA-45: same trivially-reversible posture as `memoryEnabled`/`mcpEnabled`
      // above — this agent's own persona/capability text.
      if (parsed.data.identityPrompt !== undefined) {
        row = app.pocket.plannerWorkspaces.setIdentityPrompt(id, parsed.data.identityPrompt);
      }
      // PA-96: same trivially-reversible posture. The disclosure that voice
      // and tool results go to Google is rendered in the chat on every visit,
      // which is where it applies, rather than gating this switch.
      if (parsed.data.liveProvider !== undefined) {
        row = app.pocket.plannerWorkspaces.setLiveProvider(id, parsed.data.liveProvider);
      }
      auditConfigChange(request, 'pocket agent updated', {
        workspace: id,
        fields: Object.keys(parsed.data),
      });
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

  app.get('/api/planner/providers', async () => {
    const { db, config } = app.pocket;
    const response: PlannerProviderListResponse = {
      providers: readPlannerProviders(db).map((p) => toPlannerProviderDto(p, config.settingsEncKey)),
      encryptionAvailable: config.settingsEncKey !== undefined,
      hasLocalAgyAuth: hasLocalAgyCliToken(),
    };
    return response;
  });

  app.post('/api/planner/providers', async (request, reply) => {
    const parsed = CreatePlannerProviderRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config, plannerChats } = app.pocket;
    try {
      const kind = parsed.data.kind ?? 'openai-compatible';
      const baseUrl =
        (parsed.data.baseUrl ?? '').trim() ||
        (kind === 'claude-oauth'
          ? DEFAULT_CLAUDE_OAUTH_BASE_URL
          : kind === 'codex-oauth'
            ? DEFAULT_CODEX_OAUTH_BASE_URL
            : kind === 'antigravity-oauth'
              ? DEFAULT_ANTIGRAVITY_OAUTH_BASE_URL
              : '');
      let secretCiphertext: string | null = null;
      let lastTestedAt: number | null = null;

      if (kind === 'claude-oauth') {
        const trimmedSetup = (parsed.data.setupToken ?? parsed.data.apiKey ?? '').trim();
        if (trimmedSetup.length > 0) {
          requirePlannerProviderEncKey(config.settingsEncKey);
          const creds = await validateClaudeSetupToken({
            setupToken: trimmedSetup,
            baseUrl,
            ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
          });
          secretCiphertext = encryptClaudeOAuthCredentials(creds, config.settingsEncKey);
          lastTestedAt = Date.now();
        }
      } else if (kind === 'codex-oauth') {
        if (parsed.data.authMode === 'cli-readonly') {
          requirePlannerProviderEncKey(config.settingsEncKey);
          secretCiphertext = encryptCodexOAuthCredentials(
            {
              mode: 'cli-readonly',
              accessToken: null,
              refreshToken: null,
              expiresAt: null,
              accountId: null,
              planType: null,
              accountEmail: null,
              organizationName: null,
            },
            config.settingsEncKey,
          );
          const cli = readCodexCliAuthJson();
          if (cli.accessToken && !cli.expired) {
            lastTestedAt = Date.now();
          }
        }
      } else if (kind === 'antigravity-oauth') {
        if (parsed.data.authMode === 'cli-import') {
          requirePlannerProviderEncKey(config.settingsEncKey);
        }
      } else {
        const trimmedKey = (parsed.data.apiKey ?? '').trim();
        secretCiphertext =
          trimmedKey.length > 0
            ? encryptPlannerProviderSecret(trimmedKey, config.settingsEncKey)
            : null;
      }

      let row = insertPlannerProvider(db, {
        id: crypto.randomUUID(),
        label: parsed.data.label.trim(),
        kind,
        baseUrl,
        secretCiphertext,
        allowUnattended: parsed.data.allowUnattended ?? false,
        sortOrder: nextPlannerProviderSortOrder(db),
        createdAt: Date.now(),
        lastTestedAt,
      });
      if (kind === 'antigravity-oauth' && parsed.data.authMode === 'cli-import') {
        try {
          row = await importLocalAgyCliTokenForProvider({
            db,
            providerId: row.id,
            encKey: config.settingsEncKey,
            ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
          });
        } catch (err) {
          deletePlannerProvider(db, row.id);
          throw err;
        }
      }
      auditConfigChange(request, 'planner provider created', {
        provider: row.id,
        label: row.label,
        kind: row.kind,
        baseUrl: row.baseUrl,
        allowUnattended: row.allowUnattended,
      });
      const dto: PlannerProvider = toPlannerProviderDto(row, config.settingsEncKey);
      return reply.code(201).send(dto);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.patch('/api/planner/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePlannerProviderRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config, plannerChats } = app.pocket;
    const existing = readPlannerProvider(db, id);
    if (!existing) return notFound(reply, 'Provider not found.');
    try {
      let secretPatch: { secretCiphertext?: string | null; lastTestedAt?: number | null } = {};
      let hasNewSecret = false;

      if (parsed.data.clearApiKey === true) {
        secretPatch = { secretCiphertext: null };
      } else if (existing.kind === 'claude-oauth') {
        const trimmedSetup = (parsed.data.setupToken ?? parsed.data.apiKey ?? '').trim();
        if (trimmedSetup.length > 0) {
          requirePlannerProviderEncKey(config.settingsEncKey);
          const effectiveBaseUrl =
            parsed.data.baseUrl?.trim() || existing.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
          const creds = await validateClaudeSetupToken({
            setupToken: trimmedSetup,
            baseUrl: effectiveBaseUrl,
            ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
          });
          secretPatch = {
            secretCiphertext: encryptClaudeOAuthCredentials(creds, config.settingsEncKey),
            lastTestedAt: Date.now(),
          };
          hasNewSecret = true;
        }
      } else if (existing.kind === 'codex-oauth') {
        if (parsed.data.authMode === 'cli-readonly') {
          requirePlannerProviderEncKey(config.settingsEncKey);
          const cli = readCodexCliAuthJson();
          secretPatch = {
            secretCiphertext: encryptCodexOAuthCredentials(
              {
                mode: 'cli-readonly',
                accessToken: null,
                refreshToken: null,
                expiresAt: null,
                accountId: null,
                planType: null,
                accountEmail: null,
                organizationName: null,
              },
              config.settingsEncKey,
            ),
            ...(cli.accessToken && !cli.expired ? { lastTestedAt: Date.now() } : {}),
          };
          hasNewSecret = true;
        } else if (parsed.data.authMode === 'device-code') {
          const { credentials } = existing.secretCiphertext
            ? decryptCodexOAuthCredentials(existing, config.settingsEncKey)
            : { credentials: null };
          if (credentials?.mode === 'cli-readonly') {
            secretPatch = { secretCiphertext: null };
            hasNewSecret = true;
          }
        }
      } else if (existing.kind === 'antigravity-oauth') {
        if (parsed.data.authMode === 'cli-import') {
          requirePlannerProviderEncKey(config.settingsEncKey);
          hasNewSecret = true;
        } else if (parsed.data.authMode === 'oauth') {
          const { credentials } = existing.secretCiphertext
            ? decryptAntigravityOAuthCredentials(existing, config.settingsEncKey)
            : { credentials: null };
          if (credentials?.mode === 'cli-import') {
            secretPatch = { secretCiphertext: null };
            hasNewSecret = true;
          }
        }
      } else {
        const trimmedKey = (parsed.data.apiKey ?? '').trim();
        if (trimmedKey.length > 0) {
          secretPatch = {
            secretCiphertext: encryptPlannerProviderSecret(trimmedKey, config.settingsEncKey),
          };
          hasNewSecret = true;
        }
      }

      const resetError =
        parsed.data.baseUrl !== undefined || parsed.data.clearApiKey === true || hasNewSecret
          ? { lastError: null as string | null }
          : {};
      let updated = updatePlannerProvider(db, id, {
        ...(parsed.data.label !== undefined ? { label: parsed.data.label.trim() } : {}),
        ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl.trim() } : {}),
        ...(parsed.data.allowUnattended !== undefined
          ? { allowUnattended: parsed.data.allowUnattended }
          : {}),
        ...secretPatch,
        ...resetError,
      });
      if (!updated) return notFound(reply, 'Provider not found.');
      if (existing.kind === 'antigravity-oauth' && parsed.data.authMode === 'cli-import' && parsed.data.clearApiKey !== true) {
        updated = await importLocalAgyCliTokenForProvider({
          db,
          providerId: id,
          encKey: config.settingsEncKey,
          ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
        });
      }
      auditConfigChange(request, 'planner provider updated', {
        provider: id,
        fields: Object.keys(parsed.data),
        ...(parsed.data.allowUnattended === undefined
          ? {}
          : { allowUnattended: parsed.data.allowUnattended }),
      });
      const dto: PlannerProvider = toPlannerProviderDto(updated, config.settingsEncKey);
      return reply.send(dto);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/antigravity/import-cli', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'antigravity-oauth') {
      return badRequest(reply, 'Antigravity CLI import is only supported for antigravity-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      const updated = await importLocalAgyCliTokenForProvider({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      auditConfigChange(request, 'planner provider antigravity cli imported', {
        provider: id,
        authMode: 'cli-import',
      });
      const dto: PlannerProvider = toPlannerProviderDto(updated, config.settingsEncKey);
      return noStore(reply).send(dto);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/oauth/authorize', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, config } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'claude-oauth' && provider.kind !== 'antigravity-oauth') {
      return badRequest(reply, 'OAuth sign-in is only supported for claude-oauth and antigravity-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      const response: ClaudeOAuthAuthorizeResponse =
        provider.kind === 'antigravity-oauth'
          ? startAntigravityOAuthAuthorization(id)
          : startClaudeOAuthAuthorization(id);
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/oauth/exchange', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ClaudeOAuthExchangeRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'claude-oauth' && provider.kind !== 'antigravity-oauth') {
      return badRequest(reply, 'OAuth code exchange is only supported for claude-oauth and antigravity-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      if (provider.kind === 'antigravity-oauth') {
        const updated = await exchangeAntigravityOAuthCode({
          db,
          providerId: id,
          code: parsed.data.code,
          ...(parsed.data.state ? { state: parsed.data.state } : {}),
          encKey: config.settingsEncKey,
          ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
        });
        auditConfigChange(request, 'planner provider antigravity oauth connected', {
          provider: id,
          authMode: 'oauth',
        });
        const dto: PlannerProvider = toPlannerProviderDto(updated, config.settingsEncKey);
        return noStore(reply).send(dto);
      }
      const creds = await exchangeClaudeOAuthCode({
        providerId: id,
        rawCode: parsed.data.code,
        explicitState: parsed.data.state,
        baseUrl: provider.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      const updated = updatePlannerProvider(db, id, {
        secretCiphertext: encryptClaudeOAuthCredentials(creds, config.settingsEncKey),
        lastTestedAt: Date.now(),
        lastError: null,
      });
      if (!updated) return notFound(reply, 'Provider not found.');
      auditConfigChange(request, 'planner provider oauth connected', {
        provider: id,
        authMode: 'oauth',
      });
      const dto: PlannerProvider = toPlannerProviderDto(updated, config.settingsEncKey);
      return noStore(reply).send(dto);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/codex/device/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'codex-oauth') {
      return badRequest(reply, 'Codex device-code login is only supported for codex-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      const response: CodexDeviceCodeStartResponse = await startCodexDeviceFlow(id, plannerChats.llmFetch);
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/codex/device/poll', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CodexDeviceCodePollRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'codex-oauth') {
      return badRequest(reply, 'Codex device-code polling is only supported for codex-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      const response: CodexDeviceCodePollResponse = await pollCodexDeviceFlow({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        deviceAuthId: parsed.data.deviceAuthId,
        userCode: parsed.data.userCode,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      if (response.status === 'completed') {
        auditConfigChange(request, 'planner provider codex device-code connected', {
          provider: id,
          authMode: 'device-code',
        });
      }
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.post('/api/planner/providers/:id/codex/device/complete', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CodexDeviceCodeExchangeRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind !== 'codex-oauth') {
      return badRequest(reply, 'Codex device-code completion is only supported for codex-oauth providers.');
    }
    try {
      requirePlannerProviderEncKey(config.settingsEncKey);
      const updated = await completeCodexBrowserDeviceFlow({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        body: parsed.data,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      auditConfigChange(request, 'planner provider codex device-code connected', {
        provider: id,
        authMode: 'device-code',
        browserFallback: true,
      });
      const dto: PlannerProvider = toPlannerProviderDto(updated, config.settingsEncKey);
      return noStore(reply).send(dto);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.get('/api/planner/providers/:id/usage', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, config, plannerChats } = app.pocket;
    const provider = readPlannerProvider(db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    if (provider.kind === 'claude-oauth') {
      const response: ClaudeProviderUsageResponse = await fetchClaudeOAuthUsage({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      return noStore(reply).send(response);
    }
    if (provider.kind === 'codex-oauth') {
      const response: ClaudeProviderUsageResponse = await fetchCodexOAuthUsage({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      return noStore(reply).send(response);
    }
    if (provider.kind === 'antigravity-oauth') {
      const response: ClaudeProviderUsageResponse = await fetchAntigravityOAuthUsage({
        db,
        providerId: id,
        encKey: config.settingsEncKey,
        ...(plannerChats.llmFetch ? { fetchImpl: plannerChats.llmFetch } : {}),
      });
      return noStore(reply).send(response);
    }
    return badRequest(
      reply,
      'Subscription usage is only supported for claude-oauth, codex-oauth, and antigravity-oauth providers.',
    );
  });

  app.delete('/api/planner/providers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const removed = deletePlannerProvider(app.pocket.db, id);
    if (!removed) return notFound(reply, 'Provider not found.');
    auditConfigChange(request, 'planner provider deleted', { provider: id });
    return reply.code(204).send();
  });

  app.get('/api/planner/providers/:id/models/discover', async (request, reply) => {
    const { id } = request.params as { id: string };
    const provider = readPlannerProvider(app.pocket.db, id);
    if (!provider) return notFound(reply, 'Provider not found.');
    try {
      const modelIds = await app.pocket.plannerChats.discoverModels(id);
      const response: DiscoverPlannerModelsResponse = { modelIds };
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.get('/api/planner/models', async (request) => {
    const { providerId } = (request.query ?? {}) as { providerId?: string };
    const response: PlannerModelListResponse = {
      models: readPlannerModels(
        app.pocket.db,
        providerId && providerId.length > 0 ? providerId : undefined,
      ),
    };
    return response;
  });

  app.post('/api/planner/models', async (request, reply) => {
    const parsed = CreatePlannerModelRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db } = app.pocket;
    let providerId = parsed.data.providerId?.trim() || undefined;
    if (providerId) {
      if (!readPlannerProvider(db, providerId)) {
        return notFound(reply, 'Provider not found.');
      }
    } else {
      providerId = ensureDefaultPlannerProvider(db).id;
    }
    const row = {
      id: crypto.randomUUID(),
      providerId,
      modelId: parsed.data.modelId,
      label: parsed.data.label,
      supportsEffort: parsed.data.supportsEffort ?? true,
      defaultEffort: parsed.data.defaultEffort ?? null,
      contextWindow: parsed.data.contextWindow ?? null,
      maxOutputTokens: parsed.data.maxOutputTokens ?? null,
      promptCaching: parsed.data.promptCaching ?? null,
      inputPricePerMTok: parsed.data.inputPricePerMTok ?? null,
      outputPricePerMTok: parsed.data.outputPricePerMTok ?? null,
      cacheReadPricePerMTok: parsed.data.cacheReadPricePerMTok ?? null,
      cacheWritePricePerMTok: parsed.data.cacheWritePricePerMTok ?? null,
      supportsImages: parsed.data.supportsImages ?? null,
      supportsPdf: parsed.data.supportsPdf ?? null,
      sortOrder: nextPlannerModelSortOrder(db),
      createdAt: Date.now(),
    };
    insertPlannerModel(db, row);
    auditConfigChange(request, 'planner model added to the catalog', {
      model: row.id,
      provider: row.providerId,
      modelId: row.modelId,
    });
    return reply.code(201).send(row);
  });

  app.patch('/api/planner/models/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdatePlannerModelRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const updated = updatePlannerModel(app.pocket.db, id, parsed.data);
    if (!updated) return notFound(reply, 'Model not found.');
    auditConfigChange(request, 'planner model updated in the catalog', {
      model: id,
      fields: Object.keys(parsed.data),
    });
    return reply.send(updated);
  });

  /**
   * Empty the catalog (PA-6 round 7's "delete all"). A distinct path from
   * `DELETE /:id` below rather than a magic `:id` value, so there is no way
   * for a stray/mistyped id to wipe every row. Optionally scoped to a single
   * provider (`?providerId=`).
   */
  app.delete('/api/planner/models', async (request, reply) => {
    const { providerId } = (request.query ?? {}) as { providerId?: string };
    const removed = deleteAllPlannerModels(
      app.pocket.db,
      providerId && providerId.length > 0 ? providerId : undefined,
    );
    app.log.info({ removed, providerId: providerId ?? null }, 'planner model catalog emptied');
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
  app.get('/api/planner/models/discover', async (request, reply) => {
    const { providerId } = (request.query ?? {}) as { providerId?: string };
    try {
      const modelIds = await app.pocket.plannerChats.discoverModels(
        providerId && providerId.length > 0 ? providerId : undefined,
      );
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
      const result = await app.pocket.plannerChats.testModel(model);
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
   *
   * PA-148: `baseUrl` and `apiKey` continue to read/write the Default
   * `planner_providers` row (`id = 'default'`, or the first provider) for
   * backwards compatibility.
   */
  app.patch('/api/planner/settings', async (request, reply) => {
    const parsed = UpdatePlannerSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const { db, config } = app.pocket;
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
      mcpEnabled,
      meInstruction,
      toolsInstruction,
      maxToolIterations,
      maxSubagentSpawnsPerTurn,
      commandTimeoutSeconds,
      llmIdleTimeoutSeconds,
      compactionEnabled,
      compactionReserveTokens,
      compactionKeepRecentTokens,
      attachmentInlineTextMaxBytes,
      attachmentInlineExtractMaxTokens,
    } = parsed.data;
    try {
      if (apiKey !== undefined) {
        writePlannerApiKey(db, apiKey.length > 0 ? apiKey : null, config.settingsEncKey);
      }
      if (baseUrl !== undefined) writePlannerBaseUrl(db, baseUrl);
    } catch (err) {
      return mapChatError(reply, err);
    }
    if (yoloEnabled !== undefined) writePlannerYoloEnabled(db, yoloEnabled);
    // PA-29: the embedding provider's own settings, same "only touch what's
    // sent" idiom as the chat-settings fields above.
    if (embeddingBaseUrl !== undefined) writePlannerEmbeddingBaseUrl(db, embeddingBaseUrl);
    if (embeddingApiKey !== undefined) {
      writePlannerEmbeddingApiKey(db, embeddingApiKey.length > 0 ? embeddingApiKey : null);
    }
    if (embeddingModelId !== undefined) writePlannerEmbeddingModelId(db, embeddingModelId);
    if (
      embeddingBaseUrl !== undefined ||
      embeddingApiKey !== undefined ||
      embeddingModelId !== undefined
    ) {
      app.pocket.docWorkspaces.onEmbeddingSettingsChanged();
    }
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
    // PA-37 follow-up: the global half of the whole-MCP on/off switch.
    if (mcpEnabled !== undefined) writePlannerMcpEnabled(db, mcpEnabled);
    // PA-45: the "me"/"tools" context instructions, same "only touch what's
    // sent, null clears it" idiom as every field above.
    if (meInstruction !== undefined) writePlannerMeInstruction(db, meInstruction);
    if (toolsInstruction !== undefined) writePlannerToolsInstruction(db, toolsInstruction);
    if (maxToolIterations !== undefined) writePlannerMaxToolIterations(db, maxToolIterations);
    if (maxSubagentSpawnsPerTurn !== undefined) {
      writePlannerMaxSubagentSpawnsPerTurn(db, maxSubagentSpawnsPerTurn);
    }
    if (commandTimeoutSeconds !== undefined) {
      writePlannerCommandTimeoutSeconds(db, commandTimeoutSeconds);
    }
    // PA-121: the LLM stream's idle timeout and context compaction.
    if (llmIdleTimeoutSeconds !== undefined) writePlannerLlmIdleTimeoutSeconds(db, llmIdleTimeoutSeconds);
    writePlannerCompactionSettings(db, {
      ...(compactionEnabled !== undefined ? { enabled: compactionEnabled } : {}),
      ...(compactionReserveTokens !== undefined ? { reserveTokens: compactionReserveTokens } : {}),
      ...(compactionKeepRecentTokens !== undefined ? { keepRecentTokens: compactionKeepRecentTokens } : {}),
    });
    // PA-137: how big an attachment may be and still be inlined.
    writePlannerAttachmentInlineCaps(db, {
      ...(attachmentInlineTextMaxBytes !== undefined ? { textMaxBytes: attachmentInlineTextMaxBytes } : {}),
      ...(attachmentInlineExtractMaxTokens !== undefined ? { extractMaxTokens: attachmentInlineExtractMaxTokens } : {}),
    });
    // Field names only: API keys may be among them.
    auditConfigChange(request, 'planner settings updated', {
      fields: Object.keys(parsed.data),
    });
    const dto: PlannerSettingsDto = readPlannerSettings(db);
    return reply.send(dto);
  });

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
   * The native tool catalog. **MCP tools are deliberately not listed here**
   * (PA-37 follow-up, reversing that ticket's own first cut: "Let's not list
   * the mcp tool as separate tools to allow/disallow. Let's just
   * enable/disable mcp as whole for global or each agent.") — the individual
   * tools an MCP registry exposes have their own whole-MCP on/off switch
   * instead (`PlannerSettingsDto.mcpEnabled` / `PlannerWorkspace.mcpEnabled`,
   * plus the per-registry layer), surfaced on the MCP servers section of the
   * settings page and the agent editor's own MCP section, not here.
   *
   * PA-37 round three (prod bug report: an agent that looked fully
   * configured — MCP enabled globally and per-agent, registry enabled and
   * connected — still had no MCP tools, because `list_mcp_tools`/
   * `call_mcp_tool` themselves were, until this fix, plain `PLANNER_TOOLS`
   * members that ALSO went through the ordinary global/per-agent tool
   * deny-list (`chats.ts`'s `toolsFor`) — an operator could uncheck one of
   * these two rows in the everyday Tools list without any indication it was
   * MCP-related, silently reintroducing exactly the per-tool footgun the
   * comment above says was deliberately removed, just one level of
   * indirection up. Both are now excluded from this catalog entirely (so
   * neither the global nor the per-agent Tools UI offers them as a
   * checkbox at all — a checkbox that did nothing once MCP's own switches
   * governed the outcome would only be confusing), and `chats.ts`'s
   * `toolsFor` no longer subjects them to `readGlobalDisabledToolNames`/
   * `readDisabledToolNames` — the whole-MCP switches are their one and
   * only gate, matching the follow-up's intent for real.
   */
  function fullToolCatalog(): { name: string; description: string; readOnly: boolean }[] {
    return PLANNER_TOOLS.filter((t) => t.name !== LIST_MCP_TOOLS_NAME && t.name !== CALL_MCP_TOOL_NAME).map((t) => ({
      name: t.name,
      description: t.description,
      readOnly: t.readOnly,
    }));
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

  /**
   * PA-109: returns one skill's metadata and body (frontmatter stripped).
   * Needed by the Hub template exporter so an operator can turn an existing
   * host-side global skill into a `skill` template without re-typing its body.
   */
  app.get('/api/planner/skills/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { db, skills } = app.pocket;
    const summary = skills.get(id);
    if (!summary) return notFound(reply, `Unknown skill: ${id}`);
    try {
      const body = await skills.loadSkillBody(id);
      const globalDisabled = readGlobalDisabledSkillNames(db);
      const response: PlannerSkillDetailResponse = {
        ...toGlobalSkillInfo(summary, globalDisabled),
        body,
      };
      return reply.send(response);
    } catch (err) {
      return mapSkillError(reply, err);
    }
  });

  app.post('/api/planner/skills', async (request, reply) => {
    const parsed = RegisterPlannerSkillRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const summary = await app.pocket.skills.registerGlobalSkill(parsed.data.path);
      const globalDisabled = readGlobalDisabledSkillNames(app.pocket.db);
      auditConfigChange(request, 'global skill registered', {
        skill: summary.id,
        name: summary.name,
      });
      return reply.code(201).send(toGlobalSkillInfo(summary, globalDisabled));
    } catch (err) {
      return mapSkillError(reply, err);
    }
  });

  /**
   * PA-70: register a global skill from its *content*.
   *
   * The route above takes a directory on this machine, which is exactly what a
   * Hub provisioning a fleet cannot supply — so this is the one new backend
   * surface that ticket adds, and `ImportPlannerSkillRequest`'s own doc
   * comment carries the reasoning for accepting a body at all.
   *
   * It is a sibling path rather than a flag on the route above because the two
   * take disjoint inputs: a request carrying both a path and a body, or
   * neither, would have to be refused by a runtime check that a `z.union`
   * expresses worse than two routes do.
   */
  app.post('/api/planner/skills/import', async (request, reply) => {
    const parsed = ImportPlannerSkillRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const summary = await app.pocket.skills.importGlobalSkill(parsed.data);
      const globalDisabled = readGlobalDisabledSkillNames(app.pocket.db);
      auditConfigChange(request, 'global skill imported from content', {
        skill: summary.id,
        name: summary.name,
        overwrote: parsed.data.overwrite === true,
      });
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

  /**
   * PA-38 round 2: "a way from UI to 'promote' any skills to global in case
   * needed." No body — the id in the URL is everything this needs, per
   * `SkillRegistryService.promoteToGlobal`'s own doc comment on why this
   * takes an id rather than a path. Reuses `toGlobalSkillInfo`/
   * `mapSkillError` exactly like `POST /api/planner/skills` does, since the
   * response shape (a newly-global `PlannerSkillInfo`) is identical.
   */
  app.post('/api/planner/skills/:id/promote', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const summary = await app.pocket.skills.promoteToGlobal(id);
      const globalDisabled = readGlobalDisabledSkillNames(app.pocket.db);
      return reply.code(200).send(toGlobalSkillInfo(summary, globalDisabled));
    } catch (err) {
      return mapSkillError(reply, err);
    }
  });

  /**
   * PA-55: copy one catalog skill into a project's `.claude/skills/` and/or
   * `.agents/skills/`, the reverse of the discover-and-import pair below.
   * Every containment, symlink and overwrite rule lives in
   * `SkillRegistryService.exportToProject`. This route only maps errors,
   * reports whether a session is mid-turn in that tree, and writes the
   * audit line. It never logs the skill's body.
   *
   * Deliberately absent from the planner tool catalog and from `/mcp`: an
   * export is a human's decision, which is why the approval gate needs no
   * new rule for it.
   */
  app.post('/api/planner/skills/:id/export', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ExportPlannerSkillRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const { projectRoot, results } = await app.pocket.skills.exportToProject({
        skillId: id,
        projectPath: parsed.data.projectPath,
        targets: parsed.data.targets,
        overwrite: parsed.data.overwrite,
      });
      auditConfigChange(request, 'skill exported into a project tree', {
        skill: id,
        projectPath: projectRoot,
        targets: results.map((r) => r.target),
        overwrote: results.some((r) => r.overwrote),
      });
      const tree = treeRootOf(projectRoot);
      const response: ExportPlannerSkillResponse = {
        results,
        busy: app.pocket.sessions.busyTreeRoots().includes(tree),
      };
      return reply.code(200).send(response);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      return mapSkillError(reply, err);
    }
  });

  /**
   * PA-38 round 2: "You can have a UI, globally scan and user can choose to
   * import." A stateless scan (see `discoverImportableSkills`'s own doc
   * comment) — the frontend imports one by calling the *existing*
   * `POST /api/planner/skills` with the discovered `path`, so no separate
   * import route was needed.
   */
  app.get('/api/planner/skills/discoverable', async () => {
    const response: DiscoverablePlannerSkillsResponse = { skills: app.pocket.skills.discoverImportableSkills() };
    return response;
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

  /**
   * One agent's own MCP registry subset (PA-37 follow-up round two) — see
   * `PlannerAgentMcpRegistryInfo`'s doc comment (protocol package). Unlike
   * tools/skills, there is no separate "global disabled registry names"
   * read here: a registry's own `enabled` column *is* the global layer
   * (`McpRegistryService.listForWorkspace` already folds it into
   * `disabledGlobally`), so this route is a thin pass-through rather than a
   * second `buildAgent*Response` merging two deny-lists.
   */
  app.get('/api/planner/workspaces/:id/mcp-registries', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const response: PlannerAgentMcpRegistriesResponse = { registries: app.pocket.mcpRegistry.listForWorkspace(id) };
    return noStore(reply).send(response);
  });

  app.post('/api/planner/workspaces/:id/mcp-registries', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!app.pocket.plannerWorkspaces.get(id)) return notFound(reply, 'Workspace not found.');
    const parsed = SetPlannerAgentMcpRegistryRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    if (!app.pocket.mcpRegistry.listForWorkspace(id).some((r) => r.id === parsed.data.registryId)) {
      return notFound(reply, `Unknown MCP registry: ${parsed.data.registryId}`);
    }
    setMcpRegistryEnabledForWorkspace(app.pocket.db, id, parsed.data.registryId, parsed.data.enabled);
    const response: PlannerAgentMcpRegistriesResponse = { registries: app.pocket.mcpRegistry.listForWorkspace(id) };
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

  app.get('/api/planner/chats/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const chat = app.pocket.plannerChats.get(id);
    if (!chat) return notFound(reply, 'Chat not found.');
    return reply.send(chat);
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
      if (parsed.data.effort !== undefined) chat = plannerChats.setEffort(id, parsed.data.effort);
      if (parsed.data.thinking !== undefined) chat = plannerChats.setThinking(id, parsed.data.thinking);
      if (parsed.data.docWorkspaceId !== undefined) chat = plannerChats.setDocWorkspace(id, parsed.data.docWorkspaceId);
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

  app.delete('/api/planner/chats/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await app.pocket.plannerChats.clearHistory(id);
      return reply.code(204).send();
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.get('/api/planner/chats/:id/subagents', async (request, reply) => {
    const { id } = request.params as { id: string };
    const chat = app.pocket.plannerChats.get(id);
    if (!chat) return notFound(reply, 'Chat not found.');
    return {
      subagents: app.pocket.sessions.listByPlannerChatId(id),
      plannerChats: app.pocket.plannerChats.listByParentChatId(id),
    };
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
   * PA-76: Subscribe-only SSE stream for chat events, backed by
   * PlannerChatService.observe(). Surfaces background turns (cron, webhooks,
   * Telegram, subagent wake) live in the UI without requiring page reloads.
   */
  app.get('/api/planner/chats/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const chat = app.pocket.plannerChats.get(id);
    if (!chat) return notFound(reply, 'Chat not found.');

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });

    const write = (event: AgentEvent): void => {
      try {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // connection closed
      }
    };

    const unsubscribe = app.pocket.plannerChats.observe(id, (event) => {
      write(event);
    });

    reply.raw.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // connection closed
      }
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * Streams one turn as it happens — see `streamPlannerEvents`'s doc comment
   * for the precondition-vs-in-band-error split this depends on, and
   * `PlannerChatHistoryResponse`'s doc comment (protocol package) for what
   * "streamed" does and does not mean here. The frontend disables its
   * composer for the duration, the same "one turn in flight at a time"
   * discipline `PromptBox` already applies to a structured session.
   */
  app.post('/api/planner/chats/:id/messages', { bodyLimit: LIMITS.maxMessageBytes }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = PlannerSendMessageRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const files = await landPlannerFiles(request, reply, id, parsed.data.attachments, 'send');
    if (files === null) return reply;
    // PA-137: extracting a document's text takes a moment, and another turn
    // may have started in it. The message is refused as before, and what it
    // landed goes again, so a 409 still leaves nothing behind.
    if (files.length > 0 && app.pocket.plannerChats.isBusy(id)) {
      app.pocket.plannerChats.removeAttachments(id, files);
      return mapChatError(reply, new PlannerChatError('A turn is already in flight for this chat.', 'busy'));
    }
    const generator = app.pocket.plannerChats.sendMessage(
      id,
      parsed.data.content,
      {
        ...(parsed.data.modelId ? { modelId: parsed.data.modelId } : {}),
        ...(parsed.data.effort !== undefined ? { effort: parsed.data.effort } : {}),
        ...(parsed.data.thinking !== undefined ? { thinking: parsed.data.thinking } : {}),
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        ...(parsed.data.voiceMode !== undefined ? { voiceMode: parsed.data.voiceMode } : {}),
      },
    );
    await streamPlannerEvents(request, reply, generator, {
      voiceMode: parsed.data.voiceMode,
      config: app.pocket.config,
    });
  });

  /**
   * PA-122: a message sent while the chat is busy — queued, and delivered
   * after the running turn's current tool batch or as the next turn (or at
   * once, if the turn ended before it arrived). `POST .../messages` still
   * answers 409 `busy` for a busy chat: cron, webhooks and MCP rely on that,
   * and only a person at the chat should be able to steer a turn.
   */
  app.post('/api/planner/chats/:id/queue', { bodyLimit: LIMITS.maxMessageBytes }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = QueuePlannerPromptRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    const files = await landPlannerFiles(request, reply, id, parsed.data.attachments, 'queue');
    if (files === null) return reply;
    try {
      const prompt = app.pocket.plannerChats.queuePrompt(id, parsed.data.content, {
        ...(parsed.data.image ? { image: parsed.data.image } : {}),
        ...(files.length > 0 ? { attachments: files } : {}),
        ...(parsed.data.voiceMode !== undefined ? { voiceMode: parsed.data.voiceMode } : {}),
      });
      const response: QueuePlannerPromptResponse = {
        prompt,
        queuedPrompts: app.pocket.plannerChats.queuedPrompts(id),
      };
      return noStore(reply).code(201).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  app.delete('/api/planner/chats/:id/queue/:promptId', async (request, reply) => {
    const { id, promptId } = request.params as { id: string; promptId: string };
    try {
      if (!app.pocket.plannerChats.cancelQueuedPrompt(id, promptId)) {
        return notFound(reply, 'That message is no longer queued — it may already have been delivered.');
      }
      return reply.code(204).send();
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /**
   * PA-99: Interrupts an in-flight planner turn or dismisses a pending approval.
   */
  app.post('/api/planner/chats/:id/interrupt', async (request, reply) => {
    const { id } = request.params as { id: string };
    const chat = app.pocket.plannerChats.get(id);
    if (!chat) return notFound(reply, 'Chat not found.');
    const interrupted = await app.pocket.plannerChats.interrupt(id);
    const response: InterruptPlannerChatResponse = { ok: true, interrupted };
    return noStore(reply).send(response);
  });

  // PA-121: `/compact` — summarize the history now. The work is one LLM call,
  // so this answers when it is done rather than streaming; the
  // `context_compaction` event reaches an open chat through `/events`.
  app.post('/api/planner/chats/:id/compact', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = CompactPlannerChatRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const result = await app.pocket.plannerChats.compact(id, parsed.data.focus ?? null);
      const response: CompactPlannerChatResponse = result;
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  // PA-143: Undo all workspace file mutations from a single turn.
  app.post('/api/planner/chats/:id/turns/:turnId/undo', async (request, reply) => {
    const { id, turnId } = request.params as { id: string; turnId: string };
    const parsed = UndoTurnRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const response: UndoTurnResponse = await app.pocket.plannerChats.undoTurn(
        id,
        turnId,
        parsed.data,
      );
      return noStore(reply).send(response);
    } catch (err) {
      if (err instanceof DocWorkspaceNotFoundError) {
        return notFound(reply, err.message);
      }
      if (err instanceof DocWorkspaceValidationError) {
        return badRequest(reply, err.message);
      }
      return mapChatError(reply, err);
    }
  });

  // ---- Gemini Live (PA-96) --------------------------------------------------

  /**
   * The feature's settings. Never the key: there is no reveal route for it,
   * the same posture a custom Claude provider's key and a Telegram bot token
   * have — nothing outside this server ever needs to read it back.
   */
  app.get('/api/planner/gemini-live', async (_request, reply) => {
    const dto: GeminiLiveSettingsDto = app.pocket.geminiLive.settings();
    return noStore(reply).send(dto);
  });

  app.patch('/api/planner/gemini-live', async (request, reply) => {
    const parsed = UpdateGeminiLiveSettingsRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const dto = app.pocket.geminiLive.update(parsed.data);
      // Field names only, never values — `apiKey` is one of them, and an audit
      // line must not be one step away from recovering a credential.
      auditConfigChange(request, 'gemini live settings updated', {
        fields: Object.keys(parsed.data).filter((k) => k !== 'apiKey' || !!parsed.data.apiKey?.trim()),
      });
      return noStore(reply).send(dto);
    } catch (err) {
      return mapGeminiError(reply, err);
    }
  });

  /**
   * Mints the constraint-locked ephemeral token a browser opens its Gemini
   * Live WebSocket with, seeded with this chat's real context. Refused unless
   * the chat's agent is set to Gemini Live — the per-agent setting is the
   * gate, not merely a UI preference — and while the planner LLM owns the
   * chat. Rate-limited because each call is an outbound request billed to
   * the operator's key; logged by chat id, never the token.
   */
  app.post(
    '/api/planner/chats/:id/live/token',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = GeminiLiveTokenRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
      }
      const { plannerChats, plannerWorkspaces, geminiLive } = app.pocket;
      const chat = plannerChats.get(id);
      if (!chat) return notFound(reply, 'Chat not found.');
      const workspace = chat.workspaceId ? plannerWorkspaces.get(chat.workspaceId) : undefined;
      if (workspace?.liveProvider !== 'gemini-live') {
        return reply.code(409).send({
          error: { code: 'not_gemini_live', message: "This chat's agent is not set to use Gemini Live." },
        });
      }
      try {
        const resumed = parsed.data.resumeHandle !== undefined;
        const setup = await plannerChats.liveSetup(id, { resumed });
        const minted = await geminiLive.mintToken({
          systemInstruction: setup.systemInstruction,
          functionDeclarations: setup.functionDeclarations,
          ...(parsed.data.resumeHandle ? { resumeHandle: parsed.data.resumeHandle } : {}),
        });
        app.log.info(
          { chatId: id, model: minted.model, resumed, tools: setup.functionDeclarations.length },
          'gemini live token minted',
        );
        const response: GeminiLiveTokenResponse = {
          token: minted.token,
          wsUrl: GEMINI_LIVE_WS_URL,
          model: minted.model,
          expiresAt: minted.expiresAt,
          newSessionExpiresAt: minted.newSessionExpiresAt,
          seedTurns: setup.seedTurns,
          resumed,
          idleMinutes: geminiLive.idleMinutes(),
        };
        return noStore(reply).send(response);
      } catch (err) {
        return mapGeminiError(reply, err);
      }
    },
  );

  /**
   * The tool bridge. Gemini's `toolCall` arrives in the browser, which
   * forwards it here; each call runs through the planner's own gate and
   * `executeTool` — see `PlannerChatService.runLiveToolCalls`. The request
   * carries calls only, so the browser has no way to claim an approval.
   */
  app.post('/api/planner/chats/:id/live/tool-calls', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = GeminiLiveToolCallsRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      const response: GeminiLiveToolCallsResponse = {
        results: await app.pocket.plannerChats.runLiveToolCalls(id, parsed.data.calls),
      };
      return noStore(reply).send(response);
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /** What Gemini heard and said, persisted into the chat's transcript. */
  app.post('/api/planner/chats/:id/live/transcript', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = GeminiLiveTranscriptRequest.safeParse(request.body);
    if (!parsed.success) {
      return badRequest(reply, parsed.error.issues[0]?.message ?? 'Invalid body.');
    }
    try {
      await app.pocket.plannerChats.recordLiveTranscript(id, parsed.data);
      return reply.code(204).send();
    } catch (err) {
      return mapChatError(reply, err);
    }
  });

  /** Best-effort "live mode is off" — releases deferred subagent wakes. */
  app.post('/api/planner/chats/:id/live/end', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      app.pocket.plannerChats.endLive(id);
      return reply.code(204).send();
    } catch (err) {
      return mapChatError(reply, err);
    }
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
    await streamPlannerEvents(request, reply, generator);
  });

  // ---- Artifacts (PA-128) ---------------------------------------------------

  function mimeTypeForArtifact(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case '.html':
      case '.htm':
        return 'text/html; charset=utf-8';
      case '.md':
      case '.markdown':
        return 'text/markdown; charset=utf-8';
      case '.txt':
      case '.log':
        return 'text/plain; charset=utf-8';
      case '.json':
        return 'application/json; charset=utf-8';
      case '.csv':
        return 'text/csv; charset=utf-8';
      case '.pdf':
        return 'application/pdf';
      case '.png':
        return 'image/png';
      case '.jpg':
      case '.jpeg':
        return 'image/jpeg';
      case '.gif':
        return 'image/gif';
      case '.svg':
        return 'image/svg+xml';
      case '.webp':
        return 'image/webp';
      case '.xml':
        return 'application/xml; charset=utf-8';
      case '.yaml':
      case '.yml':
        return 'text/yaml; charset=utf-8';
      case '.css':
        return 'text/css; charset=utf-8';
      case '.js':
        return 'text/javascript; charset=utf-8';
      case '.ts':
        return 'text/plain; charset=utf-8';
      default:
        return 'application/octet-stream';
    }
  }

  async function listArtifactFiles(artifactsDir: string): Promise<PlannerArtifact[]> {
    const results: PlannerArtifact[] = [];
    async function walk(currentDir: string, relativeDir: string) {
      let entries: fs.Dirent[];
      try {
        entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // ignore hidden files
        const fullPath = path.join(currentDir, entry.name);
        const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(fullPath, relPath);
        } else if (entry.isFile()) {
          try {
            const stat = await fsPromises.stat(fullPath);
            results.push({
              name: relPath,
              size: stat.size,
              modifiedAt: Math.round(stat.mtimeMs),
            });
          } catch {
            // ignore unreadable
          }
        }
      }
    }
    await walk(artifactsDir, '');
    results.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return results;
  }

  function resolveArtifactPath(artifactsDir: string, requestedName: string): string | null {
    const trimmed = requestedName.trim();
    if (!trimmed || trimmed.includes('\0')) return null;
    const target = path.resolve(artifactsDir, trimmed);
    if (!isContained(artifactsDir, target) || target === artifactsDir) {
      return null;
    }
    return target;
  }

  function artifactsDirForWorkspace(workspaceId: string): string | null {
    const ws = workspaceId === 'default'
      ? app.pocket.plannerWorkspaces.getDefault()
      : app.pocket.plannerWorkspaces.get(workspaceId);
    if (!ws) return null;
    return path.join(ws.path, 'artifacts');
  }

  function artifactsDirForChat(chatId: string): string | null {
    const chat = app.pocket.plannerChats.get(chatId);
    if (!chat) return null;
    const ws = chat.workspaceId ? app.pocket.plannerWorkspaces.get(chat.workspaceId) : undefined;
    const workspace = ws ?? app.pocket.plannerWorkspaces.getDefault();
    if (!workspace) return null;
    return path.join(workspace.path, 'artifacts');
  }

  async function handleServeArtifactFile(
    artifactsDir: string,
    query: { name?: string; download?: string },
    reply: FastifyReply,
  ) {
    const name = query.name;
    if (!name) return badRequest(reply, 'Missing required name query parameter.');
    const filePath = resolveArtifactPath(artifactsDir, name);
    if (!filePath) return forbidden(reply, 'Invalid or forbidden artifact path.');
    let stat: fs.Stats;
    try {
      stat = await fsPromises.stat(filePath);
    } catch {
      return notFound(reply, 'Artifact not found.');
    }
    if (!stat.isFile()) return badRequest(reply, 'Requested path is not a file.');

    const mimeType = mimeTypeForArtifact(name);
    const isDownload = query.download === '1' || query.download === 'true' || mimeType === 'application/octet-stream';
    const dispositionType = isDownload ? 'attachment' : 'inline';
    const filename = path.basename(filePath);

    reply.header('Content-Type', mimeType);
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `${dispositionType}; filename="${encodeURIComponent(filename)}"`);
    // Agent-written content: runs sandboxed on an opaque origin — see ARTIFACT_CSP.
    reply.header('Content-Security-Policy', ARTIFACT_CSP);

    const stream = fs.createReadStream(filePath);
    return reply.send(stream);
  }

  async function handleDeleteArtifactFile(
    artifactsDir: string,
    query: { name?: string },
    reply: FastifyReply,
  ) {
    const name = query.name;
    if (!name) return badRequest(reply, 'Missing required name query parameter.');
    const filePath = resolveArtifactPath(artifactsDir, name);
    if (!filePath) return forbidden(reply, 'Invalid or forbidden artifact path.');
    try {
      const stat = await fsPromises.stat(filePath);
      if (!stat.isFile()) return badRequest(reply, 'Requested path is not a file.');
      await fsPromises.unlink(filePath);
      const response: DeletePlannerArtifactResponse = { ok: true, count: 1 };
      return response;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return notFound(reply, 'Artifact not found.');
      }
      return badRequest(reply, `Could not delete artifact: ${(err as Error).message}`);
    }
  }

  async function handleDeleteAllArtifacts(
    artifactsDir: string,
    reply: FastifyReply,
  ) {
    try {
      let entries: fs.Dirent[];
      try {
        entries = await fsPromises.readdir(artifactsDir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          const response: DeletePlannerArtifactResponse = { ok: true, count: 0 };
          return response;
        }
        throw err;
      }
      let count = 0;
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const target = path.join(artifactsDir, entry.name);
        if (isContained(artifactsDir, target) && target !== artifactsDir) {
          await fsPromises.rm(target, { recursive: true, force: true });
          count++;
        }
      }
      const response: DeletePlannerArtifactResponse = { ok: true, count };
      return response;
    } catch (err) {
      return badRequest(reply, `Could not clean artifacts: ${(err as Error).message}`);
    }
  }

  app.get('/api/planner/workspaces/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifactsDir = artifactsDirForWorkspace(id);
    if (!artifactsDir) return notFound(reply, 'Workspace not found.');
    await fsPromises.mkdir(artifactsDir, { recursive: true });
    const artifacts = await listArtifactFiles(artifactsDir);
    const response: PlannerArtifactsResponse = { artifacts };
    return response;
  });

  app.get('/api/planner/chats/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifactsDir = artifactsDirForChat(id);
    if (!artifactsDir) return notFound(reply, 'Chat not found.');
    await fsPromises.mkdir(artifactsDir, { recursive: true });
    const artifacts = await listArtifactFiles(artifactsDir);
    const response: PlannerArtifactsResponse = { artifacts };
    return response;
  });

  app.delete('/api/planner/workspaces/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifactsDir = artifactsDirForWorkspace(id);
    if (!artifactsDir) return notFound(reply, 'Workspace not found.');
    return handleDeleteAllArtifacts(artifactsDir, reply);
  });

  app.delete('/api/planner/chats/:id/artifacts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const artifactsDir = artifactsDirForChat(id);
    if (!artifactsDir) return notFound(reply, 'Chat not found.');
    return handleDeleteAllArtifacts(artifactsDir, reply);
  });

  app.get('/api/planner/workspaces/:id/artifacts/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { name?: string; download?: string };
    const artifactsDir = artifactsDirForWorkspace(id);
    if (!artifactsDir) return notFound(reply, 'Workspace not found.');
    return handleServeArtifactFile(artifactsDir, query, reply);
  });

  app.get('/api/planner/chats/:id/artifacts/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { name?: string; download?: string };
    const artifactsDir = artifactsDirForChat(id);
    if (!artifactsDir) return notFound(reply, 'Chat not found.');
    return handleServeArtifactFile(artifactsDir, query, reply);
  });

  app.delete('/api/planner/workspaces/:id/artifacts/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { name?: string };
    const artifactsDir = artifactsDirForWorkspace(id);
    if (!artifactsDir) return notFound(reply, 'Workspace not found.');
    return handleDeleteArtifactFile(artifactsDir, query, reply);
  });

  app.delete('/api/planner/chats/:id/artifacts/file', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { name?: string };
    const artifactsDir = artifactsDirForChat(id);
    if (!artifactsDir) return notFound(reply, 'Chat not found.');
    return handleDeleteArtifactFile(artifactsDir, query, reply);
  });
};
