import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { parseSettingsEncKey } from '../crypto/secret-box.js';

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

  /**
   * Base URL of the self-hosted `live-stt` service (PA-20), e.g.
   * `http://10.100.0.50:8000` — its HTTP admin port, not its gRPC port
   * (this feature is HTTP-only; see the PA-20 implementation plan's D1).
   * Reachable only from this server, never the browser: `live-stt` has no
   * auth on its own HTTP/gRPC surface today. Optional, and unset does not
   * fail the boot — it disables the voice-input feature entirely (the mic
   * button and live-listen toggle are hidden). Set-but-invalid (not a URL)
   * does throw, so a typo reads as a boot-time configuration complaint
   * rather than a mystifying runtime fetch failure the first time someone
   * taps the mic button. Like `POCKETAGENT_CODE_SERVER_URL`, this only
   * *seeds* the value on first boot — it's a live `SETTINGS_FIELDS` entry
   * (`settings/fields.ts`), editable from Settings from then on with no
   * restart needed, and the database wins over this var forever after.
   */
  POCKETAGENT_LIVE_STT_URL: z.string().optional(),

  POCKETAGENT_SHELL: z.string().optional(),
  POCKETAGENT_CLAUDE_BIN: z.string().default('claude'),
  POCKETAGENT_AGY_BIN: z.string().default('agy'),
  POCKETAGENT_OPENCODE_BIN: z.string().default('opencode'),
  POCKETAGENT_CODEX_BIN: z.string().default('codex'),
  POCKETAGENT_PI_BIN: z.string().default('pi'),
  /**
   * Where on-demand agent installs land (PA-68). Default `~/.npm-global`,
   * which `agents/registry.ts` already searches and which the container
   * image already mounts and puts first on PATH — so the default agrees
   * with the image by construction rather than by a second decision.
   */
  POCKETAGENT_AGENT_INSTALL_PREFIX: z.string().optional(),
  POCKETAGENT_WEB_DIST: z.string().optional(),

  /**
   * App-owned data root (PA-62). Unset is `<REPO_ROOT>/data`, so an existing
   * install is unaffected; set, it relocates the database and the planner's
   * own scratch/skills roots together, which is what a container needs to put
   * all mutable state on one mounted volume.
   */
  POCKETAGENT_DATA_DIR: z.string().optional(),

  /**
   * Base64 of 32 raw bytes, encrypting the API key of every custom Claude
   * provider at rest (PA-28). See `crypto/secret-box.ts`.
   *
   * Optional, and unset does **not** fail the boot — it disables the
   * custom-provider feature instead, because an existing deployment must not
   * stop starting because it has never generated a key. Set-but-invalid *does*
   * throw: a typo would otherwise silently disable a feature the operator
   * believes they just turned on.
   *
   * The Claude Code variants that used to be configured here as
   * `POCKETAGENT_DEEPSEEK_*` / `POCKETAGENT_OMNIROUTE_*` (PA-19) are gone from
   * this schema. Those variables are now read exactly once, from raw
   * `process.env`, by `CustomClaudeProviderStore.migrateLegacyEnvProviders` —
   * they seed a database row on first boot and are ignored forever after, so
   * they are no longer *configuration* and do not belong in the config type.
   */
  POCKETAGENT_SETTINGS_ENC_KEY: z.string().optional(),

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
  /**
   * Every mutable, app-owned directory hangs off this one root (PA-62):
   * `pocketagent.db`, `planner-workspaces/`, `planner-skills/`. It is
   * `POCKETAGENT_DATA_DIR` when set and `<REPO_ROOT>/data` when not, and it
   * can never move into the database it names (chicken-and-egg), which is why
   * it is an env var rather than a row in `settings/fields.ts`.
   *
   * It exists as its own field, rather than being recovered from
   * `path.dirname(databasePath)` the way the planner roots used to recover it,
   * because a data root that is an implicit property of a filename is one
   * `basename` change away from silently moving two unrelated directories.
   */
  dataDir: string;
  /**
   * `<dataDir>/pocketagent.db`.
   *
   * This was deliberately *not* configurable until PA-62, on the grounds that
   * per-checkout isolation for demos and per-machine persistence for a deploy
   * were both already answered by *which checkout* the process runs from, so a
   * second knob only added a way to point two processes at one file by
   * accident. A containerised backend cannot satisfy that — the checkout is in
   * the image and the state has to outlive it — so the knob exists now, and
   * what replaces the old structural guarantee is `resolveDataDir`'s refusal to
   * put the data root inside a workspace root plus the boot log naming the root
   * that was opened. Demo scripts isolate themselves by setting the variable;
   * see CLAUDE.md.
   */
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
  /** Absolute directory on-demand agent installs are written to (PA-68). */
  agentInstallPrefix: string;
  /**
   * Key encrypting every custom Claude provider's API key at rest, or
   * `undefined` when `POCKETAGENT_SETTINGS_ENC_KEY` is unset — in which case
   * the feature is disabled (existing rows list and delete, nothing can be
   * created or edited) rather than the server refusing to start. A `Buffer`
   * rather than the raw base64 string so it is parsed and validated exactly
   * once, at boot, instead of on every encrypt.
   */
  settingsEncKey: Buffer | undefined;
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
  /**
   * Base URL of `live-stt`'s HTTP admin surface, or null when unset — in
   * which case PA-20's voice-input feature is disabled and the browser
   * never shows the mic button (`RuntimeSettings.liveSttUrl === ''`).
   * `POCKETAGENT_LIVE_STT_URL` only *seeds* this on first boot, the same
   * "database wins forever after" rule every other `SETTINGS_FIELDS` entry
   * follows (see `settings/fields.ts`) — it's a live, Settings-UI-editable
   * value, not a fixed one, per user feedback that it belonged there rather
   * than in `.env`.
   */
  liveSttUrl: string | null;
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

