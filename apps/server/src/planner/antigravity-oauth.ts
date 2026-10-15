/**
 * PA-151: Antigravity (Google) subscription provider (`antigravity-oauth`) —
 * reuse the signed-in `agy` CLI login (`~/.gemini/antigravity-cli/antigravity-oauth-token`)
 * or sign in with a separate Google OAuth flow against Google's Cloud Code Assist
 * backend (`/v1internal:streamGenerateContent?alt=sse`).
 *
 * Adapted in part from OmniRoute (https://github.com/diegosouzapw/OmniRoute):
 *   - src/lib/oauth/utils/agyAuthImport.ts
 *   - src/app/api/providers/agy-auth/apply-local/route.ts
 *   - src/lib/oauth/providers/antigravity.ts
 *   - src/lib/oauth/constants/oauth.ts (ANTIGRAVITY_CONFIG)
 *   - open-sse/executors/antigravity.ts
 *   - open-sse/services/antigravityHeaders.ts
 *   - open-sse/services/antigravityVersion.ts
 *   - open-sse/config/antigravityUpstream.ts
 *
 * MIT License
 * Copyright (c) 2026 diegosouzapw
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ClaudeOAuthAuthorizeResponse,
  ClaudeProviderUsageResponse,
  ClaudeProviderUsageWindow,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  AntigravityGeminiSseParser,
  DEFAULT_ANTIGRAVITY_CLI_VERSION,
  buildAntigravityGeminiRequest,
  formatAntigravityErrorMessage,
  parseAntigravityRetryResetInfo,
} from './antigravity-gemini-translator.js';
import type {
  PlannerChatMessage,
  PlannerLlmProvider,
  PlannerLlmRetryPolicy,
  PlannerLlmStreamEvent,
  PlannerLlmStreamOptions,
} from './llm-client.js';
import {
  DEFAULT_LLM_RETRY_POLICY,
  PlannerLlmError,
  abortableSleep,
} from './llm-client.js';
import { isContextOverflowMessage, isQuotaMessage, isRetryableStatus } from './llm-errors.js';
import {
  type AntigravityOAuthStoredCredentials,
  DEFAULT_ANTIGRAVITY_OAUTH_BASE_URL,
  type PlannerProviderRow,
  decryptAntigravityOAuthCredentials,
  encryptAntigravityOAuthCredentials,
  readPlannerProvider,
  updatePlannerProvider,
} from './store.js';

/**
 * Antigravity public Google OAuth installed-app credentials (from OmniRoute's
 * `src/shared/constants/publicCreds.ts`). Overridable via environment variables.
 */
const MASK_KEY = 'omniroute-public-v1';
const ANTIGRAVITY_ALT_BYTES = [
  40, 34, 45, 58, 34, 55, 88, 63, 80, 21, 54, 34, 48, 88, 81, 85, 97, 18, 125, 37, 92, 3, 37, 48,
  87, 6, 44, 38, 25, 10, 67, 19, 40, 40, 5,
] as const;

function decodePublicSecret(bytes: readonly number[]): string {
  return bytes
    .map((b, i) => String.fromCharCode(b ^ MASK_KEY.charCodeAt(i % MASK_KEY.length)))
    .join('');
}

export const ANTIGRAVITY_OAUTH_CLIENT_ID =
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID ||
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';

export const ANTIGRAVITY_OAUTH_CLIENT_SECRET =
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || decodePublicSecret(ANTIGRAVITY_ALT_BYTES);

export const ANTIGRAVITY_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
export const ANTIGRAVITY_OAUTH_REDIRECT_URI = 'http://127.0.0.1:51121/oauth-callback';

export const ANTIGRAVITY_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
] as const;

export const ANTIGRAVITY_UPSTREAM_BASES = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
] as const;

const DEFAULT_FALLBACK_PROJECT_ID = 'bamboo-precept-lgxtn';
const PKCE_SESSION_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Static fallback model catalog for `antigravity-oauth` when `/v1internal:fetchAvailableModels`
 * is unreachable. Matches the current Code Assist agent model catalog.
 */
export const ANTIGRAVITY_OAUTH_STATIC_MODELS: readonly { id: string; name: string }[] = [
  { id: 'auto', name: 'Auto (Recommended)' },
  { id: 'gemini-3.7-flash-high', name: 'Gemini 3.7 Flash' },
  { id: 'fable-5.1-high', name: 'Fable 5.1 (High)' },
  { id: 'fable-5.1-low', name: 'Fable 5.1 (Low)' },
  { id: 'opus-5.5-thinking', name: 'Opus 5.5 (Thinking)' },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
];

let cachedAgyVersion: string | null = null;

/**
 * Resolves the installed `agy` CLI version once per process (`agy --version`),
 * falling back to `DEFAULT_ANTIGRAVITY_CLI_VERSION` (`1.3.5`).
 */
