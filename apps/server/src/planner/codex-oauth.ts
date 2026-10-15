/**
 * Codex (ChatGPT subscription) provider (`codex-oauth`) for Pocket Agent (PA-150).
 *
 * Supports:
 * 1. Device-code OAuth login (`POST https://auth.openai.com/api/accounts/deviceauth/usercode`,
 *    user verification at `https://auth.openai.com/codex/device`, polling
 *    `/api/accounts/deviceauth/token`, and PKCE token exchange at
 *    `https://auth.openai.com/oauth/token`) with serialized refresh-token rotation
 *    (deliberately omitting `scope`).
 * 2. Read-only `~/.codex/auth.json` (`cli-readonly`) mode, re-read on every
 *    request, never refreshed, and never written.
 * 3. Streaming inference against `POST https://chatgpt.com/backend-api/codex/responses`
 *    via `codex-responses-translator.ts`.
 * 4. 5h / 7d quota tracking from `x-codex-*` headers and
 *    `GET https://chatgpt.com/backend-api/wham/usage`.
 *
 * Ported from OmniRoute (`src/lib/oauth/providers/codex.ts`,
 * `src/lib/oauth/codexDeviceFlow.ts`, `src/lib/oauth/constants/oauth.ts`,
 * `src/lib/oauth/services/codexImport.ts`,
 * `open-sse/services/tokenRefresh/providers/codex.ts`,
 * `open-sse/executors/codex.ts`, `open-sse/executors/codex/quota.ts`,
 * `open-sse/services/usage/codex.ts`):
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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ClaudeProviderUsageResponse,
  ClaudeProviderUsageWindow,
  CodexDeviceCodeExchangeRequest,
  CodexDeviceCodePollResponse,
  CodexDeviceCodeStartResponse,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  CODEX_OPENAI_BETA_HEADER,
  CODEX_ORIGINATOR,
  CodexResponsesSseParser,
  DEFAULT_CODEX_CLIENT_VERSION,
  buildCodexResponsesRequest,
} from './codex-responses-translator.js';
import {
  DEFAULT_LLM_RETRY_POLICY,
  PlannerLlmError,
  abortableSleep,
  httpError,
  type PlannerChatMessage,
  type PlannerLlmCompletion,
  type PlannerLlmProvider,
  type PlannerLlmRetryPolicy,
  type PlannerLlmStreamEvent,
  type PlannerLlmStreamOptions,
} from './llm-client.js';
import {
  DEFAULT_CODEX_OAUTH_BASE_URL,
  PlannerProviderStoreError,
  decryptCodexOAuthCredentials,
  encryptCodexOAuthCredentials,
  readPlannerProvider,
  recordPlannerProviderTestResult,
  toPlannerProviderDto,
  updatePlannerProvider,
  type CodexOAuthStoredCredentials,
  type PlannerProviderRow,
} from './store.js';

export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_BASE_URL = 'https://auth.openai.com';
export const CODEX_DEVICE_USERCODE_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const CODEX_DEVICE_VERIFY_URL = `${CODEX_AUTH_BASE_URL}/codex/device`;
export const CODEX_DEVICE_CALLBACK_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
export const CODEX_OAUTH_TOKEN_URL = `${CODEX_AUTH_BASE_URL}/oauth/token`;
export const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** Refresh ~5 minutes before expiry, not earlier (PA-150). */
export const CODEX_TOKEN_REFRESH_BUFFER_MS = 5 * 60_000;

/**
 * Static Codex model catalog (400k context window per OmniRoute), including
 * reasoning-effort suffix variants (`splitCodexReasoningSuffix` extracts the
 * suffix into `reasoning.effort` and sends the base model ID on the wire).
 */
export const CODEX_OAUTH_STATIC_MODELS: readonly string[] = [
  'gpt-5.5',
  'gpt-5.5-low',
  'gpt-5.5-medium',
  'gpt-5.5-high',
  'gpt-5.5-xhigh',
  'gpt-5.6-sol',
  'gpt-5.6-sol-low',
  'gpt-5.6-sol-medium',
  'gpt-5.6-sol-high',
  'gpt-5.6-sol-xhigh',
  'gpt-5.6-terra',
  'gpt-5.6-terra-low',
  'gpt-5.6-terra-medium',
  'gpt-5.6-terra-high',
  'gpt-5.6-terra-xhigh',
  'gpt-5.6-luna',
  'gpt-5.6-luna-low',
  'gpt-5.6-luna-medium',
  'gpt-5.6-luna-high',
  'gpt-5.6-luna-xhigh',
  'gpt-6-astra',
  'gpt-6-astra-low',
  'gpt-6-astra-medium',
  'gpt-6-astra-high',
  'gpt-6-astra-xhigh',
  'gpt-6-sol',
  'gpt-6-sol-low',
  'gpt-6-sol-medium',
  'gpt-6-sol-high',
  'gpt-6-sol-xhigh',
  'gpt-6.1-sol',
  'gpt-6.1-sol-low',
  'gpt-6.1-sol-medium',
  'gpt-6.1-sol-high',
  'gpt-6.1-sol-xhigh',
  'gpt-6-luna',
  'gpt-6-luna-low',
  'gpt-6-luna-medium',
  'gpt-6-luna-high',
  'gpt-6-luna-xhigh',
  'gpt-5.3-codex',
  'gpt-5.3-codex-low',
  'gpt-5.3-codex-medium',
  'gpt-5.3-codex-high',
  'gpt-5.3-codex-xhigh',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex',
  'gpt-5.1-codex-mini',
];

