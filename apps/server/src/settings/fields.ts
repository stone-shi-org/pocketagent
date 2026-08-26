import type { Config } from '../config/index.js';

/**
 * Maps one `Config` field onto a row in the `settings` table.
 *
 * This is the generalization of the seed-once pattern `workspaces_seeded` and
 * `global_skip_permissions` already used (see `db/index.ts`): configuration
 * only ever *seeds* a field's first value from the environment; after that,
 * the database wins forever, on every future boot, regardless of what `.env`
 * says. See CLAUDE.md and the settings-page plan for why: an inherited or
 * edited env var silently outranking a persisted choice on every restart is
 * exactly the bug this exists to close off.
 *
 * `live: true` means the running server re-reads `config.<key>` at the
 * moment it's used (already true for several fields — `SessionManager` reads
 * `this.opts.maxSessions` etc. live, several routes read `config.X` per
 * request), so a `PATCH /api/settings` that mutates the shared `config`
 * object takes effect immediately. `live: false` means some other module
 * captured the value into its own constructor closure at boot (the agent
 * registry, the process backend, Fastify's own `trustProxy` option, ...); the
 * write still persists, it just needs a restart to be picked up.
 */
export interface SettingsField<K extends keyof Config = keyof Config> {
  key: K;
  /** Row key in the `settings` table. snake_case, matching existing rows. */
  dbKey: string;
  live: boolean;
  parse(raw: string): Config[K];
  serialize(value: Config[K]): string;
}

const str = <K extends keyof Config>(key: K, dbKey: string, live: boolean): SettingsField<K> => ({
  key,
  dbKey,
  live,
  parse: (raw) => raw as Config[K],
  serialize: (value) => value as unknown as string,
});

const num = <K extends keyof Config>(key: K, dbKey: string, live: boolean): SettingsField<K> => ({
  key,
  dbKey,
  live,
  parse: (raw) => Number(raw) as Config[K],
  serialize: (value) => String(value),
});

const bool = <K extends keyof Config>(key: K, dbKey: string, live: boolean): SettingsField<K> => ({
  key,
  dbKey,
  live,
  parse: (raw) => (raw === '1') as Config[K],
  serialize: (value) => (value ? '1' : '0'),
});

/** `null` <-> `''` on the wire; a present-but-empty row still round-trips to `null`. */
const nullableStr = <K extends keyof Config>(
  key: K,
  dbKey: string,
  live: boolean,
): SettingsField<K> => ({
  key,
  dbKey,
  live,
  parse: (raw) => (raw.trim() === '' ? null : raw) as Config[K],
  serialize: (value) => (value === null ? '' : (value as unknown as string)),
});

/**
 * Every field in `RawEnv` (`config/index.ts`) except the ones that structurally
 * cannot move here: `HOST`/`PORT` (needed to bind before a settings page is
 * even reachable), `DATABASE_PATH` (needed to open the very database that
 * would store it), `NODE_ENV` (a deployment mode, not an app setting), and
 * `POCKETAGENT_AUTH_TOKEN` (left out of this change entirely — see the plan).
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  str('logLevel', 'log_level', true),
  {
    key: 'allowedOrigins',
    dbKey: 'allowed_origins',
    live: true,
    parse: (raw) => {
      if (raw.trim() === '') return null;
      const list = raw
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean);
      return list.length > 0 ? list : null;
    },
    serialize: (value) => (value === null ? '' : value.join(',')),
  } as SettingsField<'allowedOrigins'>,
  num('maxSessions', 'max_sessions', true),
  num('outputBufferBytes', 'output_buffer_bytes', true),
  num('sessionIdleTimeoutSeconds', 'session_idle_timeout_seconds', true),
  num('sessionTtlMs', 'session_ttl_ms', true),
  bool('cookieSecure', 'cookie_secure', true),
  bool('trustProxy', 'trust_proxy', false),
  nullableStr('codeServerBaseUrl', 'code_server_url', true),
  str('shell', 'shell', false),
  str('claudeBin', 'claude_bin', false),
  str('agyBin', 'agy_bin', false),
  str('opencodeBin', 'opencode_bin', false),
  str('codexBin', 'codex_bin', false),
  str('piBin', 'pi_bin', false),
  str('webDistPath', 'web_dist_path', false),
  str('backend', 'backend', false),
  str('tmuxBin', 'tmux_bin', false),
  str('tmuxSocket', 'tmux_socket', false),
  str('adoptTmuxSocket', 'adopt_tmux_socket', false),
  nullableStr('tmuxSessionScopeSlice', 'tmux_session_scope_slice', false),
  str('pushContact', 'push_contact', false),
] as unknown as readonly SettingsField[];

export const RESTART_REQUIRED_KEYS: readonly string[] = SETTINGS_FIELDS.filter((f) => !f.live).map(
  (f) => f.key,
);
