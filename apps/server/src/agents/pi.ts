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

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
