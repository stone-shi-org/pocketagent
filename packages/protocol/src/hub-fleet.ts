import { z } from 'zod';
import { HubHostId } from './hub-registry.js';
import type { McpScope } from './mcp-server.js';

/**
 * PA-134: the Fleet agent — a Hub-level MCP server (`/mcp` on the Hub) that a
 * coordinator Pocket Agent uses to find the right host and dispatch work to it.
 *
 * There is no LLM loop in the Hub. The chat runs as an ordinary Pocket Agent
 * on one backend (the *coordinator*), which reaches the Hub's `/mcp` through
 * an ordinary MCP registry; the Hub then calls each target backend's own
 * `/mcp` with a scoped `pam_` token minted for exactly this.
 */

/**
 * Prefix on a Hub-issued MCP token (the coordinator → Hub credential). Its own
 * prefix so the Hub's gate can tell it from anything else before touching the
 * database, and so a token in a config file is recognisable at a glance next
 * to a backend's `pam_` and a hub credential's `pah_`.
 */
export const HUB_MCP_TOKEN_SCHEME_PREFIX = 'phm_';

/** Characters of a `phm_` token kept in the clear for the UI. No reveal path. */
export const HUB_MCP_TOKEN_PREFIX_LENGTH = HUB_MCP_TOKEN_SCHEME_PREFIX.length + 8;

/**
 * Scopes of the `pam_` token the Hub mints on every bound host for dispatch.
 * Never `admin`: adding a project folder grants every agent on that machine
 * access to it, which no Fleet dispatch needs. The Hub verifies the minted
 * token reports exactly these and revokes it otherwise.
 */
export const HUB_FLEET_BACKEND_SCOPES: readonly McpScope[] = ['read', 'sessions', 'planner'];

/**
 * PA-135: Scopes of the separate `pam_` token the Hub mints on every bound
 * host for Tier 2 config changes. Held alongside the dispatch token and used
 * only by Tier 2 mutating tools so the PA-134 dispatch token never carries
 * `admin`.
 */
export const HUB_FLEET_ADMIN_SCOPES: readonly McpScope[] = ['admin'];

/** Label given to the separate per-host Tier 2 admin token on each backend. */
export const HUB_FLEET_BACKEND_ADMIN_TOKEN_LABEL = 'Hub fleet admin';

/** Display name of the Pocket Agent the Hub provisions on the coordinator. */
export const FLEET_AGENT_NAME = 'Fleet agent';

/** Name of the MCP registry, on the coordinator, pointing at the Hub's `/mcp`. */
export const FLEET_REGISTRY_NAME = 'PocketAgent Hub (fleet)';

/**
 * The Hub `/mcp` catalog. Fixed and in this order (MCP 2026-07-28 asks for a
 * deterministic `tools/list`). There is deliberately no approve tool and no
 * decision, `skipPermissions`, `force`, executable or argv field anywhere —
 * asserted by grepping the input schemas in `apps/hub/tests/fleet-mcp-tools.test.ts`.
 */
export const HUB_FLEET_TOOL_NAMES = [
  'list_hosts',
  'get_host_capabilities',
  'dispatch_pocket_task',
  'dispatch_coding_task',
  'wait',
  'list_pending_approvals',
  // PA-135 Tier 1: read-only fleet views (approval-exempt)
  'fleet_versions',
  'fleet_drain_state',
  'fleet_agent_status',
  'fleet_health',
  'fleet_attention',
  'fleet_usage',
  // PA-135 Tier 2: config changes (gated, audited, admin-scoped token)
  'update_webhook',
  'update_cron_job',
  'update_custom_claude_provider',
  'update_planner_settings',
  'provision_template',
] as const;
export type HubFleetToolName = (typeof HUB_FLEET_TOOL_NAMES)[number];

/** Whether this Hub holds a usable dispatch token for one host. */
export const HubFleetTokenState = z.enum([
  /** Minted, verified, decryptable. */
  'ok',
  /** Never minted (bound after the fleet was enabled and minting failed, say). */
  'missing',
  /** Stored but will not decrypt — `POCKETAGENT_SETTINGS_ENC_KEY` rotated. */
  'unreadable',
  /** The host has no hub credential, so nothing could be minted on it. */
  'unbound',
]);
export type HubFleetTokenState = z.infer<typeof HubFleetTokenState>;

export const HubFleetHostToken = z.object({
  hostId: z.string(),
  label: z.string(),
  state: HubFleetTokenState,
  /** First characters of the `pam_` token, for matching against the backend's own list. */
  tokenPrefix: z.string().nullable(),
  /** PA-135: state of the separate `admin`-scoped `pam_` token for Tier 2 config changes. */
  adminState: HubFleetTokenState.optional(),
  adminTokenPrefix: z.string().nullable().optional(),
});
export type HubFleetHostToken = z.infer<typeof HubFleetHostToken>;