/**
 * Absolute, symlink-resolved form of a path that does not necessarily exist
 * yet — the data root is created on first boot (`openDatabase` mkdirs it), so
 * it cannot be handed straight to `realpathSync` the way a workspace root can.
 * Resolves the deepest ancestor that *does* exist and re-appends the rest, so
 * a symlinked parent is still collapsed before containment is tested.
 */
function realpathUncreated(target: string): string {
  const absolute = path.resolve(target);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    let real: string;
    try {
      real = fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists:
      // nothing to resolve, so the plain absolute path is the best answer.
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
      continue;
    }
    return tail.length > 0 ? path.join(real, ...tail) : real;
  }
}

/**
 * PA-62. Unset returns today's path and skips every check below, which is what
 * makes an existing install bit-for-bit unaffected — and is load-bearing for a
 * second reason: a dev checkout is very often itself inside a workspace root,
 * so applying the containment refusal to the default would fail the boot of
 * installs that have worked for months.
 *
 * An explicitly set root is checked, because making this configurable removed a
 * structural guarantee (see `Config.databasePath`) and an env var that can be
 * pointed anywhere should at least refuse the one place it must never go: a
 * tree an agent is allowed to edit. `pocketagent.db` holds webhook signing
 * secrets and encrypted provider keys, and an agent running `git clean -xfd`,
 * or a worktree delete, would take it out — the same "app state does not live
 * inside an agent-writable tree" rule `usage/probe-cwd.ts` records after the
 * rate-limit poller filed 288 transcripts a day into a workspace.
 *
 * Known limit, deliberately not papered over: this sees only the roots *seeded*
 * from the environment. The real folder list lives in the database and is
 * managed from the UI, so a folder added later can still come to contain the
 * data root, and nothing re-checks at that point.
 */
/**
 * Where `POST /api/agents/install` writes (PA-68).
 *
 * Defaults to `~/.npm-global` rather than `~/.local` for one reason that
 * matters more than taste: `agents/registry.ts` searches both, but the
 * container image already sets `NPM_CONFIG_PREFIX=$HOME/.npm-global`, mounts
 * `$HOME` as a volume and puts that prefix *first* on PATH ahead of the
 * image's own pinned CLIs. Defaulting here to the same directory means the
 * bare-metal default and the image agree by construction instead of by a
 * second decision someone has to keep in sync — and it is what makes "an
 * installed agent survives a container restart" true without the operator
 * configuring anything.
 *
 * Not validated for existence: npm creates the prefix, and a directory that
 * does not exist yet is the normal case on a host that has never installed a
 * global package. Whether the server will actually *find* the result is a
 * separate question, answered by `agentInstallPrefixDetectable`.
 */
