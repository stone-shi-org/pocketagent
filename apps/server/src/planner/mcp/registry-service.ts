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
import { readAgentDisabledMcpRegistries, readPlannerSettings } from '../store.js';
import { McpClient, McpClientError, type McpConnectionConfig, type McpToolDescriptor } from './client.js';

export class McpRegistryError extends Error {
  override readonly name = 'McpRegistryError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'encryption_unavailable' | 'unreachable',
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
  description: string | null;
  reported_instructions: string | null;
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
  /** PA-101: consecutive connection/timeout failure streak. */
  failureStreak?: number;
  /** PA-101: epoch ms until which calls to this registry short-circuit. */
  cooldownUntil?: number | null;
}

/** One entry of `listKnownTools()` — enough for the planner's tool-catalog
    merge (`PlannerChatService.toolsFor`, the two tool-listing routes) without
    handing out the raw `McpToolDescriptor`/registry internals. */
export interface McpKnownTool {
  qualifiedName: string;
  /** The owning registry's id — so per-agent, per-registry filtering
      (`listEnabledTools`) doesn't have to re-parse `qualifiedName` back
      apart via `parseMcpQualifiedToolName` for every tool on every call. */
  registryId: string;
  description: string;
  /** `true` only when the underlying MCP tool declared
      `annotations.readOnlyHint === true` — absent/unknown defaults to
      mutating (gated), the same fail-closed posture every other
      safety-unknown case in this codebase takes. */
  readOnly: boolean;
}

/** One entry of `listEnabledRegistries()` — the cheap "directory" tier
    `list_mcp_tools` (`planner/tools.ts`) returns with no `registry` argument,
    so a model can decide which registry is relevant before spending any of
    its per-registry tool-schema budget. Deliberately much smaller than
    `McpRegistrySummary`: no `url`/`transport`/`authKind`/timestamps, none of
    which help a model choose. */
export interface McpRegistryDirectoryEntry {
  id: string;
  name: string;
  host: string;
  description: string | null;
  toolCount: number;
}

export interface McpRegistryServiceOptions {
  db: Db;
  /** `undefined` disables bearer/header auth create/update, same as
      `CustomClaudeProviderStoreOptions.encKey`. A registry with `authKind:
      'none'` needs no key and works either way. */
  encKey: Buffer | undefined;
  logger: FastifyBaseLogger;
  /** Injected in tests so clock can be advanced deterministically. Defaults to Date.now. */
  now?: () => number;
  /** Injected in tests to mock or supply fake transports. Defaults to new McpClient(config). */
  clientFactory?: (config: McpConnectionConfig) => McpClient;
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
  private readonly now: () => number;
  private readonly clientFactory?: (config: McpConnectionConfig) => McpClient;
  private readonly live = new Map<string, LiveRegistry>();

  /**
   * Resolves once every registry that was `enabled` at construction has
   * finished its boot-time reconnect attempt (success or failure) — never
   * rejects, since `checkConnection` itself never throws. `Promise.resolve()`
   * immediately when nothing needs warming (the overwhelmingly common case:
   * no registries configured, or none enabled), so this costs nothing for a
   * deployment that isn't using the feature.
   *
   * PA-37 round four (prod bug report, comment 10276: "whenever system
   * refresh start, pocket agent can't find mcp tool, but once I click
   * test/refresh... it will work... without doing anything and same
   * prompt"). Root cause: the constructor below always hydrated `tools` as
   * `null` for every row, regardless of what `tool_count`/`last_connected_at`
   * said in the database — a registry that connected successfully seconds
   * before a restart looked exactly like one that had *never* connected,
   * because the tool cache lives only in process memory (`LiveRegistry.tools`),
   * never in the row. `checkConnection`'s own doc comment already floated
   * this as a known gap ("if it becomes convenient, a boot-time warm-up") —
   * this is that warm-up, finally wired in.
   *
   * Deliberately fire-and-forget from the caller's point of view: nothing in
   * `app.ts`'s boot sequence awaits this field, so a slow or unreachable
   * registry (each capped at `MCP_CONNECT_TIMEOUT_MS` = 15s, all run
   * concurrently via `Promise.allSettled`, never serially) cannot delay the
   * server from accepting requests. It exists as a public field rather than
   * a purely internal side effect only so a test can `await` it directly
   * instead of racing a real reconnect with an arbitrary sleep — the same
   * "no timeout, deterministic wait" preference this codebase applies to
   * approval gates, expressed here for a background task instead of a human
   * decision.
   */
  readonly warmupComplete: Promise<void>;

