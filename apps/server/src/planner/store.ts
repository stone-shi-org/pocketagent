import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type {
  PlannerChat,
  PlannerLiveProvider,
  PlannerMemory,
  PlannerMemoryTier,
  PlannerProvider,
  PlannerProviderAuthMode,
  PlannerProviderEndpoint,
  PlannerProviderKind,
} from '@pocketagent/protocol';
import {
  ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE,
  CLAUDE_OAUTH_PROVIDER_DISCLOSURE,
  CODEX_OAUTH_PROVIDER_DISCLOSURE,
  DEFAULT_INLINE_EXTRACT_MAX_TOKENS,
  DEFAULT_INLINE_TEXT_MAX_BYTES,
  MAX_INLINE_EXTRACT_MAX_TOKENS,
  MAX_INLINE_TEXT_MAX_BYTES,
  PromptAttachment,
  PromptImage,
  defaultEndpointsForProviderKind,
  isApiKeyProviderKind,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  PLANNER_PROVIDERS_KEY_MIGRATED_KEY,
  readSetting,
  remapLegacyPlannerModelReferences,
  writeSetting,
} from '../db/index.js';
import {
  SETTINGS_ENC_KEY_VAR,
  decryptSecret,
  encryptSecret,
} from '../crypto/secret-box.js';
import { readCodexCliAuthJson } from './codex-oauth.js';
import type { PlannerWorkspaceRow, PlannerWorkspaceStore } from './workspaces.js';

// ---- planner_workspaces -----------------------------------------------------

/**
 * Tracks whether `PlannerWorkspaceRegistry.ensureDefaultWorkspace` has ever
 * run, the same way `workspaces_seeded` tracks the project-folder seed —
 * see that key's doc comment in `workspaces/index.ts` for why this has to be
 * a flag rather than "the table is empty".
 */
const PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY = 'planner_default_workspace_seeded';

interface PlannerWorkspaceDbRow {
  id: string;
  name: string;
  path: string;
  is_default: number;
  created_at: number;
  default_model_id: string | null;
  memory_enabled: number;
  last_consolidated_at: number | null;
  mcp_enabled: number;
  identity_prompt: string | null;
  live_provider: string | null;
}

/** Anything unrecognised reads as the default rather than throwing — a row
    written by a newer build must not stop an older one listing its agents. */
function toLiveProvider(raw: string | null): PlannerLiveProvider {
  return raw === 'gemini-live' ? 'gemini-live' : 'pipeline';
}

function fromDbRow(row: PlannerWorkspaceDbRow): PlannerWorkspaceRow {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    defaultModelId: row.default_model_id,
    memoryEnabled: row.memory_enabled === 1,
    lastConsolidatedAt: row.last_consolidated_at,
    mcpEnabled: row.mcp_enabled === 1,
    identityPrompt: row.identity_prompt,
    liveProvider: toLiveProvider(row.live_provider),
  };
}

export function createPlannerWorkspaceStore(db: Db): PlannerWorkspaceStore {
  return {
    list: () =>
      (
        db.prepare('SELECT * FROM planner_workspaces ORDER BY created_at').all() as PlannerWorkspaceDbRow[]
      ).map(fromDbRow),
    insert: (row) => {
      db.prepare(
        `INSERT INTO planner_workspaces
           (id, name, path, is_default, created_at, default_model_id, memory_enabled, last_consolidated_at, mcp_enabled, identity_prompt, live_provider)
         VALUES (@id, @name, @path, @isDefault, @createdAt, @defaultModelId, @memoryEnabled, @lastConsolidatedAt, @mcpEnabled, @identityPrompt, @liveProvider)`,
      ).run({
        id: row.id,
        name: row.name,
        path: row.path,
        isDefault: row.isDefault ? 1 : 0,
        createdAt: row.createdAt,
        defaultModelId: row.defaultModelId,
        memoryEnabled: row.memoryEnabled ? 1 : 0,
        lastConsolidatedAt: row.lastConsolidatedAt,
        mcpEnabled: row.mcpEnabled ? 1 : 0,
        identityPrompt: row.identityPrompt,
        liveProvider: row.liveProvider,
      });
    },
    delete: (id) => db.prepare('DELETE FROM planner_workspaces WHERE id = ?').run(id).changes > 0,
    rename: (id, name) => {
      db.prepare('UPDATE planner_workspaces SET name = ? WHERE id = ?').run(name, id);
    },
    setDefaultModelId: (id, modelId) => {
      db.prepare('UPDATE planner_workspaces SET default_model_id = ? WHERE id = ?').run(modelId, id);
    },
    setPath: (id, newPath) => {
      db.prepare('UPDATE planner_workspaces SET path = ? WHERE id = ?').run(newPath, id);
    },
    setMemoryEnabled: (id, enabled) => {
      db.prepare('UPDATE planner_workspaces SET memory_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    setMcpEnabled: (id, enabled) => {
      db.prepare('UPDATE planner_workspaces SET mcp_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },
    setIdentityPrompt: (id, identityPrompt) => {
      db.prepare('UPDATE planner_workspaces SET identity_prompt = ? WHERE id = ?').run(identityPrompt, id);
    },
    setLiveProvider: (id, provider) => {
      db.prepare('UPDATE planner_workspaces SET live_provider = ? WHERE id = ?').run(provider, id);
    },
    setLastConsolidatedAt: (id, at) => {
      db.prepare('UPDATE planner_workspaces SET last_consolidated_at = ? WHERE id = ?').run(at, id);
    },
    isSeeded: () => readSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY) !== null,
    markSeeded: () => writeSetting(db, PLANNER_DEFAULT_WORKSPACE_SEEDED_KEY, new Date().toISOString()),
  };
}

// ---- planner_agent_disabled_tools --------------------------------------------

/**
 * "Tools can be global, but each agent can select their own available
 * tools" (PA-6 round 4). Stores only what's *disabled* — see the migration's
 * own doc comment in `db/index.ts` for why that (rather than an allow-list)
 * is the correct default: every tool starts enabled for every agent,
 * including ones added to the catalog after an agent already existed.
 */
export function readDisabledToolNames(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT tool_name FROM planner_agent_disabled_tools WHERE workspace_id = ?')
    .all(workspaceId) as { tool_name: string }[];
  return new Set(rows.map((r) => r.tool_name));
}

/** Idempotent either way — disabling an already-disabled tool, or enabling
    an already-enabled one, is a no-op rather than an error. */
export function setToolEnabledForWorkspace(
  db: Db,
  workspaceId: string,
  toolName: string,
  enabled: boolean,
): void {
  if (enabled) {
    db.prepare(
      'DELETE FROM planner_agent_disabled_tools WHERE workspace_id = ? AND tool_name = ?',
    ).run(workspaceId, toolName);
  } else {
    db.prepare(
      `INSERT INTO planner_agent_disabled_tools (id, workspace_id, tool_name, created_at)
       VALUES (@id, @workspaceId, @toolName, @createdAt)
       ON CONFLICT (workspace_id, tool_name) DO NOTHING`,
    ).run({ id: crypto.randomUUID(), workspaceId, toolName, createdAt: Date.now() });
  }
}

// ---- planner_global_disabled_tools -------------------------------------------

/**
 * The coarser layer above `readDisabledToolNames`: a tool disabled here is
 * off for every agent, full stop — see the migration's own doc comment for
 * why this is a separate flat table rather than folded into the per-agent
 * one with a nullable `workspace_id`.
 */
export function readGlobalDisabledToolNames(db: Db): Set<string> {
  const rows = db.prepare('SELECT tool_name FROM planner_global_disabled_tools').all() as {
    tool_name: string;
  }[];
  return new Set(rows.map((r) => r.tool_name));
}

/** Idempotent either way, same as `setToolEnabledForWorkspace`. */
export function setToolEnabledGlobally(db: Db, toolName: string, enabled: boolean): void {
  if (enabled) {
    db.prepare('DELETE FROM planner_global_disabled_tools WHERE tool_name = ?').run(toolName);
  } else {
    db.prepare(
      `INSERT INTO planner_global_disabled_tools (tool_name, created_at)
       VALUES (?, ?)
       ON CONFLICT (tool_name) DO NOTHING`,
    ).run(toolName, Date.now());
  }
}

// ---- planner_agent_disabled_skills --------------------------------------------

/**
 * PA-38: the skills equivalent of `readDisabledToolNames`/
 * `setToolEnabledForWorkspace` — see the migration's own doc comment in
 * `db/index.ts` for why `skillId` is namespaced (`global:<slug>` or
 * `<workspaceId>:<slug>`) rather than a bare slug.
 */
export function readDisabledSkillNames(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT skill_id FROM planner_agent_disabled_skills WHERE workspace_id = ?')
    .all(workspaceId) as { skill_id: string }[];
  return new Set(rows.map((r) => r.skill_id));
}

/** Idempotent either way, same as `setToolEnabledForWorkspace`. */
export function setSkillEnabledForWorkspace(
  db: Db,
  workspaceId: string,
  skillId: string,
  enabled: boolean,
): void {
  if (enabled) {
    db.prepare(
      'DELETE FROM planner_agent_disabled_skills WHERE workspace_id = ? AND skill_id = ?',
    ).run(workspaceId, skillId);
  } else {
    db.prepare(
      `INSERT INTO planner_agent_disabled_skills (id, workspace_id, skill_id, created_at)
       VALUES (@id, @workspaceId, @skillId, @createdAt)
       ON CONFLICT (workspace_id, skill_id) DO NOTHING`,
    ).run({ id: crypto.randomUUID(), workspaceId, skillId, createdAt: Date.now() });
  }
}

// ---- planner_global_disabled_skills -------------------------------------------

/**
 * The coarser layer above `readDisabledSkillNames`: a skill disabled here is
 * off for every agent, full stop — see the migration's own doc comment for
 * why this is a separate flat table rather than folded into the per-agent
 * one with a nullable `workspace_id`. Mirrors `readGlobalDisabledToolNames`.
 */
export function readGlobalDisabledSkillNames(db: Db): Set<string> {
  const rows = db.prepare('SELECT skill_id FROM planner_global_disabled_skills').all() as {
    skill_id: string;
  }[];
  return new Set(rows.map((r) => r.skill_id));
}

/** Idempotent either way, same as `setToolEnabledGlobally`. */
export function setSkillEnabledGlobally(db: Db, skillId: string, enabled: boolean): void {
  if (enabled) {
    db.prepare('DELETE FROM planner_global_disabled_skills WHERE skill_id = ?').run(skillId);
  } else {
    db.prepare(
      `INSERT INTO planner_global_disabled_skills (skill_id, created_at)
       VALUES (?, ?)
       ON CONFLICT (skill_id) DO NOTHING`,
    ).run(skillId, Date.now());
  }
}

// ---- planner_agent_disabled_mcp_registries -----------------------------------

/**
 * PA-37 follow-up round two: the per-agent half of registry-level MCP
 * enablement — the same `readDisabledToolNames`/`setToolEnabledForWorkspace`
 * shape, one layer to the left (a whole registry, not a tool within one).
 * There is deliberately no `readGlobalDisabledMcpRegistries` counterpart:
 * the global half of this layer is `mcp_registries.enabled`, a column on
 * the registry's own row (`McpRegistryService`), not a separate deny-list —
 * a registry is a real row that already has a natural place for its own
 * global on/off state, unlike a bare tool or skill name.
 */
export function readAgentDisabledMcpRegistries(db: Db, workspaceId: string): Set<string> {
  const rows = db
    .prepare('SELECT registry_id FROM planner_agent_disabled_mcp_registries WHERE workspace_id = ?')
    .all(workspaceId) as { registry_id: string }[];
  return new Set(rows.map((r) => r.registry_id));
}

/** Idempotent either way, same as `setToolEnabledForWorkspace`. */
export function setMcpRegistryEnabledForWorkspace(
  db: Db,
  workspaceId: string,
  registryId: string,
  enabled: boolean,
): void {
  if (enabled) {
    db.prepare(
      'DELETE FROM planner_agent_disabled_mcp_registries WHERE workspace_id = ? AND registry_id = ?',
    ).run(workspaceId, registryId);
  } else {
    db.prepare(
      `INSERT INTO planner_agent_disabled_mcp_registries (id, workspace_id, registry_id, created_at)
       VALUES (@id, @workspaceId, @registryId, @createdAt)
       ON CONFLICT (workspace_id, registry_id) DO NOTHING`,
    ).run({ id: crypto.randomUUID(), workspaceId, registryId, createdAt: Date.now() });
  }
}

// ---- planner_providers (PA-148) ---------------------------------------------

export const DEFAULT_PLANNER_PROVIDER_ID = 'default';
export const DEFAULT_PLANNER_PROVIDER_LABEL = 'Default';
export const DEFAULT_CLAUDE_OAUTH_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_ANTIGRAVITY_OAUTH_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

export interface ClaudeOAuthStoredCredentials {
  mode: PlannerProviderAuthMode;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  accountEmail?: string | null;
  organizationName?: string | null;
  rateLimitTier?: string | null;
}

export interface CodexOAuthStoredCredentials {
  mode: 'device-code' | 'cli-readonly';
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  accountId?: string | null;
  planType?: string | null;
  accountEmail?: string | null;
  organizationName?: string | null;
}

export interface AntigravityOAuthStoredCredentials {
  mode: 'cli-import' | 'oauth';
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  /** Cached Code Assist project ID (`cloudaicompanionProject`) from `loadCodeAssist` / `onboardUser`. */
  projectId?: string | null;
  /** True when `loadCodeAssist` reported `gcpManaged: true`. */
  gcpManaged?: boolean | null;
  /** True when `x-goog-user-project` should be omitted on requests (e.g. `gcpManaged` or after a 403). */
  omitUserProjectHeader?: boolean | null;
  accountEmail?: string | null;
  planType?: string | null;
  rateLimitTier?: string | null;
}

export class PlannerProviderStoreError extends Error {
  override readonly name = 'PlannerProviderStoreError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'encryption_unavailable',
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface PlannerProviderRow {
  id: string;
  label: string;
  kind: PlannerProviderKind;
  baseUrl: string;
  endpoints: PlannerProviderEndpoint[];
  secretCiphertext: string | null;
  allowUnattended: boolean;
  sortOrder: number;
  createdAt: number;
  lastTestedAt: number | null;
  lastError: string | null;
}

interface PlannerProviderDbRow {
  id: string;
  label: string;
  kind: string;
  base_url: string;
  endpoints_json?: string | null;
  secret_ciphertext: string | null;
  allow_unattended: number;
  sort_order: number;
  created_at: number;
  last_tested_at: number | null;
  last_error: string | null;
}

function toProviderKind(raw: string | null | undefined): PlannerProviderKind {
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'opencode-zen') return 'opencode-zen';
  if (raw === 'opencode-go') return 'opencode-go';
  if (raw === 'claude-oauth') return 'claude-oauth';
  if (raw === 'codex-oauth') return 'codex-oauth';
  if (raw === 'antigravity-oauth') return 'antigravity-oauth';
  return 'openai-compatible';
}

function parseProviderEndpoints(
  rawJson: string | null | undefined,
  kind: PlannerProviderKind,
): PlannerProviderEndpoint[] {
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(
          (item): item is PlannerProviderEndpoint => item === 'openai' || item === 'anthropic',
        );
        if (valid.length > 0) {
          return Array.from(new Set(valid));
        }
      }
    } catch {
      // Fall through to defaults for kind
    }
  }
  return defaultEndpointsForProviderKind(kind);
}

