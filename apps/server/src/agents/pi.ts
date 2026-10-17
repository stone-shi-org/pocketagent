import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';

/**
 * `pi` (`@earendil-works/pi-coding-agent`), driven through its `--mode rpc`
 * JSON protocol over stdin/stdout.
 *
 * `forcesSkipPermissions` is `true` for the same class of reason as `agy`,
 * but a stronger version of it: agy's headless mode merely has no approval
 * channel *in that mode* — pi has none anywhere, by explicit design. Its own
 * security docs are direct about this: "It is not a sandbox and it does not
 * restrict what the model can ask tools to do" and "Pi does not include a
 * built-in sandbox." The `--approve`/`-a` flag some `pi --help` output
 * mentions governs trusting *project-local config/extension files*, not tool
 * calls — reading, writing, and running shell commands happen unconditionally
 * once a tool is enabled, in every mode, including the RPC mode used here.
 * The only user-interaction channel in the RPC protocol is the *extension* UI
 * sub-protocol (`ctx.ui.confirm()` etc.), which nothing in pi's own built-in
 * tools uses — it exists for third-party extensions to build their own
 * prompts, not as a built-in approval gate this adapter could hook into.
 */
export function createPiAdapter(bin: string): AgentAdapter {
  return {
    id: 'pi',
    displayName: 'pi',
    description: 'pi coding agent, structured — no approval gate by design (no sandbox)',
    transports: ['structured'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    forcesSkipPermissions: true,
    structuredKind: 'pi-rpc',

    buildCommand() {
      // Args are unused for the structured transport: `PiSession` builds its
      // own argv per session. This only has to be truthful for `isAvailable`
      // and env merging, same as the other three.
      return { command: bin, args: [] };
    },

    bin,

    /**
     * `pi auth check` (added in v1.3.0) requires `--provider <provider>` or
     * `--model <model>`, so a static probe argv cannot ask it across a
     * multi-provider CLI without guessing which provider the operator
     * configured. `pi --offline --list-models` evaluates all active credential
     * sources at once (`~/.pi/agent/auth.json`, `~/.pi/agent/models.json`, and
     * provider environment variables) in ~0.35s with no network traffic (PA-160):
     *   - signed out (zero providers configured): exits 0 with
     *     `No models available. Use /login to log into a provider via OAuth or API key.`
     *   - signed in: exits 0 after printing a `provider  model  context  max-out  thinking  images`
     *     table listing every available model and its provider in column 1.
     */
    authProbe: {
      args: ['--offline', '--list-models'],
      interpret({ stdout, stderr, code, timedOut }) {
        if (timedOut) return { state: 'unknown', detail: 'pi --list-models did not respond in time.' };
        const text = `${stdout}\n${stderr}`.trim();
        if (/\bno\s+models\s+available\b/i.test(text)) {
          return {
            state: 'signed-out',
            detail: 'Not signed in. Run `pi` in a shell session or configure provider API keys.',
          };
        }
        if (code === 0) {
          const lines = stdout.split(/\r?\n/);
          const headerIdx = lines.findIndex((line) => /^\s*provider\s+model(?:\s+|$)/i.test(line));
          if (headerIdx !== -1) {
            const providers: string[] = [];
            for (const rawLine of lines.slice(headerIdx + 1)) {
              const trimmed = rawLine.trim();
              if (trimmed === '' || /^[-=\s]+$/.test(trimmed)) continue;
              const cols = trimmed.split(/\s+/);
              const provider = cols[0];
              if (cols.length >= 2 && provider && !/^[-=]+$/.test(provider)) {
                if (!providers.includes(provider)) {
                  providers.push(provider);
                }
              }
            }
            if (providers.length > 0) {
              return {
                state: 'ready',
                detail: `Signed in (${providers.join(', ')})`,
              };
            }
          }
        }
        return {
          state: 'unknown',
          detail: text === '' ? 'pi --list-models printed nothing.' : text.slice(0, 200),
        };
      },
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
