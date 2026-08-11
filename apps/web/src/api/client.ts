import type {
  AdoptableTarget,
  AgentInfo,
  ConversationInfo,
  MeResponse,
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
  }) =>
    request<SessionInfo>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  deleteSession: (id: string) =>
    request<SessionInfo>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  listWorkspaces: () => request<{ workspaces: WorkspaceEntry[] }>('/api/workspaces'),

  listAgents: () => request<{ agents: AgentInfo[] }>('/api/agents'),

  listConversations: () =>
    request<{ conversations: ConversationInfo[] }>('/api/conversations'),

  listAdoptable: () =>
    request<{ enabled: boolean; targets: AdoptableTarget[] }>('/api/adoptable'),

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
};
