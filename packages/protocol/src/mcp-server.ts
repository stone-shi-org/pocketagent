import { z } from 'zod';

/**
 * PA-118: PocketAgent as an MCP *server*.
 *
 * `mcp-registry.ts` is the other direction — a Pocket Agent calling out to
 * someone else's MCP server. This file is the contract for an external agent
 * (Claude Code, Codex, a CI job, another PocketAgent) calling *in*, over
 * Streamable HTTP at `/mcp`.
 */

/**
 * The canonical endpoint. Deliberately outside `/api/`, because that is the
 * path the ticket asked for and the one a human types into `claude mcp add`.
 * Being outside `/api/` is also exactly what makes it dangerous: the server's
 * auth gate returns early for every non-`/api/` path (that is how the SPA shell
 * stays public), so this path is named in the gate by **exact match** — see
 * `app.ts`.
 */
export const MCP_SERVER_PATH = '/mcp';

/**
 * The same handler under `/api/`. Exists only because a Hub proxies
 * `/h/<id>/api/**` and nothing else, so `/mcp` alone would be unreachable
 * through one. `/mcp` stays the documented path.
 */
export const MCP_SERVER_API_ALIAS = '/api/mcp';

/**
 * Prefix on every MCP client token, so a token in a config file or a support
 * paste is distinguishable at a glance from a hub credential (`pah_`) or a
 * session id — and so the gate can reject anything else before it reaches the
 * database.
 */
export const MCP_TOKEN_SCHEME_PREFIX = 'pam_';

/** How much of a token is kept in the clear, for the list UI. Same budget as a hub credential's. */
export const MCP_TOKEN_PREFIX_LENGTH = MCP_TOKEN_SCHEME_PREFIX.length + 8;

/**
 * Coarse grants, one per tool group.
 *
 * This *is* a permissions model, which PA-63 deliberately declined for hub
 * credentials. The difference is who holds the token: a Hub is the operator's
 * own infrastructure, while an MCP token is pasted into a third-party agent's
 * config file — a much wider audience, so least privilege earns its cost here.
 *
 * - `read`: list and read everything the home screen shows. Never a secret.
 * - `sessions`: start, prompt, wait on, interrupt and stop coding-agent sessions.
 * - `planner`: create and drive Pocket Agent chats.
 * - `admin`: add/remove project folders, create/delete worktrees, hide and
 *   clear chats. Off by default, because adding a folder grants every agent on
 *   this machine access to it.
 */
export const McpScope = z.enum(['read', 'sessions', 'planner', 'admin']);
export type McpScope = z.infer<typeof McpScope>;

export const MCP_SCOPES: readonly McpScope[] = McpScope.options;
export const DEFAULT_MCP_SCOPES: readonly McpScope[] = ['read', 'sessions', 'planner'];

export const McpClientTokenSummary = z.object({
  id: z.string(),
  label: z.string(),
  /** First `MCP_TOKEN_PREFIX_LENGTH` characters of the token. There is no reveal path. */
  tokenPrefix: z.string(),
  scopes: z.array(McpScope),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
  lastSeenIp: z.string().nullable(),
  /** Coding-agent sessions this client started that are still running. */
  liveSessions: z.number().int().nonnegative(),
});
export type McpClientTokenSummary = z.infer<typeof McpClientTokenSummary>;

export const McpClientTokenListResponse = z.object({
  clients: z.array(McpClientTokenSummary),
  /** The canonical endpoint path, so the UI never hardcodes it. */
  path: z.string(),
});
export type McpClientTokenListResponse = z.infer<typeof McpClientTokenListResponse>;

export const CreateMcpClientTokenRequest = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(McpScope).min(1).max(MCP_SCOPES.length),
});
export type CreateMcpClientTokenRequest = z.infer<typeof CreateMcpClientTokenRequest>;

export const CreateMcpClientTokenResponse = z.object({
  client: McpClientTokenSummary,
  /** Shown exactly once. Only `sha256(token)` is stored. */
  token: z.string(),
});
export type CreateMcpClientTokenResponse = z.infer<typeof CreateMcpClientTokenResponse>;

/**
 * Header PocketAgent's own MCP *client* sets on every outbound call, carrying
 * how many PocketAgent hops deep the calling work already is.
 *
 * A loop guard, not a security boundary: a Pocket Agent can register this same
 * server's `/mcp` as an MCP registry, start a session through it, whose work
 * calls `/mcp` again, and so on. An arbitrary client can simply omit the header
 * — which costs it nothing it could not do by hand, since the per-token
 * concurrency cap is what actually bounds a runaway caller.
 */
export const MCP_DEPTH_HEADER = 'x-pocketagent-depth';

/**
 * The same depth, carried in a `tools/call` request's `_meta` instead. This is
 * the form PocketAgent's own client actually uses: it opens one connection per
 * call but serves many chats, so the depth belongs to the *call*, and `_meta`
 * is the MCP-native place for per-call context. The server takes the larger of
 * the two.
 */
export const MCP_DEPTH_META_KEY = 'pocketagent/depth';

/** Work-starting tools are refused at or beyond this depth. */
export const MAX_MCP_CALL_DEPTH = 3;

/** Live coding-agent sessions one MCP client may hold at once. */
export const MCP_MAX_LIVE_SESSIONS_PER_CLIENT = 3;

/**
 * Where a coding-agent or Pocket Agent turn stands, as `wait_for_turn` reports it.
 *
 * `awaiting_approval` is the reason this is not a boolean: an MCP caller can
 * *see* that a human is needed and can never answer for them (the first
 * invariant). The turn stays parked with no timeout until a person decides in
 * PocketAgent itself.
 */
export const McpTurnState = z.enum([
  'complete',
  'awaiting_approval',
  'queued',
  'still_running',
  'ended',
]);
export type McpTurnState = z.infer<typeof McpTurnState>;

/** Resource URI schemes (MCP `resources/*`). */
export const MCP_SESSION_RESOURCE_PREFIX = 'pocketagent://session/';
export const MCP_POCKET_CHAT_RESOURCE_PREFIX = 'pocketagent://pocket-chat/';
