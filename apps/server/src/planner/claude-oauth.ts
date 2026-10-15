/**
 * PA-149: Claude subscription provider (`claude-oauth`) — setup-token and
 * copy-paste PKCE OAuth against Anthropic's Messages API (`/v1/messages?beta=true`).
 *
 * Adapted in part from OmniRoute (https://github.com/diegosouzapw/OmniRoute):
 *   - src/lib/oauth/providers/claude.ts
 *   - src/lib/oauth/constants/oauth.ts (CLAUDE_CONFIG)
 *   - open-sse/services/tokenRefresh/providers/claudeOAuth.ts
 *   - open-sse/executors/base.ts
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
import type {
  ClaudeOAuthAuthorizeResponse,
  ClaudeProviderUsageResponse,
  ClaudeProviderUsageWindow,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  ANTHROPIC_API_VERSION,
  AnthropicMessagesSseParser,
  DEFAULT_CLAUDE_CODE_VERSION,
  buildAnthropicMessagesRequest,
} from './claude-messages-translator.js';
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
  httpError,
} from './llm-client.js';
import {
  type ClaudeOAuthStoredCredentials,
  DEFAULT_CLAUDE_OAUTH_BASE_URL,
  type PlannerProviderRow,
  decryptClaudeOAuthCredentials,
  encryptClaudeOAuthCredentials,
  readPlannerProvider,
  updatePlannerProvider,
} from './store.js';

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_OAUTH_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
] as const;

export const CLAUDE_SETUP_TOKEN_PREFIX = 'sk-ant-oat';
const PKCE_SESSION_TTL_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Static model catalog fallback for `claude-oauth` when `/v1/models` is not
 * available for a subscription token (`staticModels` shape). Context windows
 * come from `KNOWN_MODEL_WINDOWS` in `context-budget.ts`.
 */
export const CLAUDE_OAUTH_STATIC_MODELS: readonly { id: string; name: string }[] = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
];

let cachedClientVersion: string | null = null;

/**
 * Resolves the `claude-cli/<ver>` version string once per process by reading
 * the installed `claude --version` if available, falling back to
 * `DEFAULT_CLAUDE_CODE_VERSION` (`2.1.280`). Never touches `~/.claude/`.
 */
export function resolveClaudeCodeClientVersion(claudeBin = 'claude'): string {
  if (cachedClientVersion !== null) return cachedClientVersion;
  try {
    const out = execFileSync(claudeBin, ['--version'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+\.\d+\.\d+)/.exec(out);
    cachedClientVersion = match?.[1] ?? DEFAULT_CLAUDE_CODE_VERSION;
  } catch {
    cachedClientVersion = DEFAULT_CLAUDE_CODE_VERSION;
  }
  return cachedClientVersion;
}

export function buildClaudeOAuthHeaders(opts: {
  accessToken: string;
  betas?: readonly string[];
  clientVersion?: string;
  accept?: string;
  contentType?: string;
}): Record<string, string> {
  const ver = opts.clientVersion ?? resolveClaudeCodeClientVersion();
  const betas =
    opts.betas && opts.betas.length > 0
      ? opts.betas.join(',')
      : 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,prompt-caching-scope-2026-01-05';
  return {
    ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    accept: opts.accept ?? 'application/json',
    authorization: `Bearer ${opts.accessToken}`,
    'anthropic-version': ANTHROPIC_API_VERSION,
    'anthropic-beta': betas,
    'user-agent': `claude-cli/${ver} (external, cli)`,
    'x-app': 'cli',
  };
}

function joinUrl(base: string, suffix: string): string {
  const normalizedBase = (base || DEFAULT_CLAUDE_OAUTH_BASE_URL).replace(/\/+$/, '');
  if (normalizedBase.endsWith('/v1') && suffix.startsWith('/v1/')) {
    return normalizedBase + suffix.slice(3);
  }
  return normalizedBase + suffix;
}

// ---- PKCE copy-paste OAuth state -------------------------------------------

interface PendingPkceSession {
  providerId: string;
  state: string;
  codeVerifier: string;
  createdAt: number;
}

const pendingPkceByProviderId = new Map<string, PendingPkceSession>();

function pruneExpiredPkceSessions(now = Date.now()): void {
  for (const [key, session] of pendingPkceByProviderId.entries()) {
    if (now - session.createdAt > PKCE_SESSION_TTL_MS) {
      pendingPkceByProviderId.delete(key);
    }
  }
}

export function startClaudeOAuthAuthorization(providerId: string): ClaudeOAuthAuthorizeResponse {
  pruneExpiredPkceSessions();
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('base64url');

  pendingPkceByProviderId.set(providerId, {
    providerId,
    state,
    codeVerifier,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    code: 'true',
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    response_type: 'code',
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    scope: CLAUDE_OAUTH_SCOPES.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'login',
  });

  return {
    authorizeUrl: `${CLAUDE_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
    state,
  };
}

/**
 * Parses what the operator pastes back from the Claude OAuth callback page:
 * supports `code#state`, a full callback URL (`https://platform.claude.com/oauth/code/callback?code=...&state=...`),
 * or a bare authorization code.
 */
export function parsePastedClaudeOAuthCode(
  rawCode: string,
  explicitState?: string,
): { code: string; state: string | null } {
  const trimmed = rawCode.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const qCode = url.searchParams.get('code');
      const qState = url.searchParams.get('state') ?? (url.hash ? url.hash.slice(1) : null);
      if (qCode) {
        return { code: qCode.trim(), state: (explicitState ?? qState)?.trim() || null };
      }
    } catch {
      // Fall through to `#` split
    }
  }
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx >= 0) {
    const codePart = trimmed.slice(0, hashIdx).trim();
    const statePart = trimmed.slice(hashIdx + 1).trim();
    return {
      code: codePart,
      state: (explicitState?.trim() || statePart) || null,
    };
  }
  return {
    code: trimmed,
    state: explicitState?.trim() || null,
  };
}

