import { useState } from 'react';
import type { HostDirectory } from '../hosts/directory.js';

/**
 * Pastes a backend's master token into the Hub once, to mint (or re-mint) the
 * scoped `pah_` credential the Hub holds for it (PA-63/PA-66).
 *
 * This is the second half of `README.md`'s documented "add a host, then bind
 * it" flow — `AddHostDialog` covers binding at creation time, when the token
 * is already in hand; this one covers every case that isn't that: a host
 * added without a token, a host whose stored credential no longer decrypts
 * (`POCKETAGENT_SETTINGS_ENC_KEY` rotated on the Hub, which reads identically
 * to "never bound" — see `HostRegistry.credentialFor`), or deliberately
 * rotating one that still works. All three end up needing the exact same
 * call, `POST /api/hub/hosts/:id/bind`, so `HostSheet` opens this for both a
 * never-bound row ("Bind") and an already-bound one ("Re-bind") rather than
 * drawing two dialogs for one request shape.
 *
 * The token itself is never the caller's to keep: it is read from this field,
 * spent on one request, and the input holds nothing worth restoring if the
 * dialog is reopened, which is why there is no controlled persistence of it
 * anywhere above this component.
 */
export function BindHostDialog({
  directory,
  hostId,
  hostLabel,
  alreadyBound,
  onClose,
}: {
  directory: HostDirectory;
  hostId: string;
  hostLabel: string;
  /** Changes the verb only — the request is identical either way. */
  alreadyBound: boolean;
  onClose: () => void;
}): JSX.Element {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const problem = await directory.bind(hostId, token.trim());
    setBusy(false);
    if (problem) {
      setError(problem);
      return;
    }
    onClose();
  };

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={alreadyBound ? 'Re-bind host' : 'Bind host'}
      >
        <div className="sheet-title">{alreadyBound ? 'Re-bind' : 'Bind'} {hostLabel}</div>

        <p className="hint">
          Paste {hostLabel}&rsquo;s <code>POCKETAGENT_AUTH_TOKEN</code> (the master token from
          its own <code>.env</code>). The Hub exchanges it once for a scoped credential and
          never stores the token itself.
          {alreadyBound &&
            ' This mints a fresh credential and replaces the one currently stored — do this if the host has stopped answering with "no usable credential".'}
        </p>

        <label className="field">
          <span>Access token</span>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="that backend's POCKETAGENT_AUTH_TOKEN"
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </label>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        <div className="host-dialog-actions">
          <button type="button" className="sheet-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void submit()}
            disabled={busy || token.trim() === ''}
          >
            {busy ? 'Binding…' : alreadyBound ? 'Re-bind' : 'Bind'}
          </button>
        </div>
      </div>
    </div>
  );
}