/**
 * PA-154: Resolves the Anthropic Messages API base URL (`ANTHROPIC_BASE_URL` /
 * `<base>/v1/messages`) for a provider.
 * - `deepseek`: `https://api.deepseek.com` -> `https://api.deepseek.com/anthropic`
 * - `opencode-zen`: `https://opencode.ai/zen/v1` -> `https://opencode.ai/zen`
 * - `opencode-go`: `https://opencode.ai/zen/go/v1` -> `https://opencode.ai/zen/go`
 * - `openai-compatible`: strips trailing `/v1` or `/v1/messages` if present so
 *   both `AnthropicApiPlannerProvider` (which appends `/v1/messages`) and Claude
 *   Code (`ANTHROPIC_BASE_URL`, which appends `/v1/messages`) work whether the
 *   operator entered `https://api.anthropic.com`, `https://host/v1`, or `https://host`.
 */
export function resolveAnthropicBaseUrlForProvider(provider: {
  kind: PlannerProviderKind;
  baseUrl: string;
}): string {
  let url = provider.baseUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/v1/messages')) {
    url = url.slice(0, -'/v1/messages'.length);
  } else if (url.endsWith('/v1')) {
    url = url.slice(0, -'/v1'.length);
  }
  if (provider.kind === 'deepseek') {
    if (!url.endsWith('/anthropic')) {
      url = `${url || 'https://api.deepseek.com'}/anthropic`;
    }
    return url;
  }
  return url;
}

function providerFromDbRow(row: PlannerProviderDbRow): PlannerProviderRow {
  const kind = toProviderKind(row.kind);
  return {
    id: row.id,
    label: row.label,
    kind,
    baseUrl: row.base_url,
    endpoints: parseProviderEndpoints(row.endpoints_json, kind),
    secretCiphertext: row.secret_ciphertext ?? null,
    allowUnattended: row.allow_unattended === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    lastTestedAt: row.last_tested_at ?? null,
    lastError: row.last_error ?? null,
  };
}

export function decryptClaudeOAuthCredentials(
  provider: PlannerProviderRow,
  encKey: Buffer | undefined,
): { credentials: ClaudeOAuthStoredCredentials | null; error: string | null } {
  if (!provider.secretCiphertext) return { credentials: null, error: null };
  if (encKey === undefined) {
    return {
      credentials: null,
      error: `Set ${SETTINGS_ENC_KEY_VAR} to decrypt this provider's credentials.`,
    };
  }
  let raw: string;
  try {
    raw = decryptSecret(provider.secretCiphertext, encKey);
  } catch {
    return {
      credentials: null,
      error: `Could not decrypt this provider's credentials with the configured ${SETTINGS_ENC_KEY_VAR}. Re-enter or sign in again in Settings to repair it.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ClaudeOAuthStoredCredentials>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.accessToken === 'string' &&
      parsed.accessToken.trim().length > 0 &&
      (parsed.mode === 'setup-token' || parsed.mode === 'oauth')
    ) {
      return {
        credentials: {
          mode: parsed.mode,
          accessToken: parsed.accessToken.trim(),
          refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
          accountEmail: typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
          organizationName: typeof parsed.organizationName === 'string' ? parsed.organizationName : null,
          rateLimitTier: typeof parsed.rateLimitTier === 'string' ? parsed.rateLimitTier : null,
        },
        error: null,
      };
    }
  } catch {
    // Fall through if raw string is a bare token.
  }
  if (raw.trim().length > 0) {
    return {
      credentials: {
        mode: 'setup-token',
        accessToken: raw.trim(),
        refreshToken: null,
        expiresAt: null,
        accountEmail: null,
        organizationName: null,
        rateLimitTier: null,
      },
      error: null,
    };
  }
  return { credentials: null, error: 'Stored provider credentials are invalid.' };
}

export function encryptClaudeOAuthCredentials(
  creds: ClaudeOAuthStoredCredentials,
  encKey: Buffer | undefined,
): string {
  const normalized: ClaudeOAuthStoredCredentials = {
    mode: creds.mode,
    accessToken: creds.accessToken.trim(),
    refreshToken: creds.refreshToken ?? null,
    expiresAt: creds.expiresAt ?? null,
    accountEmail: creds.accountEmail ?? null,
    organizationName: creds.organizationName ?? null,
    rateLimitTier: creds.rateLimitTier ?? null,
  };
  return encryptSecret(JSON.stringify(normalized), requirePlannerProviderEncKey(encKey));
}

export function decryptCodexOAuthCredentials(
  provider: PlannerProviderRow,
  encKey: Buffer | undefined,
): { credentials: CodexOAuthStoredCredentials | null; error: string | null } {
  if (!provider.secretCiphertext) return { credentials: null, error: null };
  if (encKey === undefined) {
    return {
      credentials: null,
      error: `Set ${SETTINGS_ENC_KEY_VAR} to decrypt this provider's credentials.`,
    };
  }
  let raw: string;
  try {
    raw = decryptSecret(provider.secretCiphertext, encKey);
  } catch {
    return {
      credentials: null,
      error: `Could not decrypt this provider's credentials with the configured ${SETTINGS_ENC_KEY_VAR}. Re-enter or sign in again in Settings to repair it.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CodexOAuthStoredCredentials>;
    if (parsed && typeof parsed === 'object') {
      if (parsed.mode === 'cli-readonly') {
        return {
          credentials: {
            mode: 'cli-readonly',
            accessToken: null,
            refreshToken: null,
            expiresAt: null,
            accountId: null,
            planType: null,
            accountEmail: null,
            organizationName: null,
          },
          error: null,
        };
      }
      if (
        parsed.mode === 'device-code' &&
        typeof parsed.accessToken === 'string' &&
        parsed.accessToken.trim().length > 0
      ) {
        return {
          credentials: {
            mode: 'device-code',
            accessToken: parsed.accessToken.trim(),
            refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
            expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
            accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null,
            planType: typeof parsed.planType === 'string' ? parsed.planType : null,
            accountEmail: typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
            organizationName: typeof parsed.organizationName === 'string' ? parsed.organizationName : null,
          },
          error: null,
        };
      }
    }
  } catch {
    // Fall through
  }
  return { credentials: null, error: 'Stored Codex provider credentials are invalid.' };
}

export function encryptCodexOAuthCredentials(
  creds: CodexOAuthStoredCredentials,
  encKey: Buffer | undefined,
): string {
  const normalized: CodexOAuthStoredCredentials = {
    mode: creds.mode,
    accessToken: creds.accessToken ? creds.accessToken.trim() : null,
    refreshToken: creds.refreshToken ? creds.refreshToken.trim() : null,
    expiresAt: creds.expiresAt ?? null,
    accountId: creds.accountId ?? null,
    planType: creds.planType ?? null,
    accountEmail: creds.accountEmail ?? null,
    organizationName: creds.organizationName ?? null,
  };
  return encryptSecret(JSON.stringify(normalized), requirePlannerProviderEncKey(encKey));
}

export function decryptAntigravityOAuthCredentials(
  provider: PlannerProviderRow,
  encKey: Buffer | undefined,
): { credentials: AntigravityOAuthStoredCredentials | null; error: string | null } {
  if (!provider.secretCiphertext) return { credentials: null, error: null };
  if (encKey === undefined) {
    return {
      credentials: null,
      error: `Set ${SETTINGS_ENC_KEY_VAR} to decrypt this provider's credentials.`,
    };
  }
  let raw: string;
  try {
    raw = decryptSecret(provider.secretCiphertext, encKey);
  } catch {
    return {
      credentials: null,
      error: `Could not decrypt this provider's credentials with the configured ${SETTINGS_ENC_KEY_VAR}. Re-import or sign in again in Settings to repair it.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AntigravityOAuthStoredCredentials>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed.mode === 'cli-import' || parsed.mode === 'oauth')
    ) {
      return {
        credentials: {
          mode: parsed.mode,
          accessToken: typeof parsed.accessToken === 'string' && parsed.accessToken.trim() ? parsed.accessToken.trim() : null,
          refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim() ? parsed.refreshToken.trim() : null,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null,
          projectId: typeof parsed.projectId === 'string' && parsed.projectId.trim() ? parsed.projectId.trim() : null,
          gcpManaged: typeof parsed.gcpManaged === 'boolean' ? parsed.gcpManaged : null,
          omitUserProjectHeader: typeof parsed.omitUserProjectHeader === 'boolean' ? parsed.omitUserProjectHeader : null,
          accountEmail: typeof parsed.accountEmail === 'string' ? parsed.accountEmail : null,
          planType: typeof parsed.planType === 'string' ? parsed.planType : null,
          rateLimitTier: typeof parsed.rateLimitTier === 'string' ? parsed.rateLimitTier : null,
        },
        error: null,
      };
    }
  } catch {
    // Fall through
  }
  return { credentials: null, error: 'Stored Antigravity provider credentials are invalid.' };
}

export function encryptAntigravityOAuthCredentials(
  creds: AntigravityOAuthStoredCredentials,
  encKey: Buffer | undefined,
): string {
  const normalized: AntigravityOAuthStoredCredentials = {
    mode: creds.mode,
    accessToken: creds.accessToken ? creds.accessToken.trim() : null,
    refreshToken: creds.refreshToken ? creds.refreshToken.trim() : null,
    expiresAt: creds.expiresAt ?? null,
    projectId: creds.projectId ? creds.projectId.trim() : null,
    gcpManaged: creds.gcpManaged ?? null,
    omitUserProjectHeader: creds.omitUserProjectHeader ?? null,
    accountEmail: creds.accountEmail ?? null,
    planType: creds.planType ?? null,
    rateLimitTier: creds.rateLimitTier ?? null,
  };
  return encryptSecret(JSON.stringify(normalized), requirePlannerProviderEncKey(encKey));
}

export function decryptPlannerProviderSecret(
  provider: PlannerProviderRow,
  encKey: Buffer | undefined,
): { apiKey: string | null; error: string | null } {
  if (provider.kind === 'claude-oauth') {
    const { credentials, error } = decryptClaudeOAuthCredentials(provider, encKey);
    return { apiKey: credentials?.accessToken ?? null, error };
  }
  if (provider.kind === 'codex-oauth') {
    const { credentials, error } = decryptCodexOAuthCredentials(provider, encKey);
    if (error !== null) return { apiKey: null, error };
    if (credentials?.mode === 'cli-readonly') {
      const cli = readCodexCliAuthJson();
      if (cli.error) return { apiKey: null, error: cli.error };
      return { apiKey: cli.accessToken, error: null };
    }
    return { apiKey: credentials?.accessToken ?? null, error: null };
  }
  if (provider.kind === 'antigravity-oauth') {
    const { credentials, error } = decryptAntigravityOAuthCredentials(provider, encKey);
    return { apiKey: credentials?.accessToken ?? credentials?.refreshToken ?? null, error };
  }
  if (!provider.secretCiphertext) return { apiKey: null, error: null };
  if (encKey === undefined) {
    return {
      apiKey: null,
      error: `Set ${SETTINGS_ENC_KEY_VAR} to decrypt this provider's API key.`,
    };
  }
  try {
    return { apiKey: decryptSecret(provider.secretCiphertext, encKey), error: null };
  } catch {
    return {
      apiKey: null,
      error: `Could not decrypt this provider's API key with the configured ${SETTINGS_ENC_KEY_VAR}. Re-enter the key in Settings to repair it.`,
    };
  }
}