export const HubFleetState = z.object({
  enabled: z.boolean(),
  coordinatorHostId: z.string().nullable(),
  coordinatorLabel: z.string().nullable(),
  /** The Hub address the coordinator dials, as the operator entered it. */
  hubUrl: z.string().nullable(),
  /** The Fleet agent's Pocket Agent id on the coordinator. */
  pocketAgentId: z.string().nullable(),
  /** The coordinator's MCP registry id pointing at this Hub. */
  registryId: z.string().nullable(),
  /** The coordinator's `phm_` token prefix; the token itself is never stored. */
  tokenPrefix: z.string().nullable(),
  /** From the health poller; null before the first probe. */
  coordinatorOnline: z.boolean().nullable(),
  hosts: z.array(HubFleetHostToken),
  updatedAt: z.number().nullable(),
});
export type HubFleetState = z.infer<typeof HubFleetState>;

/** One step of an enable / move / disable, as the dialog lists it. */
export const HubFleetStep = z.object({
  label: z.string(),
  ok: z.boolean(),
  message: z.string(),
});
export type HubFleetStep = z.infer<typeof HubFleetStep>;

export const HubFleetActionResponse = z.object({
  fleet: HubFleetState,
  steps: z.array(HubFleetStep),
});
export type HubFleetActionResponse = z.infer<typeof HubFleetActionResponse>;

/**
 * `hubUrl` is entered by the operator rather than derived: the Hub has no
 * reliable notion of its own external origin (the same problem an inbound
 * webhook's delivery URL has), and the address the *coordinator* reaches it
 * by — `http://hub:8788` inside one Compose network — is often not the one the
 * browser used. The Hub tests it before provisioning.
 */
export const HubFleetUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'Enter an http(s) address with no credentials in it.');

export const EnableHubFleetRequest = z.object({
  hostId: HubHostId,
  hubUrl: HubFleetUrl,
});
export type EnableHubFleetRequest = z.infer<typeof EnableHubFleetRequest>;

export const MoveHubFleetRequest = z.object({
  hostId: HubHostId,
  /** Defaults to the address the current coordinator used. */
  hubUrl: HubFleetUrl.optional(),
});
export type MoveHubFleetRequest = z.infer<typeof MoveHubFleetRequest>;

// ---- PA-169: Hub MCP client tokens ------------------------------------------

/**
 * Who a `phm_` token was minted for. `coordinator` is PA-134's: minted by the
 * Fleet-agent enable flow, every scope, every host, and its lifecycle is the
 * Fleet card's. `client` is PA-169's: minted by an operator on `HubPage` for a
 * coding agent (Claude Code, Codex, any MCP client), with its own scopes and an
 * optional host allowlist.
 */
export const HubMcpTokenKind = z.enum(['coordinator', 'client']);
export type HubMcpTokenKind = z.infer<typeof HubMcpTokenKind>;

/**
 * What a Hub MCP token may call. Deliberately not the backend's `McpScope`:
 * the Hub's catalog has three classes of tool, not four.
 *
 * - `read`: `list_hosts`, `get_host_capabilities`, `list_pending_approvals` and
 *   the read-only `fleet_*` views.
 * - `dispatch`: `dispatch_coding_task`, `dispatch_pocket_task`, `wait`.
 * - `admin`: PA-135's Tier 2 config tools. Off by default.
 */
export const HubMcpScope = z.enum(['read', 'dispatch', 'admin']);
export type HubMcpScope = z.infer<typeof HubMcpScope>;
export const HUB_MCP_SCOPES: readonly HubMcpScope[] = HubMcpScope.options;
export const DEFAULT_HUB_MCP_SCOPES: readonly HubMcpScope[] = ['read', 'dispatch'];

/** Upper bound on a token's host allowlist — the same bound the tools' `hosts` arrays carry. */
export const MAX_HUB_MCP_TOKEN_HOSTS = 50;

/** A host allowlist: `null` means every host behind this Hub. */
const HubMcpTokenHosts = z.array(HubHostId).min(1).max(MAX_HUB_MCP_TOKEN_HOSTS).nullable();

export const HubMcpClientToken = z.object({
  id: z.string(),
  label: z.string(),
  kind: HubMcpTokenKind,
  /** First `HUB_MCP_TOKEN_PREFIX_LENGTH` characters. There is no reveal path. */
  tokenPrefix: z.string(),
  scopes: z.array(HubMcpScope),
  /** `null` = every host. */
  hosts: z.array(z.string()).nullable(),
  createdAt: z.number(),
  lastSeenAt: z.number().nullable(),
});
export type HubMcpClientToken = z.infer<typeof HubMcpClientToken>;

export const HubMcpClientTokenListResponse = z.object({
  tokens: z.array(HubMcpClientToken),
  /** The endpoint path, so the UI never hardcodes it. */
  path: z.string(),
});
export type HubMcpClientTokenListResponse = z.infer<typeof HubMcpClientTokenListResponse>;

