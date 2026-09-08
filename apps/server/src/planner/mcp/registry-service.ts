import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  mcpQualifiedToolName,
  parseMcpQualifiedToolName,
  type CreateMcpRegistryRequest,
  type McpAuthKind,
  type McpRegistrySummary,
  type McpTransportKind,
  type TestMcpRegistryResponse,
  type UpdateMcpRegistryRequest,
} from '@pocketagent/protocol';
import type { Db } from '../../db/index.js';
import { SETTINGS_ENC_KEY_VAR, decryptSecret, encryptSecret } from '../../crypto/secret-box.js';
import { readPlannerSettings } from '../store.js';
import { McpClient, McpClientError, type McpConnectionConfig, type McpToolDescriptor } from './client.js';

export class McpRegistryError extends Error {
  override readonly name = 'McpRegistryError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'encryption_unavailable',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/** Shape of an `mcp_registries` row, as SQLite hands it back. */
interface Row {
  id: string;
  name: string;
  transport: string;
  url: string;
  auth_kind: string;
  bearer_token_ciphertext: string | null;
  header_name: string | null;
  header_value_ciphertext: string | null;
  enabled: number;
  tool_count: number;
  last_connected_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** One registry's live, in-memory state: the row (kept in step with the
    database on every mutation, `PlannerWorkspaceRegistry`-style, rather than
    re-queried) and its cached tool catalog. `tools: null` means "never
    connected yet" — a registry contributes no tools to any agent until an
    operator has hit Test connection or Refresh tools at least once; a turn
    in a chat is latency-sensitive and must never itself pay for discovering
    a possibly-dead server. */
interface LiveRegistry {
  row: Row;
  tools: McpToolDescriptor[] | null;
}

/** One entry of `listKnownTools()` — enough for the planner's tool-catalog
    merge (`PlannerChatService.toolsFor`, the two tool-listing routes) without
    handing out the raw `McpToolDescriptor`/registry internals. */
export interface McpKnownTool {
  qualifiedName: string;
  description: string;
  /** `true` only when the underlying MCP tool declared
      `annotations.readOnlyHint === true` — absent/unknown defaults to
      mutating (gated), the same fail-closed posture every other
      safety-unknown case in this codebase takes. */
  readOnly: boolean;
}

export interface McpRegistryServiceOptions {
  db: Db;
  /** `undefined` disables bearer/header auth create/update, same as
      `CustomClaudeProviderStoreOptions.encKey`. A registry with `authKind:
      'none'` needs no key and works either way. */
  encKey: Buffer | undefined;
  logger: FastifyBaseLogger;
}

/**
 * PA-37: owns `mcp_registries` — CRUD, encrypted auth secrets, and the live
 * connection/tool-cache layer on top of `McpClient`.
 *
 * Follows `CustomClaudeProviderStore`'s pattern: rows are the truth, hydrated
 * into memory at construction, and every mutation writes the row and updates
 * the in-memory copy in the same synchronous call, so the very next request
 * sees it. Unlike a custom Claude provider, there is no long-lived adapter to
 * re-register — what needs to stay in step here is a *tool cache*, refreshed
 * by `checkConnection` (shared by the "Test connection" button and the
 * "Refresh tools" button — same operation, two names for why a caller might
 * run it) rather than kept as an always-open connection, since a registry
 * might sit unused for the life of the process.
 */
export class McpRegistryService {
  private readonly db: Db;
  private readonly encKey: Buffer | undefined;
  private readonly logger: FastifyBaseLogger;
  private readonly live = new Map<string, LiveRegistry>();

  constructor(opts: McpRegistryServiceOptions) {
    this.db = opts.db;
    this.encKey = opts.encKey;
    this.logger = opts.logger;
    const rows = this.db
      .prepare('SELECT * FROM mcp_registries ORDER BY name COLLATE NOCASE, created_at')
      .all() as Row[];
    if (rows.some((r) => r.auth_kind !== 'none') && this.encKey === undefined) {
      this.logger.warn(
        { registries: rows.length },
        `${SETTINGS_ENC_KEY_VAR} is not set, so a stored MCP registry's bearer token or header ` +
          'value cannot be decrypted. It is listed but cannot connect until the key that ' +
          'encrypted it is configured.',
      );
    }
    for (const row of rows) this.live.set(row.id, { row, tools: null });
  }