let cachedCodexClientVersion: string | null = null;

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolves the Codex CLI version reported in `Version` and `User-Agent` headers.
 * Reads the installed `codex --version` once per process and uses it if newer
 * than `DEFAULT_CODEX_CLIENT_VERSION` (`0.159.2`); otherwise falls back to
 * `DEFAULT_CODEX_CLIENT_VERSION`.
 */
export function resolveCodexClientVersion(): string {
  if (cachedCodexClientVersion) return cachedCodexClientVersion;
  const bin = process.env.POCKETAGENT_CODEX_BIN || 'codex';
  try {
    const out = execFileSync(bin, ['--version'], {
      timeout: 1500,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = /(\d+\.\d+\.\d+)/.exec(out);
    if (match?.[1] && compareSemver(match[1], DEFAULT_CODEX_CLIENT_VERSION) >= 0) {
      cachedCodexClientVersion = match[1];
      return cachedCodexClientVersion;
    }
  } catch {
    // Fall back to default constant when codex CLI is not installed.
  }
  cachedCodexClientVersion = DEFAULT_CODEX_CLIENT_VERSION;
  return cachedCodexClientVersion;
}

export function buildCodexUserAgent(clientVersion = resolveCodexClientVersion()): string {
  return `${CODEX_ORIGINATOR}/${clientVersion} (${os.platform()} ${os.release()}; ${os.arch()})`;
}

export function buildCodexResponsesHeaders(opts: {
  accessToken: string;
  accountId?: string | null | undefined;
  clientVersion?: string | undefined;
  sessionId?: string | null | undefined;
}): Record<string, string> {
  const version = opts.clientVersion ?? resolveCodexClientVersion();
  return {
    Authorization: `Bearer ${opts.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    originator: CODEX_ORIGINATOR,
    Version: version,
    'Openai-Beta': CODEX_OPENAI_BETA_HEADER,
    'User-Agent': buildCodexUserAgent(version),
    ...(opts.accountId ? { 'chatgpt-account-id': opts.accountId } : {}),
    ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
  };
}

export interface CodexJwtAccountMetadata {
  accountId: string | null;
  planType: string | null;
  accountEmail: string | null;
  organizationName: string | null;
  expiresAt: number | null;
}

export function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Extracts `chatgpt_account_id`, `chatgpt_plan_type`, `email`, organization
 * info, and `exp` from OpenAI's `id_token` / `access_token` JWT claims
 * (`https://api.openai.com/auth`).
 */
export function extractCodexAccountMetadata(
  idToken?: string | null,
  accessToken?: string | null,
  fallbackAccountId?: string | null,
): CodexJwtAccountMetadata {
  const idClaims = decodeJwtPayload(idToken);
  const accessClaims = decodeJwtPayload(accessToken);

  const idAuth =
    idClaims && typeof idClaims['https://api.openai.com/auth'] === 'object' && idClaims['https://api.openai.com/auth']
      ? (idClaims['https://api.openai.com/auth'] as Record<string, unknown>)
      : null;
  const accessAuth =
    accessClaims &&
    typeof accessClaims['https://api.openai.com/auth'] === 'object' &&
    accessClaims['https://api.openai.com/auth']
      ? (accessClaims['https://api.openai.com/auth'] as Record<string, unknown>)
      : null;

  let accountId =
    (typeof idAuth?.chatgpt_account_id === 'string' && idAuth.chatgpt_account_id) ||
    (typeof accessAuth?.chatgpt_account_id === 'string' && accessAuth.chatgpt_account_id) ||
    (typeof fallbackAccountId === 'string' && fallbackAccountId) ||
    null;

  const planType =
    (typeof idAuth?.chatgpt_plan_type === 'string' && idAuth.chatgpt_plan_type) ||
    (typeof accessAuth?.chatgpt_plan_type === 'string' && accessAuth.chatgpt_plan_type) ||
    null;

  let organizationName: string | null = null;
  const orgs = Array.isArray(idAuth?.organizations)
    ? idAuth.organizations
    : Array.isArray(accessAuth?.organizations)
      ? accessAuth.organizations
      : [];
  if (orgs.length > 0) {
    const nonDefaultOrg = orgs.find(
      (o): o is Record<string, unknown> => Boolean(o && typeof o === 'object' && !(o as { is_default?: unknown }).is_default),
    );
    const defaultOrg = orgs.find(
      (o): o is Record<string, unknown> => Boolean(o && typeof o === 'object'),
    );
    const chosenOrg =
      (!planType || planType === 'free') && nonDefaultOrg ? nonDefaultOrg : (nonDefaultOrg ?? defaultOrg);
    if (chosenOrg) {
      if (typeof chosenOrg.title === 'string' && chosenOrg.title.trim()) {
        organizationName = chosenOrg.title.trim();
      }
      if ((!planType || planType === 'free') && nonDefaultOrg && typeof nonDefaultOrg.id === 'string' && nonDefaultOrg.id) {
        accountId = nonDefaultOrg.id;
      }
    }
  }

  const profileClaims =
    accessClaims &&
    typeof accessClaims['https://api.openai.com/profile'] === 'object' &&
    accessClaims['https://api.openai.com/profile']
      ? (accessClaims['https://api.openai.com/profile'] as Record<string, unknown>)
      : null;

  const accountEmail =
    (typeof idClaims?.email === 'string' && idClaims.email) ||
    (typeof accessClaims?.email === 'string' && accessClaims.email) ||
    (typeof profileClaims?.email === 'string' && profileClaims.email) ||
    null;

  const expSec =
    typeof accessClaims?.exp === 'number'
      ? accessClaims.exp
      : typeof idClaims?.exp === 'number'
        ? idClaims.exp
        : null;
  const expiresAt = expSec && Number.isFinite(expSec) ? expSec * 1000 : null;

  return {
    accountId,
    planType,
    accountEmail,
    organizationName,
    expiresAt,
  };
}

// ---- Read-only ~/.codex/auth.json support -----------------------------------

export interface CodexCliAuthState {
  filePath: string;
  exists: boolean;
  accessToken: string | null;
  accountId: string | null;
  planType: string | null;
  accountEmail: string | null;
  organizationName: string | null;
  expiresAt: number | null;
  expired: boolean;
  error: string | null;
}

export function resolveCodexCliAuthFilePath(): string {
  const override = process.env.POCKETAGENT_CODEX_AUTH_FILE?.trim();
  if (override) return override;
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'auth.json');
}

/**
 * Reads `~/.codex/auth.json` strictly read-only (`fs.readFileSync`).
 * Never writes, touches, or refreshes that file.
 */
export function readCodexCliAuthJson(customPath?: string): CodexCliAuthState {
  const filePath = customPath ?? resolveCodexCliAuthFilePath();
  let rawText: string;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        filePath,
        exists: false,
        accessToken: null,
        accountId: null,
        planType: null,
        accountEmail: null,
        organizationName: null,
        expiresAt: null,
        expired: false,
        error: `Codex CLI auth file not found at ${filePath} — run codex once to sign in.`,
      };
    }
    return {
      filePath,
      exists: false,
      accessToken: null,
      accountId: null,
      planType: null,
      accountEmail: null,
      organizationName: null,
      expiresAt: null,
      expired: false,
      error: `Could not read ${filePath}: ${(err as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const json: unknown = JSON.parse(rawText);
    if (!json || typeof json !== 'object') {
      throw new Error('Root value is not an object');
    }
    parsed = json as Record<string, unknown>;
  } catch (err) {
    return {
      filePath,
      exists: true,
      accessToken: null,
      accountId: null,
      planType: null,
      accountEmail: null,
      organizationName: null,
      expiresAt: null,
      expired: false,
      error: `Invalid JSON in ${filePath}: ${(err as Error).message}`,
    };
  }

  const tokensObj =
    parsed.tokens && typeof parsed.tokens === 'object'
      ? (parsed.tokens as Record<string, unknown>)
      : parsed;
  const accessToken =
    typeof tokensObj.access_token === 'string' && tokensObj.access_token.trim().length > 0
      ? tokensObj.access_token.trim()
      : null;
  const idToken =
    typeof tokensObj.id_token === 'string' && tokensObj.id_token.trim().length > 0
      ? tokensObj.id_token.trim()
      : null;
  const rawAccountId =
    typeof tokensObj.account_id === 'string' && tokensObj.account_id.trim().length > 0
      ? tokensObj.account_id.trim()
      : null;

  if (!accessToken) {
    return {
      filePath,
      exists: true,
      accessToken: null,
      accountId: rawAccountId,
      planType: null,
      accountEmail: null,
      organizationName: null,
      expiresAt: null,
      expired: false,
      error: `No tokens.access_token found in ${filePath} — run codex once to refresh.`,
    };
  }

  const meta = extractCodexAccountMetadata(idToken, accessToken, rawAccountId);
  const expired = meta.expiresAt !== null && meta.expiresAt <= Date.now();
  return {
    filePath,
    exists: true,
    accessToken,
    accountId: meta.accountId,
    planType: meta.planType,
    accountEmail: meta.accountEmail,
    organizationName: meta.organizationName,
    expiresAt: meta.expiresAt,
    expired,
    error: expired ? 'Codex CLI token in ~/.codex/auth.json is expired — run codex once to refresh.' : null,
  };
}

// ---- Device-code login flow -------------------------------------------------

interface PendingCodexDeviceSession {
  providerId: string;
  deviceAuthId: string;
  userCode: string;
  intervalSec: number;
  createdAt: number;
}

const pendingDeviceSessions = new Map<string, PendingCodexDeviceSession>();
const DEVICE_SESSION_TTL_MS = 15 * 60_000;

function prunePendingDeviceSessions(): void {
  const now = Date.now();
  for (const [key, session] of pendingDeviceSessions) {
    if (now - session.createdAt > DEVICE_SESSION_TTL_MS) {
      pendingDeviceSessions.delete(key);
    }
  }
}

/**
 * Initiates OpenAI's custom device-code login flow (`POST /api/accounts/deviceauth/usercode`).
 * Attempts the call server-side first; if `auth.openai.com` blocks or refuses
 * the server IP (e.g. 403 Cloudflare challenge or network error), returns
 * `mode: 'browser'` so the browser UI can run the flow directly.
 */
export async function startCodexDeviceFlow(
  providerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexDeviceCodeStartResponse> {
  prunePendingDeviceSessions();

  let res: Response;
  try {
    res = await fetchImpl(CODEX_DEVICE_USERCODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return {
      mode: 'browser',
      intervalSec: 5,
      verificationUri: CODEX_DEVICE_VERIFY_URL,
      clientId: CODEX_OAUTH_CLIENT_ID,
      fallbackReason: `Server could not reach auth.openai.com (${(err as Error).message}); falling back to browser-side device flow.`,
    };
  }

  if (res.status === 404) {
    throw new PlannerProviderStoreError(
      'Codex device-code login is not enabled for this ChatGPT account or workspace (404). Enable device-code authentication in your ChatGPT security settings and try again.',
      'invalid',
      400,
    );
  }

  if (res.status === 403 || res.status === 429 || res.status >= 500) {
    const body = await res.text().catch(() => '');
    return {
      mode: 'browser',
      intervalSec: 5,
      verificationUri: CODEX_DEVICE_VERIFY_URL,
      clientId: CODEX_OAUTH_CLIENT_ID,
      fallbackReason: `auth.openai.com refused server-side device-code request (${res.status}${body ? `: ${body.slice(0, 120)}` : ''}); falling back to browser-side device flow.`,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PlannerProviderStoreError(
      `Codex device-code request failed (${res.status}): ${body.slice(0, 300)}`,
      'invalid',
      400,
    );
  }

  const data = (await res.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    usercode?: unknown;
    interval?: unknown;
  };
  const deviceAuthId = typeof data.device_auth_id === 'string' ? data.device_auth_id.trim() : '';
  const userCode =
    typeof data.user_code === 'string' && data.user_code.trim()
      ? data.user_code.trim()
      : typeof data.usercode === 'string' && data.usercode.trim()
        ? data.usercode.trim()
        : '';
  const parsedInterval = Number.parseInt(String(data.interval ?? '5'), 10);
  const intervalSec = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 5;

  if (!deviceAuthId || !userCode) {
    throw new PlannerProviderStoreError(
      'Codex device-code endpoint did not return a device_auth_id and user_code.',
      'invalid',
      400,
    );
  }

  pendingDeviceSessions.set(providerId, {
    providerId,
    deviceAuthId,
    userCode,
    intervalSec,
    createdAt: Date.now(),
  });

  return {
    mode: 'server',
    deviceAuthId,
    userCode,
    intervalSec,
    verificationUri: CODEX_DEVICE_VERIFY_URL,
    clientId: CODEX_OAUTH_CLIENT_ID,
    fallbackReason: null,
  };
}

async function exchangeAuthorizationCodeForTokens(
  authorizationCode: string,
  codeVerifier: string,
  fetchImpl: typeof fetch,
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number | null;
}> {
  const res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_OAUTH_CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: CODEX_DEVICE_CALLBACK_URI,
    }).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new PlannerProviderStoreError(
      `Codex OAuth token exchange failed (${res.status}): ${errText.slice(0, 300)}`,
      'invalid',
      400,
    );
  }

  const tokens = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
  };
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  if (!accessToken) {
    throw new PlannerProviderStoreError(
      'Codex OAuth token endpoint did not return an access_token.',
      'invalid',
      400,
    );
  }
  return {
    accessToken,
    refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token.trim() ? tokens.refresh_token.trim() : null,
    idToken: typeof tokens.id_token === 'string' && tokens.id_token.trim() ? tokens.id_token.trim() : null,
    expiresIn: typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in) ? tokens.expires_in : null,
  };
}

function saveCodexDeviceCredentials(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresIn: number | null;
}): PlannerProviderRow {
  const meta = extractCodexAccountMetadata(opts.idToken, opts.accessToken);
  const expiresAt =
    opts.expiresIn && opts.expiresIn > 0
      ? Date.now() + opts.expiresIn * 1000
      : (meta.expiresAt ?? Date.now() + 3600 * 1000);

  const creds: CodexOAuthStoredCredentials = {
    mode: 'device-code',
    accessToken: opts.accessToken,
    refreshToken: opts.refreshToken,
    expiresAt,
    accountId: meta.accountId,
    planType: meta.planType,
    accountEmail: meta.accountEmail,
    organizationName: meta.organizationName,
  };

  const secretCiphertext = encryptCodexOAuthCredentials(creds, opts.encKey);
  const updated = updatePlannerProvider(opts.db, opts.providerId, {
    secretCiphertext,
    lastTestedAt: Date.now(),
    lastError: null,
  });
  if (!updated) {
    throw new PlannerProviderStoreError('Provider not found.', 'not_found', 404);
  }
  return updated;
}

/**
 * Polls `POST https://auth.openai.com/api/accounts/deviceauth/token` once for
 * the pending device-code session. Returns `{ status: 'pending' }` while
 * OpenAI responds with 403/404, or exchanges the returned `{ authorization_code, code_verifier }`
 * at `https://auth.openai.com/oauth/token` and persists the encrypted credentials.
 */
export async function pollCodexDeviceFlow(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  deviceAuthId: string;
  userCode: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<CodexDeviceCodePollResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(CODEX_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        device_auth_id: opts.deviceAuthId,
        user_code: opts.userCode,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new PlannerProviderStoreError(
      `Could not reach Codex device-code poll endpoint: ${(err as Error).message}`,
      'invalid',
      502,
    );
  }

  // 403 Forbidden or 404 Not Found indicates user has not yet entered the code.
  if (res.status === 403 || res.status === 404) {
    return { status: 'pending' };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PlannerProviderStoreError(
      `Codex device-code polling failed (${res.status}): ${body.slice(0, 300)}`,
      'invalid',
      400,
    );
  }

  const pollData = (await res.json()) as {
    authorization_code?: unknown;
    code_verifier?: unknown;
  };
  const authorizationCode =
    typeof pollData.authorization_code === 'string' ? pollData.authorization_code.trim() : '';
  const codeVerifier =
    typeof pollData.code_verifier === 'string' ? pollData.code_verifier.trim() : '';
  if (!authorizationCode || !codeVerifier) {
    throw new PlannerProviderStoreError(
      'Codex device-code poll response lacked authorization_code or code_verifier.',
      'invalid',
      400,
    );
  }

  const exchanged = await exchangeAuthorizationCodeForTokens(authorizationCode, codeVerifier, fetchImpl);
  pendingDeviceSessions.delete(opts.providerId);
  const updated = saveCodexDeviceCredentials({
    db: opts.db,
    providerId: opts.providerId,
    encKey: opts.encKey,
    ...exchanged,
  });
  return {
    status: 'completed',
    provider: toPlannerProviderDto(updated, opts.encKey),
  };
}

/**
 * Completes a browser-fallback device login by either exchanging
 * `{ authorizationCode, codeVerifier }` or saving tokens obtained directly by
 * the browser from `auth.openai.com`.
 */
export async function completeCodexBrowserDeviceFlow(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  body: CodexDeviceCodeExchangeRequest;
  fetchImpl?: typeof fetch | undefined;
}): Promise<PlannerProviderRow> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (opts.body.accessToken && opts.body.accessToken.trim()) {
    pendingDeviceSessions.delete(opts.providerId);
    return saveCodexDeviceCredentials({
      db: opts.db,
      providerId: opts.providerId,
      encKey: opts.encKey,
      accessToken: opts.body.accessToken.trim(),
      refreshToken: opts.body.refreshToken?.trim() || null,
      idToken: opts.body.idToken?.trim() || null,
      expiresIn: opts.body.expiresIn ?? null,
    });
  }
  if (opts.body.authorizationCode && opts.body.codeVerifier) {
    const exchanged = await exchangeAuthorizationCodeForTokens(
      opts.body.authorizationCode.trim(),
      opts.body.codeVerifier.trim(),
      fetchImpl,
    );
    pendingDeviceSessions.delete(opts.providerId);
    return saveCodexDeviceCredentials({
      db: opts.db,
      providerId: opts.providerId,
      encKey: opts.encKey,
      ...exchanged,
    });
  }
  throw new PlannerProviderStoreError(
    'Provide either authorizationCode + codeVerifier or accessToken to complete Codex sign-in.',
    'invalid',
    400,
  );
}

// ---- Serialized token refresh -----------------------------------------------

const inFlightRefreshes = new Map<string, Promise<CodexOAuthStoredCredentials>>();

const UNRECOVERABLE_REFRESH_CODES = new Set([
  'refresh_token_reused',
  'invalid_grant',
  'token_expired',
  'invalid_token',
]);

function parseOAuthErrorCode(bodyText: string): { code: string | null; message: string } {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: unknown;
      error_description?: unknown;
      message?: unknown;
    };
    if (typeof parsed.error === 'string') {
      const desc = typeof parsed.error_description === 'string' ? parsed.error_description : parsed.error;
      return { code: parsed.error, message: desc };
    }
    if (parsed.error && typeof parsed.error === 'object') {
      const errObj = parsed.error as { code?: unknown; type?: unknown; message?: unknown };
      const code =
        typeof errObj.code === 'string'
          ? errObj.code
          : typeof errObj.type === 'string'
            ? errObj.type
            : null;
      const msg = typeof errObj.message === 'string' ? errObj.message : bodyText;
      return { code, message: msg };
    }
  } catch {
    // Plaintext body
  }
  return { code: null, message: bodyText };
}

