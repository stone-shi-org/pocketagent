import type {
  AdoptableTarget,
  AgentEvent,
  AgentUsageInfo,
  BrowseEntry,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DeleteRemoteBranchRequest,
  DeleteWorktreeResponse,
  DiscoveredFolder,
  DrainStateResponse,
  RestartAcceptedResponse,
  AgentInfo,
  AgentInstallEvent,
  InstallAgentTarget,
  InstallableAgentId,
  InstallableAgentListResponse,
  ConversationInfo,
  CreateCronJobRequest,
  CronJob,
  CronJobRun,
  EffortLevel,
  HealthResponse,
  HostInfo,
  UpdateCronJobRequest,
  HubCredentialListResponse,
  CreateMcpClientTokenRequest,
  CreateMcpClientTokenResponse,
  McpClientTokenListResponse,
  MeResponse,
  ProjectInfo,
  PushStatusResponse,
  SessionInfo,
  SettingsResponse,
  ShellSessionSummary,
  UpdateSettingsRequest,
  CreateCustomClaudeProviderRequest,
  CustomClaudeProviderListResponse,
  CustomClaudeProviderSummary,
  UpdateCustomClaudeProviderRequest,
  CreateMcpRegistryRequest,
  McpRegistryListResponse,
  McpRegistrySummary,
  PlannerAgentMcpRegistriesResponse,
  SetPlannerAgentMcpRegistryRequest,
  TestMcpRegistryResponse,
  UpdateMcpRegistryRequest,
  CreateWebhookRequest,
  UpdateWebhookRequest,
  Webhook,
  WebhookCreatedResponse,
  WebhookDelivery,
  WebhookDeliveryCounts,
  WebhookDeliveryDetail,
  WebhookHistoryResponse,
  WebhookPreviewResponse,
  WebhookSecretResponse,
  WorkspaceEntry,
  PlannerWorkspace,
  PlannerWorkspaceListResponse,
  PlannerModel,
  PlannerModelListResponse,
  CreatePlannerModelRequest,
  UpdatePlannerModelRequest,
  DiscoverPlannerModelsResponse,
  TestPlannerModelResponse,
  PlannerEmbeddingApiKeyRevealResponse,
  PlannerSettingsDto,
  GeminiLiveSettingsDto,
  GeminiLiveTokenRequest,
  GeminiLiveTokenResponse,
  GeminiLiveToolCall,
  GeminiLiveToolCallsResponse,
  GeminiLiveTranscriptRequest,
  UpdateGeminiLiveSettingsRequest,
  TestPlannerEmbeddingResponse,
  TestPlannerUrlFetchResponse,
  TestPlannerWebSearchResponse,
  UpdatePlannerSettingsRequest,
  PlannerApiKeyRevealResponse,
  PlannerChat,
  PlannerChatListResponse,
  CreatePlannerChatRequest,
  UpdatePlannerChatRequest,
  DeleteAllPlannerChatsResponse,
  InterruptPlannerChatResponse,
  PlannerChatHistoryResponse,
  PlannerChatSubagentsResponse,
  PlannerContextPreviewResponse,
  PlannerSendMessageRequest,
  PlannerToolApprovalChoice,
  PlannerToolListResponse,
  PlannerToolApprovalListResponse,
  PlannerToolApprovalRow,
  SetPlannerToolApprovalRequest,
  PlannerAgentToolsResponse,
  SetPlannerAgentToolRequest,
  SetPlannerToolEnabledRequest,
  UpdatePlannerWorkspaceRequest,
  PlannerMemory,
  PlannerMemoryListResponse,
  PlannerMemoryTier,
  UpdatePlannerMemoryRequest,
  PlannerSkillListResponse,
  PlannerSkillDetailResponse,
  PlannerSkillInfo,
  RegisterPlannerSkillRequest,
  ExportPlannerSkillRequest,
  ExportPlannerSkillResponse,
  SetPlannerSkillEnabledRequest,
  PlannerAgentSkillsResponse,
  SetPlannerAgentSkillRequest,
  DiscoverablePlannerSkillsResponse,
  TelegramBotListResponse,
  TelegramBotSummary,
  CreateTelegramBotRequest,
  UpdateTelegramBotRequest,
  TelegramBotTestResult,
  TelegramLink,
  TelegramLinkListResponse,
  CreateTelegramLinkRequest,
  UpdateTelegramLinkRequest,
  VoiceTranscribeRequest,
  VoiceTranscribeResponse,
  VoiceTestSttRequest,
  VoiceTestSttResponse,
  VoiceTestTtsRequest,
  VoiceTestTtsResponse,
  VoiceModelListResponse,
} from '@pocketagent/protocol';
import { DEFAULT_HOST, hostUrl, type HostEndpoint } from './host.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

async function requestAt<T>(
  endpoint: HostEndpoint,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(hostUrl(endpoint, path), {
    // Cookies are HttpOnly; the browser attaches them. No token ever lives in JS.
    credentials: 'same-origin',
    headers: init?.body ? { 'content-type': 'application/json' } : {},
    ...init,
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`Unexpected response from server (${response.status}).`, response.status, 'bad_response');
  }

  if (!response.ok) {
    const err = (body as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      err?.message ?? `Request failed (${response.status}).`,
      response.status,
      err?.code ?? 'unknown',
    );
  }

  return body as T;
}