  constructor(opts: McpRegistryServiceOptions) {
    this.db = opts.db;
    this.encKey = opts.encKey;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.clientFactory = opts.clientFactory;
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
    for (const row of rows) this.live.set(row.id, { row, tools: null, failureStreak: 0, cooldownUntil: null });

    const enabledIds = rows.filter((r) => r.enabled === 1).map((r) => r.id);
    this.warmupComplete =
      enabledIds.length === 0
        ? Promise.resolve()
        : Promise.allSettled(enabledIds.map((id) => this.checkConnection(id))).then((results) => {
            // `checkConnection` never throws (its own doc comment says so),
            // so every settlement is `fulfilled`; a connection failure shows
            // up as `value.ok === false`, not as `status: 'rejected'`.
            // `allSettled` (rather than `all`) is still the right call here
            // purely as defense in depth against that contract changing
            // later without this warm-up loop being revisited.
            const failed = results.filter((r) => r.status === 'rejected' || !r.value.ok).length;
            this.logger.info({ registries: enabledIds.length, failed }, 'MCP registry boot-time warm-up complete');
          });
  }

  private createClient(row: Row): McpClient {
    const config = this.connectionConfig(row);
    if (this.clientFactory) return this.clientFactory(config);
    return new McpClient(config);
  }

  get encryptionAvailable(): boolean {
    return this.encKey !== undefined;
  }

  list(): McpRegistrySummary[] {
    return [...this.live.values()].map((l) => toSummary(l.row, l, this.now())).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): McpRegistrySummary {
    const live = this.liveOrThrow(id);
    return toSummary(live.row, live, this.now());
  }