export function encryptPlannerProviderSecret(apiKey: string, encKey: Buffer | undefined): string {
  return encryptSecret(apiKey, requirePlannerProviderEncKey(encKey));
}

export function toPlannerProviderDto(row: PlannerProviderRow, encKey?: Buffer): PlannerProvider {
  if (row.kind === 'claude-oauth') {
    const { credentials, error } = row.secretCiphertext
      ? decryptClaudeOAuthCredentials(row, encKey)
      : { credentials: null, error: null };
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.baseUrl,
      endpoints: row.endpoints,
      hasApiKey: row.secretCiphertext !== null && row.secretCiphertext.length > 0,
      keyUnreadable: error !== null,
      allowUnattended: row.allowUnattended,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      lastTestedAt: row.lastTestedAt,
      lastError: row.lastError ?? error,
      authMode: credentials?.mode ?? null,
      accountEmail: credentials?.accountEmail ?? null,
      organizationName: credentials?.organizationName ?? null,
      rateLimitTier: credentials?.rateLimitTier ?? null,
      tokenExpiresAt: credentials?.expiresAt ?? null,
      providerDisclosure: CLAUDE_OAUTH_PROVIDER_DISCLOSURE,
    };
  }
  if (row.kind === 'codex-oauth') {
    const { credentials, error } = row.secretCiphertext
      ? decryptCodexOAuthCredentials(row, encKey)
      : { credentials: null, error: null };
    if (credentials?.mode === 'cli-readonly') {
      const cli = readCodexCliAuthJson();
      return {
        id: row.id,
        label: row.label,
        kind: row.kind,
        baseUrl: row.baseUrl,
        endpoints: row.endpoints,
        hasApiKey: Boolean(cli.accessToken && !cli.expired),
        keyUnreadable: false,
        allowUnattended: row.allowUnattended,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt,
        lastTestedAt: row.lastTestedAt,
        lastError: row.lastError ?? cli.error,
        authMode: 'cli-readonly',
        accountEmail: cli.accountEmail,
        accountId: cli.accountId,
        planType: cli.planType,
        organizationName: cli.organizationName,
        rateLimitTier: cli.planType,
        tokenExpiresAt: cli.expiresAt,
        providerDisclosure: CODEX_OAUTH_PROVIDER_DISCLOSURE,
      };
    }
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.baseUrl,
      endpoints: row.endpoints,
      hasApiKey: Boolean(credentials?.accessToken),
      keyUnreadable: error !== null,
      allowUnattended: row.allowUnattended,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      lastTestedAt: row.lastTestedAt,
      lastError: row.lastError ?? error,
      authMode: credentials?.mode ?? null,
      accountEmail: credentials?.accountEmail ?? null,
      accountId: credentials?.accountId ?? null,
      planType: credentials?.planType ?? null,
      organizationName: credentials?.organizationName ?? null,
      rateLimitTier: credentials?.planType ?? null,
      tokenExpiresAt: credentials?.expiresAt ?? null,
      providerDisclosure: CODEX_OAUTH_PROVIDER_DISCLOSURE,
    };
  }
  if (row.kind === 'antigravity-oauth') {
    const { credentials, error } = row.secretCiphertext
      ? decryptAntigravityOAuthCredentials(row, encKey)
      : { credentials: null, error: null };
    return {
      id: row.id,
      label: row.label,
      kind: row.kind,
      baseUrl: row.baseUrl,
      endpoints: row.endpoints,
      hasApiKey: Boolean(credentials?.accessToken || credentials?.refreshToken),
      keyUnreadable: error !== null,
      allowUnattended: row.allowUnattended,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      lastTestedAt: row.lastTestedAt,
      lastError: row.lastError ?? error,
      authMode: credentials?.mode ?? null,
      accountEmail: credentials?.accountEmail ?? null,
      accountId: credentials?.projectId ?? null,
      planType: credentials?.planType ?? null,
      organizationName: null,
      rateLimitTier: credentials?.rateLimitTier ?? credentials?.planType ?? null,
      tokenExpiresAt: credentials?.expiresAt ?? null,
      providerDisclosure: ANTIGRAVITY_OAUTH_PROVIDER_DISCLOSURE,
    };
  }
  const decryptStatus = row.secretCiphertext
    ? decryptPlannerProviderSecret(row, encKey)
    : { apiKey: null, error: null };
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    baseUrl: row.baseUrl,
    endpoints: row.endpoints,
    hasApiKey: row.secretCiphertext !== null && row.secretCiphertext.length > 0,
    keyUnreadable: decryptStatus.error !== null,
    allowUnattended: row.allowUnattended,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    lastTestedAt: row.lastTestedAt,
    lastError: row.lastError ?? decryptStatus.error,
    authMode: null,
    accountEmail: null,
    accountId: null,
    planType: null,
    organizationName: null,
    rateLimitTier: null,
    tokenExpiresAt: null,
    providerDisclosure: null,
  };
}

export function readPlannerProviders(db: Db): PlannerProviderRow[] {
  return (
    db.prepare('SELECT * FROM planner_providers ORDER BY sort_order, created_at').all() as PlannerProviderDbRow[]
  ).map(providerFromDbRow);
}

export function readPlannerProvider(db: Db, id: string): PlannerProviderRow | null {
  const row = db.prepare('SELECT * FROM planner_providers WHERE id = ?').get(id) as
    | PlannerProviderDbRow
    | undefined;
  return row ? providerFromDbRow(row) : null;
}

export function readDefaultOrFirstPlannerProvider(db: Db): PlannerProviderRow | null {
  return readPlannerProvider(db, DEFAULT_PLANNER_PROVIDER_ID) ?? readPlannerProviders(db)[0] ?? null;
}

export function nextPlannerProviderSortOrder(db: Db): number {
  const row = db.prepare('SELECT MAX(sort_order) as maxOrder FROM planner_providers').get() as {
    maxOrder: number | null;
  };
  return (row.maxOrder ?? -1) + 1;
}

export function insertPlannerProvider(
  db: Db,
  row: Omit<
    PlannerProviderRow,
    'kind' | 'endpoints' | 'allowUnattended' | 'lastTestedAt' | 'lastError'
  > &
    Partial<
      Pick<
        PlannerProviderRow,
        'kind' | 'endpoints' | 'allowUnattended' | 'lastTestedAt' | 'lastError'
      >
    >,
): PlannerProviderRow {
  const kind = row.kind ?? 'openai-compatible';
  const endpoints =
    row.endpoints && row.endpoints.length > 0
      ? Array.from(new Set(row.endpoints))
      : defaultEndpointsForProviderKind(kind);
  const full: PlannerProviderRow = {
    id: row.id,
    label: row.label,
    kind,
    baseUrl: row.baseUrl,
    endpoints,
    secretCiphertext: row.secretCiphertext ?? null,
    allowUnattended: row.allowUnattended ?? false,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    lastTestedAt: row.lastTestedAt ?? null,
    lastError: row.lastError ?? null,
  };
  db.prepare(
    `INSERT INTO planner_providers
       (id, label, kind, base_url, endpoints_json, secret_ciphertext, allow_unattended, sort_order, created_at, last_tested_at, last_error)
     VALUES (@id, @label, @kind, @baseUrl, @endpointsJson, @secretCiphertext, @allowUnattended, @sortOrder, @createdAt, @lastTestedAt, @lastError)`,
  ).run({
    id: full.id,
    label: full.label,
    kind: full.kind,
    baseUrl: full.baseUrl,
    endpointsJson: JSON.stringify(full.endpoints),
    secretCiphertext: full.secretCiphertext,
    allowUnattended: full.allowUnattended ? 1 : 0,
    sortOrder: full.sortOrder,
    createdAt: full.createdAt,
    lastTestedAt: full.lastTestedAt,
    lastError: full.lastError,
  });
  return full;
}

export function ensureDefaultPlannerProvider(db: Db, baseUrl = ''): PlannerProviderRow {
  const existing = readDefaultOrFirstPlannerProvider(db);
  if (existing) return existing;
  return insertPlannerProvider(db, {
    id: DEFAULT_PLANNER_PROVIDER_ID,
    label: DEFAULT_PLANNER_PROVIDER_LABEL,
    kind: 'openai-compatible',
    baseUrl,
    secretCiphertext: null,
    allowUnattended: false,
    sortOrder: 0,
    createdAt: Date.now(),
  });
}

export function updatePlannerProvider(
  db: Db,
  id: string,
  patch: {
    label?: string;
    kind?: PlannerProviderKind;
    baseUrl?: string;
    endpoints?: PlannerProviderEndpoint[];
    secretCiphertext?: string | null;
    allowUnattended?: boolean;
    sortOrder?: number;
    lastTestedAt?: number | null;
    lastError?: string | null;
  },
): PlannerProviderRow | null {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.label !== undefined) {
    assignments.push('label = @label');
    params.label = patch.label;
  }
  if (patch.kind !== undefined) {
    assignments.push('kind = @kind');
    params.kind = patch.kind;
  }
  if (patch.baseUrl !== undefined) {
    assignments.push('base_url = @baseUrl');
    params.baseUrl = patch.baseUrl;
  }
  if (patch.endpoints !== undefined) {
    assignments.push('endpoints_json = @endpointsJson');
    params.endpointsJson = JSON.stringify(Array.from(new Set(patch.endpoints)));
  }
  if (patch.secretCiphertext !== undefined) {
    assignments.push('secret_ciphertext = @secretCiphertext');
    params.secretCiphertext = patch.secretCiphertext;
  }
  if (patch.allowUnattended !== undefined) {
    assignments.push('allow_unattended = @allowUnattended');
    params.allowUnattended = patch.allowUnattended ? 1 : 0;
  }
  if (patch.sortOrder !== undefined) {
    assignments.push('sort_order = @sortOrder');
    params.sortOrder = patch.sortOrder;
  }
  if (patch.lastTestedAt !== undefined) {
    assignments.push('last_tested_at = @lastTestedAt');
    params.lastTestedAt = patch.lastTestedAt;
  }
  if (patch.lastError !== undefined) {
    assignments.push('last_error = @lastError');
    params.lastError = patch.lastError;
  }
  if (assignments.length === 0) return readPlannerProvider(db, id);
  const res = db.prepare(`UPDATE planner_providers SET ${assignments.join(', ')} WHERE id = @id`).run(params);
  if (res.changes === 0) return null;
  return readPlannerProvider(db, id);
}

export function recordPlannerProviderTestResult(
  db: Db,
  id: string,
  result: { ok: boolean; error?: string | null; at?: number },
): PlannerProviderRow | null {
  return updatePlannerProvider(db, id, {
    lastTestedAt: result.at ?? Date.now(),
    lastError: result.ok ? null : (result.error ?? 'Connection failed.'),
  });
}

export function deletePlannerProvider(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_providers WHERE id = ?').run(id).changes > 0;
}

/**
 * PA-158: Reorders providers by assigning sequential sort_order (0..n-1).
 * Any existing providers not listed in `providerIds` are preserved after the
 * specified IDs in their existing relative order.
 */
