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

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
