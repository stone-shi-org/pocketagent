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
  UpdateSettingsRequest,
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
    request<{ host: HostInfo; projects: ProjectInfo[] }>(
      `/api/projects${includeHidden ? '?includeHidden=1' : ''}`,
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

  createSession: (input: {
    agent: string;
    cwd: string;
    cols: number;
    rows: number;
    title?: string;
    transport?: 'terminal' | 'structured';
    /** Resume a conversation from the agent's own session store. */
    resumeAgentSessionId?: string;
    /** Branch instead of appending. Defaults to true server-side. */
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
    request<{ deliveryId: string | null; status: string; sessionId: string | null; reason: string | null }>(
      `/api/webhooks/${encodeURIComponent(id)}/test`,
      { method: 'POST', body: JSON.stringify(payload !== undefined ? { payload } : {}) },
    ),

  /** Renders server-side so the editor never re-implements the renderer. */
  previewWebhookPrompt: (id: string, body: { payload?: string; promptTemplate?: string }) =>
    request<WebhookPreviewResponse>(`/api/webhooks/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};