/**
 * POSTs `body` and reads the response as a stream of `AgentEvent`s — one
 * `data: <json>\n\n` frame per event, matching `streamPlannerEvents` on the
 * server (`routes/planner.ts`). Not built on `request()` above: that helper
 * awaits the *whole* body as one JSON value, which is exactly what a
 * streamed turn cannot do — events have to reach `onEvent` as they arrive,
 * not once the connection closes. `EventSource` was not an option either: it
 * only ever issues a `GET`, and sending a message needs a body.
 *
 * A non-2xx response is assumed to be the same JSON error shape `request()`
 * handles, since a precondition failure (chat not found, no LLM configured)
 * is answered *before* the route ever switches into streaming mode — see
 * `streamPlannerEvents`'s own doc comment server-side.
 */
async function streamSseAt<T>(
  endpoint: HostEndpoint,
  path: string,
  body: unknown,
  onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(hostUrl(endpoint, path), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
    throw err;
  }

  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(`Unexpected response from server (${response.status}).`, response.status, 'bad_response');
    }
    const err = (parsed as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(
      err?.message ?? `Request failed (${response.status}).`,
      response.status,
      err?.code ?? 'unknown',
    );
  }

  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (frame.length > 0) {
          const jsonText = frame.startsWith('data:') ? frame.slice(5).trim() : frame;
          try {
            onEvent(JSON.parse(jsonText) as T);
          } catch {
            // A malformed frame is dropped rather than aborting the rest of
            // the stream — the turn already in flight server-side keeps going
            // either way.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
    throw err;
  }
}

/**
 * An API client bound to one host.
 *
 * `request`/`streamPlannerEvents` are per-endpoint closures so that every
 * method below stays written as `request('/api/...')` — the host is applied
 * underneath them rather than being passed at all 131 call sites, which is
 * also what keeps this a refactor rather than a rewrite of the 40 modules
 * that import `api`.
 */