export function reorderPlannerProviders(
  db: Db,
  providerIds: readonly string[],
): PlannerProviderRow[] {
  const existing = readPlannerProviders(db);
  const existingMap = new Map(existing.map((p) => [p.id, p]));

  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of providerIds) {
    if (existingMap.has(id) && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  for (const p of existing) {
    if (!seen.has(p.id)) {
      orderedIds.push(p.id);
    }
  }

  const updateStmt = db.prepare('UPDATE planner_providers SET sort_order = ? WHERE id = ?');
  const runTx = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      updateStmt.run(i, orderedIds[i]);
    }
  });
  runTx();

  return readPlannerProviders(db);
}

export function requirePlannerProviderEncKey(encKey: Buffer | undefined): Buffer {
  if (encKey === undefined) {
    throw new PlannerProviderStoreError(
      `Set ${SETTINGS_ENC_KEY_VAR} to store Pocket Agent provider API keys.`,
      'encryption_unavailable',
      409,
    );
  }
  return encKey;
}

/**
 * PA-148: One-time migration of legacy `planner_llm_base_url` / `planner_llm_api_key`
 * settings into the Default `planner_providers` row (`id = 'default'`), plus
 * remapping bare `model_id` references across chats, workspaces, settings,
 * cron jobs, and webhooks.
 *
 * Follows PA-28's deferral rule when `planner_llm_api_key` is non-empty and
 * `POCKETAGENT_SETTINGS_ENC_KEY` (`encKey`) is not set: never writes plaintext
 * into `planner_providers.secret_ciphertext`, never fails boot, and leaves
 * `PLANNER_PROVIDERS_KEY_MIGRATED_KEY` unset so the next boot with a key
 * finishes encrypting and clearing the legacy setting.
 */
export function migrateLegacyPlannerSettings(
  db: Db,
  encKey: Buffer | undefined,
  logger?: FastifyBaseLogger,
): boolean {
  remapLegacyPlannerModelReferences(db);

  if (readSetting(db, PLANNER_PROVIDERS_KEY_MIGRATED_KEY) !== null) return false;

  const legacyBaseUrl = (readSetting(db, PLANNER_LLM_BASE_URL_KEY) ?? '').trim();
  const legacyApiKey = (readSetting(db, PLANNER_LLM_API_KEY_KEY) ?? '').trim();
  const existingDefault = readPlannerProvider(db, DEFAULT_PLANNER_PROVIDER_ID);

  if (!existingDefault && legacyBaseUrl.length === 0 && legacyApiKey.length === 0) {
    return false;
  }

  let provider = existingDefault;
  if (!provider) {
    provider = insertPlannerProvider(db, {
      id: DEFAULT_PLANNER_PROVIDER_ID,
      label: DEFAULT_PLANNER_PROVIDER_LABEL,
      kind: 'openai-compatible',
      baseUrl: legacyBaseUrl,
      secretCiphertext: null,
      allowUnattended: false,
      sortOrder: 0,
      createdAt: Date.now(),
    });
  } else if (!provider.baseUrl && legacyBaseUrl.length > 0) {
    provider = updatePlannerProvider(db, provider.id, { baseUrl: legacyBaseUrl }) ?? provider;
  }

  if (legacyApiKey.length > 0) {
    if (encKey === undefined) {
      logger?.warn(
        `${PLANNER_LLM_API_KEY_KEY} is set in settings, but ${SETTINGS_ENC_KEY_VAR} is not configured; ` +
          'deferring API key migration into planner_providers until a key is set.',
      );
      return false;
    }
    if (!provider.secretCiphertext) {
      updatePlannerProvider(db, provider.id, {
        secretCiphertext: encryptSecret(legacyApiKey, encKey),
      });
    }
    writeSetting(db, PLANNER_LLM_API_KEY_KEY, '');
  }

  if (legacyBaseUrl.length > 0) {
    writeSetting(db, PLANNER_LLM_BASE_URL_KEY, '');
  }
  writeSetting(db, PLANNER_PROVIDERS_KEY_MIGRATED_KEY, String(Date.now()));
  return true;
}

// ---- planner_models ---------------------------------------------------------

export interface PlannerModelRow {
  id: string;
  providerId: string;
  modelId: string;
  label: string;
  sortOrder: number;
  createdAt: number;
  supportsEffort: boolean;
  defaultEffort: string | null;
  /** PA-121: tokens; `null` = not set, see `planner/context-budget.ts`. */
  contextWindow: number | null;
  maxOutputTokens: number | null;
  /** PA-122: `null` = auto, see `planner/prompt-cache.ts`. */
  promptCaching: boolean | null;
  /** PA-122: USD per million tokens; `null` = not set, see `planner/cost.ts`. */
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  cacheReadPricePerMTok: number | null;
  cacheWritePricePerMTok: number | null;
  /** PA-122: `null` = auto, see `plannerModelSupportsImages`. */
  supportsImages: boolean | null;
  /** PA-137: `null` = off — see `PlannerModel.supportsPdf`. */
  supportsPdf: boolean | null;
}

/** PA-122: the price columns, camelCase → column name. */
const PRICE_COLUMNS = {
  inputPricePerMTok: 'price_input',
  outputPricePerMTok: 'price_output',
  cacheReadPricePerMTok: 'price_cache_read',
  cacheWritePricePerMTok: 'price_cache_write',
} as const;
type PriceField = keyof typeof PRICE_COLUMNS;

/** The columns a caller may leave out when adding a row — each defaults to
    "not set". */
type OptionalModelColumns =
  | 'providerId'
  | 'contextWindow'
  | 'maxOutputTokens'
  | 'promptCaching'
  | 'supportsImages'
  | 'supportsPdf'
  | PriceField;

function nullableBool(value: number | null | undefined): boolean | null {
  return value === null || value === undefined ? null : value !== 0;
}

function boolParam(value: boolean | null | undefined): number | null {
  return value === null || value === undefined ? null : value ? 1 : 0;
}

interface PlannerModelDbRow {
  id: string;
  provider_id: string;
  model_id: string;
  label: string;
  sort_order: number;
  created_at: number;
  supports_effort?: number | null;
  default_effort?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  prompt_caching?: number | null;
  price_input?: number | null;
  price_output?: number | null;
  price_cache_read?: number | null;
  price_cache_write?: number | null;
  supports_images?: number | null;
  supports_pdf?: number | null;
}

function modelFromDbRow(row: PlannerModelDbRow): PlannerModelRow {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    label: row.label,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    supportsEffort: row.supports_effort !== 0,
    defaultEffort: row.default_effort ?? null,
    contextWindow: row.context_window ?? null,
    maxOutputTokens: row.max_output_tokens ?? null,
    promptCaching: nullableBool(row.prompt_caching),
    inputPricePerMTok: row.price_input ?? null,
    outputPricePerMTok: row.price_output ?? null,
    cacheReadPricePerMTok: row.price_cache_read ?? null,
    cacheWritePricePerMTok: row.price_cache_write ?? null,
    supportsImages: nullableBool(row.supports_images),
    supportsPdf: nullableBool(row.supports_pdf),
  };
}

export function readPlannerModels(db: Db, providerId?: string): PlannerModelRow[] {
  if (providerId !== undefined) {
    return (
      db
        .prepare('SELECT * FROM planner_models WHERE provider_id = ? ORDER BY sort_order, created_at')
        .all(providerId) as PlannerModelDbRow[]
    ).map(modelFromDbRow);
  }
  return (
    db.prepare('SELECT * FROM planner_models ORDER BY sort_order, created_at').all() as PlannerModelDbRow[]
  ).map(modelFromDbRow);
}

export function readPlannerModelById(db: Db, id: string): PlannerModelRow | null {
  const row = db.prepare('SELECT * FROM planner_models WHERE id = ?').get(id) as
    | PlannerModelDbRow
    | undefined;
  return row ? modelFromDbRow(row) : null;
}

export function insertPlannerModel(
  db: Db,
  row: Omit<PlannerModelRow, OptionalModelColumns> & Partial<Pick<PlannerModelRow, OptionalModelColumns>>,
): PlannerModelRow {
  const providerId = row.providerId ?? ensureDefaultPlannerProvider(db).id;
  db.prepare(
    `INSERT INTO planner_models
       (id, provider_id, model_id, label, sort_order, created_at, supports_effort, default_effort, context_window, max_output_tokens,
        prompt_caching, price_input, price_output, price_cache_read, price_cache_write, supports_images, supports_pdf)
     VALUES (@id, @providerId, @modelId, @label, @sortOrder, @createdAt, @supportsEffort, @defaultEffort, @contextWindow, @maxOutputTokens,
        @promptCaching, @inputPricePerMTok, @outputPricePerMTok, @cacheReadPricePerMTok, @cacheWritePricePerMTok,
        @supportsImages, @supportsPdf)`,
  ).run({
    id: row.id,
    providerId,
    modelId: row.modelId,
    label: row.label,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    supportsEffort: row.supportsEffort !== false ? 1 : 0,
    defaultEffort: row.defaultEffort ?? null,
    contextWindow: row.contextWindow ?? null,
    maxOutputTokens: row.maxOutputTokens ?? null,
    promptCaching: boolParam(row.promptCaching),
    inputPricePerMTok: row.inputPricePerMTok ?? null,
    outputPricePerMTok: row.outputPricePerMTok ?? null,
    cacheReadPricePerMTok: row.cacheReadPricePerMTok ?? null,
    cacheWritePricePerMTok: row.cacheWritePricePerMTok ?? null,
    supportsImages: boolParam(row.supportsImages),
    supportsPdf: boolParam(row.supportsPdf),
  });
  return readPlannerModelById(db, row.id)!;
}

/** PA-121: the catalog row for a model id, if one exists — what the loop
    reads a context window from. First by sort order when an id is listed
    twice. Also accepts a `planner_models.id` UUID (PA-148). */
export function readPlannerModelByModelId(
  db: Db,
  modelId: string,
  providerId?: string,
): PlannerModelRow | null {
  const byId = readPlannerModelById(db, modelId);
  if (byId && (providerId === undefined || byId.providerId === providerId)) return byId;
  if (providerId !== undefined) {
    const row = db
      .prepare(
        'SELECT * FROM planner_models WHERE provider_id = ? AND model_id = ? ORDER BY sort_order, created_at LIMIT 1',
      )
      .get(providerId, modelId) as PlannerModelDbRow | undefined;
    return row ? modelFromDbRow(row) : null;
  }
  const row = db
    .prepare('SELECT * FROM planner_models WHERE model_id = ? ORDER BY sort_order, created_at LIMIT 1')
    .get(modelId) as PlannerModelDbRow | undefined;
  return row ? modelFromDbRow(row) : null;
}

/**
 * PA-148: Resolves a model reference (`planner_models.id` row UUID, or a
 * legacy/uncatalogued bare `model_id` string) into its catalog row (if any),
 * its owning `PlannerProviderRow` (or the default/first provider for an
 * unmatched bare string), and the upstream `modelId` string sent to the
 * provider API.
 */
export function resolvePlannerModel(
  db: Db,
  ref: string | null | undefined,
): { row: PlannerModelRow | null; provider: PlannerProviderRow | null; modelId: string } {
  const trimmed = (ref ?? '').trim();
  if (!trimmed) {
    return {
      row: null,
      provider: readDefaultOrFirstPlannerProvider(db),
      modelId: '',
    };
  }
  const byId = readPlannerModelById(db, trimmed);
  if (byId) {
    return {
      row: byId,
      provider: readPlannerProvider(db, byId.providerId),
      modelId: byId.modelId,
    };
  }
  const byModelId = readPlannerModelByModelId(db, trimmed);
  if (byModelId) {
    return {
      row: byModelId,
      provider: readPlannerProvider(db, byModelId.providerId),
      modelId: byModelId.modelId,
    };
  }
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx > 0) {
    const candidateProviderId = trimmed.slice(0, slashIdx);
    const candidateModelId = trimmed.slice(slashIdx + 1);
    const provider = readPlannerProvider(db, candidateProviderId);
    if (provider && candidateModelId.length > 0) {
      const scopedRow = readPlannerModelByModelId(db, candidateModelId, provider.id);
      return {
        row: scopedRow,
        provider,
        modelId: scopedRow?.modelId ?? candidateModelId,
      };
    }
  }
  return {
    row: null,
    provider: readDefaultOrFirstPlannerProvider(db),
    modelId: trimmed,
  };
}

