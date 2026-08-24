import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, whether running from `src/` (tsx/strip-types) or `dist/`. */
export const REPO_ROOT = path.resolve(here, '../../../..');

dotenv.config({ path: path.join(REPO_ROOT, '.env'), quiet: true });

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intish = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected an integer between ${min} and ${max}, got ${JSON.stringify(v)}`,
        });
        return z.NEVER;
      }
      return n;
    });

const RawEnv = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: intish(8787, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  POCKETAGENT_AUTH_TOKEN: z.string().optional(),
  POCKETAGENT_WORKSPACE_ROOTS: z.string().optional(),
  POCKETAGENT_ALLOWED_ORIGINS: z.string().optional(),

  DATABASE_PATH: z.string().default('./data/pocketagent.db'),

  MAX_SESSIONS: intish(10, 1, 200),
  OUTPUT_BUFFER_BYTES: intish(2 * 1024 * 1024, 16 * 1024, 64 * 1024 * 1024),
  /** Seconds of no PTY output AND no attached client before auto-kill. 0 disables. */
  SESSION_IDLE_TIMEOUT: intish(0, 0, 30 * 24 * 3600),

  POCKETAGENT_SESSION_TTL_HOURS: intish(720, 1, 8760),
  POCKETAGENT_COOKIE_SECURE: z.string().optional(),
  POCKETAGENT_TRUST_PROXY: boolish(false),

  /**
   * Base URL of a code-server instance reachable from the browser, e.g.
   * `https://host/code/`. Optional: unset hides the "Open in code-server"
   * action entirely rather than defaulting to some guessed local URL, since a
   * wrong guess would silently link to nothing.
   */
  POCKETAGENT_CODE_SERVER_URL: z.string().optional(),

  POCKETAGENT_SHELL: z.string().optional(),
  POCKETAGENT_CLAUDE_BIN: z.string().default('claude'),
  POCKETAGENT_AGY_BIN: z.string().default('agy'),
  POCKETAGENT_OPENCODE_BIN: z.string().default('opencode'),
  POCKETAGENT_CODEX_BIN: z.string().default('codex'),
  POCKETAGENT_PI_BIN: z.string().default('pi'),
  POCKETAGENT_WEB_DIST: z.string().optional(),

  /**
   * Boot-time seed for the global "skip all approvals" switch. See `Config.globalSkipPermissionsDefault`.
   * Off by default; once the switch has been toggled at runtime via `PATCH
   * /api/settings`, the persisted value wins and this is ignored on later boots.
   */
  POCKETAGENT_GLOBAL_SKIP_PERMISSIONS: boolish(false),

  POCKETAGENT_BACKEND: z.enum(['direct', 'tmux']).default('direct'),
  POCKETAGENT_PUSH_CONTACT: z.string().default('mailto:pocketagent@localhost'),
  POCKETAGENT_TMUX_BIN: z.string().default('tmux'),
  POCKETAGENT_TMUX_SOCKET: z.string().default('pocketagent'),
  POCKETAGENT_ADOPT_TMUX_SOCKET: z.string().default(''),

  /**
   * systemd slice to start the tmux server's own transient scope in (via
   * `systemd-run --user --scope`), instead of as a direct child of this
   * process. See `Config.tmuxSessionScopeSlice`. Empty disables it — the
   * tmux server is then just a normal child, as it always was.
   */
  POCKETAGENT_TMUX_SESSION_SCOPE_SLICE: z.string().default(''),
});

export interface Config {
  nodeEnv: 'development' | 'production' | 'test';
  isProduction: boolean;
  host: string;
  port: number;
  logLevel: string;
  authToken: string;
  /** Canonicalized, existing, de-duplicated workspace roots. Never empty. */
  workspaceRoots: string[];
  /** null means "accept any Origin" (only permitted outside production). */
  allowedOrigins: string[] | null;
  databasePath: string;
  maxSessions: number;
  outputBufferBytes: number;
  sessionIdleTimeoutSeconds: number;
  sessionTtlMs: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  /**
   * Seeds the database-backed global skip-permissions switch on first boot only.
   *
   * DANGEROUS: when that switch is on, every session bypasses approval instead
   * of routing it to the browser — the opposite of PocketAgent's default
   * per-session, off-by-default `skipPermissions` opt-in. See CLAUDE.md.
   */
  globalSkipPermissionsDefault: boolean;
  shell: string;
  claudeBin: string;
  agyBin: string;
  opencodeBin: string;
  codexBin: string;
  piBin: string;
  webDistPath: string;
  /** Where agent processes live. `tmux` lets them survive a server restart. */
  backend: 'direct' | 'tmux';
  tmuxBin: string;
  tmuxSocket: string;
  /**
   * Foreign tmux socket whose panes may be adopted, e.g. `default` for the
   * user's own server. Empty disables adoption.
   */
  adoptTmuxSocket: string;
  /**
   * When set, the tmux backend's server is started inside a transient
   * `systemd-run --user --scope` unit under this slice rather than as a
   * direct child of this process. Without it, the server (and everything
   * anyone later forks inside it — the whole point of a backend that
   * survives a restart) stays glued to this process's own cgroup forever,
   * across every future restart, since cgroup membership is inherited on
   * fork and nothing here ever moves a process out of it. null outside of
   * a systemd-managed deployment, where there is no such user manager to
   * delegate to.
   */
  tmuxSessionScopeSlice: string | null;
  /** VAPID `sub` claim: a mailto: or https: URL identifying this deployment. */
  pushContact: string;
  /** True when bound to something other than loopback. */
  isNetworkExposed: boolean;
  /**
   * Base URL of a code-server instance for this machine, or null if none is
   * configured. Varies per machine, so it rides on `HostInfo` rather than a
   * global response field — see `ProjectService.host()`.
   */
  codeServerBaseUrl: string | null;
}

