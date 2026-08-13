import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * opencode, driven through `opencode serve`'s HTTP + SSE API rather than a
 * pseudo-terminal.
 *
 * Only `structured` is offered, same choice as `agy` and for a related but
 * different reason: opencode's server exposes a genuine multi-session daemon
 * with a real synchronous permission gate (`permission.updated` over SSE,
 * answered with `POST /permission/{id}/reply`) — unlike `agy`'s headless mode,
 * this one actually supports PocketAgent's default "ask for everything"
 * behaviour, so `supportsSkipPermissions` is a real per-session choice here,
 * not a fixed fact about the CLI (see `OpencodeSession` for how the bypass is
 * realized: there is no spawn-time flag for it in `serve` mode, so
 * PocketAgent auto-replies to every permission itself instead).
 *
 * `structuredKind: 'opencode-server'` tells `SessionManager` to route this
 * adapter's structured transport through `OpencodeSession`/
 * `OpencodeServerManager` instead of the Claude Agent SDK.
 */
export function createOpencodeAdapter(bin: string): AgentAdapter {
  return {
    id: 'opencode',
    displayName: 'opencode',
    description: 'opencode CLI, structured — served headlessly over HTTP',
    transports: ['structured'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    structuredKind: 'opencode-server',

    buildCommand() {
      // Args are unused for the structured transport: `OpencodeServerManager`
      // spawns `opencode serve` itself with its own fixed argv. This only has
      // to be truthful for `isAvailable` and env merging, same as `agy`.
      return { command: bin, args: [] };
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
