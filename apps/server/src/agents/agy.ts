import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter } from './types.js';
import { resolveExecutable } from './registry.js';
import { normalizeAgyModelList } from '../sessions/normalize.js';

/**
 * Google's Antigravity CLI (`agy`), driven over the `structured` transport via
 * its Agent Client Protocol stdio server (`agy acp`).
 *
 * There is deliberately no `terminal` entry in `transports`: `agy`'s
 * interactive TUI works fine over a PTY, but this adapter exists specifically
 * to get the native tool-card UI and button-driven approval sheet.
 *
 * Over ACP, `agy` supports a real approval gate via `session/request_permission`
 * when started without `--dangerously-skip-permissions`, so `supportsSkipPermissions`
 * is a genuine per-session opt-in (off by default) rather than forced. Note that
 * `agy acp`'s `default` mode still respects `~/.gemini/antigravity-cli/settings.json`
 * (`toolPermission: "always-proceed"` auto-approves tools even without the CLI flag).
 * See `AgySession` for the long-lived ACP subprocess model.
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

/**
 * Values of `toolPermission` in `~/.gemini/antigravity-cli/settings.json`
 * known to ask for approval before running terminal commands. Anything else
 * (`always-proceed`, `proceed-in-sandbox`, `custom`, or any future/unknown
 * value) fails closed and is disclosed as potentially auto-approving so a
 * bypassed session is never shown as supervised. Confirmed live against
 * agy 1.5.14: `session/set_mode(default)` does not override `settings.json`.
 */
const AGY_SUPERVISED_POLICIES = new Set(['request-review', 'strict']);

export interface AgySettingsAutoApproveInfo {
  autoApproves: boolean;
  toolPermission: string | null;
  settingsPath: string;
}

/**
 * Format the startup warning shown when agy's `settings.json` carries a
 * non-supervised `toolPermission` value.
 */
export function formatAgySettingsAutoApproveNotice(info: AgySettingsAutoApproveInfo): string {
  const value = info.toolPermission ?? 'unknown';
  return `agy's ${info.settingsPath} sets toolPermission: "${value}", so agy may auto-approve commands on its own without PocketAgent's approval gate. Change toolPermission to "request-review" or "strict" (or remove it) to require PocketAgent approval.`;
}

/**
 * Read agy's `settings.json` read-only to detect whether host-level
 * `toolPermission` may auto-approve commands even when PocketAgent starts
 * `agy acp` without `--dangerously-skip-permissions`. Fails closed for any
 * configured value other than known supervised modes (`request-review`,
 * `strict`). Never throws.
 */
export function readAgySettingsAutoApprove(opts: {
  settingsPath?: string;
  homeDir?: string;
} = {}): AgySettingsAutoApproveInfo {
  const settingsPath =
    opts.settingsPath ??
    path.join(opts.homeDir || os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { autoApproves: false, toolPermission: null, settingsPath };
    }
    const tp = (parsed as Record<string, unknown>).toolPermission;
    if (typeof tp !== 'string' || !tp.trim()) {
      return { autoApproves: false, toolPermission: null, settingsPath };
    }
    const normalized = tp.trim().toLowerCase();
    return {
      autoApproves: !AGY_SUPERVISED_POLICIES.has(normalized),
      toolPermission: tp.trim(),
      settingsPath,
    };
  } catch {
    return { autoApproves: false, toolPermission: null, settingsPath };
  }
}

export const AGY_EDIT_APPROVAL_DISCLOSURE =
  'Antigravity CLI (agy) auto-approves file edits inside the project folder; terminal commands ask for approval unless skip-permissions or ~/.gemini/antigravity-cli/settings.json toolPermission overrides it.';

export function createAgyAdapter(bin: string): AgentAdapter {
  return {
    id: 'agy',
    displayName: 'Antigravity CLI',
    description: 'Google Antigravity CLI (agy), structured via ACP',
    transports: ['structured'],
    defaultTransport: 'structured',
    supportsSkipPermissions: true,
    providerDisclosure: AGY_EDIT_APPROVAL_DISCLOSURE,
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
