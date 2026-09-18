import { useState } from 'react';
import type { HostDirectory } from '../hosts/directory.js';

/**
 * Registering another backend (PA-67).
 *
 * Two sources, one dialog, and the difference is disclosed rather than hidden:
 * `directory.manageHint` says whether this writes to a Hub registry every
 * browser shares, or to this browser's own `localStorage`. Those promise very
 * different things and a user who assumes the wrong one will conclude the
 * feature is broken.
 *
 * ## Why a path and not a URL
 *
 * The field is a **same-origin path prefix**, because that is the only thing
 * that can work: requests authenticate with an HttpOnly `SameSite` cookie, so a
 * cross-origin backend would need `SameSite=None; Secure` and a credentialed
 * CORS allowlist, which the loopback-over-plain-HTTP posture cannot provide
 * (see `HostEndpoint`'s own doc comment, PA-60). A second host is therefore
 * something a reverse proxy already publishes on this origin, and this dialog
 * records where. `normalizeBasePath` cannot produce an absolute URL from
 * whatever is typed, so this input cannot point the browser at another origin
 * even deliberately.
 *
 * The default prefix matches the Hub's own routing table (`/h/<id>/api/**`), so
 * a host registered by hand today keeps the same address once a Hub is put in
 * front of the same backends.
 */
export function AddHostDialog({
  directory,
  onClose,
}: {
  directory: HostDirectory;
  onClose: () => void;
}): JSX.Element {
  const [id, setId] = useState('');
  const [label, setLabel] = useState('');
  const [basePath, setBasePath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Proposed, not forced: typing an id fills the prefix, but an operator whose
  // proxy mounts somewhere else can still say so.
  const effectiveBasePath = basePath.trim() === '' ? directory.defaultBasePathFor(id.trim()) : basePath;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const problem = await directory.add({
      id: id.trim(),
      label: label.trim() === '' ? id.trim() : label.trim(),
      basePath: effectiveBasePath,
    });
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
        aria-label="Add host"
      >
        <div className="sheet-title">Add a host</div>

        <label className="field">
          <span>Host id</span>
          <input
            type="text"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="dev02"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Name</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Second workstation"
          />
        </label>

        <label className="field">
          <span>Path prefix on this origin</span>
          <input
            type="text"
            value={basePath}
            onChange={(e) => setBasePath(e.target.value)}
            placeholder={id.trim() === '' ? '/h/dev02' : directory.defaultBasePathFor(id.trim())}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        <p className="hint">{directory.manageHint}</p>

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
            disabled={busy || id.trim() === ''}
          >
            {busy ? 'Adding…' : 'Add host'}
          </button>
        </div>
      </div>
    </div>
  );
}