/**
 * Ensures the `codex-oauth` provider has a fresh access token.
 * - In `cli-readonly` mode: re-reads `~/.codex/auth.json` read-only on every call
 *   and fails with `"run codex once to refresh"` if expired.
 * - In `device-code` mode: refreshes ~5 minutes before expiry (never earlier),
 *   serializes concurrent refreshes per provider, omits `scope` on the refresh
 *   form POST, and atomically persists rotated tokens in SQLite.
 */
export async function ensureFreshCodexCredentials(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<{ accessToken: string; accountId: string | null; mode: 'device-code' | 'cli-readonly' }> {
  const provider = readPlannerProvider(opts.db, opts.providerId);
  if (!provider) {
    throw new PlannerLlmError('Codex provider no longer exists.', 404, { retryable: false });
  }
  const { credentials, error } = decryptCodexOAuthCredentials(provider, opts.encKey);
  if (error !== null) {
    throw new PlannerLlmError(error, 401, { retryable: false });
  }

  if (credentials?.mode === 'cli-readonly') {
    const cliState = readCodexCliAuthJson();
    if (!cliState.accessToken || cliState.expired || cliState.error) {
      const msg =
        cliState.error ??
        'Codex CLI token in ~/.codex/auth.json is expired — run codex once to refresh.';
      recordPlannerProviderTestResult(opts.db, opts.providerId, { ok: false, error: msg });
      throw new PlannerLlmError(msg, 401, { retryable: false });
    }
    return {
      accessToken: cliState.accessToken,
      accountId: cliState.accountId,
      mode: 'cli-readonly',
    };
  }

  if (!credentials || !credentials.accessToken) {
    throw new PlannerLlmError(
      `Codex provider "${provider.label}" has no credentials configured. Sign in with device code or select ~/.codex/auth.json in Settings → Providers & Models.`,
      401,
      { retryable: false },
    );
  }

  const now = Date.now();
  if (!credentials.expiresAt || credentials.expiresAt - now > CODEX_TOKEN_REFRESH_BUFFER_MS) {
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId ?? null,
      mode: 'device-code',
    };
  }

  if (!credentials.refreshToken) {
    if (credentials.expiresAt <= now) {
      const msg = 'Codex OAuth access token has expired and no refresh token is available — please sign in again.';
      recordPlannerProviderTestResult(opts.db, opts.providerId, { ok: false, error: msg });
      throw new PlannerLlmError(msg, 401, { retryable: false });
    }
    return {
      accessToken: credentials.accessToken,
      accountId: credentials.accountId ?? null,
      mode: 'device-code',
    };
  }

  const existingRefresh = inFlightRefreshes.get(opts.providerId);
  if (existingRefresh) {
    const refreshed = await existingRefresh;
    return {
      accessToken: refreshed.accessToken!,
      accountId: refreshed.accountId ?? null,
      mode: 'device-code',
    };
  }

  const refreshPromise = (async (): Promise<CodexOAuthStoredCredentials> => {
    const latestRow = readPlannerProvider(opts.db, opts.providerId);
    if (!latestRow) {
      throw new PlannerLlmError('Codex provider no longer exists.', 404, { retryable: false });
    }
    const latestDecrypted = decryptCodexOAuthCredentials(latestRow, opts.encKey);
    if (latestDecrypted.error !== null || !latestDecrypted.credentials) {
      throw new PlannerLlmError(
        latestDecrypted.error ?? 'Codex provider credentials are missing.',
        401,
        { retryable: false },
      );
    }
    const latestCreds = latestDecrypted.credentials;
    if (latestCreds.expiresAt && latestCreds.expiresAt - Date.now() > CODEX_TOKEN_REFRESH_BUFFER_MS && latestCreds.accessToken) {
      return latestCreds;
    }
    if (!latestCreds.refreshToken) {
      throw new PlannerLlmError('Codex OAuth refresh token is missing — please sign in again.', 401, {
        retryable: false,
      });
    }

    const fetchImpl = opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      // Deliberately omit `scope` on refresh_token requests: Auth0 treats a scope
      // subset on refresh as a re-scope and invalidates sibling refresh token families.
      res = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: latestCreds.refreshToken,
          client_id: CODEX_OAUTH_CLIENT_ID,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new PlannerLlmError(
        `Could not reach Codex OAuth token endpoint to refresh credentials: ${(err as Error).message}`,
        502,
        { retryable: true },
      );
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const { code, message } = parseOAuthErrorCode(errBody);
      const isUnrecoverable =
        res.status === 401 ||
        (code !== null && UNRECOVERABLE_REFRESH_CODES.has(code)) ||
        /refresh_token_reused|invalid_grant|token_expired|invalid_token/i.test(errBody);
      if (isUnrecoverable) {
        const signAgainMsg = `Codex OAuth token refresh failed (${code ?? res.status}): ${message.slice(0, 200)} — please sign in again in Settings → Providers & Models.`;
        recordPlannerProviderTestResult(opts.db, opts.providerId, {
          ok: false,
          error: signAgainMsg,
        });
        throw new PlannerLlmError(signAgainMsg, 401, { retryable: false });
      }
      throw new PlannerLlmError(
        `Codex OAuth token refresh returned ${res.status}: ${errBody.slice(0, 300)}`,
        res.status,
        { retryable: res.status >= 500 || res.status === 429 },
      );
    }

    const tokenData = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      id_token?: unknown;
      expires_in?: unknown;
    };
    const nextAccessToken =
      typeof tokenData.access_token === 'string' && tokenData.access_token.trim()
        ? tokenData.access_token.trim()
        : '';
    if (!nextAccessToken) {
      throw new PlannerLlmError('Codex OAuth refresh response lacked an access_token.', 502, {
        retryable: false,
      });
    }
    const nextRefreshToken =
      typeof tokenData.refresh_token === 'string' && tokenData.refresh_token.trim()
        ? tokenData.refresh_token.trim()
        : latestCreds.refreshToken;
    const idToken =
      typeof tokenData.id_token === 'string' && tokenData.id_token.trim()
        ? tokenData.id_token.trim()
        : null;
    const meta = extractCodexAccountMetadata(idToken, nextAccessToken, latestCreds.accountId);
    const expiresInSec =
      typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in) && tokenData.expires_in > 0
        ? tokenData.expires_in
        : 3600;
    const nextCreds: CodexOAuthStoredCredentials = {
      mode: 'device-code',
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      accountId: meta.accountId ?? latestCreds.accountId ?? null,
      planType: meta.planType ?? latestCreds.planType ?? null,
      accountEmail: meta.accountEmail ?? latestCreds.accountEmail ?? null,
      organizationName: meta.organizationName ?? latestCreds.organizationName ?? null,
    };

    const secretCiphertext = encryptCodexOAuthCredentials(nextCreds, opts.encKey);
    updatePlannerProvider(opts.db, opts.providerId, {
      secretCiphertext,
      lastError: null,
    });
    return nextCreds;
  })();

  inFlightRefreshes.set(opts.providerId, refreshPromise);
  try {
    const refreshed = await refreshPromise;
    return {
      accessToken: refreshed.accessToken!,
      accountId: refreshed.accountId ?? null,
      mode: 'device-code',
    };
  } finally {
    if (inFlightRefreshes.get(opts.providerId) === refreshPromise) {
      inFlightRefreshes.delete(opts.providerId);
    }
  }
}