function resolveAgentInstallPrefix(raw: string | undefined): string {
  const configured = raw?.trim();
  if (!configured) return path.join(os.homedir(), '.npm-global');
  const expanded = configured.startsWith('~')
    ? path.join(os.homedir(), configured.slice(1))
    : configured;
  return path.resolve(expanded);
}

function resolveDataDir(raw: string | undefined, workspaceRoots: string[]): string {
  const configured = raw?.trim();
  if (!configured) return path.join(REPO_ROOT, 'data');

  const expanded = configured.startsWith('~')
    ? path.join(os.homedir(), configured.slice(1))
    : configured;
  const resolved = realpathUncreated(expanded);

  if (resolved === '/') {
    throw new ConfigError('POCKETAGENT_DATA_DIR refuses to use "/" as the data root.');
  }

  for (const root of workspaceRoots) {
    const rel = path.relative(root, resolved);
    const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (inside) {
      throw new ConfigError(
        `POCKETAGENT_DATA_DIR (${resolved}) is inside the workspace root ${root}.\n\n` +
          `The data root holds pocketagent.db — webhook signing secrets and ` +
          `encrypted provider API keys — plus the Pocket Agent scratch and skills ` +
          `directories. An agent working in that tree can rewrite or delete all of ` +
          `it. Point POCKETAGENT_DATA_DIR outside every workspace root.`,
      );
    }
  }

  // Note the reverse direction is allowed on purpose: a workspace root *inside*
  // the data root is a plausible container layout (one volume at /data holding
  // both repos and state), and the hazard above does not run that way.
  return resolved;
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

  // Hoisted out of the returned object literal because `resolveDataDir` has to
  // test the data root against these.
  const workspaceRoots = canonicalizeRoots(rootsRaw);

  const dataDir = resolveDataDir(e.POCKETAGENT_DATA_DIR, workspaceRoots);
  const databasePath = path.join(dataDir, 'pocketagent.db');

  const webDistPath = e.POCKETAGENT_WEB_DIST
    ? path.resolve(e.POCKETAGENT_WEB_DIST)
    : path.join(REPO_ROOT, 'apps/web/dist');

  // Unset is fine (the feature turns itself off); a bad value is not, and is
  // re-thrown as a `ConfigError` so it reads like every other boot-time
  // configuration complaint rather than an unhandled crypto error.
  let settingsEncKey: Buffer | undefined;
  try {
    settingsEncKey = parseSettingsEncKey(e.POCKETAGENT_SETTINGS_ENC_KEY);
  } catch (err) {
    throw new ConfigError(err instanceof Error ? err.message : String(err));
  }

  // Same "unset disables, invalid throws" shape as settingsEncKey above, but
  // for a URL rather than a crypto key: unset just means PA-20's voice
  // feature is off, while a typo'd value fails at boot instead of on the
  // first tap of the mic button.
  let liveSttUrl: string | null = null;
  const liveSttUrlRaw = e.POCKETAGENT_LIVE_STT_URL?.trim();
  if (liveSttUrlRaw) {
    try {
      liveSttUrl = new URL(liveSttUrlRaw).toString().replace(/\/$/, '');
    } catch {
      throw new ConfigError(`POCKETAGENT_LIVE_STT_URL is not a valid URL: ${JSON.stringify(liveSttUrlRaw)}`);
    }
  }

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    host,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    authToken: token,
    workspaceRoots,
    allowedOrigins,
    dataDir,
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
    agentInstallPrefix: resolveAgentInstallPrefix(e.POCKETAGENT_AGENT_INSTALL_PREFIX),
    settingsEncKey,
    webDistPath,
    backend: e.POCKETAGENT_BACKEND,
    tmuxBin: e.POCKETAGENT_TMUX_BIN.trim(),
    tmuxSocket: e.POCKETAGENT_TMUX_SOCKET.trim(),
    adoptTmuxSocket: e.POCKETAGENT_ADOPT_TMUX_SOCKET.trim(),
    tmuxSessionScopeSlice: e.POCKETAGENT_TMUX_SESSION_SCOPE_SLICE.trim() || null,
    pushContact: e.POCKETAGENT_PUSH_CONTACT.trim(),
    isNetworkExposed,
    codeServerBaseUrl: e.POCKETAGENT_CODE_SERVER_URL?.trim() || null,
    liveSttUrl,
  };
}