  create(req: CreateMcpRegistryRequest): McpRegistrySummary {
    const key = req.authKind === 'none' ? undefined : this.requireKey();
    const now = this.now();
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
      description: req.description?.trim() || null,
      reported_instructions: null,
    };
    this.insert(row);
    const live: LiveRegistry = { row, tools: null, failureStreak: 0, cooldownUntil: null };
    this.live.set(row.id, live);
    this.logger.info(
      { registry: row.id, transport: row.transport, authKind: row.auth_kind },
      'MCP registry created',
    );
    return toSummary(row, live, this.now());
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
      updated_at: this.now(),
      // Omitted keeps the stored value; an empty (or whitespace-only) string
      // clears it back to `null` — same "blank means unset" convention as a
      // chat title edit, and safe to round-trip unlike a secret field.
      description: req.description === undefined ? existing.description : req.description.trim() || null,
    };
    this.persist(row);
    const prevLive = this.live.get(row.id);
    const live: LiveRegistry = {
      row,
      tools: prevLive?.tools ?? null,
      failureStreak: prevLive?.failureStreak ?? 0,
      cooldownUntil: prevLive?.cooldownUntil ?? null,
    };
    this.live.set(row.id, live);
    this.logger.info(
      { registry: row.id, rekeyed: rekeyingBearer || rekeyingHeader, enabled: row.enabled === 1 },
      'MCP registry updated',
    );
    return toSummary(row, live, this.now());
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
   * (PA-37 follow-up: enablement is whole-MCP/per-registry, not per-tool).
   * `planner_agent_disabled_mcp_registries` needs no manual cleanup either:
   * its `registry_id` is a real foreign key with `ON DELETE CASCADE`, so
   * this one `DELETE` below already takes those rows with it.
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
   * Connect, list tools, disconnect — shared by the "Test connection" button,
   * the "Refresh tools" button, and (PA-37 round four) the constructor's own
   * `warmupComplete` boot-time reconnect; a successful call replaces this
   * registry's cached catalog, which is what actually makes its tools usable
   * by `list_mcp_tools`/`call_mcp_tool`. Never throws: a failed connection is
   * the expected, common outcome of any of those three callers, not a server
   * error, so a route can always answer 200 with a verdict — the same
   * posture `PlannerChatService.testModel` already takes for the LLM
   * endpoint — and the boot-time warm-up can `Promise.allSettled` many of
   * these without a `.catch` per call.
   */
  async checkConnection(id: string): Promise<TestMcpRegistryResponse> {
    const live = this.liveOrThrow(id);
    const startedAt = this.now();
    const client = this.createClient(live.row);
    try {
      await client.connect();
      const tools = await client.listTools();
      this.recordSuccess(id, tools, client.getInstructions());
      return {
        ok: true,
        message: `Connected — ${tools.length} tool${tools.length === 1 ? '' : 's'} available.`,
        latencyMs: this.now() - startedAt,
        toolCount: tools.length,
      };
    } catch (err) {
      const rawMessage = err instanceof McpClientError ? err.message : (err as Error).message;
      const host = extractHost(live.row.url);
      const formattedMessage = formatMcpErrorMessage(live.row.name, host, live.row.transport, rawMessage);
      this.recordFailure(id, formattedMessage);
      return { ok: false, message: formattedMessage, latencyMs: this.now() - startedAt, toolCount: null };
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
          registryId: live.row.id,
          description: `[${live.row.name}] ${tool.description}`,
          readOnly: tool.readOnlyHint === true,
        });
      }
    }
    return out;
  }

  /**
   * `listKnownTools()`, gated by every enablement layer for one agent — this
   * is what `list_mcp_tools`/`call_mcp_tool`'s own `execute()` and
   * `PlannerChatService.toolsFor`/`effectiveMcpToolIdentity` all call.
   *
   * Three layers, all must be true, from broadest to narrowest:
   *
   * 1. The whole-MCP global switch (`readPlannerSettings(db).mcpEnabled`,
   *    defaulting to on) — PA-37 follow-up: "Let's just enable/disable mcp
   *    as whole for global or each agent."
   * 2. This agent's own whole-MCP switch (`planner_workspaces.mcp_enabled`,
   *    also defaulting to on), skipped entirely for `workspaceId: null` (an
   *    orphaned chat has no per-agent switch to read, the same fallback the
   *    native tool catalog's own `PlannerChatService.toolsFor` already
   *    uses) — the other half of the same follow-up.
   * 3. Per-registry: each registry's own global `enabled` (already applied
   *    inside `listKnownTools()`) *and*, for a real agent, whether that
   *    agent has individually disabled this specific registry
   *    (`planner_agent_disabled_mcp_registries`) — PA-37 follow-up round
   *    two: "we can globally disable bamboo mcp but allow Jira mcp. Same
   *    concept for per agent base... enable/disable all AND separate
   *    enable/disable for each mcp." Deliberately still not *tool*
   *    granularity within one registry — that was the very first cut of
   *    this ticket, reverted by the first follow-up above.
   */
  listEnabledTools(workspaceId: string | null): McpKnownTool[] {
    if (!readPlannerSettings(this.db).mcpEnabled) return [];
    if (!workspaceId) return this.listKnownTools();
    if (!this.isMcpEnabledForWorkspace(workspaceId)) return [];
    const disabledRegistries = readAgentDisabledMcpRegistries(this.db, workspaceId);
    if (disabledRegistries.size === 0) return this.listKnownTools();
    return this.listKnownTools().filter((t) => !disabledRegistries.has(t.registryId));
  }

  /**
   * The cheap "directory" tier `list_mcp_tools` returns with no `registry`
   * argument: one entry per registry visible to this agent (same three-layer
   * gating `listEnabledTools` applies — global switch, per-agent switch,
   * per-registry enable), each just `{id, name, description, toolCount}`,
   * never a tool schema. This is what lets a model learn *that* a registry
   * exists and roughly *what it's for* without paying to serialize every one
   * of its tools' full JSON schemas — the fix for a chatty registry (many
   * tools, verbose per-tool descriptions) starving every other registry's
   * share of `list_mcp_tools`' own truncation budget, since that budget is
   * now spent per registry (via `registry`) rather than once across all of
   * them.
   *
   * Lists a registry even if it has never successfully connected
   * (`tool_count` then reads `0`) — unlike `listKnownTools()`, this is a
   * discovery surface, not a live tool catalog, so a freshly-added,
   * not-yet-tested registry is still worth an agent knowing about.
   *
   * `description` here is the *effective* one for a model to read: the
   * user-authored column if set, else the server's own last-reported
   * `initialize` `instructions` (most servers don't set one, but one that
   * does is better than nothing) — the model has no use for which of the two
   * it's reading, only the settings page draws that distinction, so it keeps
   * both raw fields (`McpRegistrySummary.description`/`reportedInstructions`)
   * separately.
   */
  listEnabledRegistries(workspaceId: string | null): McpRegistryDirectoryEntry[] {
    if (!readPlannerSettings(this.db).mcpEnabled) return [];
    if (workspaceId && !this.isMcpEnabledForWorkspace(workspaceId)) return [];
    const disabledRegistries = workspaceId ? readAgentDisabledMcpRegistries(this.db, workspaceId) : new Set<string>();
    return [...this.live.values()]
      .filter((l) => l.row.enabled === 1 && !disabledRegistries.has(l.row.id))
      .map((l) => ({
        id: l.row.id,
        name: l.row.name,
        host: extractHost(l.row.url),
        description: l.row.description ?? l.row.reported_instructions ?? null,
        toolCount: l.row.tool_count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Resolve the `registry` argument `list_mcp_tools`/`call_mcp_tool`'s own
   * `execute()` accepts — a registry's id (as minted, `mcp:<slug>-<hex>`) or
   * its display name, case-insensitively, since a model is far more likely
   * to echo back the human-readable name it just read from the directory
   * tier than to retype an opaque id correctly. Gated through
   * `listEnabledRegistries` rather than a raw lookup, so a ref naming a
   * registry that exists but is disabled (globally or for this agent)
   * resolves to `null` exactly like an unknown one — the same "disabled
   * looks like absent from in here" posture `listEnabledTools` already
   * takes for an individual tool.
   */
  resolveRegistryRef(ref: string, workspaceId: string | null): string | null {
    const lower = ref.trim().toLowerCase();
    if (!lower) return null;
    const match = this.listEnabledRegistries(workspaceId).find(
      (r) => r.id === ref || r.name.toLowerCase() === lower,
    );
    return match?.id ?? null;
  }

  /** Raw read of one agent's own whole-MCP switch, straight off
      `planner_workspaces` — a direct query rather than a
      `PlannerWorkspaceRegistry` dependency, since this is the only field
      this service ever needs from that table and a missing row (should not
      normally happen) defaults to enabled, the same "fail open at the
      per-agent layer, the global layer is the real kill switch" reasoning
      `listEnabledTools` already applies at every layer. */
  private isMcpEnabledForWorkspace(workspaceId: string): boolean {
    const row = this.db.prepare('SELECT mcp_enabled FROM planner_workspaces WHERE id = ?').get(workspaceId) as
      | { mcp_enabled: number }
      | undefined;
    return row ? row.mcp_enabled === 1 : true;
  }

  /**
   * One agent's own view of the registry catalog, for the agent editor's
   * "MCP" section (PA-37 follow-up round two) — every registry, `enabled`
   * effective for this agent (this registry's own global `enabled` AND not
   * individually disabled for this agent) and `disabledGlobally` when the
   * registry itself is off, mirroring `PlannerAgentToolInfo`/
   * `PlannerAgentSkillInfo` exactly. Lists **every** registry regardless of
   * whether it has ever connected — unlike `listKnownTools()`, this is a
   * configuration surface, not a live tool catalog, so an uncached registry
   * still needs a row to toggle.
   */
  listForWorkspace(workspaceId: string): { id: string; name: string; enabled: boolean; disabledGlobally: boolean }[] {
    const disabled = readAgentDisabledMcpRegistries(this.db, workspaceId);
    return [...this.live.values()]
      .map((l) => ({
        id: l.row.id,
        name: l.row.name,
        enabled: l.row.enabled === 1 && !disabled.has(l.row.id),
        disabledGlobally: l.row.enabled !== 1,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
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

    if (live.cooldownUntil && live.cooldownUntil > this.now()) {
      const host = extractHost(live.row.url);
      const lastErrorAgo = live.row.updated_at ? Math.max(0, Math.floor((this.now() - live.row.updated_at) / 1000)) : null;
      const agoText = lastErrorAgo !== null ? ` (last error ${lastErrorAgo}s ago: ${live.row.last_error ?? 'unknown error'})` : '';
      const retryTime = new Date(live.cooldownUntil).toISOString();
      throw new McpRegistryError(
        `MCP server "${live.row.name}" (${host}) is unreachable${agoText}. Not retrying until ${retryTime}.`,
        'unreachable',
        503,
      );
    }

    const client = this.createClient(live.row);
    try {
      await client.connect();
      const result = await client.callTool(parsed.toolName, args);
      // Tool call connected and responded — clear any failure streak and cooldown
      this.recordSuccess(parsed.registryId, live.tools ?? [], live.row.reported_instructions);
      return result;
    } catch (err) {
      const rawMessage = err instanceof McpClientError ? err.message : (err as Error).message;
      const host = extractHost(live.row.url);
      const formattedMessage = formatMcpErrorMessage(live.row.name, host, live.row.transport, rawMessage);
      this.recordFailure(parsed.registryId, formattedMessage);
      throw new McpRegistryError(formattedMessage, 'not_found', 502);
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

  /** `reportedInstructions` is refreshed on every successful connect the
      same way `tool_count`/`last_connected_at` already are — a server that
      starts (or stops) setting `initialize`'s `instructions` field takes
      effect on the next Test/Refresh, not only at creation. Never touches
      the user-authored `description` column. */
  private recordSuccess(id: string, tools: McpToolDescriptor[], reportedInstructions: string | null): void {
    const live = this.live.get(id);
    if (!live) return;
    const now = this.now();
    live.failureStreak = 0;
    live.cooldownUntil = null;
    this.db
      .prepare(
        'UPDATE mcp_registries SET tool_count = ?, last_connected_at = ?, last_error = NULL, ' +
          'reported_instructions = ?, updated_at = ? WHERE id = ?',
      )
      .run(tools.length, now, reportedInstructions, now, id);
    live.tools = tools;
    live.row = {
      ...live.row,
      tool_count: tools.length,
      last_connected_at: now,
      last_error: null,
      reported_instructions: reportedInstructions,
      updated_at: now,
    };
  }

  /** Deliberately does not clear the cached tool list or `tool_count` — a
      transient failure must not make every one of this registry's tools
      vanish from every agent's catalog mid-outage; it should instead fail
      loudly the next time something actually tries to call one. */
  private recordFailure(id: string, message: string): void {
    const live = this.live.get(id);
    if (!live) return;
    const now = this.now();
    const streak = (live.failureStreak ?? 0) + 1;
    live.failureStreak = streak;
    const cooldownMs = Math.min(30_000 * Math.pow(2, streak - 1), 300_000);
    live.cooldownUntil = now + cooldownMs;
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
            created_at, updated_at, description, reported_instructions)
         VALUES (@id, @name, @transport, @url, @auth_kind, @bearer_token_ciphertext, @header_name,
            @header_value_ciphertext, @enabled, @tool_count, @last_connected_at, @last_error,
            @created_at, @updated_at, @description, @reported_instructions)`,
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
                last_error = @last_error, updated_at = @updated_at, description = @description,
                reported_instructions = @reported_instructions
          WHERE id = @id`,
      )
      .run(row);
  }
}

function toSummary(row: Row, live?: LiveRegistry, now: number = Date.now()): McpRegistrySummary {
  const cooldown = live?.cooldownUntil && live.cooldownUntil > now ? live.cooldownUntil : null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    reportedInstructions: row.reported_instructions,
    transport: row.transport as McpTransportKind,
    url: row.url,
    authKind: row.auth_kind as McpAuthKind,
    headerName: row.header_name,
    enabled: row.enabled === 1,
    toolCount: row.tool_count,
    lastConnectedAt: row.last_connected_at,
    lastError: row.last_error,
    cooldownUntil: cooldown,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * PA-101: Extract only the host (hostname and optional port) from a URL.
 * Strictly avoids path, query string, fragment, or credentials.
 */
export function extractHost(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.host;
  } catch {
    const withoutScheme = urlStr.replace(/^[a-zA-Z]+:\/\//, '');
    const firstSlash = withoutScheme.indexOf('/');
    const hostAndPath = firstSlash >= 0 ? withoutScheme.slice(0, firstSlash) : withoutScheme;
    const firstQuestion = hostAndPath.indexOf('?');
    return firstQuestion >= 0 ? hostAndPath.slice(0, firstQuestion) : hostAndPath;
  }
}

/**
 * PA-101: Format MCP error message naming the registry, host, and transport,
 * while preventing leakage of tokens or secret headers.
 */
export function formatMcpErrorMessage(name: string, host: string, transport: string, rawMessage: string): string {
  const isTimeout = /timed? ?out/i.test(rawMessage);
  if (isTimeout) {
    if (/connect/i.test(rawMessage)) {
      return `MCP server "${name}" (${host}, ${transport}) timed out on connect: ${rawMessage}`;
    }
    if (/tools\/list/i.test(rawMessage)) {
      return `MCP server "${name}" (${host}, ${transport}) timed out on tools/list: ${rawMessage}`;
    }
    return `MCP server "${name}" (${host}, ${transport}) timed out on tools/call: ${rawMessage}`;
  }
  return `MCP server "${name}" (${host}, ${transport}): ${rawMessage}`;
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
