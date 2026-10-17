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

    bin,

    /**
     * In OpenCode v1, `opencode auth list` only emitted ANSI-decorated box
     * drawing with no machine-readable option, so `opencode` had no probe and
     * reported `unknown`. OpenCode v2 (`2.0.x`) adds `--standalone` and
     * `--format json` (`opencode auth list --standalone --format json`, PA-159):
     *   - resolves in ~0.2s with no TTY and never prompts
     *   - `--standalone` reads `~/.local/share/opencode/opencode.db` and
     *     provider environment variables in-process without needing `opencode
     *     serve` to be running
     *   - signed in: exits 0 with a JSON array of integrations and their
     *     connections (`[{ "id": "opencode", "name": "OpenCode Console",
     *     "connections": [{ "type": "credential", "label": "Default",
     *     "method": "oauth" }] }]`)
     *   - signed out: exits 0 with `[]` (or text `No authenticated integrations`
     *     without `--format json`)
     *
     * Older v1 binaries that reject `--standalone`/`--format json` or emit the
     * box-drawing table fail JSON parsing and degrade to `unknown` rather than
     * claiming `signed-out` or `ready`.
     */
    authProbe: {
      args: ['auth', 'list', '--standalone', '--format', 'json'],
      interpret({ stdout, stderr, code, timedOut }) {
        if (timedOut) return { state: 'unknown', detail: 'opencode auth list did not respond in time.' };
        const text = `${stdout}\n${stderr}`.trim();
        if (/\bno\s+authenticated\s+integrations\b/i.test(text)) {
          return {
            state: 'signed-out',
            detail: 'Not signed in. Run `opencode auth login` in a shell session on this host.',
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          const fallback = (stdout || stderr).trim().slice(0, 200);
          return {
            state: 'unknown',
            detail: fallback === '' ? 'opencode auth list printed nothing.' : fallback,
          };
        }
        if (!Array.isArray(parsed)) {
          return { state: 'unknown', detail: 'opencode auth list did not return an integration list.' };
        }
        if (parsed.length === 0) {
          if (code !== 0 && code !== null && stderr.trim().length > 0) {
            return { state: 'unknown', detail: stderr.trim().slice(0, 200) };
          }
          return {
            state: 'signed-out',
            detail: 'Not signed in. Run `opencode auth login` in a shell session on this host.',
          };
        }
        let activeCount = 0;
        const labels: string[] = [];
        for (const item of parsed) {
          if (typeof item !== 'object' || item === null || Array.isArray(item)) {
            return { state: 'unknown', detail: 'opencode auth list did not return an integration list.' };
          }
          const row = item as { id?: unknown; name?: unknown; connections?: unknown };
          const hasName = typeof row.name === 'string' && row.name.trim().length > 0;
          const hasId = typeof row.id === 'string' && row.id.trim().length > 0;
          const hasConnectionsField = 'connections' in row && row.connections !== undefined;
          if (hasConnectionsField && !Array.isArray(row.connections)) {
            return { state: 'unknown', detail: 'opencode auth list did not return an integration list.' };
          }
          const connections = Array.isArray(row.connections) ? row.connections : null;
          if (connections !== null && connections.some((c) => typeof c !== 'object' || c === null || Array.isArray(c))) {
            return { state: 'unknown', detail: 'opencode auth list did not return an integration list.' };
          }
          if (!hasName && !hasId && connections === null) {
            return { state: 'unknown', detail: 'opencode auth list did not return an integration list.' };
          }
          const isActive = connections !== null ? connections.length > 0 : hasName || hasId;
          if (!isActive) continue;
          activeCount += 1;

          const connLabel =
            connections
              ?.map((c) => {
                const conn = c as { label?: unknown; name?: unknown };
                if (typeof conn.label === 'string' && conn.label.trim().length > 0) return conn.label.trim();
                if (typeof conn.name === 'string' && conn.name.trim().length > 0) return conn.name.trim();
                return null;
              })
              .find((v): v is string => v !== null) ?? null;

          const label = hasName
            ? (row.name as string).trim()
            : connLabel ?? (hasId ? (row.id as string).trim() : null);
          if (label && !labels.includes(label)) {
            labels.push(label);
          }
        }
        if (code !== 0 && code !== null) {
          const fallback = text.slice(0, 200);
          return {
            state: 'unknown',
            detail: fallback === '' ? `opencode auth list exited with code ${code}.` : fallback,
          };
        }
        if (activeCount === 0) {
          return {
            state: 'signed-out',
            detail: 'Not signed in. Run `opencode auth login` in a shell session on this host.',
          };
        }
        return {
          state: 'ready',
          detail: labels.length > 0 ? `Signed in (${labels.join(', ')})` : 'Signed in',
        };
      },
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