export const CreateHubMcpClientTokenRequest = z.object({
  label: z.string().trim().min(1).max(80),
  scopes: z.array(HubMcpScope).min(1).max(HUB_MCP_SCOPES.length),
  hosts: HubMcpTokenHosts.optional(),
});
export type CreateHubMcpClientTokenRequest = z.infer<typeof CreateHubMcpClientTokenRequest>;

export const CreateHubMcpClientTokenResponse = z.object({
  client: HubMcpClientToken,
  /** Shown exactly once. Only `sha256(token)` is stored. */
  token: z.string(),
});
export type CreateHubMcpClientTokenResponse = z.infer<typeof CreateHubMcpClientTokenResponse>;

/** Narrow (or widen) a client token. Takes effect on its next call. */
export const UpdateHubMcpClientTokenRequest = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    scopes: z.array(HubMcpScope).min(1).max(HUB_MCP_SCOPES.length).optional(),
    hosts: HubMcpTokenHosts.optional(),
  })
  .refine((v) => v.label !== undefined || v.scopes !== undefined || v.hosts !== undefined, 'Nothing to change.');
export type UpdateHubMcpClientTokenRequest = z.infer<typeof UpdateHubMcpClientTokenRequest>;

/**
 * The scope each Hub `/mcp` tool needs. A `Record` over the catalog, so adding
 * a tool without deciding its scope is a type error rather than a tool every
 * token can call.
 */
export const HUB_FLEET_TOOL_SCOPES: Readonly<Record<HubFleetToolName, HubMcpScope>> = {
  list_hosts: 'read',
  get_host_capabilities: 'read',
  dispatch_pocket_task: 'dispatch',
  dispatch_coding_task: 'dispatch',
  wait: 'dispatch',
  list_pending_approvals: 'read',
  fleet_versions: 'read',
  fleet_drain_state: 'read',
  fleet_agent_status: 'read',
  fleet_health: 'read',
  fleet_attention: 'read',
  fleet_usage: 'read',
  update_webhook: 'admin',
  update_cron_job: 'admin',
  update_custom_claude_provider: 'admin',
  update_planner_settings: 'admin',
  provision_template: 'admin',
};

// ---- PA-169 Phase 3: Fleet MCP auto-attach ------------------------------------

/**
 * The name a structured `claude` session sees the Hub's `/mcp` under, when a
 * human started it with "attach Fleet MCP" on. Its tools then read
 * `mcp__pocketagent-fleet__dispatch_coding_task` and so on.
 */
export const FLEET_MCP_SERVER_NAME = 'pocketagent-fleet';

/**
 * What a Hub hands a backend so its sessions can attach the Hub's `/mcp`: the
 * address and a Hub MCP client token minted for that backend. Sent with the
 * Hub's `pah_` credential to `POST /api/fleet-mcp`, stored as `secret-box`
 * ciphertext, never returned.
 */
export const SetFleetMcpAttachRequest = z.object({
  url: HubFleetUrl,
  token: z.string().min(16).max(200).startsWith(HUB_MCP_TOKEN_SCHEME_PREFIX),
});
export type SetFleetMcpAttachRequest = z.infer<typeof SetFleetMcpAttachRequest>;

/** A backend's attach state, for the composer's toggle. */
export const FleetMcpAttachState = z.object({
  /** A Hub URL and a decryptable token are both stored. */
  configured: z.boolean(),
  /** The `/mcp` URL sessions are given, or null. */
  url: z.string().nullable(),
  tokenPrefix: z.string().nullable(),
  /** Stored, but will not decrypt (`POCKETAGENT_SETTINGS_ENC_KEY` rotated). */
  unreadable: z.boolean(),
  updatedAt: z.number().nullable(),
});
export type FleetMcpAttachState = z.infer<typeof FleetMcpAttachState>;

/** One host's attach state as the Hub page shows it. */
export const HubMcpAttachHost = z.object({
  hostId: z.string(),
  label: z.string(),
  /** `attached` = the backend holds a token; `none` = not offered; `failed` = the last attempt did not land. */
  state: z.enum(['attached', 'none', 'failed']),
  tokenPrefix: z.string().nullable(),
  message: z.string().nullable(),
});
export type HubMcpAttachHost = z.infer<typeof HubMcpAttachHost>;

export const HubMcpAttachState = z.object({
  enabled: z.boolean(),
  /** The Hub address handed to every backend, as the operator entered it. */
  hubUrl: z.string().nullable(),
  hosts: z.array(HubMcpAttachHost),
});
export type HubMcpAttachState = z.infer<typeof HubMcpAttachState>;

export const EnableHubMcpAttachRequest = z.object({ hubUrl: HubFleetUrl });
export type EnableHubMcpAttachRequest = z.infer<typeof EnableHubMcpAttachRequest>;

/** The scopes of the token a Hub mints for a backend's sessions: never `admin`. */
export const HUB_MCP_ATTACH_SCOPES: readonly HubMcpScope[] = ['read', 'dispatch'];
