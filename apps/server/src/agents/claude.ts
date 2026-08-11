import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * Claude Code, launched exactly the way a human would launch it: the documented
 * `claude` entry point, no arguments, in the chosen directory.
 *
 * There is deliberately nothing else here. No flags, no wrapper scripts, no
 * authentication handling — the CLI uses whatever credentials it already has on
 * this machine, and any interactive prompt it shows is answered by the user's
 * keystrokes travelling over the WebSocket.
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

    buildCommand() {
      return { command: bin, args: [] };
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
