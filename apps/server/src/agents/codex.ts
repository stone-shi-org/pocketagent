import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * OpenAI's Codex CLI, driven through `codex app-server`'s JSON-RPC protocol
 * rather than its simpler `codex exec --json` headless mode.
 *
 * `exec --json` was the obvious first candidate — it is stable, was fully
 * live-verified, and its own default sandbox (read-only) is actually safer
 * than `agy`'s always-proceed default. But it has no flag at all to make it
 * pause and ask a human (`-a/--ask-for-approval` only exists on the
 * interactive TUI); an out-of-policy action is just rejected outright, never
 * routed anywhere. `app-server` is the one surface where Codex genuinely
 * blocks a command/file-change until a real reply arrives — confirmed live
 * against the installed CLI (v0.147.0): a deliberately-wrong reply produced a
 * server-side rejection log, proving the gate is real, not decorative. OpenAI
 * marks this protocol `[experimental]` and its own schema shows signs of an
 * in-flight v1→v2 migration, which is the trade being made here for genuine
 * default-ask behaviour instead of `agy`'s forced bypass.
 */
export function createCodexAdapter(bin: string): AgentAdapter {
  return {
    id: 'codex',
    displayName: 'Codex',
    description: 'OpenAI Codex CLI, structured — real approval gate via app-server',
    transports: ['structured'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    structuredKind: 'codex-app-server',

    buildCommand() {
      // Args are unused for the structured transport: `CodexServerManager`
      // spawns `codex app-server` itself with its own fixed argv. This only
      // has to be truthful for `isAvailable` and env merging, same as agy
      // and opencode.
      return { command: bin, args: [] };
    },

    bin,

    /**
     * `codex login status` prints one line ("Logged in using ChatGPT") in
     * ~0.1s, locally. Text rather than JSON, so the matching below is
     * deliberately narrow and falls through to `unknown`.
     *
     * Not `codex doctor --json`, which reports far more but performs DNS, a
     * WSS handshake to the provider and an HTTP reachability probe — that is a
     * diagnostic, not a cheap local check, and it would make this probe fail
     * on a host with no outbound network even while signed in.
     */
    authProbe: {
      args: ['login', 'status'],
      interpret({ stdout, stderr, timedOut }) {
        if (timedOut) return { state: 'unknown', detail: 'codex login status did not respond in time.' };
        const text = `${stdout}\n${stderr}`.trim();
        // "not logged in" has to be tested first: it contains "logged in".
        if (/\bnot\s+logged\s+in\b/i.test(text) || /\bnot\s+authenticated\b/i.test(text)) {
          return { state: 'signed-out', detail: 'Not signed in. Run `codex login` in a shell session on this host.' };
        }
        if (/\blogged\s+in\b/i.test(text)) {
          return { state: 'ready', detail: text.split('\n')[0]?.trim().slice(0, 200) ?? 'Signed in' };
        }
        return {
          state: 'unknown',
          detail: text === '' ? 'codex login status printed nothing.' : text.slice(0, 200),
        };
      },
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