  get encryptionAvailable(): boolean {
    return this.encKey !== undefined;
  }

  list(): McpRegistrySummary[] {
    return [...this.live.values()].map((l) => toSummary(l.row)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): McpRegistrySummary {
    return toSummary(this.liveOrThrow(id).row);
  }

  create(req: CreateMcpRegistryRequest): McpRegistrySummary {
    const key = req.authKind === 'none' ? undefined : this.requireKey();
    const now = Date.now();
    const id = mintRegistryId(req.name, new Set(this.live.keys()));
    const row: Row = {
      id,
      name: req.name.trim(),
      transport: req.transport,
      url: normalizeUrl(req.url),
      auth_kind: req.authKind,
      bearer_token_ciphertext:
        req.authKind === 'bearer' && key ? encryptSecret(req.bearerToken ?? '', key) : null,
      header_name: req.authKind === 'header' ? req.headerName ?? null : null,
      header_value_ciphertext:
        req.authKind === 'header' && key ? encryptSecret(req.headerValue ?? '', key) : null,
      enabled: req.enabled === false ? 0 : 1,
      tool_count: 0,
      last_connected_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    this.insert(row);
    this.live.set(row.id, { row, tools: null });
    this.logger.info(
      { registry: row.id, transport: row.transport, authKind: row.auth_kind },
      'MCP registry created',
    );
    return toSummary(row);
  }

  /**
   * Apply a partial update. A secret field omitted *or* blank keeps the
   * stored value — same "editor has nothing to prefill it with" reasoning
   * `CustomClaudeProviderStore.update`'s `apiKey` handling documents.
   * Switching `authKind` away from `bearer`/`header` clears whichever secret
   * no longer applies, so a registry that used to need a header and no
   * longer does does not keep a stale encrypted value sitting unused in the
   * row.
   */
  update(id: string, req: UpdateMcpRegistryRequest): McpRegistrySummary {
    const existing = this.liveOrThrow(id).row;
    const authKind = req.authKind ?? existing.auth_kind;
    const rekeyingBearer = authKind === 'bearer' && (req.bearerToken ?? '').trim().length > 0;
    const rekeyingHeader = authKind === 'header' && (req.headerValue ?? '').trim().length > 0;
    const key = rekeyingBearer || rekeyingHeader ? this.requireKey() : undefined;

    const row: Row = {
      ...existing,
      name: req.name === undefined ? existing.name : req.name.trim(),
      transport: req.transport ?? existing.transport,
      url: req.url === undefined ? existing.url : normalizeUrl(req.url),
      auth_kind: authKind,
      bearer_token_ciphertext:
        authKind !== 'bearer'
          ? null
          : key && req.bearerToken !== undefined
            ? encryptSecret(req.bearerToken, key)
            : existing.auth_kind === 'bearer'
              ? existing.bearer_token_ciphertext
              : null,
      header_name: authKind === 'header' ? (req.headerName ?? existing.header_name) : null,
      header_value_ciphertext:
        authKind !== 'header'
          ? null
          : key && req.headerValue !== undefined
            ? encryptSecret(req.headerValue, key)
            : existing.auth_kind === 'header'
              ? existing.header_value_ciphertext
              : null,
      enabled: req.enabled === undefined ? existing.enabled : req.enabled ? 1 : 0,
      updated_at: Date.now(),
    };
    this.persist(row);
    this.live.set(row.id, { row, tools: this.live.get(row.id)?.tools ?? null });
    this.logger.info(
      { registry: row.id, rekeyed: rekeyingBearer || rekeyingHeader, enabled: row.enabled === 1 },
      'MCP registry updated',
    );
    return toSummary(row);
  }

  /**
   * Forget a registry. Any `planner_tool_approvals` rows for this registry's
   * tools (a remembered "always allow"/"always deny" for one specific real
   * tool, from the dynamic `call_mcp_tool` approval-gating special case) are
   * pure current configuration for tools that no longer exist — cleaned up
   * here, unlike `cron_runs`/`webhook_deliveries` history, which is
   * deliberately kept after the thing that created it is gone. There is
   * nothing to clean up in `planner_global_disabled_tools`/
   * `planner_agent_disabled_tools` — MCP tool names are never written there
   * (PA-37 follow-up: enablement is whole-MCP, not per-tool).
   */
  remove(id: string): boolean {
    const changes = this.db.prepare('DELETE FROM mcp_registries WHERE id = ?').run(id).changes;
    if (changes === 0) return false;
    this.live.delete(id);
    this.cleanupToolConfigFor(id);
    this.logger.info({ registry: id }, 'MCP registry deleted');
    return true;
  }

  /**
   * Connect, list tools, disconnect — shared by the "Test connection" and
   * "Refresh tools" buttons (and, if it becomes convenient, a boot-time
   * warm-up); a successful call replaces this registry's cached catalog,
   * which is what actually makes its tools usable by `list_mcp_tools`/
   * `call_mcp_tool`. Never throws: a failed connection is the expected,
   * common outcome of clicking this button, not a server error, so the route
   * can always answer 200 with a verdict — the same posture
   * `PlannerChatService.testModel` already takes for the LLM endpoint.
   */
  async checkConnection(id: string): Promise<TestMcpRegistryResponse> {
    const live = this.liveOrThrow(id);
    const startedAt = Date.now();
    const client = new McpClient(this.connectionConfig(live.row));
    try {
      await client.connect();
      const tools = await client.listTools();
      this.recordSuccess(id, tools);
      return {
        ok: true,
        message: `Connected — ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
        latencyMs: Date.now() - startedAt,
        toolCount: tools.length,
      };
    } catch (err) {
      const message = err instanceof McpClientError ? err.message : (err as Error).message;
      this.recordFailure(id, message);
      return { ok: false, message, latencyMs: Date.now() - startedAt, toolCount: null };
    } finally {
      await client.close();
    }
  }

  /**
   * Every tool from every *enabled* registry that has connected at least
   * once, namespaced. A disabled registry, or one that has never
   * successfully connected, contributes nothing — not an error, the same
   * "unconfigured is a normal steady state" posture `web_search`/`url_fetch`
   * already take. Unfiltered by the whole-MCP on/off switch — see
   * `listEnabledTools` for that; this raw form exists for the settings page
   * to show what a registry has (§ its own tool-count display), independent
   * of whether MCP is currently switched on anywhere.
   */
  listKnownTools(): McpKnownTool[] {
    const out: McpKnownTool[] = [];
    for (const live of this.live.values()) {
      if (live.row.enabled !== 1 || !live.tools) continue;
      for (const tool of live.tools) {
        out.push({
          qualifiedName: mcpQualifiedToolName(live.row.id, tool.name),
          description: `[${live.row.name}] ${tool.description}`,
          readOnly: tool.readOnlyHint === true,
        });
      }
    }
    return out;
  }

  /**
   * `listKnownTools()`, gated by the whole-MCP on/off switch for one agent —
   * this is what `list_mcp_tools`/`call_mcp_tool`'s own `execute()` and
   * `PlannerChatService.toolsFor`/`effectiveMcpToolIdentity` all call.
   *
   * PA-37 follow-up (reporter: "Let's not list the mcp tool as separate
   * tools to allow/disallow. Let's just enable/disable mcp as whole for
   * global or each agent."): deliberately **not** per-tool or per-registry
   * filtering — either every enabled registry's tools are available to this
   * agent, or none are. Two layers, both must be true: the global switch
   * (`readPlannerSettings(db).mcpEnabled`, defaulting to on) and, when this
   * chat has a real agent, that agent's own `planner_workspaces.mcp_enabled`
   * (also defaulting to on — a fresh migration must not silently take MCP
   * away from an agent that never touched the setting). `workspaceId: null`
   * (an orphaned chat) skips the per-agent read entirely and defers to the
   * global layer alone, the same fallback the native tool catalog's own
   * `PlannerChatService.toolsFor` already uses.
   */
  listEnabledTools(workspaceId: string | null): McpKnownTool[] {
    if (!readPlannerSettings(this.db).mcpEnabled) return [];
    if (workspaceId && !this.isMcpEnabledForWorkspace(workspaceId)) return [];
    return this.listKnownTools();
  }

  /** Raw read of one agent's own MCP switch, straight off `planner_workspaces`
      — a direct query rather than a `PlannerWorkspaceRegistry` dependency,
      since this is the only field this service ever needs from that table
      and a missing row (should not normally happen) defaults to enabled,
      the same "fail open at the per-agent layer, the global layer is the
      real kill switch" reasoning `workspaceId: null` above already uses. */
  private isMcpEnabledForWorkspace(workspaceId: string): boolean {
    const row = this.db.prepare('SELECT mcp_enabled FROM planner_workspaces WHERE id = ?').get(workspaceId) as
      | { mcp_enabled: number }
      | undefined;
    return row ? row.mcp_enabled === 1 : true;
  }

  /**
   * Resolve a namespaced tool name to its full descriptor (schema included)
   * and owning registry's display name — used by `list_mcp_tools` to answer
   * with detail on a specific match, and by `call_mcp_tool`'s dynamic
   * approval-gating (PA-37 plan §4) to find the *real* tool's
   * `readOnlyHint` before deciding whether to pause the turn. `null` for an
   * unknown, disabled, or not-yet-cached tool — every caller treats that the
   * same way an unknown native tool name is already treated.
   */
  resolveTool(qualifiedName: string): { registryId: string; registryName: string; tool: McpToolDescriptor } | null {
    const parsed = parseMcpQualifiedToolName(qualifiedName);
    if (!parsed) return null;
    const live = this.live.get(parsed.registryId);
    if (!live || live.row.enabled !== 1 || !live.tools) return null;
    const tool = live.tools.find((t) => t.name === parsed.toolName);
    if (!tool) return null;
    return { registryId: live.row.id, registryName: live.row.name, tool };
  }

  /**
   * Dispatch a `tools/call` for a namespaced tool name — a fresh short-lived
   * connection per call (see `McpClient`'s own doc comment for why), never a
   * kept-open one. Throws `McpRegistryError('not_found')` for a name that
   * doesn't resolve; `planner/tools.ts`'s `call_mcp_tool` turns that into a
   * tool-result string the same way every other tool error there is
   * surfaced, never an uncaught exception.
   */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const parsed = parseMcpQualifiedToolName(qualifiedName);
    if (!parsed) {
      throw new McpRegistryError(`"${qualifiedName}" is not an MCP tool.`, 'not_found', 404);
    }
    const live = this.live.get(parsed.registryId);
    if (!live || live.row.enabled !== 1) {
      throw new McpRegistryError(`The MCP registry for "${qualifiedName}" is not available.`, 'not_found', 404);
    }
    const client = new McpClient(this.connectionConfig(live.row));
    try {
      await client.connect();
      return await client.callTool(parsed.toolName, args);
    } catch (err) {
      const message = err instanceof McpClientError ? err.message : (err as Error).message;
      this.recordFailure(parsed.registryId, message);
      throw new McpRegistryError(message, 'not_found', 502);
    } finally {
      await client.close();
    }
  }

  // ---- internals --------------------------------------------------------

  private connectionConfig(row: Row): McpConnectionConfig {
    return {
      url: row.url,
      transport: row.transport as McpTransportKind,
      authKind: row.auth_kind as McpAuthKind,
      bearerToken: row.auth_kind === 'bearer' ? this.decrypt(row.bearer_token_ciphertext, row.id) : null,
      headerName: row.auth_kind === 'header' ? row.header_name : null,
      headerValue: row.auth_kind === 'header' ? this.decrypt(row.header_value_ciphertext, row.id) : null,
    };
  }

  private decrypt(ciphertext: string | null, registryId: string): string | null {
    if (!ciphertext || this.encKey === undefined) return null;
    try {
      return decryptSecret(ciphertext, this.encKey);
    } catch {
      // The message deliberately carries no part of the ciphertext.
      this.logger.error(
        { registry: registryId },
        `Could not decrypt this MCP registry's secret with the configured ${SETTINGS_ENC_KEY_VAR}. ` +
          'Re-enter it in Settings to repair it.',
      );
      return null;
    }
  }

  private requireKey(): Buffer {
    if (this.encKey === undefined) {
      throw new McpRegistryError(
        `Set ${SETTINGS_ENC_KEY_VAR} to enable bearer/header auth for an MCP registry.`,
        'encryption_unavailable',
        409,
      );
    }
    return this.encKey;
  }

  private recordSuccess(id: string, tools: McpToolDescriptor[]): void {
    const live = this.live.get(id);
    if (!live) return;
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE mcp_registries SET tool_count = ?, last_connected_at = ?, last_error = NULL, updated_at = ? WHERE id = ?',
      )
      .run(tools.length, now, now, id);
    live.tools = tools;
    live.row = { ...live.row, tool_count: tools.length, last_connected_at: now, last_error: null, updated_at: now };
  }

  /** Deliberately does not clear the cached tool list or `tool_count` — a
      transient failure must not make every one of this registry's tools
      vanish from every agent's catalog mid-outage; it should instead fail
      loudly the next time something actually tries to call one. */
  private recordFailure(id: string, message: string): void {
    const live = this.live.get(id);
    if (!live) return;
    const now = Date.now();
    this.db.prepare('UPDATE mcp_registries SET last_error = ?, updated_at = ? WHERE id = ?').run(message, now, id);
    live.row = { ...live.row, last_error: message, updated_at: now };
  }

  private cleanupToolConfigFor(registryId: string): void {
    const rows = this.db.prepare('SELECT DISTINCT tool_name FROM planner_tool_approvals').all() as {
      tool_name: string;
    }[];
    const stale = rows.map((r) => r.tool_name).filter((name) => parseMcpQualifiedToolName(name)?.registryId === registryId);
    if (stale.length === 0) return;
    const placeholders = stale.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM planner_tool_approvals WHERE tool_name IN (${placeholders})`).run(...stale);
  }

  private liveOrThrow(id: string): LiveRegistry {
    const live = this.live.get(id);
    if (!live) throw new McpRegistryError('No such MCP registry.', 'not_found', 404);
    return live;
  }

  private insert(row: Row): void {
    this.db
      .prepare(
        `INSERT INTO mcp_registries
           (id, name, transport, url, auth_kind, bearer_token_ciphertext, header_name,
            header_value_ciphertext, enabled, tool_count, last_connected_at, last_error,
            created_at, updated_at)
         VALUES (@id, @name, @transport, @url, @auth_kind, @bearer_token_ciphertext, @header_name,
            @header_value_ciphertext, @enabled, @tool_count, @last_connected_at, @last_error,
            @created_at, @updated_at)`,
      )
      .run(row);
  }

  private persist(row: Row): void {
    this.db
      .prepare(
        `UPDATE mcp_registries
            SET name = @name, transport = @transport, url = @url, auth_kind = @auth_kind,
                bearer_token_ciphertext = @bearer_token_ciphertext, header_name = @header_name,
                header_value_ciphertext = @header_value_ciphertext, enabled = @enabled,
                tool_count = @tool_count, last_connected_at = @last_connected_at,
                last_error = @last_error, updated_at = @updated_at
          WHERE id = @id`,
      )
      .run(row);
  }
}

function toSummary(row: Row): McpRegistrySummary {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as McpTransportKind,
    url: row.url,
    authKind: row.auth_kind as McpAuthKind,
    headerName: row.header_name,
    enabled: row.enabled === 1,
    toolCount: row.tool_count,
    lastConnectedAt: row.last_connected_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * `mcp:<slug>-<hex>`. Never contains `__`, which is what lets
 * `mcpQualifiedToolName`/`parseMcpQualifiedToolName` split a qualified tool
 * name unambiguously — see that function's own doc comment.
 */
function mintRegistryId(name: string, taken: ReadonlySet<string>): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'registry';
  for (;;) {
    const id = `mcp:${slug}-${crypto.randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpRegistryError('URL must be an absolute http(s) URL.', 'invalid', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpRegistryError('URL must use http or https.', 'invalid', 400);
  }
  return trimmed;
}