async function fetchBootstrapProfile(opts: {
  baseUrl: string;
  accessToken: string;
  fetchImpl: typeof fetch;
  clientVersion: string;
}): Promise<{
  accountEmail: string | null;
  organizationName: string | null;
  rateLimitTier: string | null;
}> {
  try {
    const res = await opts.fetchImpl(joinUrl(opts.baseUrl, '/api/claude_cli/bootstrap'), {
      method: 'GET',
      headers: buildClaudeOAuthHeaders({
        accessToken: opts.accessToken,
        betas: ['oauth-2025-04-20'],
        clientVersion: opts.clientVersion,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      return { accountEmail: null, organizationName: null, rateLimitTier: null };
    }
    const data = (await res.json()) as {
      oauth_account?: {
        account_email?: string;
        email?: string;
        organization_name?: string;
        organization_rate_limit_tier?: string;
        rate_limit_tier?: string;
      };
      account?: { email_address?: string; email?: string };
      organization?: { name?: string; rate_limit_tier?: string };
    };
    const oauthAccount = data?.oauth_account;
    return {
      accountEmail:
        oauthAccount?.account_email ??
        oauthAccount?.email ??
        data?.account?.email_address ??
        data?.account?.email ??
        null,
      organizationName: oauthAccount?.organization_name ?? data?.organization?.name ?? null,
      rateLimitTier:
        oauthAccount?.organization_rate_limit_tier ??
        oauthAccount?.rate_limit_tier ??
        data?.organization?.rate_limit_tier ??
        null,
    };
  } catch {
    return { accountEmail: null, organizationName: null, rateLimitTier: null };
  }
}

/**
 * Exchanges the authorization `code` (or `code#state`) for OAuth tokens and
 * best-effort profile metadata.
 */
export async function exchangeClaudeOAuthCode(opts: {
  providerId: string;
  rawCode: string;
  explicitState?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<ClaudeOAuthStoredCredentials> {
  pruneExpiredPkceSessions();
  const pending = pendingPkceByProviderId.get(opts.providerId);
  if (!pending) {
    throw new PlannerLlmError(
      'No active Claude OAuth sign-in session for this provider (or it expired). Click "Start OAuth Sign-In" again.',
      400,
    );
  }

  const { code, state } = parsePastedClaudeOAuthCode(opts.rawCode, opts.explicitState);
  if (!code) {
    throw new PlannerLlmError('Authorization code is required.', 400);
  }
  if (state && state !== pending.state) {
    throw new PlannerLlmError(
      'OAuth state mismatch. Please start a fresh sign-in and paste the matching code#state.',
      400,
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
  const clientVersion = opts.clientVersion ?? resolveClaudeCodeClientVersion();
  const tokenUrl = joinUrl(baseUrl, '/v1/oauth/token');

  let res: Response;
  try {
    res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-cli/${clientVersion} (external, cli)`,
      },
      body: JSON.stringify({
        code,
        state: state || pending.state,
        grant_type: 'authorization_code',
        client_id: CLAUDE_OAUTH_CLIENT_ID,
        redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
        code_verifier: pending.codeVerifier,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PlannerLlmError(`Could not reach Anthropic OAuth token endpoint: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PlannerLlmError(
      `Anthropic OAuth token exchange failed (${res.status}): ${body.slice(0, 400)}`,
      res.status,
    );
  }

  const tokens = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { email_address?: string; email?: string };
    organization?: { name?: string; rate_limit_tier?: string };
  };
  if (!tokens.access_token || typeof tokens.access_token !== 'string') {
    throw new PlannerLlmError('Anthropic OAuth token exchange returned no access_token.', 502);
  }

  pendingPkceByProviderId.delete(opts.providerId);

  const profile = await fetchBootstrapProfile({
    baseUrl,
    accessToken: tokens.access_token,
    fetchImpl,
    clientVersion,
  });

  const expiresInSec =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : 3600;

  return {
    mode: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null,
    expiresAt: Date.now() + expiresInSec * 1000,
    accountEmail:
      profile.accountEmail ?? tokens.account?.email_address ?? tokens.account?.email ?? null,
    organizationName: profile.organizationName ?? tokens.organization?.name ?? null,
    rateLimitTier: profile.rateLimitTier ?? tokens.organization?.rate_limit_tier ?? null,
  };
}

/**
 * Validates a `claude setup-token` with one live minimal Messages API request
 * before saving, per PA-149 ("Validate with one live request before saving.
 * No refresh means no conflict with the claude CLI's own login.").
 *
 * Real Claude Code setup-tokens typically start with "0AGY..." (or other
 * OAuth bearer token formats such as "sk-ant-oat..."). We do not restrict
 * by prefix, but guard against accidentally pasting standard API keys
 * ("sk-ant-api...") or raw OAuth authorization codes ("code#state"), and
 * verify the token against the live Messages API.
 */
export async function validateClaudeSetupToken(opts: {
  setupToken: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<ClaudeOAuthStoredCredentials> {
  let token = opts.setupToken.trim();

  // Strip accidental "export CLAUDE_CODE_OAUTH_TOKEN=..." wrapper if pasted verbatim
  const exportMatch = /^(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*['"]?([^'"]+)['"]?$/i.exec(token);
  if (exportMatch?.[1]) {
    token = exportMatch[1].trim();
  }
  // Strip surrounding quotes
  token = token.replace(/^['"]|['"]$/g, '').trim();

  if (token.length === 0) {
    throw new PlannerLlmError('Setup token cannot be empty.', 400);
  }

  if (token.startsWith('sk-ant-api')) {
    throw new PlannerLlmError(
      'This credential looks like an Anthropic API key ("sk-ant-api..."). For API keys, please use an Anthropic or OpenAI-compatible provider instead. Claude subscription providers require a token generated by `claude setup-token` or OAuth sign-in.',
      400,
    );
  }

  if (token.includes('#') || token.includes('oauth/code/callback') || /^(code=|\?code=)/i.test(token)) {
    throw new PlannerLlmError(
      'This looks like an OAuth authorization code or callback URL (code#state), not a setup token. If you are running `claude setup-token`, paste this code into your terminal prompt first to finish minting your 1-year token. Alternatively, click "Sign in with OAuth (copy-paste)" below to sign in directly from Pocket Agent.',
      400,
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
  const clientVersion = opts.clientVersion ?? resolveClaudeCodeClientVersion();
  const translated = buildAnthropicMessagesRequest({
    model: CLAUDE_OAUTH_STATIC_MODELS[0]!.id,
    messages: [{ role: 'user', content: 'test' }],
    streamOptions: { maxTokens: 1, thinking: false },
    clientVersion,
  });
  const requestBody = {
    ...translated.body,
    max_tokens: 1,
    stream: false,
  };

  const url = joinUrl(baseUrl, '/v1/messages?beta=true');
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: buildClaudeOAuthHeaders({
        accessToken: token,
        betas: translated.betas,
        clientVersion,
        contentType: 'application/json',
        accept: 'application/json',
      }),
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PlannerLlmError(
      `Could not validate Claude setup-token against ${baseUrl}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new PlannerLlmError(
        `Claude setup-token validation failed (401 Unauthorized): the token was not accepted by Anthropic. Make sure you pasted the final token output by \`claude setup-token\` (e.g. from \`export CLAUDE_CODE_OAUTH_TOKEN=...\`), not the intermediate authorization code from the browser. (Anthropic response: ${body.slice(0, 200)})`,
        401,
      );
    }
    throw new PlannerLlmError(
      `Claude setup-token validation failed (${res.status}): ${body.slice(0, 400)}`,
      res.status,
    );
  }

  const profile = await fetchBootstrapProfile({
    baseUrl,
    accessToken: token,
    fetchImpl,
    clientVersion,
  });

  return {
    mode: 'setup-token',
    accessToken: token,
    refreshToken: null,
    expiresAt: null,
    accountEmail: profile.accountEmail,
    organizationName: profile.organizationName,
    rateLimitTier: profile.rateLimitTier,
  };
}

// ---- Serialized OAuth refresh per provider ---------------------------------

const inFlightRefreshes = new Map<string, Promise<ClaudeOAuthStoredCredentials>>();

function isInvalidGrantFailure(status: number, bodyText: string): boolean {
  if (/invalid_grant/i.test(bodyText)) return true;
  if ((status === 400 || status === 401) && /invalid_request|revoked|expired/i.test(bodyText)) {
    return true;
  }
  return false;
}

/**
 * Ensures the `claude-oauth` provider has a valid access token. Setup-tokens
 * have no refresh token and are returned as-is. OAuth tokens with a refresh
 * token are refreshed under a per-provider mutex so concurrent turns or quota
 * checks never race two refresh requests (which would invalidate the rotated
 * refresh token). Persists the rotated token atomically in `planner_providers`.
 */
export async function ensureFreshClaudeCredentials(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
  forceRefresh?: boolean;
}): Promise<{ provider: PlannerProviderRow; credentials: ClaudeOAuthStoredCredentials }> {
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider) {
    throw new PlannerLlmError('Claude subscription provider not found.', 404);
  }
  const { credentials, error } = decryptClaudeOAuthCredentials(provider, opts.encKey);
  if (error !== null) {
    throw new PlannerLlmError(error, 409);
  }
  if (!credentials || !credentials.accessToken) {
    throw new PlannerLlmError(
      `Claude provider "${provider.label}" has no credentials configured. Paste a setup-token or sign in with OAuth in Settings → Providers & Models.`,
      401,
    );
  }

  if (credentials.mode === 'setup-token' || !credentials.refreshToken) {
    return { provider, credentials };
  }

  const needsRefresh =
    opts.forceRefresh === true ||
    (credentials.expiresAt !== null &&
      credentials.expiresAt !== undefined &&
      Date.now() + TOKEN_REFRESH_BUFFER_MS >= credentials.expiresAt);

  if (!needsRefresh) {
    return { provider, credentials };
  }

  let refreshPromise = inFlightRefreshes.get(provider.id);
  if (!refreshPromise) {
    refreshPromise = refreshClaudeOAuthToken({
      db: opts.db,
      providerId: provider.id,
      encKey: opts.encKey,
      fetchImpl: opts.fetchImpl ?? fetch,
      clientVersion: opts.clientVersion ?? resolveClaudeCodeClientVersion(),
    }).finally(() => {
      inFlightRefreshes.delete(provider.id);
    });
    inFlightRefreshes.set(provider.id, refreshPromise);
  }

  const refreshed = await refreshPromise;
  const updatedProvider = readPlannerProvider(opts.db, provider.id) ?? provider;
  return { provider: updatedProvider, credentials: refreshed };
}

async function refreshClaudeOAuthToken(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl: typeof fetch;
  clientVersion: string;
}): Promise<ClaudeOAuthStoredCredentials> {
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider) {
    throw new PlannerLlmError('Claude subscription provider not found.', 404);
  }
  const { credentials, error } = decryptClaudeOAuthCredentials(provider, opts.encKey);
  if (error !== null || !credentials || !credentials.refreshToken) {
    throw new PlannerLlmError(
      error ?? 'Claude OAuth provider has no refresh token; please sign in again.',
      401,
    );
  }

  const baseUrl = provider.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
  const tokenUrl = joinUrl(baseUrl, '/v1/oauth/token');
  const formBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: credentials.refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  }).toString();

  let res: Response;
  try {
    res = await opts.fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': `claude-cli/${opts.clientVersion} (external, cli)`,
      },
      body: formBody,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new PlannerLlmError(
      `Could not refresh Claude OAuth token: ${(err as Error).message}`,
      undefined,
      { retryable: true },
    );
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    if (isInvalidGrantFailure(res.status, bodyText)) {
      const signAgainMsg =
        'Claude OAuth session expired or was revoked (invalid_grant). Please sign in again in Settings → Providers & Models.';
      updatePlannerProvider(opts.db, provider.id, { lastError: signAgainMsg });
      throw new PlannerLlmError(signAgainMsg, 401, { retryable: false });
    }
    throw new PlannerLlmError(
      `Claude OAuth token refresh failed (${res.status}): ${bodyText.slice(0, 400)}`,
      res.status,
      { retryable: res.status >= 500 || res.status === 429 },
    );
  }

  const tokens = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { email_address?: string; email?: string };
    organization?: { name?: string; rate_limit_tier?: string };
  };
  if (!tokens.access_token || typeof tokens.access_token !== 'string') {
    throw new PlannerLlmError('Claude OAuth token refresh returned no access_token.', 502);
  }

  const expiresInSec =
    typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0
      ? tokens.expires_in
      : 3600;

  const updated: ClaudeOAuthStoredCredentials = {
    mode: 'oauth',
    accessToken: tokens.access_token,
    refreshToken:
      typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
        ? tokens.refresh_token
        : credentials.refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    accountEmail:
      tokens.account?.email_address ?? tokens.account?.email ?? credentials.accountEmail ?? null,
    organizationName: tokens.organization?.name ?? credentials.organizationName ?? null,
    rateLimitTier: tokens.organization?.rate_limit_tier ?? credentials.rateLimitTier ?? null,
  };

  // Persist rotated credentials atomically.
  const tx = opts.db.transaction(() => {
    const ciphertext = encryptClaudeOAuthCredentials(updated, opts.encKey);
    updatePlannerProvider(opts.db, provider.id, {
      secretCiphertext: ciphertext,
      lastError: null,
    });
  });
  tx();

  return updated;
}

// ---- Subscription 5h / 7d usage windows ------------------------------------

function parseUsageWindow(
  label: string,
  raw: unknown,
): ClaudeProviderUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as {
    utilization?: unknown;
    percent_used?: unknown;
    resets_at?: unknown;
  };
  let pct: number | null = null;
  if (typeof obj.utilization === 'number' && Number.isFinite(obj.utilization)) {
    // Anthropic returns utilization either as 0..100 or 0..1 depending on endpoint version.
    pct = obj.utilization <= 1 && obj.utilization > 0 ? Math.round(obj.utilization * 100) : Math.round(obj.utilization);
  } else if (typeof obj.percent_used === 'number' && Number.isFinite(obj.percent_used)) {
    pct = Math.round(obj.percent_used);
  }
  if (pct === null) return null;
  return {
    label,
    percentUsed: Math.max(0, Math.min(100, pct)),
    resetsAt: typeof obj.resets_at === 'string' ? obj.resets_at : null,
  };
}

export async function fetchClaudeOAuthUsage(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}): Promise<ClaudeProviderUsageResponse> {
  const updatedAt = new Date().toISOString();
  try {
    const { provider, credentials } = await ensureFreshClaudeCredentials(opts);
    const fetchImpl = opts.fetchImpl ?? fetch;
    const baseUrl = provider.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
    const res = await fetchImpl(joinUrl(baseUrl, '/api/oauth/usage'), {
      method: 'GET',
      headers: buildClaudeOAuthHeaders({
        accessToken: credentials.accessToken,
        betas: ['oauth-2025-04-20'],
        clientVersion: opts.clientVersion,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: false,
        windows: [],
        error: `Usage endpoint returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        updatedAt,
      };
    }
    const data = (await res.json()) as Record<string, unknown>;
    const windows: ClaudeProviderUsageWindow[] = [];
    const candidates: readonly [string, unknown][] = [
      ['5h', data.five_hour],
      ['7d', data.seven_day],
      ['7d Opus', data.seven_day_opus],
      ['7d Sonnet', data.seven_day_sonnet],
    ];
    for (const [label, raw] of candidates) {
      const win = parseUsageWindow(label, raw);
      if (win) windows.push(win);
    }
    return {
      available: windows.length > 0,
      windows,
      error: null,
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

// ---- ClaudeOAuthPlannerProvider (implements PlannerLlmProvider) ------------

export interface ClaudeOAuthPlannerProviderOptions {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch;
  retry?: Partial<PlannerLlmRetryPolicy>;
  clientVersion?: string;
}

export class ClaudeOAuthPlannerProvider implements PlannerLlmProvider {
  constructor(private readonly opts: ClaudeOAuthPlannerProviderOptions) {}

  async listModels(): Promise<string[]> {
    const { provider, credentials } = await ensureFreshClaudeCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
      clientVersion: this.opts.clientVersion,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const baseUrl = provider.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
    const url = joinUrl(baseUrl, '/v1/models?beta=true');

    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: buildClaudeOAuthHeaders({
          accessToken: credentials.accessToken,
          betas: ['oauth-2025-04-20'],
          clientVersion: this.opts.clientVersion,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const parsed = (await res.json()) as { data?: unknown };
        if (Array.isArray(parsed.data)) {
          const liveIds = parsed.data
            .map((entry) =>
              entry && typeof entry === 'object' ? String((entry as { id?: unknown }).id ?? '') : '',
            )
            .filter((id) => id.length > 0);
          if (liveIds.length > 0) {
            const seen = new Set(liveIds);
            for (const staticModel of CLAUDE_OAUTH_STATIC_MODELS) {
              if (!seen.has(staticModel.id)) liveIds.push(staticModel.id);
            }
            return liveIds;
          }
        }
      }
    } catch {
      // Fall back to static model catalog when /v1/models is unreachable or unsupported for OAuth tokens.
    }

    return CLAUDE_OAUTH_STATIC_MODELS.map((m) => m.id);
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
        { maxTokens: 32, thinking: false },
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

        // If an OAuth access token was rejected with 401 before streaming, force one refresh and retry immediately.
        if (!streamedAnything && error.statusCode === 401 && !retriedAfter401Refresh) {
          const provider = readPlannerProvider(this.opts.db, this.opts.providerId);
          const { credentials } = provider
            ? decryptClaudeOAuthCredentials(provider, this.opts.encKey)
            : { credentials: null };
          if (credentials?.mode === 'oauth' && credentials.refreshToken) {
            retriedAfter401Refresh = true;
            await ensureFreshClaudeCredentials({
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
        yield { type: 'retry', attempt: attempt + 1, maxRetries: policy.maxRetries, delayMs, reason: error.message };
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
    const { provider, credentials } = await ensureFreshClaudeCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
      clientVersion: this.opts.clientVersion,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const baseUrl = provider.baseUrl || DEFAULT_CLAUDE_OAUTH_BASE_URL;
    const url = joinUrl(baseUrl, '/v1/messages?beta=true');

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
      new PlannerLlmError(`Anthropic Messages API sent nothing for ${Math.round(idleMs / 1000)}s.`, undefined, {
        retryable: true,
      });
    const signal = controller.signal;

    try {
      armIdle();
      const clientVersion = this.opts.clientVersion ?? resolveClaudeCodeClientVersion();
      const translated = buildAnthropicMessagesRequest({
        model,
        messages,
        tools,
        streamOptions: options,
        clientVersion,
      });

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: buildClaudeOAuthHeaders({
            accessToken: credentials.accessToken,
            betas: translated.betas,
            clientVersion,
            contentType: 'application/json',
            accept: 'text/event-stream',
          }),
          body: JSON.stringify(translated.body),
          signal,
        });
      } catch (err) {
        const idle = idledOut ? idleError() : null;
        if (idle) throw idle;
        throw new PlannerLlmError(`Could not reach Anthropic Messages API: ${(err as Error).message}`, undefined, {
          retryable: !signal.aborted,
        });
      }
      armIdle();

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw httpError('Anthropic Messages API', res.status, body, res.headers);
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new PlannerLlmError('Anthropic Messages API returned no readable stream body.');
      }

      const decoder = new TextDecoder();
      const parser = new AnthropicMessagesSseParser();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n');
          while (boundary >= 0) {
            const line = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 1);
            for (const event of parser.feedLine(line)) {
              yield event;
            }
            boundary = buffer.indexOf('\n');
          }
        }
        if (buffer.length > 0) {
          for (const event of parser.feedLine(buffer)) {
            yield event;
          }
        }
      } catch (err) {
        if (err instanceof PlannerLlmError) throw err;
        const idle = idledOut ? idleError() : null;
        if (idle) throw idle;
        throw new PlannerLlmError(`Lost connection to Anthropic Messages API: ${(err as Error).message}`, undefined, {
          retryable: !signal.aborted,
        });
      }

      if (!parser.hasSeenChunk) {
        throw new PlannerLlmError('Anthropic Messages API returned an empty stream.', undefined, { retryable: true });
      }

      const doneEvent = parser.finish();
      if (doneEvent.content === null && doneEvent.toolCalls.length === 0 && doneEvent.reasoning === null) {
        throw new PlannerLlmError('Anthropic Messages API response had no message content or tool calls.');
      }

      yield doneEvent;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