/**
 * PA-149: Checks whether the model a Pocket Agent unattended run (cron job,
 * inbound webhook, or MCP-started chat/turn) would use belongs to a
 * subscription provider (`kind !== 'openai-compatible'`) with
 * `allowUnattended === false`. Returns a clear human-readable refusal reason
 * when blocked, or `null` when allowed.
 */
export function unattendedPlannerModelProblem(
  db: Db,
  opts: {
    modelId?: string | null;
    workspaceDefaultModelId?: string | null;
    noun: 'scheduled' | 'triggered by a webhook' | 'started over MCP';
  },
): string | null {
  const candidate =
    opts.modelId ??
    opts.workspaceDefaultModelId ??
    readSetting(db, PLANNER_LAST_MODEL_ID_KEY) ??
    null;
  const resolved = resolvePlannerModel(db, candidate);
  if (
    resolved.provider &&
    !isApiKeyProviderKind(resolved.provider.kind) &&
    !resolved.provider.allowUnattended
  ) {
    return (
      `Pocket Agent provider "${resolved.provider.label}" cannot be ${opts.noun}: ` +
      'subscription providers have unattended use disabled by default. Enable "Allow unattended use" on this provider in Settings → Providers & Models, or choose a model from an API-key provider.'
    );
  }
  return null;
}

export function updatePlannerModel(
  db: Db,
  id: string,
  patch: {
    label?: string;
    supportsEffort?: boolean;
    defaultEffort?: string | null;
    contextWindow?: number | null;
    maxOutputTokens?: number | null;
    promptCaching?: boolean | null;
    supportsImages?: boolean | null;
    supportsPdf?: boolean | null;
  } & Partial<Record<PriceField, number | null>>,
): PlannerModelRow | null {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.label !== undefined) {
    assignments.push('label = @label');
    params.label = patch.label;
  }
  if (patch.supportsEffort !== undefined) {
    assignments.push('supports_effort = @supportsEffort');
    params.supportsEffort = patch.supportsEffort ? 1 : 0;
  }
  if (patch.defaultEffort !== undefined) {
    assignments.push('default_effort = @defaultEffort');
    params.defaultEffort = patch.defaultEffort;
  }
  if (patch.contextWindow !== undefined) {
    assignments.push('context_window = @contextWindow');
    params.contextWindow = patch.contextWindow;
  }
  if (patch.maxOutputTokens !== undefined) {
    assignments.push('max_output_tokens = @maxOutputTokens');
    params.maxOutputTokens = patch.maxOutputTokens;
  }
  if (patch.promptCaching !== undefined) {
    assignments.push('prompt_caching = @promptCaching');
    params.promptCaching = boolParam(patch.promptCaching);
  }
  if (patch.supportsImages !== undefined) {
    assignments.push('supports_images = @supportsImages');
    params.supportsImages = boolParam(patch.supportsImages);
  }
  if (patch.supportsPdf !== undefined) {
    assignments.push('supports_pdf = @supportsPdf');
    params.supportsPdf = boolParam(patch.supportsPdf);
  }
  for (const field of Object.keys(PRICE_COLUMNS) as PriceField[]) {
    if (patch[field] === undefined) continue;
    assignments.push(`${PRICE_COLUMNS[field]} = @${field}`);
    params[field] = patch[field];
  }
  if (assignments.length === 0) return readPlannerModelById(db, id);
  const res = db.prepare(`UPDATE planner_models SET ${assignments.join(', ')} WHERE id = @id`).run(params);
  if (res.changes === 0) return null;
  return readPlannerModelById(db, id);
}

export function deletePlannerModel(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_models WHERE id = ?').run(id).changes > 0;
}

/**
 * Empties the catalog in one statement — PA-6 round 7's "delete all" button.
 * Optionally scoped to a single provider (PA-148).
 */
export function deleteAllPlannerModels(db: Db, providerId?: string): number {
  if (providerId !== undefined) {
    return db.prepare('DELETE FROM planner_models WHERE provider_id = ?').run(providerId).changes;
  }
  return db.prepare('DELETE FROM planner_models').run().changes;
}

/** Appends new models after whatever is already configured. */
export function nextPlannerModelSortOrder(db: Db): number {
  const row = db.prepare('SELECT MAX(sort_order) as maxOrder FROM planner_models').get() as {
    maxOrder: number | null;
  };
  return (row.maxOrder ?? -1) + 1;
}

/**
 * PA-158: Reorders models within a single provider by assigning sequential
 * sort_order (0..n-1). Any models belonging to `providerId` not listed in
 * `modelIds` are preserved after the specified IDs in their existing relative
 * order.
 */
export function reorderPlannerModels(
  db: Db,
  providerId: string,
  modelIds: readonly string[],
): PlannerModelRow[] {
  const existing = readPlannerModels(db, providerId);
  const existingMap = new Map(existing.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of modelIds) {
    if (existingMap.has(id) && !seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }
  for (const m of existing) {
    if (!seen.has(m.id)) {
      orderedIds.push(m.id);
    }
  }

  const updateStmt = db.prepare(
    'UPDATE planner_models SET sort_order = ? WHERE id = ? AND provider_id = ?',
  );
  const runTx = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      updateStmt.run(i, orderedIds[i], providerId);
    }
  });
  runTx();

  return readPlannerModels(db, providerId);
}

// ---- planner LLM provider settings ------------------------------------------
//
// Bespoke `settings` keys, read/written directly rather than through
// `SETTINGS_FIELDS` (`settings/fields.ts`) — these are not `Config` fields
// seeded from `.env`, the same reasoning that keeps `global_skip_permissions`
// out of that table (see `GLOBAL_SKIP_PERMISSIONS_KEY` in `db/index.ts`).

export const PLANNER_LLM_BASE_URL_KEY = 'planner_llm_base_url';

/**
 * Stored in PLAINTEXT, like the webhook secret — the key must be replayed to
 * the provider verbatim, so there is no hashed-verification alternative.
 * Never logged, never returned by a plain read; see `revealPlannerApiKey`.
 */
export const PLANNER_LLM_API_KEY_KEY = 'planner_llm_api_key';

/**
 * Off by default. Not consumed by any code yet — the tool-approval gate that
 * reads this lands in a later phase — but recorded here as part of the
 * settings surface so the Settings page can be built against a stable shape.
 */
export const PLANNER_YOLO_ENABLED_KEY = 'planner_yolo_enabled';

/** Seeds a new chat's model picker; each existing chat keeps its own choice. */
export const PLANNER_LAST_MODEL_ID_KEY = 'planner_last_model_id';
/** Seeds a new chat's effort picker; each existing chat keeps its own choice. */
export const PLANNER_LAST_EFFORT_KEY = 'planner_last_effort';

/**
 * PA-29: the embedding provider's own settings — a separate base URL, API
 * key and model from the `PLANNER_LLM_*` ones above, per the approved
 * design ("Embedding need own setting with url, api key, model (in case I
 * deploy service on other place)"). Mirrors the chat-settings keys/functions
 * exactly, one layer down; see `PlannerSettingsDto.embeddingBaseUrl`'s own
 * doc comment (protocol package) for why the two are never folded together.
 */
export const PLANNER_EMBEDDING_BASE_URL_KEY = 'planner_embedding_base_url';

/** Same plaintext-storage reasoning as `PLANNER_LLM_API_KEY_KEY`. */
export const PLANNER_EMBEDDING_API_KEY_KEY = 'planner_embedding_api_key';

export const PLANNER_EMBEDDING_MODEL_ID_KEY = 'planner_embedding_model_id';

/**
 * PA-31: the `web_search` tool's own provider settings. Same plaintext
 * storage rationale as `PLANNER_LLM_API_KEY_KEY` above — this key is
 * replayed verbatim as a bearer token to the configured search endpoint,
 * so there is no hashed-verification alternative. `_ENABLED` is a separate
 * on/off switch from "a base URL is set" for the same reason
 * `CreateCronJobRequest.skipPermissions` documents keeping a
 * consequential default an explicit, separate act: an operator mid-typing
 * a URL must not have the tool start firing before they mean it to.
 */
export const PLANNER_WEB_SEARCH_ENABLED_KEY = 'planner_web_search_enabled';
export const PLANNER_WEB_SEARCH_BASE_URL_KEY = 'planner_web_search_base_url';
export const PLANNER_WEB_SEARCH_API_KEY_KEY = 'planner_web_search_api_key';

/** PA-31: the `url_fetch` tool's own provider settings — deliberately a
    separate provider from `web_search`'s (a search index and a
    page-fetch/scrape service are different products), same shape and
    plaintext-storage rationale one layer down. */
export const PLANNER_URL_FETCH_ENABLED_KEY = 'planner_url_fetch_enabled';
export const PLANNER_URL_FETCH_BASE_URL_KEY = 'planner_url_fetch_base_url';
export const PLANNER_URL_FETCH_API_KEY_KEY = 'planner_url_fetch_api_key';

/**
 * PA-37 follow-up: the global half of the MCP on/off switch — the per-agent
 * half is `planner_workspaces.mcp_enabled`. Unlike `PLANNER_WEB_SEARCH_ENABLED_KEY`/
 * `PLANNER_URL_FETCH_ENABLED_KEY`, which gate a tool that has no meaning
 * until a base URL is entered, MCP already has its own per-registry
 * `enabled`/connect-test gate, so absence of this key means **on** — a
 * fresh deployment with no MCP registries configured behaves identically
 * whether this key is set or not, and only an explicit turn-off changes
 * anything observable.
 */
export const PLANNER_MCP_ENABLED_KEY = 'planner_mcp_enabled';

/**
 * PA-45 (reporter: "add 'me' instruction, like my name is XXX, email, Jira
 * name, etc whenever agent need have context of myself"): free text about
 * the human operator, global rather than per-agent — see
 * `PlannerSettingsDto.meInstruction`'s doc comment (protocol package) for
 * why. `''`/absent both read as unset (`|| null` below), the same
 * "empty string means unset" convention `PLANNER_LLM_BASE_URL_KEY` already
 * uses.
 */
export const PLANNER_ME_INSTRUCTION_KEY = 'planner_me_instruction';

/**
 * PA-45 (reporter: "add 'tools' instruction, for environment settings, like
 * ssh key, url for certain things, which environment variable has
 * something used for something"): free text about the operator's own
 * environment/tooling — same "global, empty means unset" shape as
 * `PLANNER_ME_INSTRUCTION_KEY` immediately above.
 */
export const PLANNER_TOOLS_INSTRUCTION_KEY = 'planner_tools_instruction';

/**
 * How many tool-call iterations one turn may make before `driveLoop` gives
 * up — see `PlannerSettingsDto.maxToolIterations`'s doc comment (protocol
 * package) for the full rationale. 20 replaces what used to be a hardcoded
 * `MAX_TOOL_ITERATIONS = 8` in `chats.ts`; stored as a string like every
 * other `settings` row, parsed with `Number(...)` and clamped defensively in
 * case a future migration or manual edit puts something out of range in the
 * table.
 */
export const PLANNER_MAX_TOOL_ITERATIONS_KEY = 'planner_max_tool_iterations';
export const DEFAULT_MAX_TOOL_ITERATIONS = 20;

/**
 * PA-74: Maximum subagents a single turn may spawn before refusing further
 * spawns. Stored as a string in settings, parsed with Number(...) and
 * clamped defensively in [1, 50].
 */
export const PLANNER_MAX_SUBAGENT_SPAWNS_PER_TURN_KEY = 'planner_max_subagent_spawns_per_turn';
export const DEFAULT_MAX_SUBAGENT_SPAWNS_PER_TURN = 3;

/**
 * PA-95: Maximum duration (in seconds) a planner shell command (`bash`/`exec_command`)
 * may run before being killed. Stored as a string in settings, parsed with Number(...)
 * and clamped defensively in [1, 3600].
 */
export const PLANNER_COMMAND_TIMEOUT_SECONDS_KEY = 'planner_command_timeout_seconds';
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;

/**
 * PA-121: how long the chat-completion stream may go without a single byte
 * before the request is abandoned (and, if nothing had been streamed yet,
 * retried). `0` turns it off. 300s matches pi's
 * `DEFAULT_HTTP_IDLE_TIMEOUT_MS`: long enough for a slow reasoning model to
 * think before its first token, short enough that a dead connection does not
 * hold a turn — and the chat's `busy` flag — forever. It bounds a wedged
 * network call, which is nobody's decision; it is not a timeout on anything a
 * human is being asked.
 */
export const PLANNER_LLM_IDLE_TIMEOUT_SECONDS_KEY = 'planner_llm_idle_timeout_seconds';
export const DEFAULT_LLM_IDLE_TIMEOUT_SECONDS = 300;

