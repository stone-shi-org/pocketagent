import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * Google's Antigravity CLI (`agy`), driven only over the `structured`
 * transport via its headless `--output-format stream-json` mode.
 *
 * There is deliberately no `terminal` entry in `transports`: `agy`'s
 * interactive TUI works fine over a PTY, but this adapter exists specifically
 * to get the native tool-card UI, and print mode is the only surface that
 * emits machine-readable events.
 *
 * That same print mode is why `forcesSkipPermissions` is `true` and not just
 * `supportsSkipPermissions`: probing the real CLI (v1.1.12) shows every
 * headless run reports `"permission_mode":"always-proceed"` — with or without
 * `--dangerously-skip-permissions`, and regardless of `--mode` — because print
 * mode has no stdin channel to pause on. There is no synchronous approval
 * gate to wire `canUseTool` into, so unlike Claude's adapter this can never
 * offer the normal off-by-default behaviour; every session this starts is
 * bypassed from birth, and the client must say so permanently rather than
 * offer a checkbox that implies an off state which does not exist. See
 * `AgySession` for the per-turn subprocess model this implies.
 */
export function createAgyAdapter(bin: string): AgentAdapter {
  return {
    id: 'agy',
    displayName: 'Antigravity CLI',
    description: 'Google Antigravity CLI (agy), structured — no approval gate in this mode',
    transports: ['structured'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    forcesSkipPermissions: true,
    structuredKind: 'agy-cli',

    buildCommand() {
      // Args are unused for the structured transport (AgySession builds its
      // own per-turn argv); this only has to be truthful for `isAvailable`
      // and for `env` merging, which happens regardless of transport.
      return { command: bin, args: [] };
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