export function resolveAntigravityCliVersion(
  agyBin = process.env.POCKETAGENT_AGY_BIN || 'agy',
): string {
  if (cachedAgyVersion !== null) return cachedAgyVersion;
  try {
    const out = execFileSync(agyBin, ['--version'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+\.\d+\.\d+)/.exec(out);
    cachedAgyVersion = match?.[1] ?? DEFAULT_ANTIGRAVITY_CLI_VERSION;
  } catch {
    cachedAgyVersion = DEFAULT_ANTIGRAVITY_CLI_VERSION;
  }
  return cachedAgyVersion;
}

export function resetAntigravityCliVersionCacheForTests(): void {
  cachedAgyVersion = null;
}

export function resolveAntigravityPlatformInfo(): {
  osType: 'darwin' | 'linux' | 'windows';
  arch: 'arm64' | 'amd64';
  platformEnum: number;
} {
  const osType: 'darwin' | 'linux' | 'windows' =
    process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : 'linux';
  const arch: 'arm64' | 'amd64' = process.arch === 'arm64' ? 'arm64' : 'amd64';
  // Google Cloud Code Assist Platform enum:
  // 1 = DARWIN_AMD64, 2 = DARWIN_ARM64, 3 = LINUX_AMD64, 4 = LINUX_ARM64, 5 = WINDOWS_AMD64
  let platformEnum = 3;
  if (osType === 'darwin') {
    platformEnum = arch === 'arm64' ? 2 : 1;
  } else if (osType === 'linux') {
    platformEnum = arch === 'arm64' ? 4 : 3;
  } else {
    platformEnum = 5;
  }
  return { osType, arch, platformEnum };
}

export function buildAntigravityHeaders(opts: {
  accessToken: string;
  projectId?: string | null;
  omitUserProjectHeader?: boolean | null;
  clientVersion?: string;
  accept?: string;
  contentType?: string;
}): Record<string, string> {
  const ver = opts.clientVersion ?? resolveAntigravityCliVersion();
  const { osType, arch } = resolveAntigravityPlatformInfo();
  const headers: Record<string, string> = {
    ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    accept: opts.accept ?? 'application/json',
    authorization: `Bearer ${opts.accessToken}`,
    'user-agent': `antigravity/cli/${ver} (aidev_client; os_type=${osType}; arch=${arch}; auth_method=consumer)`,
  };
  if (opts.projectId && !opts.omitUserProjectHeader) {
    headers['x-goog-user-project'] = opts.projectId;
  }
  return headers;
}

// ---- Local agy CLI token file (read-only) ----------------------------------

export interface LocalAgyCliTokenData {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  authMethod: string | null;
}

export function resolveLocalAgyTokenPath(customPath?: string): string {
  const override =
    customPath?.trim() ||
    process.env.POCKETAGENT_AGY_TOKEN_FILE?.trim() ||
    process.env.AGY_TOKEN_FILE?.trim();
  if (override) {
    if (override.startsWith('~/')) {
      return path.join(os.homedir(), override.slice(2));
    }
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

/**
 * Reads `~/.gemini/antigravity-cli/antigravity-oauth-token` (or override path)
 * strictly read-only. Never writes or modifies the file.
 */
export function readLocalAgyCliToken(customPath?: string): {
  data: LocalAgyCliTokenData | null;
  filePath: string;
  error: string | null;
} {
  const filePath = resolveLocalAgyTokenPath(customPath);
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) {
      return {
        data: null,
        filePath,
        error: `Antigravity CLI token file not found at ${filePath}. Sign in with \`agy login\` or use Google OAuth.`,
      };
    }
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      data: null,
      filePath,
      error: `Could not read Antigravity CLI token file at ${filePath}: ${(err as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      data: null,
      filePath,
      error: `Antigravity CLI token file at ${filePath} is not valid JSON.`,
    };
  }

  const tokenObj =
    parsed.token && typeof parsed.token === 'object'
      ? (parsed.token as Record<string, unknown>)
      : parsed;

  const accessToken =
    typeof tokenObj.access_token === 'string' && tokenObj.access_token.trim()
      ? tokenObj.access_token.trim()
      : typeof tokenObj.accessToken === 'string' && tokenObj.accessToken.trim()
        ? tokenObj.accessToken.trim()
        : null;

  const refreshToken =
    typeof tokenObj.refresh_token === 'string' && tokenObj.refresh_token.trim()
      ? tokenObj.refresh_token.trim()
      : typeof tokenObj.refreshToken === 'string' && tokenObj.refreshToken.trim()
        ? tokenObj.refreshToken.trim()
        : null;

  if (!refreshToken && !accessToken) {
    return {
      data: null,
      filePath,
      error: `Antigravity CLI token file at ${filePath} does not contain a refresh_token or access_token.`,
    };
  }

  let expiresAt: number | null = null;
  if (typeof tokenObj.expiry === 'string' && tokenObj.expiry.trim()) {
    const ts = Date.parse(tokenObj.expiry.trim());
    if (Number.isFinite(ts)) expiresAt = ts;
  } else if (typeof tokenObj.expires_at === 'number' && Number.isFinite(tokenObj.expires_at)) {
    expiresAt = tokenObj.expires_at;
  }

  const authMethod =
    typeof parsed.auth_method === 'string' && parsed.auth_method.trim()
      ? parsed.auth_method.trim()
      : null;

  return {
    data: {
      accessToken,
      refreshToken,
      expiresAt,
      authMethod,
    },
    filePath,
    error: null,
  };
}

export function hasLocalAgyCliToken(customPath?: string): boolean {
  const { data } = readLocalAgyCliToken(customPath);
  return Boolean(data && (data.refreshToken || data.accessToken));
}

function decodeEmailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string' || !idToken.includes('.')) return null;
  try {
    const parts = idToken.split('.');
    if (parts.length < 2 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (typeof payload.email === 'string' && payload.email.trim()) {
      return payload.email.trim();
    }
  } catch {
    // Ignore malformed JWT
  }
  return null;
}

async function fetchGoogleUserEmail(
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(ANTIGRAVITY_OAUTH_USERINFO_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return typeof data.email === 'string' && data.email.trim() ? data.email.trim() : null;
  } catch {
    return null;
  }
}

async function refreshGoogleAccessTokenHttp(
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string | null;
}> {
  const res = await fetchImpl(ANTIGRAVITY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Antigravity OAuth token refresh failed (${res.status}): ${errText.slice(0, 300) || res.statusText}`,
    );
  }

  const tokens = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) {
    throw new Error('Antigravity OAuth token refresh response did not include an access_token.');
  }

  const expiresInSec =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : 3600;

  return {
    accessToken: tokens.access_token.trim(),
    refreshToken:
      typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim()
        ? tokens.refresh_token.trim()
        : refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    email: decodeEmailFromIdToken(tokens.id_token),
  };
}

