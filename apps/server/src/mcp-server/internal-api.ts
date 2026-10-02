import crypto from 'node:crypto';
import { IncomingMessage } from 'node:http';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { McpClientIdentity } from '../auth/mcp-tokens.js';

/**
 * PA-118: the MCP tools that mirror an existing HTTP route call that route,
 * in-process, rather than re-implementing it.
 *
 * This is PA-70's rule — "provisioning is the Hub being an API client, not a
 * new contract" — applied from inside the process. A tool like
 * `delete_worktree` sits on forty lines of route logic (containment with a
 * deleted-worktree fallback, the live-session refusal, forgetting finished
 * rows, hiding the tree's chats), and a second copy of that is exactly the
 * thing that drifts silently. Calling the route also means every response
 * shape, validation message and audit line an MCP caller sees is the one the
 * browser sees.
 *
 * How such a call authenticates is the part that must not become a hole. It
 * presents a **single-use 256-bit nonce** in `INTERNAL_CALL_HEADER`, registered
 * here against the MCP principal the call is made for and consumed by the
 * gate's first lookup. Two independent properties keep the network out:
 *
 * - The nonce exists only in this process's memory for the duration of one
 *   `app.inject()`; nothing logs it and nothing returns it.
 * - The gate honours it only when `request.raw` is **not** an
 *   `http.IncomingMessage` — i.e. only for `light-my-request`'s synthetic
 *   request, which no socket can produce. A network request carrying the
 *   header falls through to ordinary authentication.
 *
 * And the principal it resolves to is the MCP client's own, so a route's
 * `auditConfigChange` names `mcp:<label>`, not "session".
 */
export const INTERNAL_CALL_HEADER = 'x-pocketagent-internal-call';

export interface InternalApiResponse<T = unknown> {
  status: number;
  body: T;
}

export class InternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'InternalApiError';
  }
}

export class InternalApiClient {
  private readonly pending = new Map<string, McpClientIdentity>();
  private app: FastifyInstance | null = null;

  /** Wired once from `app.ts`, after the instance exists. */
  attach(app: FastifyInstance): void {
    this.app = app;
  }

  /**
   * The gate's half. Consumes the nonce whether or not the request qualifies,
   * so a nonce can never be presented twice.
   */
  principalFor(request: FastifyRequest): McpClientIdentity | null {
    const header = request.headers[INTERNAL_CALL_HEADER];
    if (typeof header !== 'string' || header.length === 0) return null;
    const principal = this.pending.get(header) ?? null;
    if (principal) this.pending.delete(header);
    if (request.raw instanceof IncomingMessage) return null;
    return principal;
  }

  async request<T = unknown>(
    principal: McpClientIdentity,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<InternalApiResponse<T>> {
    if (!this.app) throw new Error('InternalApiClient used before it was attached.');
    const nonce = crypto.randomBytes(32).toString('base64url');
    this.pending.set(nonce, principal);
    try {
      const response = await this.app.inject({
        method,
        url,
        headers: {
          [INTERNAL_CALL_HEADER]: nonce,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
      });
      let parsed: unknown = null;
      if (response.body.length > 0) {
        try {
          parsed = JSON.parse(response.body);
        } catch {
          parsed = response.body;
        }
      }
      return { status: response.statusCode, body: parsed as T };
    } finally {
      // Normally already consumed by the gate; this covers a request that
      // never reached it (a routing failure before `onRequest`).
      this.pending.delete(nonce);
    }
  }

  /** `request`, throwing `InternalApiError` on any non-2xx with the route's own message. */
  async call<T = unknown>(
    principal: McpClientIdentity,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.request<T>(principal, method, url, body);
    if (response.status >= 200 && response.status < 300) return response.body;
    const error = (response.body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new InternalApiError(
      error?.message ?? `Request failed with status ${response.status}.`,
      response.status,
      error?.code ?? 'error',
    );
  }
}