/**
 * PA-121: context compaction — see `planner/compaction.ts`. On by default:
 * without it a long chat eventually exceeds the model's context window and
 * every later turn fails. `reserveTokens` is the headroom kept free below the
 * window (for the reply, and as slack for the estimate); `keepRecentTokens`
 * is how much of the most recent conversation survives verbatim. Defaults are
 * pi's (`DEFAULT_COMPACTION_SETTINGS`).
 */
export const PLANNER_COMPACTION_ENABLED_KEY = 'planner_compaction_enabled';
export const PLANNER_COMPACTION_RESERVE_TOKENS_KEY = 'planner_compaction_reserve_tokens';
export const PLANNER_COMPACTION_KEEP_RECENT_TOKENS_KEY = 'planner_compaction_keep_recent_tokens';
export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
export const DEFAULT_COMPACTION_KEEP_RECENT_TOKENS = 20_000;

/**
 * PA-137: how big an attachment may be and still have its content put into
 * the message (`attachments/inline.ts`) — a UTF-8 text file in bytes, an
 * extracted document in tokens. `0` never inlines. Settings, with these
 * defaults, by the reporter's choice on the ticket.
 */
export const PLANNER_ATTACHMENT_INLINE_TEXT_MAX_BYTES_KEY = 'planner_attachment_inline_text_max_bytes';
export const PLANNER_ATTACHMENT_INLINE_EXTRACT_MAX_TOKENS_KEY = 'planner_attachment_inline_extract_max_tokens';

export interface PlannerSettingsSnapshot {
  baseUrl: string | null;
  hasApiKey: boolean;
  yoloEnabled: boolean;
  lastModelId: string | null;
  embeddingBaseUrl: string | null;
  embeddingHasApiKey: boolean;
  embeddingModelId: string | null;
  webSearchEnabled: boolean;
  webSearchBaseUrl: string | null;
  webSearchHasApiKey: boolean;
  urlFetchEnabled: boolean;
  urlFetchBaseUrl: string | null;
  urlFetchHasApiKey: boolean;
  mcpEnabled: boolean;
  meInstruction: string | null;
  toolsInstruction: string | null;
  maxToolIterations: number;
  maxSubagentSpawnsPerTurn: number;
  commandTimeoutSeconds: number;
  llmIdleTimeoutSeconds: number;
  compactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  attachmentInlineTextMaxBytes: number;
  attachmentInlineExtractMaxTokens: number;
}

export function readPlannerSettings(db: Db): PlannerSettingsSnapshot {
  const defaultProvider = readDefaultOrFirstPlannerProvider(db);
  const legacyBaseUrl = readSetting(db, PLANNER_LLM_BASE_URL_KEY) || null;
  const legacyHasKey = (readSetting(db, PLANNER_LLM_API_KEY_KEY) ?? '').length > 0;
  return {
    baseUrl: defaultProvider ? defaultProvider.baseUrl || null : legacyBaseUrl,
    hasApiKey: defaultProvider
      ? (defaultProvider.secretCiphertext !== null && defaultProvider.secretCiphertext.length > 0) || legacyHasKey
      : legacyHasKey,
    yoloEnabled: readSetting(db, PLANNER_YOLO_ENABLED_KEY) === '1',
    lastModelId: readSetting(db, PLANNER_LAST_MODEL_ID_KEY) || null,
    embeddingBaseUrl: readSetting(db, PLANNER_EMBEDDING_BASE_URL_KEY) || null,
    embeddingHasApiKey: (readSetting(db, PLANNER_EMBEDDING_API_KEY_KEY) ?? '').length > 0,
    embeddingModelId: readSetting(db, PLANNER_EMBEDDING_MODEL_ID_KEY) || null,
    webSearchEnabled: readSetting(db, PLANNER_WEB_SEARCH_ENABLED_KEY) === '1',
    webSearchBaseUrl: readSetting(db, PLANNER_WEB_SEARCH_BASE_URL_KEY) || null,
    webSearchHasApiKey: (readSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY) ?? '').length > 0,
    urlFetchEnabled: readSetting(db, PLANNER_URL_FETCH_ENABLED_KEY) === '1',
    urlFetchBaseUrl: readSetting(db, PLANNER_URL_FETCH_BASE_URL_KEY) || null,
    urlFetchHasApiKey: (readSetting(db, PLANNER_URL_FETCH_API_KEY_KEY) ?? '').length > 0,
    // Absence means on — see `PLANNER_MCP_ENABLED_KEY`'s own doc comment.
    mcpEnabled: readSetting(db, PLANNER_MCP_ENABLED_KEY) !== '0',
    meInstruction: readSetting(db, PLANNER_ME_INSTRUCTION_KEY) || null,
    toolsInstruction: readSetting(db, PLANNER_TOOLS_INSTRUCTION_KEY) || null,
    maxToolIterations: readMaxToolIterations(db),
    maxSubagentSpawnsPerTurn: readMaxSubagentSpawnsPerTurn(db),
    commandTimeoutSeconds: readCommandTimeoutSeconds(db),
    llmIdleTimeoutSeconds: readBoundedInt(db, PLANNER_LLM_IDLE_TIMEOUT_SECONDS_KEY, DEFAULT_LLM_IDLE_TIMEOUT_SECONDS, 0, 3600),
    // Absence means on, the same convention `mcpEnabled` uses.
    compactionEnabled: readSetting(db, PLANNER_COMPACTION_ENABLED_KEY) !== '0',
    compactionReserveTokens: readBoundedInt(
      db,
      PLANNER_COMPACTION_RESERVE_TOKENS_KEY,
      DEFAULT_COMPACTION_RESERVE_TOKENS,
      1024,
      1_000_000,
    ),
    compactionKeepRecentTokens: readBoundedInt(
      db,
      PLANNER_COMPACTION_KEEP_RECENT_TOKENS_KEY,
      DEFAULT_COMPACTION_KEEP_RECENT_TOKENS,
      1024,
      1_000_000,
    ),
    attachmentInlineTextMaxBytes: readBoundedInt(
      db,
      PLANNER_ATTACHMENT_INLINE_TEXT_MAX_BYTES_KEY,
      DEFAULT_INLINE_TEXT_MAX_BYTES,
      0,
      MAX_INLINE_TEXT_MAX_BYTES,
    ),
    attachmentInlineExtractMaxTokens: readBoundedInt(
      db,
      PLANNER_ATTACHMENT_INLINE_EXTRACT_MAX_TOKENS_KEY,
      DEFAULT_INLINE_EXTRACT_MAX_TOKENS,
      0,
      MAX_INLINE_EXTRACT_MAX_TOKENS,
    ),
  };
}

/** PA-137: see `PLANNER_ATTACHMENT_INLINE_TEXT_MAX_BYTES_KEY`. */
export function writePlannerAttachmentInlineCaps(
  db: Db,
  patch: { textMaxBytes?: number; extractMaxTokens?: number },
): void {
  if (patch.textMaxBytes !== undefined) {
    writeSetting(db, PLANNER_ATTACHMENT_INLINE_TEXT_MAX_BYTES_KEY, String(patch.textMaxBytes));
  }
  if (patch.extractMaxTokens !== undefined) {
    writeSetting(db, PLANNER_ATTACHMENT_INLINE_EXTRACT_MAX_TOKENS_KEY, String(patch.extractMaxTokens));
  }
}

/** An integer setting, clamped defensively on the way out like the three
    above it: an out-of-range or unparsable row reads as the default. */
function readBoundedInt(db: Db, key: string, fallback: number, min: number, max: number): number {
  const raw = readSetting(db, key);
  if (raw === null || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/** PA-121: see `PLANNER_LLM_IDLE_TIMEOUT_SECONDS_KEY`. */
export function writePlannerLlmIdleTimeoutSeconds(db: Db, n: number): void {
  writeSetting(db, PLANNER_LLM_IDLE_TIMEOUT_SECONDS_KEY, String(n));
}

/** PA-121: see `PLANNER_COMPACTION_ENABLED_KEY`. */
export function writePlannerCompactionSettings(
  db: Db,
  patch: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number },
): void {
  if (patch.enabled !== undefined) writeSetting(db, PLANNER_COMPACTION_ENABLED_KEY, patch.enabled ? '1' : '0');
  if (patch.reserveTokens !== undefined) {
    writeSetting(db, PLANNER_COMPACTION_RESERVE_TOKENS_KEY, String(patch.reserveTokens));
  }
  if (patch.keepRecentTokens !== undefined) {
    writeSetting(db, PLANNER_COMPACTION_KEEP_RECENT_TOKENS_KEY, String(patch.keepRecentTokens));
  }
}

function readMaxToolIterations(db: Db): number {
  const raw = readSetting(db, PLANNER_MAX_TOOL_ITERATIONS_KEY);
  if (raw === null) return DEFAULT_MAX_TOOL_ITERATIONS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return DEFAULT_MAX_TOOL_ITERATIONS;
  return parsed;
}

function readMaxSubagentSpawnsPerTurn(db: Db): number {
  const raw = readSetting(db, PLANNER_MAX_SUBAGENT_SPAWNS_PER_TURN_KEY);
  if (raw === null) return DEFAULT_MAX_SUBAGENT_SPAWNS_PER_TURN;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) return DEFAULT_MAX_SUBAGENT_SPAWNS_PER_TURN;
  return parsed;
}

function readCommandTimeoutSeconds(db: Db): number {
  const raw = readSetting(db, PLANNER_COMMAND_TIMEOUT_SECONDS_KEY);
  if (raw === null) return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  return parsed;
}

export function writePlannerMcpEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_MCP_ENABLED_KEY, enabled ? '1' : '0');
}

/** PA-45: see `PLANNER_ME_INSTRUCTION_KEY`'s own doc comment. */
export function writePlannerMeInstruction(db: Db, text: string | null): void {
  writeSetting(db, PLANNER_ME_INSTRUCTION_KEY, text ?? '');
}

/** PA-45: see `PLANNER_TOOLS_INSTRUCTION_KEY`'s own doc comment. */
export function writePlannerToolsInstruction(db: Db, text: string | null): void {
  writeSetting(db, PLANNER_TOOLS_INSTRUCTION_KEY, text ?? '');
}

/** See `PLANNER_MAX_TOOL_ITERATIONS_KEY`'s own doc comment. The route's own
    Zod schema (`UpdatePlannerSettingsRequest.maxToolIterations`) already
    bounds `n` to `[1, 200]`; `readMaxToolIterations` clamps defensively on
    the way back out regardless. */
export function writePlannerMaxToolIterations(db: Db, n: number): void {
  writeSetting(db, PLANNER_MAX_TOOL_ITERATIONS_KEY, String(n));
}

/** PA-74: see `PLANNER_MAX_SUBAGENT_SPAWNS_PER_TURN_KEY`'s own doc comment. */
export function writePlannerMaxSubagentSpawnsPerTurn(db: Db, n: number): void {
  writeSetting(db, PLANNER_MAX_SUBAGENT_SPAWNS_PER_TURN_KEY, String(n));
}

/** PA-95: see `PLANNER_COMMAND_TIMEOUT_SECONDS_KEY`'s own doc comment. */
export function writePlannerCommandTimeoutSeconds(db: Db, n: number): void {
  writeSetting(db, PLANNER_COMMAND_TIMEOUT_SECONDS_KEY, String(n));
}

export function writePlannerBaseUrl(db: Db, baseUrl: string | null): void {
  const normalized = (baseUrl ?? '').trim();
  const existing = readDefaultOrFirstPlannerProvider(db);
  if (existing) {
    updatePlannerProvider(db, existing.id, { baseUrl: normalized });
  } else if (normalized.length > 0) {
    ensureDefaultPlannerProvider(db, normalized);
  }
  writeSetting(db, PLANNER_LLM_BASE_URL_KEY, '');
}

export function writePlannerApiKey(db: Db, apiKey: string | null, encKey?: Buffer): void {
  const trimmed = (apiKey ?? '').trim();
  if (trimmed.length === 0) {
    const existing = readDefaultOrFirstPlannerProvider(db);
    if (existing) {
      updatePlannerProvider(db, existing.id, { secretCiphertext: null });
    }
    writeSetting(db, PLANNER_LLM_API_KEY_KEY, '');
    return;
  }
  const key = requirePlannerProviderEncKey(encKey);
  const provider = ensureDefaultPlannerProvider(db);
  updatePlannerProvider(db, provider.id, {
    secretCiphertext: encryptSecret(trimmed, key),
  });
  writeSetting(db, PLANNER_LLM_API_KEY_KEY, '');
}

export function writePlannerYoloEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_YOLO_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerLastModelId(db: Db, modelId: string | null): void {
  writeSetting(db, PLANNER_LAST_MODEL_ID_KEY, modelId ?? '');
}

