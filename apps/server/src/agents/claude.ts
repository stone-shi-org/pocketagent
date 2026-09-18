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

    bin,

    /**
     * `claude auth status` answers JSON on stdout *by default* (`--text` is
     * the opt-in for humans), runs in ~0.2s and touches no network — verified
     * against the real CLI. That makes it the one probe here that is both
     * cheap and unambiguous.
     *
     * Deliberately not `claude -p /usage`, which `usage/claude-source.ts`
     * already runs: that is a headless *agent* invocation, so it files a
     * transcript (the whole reason `usage/probe-cwd.ts` exists) and conflates
     * "signed out" with "the output format changed". And deliberately not
     * reading `~/.claude/.credentials.json`: the CLI also accepts
     * `ANTHROPIC_API_KEY` and an `apiKeyHelper`, so an absent credentials file
     * does not mean signed out.
     */
    authProbe: {
      args: ['auth', 'status'],
      interpret({ stdout, stderr, timedOut }) {
        if (timedOut) return { state: 'unknown', detail: 'claude auth status did not respond in time.' };
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          // A future CLI that stops answering JSON must not read as signed in.
          const text = (stdout || stderr).trim().slice(0, 200);
          return {
            state: 'unknown',
            detail: text === '' ? 'claude auth status printed nothing.' : text,
          };
        }
        if (typeof parsed !== 'object' || parsed === null || !('loggedIn' in parsed)) {
          return { state: 'unknown', detail: 'claude auth status did not report a login state.' };
        }
        const row = parsed as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
        if (row.loggedIn !== true) {
          return { state: 'signed-out', detail: 'Not signed in. Run `claude` in a shell session on this host.' };
        }
        // The account's own email is deliberately left out: it is a personal
        // identifier and the method is what an operator actually needs to see.
        const parts = [row.authMethod, row.subscriptionType].filter(
          (v): v is string => typeof v === 'string' && v.length > 0,
        );
        return { state: 'ready', detail: parts.length > 0 ? `Signed in (${parts.join(', ')})` : 'Signed in' };
      },
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
