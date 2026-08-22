import type {
  AdoptableTarget,
  AgentEvent,
  AgentUsageInfo,
  BrowseEntry,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  DiscoveredFolder,
  AgentInfo,
  ConversationInfo,
  HostInfo,
  MeResponse,
  ProjectInfo,
  SessionInfo,
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

  addWorkspace: (path: string) =>
    request<{ ok: true; path: string; label: string }>('/api/workspaces/add', {
      method: 'POST',
      body: JSON.stringify({ path }),
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

  /** Start a brand-new named tmux session on the adoption socket. */
  createAdoptableSession: (name: string) =>
    request<AdoptableTarget>('/api/adoptable', {
      method: 'POST',
      body: JSON.stringify({ name }),
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

  /** The operator's server-wide "skip all approvals" switch. Off by default. */
  getSettings: () => request<{ skipPermissionsEnabled: boolean }>('/api/settings'),

  updateSettings: (skipPermissionsEnabled: boolean) =>
    request<{ skipPermissionsEnabled: boolean }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ skipPermissionsEnabled }),
    }),

  /** Rate-limit usage for every agent that reports its own, for the status area next to `HostChip`. */
  getUsage: () => request<{ usage: AgentUsageInfo[] }>('/api/usage'),
};
