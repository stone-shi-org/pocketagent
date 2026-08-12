import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * Claude Code, launched exactly the way a human would launch it: the documented
 * `claude` entry point, no arguments, in the chosen directory.
 *
 * There is deliberately nothing else here by default. No flags, no wrapper
 * scripts, no authentication handling — the CLI uses whatever credentials it
 * already has on this machine, and any interactive prompt it shows is answered
 * by the user's keystrokes travelling over the WebSocket.
 *
 * The one flag this adapter *can* add is `--dangerously-skip-permissions`, and
 * only when the caller explicitly opted in via `skipPermissions`. It is never
 * the default: PocketAgent's whole reason to exist is routing every approval
 * to the browser, so bypassing that has to be a choice made per session, not
 * something baked into how this adapter launches the CLI.
 */
export function createClaudeAdapter(bin: string): AgentAdapter {
  return {
    id: 'claude',
    displayName: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    // Claude Code can be driven either way. Structured is the default because
    // it gives a native UI; terminal stays available as the exact-fidelity
    // fallback and for anything the structured UI does not yet render.
    transports: ['structured', 'terminal'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,

    buildCommand(options) {
      return {
        command: bin,
        args: options.skipPermissions ? ['--dangerously-skip-permissions'] : [],
      };
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
