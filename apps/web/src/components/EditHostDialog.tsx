import { useState } from 'react';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostRecord } from '../hosts/host-status.js';

/**
 * Renames a host, or repoints its address, after it already exists.
 *
 * `AddHostDialog` and `BindHostDialog` cover creation and credentialing;
 * this is the third and last gap in host management — fixing a typo in a
 * label or address without deleting and re-adding the host (which, for a
 * Hub-bound host, would also discard its credential and start the bind
 * dance over). Same two-mode split as `AddHostDialog` — see its own doc
 * comment for why a `basePath` means a same-origin prefix in local mode and
 * an address the *Hub* dials in hub mode — but there is no id field here:
 * a host's id is its routing identity everywhere it is stored (a session's
 * cwd, a bookmark, `#/h/<id>/...`), so renaming it out from under those
 * would be a different operation entirely, not exposed by this dialog or by
 * the `PATCH` route it calls.
 */
export function EditHostDialog({
  directory,
  host,
  onClose,
}: {
  directory: HostDirectory;
  host: HostRecord;
  onClose: () => void;
}): JSX.Element {
  const isHub = directory.source === 'hub';
  // The id every management call must use — see `HostRecord.hubHostId`'s own
  // doc comment for why this can differ from `host.endpoint.id`.
  const hostId = host.hubHostId ?? host.endpoint.id;

  const [label, setLabel] = useState(host.label);
  const [basePath, setBasePath] = useState(isHub ? host.hubBaseUrl ?? '' : host.endpoint.basePath);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const problem = await directory.update(hostId, {
      label: label.trim(),
      basePath: basePath.trim(),
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
        aria-label="Edit host"
      >
        <div className="sheet-title">Edit {host.label}</div>

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
          <span>{isHub ? 'Backend address (as the Hub can reach it)' : 'Path prefix on this origin'}</span>
          <input
            type="text"
            value={basePath}
            onChange={(e) => setBasePath(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        {isHub && (
          <p className="hint">
            Changing the address does not touch this host&rsquo;s stored credential — if the
            new address points at a different machine entirely, bind it again from its row in
            this list.
          </p>
        )}

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
            disabled={busy || label.trim() === '' || basePath.trim() === ''}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