const MIN_TOKEN_LENGTH = 24;

const TOKEN_HELP = `
PocketAgent requires an access token. It is not auto-generated, because a token
printed once into a terminal is easy to lose and easy to leak into scrollback.

Generate one and store it in .env:

    node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

then add to ${path.join(REPO_ROOT, '.env')}:

    POCKETAGENT_AUTH_TOKEN=<the generated value>

Or run:  pnpm generate-token
`.trim();

function canonicalizeRoots(raw: string): string[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const seen = new Set<string>();
  const roots: string[] = [];
  const problems: string[] = [];

  for (const part of parts) {
    const expanded = part.startsWith('~') ? path.join(os.homedir(), part.slice(1)) : part;
    const absolute = path.resolve(expanded);
    let real: string;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      problems.push(`  ${part} -> does not exist or is not readable`);
      continue;
    }
    if (!fs.statSync(real).isDirectory()) {
      problems.push(`  ${part} -> not a directory`);
      continue;
    }
    if (real === '/') {
      problems.push(`  ${part} -> refusing to use "/" as a workspace root`);
      continue;
    }
    if (!seen.has(real)) {
      seen.add(real);
      roots.push(real);
    }
  }

  return roots;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = RawEnv.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${details}`);
  }
  const e = parsed.data;

  const token = e.POCKETAGENT_AUTH_TOKEN?.trim();
  if (!token) throw new ConfigError(`POCKETAGENT_AUTH_TOKEN is not set.\n\n${TOKEN_HELP}`);
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `POCKETAGENT_AUTH_TOKEN is only ${token.length} characters. ` +
        `PocketAgent grants terminal access to this machine, so a minimum of ` +
        `${MIN_TOKEN_LENGTH} characters is enforced.\n\n${TOKEN_HELP}`,
    );
  }

  // Optional now: workspaces live in the database and are managed from the UI,
  // and this only seeds them on first run. Unset is safe — it means no folders
  // at all, and the app asks you to add one — which is why the old hard failure
  // is gone. It never meant "the whole filesystem" and still does not.
  const rootsRaw = e.POCKETAGENT_WORKSPACE_ROOTS?.trim() ?? '';

  const host = e.HOST.trim();
  const isNetworkExposed = !['127.0.0.1', 'localhost', '::1'].includes(host);

  const allowedOrigins =
    e.POCKETAGENT_ALLOWED_ORIGINS?.trim()
      ?.split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean) ?? null;

  const isProduction = e.NODE_ENV === 'production';

  const databasePath = path.isAbsolute(e.DATABASE_PATH)
    ? e.DATABASE_PATH
    : path.join(REPO_ROOT, e.DATABASE_PATH);

  const webDistPath = e.POCKETAGENT_WEB_DIST
    ? path.resolve(e.POCKETAGENT_WEB_DIST)
    : path.join(REPO_ROOT, 'apps/web/dist');

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    host,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    authToken: token,
    workspaceRoots: canonicalizeRoots(rootsRaw),
    allowedOrigins,
    databasePath,
    maxSessions: e.MAX_SESSIONS,
    outputBufferBytes: e.OUTPUT_BUFFER_BYTES,
    sessionIdleTimeoutSeconds: e.SESSION_IDLE_TIMEOUT,
    sessionTtlMs: e.POCKETAGENT_SESSION_TTL_HOURS * 3600 * 1000,
    cookieSecure:
      e.POCKETAGENT_COOKIE_SECURE === undefined || e.POCKETAGENT_COOKIE_SECURE.trim() === ''
        ? isProduction
        : ['1', 'true', 'yes', 'on'].includes(e.POCKETAGENT_COOKIE_SECURE.trim().toLowerCase()),
    trustProxy: e.POCKETAGENT_TRUST_PROXY,
    globalSkipPermissionsDefault: e.POCKETAGENT_GLOBAL_SKIP_PERMISSIONS,
    shell: e.POCKETAGENT_SHELL?.trim() || env.SHELL || '/bin/bash',
    claudeBin: e.POCKETAGENT_CLAUDE_BIN.trim(),
    agyBin: e.POCKETAGENT_AGY_BIN.trim(),
    opencodeBin: e.POCKETAGENT_OPENCODE_BIN.trim(),
    codexBin: e.POCKETAGENT_CODEX_BIN.trim(),
    piBin: e.POCKETAGENT_PI_BIN.trim(),
    webDistPath,
    backend: e.POCKETAGENT_BACKEND,
    tmuxBin: e.POCKETAGENT_TMUX_BIN.trim(),
    tmuxSocket: e.POCKETAGENT_TMUX_SOCKET.trim(),
    adoptTmuxSocket: e.POCKETAGENT_ADOPT_TMUX_SOCKET.trim(),
    tmuxSessionScopeSlice: e.POCKETAGENT_TMUX_SESSION_SCOPE_SLICE.trim() || null,
    pushContact: e.POCKETAGENT_PUSH_CONTACT.trim(),
    isNetworkExposed,
    codeServerBaseUrl: e.POCKETAGENT_CODE_SERVER_URL?.trim() || null,
  };
}