// ---- Quota headers & /backend-api/wham/usage --------------------------------

const codexQuotaSnapshotsByProvider = new Map<string, ClaudeProviderUsageWindow[]>();

function parseHeaderPercent(headers: Headers, names: readonly string[]): number | null {
  for (const name of names) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n >= 0) {
      return Math.min(100, Math.max(0, n));
    }
  }
  return null;
}

function parseHeaderResetIso(
  headers: Headers,
  resetAtNames: readonly string[],
  resetAfterNames: readonly string[],
): string | null {
  for (const name of resetAtNames) {
    const raw = headers.get(name)?.trim();
    if (!raw) continue;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      const ms = asNum > 1e12 ? asNum : asNum * 1000;
      return new Date(ms).toISOString();
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  for (const name of resetAfterNames) {
    const raw = headers.get(name)?.trim();
    if (!raw) continue;
    const sec = Number.parseInt(raw, 10);
    if (Number.isFinite(sec) && sec > 0) {
      return new Date(Date.now() + sec * 1000).toISOString();
    }
  }
  return null;
}

/**
 * Parses `x-codex-5h-*` and `x-codex-7d-*` (plus `x-codex-primary-*` /
 * `x-codex-secondary-*`) response headers from `/backend-api/codex/responses`.
 */
export function parseCodexQuotaHeaders(headers: Headers): ClaudeProviderUsageWindow[] {
  const windows: ClaudeProviderUsageWindow[] = [];
  const used5h = parseHeaderPercent(headers, [
    'x-codex-5h-used-percent',
    'x-codex-primary-used-percent',
  ]);
  if (used5h !== null) {
    windows.push({
      label: '5h window',
      percentUsed: used5h,
      resetsAt: parseHeaderResetIso(
        headers,
        ['x-codex-5h-reset-at', 'x-codex-primary-reset-at'],
        ['x-codex-5h-reset-after-seconds', 'x-codex-primary-reset-after-seconds'],
      ),
    });
  }

  const used7d = parseHeaderPercent(headers, [
    'x-codex-7d-used-percent',
    'x-codex-secondary-used-percent',
  ]);
  if (used7d !== null) {
    windows.push({
      label: '7d window',
      percentUsed: used7d,
      resetsAt: parseHeaderResetIso(
        headers,
        ['x-codex-7d-reset-at', 'x-codex-secondary-reset-at'],
        ['x-codex-7d-reset-after-seconds', 'x-codex-secondary-reset-after-seconds'],
      ),
    });
  }
  return windows;
}

function recordCodexQuotaHeaders(providerId: string, headers: Headers): void {
  const windows = parseCodexQuotaHeaders(headers);
  if (windows.length > 0) {
    codexQuotaSnapshotsByProvider.set(providerId, windows);
  }
}

function parseWhamWindow(
  label: string,
  win: unknown,
): ClaudeProviderUsageWindow | null {
  if (!win || typeof win !== 'object') return null;
  const w = win as Record<string, unknown>;
  const rawPct =
    typeof w.used_percent === 'number'
      ? w.used_percent
      : typeof w.utilization === 'number'
        ? w.utilization
        : null;
  if (rawPct === null || !Number.isFinite(rawPct)) return null;
  const percentUsed = Math.min(100, Math.max(0, rawPct));
  let resetsAt: string | null = null;
  if (typeof w.reset_at === 'number' && Number.isFinite(w.reset_at) && w.reset_at > 0) {
    const ms = w.reset_at > 1e12 ? w.reset_at : w.reset_at * 1000;
    resetsAt = new Date(ms).toISOString();
  } else if (typeof w.reset_at === 'string' && w.reset_at.trim()) {
    const parsed = Date.parse(w.reset_at);
    resetsAt = Number.isNaN(parsed) ? w.reset_at : new Date(parsed).toISOString();
  } else if (typeof w.reset_after_seconds === 'number' && Number.isFinite(w.reset_after_seconds) && w.reset_after_seconds > 0) {
    resetsAt = new Date(Date.now() + w.reset_after_seconds * 1000).toISOString();
  }
  return { label, percentUsed, resetsAt };
}

/**
 * Queries `GET https://chatgpt.com/backend-api/wham/usage` for 5h / 7d ChatGPT
 * Codex rate-limit windows, falling back to any cached `x-codex-5h-*` /
 * `x-codex-7d-*` response headers recorded on recent `/responses` calls.
 */
export async function fetchCodexOAuthUsage(opts: {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch | undefined;
}): Promise<ClaudeProviderUsageResponse> {
  const cached = codexQuotaSnapshotsByProvider.get(opts.providerId) ?? [];
  let auth: { accessToken: string; accountId: string | null };
  try {
    auth = await ensureFreshCodexCredentials({
      db: opts.db,
      providerId: opts.providerId,
      encKey: opts.encKey,
      fetchImpl: opts.fetchImpl,
    });
  } catch (err) {
    return {
      available: cached.length > 0,
      windows: cached,
      error: (err as Error).message,
      updatedAt: new Date().toISOString(),
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(CODEX_WHAM_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: 'application/json',
        'User-Agent': buildCodexUserAgent(),
        ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        available: cached.length > 0,
        windows: cached,
        error: `Usage endpoint returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
        updatedAt: new Date().toISOString(),
      };
    }

    const data = (await res.json()) as {
      rate_limit?: {
        primary_window?: unknown;
        secondary_window?: unknown;
      };
      code_review_rate_limit?: {
        primary_window?: unknown;
      };
    };

    const windows: ClaudeProviderUsageWindow[] = [];
    const primary = parseWhamWindow('5h window', data.rate_limit?.primary_window);
    if (primary) windows.push(primary);
    const secondary = parseWhamWindow('7d window', data.rate_limit?.secondary_window);
    if (secondary) windows.push(secondary);
    const codeReview = parseWhamWindow('Code review (7d)', data.code_review_rate_limit?.primary_window);
    if (codeReview) windows.push(codeReview);

    if (windows.length > 0) {
      codexQuotaSnapshotsByProvider.set(opts.providerId, windows);
      return {
        available: true,
        windows,
        error: null,
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      available: cached.length > 0,
      windows: cached,
      error: null,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      available: cached.length > 0,
      windows: cached,
      error: `Could not reach Codex usage endpoint: ${(err as Error).message}`,
      updatedAt: new Date().toISOString(),
    };
  }
}

// ---- CodexOAuthPlannerProvider ----------------------------------------------

function buildResponsesEndpointUrl(baseUrl: string): string {
  const trimmed = (baseUrl || DEFAULT_CODEX_OAUTH_BASE_URL).trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/responses')) return trimmed;
  return `${trimmed}/responses`;
}

function buildModelsEndpointUrl(baseUrl: string, clientVersion: string): string {
  const trimmed = (baseUrl || DEFAULT_CODEX_OAUTH_BASE_URL).trim().replace(/\/+$/, '');
  const root = trimmed.endsWith('/responses') ? trimmed.slice(0, -'/responses'.length) : trimmed;
  return `${root}/models?client_version=${encodeURIComponent(clientVersion)}`;
}

export interface CodexOAuthPlannerProviderOptions {
  db: Db;
  providerId: string;
  encKey: Buffer | undefined;
  fetchImpl?: typeof fetch | undefined;
  retry?: Partial<PlannerLlmRetryPolicy> | undefined;
}

export class CodexOAuthPlannerProvider implements PlannerLlmProvider {
  constructor(private readonly opts: CodexOAuthPlannerProviderOptions) {}

  async listModels(): Promise<string[]> {
    const provider = readPlannerProvider(this.opts.db, this.opts.providerId);
    if (!provider) {
      throw new PlannerLlmError('Codex provider not found.', 404, { retryable: false });
    }
    const auth = await ensureFreshCodexCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
    });
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const version = resolveCodexClientVersion();
    const url = buildModelsEndpointUrl(provider.baseUrl, version);
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: 'application/json',
          originator: CODEX_ORIGINATOR,
          Version: version,
          'User-Agent': buildCodexUserAgent(version),
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      });
      if (res.ok) {
        const parsed = (await res.json()) as { models?: unknown; data?: unknown };
        const rawList = Array.isArray(parsed.models)
          ? parsed.models
          : Array.isArray(parsed.data)
            ? parsed.data
            : [];
        const dynamicIds = rawList
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return '';
            const obj = entry as { slug?: unknown; id?: unknown };
            return typeof obj.slug === 'string'
              ? obj.slug.trim()
              : typeof obj.id === 'string'
                ? obj.id.trim()
                : '';
          })
          .filter((id) => id.length > 0);
        if (dynamicIds.length > 0) {
          return [...new Set([...dynamicIds, ...CODEX_OAUTH_STATIC_MODELS])];
        }
      }
    } catch {
      // Fall back to static model catalog when /models is unreachable.
    }
    return [...CODEX_OAUTH_STATIC_MODELS];
  }

  async test(model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      let content: string | null = null;
      for await (const chunk of this.streamComplete(model, [
        { role: 'user', content: 'Reply with exactly one word: ok' },
      ])) {
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
    const provider = readPlannerProvider(this.opts.db, this.opts.providerId);
    if (!provider) {
      throw new PlannerLlmError('Codex provider not found.', 404, { retryable: false });
    }
    const auth = await ensureFreshCodexCredentials({
      db: this.opts.db,
      providerId: this.opts.providerId,
      encKey: this.opts.encKey,
      fetchImpl: this.opts.fetchImpl,
    });

    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = buildResponsesEndpointUrl(provider.baseUrl);
    const clientVersion = resolveCodexClientVersion();
    const headers = buildCodexResponsesHeaders({
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      clientVersion,
      sessionId: options?.chatId ?? null,
    });
    const bodyObj = buildCodexResponsesRequest({
      model,
      messages,
      tools,
      streamOptions: options,
    });

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
        `The Codex Responses endpoint sent nothing for ${Math.round(idleMs / 1000)}s.`,
        undefined,
        { retryable: true },
      );

    try {
      armIdle();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyObj),
          signal: controller.signal,
        });
      } catch (err) {
        if (idledOut) throw idleError();
        if (externalSignal?.aborted) throw new PlannerLlmError('Aborted.');
        throw new PlannerLlmError(
          `Could not reach the Codex Responses endpoint: ${(err as Error).message}`,
          undefined,
          { retryable: true },
        );
      }
      armIdle();

      recordCodexQuotaHeaders(this.opts.providerId, res.headers);

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        if (res.status === 401 && auth.mode === 'cli-readonly') {
          const msg =
            'Codex CLI token in ~/.codex/auth.json was rejected (401) — run codex once to refresh.';
          recordPlannerProviderTestResult(this.opts.db, this.opts.providerId, {
            ok: false,
            error: msg,
          });
          throw new PlannerLlmError(msg, 401, { retryable: false });
        }
        const err = httpError('Codex Responses endpoint', res.status, bodyText, res.headers);
        if (res.status === 401 || res.status === 403) {
          recordPlannerProviderTestResult(this.opts.db, this.opts.providerId, {
            ok: false,
            error: err.message,
          });
        }
        throw err;
      }

      if (!res.body) {
        throw new PlannerLlmError('Codex Responses endpoint returned an empty body.', undefined, {
          retryable: true,
        });
      }

      const parser = new CodexResponsesSseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep = buffer.indexOf('\n\n');
          while (sep >= 0) {
            const rawFrame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const ev of parser.feedFrame(rawFrame)) {
              yield ev;
            }
            sep = buffer.indexOf('\n\n');
          }
        }
        buffer += decoder.decode().replace(/\r\n/g, '\n');
        if (buffer.trim().length > 0) {
          for (const ev of parser.feedFrame(buffer)) {
            yield ev;
          }
        }
      } catch (err) {
        if (idledOut) throw idleError();
        if (err instanceof PlannerLlmError) throw err;
        if (externalSignal?.aborted) throw new PlannerLlmError('Aborted.');
        throw new PlannerLlmError(
          `Codex Responses stream interrupted: ${(err as Error).message}`,
          undefined,
          { retryable: true },
        );
      } finally {
        reader.releaseLock();
      }

      const completion: PlannerLlmCompletion = parser.finish();
      recordPlannerProviderTestResult(this.opts.db, this.opts.providerId, { ok: true });
      yield { type: 'done', ...completion };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }
}
