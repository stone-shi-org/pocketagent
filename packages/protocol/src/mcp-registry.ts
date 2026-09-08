import { z } from 'zod';

/**
 * PA-37: MCP (Model Context Protocol) registries for Pocket Agent.
 *
 * A registry is a remote MCP server this app knows how to reach — analogous to
 * `custom-claude-providers.ts`'s provider rows, and deliberately built the same
 * way: a row the user creates from Settings, a secret (bearer token or a
 * custom header value) encrypted at rest via `crypto/secret-box.ts`, and no
 * reveal endpoint. Unlike a custom Claude provider, a registry does not occupy
 * the agent-id value space — it contributes *tools* to the planner's existing
 * catalog, namespaced by `mcpQualifiedToolName` below, and is otherwise
 * invisible outside the planner's tool lists.
 */

/**
 * The two remote MCP transports the reporter asked for. `streamable_http` is
 * the current single-endpoint transport and the recommended default;
 * `sse` is the older two-endpoint (GET SSE + POST) transport, offered for
 * servers that have not moved to Streamable HTTP yet. No `stdio` — a registry
 * row would then have to name a local command to spawn, a materially larger
 * trust boundary than anything else this app manages from a settings-page
 * row, and it was not asked for.
 */
export const McpTransportKind = z.enum(['streamable_http', 'sse']);
export type McpTransportKind = z.infer<typeof McpTransportKind>;

/**
 * `bearer` sends `Authorization: Bearer <token>` — the primary, recommended
 * option and what most self-hosted MCP servers already accept. `header` sends
 * one arbitrary header name/value pair, for a server that instead expects
 * something like `X-API-Key` (the reporter's "or other"). Full MCP OAuth 2.1
 * (dynamic client registration, PKCE, token refresh) is out of scope — see
 * PA-37's posted plan for why.
 */
export const McpAuthKind = z.enum(['none', 'bearer', 'header']);
export type McpAuthKind = z.infer<typeof McpAuthKind>;

/**
 * A registry as the browser sees it. **Never carries the token or header
 * value**, in plaintext or ciphertext — same discipline as
 * `CustomClaudeProviderSummary`, and for the same reason: nothing outside this
 * server ever needs to read it back.
 */
