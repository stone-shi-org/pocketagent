/**
 * Variables that must never reach a spawned agent.
 *
 * The server's own environment holds POCKETAGENT_AUTH_TOKEN. A shell session
 * inherits whatever we pass, so `env | grep POCKET` in the browser would print
 * the master credential straight back to the screen. Strip the whole namespace.
 */
const BLOCKED_EXACT = new Set(['POCKETAGENT_AUTH_TOKEN']);
const BLOCKED_PREFIXES = ['POCKETAGENT_'];

export interface BuildEnvOptions {
  cwd: string;
  overrides?: Record<string, string>;
  base?: NodeJS.ProcessEnv;
}

/**
 * Build the child environment: the server's environment minus PocketAgent's own
 * configuration, plus the terminal settings a CLI needs to render properly.
 */
export function buildChildEnv(options: BuildEnvOptions): Record<string, string> {
  const base = options.base ?? process.env;
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (BLOCKED_EXACT.has(key)) continue;
    if (BLOCKED_PREFIXES.some((p) => key.startsWith(p))) continue;
    env[key] = value;
  }

  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.PWD = options.cwd;
  // Interactive CLIs check this to decide whether to page output. A pager in a
  // remote terminal is fine, but `less` without -R mangles colour.
  env.LESS = env.LESS ?? '-R';

  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    env[key] = value;
  }

  return env;
}
