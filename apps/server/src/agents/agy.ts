import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';
import { normalizeAgyModelList } from '../sessions/normalize.js';

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
 * `AgySession` for the long-lived subprocess model this implies.
 */
/**
 * Force `agy`'s `CompositeTokenStorage` onto its file-based token store
 * (`~/.gemini/antigravity-cli/antigravity-oauth-token`) rather than the OS
 * keyring (`org.freedesktop.secrets` over `/run/user/$UID/bus`).
 *
 * Confirmed against `agy` v1.3.6 (`composite_token_storage.go` +
 * `keyring_detector_ssh.go`):
 *   - When an operator signs in or switches accounts over SSH, `SSH_CONNECTION`
 *     (or `SSH_CLIENT` / `SSH_TTY`) is set, so `sshDetector.Detect()` triggers
 *     ("Using file-based token storage because SSH session detected") and
 *     writes the OAuth token only to `antigravity-oauth-token`, leaving any
 *     desktop keyring (`gnome-keyring-daemon`) untouched.
 *   - When PocketAgent runs as a `systemd --user` service on a Linux host that
 *     also has a desktop/XRDP session (`DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID/bus`),
 *     `SSH_*` is absent from the daemon's environment. Without it, `agy`
 *     consults `gnome-keyring-daemon` first — reading a stale account from the
 *     keyring instead of the account configured over SSH, or writing refreshed
 *     tokens back into the keyring so the next SSH account switch splits the
 *     two stores again (`dbusDetector` still sees the `/run/user/$UID/bus`
 *     socket even when `DBUS_SESSION_BUS_ADDRESS` is unset or `disabled:`).
 */
export function agyFileTokenStorageEnv(
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    SSH_CONNECTION: base.SSH_CONNECTION || 'pocketagent',
  };
}

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
      // own argv); this only has to be truthful for `isAvailable`
      // and for `env` merging, which happens regardless of transport.
      return { command: bin, args: [], env: agyFileTokenStorageEnv() };
    },

    bin,

    /**
     * `agy` has no `auth` or `login status` subcommand, so this reuses
     * `agy models` (PA-146). Checked against the real CLI:
     *   - signed in: exits 0 after printing `<id>\t<label>` model lines
     *     (`auto\tGemini Pro Next`, …)
     *   - signed out (empty `$HOME`): exits 1 in ~0.4s with
     *     `Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`
     *
     * Unlike `claude auth status`, `agy models` makes a network call when
     * signed in (and creates `~/.gemini` if missing), so a network error,
     * timeout, or exit-0 output with no model lines must map to `unknown`
     * with the CLI's own words — never to `signed-out` and never to `ready`.
     */
    authProbe: {
      args: ['models'],
      interpret({ stdout, stderr, code, timedOut }) {
        if (timedOut) return { state: 'unknown', detail: 'agy models did not respond in time.' };
        const text = `${stdout}\n${stderr}`.trim();
        if (/\bplease\s+sign\s+in\b/i.test(text)) {
          return { state: 'signed-out', detail: 'Not signed in. Run `agy` in a shell session on this host.' };
        }
        if (code === 0 && normalizeAgyModelList(stdout).length > 0) {
          return { state: 'ready', detail: 'Signed in' };
        }
        return {
          state: 'unknown',
          detail: text === '' ? 'agy models printed nothing.' : text.slice(0, 200),
        };
      },
    },

    isAvailable() {
      return resolveExecutable(bin) !== null;
    },
  };
}
