import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { SETTINGS_ENC_KEY_HELP, SETTINGS_ENC_KEY_VAR, SecretKeyError, parseSettingsEncKey } from '@pocketagent/node-kit';

/**
 * Four levels up from `dist/src/…`? No — from `dist/`. The Hub has *one*
 * source directory level (`src/config.ts` -> `dist/config.js`), so the repo
 * root is three levels up, not the server's four. Stated explicitly because
 * the server's own `REPO_ROOT` comment is load-bearing in the Dockerfile and
 * copying the number rather than the reasoning is how that breaks.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export class HubConfigError extends Error {
  override readonly name = 'HubConfigError';
}

const boolish =
  (fallback: boolean) =>
  (raw: string | undefined): boolean => {
    if (raw === undefined || raw.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  };

const RawEnv = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  POCKETAGENT_HUB_HOST: z.string().optional(),
  POCKETAGENT_HUB_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  POCKETAGENT_HUB_AUTH_TOKEN: z.string().optional(),
  POCKETAGENT_HUB_DATA_DIR: z.string().optional(),
  POCKETAGENT_HUB_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(8760).default(720),
  POCKETAGENT_SETTINGS_ENC_KEY: z.string().optional(),
  POCKETAGENT_ALLOWED_ORIGINS: z.string().optional(),
  POCKETAGENT_COOKIE_SECURE: z.string().optional(),
  POCKETAGENT_TRUST_PROXY: z.string().optional(),
  POCKETAGENT_WEB_DIST: z.string().optional(),
  POCKETAGENT_HUB_LATEST_RELEASE: z.string().optional(),
});

export interface HubConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly isProduction: boolean;
  readonly logLevel: string;
  readonly host: string;
  readonly port: number;
  /** The Hub's own operator credential. Never a backend's master token. */
  readonly authToken: string;
  readonly sessionTtlMs: number;
  readonly dataDir: string;
  readonly databasePath: string;
  /** Required here, unlike on the backend. See `resolveEncKey`. */
  readonly settingsEncKey: Buffer;
  readonly allowedOrigins: string[] | null;
  readonly cookieSecure: boolean;
  readonly trustProxy: boolean;
  readonly webDistPath: string;
  /** Advertised as `HubHostListResponse.latestRelease`; null when unconfigured. */
  readonly latestRelease: string | null;
}

const MIN_TOKEN_LENGTH = 24;

const TOKEN_HELP = `
POCKETAGENT_HUB_AUTH_TOKEN is required and must be at least ${MIN_TOKEN_LENGTH} characters.

Generate one *for the Hub specifically*:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

It is deliberately a different variable from POCKETAGENT_AUTH_TOKEN. Reusing a
backend's master token here would make one paste into the Hub's login box also
a root credential for that machine, which is the exact credential
concentration the scoped-credential design exists to remove.
`.trim();

/**
 * The encryption key is **required** on the Hub, which diverges from the
 * backend on purpose (PA-66 D14).
 *
 * On a backend, `POCKETAGENT_SETTINGS_ENC_KEY` unset disables a feature —
 * custom providers, Telegram bots — and refusing to boot over an optional
 * extra would take down a deployment that has never heard of the variable. On
 * the Hub there is no such graceful degradation available: every backend it
 * proxies to is reached with a credential it must store encrypted and read
 * back, so a Hub with nowhere to put one has nothing it can do. Starting
 * anyway would only move the failure to the operator's first bind, after they
 * had already registered hosts.
 */
function resolveEncKey(raw: string | undefined): Buffer {
  let key: Buffer | undefined;
  try {
    key = parseSettingsEncKey(raw);
  } catch (error) {
    throw new HubConfigError(error instanceof SecretKeyError ? error.message : String(error));
  }
  if (key === undefined) {
    throw new HubConfigError(
      `${SETTINGS_ENC_KEY_VAR} is required by the Hub: it encrypts every backend credential ` +
        `at rest, and a Hub that cannot store one has nothing to proxy with.\n\n${SETTINGS_ENC_KEY_HELP}`,
    );
  }
  return key;
}

export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    throw new HubConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'),
    );
  }
  const e = parsed.data;

  const authToken = e.POCKETAGENT_HUB_AUTH_TOKEN?.trim() ?? '';
  if (authToken.length < MIN_TOKEN_LENGTH) throw new HubConfigError(TOKEN_HELP);

  const isProduction = e.NODE_ENV === 'production';

  // Its own variable, not POCKETAGENT_DATA_DIR. One name for two unrelated
  // schemas is a trap in exactly the deployment where it matters — a compose
  // file running a Hub and a backend side by side — and the Hub has no
  // workspace roots, so PA-62's "refuse a data root inside a workspace root"
  // check has nothing here to check rather than being quietly dropped.
  const dataDir = e.POCKETAGENT_HUB_DATA_DIR?.trim()
    ? path.resolve(e.POCKETAGENT_HUB_DATA_DIR.trim())
    : path.join(REPO_ROOT, 'data', 'hub');
  if (dataDir === '/') throw new HubConfigError('POCKETAGENT_HUB_DATA_DIR must not be /.');

  const allowedOriginsRaw = e.POCKETAGENT_ALLOWED_ORIGINS?.trim();
  const allowedOrigins =
    allowedOriginsRaw === undefined || allowedOriginsRaw === ''
      ? null
      : allowedOriginsRaw
          .split(',')
          .map((value) => value.trim().replace(/\/$/, ''))
          .filter((value) => value !== '');

  const cookieSecureRaw = e.POCKETAGENT_COOKIE_SECURE?.trim();
  const cookieSecure =
    cookieSecureRaw === undefined || cookieSecureRaw === ''
      ? isProduction
      : boolish(isProduction)(cookieSecureRaw);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    host: e.POCKETAGENT_HUB_HOST?.trim() || '127.0.0.1',
    port: e.POCKETAGENT_HUB_PORT ?? 8788,
    authToken,
    sessionTtlMs: e.POCKETAGENT_HUB_SESSION_TTL_HOURS * 3600 * 1000,
    dataDir,
    databasePath: path.join(dataDir, 'pocketagent-hub.db'),
    settingsEncKey: resolveEncKey(e.POCKETAGENT_SETTINGS_ENC_KEY),
    allowedOrigins,
    cookieSecure,
    trustProxy: boolish(false)(e.POCKETAGENT_TRUST_PROXY),
    webDistPath: e.POCKETAGENT_WEB_DIST?.trim()
      ? path.resolve(e.POCKETAGENT_WEB_DIST.trim())
      : path.join(REPO_ROOT, 'apps/web/dist'),
    latestRelease: e.POCKETAGENT_HUB_LATEST_RELEASE?.trim() || null,
  };
}