export const McpRegistrySummary = z.object({
  /** `mcp:<slug>-<hex>` — stable, never reused after deletion. */
  id: z.string(),
  name: z.string(),
  transport: McpTransportKind,
  url: z.string(),
  authKind: McpAuthKind,
  /** Only meaningful when `authKind === 'header'`. */
  headerName: z.string().nullable(),
  /** Registry-level kill switch — off hides every one of its tools from
      every agent without deleting the row or its stored secret. */
  enabled: z.boolean(),
  /** Last known tool count, from the last successful connect/test/refresh —
      shown even when this server has no live connection right now. */
  toolCount: z.number().int(),
  lastConnectedAt: z.number().int().nullable(),
  /** Human-readable reason the last connection attempt failed, or `null` if
      the most recent attempt (if any) succeeded. Surfaced honestly rather
      than hidden — the same "never fired" posture a webhook row already
      takes for its own delivery history. */
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type McpRegistrySummary = z.infer<typeof McpRegistrySummary>;

export const McpRegistryListResponse = z.object({
  registries: z.array(McpRegistrySummary),
  encryptionAvailable: z.boolean(),
});
export type McpRegistryListResponse = z.infer<typeof McpRegistryListResponse>;

const NAME = z.string().min(1).max(128);
const URL_FIELD = z.string().min(1).max(2048);
const HEADER_NAME = z.string().min(1).max(200);
const SECRET = z.string().max(4096);

export const CreateMcpRegistryRequest = z
  .object({
    name: NAME,
    transport: McpTransportKind,
    url: URL_FIELD,
    authKind: McpAuthKind,
    /** Required when `authKind === 'bearer'`. */
    bearerToken: SECRET.optional(),
    /** Both required when `authKind === 'header'`. */
    headerName: HEADER_NAME.optional(),
    headerValue: SECRET.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.authKind !== 'bearer' || (v.bearerToken ?? '').length > 0, {
    message: 'A bearer token is required when auth is set to bearer.',
    path: ['bearerToken'],
  })
  .refine((v) => v.authKind !== 'header' || ((v.headerName ?? '').length > 0 && (v.headerValue ?? '').length > 0), {
    message: 'A header name and value are required when auth is set to header.',
    path: ['headerName'],
  });
export type CreateMcpRegistryRequest = z.infer<typeof CreateMcpRegistryRequest>;

/**
 * Partial update, same "blank/omitted keeps the stored secret" convention
 * `UpdateCustomClaudeProviderRequest.apiKey` already uses — the editor's
 * secret field starts empty (there is nothing to prefill it with) and a save
 * with it left blank must not wipe a working credential.
 */
export const UpdateMcpRegistryRequest = z.object({
  name: NAME.optional(),
  transport: McpTransportKind.optional(),
  url: URL_FIELD.optional(),
  authKind: McpAuthKind.optional(),
  bearerToken: SECRET.optional(),
  headerName: HEADER_NAME.optional(),
  headerValue: SECRET.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateMcpRegistryRequest = z.infer<typeof UpdateMcpRegistryRequest>;

/** For the settings page's "Test connection" button: connect, list tools,
    disconnect. Never throws to the route — a failed test is the expected,
    common outcome of clicking this button, not a server error. */
export const TestMcpRegistryResponse = z.object({
  ok: z.boolean(),
  message: z.string(),
  latencyMs: z.number().int(),
  toolCount: z.number().int().nullable(),
});
export type TestMcpRegistryResponse = z.infer<typeof TestMcpRegistryResponse>;

/** `POST .../refresh-tools` returns the same shape as list/test — there is
    nothing else a caller needs back. */
export const RefreshMcpRegistryToolsResponse = TestMcpRegistryResponse;
export type RefreshMcpRegistryToolsResponse = z.infer<typeof RefreshMcpRegistryToolsResponse>;

/**
 * The namespace prefix every MCP-derived tool name carries in the planner's
 * tool catalog, `PlannerToolInfo`/`PlannerAgentToolInfo` included — see
 * `mcpQualifiedToolName`. Exported so nothing downstream has to duplicate the
 * literal.
 */
export const MCP_TOOL_NAME_PREFIX = 'mcp__';

/**
 * Namespaces one registry's tool name so it can share the *existing*
 * `planner_global_disabled_tools`/`planner_agent_disabled_tools`/
 * `planner_tool_approvals` tables with the native catalog — "MCP tools treat
 * same as tools" (PA-37), not a parallel enable/disable system. A registry id
 * never contains `__` (it is minted as `mcp:<slug>-<hex>`, and the slug itself
 * collapses every run of non-alphanumeric characters to a single `-`), so
 * splitting on the first `__` after the prefix in `parseMcpQualifiedToolName`
 * is unambiguous even though an MCP tool's own name may itself contain
 * underscores.
 */
export function mcpQualifiedToolName(registryId: string, toolName: string): string {
  return `${MCP_TOOL_NAME_PREFIX}${registryId}__${toolName}`;
}

/** Inverse of `mcpQualifiedToolName`. `null` for anything that isn't one —
    including a plain native tool name, which never carries this prefix. */
export function parseMcpQualifiedToolName(qualified: string): { registryId: string; toolName: string } | null {
  if (!qualified.startsWith(MCP_TOOL_NAME_PREFIX)) return null;
  const rest = qualified.slice(MCP_TOOL_NAME_PREFIX.length);
  const separatorIndex = rest.indexOf('__');
  if (separatorIndex < 0) return null;
  const registryId = rest.slice(0, separatorIndex);
  const toolName = rest.slice(separatorIndex + 2);
  if (!registryId || !toolName) return null;
  return { registryId, toolName };
}

/**
 * The two meta-tool names added to the planner's native catalog
 * (`planner/tools.ts`) so a turn's `tools` array stays small and constant no
 * matter how many registries or MCP tools are configured — see PA-37's posted
 * plan, §4, for the full reasoning. Exported so `PlannerChatService` can
 * special-case them by name without a second, drifting copy of the literal.
 */
export const LIST_MCP_TOOLS_NAME = 'list_mcp_tools';
export const CALL_MCP_TOOL_NAME = 'call_mcp_tool';

/**
 * PA-37 follow-up round two (reporter: "In additional to enable/disable for
 * mcp all. Need add individual enable/disable. For example, we can globally
 * disable bamboo mcp but allow Jira mcp. Same concept for per agent base -
 * enable/disable all AND separate enable/disable for each mcp"): one agent's
 * own view of the registry catalog, `PlannerAgentToolInfo`/
 * `PlannerAgentSkillInfo`'s exact shape one layer up — a whole registry
 * instead of a tool or skill within one. `enabled` is the *effective* state
 * for this agent (this registry's own global `enabled` AND not individually
 * disabled for this agent); `disabledGlobally` greys out a checkbox the
 * agent can't override, mirroring both of those exactly.
 *
 * Deliberately does **not** carry `url`/`transport`/`authKind` or anything
 * else from `McpRegistrySummary` — the agent editor's own "MCP" section
 * cannot change what a registry *is*, only whether this one agent may reach
 * it, so there is nothing here for it to render beyond a name and a
 * checkbox.
 */
export const PlannerAgentMcpRegistryInfo = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  disabledGlobally: z.boolean(),
});
export type PlannerAgentMcpRegistryInfo = z.infer<typeof PlannerAgentMcpRegistryInfo>;

export const PlannerAgentMcpRegistriesResponse = z.object({
  registries: z.array(PlannerAgentMcpRegistryInfo),
});
export type PlannerAgentMcpRegistriesResponse = z.infer<typeof PlannerAgentMcpRegistriesResponse>;

export const SetPlannerAgentMcpRegistryRequest = z.object({
  registryId: z.string().min(1),
  enabled: z.boolean(),
});
export type SetPlannerAgentMcpRegistryRequest = z.infer<typeof SetPlannerAgentMcpRegistryRequest>;