export function readPlannerLastEffort(db: Db): string | null {
  const value = readSetting(db, PLANNER_LAST_EFFORT_KEY);
  return value && value.length > 0 ? value : null;
}

export function writePlannerLastEffort(db: Db, effort: string | null): void {
  writeSetting(db, PLANNER_LAST_EFFORT_KEY, effort ?? '');
}

export function writePlannerEmbeddingBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerEmbeddingApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_API_KEY_KEY, apiKey ?? '');
}

export function writePlannerEmbeddingModelId(db: Db, modelId: string | null): void {
  writeSetting(db, PLANNER_EMBEDDING_MODEL_ID_KEY, modelId ?? '');
}

export function writePlannerWebSearchEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_WEB_SEARCH_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerWebSearchBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_WEB_SEARCH_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerWebSearchApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY, apiKey ?? '');
}

export function writePlannerUrlFetchEnabled(db: Db, enabled: boolean): void {
  writeSetting(db, PLANNER_URL_FETCH_ENABLED_KEY, enabled ? '1' : '0');
}

export function writePlannerUrlFetchBaseUrl(db: Db, baseUrl: string | null): void {
  writeSetting(db, PLANNER_URL_FETCH_BASE_URL_KEY, baseUrl ?? '');
}

export function writePlannerUrlFetchApiKey(db: Db, apiKey: string | null): void {
  writeSetting(db, PLANNER_URL_FETCH_API_KEY_KEY, apiKey ?? '');
}

/**
 * Decrypts the default/first provider's API key for internal server callers.
 * Never exposed via an HTTP reveal route (PA-148).
 */
export function revealPlannerApiKey(db: Db, encKey?: Buffer): string | null {
  const provider = readDefaultOrFirstPlannerProvider(db);
  if (provider?.secretCiphertext) {
    return decryptPlannerProviderSecret(provider, encKey).apiKey;
  }
  return null;
}

/** The embedding provider's own reveal — same rate-limit/logging posture,
    at its own route. */
export function revealPlannerEmbeddingApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_EMBEDDING_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

/**
 * PA-31: the `web_search`/`url_fetch` tools' own keys, read fresh on every
 * tool call (`PlannerChatService.executeTool`) — like `plannerYoloEnabled`,
 * a key rotated in Settings must take effect on the very next call, not
 * wait for a restart or a cached snapshot. Unlike `revealPlannerApiKey`/
 * `revealPlannerEmbeddingApiKey` above, these are never reachable over
 * HTTP: nothing outside this server needs to read them back, the same
 * reasoning `CustomClaudeProviderStore`'s API key has no reveal endpoint
 * either.
 */
export function resolvePlannerWebSearchApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_WEB_SEARCH_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

export function resolvePlannerUrlFetchApiKey(db: Db): string | null {
  const value = readSetting(db, PLANNER_URL_FETCH_API_KEY_KEY);
  return value && value.length > 0 ? value : null;
}

// ---- planner_chats -----------------------------------------------------------

interface PlannerChatDbRow {
  id: string;
  workspace_id: string | null;
  workspace_name: string;
  doc_workspace_id?: string | null;
  doc_workspace_name?: string | null;
  doc_workspace_auto_approve_edits?: number | null;
  title: string | null;
  last_model_id: string | null;
  created_at: number;
  last_activity_at: number;
  skip_tool_approvals: number;
  parent_chat_id?: string | null;
  cron_job_id?: string | null;
  last_effort?: string | null;
  thinking_enabled?: number | null;
}

function chatFromDbRow(row: PlannerChatDbRow): PlannerChat {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    docWorkspaceId: row.doc_workspace_id ?? null,
    docWorkspaceName: row.doc_workspace_name ?? null,
    ...(row.doc_workspace_id
      ? { docWorkspaceAutoApproveEdits: row.doc_workspace_auto_approve_edits === 1 }
      : {}),
    title: row.title,
    lastModelId: row.last_model_id,
    createdAt: row.created_at,
    lastActivityAt: row.last_activity_at,
    skipToolApprovalsEnabled: row.skip_tool_approvals === 1,
    parentChatId: row.parent_chat_id ?? null,
    cronJobId: row.cron_job_id ?? null,
    busy: false,
    lastEffort: row.last_effort ?? null,
    thinkingEnabled: row.thinking_enabled !== 0,
  };
}

const SELECT_PLANNER_CHAT_SQL = `
  SELECT c.*, dw.name AS doc_workspace_name, dw.auto_approve_edits AS doc_workspace_auto_approve_edits
    FROM planner_chats c
    LEFT JOIN doc_workspaces dw ON dw.id = c.doc_workspace_id
`;

export function readPlannerChats(db: Db, workspaceId?: string): PlannerChat[] {
  const rows = (
    workspaceId
      ? db
          .prepare(`${SELECT_PLANNER_CHAT_SQL} WHERE c.workspace_id = ? ORDER BY c.last_activity_at DESC`)
          .all(workspaceId)
      : db.prepare(`${SELECT_PLANNER_CHAT_SQL} ORDER BY c.last_activity_at DESC`).all()
  ) as PlannerChatDbRow[];
  return rows.map(chatFromDbRow);
}

export function readPlannerChatsByParentId(db: Db, parentChatId: string): PlannerChat[] {
  const rows = db
    .prepare(`${SELECT_PLANNER_CHAT_SQL} WHERE c.parent_chat_id = ? ORDER BY c.last_activity_at DESC`)
    .all(parentChatId) as PlannerChatDbRow[];
  return rows.map(chatFromDbRow);
}

export function readPlannerChat(db: Db, id: string): PlannerChat | null {
  const row = db.prepare(`${SELECT_PLANNER_CHAT_SQL} WHERE c.id = ?`).get(id) as
    | PlannerChatDbRow
    | undefined;
  return row ? chatFromDbRow(row) : null;
}

export function insertPlannerChat(db: Db, chat: PlannerChat): void {
  db.prepare(
    `INSERT INTO planner_chats
       (id, workspace_id, workspace_name, doc_workspace_id, title, last_model_id, created_at, last_activity_at,
        skip_tool_approvals, parent_chat_id, cron_job_id, last_effort, thinking_enabled)
     VALUES (@id, @workspaceId, @workspaceName, @docWorkspaceId, @title, @lastModelId, @createdAt, @lastActivityAt,
        @skipToolApprovals, @parentChatId, @cronJobId, @lastEffort, @thinkingEnabled)`,
  ).run({
    ...chat,
    docWorkspaceId: chat.docWorkspaceId ?? null,
    skipToolApprovals: chat.skipToolApprovalsEnabled ? 1 : 0,
    parentChatId: chat.parentChatId ?? null,
    cronJobId: chat.cronJobId ?? null,
    lastEffort: chat.lastEffort ?? null,
    thinkingEnabled: chat.thinkingEnabled !== false ? 1 : 0,
  });
}

/** Partial update: only the keys present in `patch` are touched. */
export function updatePlannerChat(
  db: Db,
  id: string,
  patch: Partial<
    Pick<
      PlannerChat,
      'title' | 'lastModelId' | 'lastActivityAt' | 'lastEffort' | 'thinkingEnabled' | 'docWorkspaceId'
    >
  >,
): void {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if ('title' in patch) {
    assignments.push('title = @title');
    params.title = patch.title;
  }
  if ('lastModelId' in patch) {
    assignments.push('last_model_id = @lastModelId');
    params.lastModelId = patch.lastModelId;
  }
  if ('lastActivityAt' in patch) {
    assignments.push('last_activity_at = @lastActivityAt');
    params.lastActivityAt = patch.lastActivityAt;
  }
  if ('lastEffort' in patch) {
    assignments.push('last_effort = @lastEffort');
    params.lastEffort = patch.lastEffort;
  }
  if ('thinkingEnabled' in patch) {
    assignments.push('thinking_enabled = @thinkingEnabled');
    params.thinkingEnabled = patch.thinkingEnabled ? 1 : 0;
  }
  if ('docWorkspaceId' in patch) {
    assignments.push('doc_workspace_id = @docWorkspaceId');
    params.docWorkspaceId = patch.docWorkspaceId ?? null;
  }
  if (assignments.length === 0) return;
  db.prepare(`UPDATE planner_chats SET ${assignments.join(', ')} WHERE id = @id`).run(params);
}

export function deletePlannerChat(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_chats WHERE id = ?').run(id).changes > 0;
}

/**
 * PA-29: how many of a chat's oldest turns have already been folded into a
 * memory by the rolling window — see the migration's own doc comment for why
 * this exists and why it is not part of the `PlannerChat` protocol type.
 */
export function readPlannerChatMemoryFoldedTurns(db: Db, id: string): number {
  const row = db.prepare('SELECT memory_folded_turns FROM planner_chats WHERE id = ?').get(id) as
    | { memory_folded_turns: number }
    | undefined;
  return row?.memory_folded_turns ?? 0;
}

export function writePlannerChatMemoryFoldedTurns(db: Db, id: string, foldedTurns: number): void {
  db.prepare('UPDATE planner_chats SET memory_folded_turns = ? WHERE id = ?').run(foldedTurns, id);
}

// ---- planner_tool_approvals ---------------------------------------------------

export type PlannerApprovalScope = 'global' | 'workspace';
export type PlannerApprovalDecision = 'allow' | 'deny';

/**
 * `workspaceId` must be non-null for `scope: 'workspace'` and null for
 * `scope: 'global'` — enforced by the one caller that ever writes this row
 * (`planner/approval.ts`), not by the schema (see the migration's own doc
 * comment for why).
 */
export function readPlannerToolApproval(
  db: Db,
  scope: PlannerApprovalScope,
  workspaceId: string | null,
  toolName: string,
): PlannerApprovalDecision | null {
  const row = db
    .prepare(
      `SELECT decision FROM planner_tool_approvals
       WHERE scope = ? AND workspace_id IS ? AND tool_name = ?`,
    )
    .get(scope, workspaceId, toolName) as { decision: PlannerApprovalDecision } | undefined;
  return row?.decision ?? null;
}

export function writePlannerToolApproval(
  db: Db,
  scope: PlannerApprovalScope,
  workspaceId: string | null,
  toolName: string,
  decision: PlannerApprovalDecision,
): void {
  db.prepare(
    `INSERT INTO planner_tool_approvals (id, scope, workspace_id, tool_name, decision, created_at)
     VALUES (@id, @scope, @workspaceId, @toolName, @decision, @createdAt)
     ON CONFLICT (scope, COALESCE(workspace_id, ''), tool_name)
     DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`,
  ).run({
    id: crypto.randomUUID(),
    scope,
    workspaceId,
    toolName,
    decision,
    createdAt: Date.now(),
  });
}

export interface PlannerToolApprovalRow {
  id: string;
  scope: PlannerApprovalScope;
  workspaceId: string | null;
  toolName: string;
  decision: PlannerApprovalDecision;
  createdAt: number;
}

/**
 * Every remembered decision, for a settings page to list/edit — the "which
 * tool is allowed globally and each workspace" surface, expressed as
 * ordinary rows in the same table the chat's own approval card writes to
 * (PA-6 phase 4/5): pre-configuring a decision here and a human choosing
 * "remember" mid-chat are the same act, just triggered from two different
 * places.
 */
export function readPlannerToolApprovals(db: Db): PlannerToolApprovalRow[] {
  const rows = db
    .prepare('SELECT * FROM planner_tool_approvals ORDER BY created_at DESC')
    .all() as {
    id: string;
    scope: PlannerApprovalScope;
    workspace_id: string | null;
    tool_name: string;
    decision: PlannerApprovalDecision;
    created_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    workspaceId: r.workspace_id,
    toolName: r.tool_name,
    decision: r.decision,
    createdAt: r.created_at,
  }));
}

export function deletePlannerToolApproval(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_tool_approvals WHERE id = ?').run(id).changes > 0;
}

// ---- planner_memories ---------------------------------------------------------
//
// PA-29: raw persistence for the memory system, in the same "prepared
// statements, plain functions taking `Db` first" style as every other table
// in this file. `PlannerMemoryService` (`planner/memory.ts`) owns the
// scoring/eviction/ranking logic on top of these; nothing here decides which
// row survives a budget cap or which one a search should surface first.

interface PlannerMemoryDbRow {
  id: string;
  workspace_id: string;
  tier: PlannerMemoryTier;
  content: string;
  importance: number;
  source_chat_id: string | null;
  created_at: number;
  last_accessed_at: number;
  /** PA-29: `NULL` until an embedding provider is configured and this row's
      content has been embedded — see the migration's own doc comment for why
      a mismatched `embedding_model` (or a `NULL` one) must never be compared
      against another row's vector. */
  embedding: Buffer | null;
  embedding_model: string | null;
}