export function createApiClient(endpoint: HostEndpoint) {
  const request = <T,>(path: string, init?: RequestInit): Promise<T> =>
    requestAt<T>(endpoint, path, init);
  const streamPlannerEvents = (
    path: string,
    body: unknown,
    onEvent: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => streamSseAt<AgentEvent>(endpoint, path, body, onEvent, signal);

  return {
    login: (token: string) =>
      request<{ ok: true; expiresAt: number }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),

    logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

    me: () => request<MeResponse>('/api/auth/me'),

    /**
     * PA-63: bound hubs, and revoking one.
     *
     * There is deliberately no `bindHub` here. Binding is the *Hub's* own act,
     * authenticated with the master token an operator pastes into the Hub
     * once — a browser minting one would mean this app holding the master
     * token again, which is the thing the feature removes. So the backend UI
     * gets exactly the two halves the ticket asks for: visibility, and
     * revocation.
     */
    listHubs: () => request<HubCredentialListResponse>('/api/auth/hubs'),

    revokeHub: (id: string) =>
      request<{ ok: true }>(`/api/auth/hubs/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /**
     * PA-118: MCP client tokens — what lets another agent call this server's
     * `/mcp`. Minted here (a cookie session is required), shown once, revoked
     * here; the server keeps only a digest, so there is no reveal.
     */
    listMcpTokens: () => request<McpClientTokenListResponse>('/api/mcp/tokens'),

    createMcpToken: (body: CreateMcpClientTokenRequest) =>
      request<CreateMcpClientTokenResponse>('/api/mcp/tokens', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    revokeMcpToken: (id: string) =>
      request<void>(`/api/mcp/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listSessions: () => request<{ sessions: SessionInfo[] }>('/api/sessions'),

    /** Everything the home screen draws, in one round trip. */
    listProjects: (includeHidden = false) =>
      request<{ host: HostInfo; projects: ProjectInfo[]; shells: ShellSessionSummary[] }>(
        `/api/projects${includeHidden ? '?includeHidden=1' : ''}`,
      ),

    /**
     * Forget every finished shell session (PA-25). No body: the "Shell"
     * category is not a directory, so there is no cwd to name — see
     * `ProjectService.shells`.
     */
    clearFinishedShells: () =>
      request<{ ok: true; removedSessions: number; removedConversations: number }>(
        '/api/shells/clear-finished',
        { method: 'POST' },
      ),

    /** Drops a chat from the list. Never deletes a transcript. */
    removeChat: (ids: { sessionId?: string; conversationId?: string }) =>
      request<{ ok: true }>('/api/chats/remove', {
        method: 'POST',
        body: JSON.stringify(ids),
      }),

    clearFinished: (cwd: string) =>
      request<{ ok: true; removedSessions: number; removedConversations: number }>(
        '/api/projects/clear-finished',
        { method: 'POST', body: JSON.stringify({ cwd }) },
      ),

    hideProject: (cwd: string) =>
      request<{ ok: true }>('/api/projects/hide', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      }),

    unhideProject: (cwd: string) =>
      request<{ ok: true }>('/api/projects/unhide', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      }),

    listHosts: () => request<{ hosts: HostInfo[] }>('/api/hosts'),

    /**
     * What restarting this host would cost, right now (PA-69).
     *
     * Read-only and safe to poll: the whole reason it exists is that the POST
     * below cannot be used to *look*, since on a host with nothing running it
     * would restart the server instead of answering a question.
     */
    getDrainState: () => request<DrainStateResponse>('/api/admin/drain-state'),

    /**
     * Ask this host to drain and exit so its supervisor restarts it.
     *
     * Throws `ApiError` rather than swallowing it, the same way
     * `deleteWorktree` does and for the same reason: the caller branches on
     * the code. `drain_blocked` (409) means work is in flight and the UI
     * re-reads `getDrainState` for the list — `ApiError` deliberately carries
     * only a code and a message, so the blockers in the 409 body are for a
     * `curl` caller rather than for us. `restart_unsupported` (501) means this
     * process has no supervisor and will not exit.
     *
     * There is deliberately no parameter naming a version, image or artifact,
     * and there must never be one: the update source is fixed at deploy time.
     * `force` is the only input, and it means "interrupt work that is still
     * running", the same override `force` has on a queued prompt.
     */
    restartServer: (force: boolean) =>
      request<RestartAcceptedResponse>('/api/admin/restart', {
        method: 'POST',
        body: JSON.stringify({ force }),
      }),

    /**
     * Unauthenticated version check (PA-61).
     *
     * Reachable before login — which is the point: `probeHost` calls it to
     * decide whether a host is usable at all, and a host too old to talk to is
     * not worth presenting a credential to. Callers must treat a rejection as
     * "unreachable" rather than "incompatible"; `probeHost` is where that
     * distinction is made.
     */
    health: () => request<HealthResponse>('/health'),

    getSession: (id: string) => request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`),

    scheduleContinueAfterLimit: (id: string) =>
      request<{ scheduledFor: number }>(
        `/api/sessions/${encodeURIComponent(id)}/continue-after-limit`,
        { method: 'POST' },
      ),

    /** PA-20 Phase 1: transcribes one buffered push-to-talk utterance. Does
        not submit a prompt itself — the caller (`PromptBox`) sends the
        returned text through the same path a typed message already uses. */
    transcribeVoice: (id: string, audio: VoiceTranscribeRequest['audio']) =>
      request<VoiceTranscribeResponse>(`/api/sessions/${encodeURIComponent(id)}/voice/transcribe`, {
        method: 'POST',
        body: JSON.stringify({ audio }),
      }),

    /** PA-81: lists available ASR and TTS models from the live-stt service. */
    listVoiceModels: () =>
      request<VoiceModelListResponse>('/api/voice/models'),

    /** PA-81: tests STT using an embedded test audio sample. */
    testVoiceStt: (payload?: VoiceTestSttRequest) =>
      request<VoiceTestSttResponse>('/api/voice/test-stt', {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      }),

    /** PA-81: tests TTS and returns synthesized speech audio. */
    testVoiceTts: (payload?: VoiceTestTtsRequest) =>
      request<VoiceTestTtsResponse>('/api/voice/test-tts', {
        method: 'POST',
        body: JSON.stringify(payload ?? {}),
      }),

    createSession: (input: {
      agent: string;
      cwd: string;
      cols: number;
      rows: number;
      title?: string;
      transport?: 'terminal' | 'structured';
      /** Resume a conversation from the agent's own session store. */
      resumeAgentSessionId?: string;
      /** Branch instead of appending. Defaults to false server-side. */
      forkSession?: boolean;
      /** Attach to an existing tmux pane, by opaque id from /api/adoptable. */
      adoptTargetId?: string;
      /** Explicit opt-in to bypass approvals. Defaults to false server-side. */
      skipPermissions?: boolean;
      /** Omit to fall back to the per-agent cached default — see `AgentInfo.defaultModel`. */
      model?: string;
      /** `null` pins the model's own default; omit to fall back to the cache. */
      effort?: EffortLevel | null;
    }) =>
      request<SessionInfo>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),

    deleteSession: (id: string) =>
      request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /** Messages of the conversation this session resumed, if it resumed one. */
    sessionHistory: (id: string) =>
      request<{ conversationId?: string; events: AgentEvent[] }>(
        `/api/sessions/${encodeURIComponent(id)}/history`,
      ),

    /** `create: true` makes a not-yet-existing folder no longer an error — see `WorkspaceRequest`. */
    addWorkspace: (path: string, opts?: { create?: boolean }) =>
      request<{ ok: true; path: string; label: string }>('/api/workspaces/add', {
        method: 'POST',
        body: JSON.stringify({ path, ...(opts?.create ? { create: true } : {}) }),
      }),

    removeWorkspace: (path: string) =>
      request<{ ok: boolean }>('/api/workspaces/remove', {
        method: 'POST',
        body: JSON.stringify({ path }),
      }),

    listDiscovered: () => request<{ folders: DiscoveredFolder[] }>('/api/discovered'),

    /** Subdirectories of `path` on the host; defaults to the home directory. */
    browse: (path?: string) =>
      request<{
        path: string;
        label: string;
        parent: string | null;
        added: boolean;
        entries: BrowseEntry[];
      }>(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`),

    listWorkspaces: () => request<{ workspaces: WorkspaceEntry[] }>('/api/workspaces'),

    /** Creates a new git worktree for a project; the returned `cwd` feeds `createSession`. */
    createWorktree: (body: CreateWorktreeRequest) =>
      request<CreateWorktreeResponse>('/api/projects/worktree', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /**
     * Deletes a linked git worktree and its local branch. Throws `ApiError` on
     * rejection (`dirty`, `unmerged`, `worktree_busy`, ...) rather than
     * swallowing it — the three-dot menu's delete flow branches on the error
     * code to show the right dialog.
     */
    deleteWorktree: (cwd: string) =>
      request<DeleteWorktreeResponse>('/api/projects/worktree/delete', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      }),

    /** Follow-up to `deleteWorktree`, only called if the user opts in after its `remote` is non-null. */
    deleteRemoteBranch: (body: DeleteRemoteBranchRequest) =>
      request<{ ok: true }>('/api/projects/worktree/delete-remote', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    listAgents: () => request<{ agents: AgentInfo[] }>('/api/agents'),

    /**
     * PA-50: Settings' "Coding Agents" section's "Refresh" button — re-runs
     * every structured agent's own model discovery, with no session created,
     * and answers with the same shape `listAgents` does.
     */
    refreshAgents: () => request<{ agents: AgentInfo[] }>('/api/agents/refresh', { method: 'POST' }),

    // ---- On-demand agent installation (PA-68) ---------------------------------

    /**
     * The server-declared catalog of installable agents. Read-only
     * disclosure: the ids it returns are the *only* values `installAgent`
     * accepts, and each entry's installer URL (`source`) is shown so an
     * operator can see what they are agreeing to run.
     */
    listInstallableAgents: () =>
      request<InstallableAgentListResponse>('/api/agents/installable'),

    /**
     * Install, update, or remove the leftover install-prefix copy of one
     * catalogued agent (`target`, PA-104), streaming the output as it arrives.
     *
     * Takes an `InstallableAgentId`, never a package name — the type is the
     * client-side half of the server's `z.enum`, so "the browser never
     * supplies an executable or argv" is visible here rather than only
     * enforced on arrival.
     *
     * `afterSeq` resumes a view of an install already in flight: re-calling
     * this for an agent whose install is still running attaches to it and
     * replays the log from that point rather than starting a second one. The
     * returned promise settles when the stream ends, which is *not*
     * necessarily when the install ends — abandoning the stream leaves the
     * install running server-side, deliberately.
     */
    installAgent: (
      id: InstallableAgentId,
      onEvent: (event: AgentInstallEvent) => void,
      afterSeq = 0,
      target?: InstallAgentTarget,
    ) =>
      streamSseAt<AgentInstallEvent>(
        endpoint,
        `/api/agents/install?afterSeq=${afterSeq}`,
        target ? { id, target } : { id },
        onEvent,
      ),

    // ---- Custom Claude providers (PA-28) ---------------------------------------
    //
    // No `reveal` method, deliberately: there is no such route. The API key is
    // write-only — an edit re-enters it, or leaves it blank to keep the stored
    // one — so nothing here can ever put a third-party credential into the
    // browser.

    listCustomClaudeProviders: () =>
      request<CustomClaudeProviderListResponse>('/api/custom-claude-providers'),

    createCustomClaudeProvider: (body: CreateCustomClaudeProviderRequest) =>
      request<CustomClaudeProviderSummary>('/api/custom-claude-providers', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateCustomClaudeProvider: (id: string, body: UpdateCustomClaudeProviderRequest) =>
      request<CustomClaudeProviderSummary>(`/api/custom-claude-providers/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    deleteCustomClaudeProvider: (id: string) =>
      request<void>(`/api/custom-claude-providers/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    // ---- MCP registries (PA-37) -------------------------------------------
    //
    // No `reveal` method either, same reasoning as a custom Claude provider's
    // API key — a bearer token or header value is write-only.

    listMcpRegistries: () => request<McpRegistryListResponse>('/api/mcp-registries'),

    createMcpRegistry: (body: CreateMcpRegistryRequest) =>
      request<McpRegistrySummary>('/api/mcp-registries', { method: 'POST', body: JSON.stringify(body) }),

    updateMcpRegistry: (id: string, body: UpdateMcpRegistryRequest) =>
      request<McpRegistrySummary>(`/api/mcp-registries/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    deleteMcpRegistry: (id: string) =>
      request<void>(`/api/mcp-registries/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    testMcpRegistry: (id: string) =>
      request<TestMcpRegistryResponse>(`/api/mcp-registries/${encodeURIComponent(id)}/test`, { method: 'POST' }),

    refreshMcpRegistryTools: (id: string) =>
      request<TestMcpRegistryResponse>(`/api/mcp-registries/${encodeURIComponent(id)}/refresh-tools`, {
        method: 'POST',
      }),

    // PA-37 follow-up round two: one agent's own per-registry MCP subset —
    // same shape as listPlannerAgentSkills/setPlannerAgentSkill below.
    listPlannerAgentMcpRegistries: (workspaceId: string) =>
      request<PlannerAgentMcpRegistriesResponse>(
        `/api/planner/workspaces/${encodeURIComponent(workspaceId)}/mcp-registries`,
      ),

    setPlannerAgentMcpRegistry: (workspaceId: string, body: SetPlannerAgentMcpRegistryRequest) =>
      request<PlannerAgentMcpRegistriesResponse>(
        `/api/planner/workspaces/${encodeURIComponent(workspaceId)}/mcp-registries`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    // ---- Telegram bots & pairings (PA-53) ----------------------------------
    //
    // No `reveal` method for a bot's token, same reasoning as a custom Claude
    // provider's API key — write-only, re-enter to change, blank keeps the
    // stored one.

    listTelegramBots: () => request<TelegramBotListResponse>('/api/telegram/bots'),

    createTelegramBot: (body: CreateTelegramBotRequest) =>
      request<TelegramBotSummary>('/api/telegram/bots', { method: 'POST', body: JSON.stringify(body) }),

    updateTelegramBot: (id: string, body: UpdateTelegramBotRequest) =>
      request<TelegramBotSummary>(`/api/telegram/bots/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    deleteTelegramBot: (id: string) =>
      request<void>(`/api/telegram/bots/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    testTelegramBot: (id: string) =>
      request<TelegramBotTestResult>(`/api/telegram/bots/${encodeURIComponent(id)}/test`, { method: 'POST' }),

    testTelegramBotToken: (botToken: string) =>
      request<TelegramBotTestResult>('/api/telegram/bots/test-token', {
        method: 'POST',
        body: JSON.stringify({ botToken }),
      }),

    listTelegramLinks: (botId: string) =>
      request<TelegramLinkListResponse>(`/api/telegram/bots/${encodeURIComponent(botId)}/links`),

    createTelegramLink: (botId: string, body: CreateTelegramLinkRequest) =>
      request<TelegramLink>(`/api/telegram/bots/${encodeURIComponent(botId)}/links`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateTelegramLink: (botId: string, chatId: string, body: UpdateTelegramLinkRequest) =>
      request<TelegramLink>(
        `/api/telegram/bots/${encodeURIComponent(botId)}/links/${encodeURIComponent(chatId)}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      ),

    deleteTelegramLink: (botId: string, chatId: string) =>
      request<void>(
        `/api/telegram/bots/${encodeURIComponent(botId)}/links/${encodeURIComponent(chatId)}`,
        { method: 'DELETE' },
      ),

    listConversations: () =>
      request<{ conversations: ConversationInfo[] }>('/api/conversations'),

    /**
     * A conversation's own messages, read from its transcript directly — no
     * session has to exist for this. Powers the read-only preview a finished
     * chat opens into before anything is resumed.
     */
    conversationHistory: (id: string) =>
      request<{ conversation: ConversationInfo; events: AgentEvent[] }>(
        `/api/conversations/${encodeURIComponent(id)}/history`,
      ),

    listAdoptable: (all = false) =>
      request<{ enabled: boolean; targets: AdoptableTarget[] }>(
        all ? '/api/adoptable?all=1' : '/api/adoptable',
      ),

    /**
     * Start a brand-new named tmux session on the adoption socket. `cwd`
     * defaults server-side to the first workspace root when omitted; pass it
     * explicitly to land the session in a particular project's own folder.
     */
    createAdoptableSession: (name: string, cwd?: string) =>
      request<AdoptableTarget>('/api/adoptable', {
        method: 'POST',
        body: JSON.stringify(cwd !== undefined ? { name, cwd } : { name }),
      }),

    pushPublicKey: () => request<{ publicKey: string | null }>('/api/push/key'),

    pushStatus: () => request<PushStatusResponse>('/api/push/status'),

    pushSubscribe: (subscription: Record<string, unknown>) =>
      request<{ ok: true }>('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription }),
      }),

    pushUnsubscribe: (endpoint: string) =>
      request<{ ok: true }>('/api/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint }),
      }),

    pushTest: () => request<{ sent: number; pruned: number }>('/api/push/test', { method: 'POST' }),

    /**
     * Every server setting: database-backed, seeded once from `.env` on first
     * boot, never re-read from it after — see CLAUDE.md and
     * `apps/server/src/settings/`. `fixed` is read-only (host/port/db path/
     * env), `restartRequiredKeys` flags which `settings` keys need a restart to
     * take effect once changed.
     */
    getSettings: () => request<SettingsResponse>('/api/settings'),

    updateSettings: (patch: UpdateSettingsRequest) =>
      request<SettingsResponse>('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    /** Rate-limit usage for every agent that reports its own, for the status area next to `HostChip`. */
    getUsage: () => request<{ usage: AgentUsageInfo[] }>('/api/usage'),

    // ---- Scheduled jobs -------------------------------------------------------

    listCronJobs: () => request<{ jobs: CronJob[] }>('/api/cron/jobs'),

    getCronJob: (id: string) => request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}`),

    createCronJob: (body: CreateCronJobRequest) =>
      request<CronJob>('/api/cron/jobs', { method: 'POST', body: JSON.stringify(body) }),

    updateCronJob: (id: string, patch: UpdateCronJobRequest) =>
      request<CronJob>(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    deleteCronJob: (id: string) =>
      request<{ ok: true; runsKept: number }>(`/api/cron/jobs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    /**
     * Fire a job by hand. Resolves once the session exists — so the returned run
     * already carries `sessionId` to navigate to — but not once the turn is done.
     */
    runCronJobNow: (id: string) =>
      request<CronJobRun>(`/api/cron/jobs/${encodeURIComponent(id)}/run`, { method: 'POST' }),

    listCronRuns: (id: string) =>
      request<{ runs: CronJobRun[] }>(`/api/cron/jobs/${encodeURIComponent(id)}/runs`),

    clearCronRuns: (id: string) =>
      request<{ ok: true; removed: number }>(`/api/cron/jobs/${encodeURIComponent(id)}/runs`, {
        method: 'DELETE',
      }),

    // ---- Inbound webhooks -----------------------------------------------------

    listWebhooks: () => request<{ webhooks: Webhook[] }>('/api/webhooks'),

    /** Every webhook's call history in one feed, including unmatched hits. */
    listWebhookHistory: (opts: { includeNoise?: boolean } = {}) =>
      request<WebhookHistoryResponse>(
        `/api/webhooks/history${opts.includeNoise === false ? '?noise=false' : ''}`,
      ),

    getWebhook: (id: string) => request<Webhook>(`/api/webhooks/${encodeURIComponent(id)}`),

    /** The only response that ever carries the secret, besides an explicit reveal. */
    createWebhook: (body: CreateWebhookRequest) =>
      request<WebhookCreatedResponse>('/api/webhooks', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    updateWebhook: (id: string, patch: UpdateWebhookRequest) =>
      request<Webhook>(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    deleteWebhook: (id: string) =>
      request<{ ok: true; deliveriesKept: number }>(`/api/webhooks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    listWebhookDeliveries: (id: string, opts: { includeNoise?: boolean } = {}) =>
      request<{ deliveries: WebhookDelivery[]; counts: WebhookDeliveryCounts }>(
        `/api/webhooks/${encodeURIComponent(id)}/deliveries${
          opts.includeNoise === false ? '?noise=false' : ''
        }`,
      ),

    getWebhookDelivery: (id: string, deliveryId: string) =>
      request<WebhookDeliveryDetail>(
        `/api/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}`,
      ),

    /**
     * Act on a delivery waiting for a working tree (PA-11).
     *
     * `front` reorders waiters; it deliberately cannot start one while another
     * agent holds the directory — that is the corruption the queue prevents.
     */
    resolveQueuedDelivery: (id: string, deliveryId: string, action: 'cancel' | 'front') =>
      request<{ ok: true }>(
        `/api/webhooks/${encodeURIComponent(id)}/deliveries/${encodeURIComponent(deliveryId)}/queue`,
        { method: 'POST', body: JSON.stringify({ action }) },
      ),

    clearWebhookDeliveries: (id: string) =>
      request<{ ok: true; removed: number }>(
        `/api/webhooks/${encodeURIComponent(id)}/deliveries`,
        { method: 'DELETE' },
      ),

    /**
     * POST, not GET, on purpose: the Origin check in `app.ts` only runs on
     * non-GET/HEAD methods, so a GET here would be CSRF-reachable and cacheable.
     */
    revealWebhookSecret: (id: string) =>
      request<WebhookSecretResponse>(`/api/webhooks/${encodeURIComponent(id)}/secret/reveal`, {
        method: 'POST',
      }),

    rotateWebhookSecret: (id: string) =>
      request<WebhookSecretResponse>(`/api/webhooks/${encodeURIComponent(id)}/secret/rotate`, {
        method: 'POST',
      }),

    /** Runs a payload through the real pipeline with auth skipped. */
    sendTestDelivery: (id: string, payload?: string) =>
      request<{
        deliveryId: string | null;
        status: string;
        sessionId: string | null;
        /** PA-10: set instead of `sessionId` when the webhook's agent is a Pocket Agent. */
        plannerChatId?: string | null;
        reason: string | null;
      }>(
        `/api/webhooks/${encodeURIComponent(id)}/test`,
        { method: 'POST', body: JSON.stringify(payload !== undefined ? { payload } : {}) },
      ),

    /** Renders server-side so the editor never re-implements the renderer. */
    previewWebhookPrompt: (id: string, body: { payload?: string; promptTemplate?: string }) =>
      request<WebhookPreviewResponse>(`/api/webhooks/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // ---- Planner (PA-6) ---------------------------------------------------------

    listPlannerWorkspaces: () =>
      request<PlannerWorkspaceListResponse>('/api/planner/workspaces'),

    createPlannerWorkspace: (name: string, opts?: { path?: string; createPath?: boolean }) =>
      request<PlannerWorkspace>('/api/planner/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, ...opts }),
      }),

    renamePlannerWorkspace: (id: string, name: string) =>
      request<PlannerWorkspace>(`/api/planner/workspaces/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),

    updatePlannerWorkspace: (id: string, patch: UpdatePlannerWorkspaceRequest) =>
      request<PlannerWorkspace>(`/api/planner/workspaces/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    deletePlannerWorkspace: (id: string) =>
      request<void>(`/api/planner/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listPlannerAgentTools: (workspaceId: string) =>
      request<PlannerAgentToolsResponse>(`/api/planner/workspaces/${encodeURIComponent(workspaceId)}/tools`),

    setPlannerAgentTool: (workspaceId: string, body: SetPlannerAgentToolRequest) =>
      request<PlannerAgentToolsResponse>(`/api/planner/workspaces/${encodeURIComponent(workspaceId)}/tools`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    // ---- Skills (PA-38) ----------------------------------------------------

    listPlannerAgentSkills: (workspaceId: string) =>
      request<PlannerAgentSkillsResponse>(`/api/planner/workspaces/${encodeURIComponent(workspaceId)}/skills`),

    setPlannerAgentSkill: (workspaceId: string, body: SetPlannerAgentSkillRequest) =>
      request<PlannerAgentSkillsResponse>(`/api/planner/workspaces/${encodeURIComponent(workspaceId)}/skills`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    listPlannerModels: () => request<PlannerModelListResponse>('/api/planner/models'),

    createPlannerModel: (body: CreatePlannerModelRequest) =>
      request<PlannerModel>('/api/planner/models', { method: 'POST', body: JSON.stringify(body) }),

    updatePlannerModel: (id: string, body: UpdatePlannerModelRequest) =>
      request<PlannerModel>(`/api/planner/models/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    deletePlannerModel: (id: string) =>
      request<void>(`/api/planner/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    deleteAllPlannerModels: () => request<void>('/api/planner/models', { method: 'DELETE' }),

    discoverPlannerModels: () => request<DiscoverPlannerModelsResponse>('/api/planner/models/discover'),

    testPlannerModel: (id: string) =>
      request<TestPlannerModelResponse>(`/api/planner/models/${encodeURIComponent(id)}/test`, { method: 'POST' }),

    getPlannerSettings: () => request<PlannerSettingsDto>('/api/planner/settings'),

    updatePlannerSettings: (patch: UpdatePlannerSettingsRequest) =>
      request<PlannerSettingsDto>('/api/planner/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    /** PA-96: Gemini Live settings. Never carries the key back. */
    getGeminiLiveSettings: () => request<GeminiLiveSettingsDto>('/api/planner/gemini-live'),

    updateGeminiLiveSettings: (patch: UpdateGeminiLiveSettingsRequest) =>
      request<GeminiLiveSettingsDto>('/api/planner/gemini-live', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    /** PA-96: a single-use, constraint-locked Gemini token for this chat. */
    mintGeminiLiveToken: (chatId: string, body: GeminiLiveTokenRequest = {}) =>
      request<GeminiLiveTokenResponse>(`/api/planner/chats/${encodeURIComponent(chatId)}/live/token`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    /** PA-96: the tool bridge — the server's gate decides, never the page. */
    runGeminiLiveToolCalls: (chatId: string, calls: GeminiLiveToolCall[]) =>
      request<GeminiLiveToolCallsResponse>(`/api/planner/chats/${encodeURIComponent(chatId)}/live/tool-calls`, {
        method: 'POST',
        body: JSON.stringify({ calls }),
      }),

    recordGeminiLiveTranscript: (chatId: string, body: GeminiLiveTranscriptRequest) =>
      request<void>(`/api/planner/chats/${encodeURIComponent(chatId)}/live/transcript`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    endGeminiLive: (chatId: string) =>
      request<void>(`/api/planner/chats/${encodeURIComponent(chatId)}/live/end`, { method: 'POST' }),

    /** POST, not GET — same CSRF/caching reasoning as `revealWebhookSecret`. */
    revealPlannerApiKey: () =>
      request<PlannerApiKeyRevealResponse>('/api/planner/settings/api-key/reveal', {
        method: 'POST',
      }),

    /** The embedding provider's own key reveal — see `PlannerSettingsDto.embeddingBaseUrl`'s doc comment. */
    revealPlannerEmbeddingApiKey: () =>
      request<PlannerEmbeddingApiKeyRevealResponse>('/api/planner/settings/embedding-api-key/reveal', {
        method: 'POST',
      }),

    testPlannerEmbeddings: () =>
      request<TestPlannerEmbeddingResponse>('/api/planner/settings/embeddings/test', { method: 'POST' }),

    /** PA-31: runs one canned search through the configured `web_search` provider. */
    testPlannerWebSearch: () =>
      request<TestPlannerWebSearchResponse>('/api/planner/settings/web-search/test', { method: 'POST' }),

    /** `url_fetch`'s own connection test — fetches a fixed, stable target
        server-side; see the route's own doc comment for why. */
    testPlannerUrlFetch: () =>
      request<TestPlannerUrlFetchResponse>('/api/planner/settings/url-fetch/test', { method: 'POST' }),

    listPlannerChats: (workspaceId?: string) =>
      request<PlannerChatListResponse>(
        `/api/planner/chats${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`,
      ),

    getPlannerChat: (id: string) =>
      request<PlannerChat>(`/api/planner/chats/${encodeURIComponent(id)}`),

    createPlannerChat: (body: CreatePlannerChatRequest) =>
      request<PlannerChat>('/api/planner/chats', { method: 'POST', body: JSON.stringify(body) }),

    updatePlannerChat: (id: string, patch: UpdatePlannerChatRequest) =>
      request<PlannerChat>(`/api/planner/chats/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    deletePlannerChat: (id: string) =>
      request<void>(`/api/planner/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /** PA-35: bulk counterpart, for the "..." menu's "Clear N finished chats". */
    deleteAllPlannerChats: (workspaceId: string) =>
      request<DeleteAllPlannerChatsResponse>(
        `/api/planner/workspaces/${encodeURIComponent(workspaceId)}/chats`,
        { method: 'DELETE' },
      ),

    plannerChatHistory: (id: string) =>
      request<PlannerChatHistoryResponse>(`/api/planner/chats/${encodeURIComponent(id)}/history`),

    listPlannerChatSubagents: (id: string) =>
      request<PlannerChatSubagentsResponse>(`/api/planner/chats/${encodeURIComponent(id)}/subagents`),

    clearPlannerChatHistory: (id: string) =>
      request<void>(`/api/planner/chats/${encodeURIComponent(id)}/history`, { method: 'DELETE' }),

    /**
     * Streams one turn's `AgentEvent`s as they happen — see
     * `PlannerChatHistoryResponse`'s doc comment (protocol package) for what
     * that does and does not mean — calling `onEvent` for each, in order.
     * Resolves once the turn either finishes (`turn_complete`) or pauses on a
     * mutating tool call with no remembered decision (`permission_request`
     * with no matching `permission_resolved` yet).
     */
    sendPlannerMessage: (
      id: string,
      body: PlannerSendMessageRequest,
      onEvent: (event: AgentEvent) => void,
      signal?: AbortSignal,
    ) =>
      streamPlannerEvents(`/api/planner/chats/${encodeURIComponent(id)}/messages`, body, onEvent, signal),

    /**
     * PA-99: Interrupts an in-flight planner turn or dismisses a pending approval.
     */
    interruptPlannerChat: (id: string) =>
      request<InterruptPlannerChatResponse>(`/api/planner/chats/${encodeURIComponent(id)}/interrupt`, {
        method: 'POST',
      }),

    /**
     * Subscribes to live SSE events for a planner chat (e.g. background turns
     * triggered by subagent completions). Returns an unsubscribe function.
     */
    subscribePlannerChatEvents: (
      id: string,
      onEvent: (event: AgentEvent) => void,
      onError?: (err: unknown) => void,
    ): (() => void) => {
      const controller = new AbortController();
      let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

      let retryAttempt = 0;
      const MAX_RETRIES = 10;
      const INITIAL_DELAY_MS = 1000;
      const MAX_DELAY_MS = 30000;

      const connect = async () => {
        if (controller.signal.aborted) return;
        let isFatal = false;
        try {
          // hostUrl, not a bare relative path (PA-60): this stream has to
          // come from the host whose chat is on screen, not from whichever
          // host served the bundle.
          const response = await fetch(
            hostUrl(endpoint, `/api/planner/chats/${encodeURIComponent(id)}/events`),
            {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'text/event-stream' },
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 400 || response.status === 410) {
              isFatal = true;
            }
            throw new ApiError(`Failed to subscribe to chat events (${response.status})`, response.status, 'bad_response');
          }
          retryAttempt = 0;
          const reader = response.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary).trim();
              buffer = buffer.slice(boundary + 2);
              if (frame.length > 0 && !frame.startsWith(':')) {
                const jsonText = frame.startsWith('data:') ? frame.slice(5).trim() : frame;
                try {
                  onEvent(JSON.parse(jsonText) as AgentEvent);
                } catch {
                  // Ignore malformed frame
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch (err: unknown) {
          if (controller.signal.aborted) return;
          onError?.(err);
        } finally {
          if (!controller.signal.aborted && !isFatal) {
            retryAttempt++;
            if (retryAttempt <= MAX_RETRIES) {
              const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retryAttempt - 1), MAX_DELAY_MS);
              reconnectTimeout = setTimeout(connect, delay);
            }
          }
        }
      };

      void connect();

      return () => {
        controller.abort();
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
      };
    },

    /** Resolves a turn paused on an unanswered `permission_request`. */
    resolvePlannerApproval: (
      id: string,
      approvalId: string,
      decision: PlannerToolApprovalChoice,
      onEvent: (event: AgentEvent) => void,
    ) =>
      streamPlannerEvents(
        `/api/planner/chats/${encodeURIComponent(id)}/approvals/${encodeURIComponent(approvalId)}`,
        { decision },
        onEvent,
      ),

    /** PA-29: a read-only preview of the memory ranking and rolling-window
        trimming the *next* turn in this chat would apply — never triggers a
        turn itself. */
    plannerContextPreview: (id: string) =>
      request<PlannerContextPreviewResponse>(`/api/planner/chats/${encodeURIComponent(id)}/context-preview`),

    listPlannerTools: () => request<PlannerToolListResponse>('/api/planner/tools'),

    setPlannerToolEnabled: (name: string, body: SetPlannerToolEnabledRequest) =>
      request<PlannerToolListResponse>(`/api/planner/tools/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    listPlannerSkills: () => request<PlannerSkillListResponse>('/api/planner/skills'),

    getPlannerSkill: (id: string) =>
      request<PlannerSkillDetailResponse>(`/api/planner/skills/${encodeURIComponent(id)}`),

    registerPlannerSkill: (body: RegisterPlannerSkillRequest) =>
      request<PlannerSkillInfo>('/api/planner/skills', { method: 'POST', body: JSON.stringify(body) }),

    deletePlannerSkill: (id: string) =>
      request<void>(`/api/planner/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    refreshPlannerSkills: () => request<PlannerSkillListResponse>('/api/planner/skills/refresh', { method: 'POST' }),

    setPlannerSkillEnabledGlobally: (id: string, body: SetPlannerSkillEnabledRequest) =>
      request<PlannerSkillListResponse>(`/api/planner/skills/${encodeURIComponent(id)}/global-enabled`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),

    promotePlannerSkill: (id: string) =>
      request<PlannerSkillInfo>(`/api/planner/skills/${encodeURIComponent(id)}/promote`, { method: 'POST' }),

    /** PA-55: copy a catalog skill into a project's coding-agent skill
        directories. A 409 (`skill_exists`) means nothing was written. */
    exportPlannerSkill: (id: string, body: ExportPlannerSkillRequest) =>
      request<ExportPlannerSkillResponse>(`/api/planner/skills/${encodeURIComponent(id)}/export`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    listDiscoverablePlannerSkills: () =>
      request<DiscoverablePlannerSkillsResponse>('/api/planner/skills/discoverable'),

    listPlannerToolApprovals: () =>
      request<PlannerToolApprovalListResponse>('/api/planner/tool-approvals'),

    setPlannerToolApproval: (body: SetPlannerToolApprovalRequest) =>
      request<PlannerToolApprovalRow>('/api/planner/tool-approvals', {
        method: 'POST',
        body: JSON.stringify(body),
      }),

    deletePlannerToolApproval: (id: string) =>
      request<void>(`/api/planner/tool-approvals/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    /** PA-29 phase 4: one agent's own memories, optionally narrowed to a tier. */
    listPlannerMemories: (workspaceId: string, tier?: PlannerMemoryTier) =>
      request<PlannerMemoryListResponse>(
        `/api/planner/workspaces/${encodeURIComponent(workspaceId)}/memories${tier ? `?tier=${encodeURIComponent(tier)}` : ''}`,
      ),

    updatePlannerMemory: (id: string, patch: UpdatePlannerMemoryRequest) =>
      request<PlannerMemory>(`/api/planner/memories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),

    deletePlannerMemory: (id: string) =>
      request<void>(`/api/planner/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };
}

/** The shape every host's client has. */
export type ApiClient = ReturnType<typeof createApiClient>;

/**
 * The default host's client.
 *
 * Kept as a module singleton with the exact name and shape it had before
 * PA-60, so every existing `api.foo()` call site is untouched; a second host
 * gets its own client from `createApiClient` instead.
 */
export const api = createApiClient(DEFAULT_HOST);
