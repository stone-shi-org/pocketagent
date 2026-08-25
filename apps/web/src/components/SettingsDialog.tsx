import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { getTerminalFontOverride, setTerminalFontOverride } from '../agent/terminal-font-pref.js';
import { formatBuildInfo } from '../version.js';

/**
 * Settings. One dangerous, server-wide switch, and one per-device display
 * preference that never leaves this browser.
 *
 * Skip-permissions bypasses approval for every session on this server: every
 * new one from the moment it is on, and every native (chat) session already
 * running, immediately and live. It does not reach a terminal session already
 * running — PocketAgent has no way to change `--dangerously-skip-permissions`
 * on a process after it has started, so an existing one keeps asking until it
 * is restarted. See the "global skip-permissions switch" note in CLAUDE.md.
 *
 * Turning it on always asks for a second, explicit confirmation, the same way
 * resuming in place or attaching to a tmux session does in `NewSessionDialog`
 * — this is at least as consequential as either of those.
 *
 * The terminal font override is nothing like that: it is `localStorage`, not
 * `/api/settings`, because it is true of *this device's browser*, not this
 * server — see `terminal-font-pref.ts` for why a per-server value would be
 * actively wrong (a laptop's own installed font silently breaking on a
 * phone that opens the same server).
 */
export function SettingsDialog({
  onClose,
  onApiError,
}: {
  onClose: () => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fontOverride, setFontOverride] = useState(() => getTerminalFontOverride() ?? '');

  useEffect(() => {
    let cancelled = false;
    api
      .getSettings()
      .then((s) => {
        if (!cancelled) setEnabled(s.skipPermissionsEnabled);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [onApiError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function apply(next: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateSettings(next);
      setEnabled(result.skipPermissionsEnabled);
      setConfirming(false);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not update the setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <h2>Settings</h2>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {enabled === null ? (
          <div className="spinner">Loading…</div>
        ) : confirming ? (
          <>
            <p className="confirm-body">
              Every session on this server — every agent, every directory — will run every
              tool call immediately, unattended. Nothing will be routed to you for approval.
            </p>
            <p className="confirm-body dim">
              Applies right away to any native chat session already running. A terminal
              session already open keeps asking until it is restarted.
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setConfirming(false)} disabled={busy}>
                Back
              </button>
              <button
                type="button"
                className="danger primary-danger"
                onClick={() => void apply(true)}
                disabled={busy}
              >
                {busy ? 'Enabling…' : 'Skip approvals everywhere'}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="terminal-font">Terminal font</label>
              <input
                id="terminal-font"
                type="text"
                value={fontOverride}
                placeholder='Bundled default: "JetBrainsMono Nerd Font Mono"'
                onChange={(e) => {
                  setFontOverride(e.target.value);
                  setTerminalFontOverride(e.target.value);
                }}
              />
              <p className="transport-hint">
                Terminals already render Powerline and Nerd Font glyphs out of the box, using a
                font bundled with the app — nothing to install, and it looks the same on every
                device. Only set this if you already have a different font installed on{' '}
                <strong>this device</strong> and prefer it; leave it blank otherwise, since a
                font installed here would be missing entirely on your phone or any other device
                you open this same server from. Applies to terminals opened after this change,
                not ones already on screen.
              </p>
            </div>

            <div className="field checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.checked) setConfirming(true);
                    else void apply(false);
                  }}
                />
                Skip approvals for every session
              </label>
              <p className="warn-note danger-note">
                Off by default. Overrides the per-session choice for every agent on this
                server, including sessions already running. Only turn this on if you fully
                accept that nothing here will ask before running a command or editing a file.
              </p>
            </div>

            <p className="version-footer">{formatBuildInfo()}</p>

            <div className="dialog-actions">
              <button type="button" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