function extractProjectId(val: unknown): string | null {
  if (typeof val === 'string' && val.trim()) return val.trim();
  if (val && typeof val === 'object') {
    const id = (val as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return null;
}

/**
 * Calls `/v1internal:loadCodeAssist` to discover the account's `cloudaicompanionProject`
 * and subscription tier. Only calls `/v1internal:onboardUser` when `allowOnboard` is
 * true (separate OAuth login with no existing project).
 */
export async function discoverAntigravityProject(opts: {
  accessToken: string;
  baseUrl?: string;
  allowOnboard: boolean;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<{
  projectId: string;
  gcpManaged: boolean;
  omitUserProjectHeader: boolean;
  planType: string | null;
  rateLimitTier: string | null;
}> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { platformEnum } = resolveAntigravityPlatformInfo();
  const metadata = {
    ideType: 9,
    platform: platformEnum,
    pluginType: 2,
  };

  const candidateBases = resolveCandidateBases(opts.baseUrl);
  let loadData: Record<string, unknown> | null = null;
  let activeBase = candidateBases[0]!;

  for (const base of candidateBases) {
    try {
      const res = await fetchImpl(`${base}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: buildAntigravityHeaders({
          accessToken: opts.accessToken,
          clientVersion: opts.clientVersion,
          contentType: 'application/json',
        }),
        body: JSON.stringify({ metadata }),
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        loadData = (await res.json()) as Record<string, unknown>;
        activeBase = base;
        break;
      }
    } catch {
      // Try next base URL
    }
  }

  let projectId = extractProjectId(loadData?.cloudaicompanionProject);
  const gcpManaged = Boolean(loadData?.gcpManaged);
  const paidTier =
    loadData?.paidTier && typeof loadData.paidTier === 'object'
      ? (loadData.paidTier as Record<string, unknown>)
      : null;
  const currentTier =
    loadData?.currentTier && typeof loadData.currentTier === 'object'
      ? (loadData.currentTier as Record<string, unknown>)
      : null;

  let resolvedPlanName: string | null =
    (typeof paidTier?.name === 'string' && paidTier.name.trim()) ||
    (typeof currentTier?.name === 'string' && currentTier.name.trim()) ||
    null;
  let resolvedTierId: string | null =
    (typeof paidTier?.id === 'string' && paidTier.id.trim()) ||
    (typeof currentTier?.id === 'string' && currentTier.id.trim()) ||
    null;

  if (!projectId && opts.allowOnboard && loadData) {
    const allowedTiers = Array.isArray(loadData.allowedTiers) ? loadData.allowedTiers : [];
    let onboardTierId = resolvedTierId || 'legacy-tier';
    for (const tier of allowedTiers) {
      if (tier && typeof tier === 'object' && (tier as Record<string, unknown>).isDefault) {
        const tObj = tier as Record<string, unknown>;
        if (typeof tObj.id === 'string' && tObj.id.trim()) {
          onboardTierId = tObj.id.trim();
          resolvedTierId = resolvedTierId ?? onboardTierId;
          if (!resolvedPlanName && typeof tObj.name === 'string' && tObj.name.trim()) {
            resolvedPlanName = tObj.name.trim();
          }
          break;
        }
      }
    }

    for (let attempt = 0; attempt < 3 && !projectId; attempt++) {
      try {
        const onboardRes = await fetchImpl(`${activeBase}/v1internal:onboardUser`, {
          method: 'POST',
          headers: buildAntigravityHeaders({
            accessToken: opts.accessToken,
            clientVersion: opts.clientVersion,
            contentType: 'application/json',
          }),
          body: JSON.stringify({
            tierId: onboardTierId,
            metadata,
          }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!onboardRes.ok) break;
        const onboardData = (await onboardRes.json()) as Record<string, unknown>;
        const responseObj =
          onboardData.response && typeof onboardData.response === 'object'
            ? (onboardData.response as Record<string, unknown>)
            : onboardData;
        projectId = extractProjectId(responseObj.cloudaicompanionProject);
        if (projectId || onboardData.done === true) break;
        await new Promise((r) => setTimeout(r, 1500));
      } catch {
        break;
      }
    }
  }

  return {
    projectId: projectId || DEFAULT_FALLBACK_PROJECT_ID,
    gcpManaged,
    omitUserProjectHeader: gcpManaged,
    planType: resolvedPlanName ?? resolvedTierId,
    rateLimitTier: resolvedTierId ?? resolvedPlanName,
  };
}

/**
 * Imports the local `agy` CLI token (`~/.gemini/antigravity-cli/antigravity-oauth-token`),
 * refreshes our own access token via Google's OAuth token endpoint (leaving the CLI's
 * token file untouched), discovers the Code Assist project and tier, and persists
 * encrypted credentials on the `planner_providers` row.
 */
export async function importLocalAgyCliTokenForProvider(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  customTokenPath?: string;
  clientVersion?: string;
}): Promise<PlannerProviderRow> {
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider || provider.kind !== 'antigravity-oauth') {
    throw new Error('Antigravity subscription provider not found.');
  }

  const { data: localToken, error } = readLocalAgyCliToken(opts.customTokenPath);
  if (!localToken || error) {
    throw new Error(error ?? 'Local Antigravity CLI login not found.');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  let accessToken = localToken.accessToken;
  let refreshToken = localToken.refreshToken;
  let expiresAt = localToken.expiresAt;
  let accountEmail: string | null = null;

  if (refreshToken) {
    const refreshed = await refreshGoogleAccessTokenHttp(refreshToken, fetchImpl);
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    expiresAt = refreshed.expiresAt;
    accountEmail = refreshed.email;
  }

  if (!accessToken) {
    throw new Error('Could not obtain an access token from the local Antigravity CLI login.');
  }

  if (!accountEmail) {
    accountEmail = await fetchGoogleUserEmail(accessToken, fetchImpl);
  }

  const projectInfo = await discoverAntigravityProject({
    accessToken,
    baseUrl: provider.baseUrl,
    allowOnboard: false,
    fetchImpl,
    clientVersion: opts.clientVersion,
  });

  const stored: AntigravityOAuthStoredCredentials = {
    mode: 'cli-import',
    accessToken,
    refreshToken,
    expiresAt,
    projectId: projectInfo.projectId,
    gcpManaged: projectInfo.gcpManaged,
    omitUserProjectHeader: projectInfo.omitUserProjectHeader,
    accountEmail,
    planType: projectInfo.planType,
    rateLimitTier: projectInfo.rateLimitTier,
  };

  const secretCiphertext = encryptAntigravityOAuthCredentials(stored, opts.encKey);
  const updated = updatePlannerProvider(opts.db, opts.providerId, {
    secretCiphertext,
    lastError: null,
  });
  return updated ?? provider;
}

// ---- Separate Google OAuth (PKCE + paste redirect URL) ----------------------

interface PendingAntigravityPkceSession {
  providerId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const pendingPkceByProviderId = new Map<string, PendingAntigravityPkceSession>();

function pruneExpiredPkceSessions(now = Date.now()): void {
  for (const [key, session] of pendingPkceByProviderId.entries()) {
    if (now - session.createdAt > PKCE_SESSION_TTL_MS) {
      pendingPkceByProviderId.delete(key);
    }
  }
}

export function startAntigravityOAuthAuthorization(providerId: string): ClaudeOAuthAuthorizeResponse {
  pruneExpiredPkceSessions();
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');
  const redirectUri = ANTIGRAVITY_OAUTH_REDIRECT_URI;

  pendingPkceByProviderId.set(providerId, {
    providerId,
    state,
    codeVerifier,
    redirectUri,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ANTIGRAVITY_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    authorizeUrl: `${ANTIGRAVITY_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

/**
 * Parses what the operator pastes back after Google redirects to
 * `http://127.0.0.1:51121/oauth-callback?code=...&state=...`:
 * supports a full URL, a query string (`?code=...&state=...`), `code#state`,
 * or a bare authorization code.
 */
export function parsePastedAntigravityOAuthCode(
  rawInput: string,
  explicitState?: string,
): { code: string; state: string | null; redirectUri: string | null } {
  const trimmed = rawInput.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const errParam = url.searchParams.get('error');
      if (errParam) {
        const desc = url.searchParams.get('error_description');
        throw new Error(`Google OAuth returned error: ${errParam}${desc ? ` (${desc})` : ''}`);
      }
      const qCode = url.searchParams.get('code');
      const qState = url.searchParams.get('state') ?? (url.hash ? url.hash.slice(1) : null);
      if (qCode) {
        const originAndPath = `${url.protocol}//${url.host}${url.pathname}`;
        return {
          code: qCode.trim(),
          state: (explicitState ?? qState)?.trim() || null,
          redirectUri: originAndPath,
        };
      }
    } catch (err) {
      if ((err as Error).message.startsWith('Google OAuth returned error:')) {
        throw err;
      }
    }
  }

  if (trimmed.startsWith('?') || (trimmed.includes('code=') && trimmed.includes('&'))) {
    const search = new URLSearchParams(trimmed.startsWith('?') ? trimmed.slice(1) : trimmed);
    const qCode = search.get('code');
    const qState = search.get('state');
    if (qCode) {
      return {
        code: qCode.trim(),
        state: (explicitState ?? qState)?.trim() || null,
        redirectUri: null,
      };
    }
  }

  const hashIdx = trimmed.indexOf('#');
  if (hashIdx >= 0) {
    const codePart = trimmed.slice(0, hashIdx).trim();
    const statePart = trimmed.slice(hashIdx + 1).trim();
    return {
      code: codePart,
      state: (explicitState?.trim() || statePart) || null,
      redirectUri: null,
    };
  }

  return {
    code: trimmed,
    state: explicitState?.trim() || null,
    redirectUri: null,
  };
}

export async function exchangeAntigravityOAuthCode(opts: {
  db: Db;
  providerId: string;
  code: string;
  state?: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<PlannerProviderRow> {
  pruneExpiredPkceSessions();
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider || provider.kind !== 'antigravity-oauth') {
    throw new Error('Antigravity subscription provider not found.');
  }

  const pending = pendingPkceByProviderId.get(opts.providerId);
  if (!pending) {
    throw new Error(
      'No active Google OAuth authorization session for this provider (or it expired). Click "Sign in with Google OAuth" again.',
    );
  }

  const parsed = parsePastedAntigravityOAuthCode(opts.code, opts.state);
  if (!parsed.code) {
    throw new Error('Authorization code is required.');
  }
  if (parsed.state && parsed.state !== pending.state) {
    throw new Error('OAuth state mismatch. Start a fresh "Sign in with Google OAuth" session and try again.');
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const redirectUri = parsed.redirectUri || pending.redirectUri;

  const tokenRes = await fetchImpl(ANTIGRAVITY_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: ANTIGRAVITY_OAUTH_CLIENT_ID,
      client_secret: ANTIGRAVITY_OAUTH_CLIENT_SECRET,
      code: parsed.code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pending.codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => '');
    throw new Error(
      `Google OAuth token exchange failed (${tokenRes.status}): ${errText.slice(0, 300) || tokenRes.statusText}`,
    );
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    id_token?: unknown;
  };
  if (typeof tokens.access_token !== 'string' || !tokens.access_token.trim()) {
    throw new Error('Google OAuth token response did not include an access_token.');
  }

  pendingPkceByProviderId.delete(opts.providerId);

  const accessToken = tokens.access_token.trim();
  const refreshToken =
    typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim()
      ? tokens.refresh_token.trim()
      : null;
  const expiresInSec =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : 3600;
  const expiresAt = Date.now() + expiresInSec * 1000;

  let accountEmail = decodeEmailFromIdToken(tokens.id_token);
  if (!accountEmail) {
    accountEmail = await fetchGoogleUserEmail(accessToken, fetchImpl);
  }

  const projectInfo = await discoverAntigravityProject({
    accessToken,
    baseUrl: provider.baseUrl,
    allowOnboard: true,
    fetchImpl,
    clientVersion: opts.clientVersion,
  });

  const stored: AntigravityOAuthStoredCredentials = {
    mode: 'oauth',
    accessToken,
    refreshToken,
    expiresAt,
    projectId: projectInfo.projectId,
    gcpManaged: projectInfo.gcpManaged,
    omitUserProjectHeader: projectInfo.omitUserProjectHeader,
    accountEmail,
    planType: projectInfo.planType,
    rateLimitTier: projectInfo.rateLimitTier,
  };

  const secretCiphertext = encryptAntigravityOAuthCredentials(stored, opts.encKey);
  const updated = updatePlannerProvider(opts.db, opts.providerId, {
    secretCiphertext,
    lastError: null,
  });
  return updated ?? provider;
}

// ---- Serialized token refresh ----------------------------------------------

const inFlightRefreshes = new Map<string, Promise<AntigravityOAuthStoredCredentials>>();

export async function ensureFreshAntigravityCredentials(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
  forceRefresh?: boolean;
}): Promise<{ provider: PlannerProviderRow; credentials: AntigravityOAuthStoredCredentials }> {
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider) {
    throw new PlannerLlmError('Pocket Agent provider no longer exists.');
  }

  const { credentials, error } = decryptAntigravityOAuthCredentials(provider, opts.encKey);
  if (error !== null) {
    throw new PlannerLlmError(error);
  }
  if (!credentials || (!credentials.accessToken && !credentials.refreshToken)) {
    throw new PlannerLlmError(
      `Provider "${provider.label}" has no Antigravity credentials configured. Import the signed-in agy CLI or sign in with Google OAuth in Settings -> Pocket Agent.`,
    );
  }

  const now = Date.now();
  const needsRefresh =
    opts.forceRefresh === true ||
    !credentials.accessToken ||
    (Boolean(credentials.refreshToken) &&
      typeof credentials.expiresAt === 'number' &&
      now + TOKEN_REFRESH_BUFFER_MS >= credentials.expiresAt);

  let activeCreds = credentials;
  if (needsRefresh && credentials.refreshToken) {
    let refreshPromise = inFlightRefreshes.get(opts.providerId);
    if (!refreshPromise) {
      refreshPromise = refreshStoredAntigravityToken({
        db: opts.db,
        providerId: opts.providerId,
        current: credentials,
        encKey: opts.encKey,
        fetchImpl: opts.fetchImpl ?? fetch,
        clientVersion: opts.clientVersion,
      }).finally(() => {
        inFlightRefreshes.delete(opts.providerId);
      });
      inFlightRefreshes.set(opts.providerId, refreshPromise);
    }
    activeCreds = await refreshPromise;
  }

  // Ensure projectId is populated and cached on the provider row.
  if (!activeCreds.projectId && activeCreds.accessToken) {
    const projectInfo = await discoverAntigravityProject({
      accessToken: activeCreds.accessToken,
      baseUrl: provider.baseUrl,
      allowOnboard: activeCreds.mode === 'oauth',
      fetchImpl: opts.fetchImpl ?? fetch,
      clientVersion: opts.clientVersion,
    });
    activeCreds = {
      ...activeCreds,
      projectId: projectInfo.projectId,
      gcpManaged: projectInfo.gcpManaged,
      omitUserProjectHeader: projectInfo.omitUserProjectHeader,
      planType: activeCreds.planType ?? projectInfo.planType,
      rateLimitTier: activeCreds.rateLimitTier ?? projectInfo.rateLimitTier,
    };
    if (opts.encKey !== undefined) {
      const secretCiphertext = encryptAntigravityOAuthCredentials(activeCreds, opts.encKey);
      updatePlannerProvider(opts.db, opts.providerId, { secretCiphertext });
    }
  }

  const refreshedProvider = readPlannerProvider(opts.db, opts.providerId) ?? provider;
  return { provider: refreshedProvider, credentials: activeCreds };
}

async function refreshStoredAntigravityToken(opts: {
  db: Db;
  providerId: string;
  current: AntigravityOAuthStoredCredentials;
  encKey: Buffer | undefined;
  fetchImpl: typeof fetch;
  clientVersion?: string;
}): Promise<AntigravityOAuthStoredCredentials> {
  if (!opts.current.refreshToken) return opts.current;
  let refreshed: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    email: string | null;
  };
  let nextRefreshToken = opts.current.refreshToken;
  try {
    refreshed = await refreshGoogleAccessTokenHttp(opts.current.refreshToken, opts.fetchImpl);
  } catch (err) {
    let recovered:
      | {
          accessToken: string;
          refreshToken: string;
          expiresAt: number;
          email: string | null;
        }
      | undefined;
    if (opts.current.mode === 'cli-import') {
      const localCli = readLocalAgyCliToken();
      if (
        localCli.data?.refreshToken &&
        localCli.data.refreshToken !== opts.current.refreshToken
      ) {
        try {
          recovered = await refreshGoogleAccessTokenHttp(
            localCli.data.refreshToken,
            opts.fetchImpl,
          );
          nextRefreshToken = localCli.data.refreshToken;
        } catch {
          // Fall through to throw original error.
        }
      }
    }
    if (!recovered) {
      const msg = `Antigravity OAuth token refresh failed: ${(err as Error).message}`;
      updatePlannerProvider(opts.db, opts.providerId, { lastError: msg });
      throw new PlannerLlmError(msg, 401, { retryable: false });
    }
    refreshed = recovered;
  }

  const next: AntigravityOAuthStoredCredentials = {
    ...opts.current,
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken || nextRefreshToken,
    expiresAt: refreshed.expiresAt,
    accountEmail: opts.current.accountEmail ?? refreshed.email,
  };

  if (!next.projectId) {
    const provider = readPlannerProvider(opts.db, opts.providerId);
    const projectInfo = await discoverAntigravityProject({
      accessToken: next.accessToken!,
      baseUrl: provider?.baseUrl,
      allowOnboard: next.mode === 'oauth',
      fetchImpl: opts.fetchImpl,
      clientVersion: opts.clientVersion,
    });
    next.projectId = projectInfo.projectId;
    next.gcpManaged = projectInfo.gcpManaged;
    next.omitUserProjectHeader = projectInfo.omitUserProjectHeader;
    next.planType = next.planType ?? projectInfo.planType;
    next.rateLimitTier = next.rateLimitTier ?? projectInfo.rateLimitTier;
  }

  const secretCiphertext = encryptAntigravityOAuthCredentials(next, opts.encKey);
  updatePlannerProvider(opts.db, opts.providerId, {
    secretCiphertext,
    lastError: null,
  });
  return next;
}

export function resolveCandidateBases(configuredBaseUrl?: string | null): string[] {
  const normalized = (configuredBaseUrl || DEFAULT_ANTIGRAVITY_OAUTH_BASE_URL)
    .trim()
    .replace(/\/+$/, '');
  const defaultSet = new Set<string>(ANTIGRAVITY_UPSTREAM_BASES);
  if (defaultSet.has(normalized)) {
    const others = ANTIGRAVITY_UPSTREAM_BASES.filter((b) => b !== normalized);
    return [normalized, ...others];
  }
  return [normalized];
}

async function fetchAntigravityWithProjectHeaderFallback(opts: {
  url: string;
  accessToken: string;
  projectId: string | null | undefined;
  omitUserProjectHeader: boolean | null | undefined;
  body: string;
  fetchImpl: typeof fetch;
  clientVersion?: string;
  accept?: string;
  signal?: AbortSignal;
  onOmitUserProjectDiscovered?: () => void;
}): Promise<Response> {
  let res = await opts.fetchImpl(opts.url, {
    method: 'POST',
    headers: buildAntigravityHeaders({
      accessToken: opts.accessToken,
      projectId: opts.projectId,
      omitUserProjectHeader: opts.omitUserProjectHeader,
      clientVersion: opts.clientVersion,
      contentType: 'application/json',
      accept: opts.accept,
    }),
    body: opts.body,
    signal: opts.signal,
  });

  // If `x-goog-user-project` was sent and rejected with 403 (`PERMISSION_DENIED` on
  // `gcpManaged` projects), retry immediately without `x-goog-user-project`.
  if (res.status === 403 && opts.projectId && !opts.omitUserProjectHeader) {
    opts.onOmitUserProjectDiscovered?.();
    res = await opts.fetchImpl(opts.url, {
      method: 'POST',
      headers: buildAntigravityHeaders({
        accessToken: opts.accessToken,
        projectId: opts.projectId,
        omitUserProjectHeader: true,
        clientVersion: opts.clientVersion,
        contentType: 'application/json',
        accept: opts.accept,
      }),
      body: opts.body,
      signal: opts.signal,
    });
  }

  return res;
}

// ---- Subscription Quota (`/v1internal:retrieveUserQuota`) ------------------

export async function fetchAntigravityOAuthUsage(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<ClaudeProviderUsageResponse> {
  const updatedAt = new Date().toISOString();
  try {
    const { provider, credentials } = await ensureFreshAntigravityCredentials(opts);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const bases = resolveCandidateBases(provider.baseUrl);
    const projectId = credentials.projectId || DEFAULT_FALLBACK_PROJECT_ID;
    let omitHeader = Boolean(credentials.omitUserProjectHeader ?? credentials.gcpManaged);

    const markOmitHeader = (): void => {
      omitHeader = true;
      if (opts.encKey !== undefined && !credentials.omitUserProjectHeader) {
        const nextCreds: AntigravityOAuthStoredCredentials = {
          ...credentials,
          omitUserProjectHeader: true,
        };
        updatePlannerProvider(opts.db, opts.providerId, {
          secretCiphertext: encryptAntigravityOAuthCredentials(nextCreds, opts.encKey),
        });
      }
    };

    let lastStatus = 0;
    let lastBody = '';

    for (const base of bases) {
      const res = await fetchAntigravityWithProjectHeaderFallback({
        url: `${base}/v1internal:retrieveUserQuota`,
        accessToken: credentials.accessToken!,
        projectId,
        omitUserProjectHeader: omitHeader,
        body: JSON.stringify({ project: projectId }),
        fetchImpl,
        clientVersion: opts.clientVersion,
        signal: AbortSignal.timeout(10_000),
        onOmitUserProjectDiscovered: markOmitHeader,
      });

      if (!res.ok) {
        lastStatus = res.status;
        lastBody = await res.text().catch(() => '');
        continue;
      }

      const data = (await res.json()) as { buckets?: unknown };
      const rawBuckets = Array.isArray(data.buckets) ? data.buckets : [];
      const windows: ClaudeProviderUsageWindow[] = [];
      const seenLabels = new Set<string>();

      for (const rawBucket of rawBuckets) {
        if (!rawBucket || typeof rawBucket !== 'object') continue;
        const b = rawBucket as {
          modelId?: unknown;
          remainingFraction?: unknown;
          resetTime?: unknown;
          tokenType?: unknown;
        };
        if (typeof b.modelId !== 'string' || !b.modelId.trim()) continue;
        // Skip internal raw chat_* buckets if standard model IDs are present.
        if (b.modelId.startsWith('chat_')) continue;
        const rem =
          typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
            ? Math.max(0, Math.min(1, b.remainingFraction))
            : null;
        if (rem === null) continue;
        const label = b.modelId.trim();
        if (seenLabels.has(label)) continue;
        seenLabels.add(label);
        windows.push({
          label,
          percentUsed: Math.max(0, Math.min(100, Math.round((1 - rem) * 100))),
          resetsAt: typeof b.resetTime === 'string' && b.resetTime.trim() ? b.resetTime.trim() : null,
        });
      }

      return {
        available: windows.length > 0,
        windows,
        error: null,
        updatedAt,
      };
    }

    return {
      available: false,
      windows: [],
      error: `Quota endpoint returned ${lastStatus}${lastBody ? `: ${lastBody.slice(0, 200)}` : ''}`,
      updatedAt,
    };
  } catch (err) {
    return {
      available: false,
      windows: [],
      error: (err as Error).message,
      updatedAt,
    };
  }
}

// ---- AntigravityOAuthPlannerProvider (implements PlannerLlmProvider) -------

export interface AntigravityOAuthPlannerProviderOptions {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  retry?: Partial<PlannerLlmRetryPolicy>;
  clientVersion?: string;
}

export class AntigravityOAuthPlannerProvider implements PlannerLlmProvider {
  constructor(private readonly opts: AntigravityOAuthPlannerProviderOptions) {}

  async listModels(): Promise<string[]> {
    const { provider, credentials } = await ensureFreshAntigravityCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
      clientVersion: this.opts.clientVersion,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const bases = resolveCandidateBases(provider.baseUrl);
    const projectId = credentials.projectId || DEFAULT_FALLBACK_PROJECT_ID;
    let omitHeader = Boolean(credentials.omitUserProjectHeader ?? credentials.gcpManaged);

    const markOmitHeader = (): void => {
      omitHeader = true;
      if (this.opts.encKey !== undefined && !credentials.omitUserProjectHeader) {
        const nextCreds: AntigravityOAuthStoredCredentials = {
          ...credentials,
          omitUserProjectHeader: true,
        };
        updatePlannerProvider(this.opts.db, this.opts.providerId, {
          secretCiphertext: encryptAntigravityOAuthCredentials(nextCreds, this.opts.encKey),
        });
      }
    };

    for (const base of bases) {
      try {
        const res = await fetchAntigravityWithProjectHeaderFallback({
          url: `${base}/v1internal:fetchAvailableModels`,
          accessToken: credentials.accessToken!,
          projectId,
          omitUserProjectHeader: omitHeader,
          body: JSON.stringify({ project: projectId }),
          fetchImpl,
          clientVersion: this.opts.clientVersion,
          signal: AbortSignal.timeout(10_000),
          onOmitUserProjectDiscovered: markOmitHeader,
        });
        if (!res.ok) continue;

        const parsed = (await res.json()) as {
          models?: Record<string, unknown>;
          agentModelSorts?: Array<{
            groups?: Array<{ modelIds?: unknown[] }>;
          }>;
        };

        const ordered: string[] = ['auto'];
        const seen = new Set<string>(['auto']);

        // 1. Add recommended agent models in their curated sort order first.
        if (Array.isArray(parsed.agentModelSorts)) {
          for (const sort of parsed.agentModelSorts) {
            if (!sort || !Array.isArray(sort.groups)) continue;
            for (const group of sort.groups) {
              if (!group || !Array.isArray(group.modelIds)) continue;
              for (const rawId of group.modelIds) {
                if (typeof rawId === 'string' && rawId.trim() && !seen.has(rawId.trim())) {
                  seen.add(rawId.trim());
                  ordered.push(rawId.trim());
                }
              }
            }
          }
        }

        // 2. Add remaining keys from `models` map (excluding raw `chat_*` internal IDs).
        if (parsed.models && typeof parsed.models === 'object') {
          for (const key of Object.keys(parsed.models)) {
            const trimmed = key.trim();
            if (!trimmed || trimmed.startsWith('chat_') || seen.has(trimmed)) continue;
            seen.add(trimmed);
            ordered.push(trimmed);
          }
        }

        // 3. Append any static fallback IDs not already present.
        for (const staticModel of ANTIGRAVITY_OAUTH_STATIC_MODELS) {
          if (!seen.has(staticModel.id)) {
            seen.add(staticModel.id);
            ordered.push(staticModel.id);
          }
        }

        if (ordered.length > 1) {
          return ordered;
        }
      } catch {
        // Try next base URL or fall back to static models.
      }
    }

    return ANTIGRAVITY_OAUTH_STATIC_MODELS.map((m) => m.id);
  }

  async test(model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      let content: string | null = null;
      for await (const chunk of this.streamComplete(
        model,
        [{ role: 'user', content: 'Reply with exactly one word: ok' }],
        undefined,
        undefined,
        { maxTokens: 64, thinking: false, effort: 'none' },
      )) {
        if (chunk.type === 'done') content = chunk.content;
      }
      return {
        ok: true,
        message: content ? content.trim().slice(0, 200) : '(empty reply)',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  async *streamComplete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options?: PlannerLlmStreamOptions,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const policy = { ...DEFAULT_LLM_RETRY_POLICY, ...this.opts.retry };
    let retriedAfter401Refresh = false;

    for (let attempt = 0; ; attempt++) {
      let streamedAnything = false;
      try {
        for await (const event of this.streamOnce(model, messages, tools, signal, options)) {
          if (event.type !== 'done') streamedAnything = true;
          yield event;
        }
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        const error = err instanceof PlannerLlmError ? err : new PlannerLlmError((err as Error).message);

        // If an access token was rejected with 401 before streaming, force one refresh and retry immediately.
        if (!streamedAnything && error.statusCode === 401 && !retriedAfter401Refresh) {
          const provider = readPlannerProvider(this.opts.db, this.opts.providerId);
          const { credentials } = provider
            ? decryptAntigravityOAuthCredentials(provider, this.opts.encKey)
            : { credentials: null };
          if (credentials?.refreshToken) {
            retriedAfter401Refresh = true;
            await ensureFreshAntigravityCredentials({
              db: this.opts.db,
              providerId: this.opts.providerId,
              encKey: this.opts.encKey,
              fetchImpl: this.opts.fetchImpl,
              clientVersion: this.opts.clientVersion,
              forceRefresh: true,
            });
            continue;
          }
        }

        if (streamedAnything || !error.retryable || attempt >= policy.maxRetries) throw error;
        let delayMs: number;
        if (error.retryAfterMs !== null) {
          if (error.retryAfterMs > policy.maxDelayMs) throw error;
          delayMs = error.retryAfterMs;
        } else {
          delayMs = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs) * (1 - Math.random() * 0.25);
        }
        delayMs = Math.round(delayMs);
        yield {
          type: 'retry',
          attempt: attempt + 1,
          maxRetries: policy.maxRetries,
          delayMs,
          reason: error.message,
        };
        await abortableSleep(delayMs, signal);
      }
    }
  }

  private async *streamOnce(
    model: string,
    messages: PlannerChatMessage[],
    tools: unknown[] | undefined,
    externalSignal: AbortSignal | undefined,
    options: PlannerLlmStreamOptions | undefined,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const { provider, credentials } = await ensureFreshAntigravityCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
      clientVersion: this.opts.clientVersion,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const bases = resolveCandidateBases(provider.baseUrl);
    const projectId = credentials.projectId || DEFAULT_FALLBACK_PROJECT_ID;
    let omitHeader = Boolean(credentials.omitUserProjectHeader ?? credentials.gcpManaged);

    const markOmitHeader = (): void => {
      omitHeader = true;
      if (this.opts.encKey !== undefined && !credentials.omitUserProjectHeader) {
        const nextCreds: AntigravityOAuthStoredCredentials = {
          ...credentials,
          omitUserProjectHeader: true,
        };
        updatePlannerProvider(this.opts.db, this.opts.providerId, {
          secretCiphertext: encryptAntigravityOAuthCredentials(nextCreds, this.opts.encKey),
        });
      }
    };

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const idleMs = options?.idleTimeoutMs ?? 0;
    let idledOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        controller.abort();
      }, idleMs);
    };
    const idleError = (): PlannerLlmError =>
      new PlannerLlmError(
        `Antigravity Code Assist API sent nothing for ${Math.round(idleMs / 1000)}s.`,
        undefined,
        { retryable: true },
      );
    const signal = controller.signal;

    try {
      armIdle();
      const built = buildAntigravityGeminiRequest({
        project: projectId,
        model,
        messages,
        tools,
        options,
      });
      const bodyStr = JSON.stringify(built.envelope);

      let res: Response | null = null;
      let lastError: PlannerLlmError | null = null;

      for (let i = 0; i < bases.length; i++) {
        const base = bases[i]!;
        const isLastBase = i === bases.length - 1;
        const url = `${base}/v1internal:streamGenerateContent?alt=sse`;

        try {
          res = await fetchAntigravityWithProjectHeaderFallback({
            url,
            accessToken: credentials.accessToken!,
            projectId,
            omitUserProjectHeader: omitHeader,
            body: bodyStr,
            fetchImpl,
            clientVersion: this.opts.clientVersion,
            accept: 'text/event-stream',
            signal,
            onOmitUserProjectDiscovered: markOmitHeader,
          });
        } catch (err) {
          const idle = idledOut ? idleError() : null;
          if (idle) throw idle;
          lastError = new PlannerLlmError(
            `Could not reach Antigravity Code Assist API: ${(err as Error).message}`,
            undefined,
            { retryable: !signal.aborted },
          );
          if (!isLastBase && !signal.aborted) {
            continue;
          }
          throw lastError;
        }
        armIdle();

        if (res.ok) {
          break;
        }

        const errBody = await res.text().catch(() => '');
        const formattedMsg = formatAntigravityErrorMessage(res.status, errBody, res.headers);
        const { retryAfterMs } = parseAntigravityRetryResetInfo(errBody, res.headers);
        const isQuota =
          isQuotaMessage(errBody) ||
          /exhausted your capacity/i.test(errBody) ||
          /quota/i.test(formattedMsg);
        const isGeoBlock = /user location is not supported/i.test(formattedMsg);

        lastError = new PlannerLlmError(formattedMsg, res.status, {
          retryable: !isGeoBlock && !isQuota && isRetryableStatus(res.status),
          contextOverflow: isContextOverflowMessage(errBody),
          retryAfterMs,
        });

        // Fall back from daily-cloudcode-pa.googleapis.com to cloudcode-pa.googleapis.com on 429/404/408/5xx.
        const shouldTryFallbackBase =
          !isLastBase &&
          !isGeoBlock &&
          (res.status === 429 || res.status === 404 || res.status === 408 || res.status >= 500);
        if (shouldTryFallbackBase) {
          res = null;
          continue;
        }

        throw lastError;
      }

      if (!res || !res.ok) {
        throw lastError ?? new PlannerLlmError('Antigravity Code Assist API request failed.');
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new PlannerLlmError('Antigravity Code Assist API returned no readable stream body.');
      }

      const decoder = new TextDecoder();
      const parser = new AntigravityGeminiSseParser(built.toolNameMap);

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          const chunkText = decoder.decode(value, { stream: true });
          for (const event of parser.feed(chunkText)) {
            yield event;
          }
        }
        const tail = decoder.decode();
        if (tail) {
          for (const event of parser.feed(tail)) {
            yield event;
          }
        }
      } catch (err) {
        if (err instanceof PlannerLlmError) throw err;
        const idle = idledOut ? idleError() : null;
        if (idle) throw idle;
        throw new PlannerLlmError(
          `Lost connection to Antigravity Code Assist API: ${(err as Error).message}`,
          undefined,
          { retryable: !signal.aborted },
        );
      }

      if (!parser.hasSeenChunk) {
        throw new PlannerLlmError('Antigravity Code Assist API returned an empty stream.', undefined, {
          retryable: true,
        });
      }

      const doneCompletion = parser.finish();
      yield { type: 'done', ...doneCompletion };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
