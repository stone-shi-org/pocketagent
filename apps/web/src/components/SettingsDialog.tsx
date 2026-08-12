import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';

/**
 * Server-wide settings. Today this is exactly one dangerous switch.
 *
 * Turning it on bypasses approval for every session on this server: every new
 * one from the moment it is on, and every native (chat) session already
 * running, immediately and live. It does not reach a terminal session already
 * running — PocketAgent has no way to change `--dangerously-skip-permissions`
 * on a process after it has started, so an existing one keeps asking until it
 * is restarted. See the "global skip-permissions switch" note in CLAUDE.md.
 *
 * Turning it on always asks for a second, explicit confirmation, the same way
 * resuming in place or attaching to a tmux pane does in `NewSessionDialog` —
 * this is at least as consequential as either of those.
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
