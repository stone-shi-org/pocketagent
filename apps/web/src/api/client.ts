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
  AgentInfo,
  ConversationInfo,
  CreateCronJobRequest,
  CronJob,
  CronJobRun,
  EffortLevel,
  HostInfo,
  UpdateCronJobRequest,
  MeResponse,
  ProjectInfo,
  SessionInfo,
  SettingsResponse,
  ShellSessionSummary,
  UpdateSettingsRequest,
  CreateCustomClaudeProviderRequest,
  CustomClaudeProviderListResponse,
  CustomClaudeProviderSummary,
  UpdateCustomClaudeProviderRequest,
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
  DiscoverPlannerModelsResponse,
  TestPlannerModelResponse,
  PlannerEmbeddingApiKeyRevealResponse,
  PlannerSettingsDto,
  TestPlannerEmbeddingResponse,
  UpdatePlannerSettingsRequest,
  PlannerApiKeyRevealResponse,
  PlannerChat,
  PlannerChatListResponse,
  CreatePlannerChatRequest,
  UpdatePlannerChatRequest,
  PlannerChatHistoryResponse,
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
} from '@pocketagent/protocol';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
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
async function streamPlannerEvents(
  path: string,
  body: unknown,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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
          onEvent(JSON.parse(jsonText) as AgentEvent);
        } catch {
          // A malformed frame is dropped rather than aborting the rest of
          // the stream — the turn already in flight server-side keeps going
          // either way.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export const api = {
  login: (token: string) =>
    request<{ ok: true; expiresAt: number }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),

  me: () => request<MeResponse>('/api/auth/me'),

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

  getSession: (id: string) => request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`),

  scheduleContinueAfterLimit: (id: string) =>
    request<{ scheduledFor: number }>(
      `/api/sessions/${encodeURIComponent(id)}/continue-after-limit`,
      { method: 'POST' },
    ),

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

  pushStatus: () => request<{ enabled: boolean; subscriptions: number }>('/api/push/status'),

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

  listPlannerModels: () => request<PlannerModelListResponse>('/api/planner/models'),

  createPlannerModel: (body: CreatePlannerModelRequest) =>
    request<PlannerModel>('/api/planner/models', { method: 'POST', body: JSON.stringify(body) }),

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

  listPlannerChats: (workspaceId?: string) =>
    request<PlannerChatListResponse>(
      `/api/planner/chats${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`,
    ),

  createPlannerChat: (body: CreatePlannerChatRequest) =>
    request<PlannerChat>('/api/planner/chats', { method: 'POST', body: JSON.stringify(body) }),

  updatePlannerChat: (id: string, patch: UpdatePlannerChatRequest) =>
    request<PlannerChat>(`/api/planner/chats/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deletePlannerChat: (id: string) =>
    request<void>(`/api/planner/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  plannerChatHistory: (id: string) =>
    request<PlannerChatHistoryResponse>(`/api/planner/chats/${encodeURIComponent(id)}/history`),

  /**
   * Streams one turn's `AgentEvent`s as they happen — see
   * `PlannerChatHistoryResponse`'s doc comment (protocol package) for what
   * that does and does not mean — calling `onEvent` for each, in order.
   * Resolves once the turn either finishes (`turn_complete`) or pauses on a
   * mutating tool call with no remembered decision (`permission_request`
   * with no matching `permission_resolved` yet).
   */
  sendPlannerMessage: (id: string, body: PlannerSendMessageRequest, onEvent: (event: AgentEvent) => void) =>
    streamPlannerEvents(`/api/planner/chats/${encodeURIComponent(id)}/messages`, body, onEvent),

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