function memoryFromDbRow(row: PlannerMemoryDbRow): PlannerMemory {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tier: row.tier,
    content: row.content,
    importance: row.importance,
    sourceChatId: row.source_chat_id,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

export function insertPlannerMemory(db: Db, memory: PlannerMemory): void {
  db.prepare(
    `INSERT INTO planner_memories
       (id, workspace_id, tier, content, importance, source_chat_id, created_at, last_accessed_at)
     VALUES (@id, @workspaceId, @tier, @content, @importance, @sourceChatId, @createdAt, @lastAccessedAt)`,
  ).run(memory);
}

export function readPlannerMemory(db: Db, id: string): PlannerMemory | null {
  const row = db.prepare('SELECT * FROM planner_memories WHERE id = ?').get(id) as
    | PlannerMemoryDbRow
    | undefined;
  return row ? memoryFromDbRow(row) : null;
}

/** Every row of one tier in one workspace — the eviction-budget scan.
    Small by construction (bounded by `MAX_SHORT_TERM_MEMORIES`/
    `MAX_LONG_TERM_MEMORIES` in `planner/memory.ts`), so no `LIMIT` here. */
export function readPlannerMemoriesForTier(
  db: Db,
  workspaceId: string,
  tier: PlannerMemoryTier,
): PlannerMemory[] {
  const rows = db
    .prepare('SELECT * FROM planner_memories WHERE workspace_id = ? AND tier = ?')
    .all(workspaceId, tier) as PlannerMemoryDbRow[];
  return rows.map(memoryFromDbRow);
}

/** Plain listing for a settings UI (PA-29 phase 4) — most-recent-first, no
    relevance scoring. `tier` omitted lists every tier for the workspace. */
export function readPlannerMemories(
  db: Db,
  workspaceId: string,
  tier?: PlannerMemoryTier,
): PlannerMemory[] {
  const rows = (
    tier
      ? db
          .prepare(
            'SELECT * FROM planner_memories WHERE workspace_id = ? AND tier = ? ORDER BY created_at DESC',
          )
          .all(workspaceId, tier)
      : db
          .prepare('SELECT * FROM planner_memories WHERE workspace_id = ? ORDER BY created_at DESC')
          .all(workspaceId)
  ) as PlannerMemoryDbRow[];
  return rows.map(memoryFromDbRow);
}

export function deletePlannerMemory(db: Db, id: string): boolean {
  return db.prepare('DELETE FROM planner_memories WHERE id = ?').run(id).changes > 0;
}

/**
 * `content`/`importance` only — deliberately does not touch `embedding`/
 * `embedding_model`. An edit through this path (the memories settings-page
 * editor) leaves whatever embedding this row already had, now describing
 * text that has changed underneath it; re-embedding on every edit was judged
 * out of scope for this pass (nothing else in this feature re-embeds on
 * edit either), so a hand-edited memory's semantic ranking is stale until a
 * future write path recomputes it. Its lexical (FTS5) ranking is unaffected,
 * since that index is kept in sync by the triggers on every UPDATE.
 */
export function updatePlannerMemory(
  db: Db,
  id: string,
  patch: { content?: string; importance?: number },
): void {
  const assignments: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.content !== undefined) {
    assignments.push('content = @content');
    params.content = patch.content;
  }
  if (patch.importance !== undefined) {
    assignments.push('importance = @importance');
    params.importance = patch.importance;
  }
  if (assignments.length === 0) return;
  db.prepare(`UPDATE planner_memories SET ${assignments.join(', ')} WHERE id = @id`).run(params);
}

/** Sets a memory's embedding vector and the model it came from, once
    `PlannerMemoryService.save` has successfully embedded its content — see
    that method's own doc comment for why this is a separate write from the
    initial insert (the row must exist, with its real `content`, before it
    can be embedded) and why a failure here must never fail the save. */
export function updatePlannerMemoryEmbedding(
  db: Db,
  id: string,
  embedding: Buffer,
  embeddingModel: string,
): void {
  db.prepare('UPDATE planner_memories SET embedding = ?, embedding_model = ? WHERE id = ?').run(
    embedding,
    embeddingModel,
    id,
  );
}

/**
 * PA-29: a memory's embedding is stored as a packed `Float32Array` `BLOB`
 * rather than a JSON array of floats — a vector of even a few hundred
 * dimensions as JSON text is several times larger on disk and slower to
 * parse back out, for no benefit, since nothing but this feature's own code
 * ever reads the column directly (it never round-trips through the wire
 * protocol — see `PlannerMemory`'s own schema, which has no `embedding`
 * field at all).
 */
export function encodeEmbedding(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

/**
 * The inverse of `encodeEmbedding`. Reads via `Buffer.readFloatLE` at each
 * 4-byte offset rather than reinterpreting the blob as a `Float32Array`
 * directly — a `Buffer` handed back by better-sqlite3 is a view into a
 * shared, pooled `ArrayBuffer` whose `byteOffset` is not guaranteed to be a
 * multiple of 4, and `Float32Array`'s constructor throws on a misaligned
 * offset; `readFloatLE` has no such alignment requirement.
 */
export function decodeEmbedding(blob: Buffer): number[] {
  const floatCount = Math.floor(blob.length / 4);
  const vector: number[] = new Array(floatCount);
  for (let i = 0; i < floatCount; i++) {
    vector[i] = blob.readFloatLE(i * 4);
  }
  return vector;
}

/** Bumps `last_accessed_at` for exactly the rows a search actually returned
    to the caller — never for a row only *considered* (an eviction scan, a
    dry-run preview) — see `PlannerMemoryService.search`'s `dryRun` option. */
export function touchPlannerMemoriesLastAccessed(db: Db, ids: readonly string[], now: number): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE planner_memories SET last_accessed_at = ? WHERE id IN (${placeholders})`).run(
    now,
    ...ids,
  );
}

/**
 * One FTS5 hit joined back to its full row, plus SQLite's own `bm25()`
 * relevance for that match (more negative is a better match, SQLite's own
 * convention) — `PlannerMemoryService.search` combines this with `score()`
 * rather than using either alone, so a highly important but only loosely
 * related memory and a perfectly-matched but stale, unimportant one both get
 * a fair hearing.
 */
export interface PlannerMemoryFtsHit {
  memory: PlannerMemory;
  bm25: number;
  /** PA-29: this row's own embedding/model, straight off the row — `null`
      either way when it has never been embedded. `PlannerMemoryService.search`
      decides whether it is usable (matches the *currently configured* model)
      before ever decoding it; this hit type just carries what's on disk. */
  embedding: Buffer | null;
  embeddingModel: string | null;
}

/**
 * Raw FTS5 MATCH query against `planner_memories_fts`, filtered to one
 * workspace (and tier, if given), ordered by textual relevance alone —
 * `PlannerMemoryService.search` re-ranks the top `candidateLimit` of these
 * against `score()` before applying the caller's real `limit`. Returns `[]`
 * for a query with no usable tokens (see `buildFtsMatchQuery`) rather than
 * letting FTS5's query parser throw on an empty or all-punctuation string.
 */
export function searchPlannerMemoriesFts(
  db: Db,
  workspaceId: string,
  queryText: string,
  tier: PlannerMemoryTier | undefined,
  candidateLimit: number,
): PlannerMemoryFtsHit[] {
  const matchQuery = buildFtsMatchQuery(queryText);
  if (matchQuery === null) return [];
  const rows = (
    tier
      ? db
          .prepare(
            `SELECT m.*, bm25(planner_memories_fts) AS rank
             FROM planner_memories_fts
             JOIN planner_memories m ON m.rowid = planner_memories_fts.rowid
             WHERE planner_memories_fts.content MATCH ? AND m.workspace_id = ? AND m.tier = ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(matchQuery, workspaceId, tier, candidateLimit)
      : db
          .prepare(
            `SELECT m.*, bm25(planner_memories_fts) AS rank
             FROM planner_memories_fts
             JOIN planner_memories m ON m.rowid = planner_memories_fts.rowid
             WHERE planner_memories_fts.content MATCH ? AND m.workspace_id = ?
             ORDER BY rank
             LIMIT ?`,
          )
          .all(matchQuery, workspaceId, candidateLimit)
  ) as (PlannerMemoryDbRow & { rank: number })[];
  return rows.map((row) => ({
    memory: memoryFromDbRow(row),
    bm25: row.rank,
    embedding: row.embedding,
    embeddingModel: row.embedding_model,
  }));
}

/**
 * Turns arbitrary conversation text into a safe FTS5 `MATCH` argument: split
 * into word tokens, strip everything but letters/digits from each (dropping
 * FTS5's own query syntax characters — `"`, `-`, `*`, `:`, parentheses — so
 * none of them can be smuggled in from a user's own message and change the
 * query's *meaning*, e.g. a leading `-` turning a token into a NOT clause),
 * then phrase-quote each token and OR them together. A `MATCH` with zero
 * tokens throws in SQLite rather than matching nothing, so this returns
 * `null` for that case and the caller treats it as "no results" instead of
 * letting the query throw.
 */
export function buildFtsMatchQuery(text: string): string | null {
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((token) => token.length > 0)
    // Capped so one very long message cannot build an unbounded MATCH query.
    .slice(0, 32);
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token}"`).join(' OR ');
}

// ---- planner_prompt_queue (PA-122) ------------------------------------------

export interface PlannerQueuedPromptRow {
  id: string;
  chatId: string;
  content: string;
  image: PromptImage | null;
  /** PA-136: files already landed in the workspace — metadata only. Landed at
      queue time, because a staging id would not survive the restart a
      queued message must. */
  attachments: PromptAttachment[];
  createdAt: number;
}

interface PlannerQueuedPromptDbRow {
  id: string;
  chat_id: string;
  content: string;
  image_json: string | null;
  attachments_json?: string | null;
  created_at: number;
}

function queuedPromptFromDbRow(row: PlannerQueuedPromptDbRow): PlannerQueuedPromptRow {
  let image: PromptImage | null = null;
  if (row.image_json) {
    try {
      const parsed = PromptImage.safeParse(JSON.parse(row.image_json));
      image = parsed.success ? parsed.data : null;
    } catch {
      image = null;
    }
  }
  let attachments: PromptAttachment[] = [];
  if (row.attachments_json) {
    try {
      const parsed = PromptAttachment.array().safeParse(JSON.parse(row.attachments_json));
      attachments = parsed.success ? parsed.data : [];
    } catch {
      attachments = [];
    }
  }
  return { id: row.id, chatId: row.chat_id, content: row.content, image, attachments, createdAt: row.created_at };
}

export function insertPlannerQueuedPrompt(db: Db, row: PlannerQueuedPromptRow): void {
  db.prepare(
    `INSERT INTO planner_prompt_queue (id, chat_id, content, image_json, attachments_json, created_at)
     VALUES (@id, @chatId, @content, @imageJson, @attachmentsJson, @createdAt)`,
  ).run({
    id: row.id,
    chatId: row.chatId,
    content: row.content,
    imageJson: row.image ? JSON.stringify(row.image) : null,
    attachmentsJson: row.attachments.length > 0 ? JSON.stringify(row.attachments) : null,
    createdAt: row.createdAt,
  });
}

/** Oldest first — the order they were sent, and the order they are delivered. */
export function readPlannerQueuedPrompts(db: Db, chatId: string): PlannerQueuedPromptRow[] {
  return (
    db
      .prepare('SELECT * FROM planner_prompt_queue WHERE chat_id = ? ORDER BY created_at, rowid')
      .all(chatId) as PlannerQueuedPromptDbRow[]
  ).map(queuedPromptFromDbRow);
}

export function countPlannerQueuedPrompts(db: Db, chatId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM planner_prompt_queue WHERE chat_id = ?').get(chatId) as { n: number }).n;
}

export function deletePlannerQueuedPrompt(db: Db, chatId: string, id: string): boolean {
  return db.prepare('DELETE FROM planner_prompt_queue WHERE id = ? AND chat_id = ?').run(id, chatId).changes > 0;
}

export function deletePlannerQueuedPromptsForChat(db: Db, chatId: string): number {
  return db.prepare('DELETE FROM planner_prompt_queue WHERE chat_id = ?').run(chatId).changes;
}

/** Chats with something still queued — what a boot delivers. */
export function readChatIdsWithQueuedPrompts(db: Db): string[] {
  return (
    db.prepare('SELECT DISTINCT chat_id FROM planner_prompt_queue ORDER BY chat_id').all() as { chat_id: string }[]
  ).map((r) => r.chat_id);
}
