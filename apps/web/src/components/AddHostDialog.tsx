import { useState } from 'react';
import type { HostDirectory } from '../hosts/directory.js';

/**
 * Registering another backend (PA-67).
 *
 * Two sources, one dialog, and the difference is disclosed rather than hidden:
 * `directory.manageHint` says whether this writes to a Hub registry every
 * browser shares, or to this browser's own `localStorage`. Those promise very
 * different things and a user who assumes the wrong one will conclude the
 * feature is broken. It is also why the third field's own label and
 * placeholder are source-conditional rather than fixed text — the two modes
 * hand the *same value* to two different network hops.
 *
 * ## Local mode: a path, not a URL
 *
 * With no Hub, this field is a **same-origin path prefix**, because that is
 * the only thing that can work: requests authenticate with an HttpOnly
 * `SameSite` cookie, so a cross-origin backend would need `SameSite=None;
 * Secure` and a credentialed CORS allowlist, which the loopback-over-plain-HTTP
 * posture cannot provide (see `HostEndpoint`'s own doc comment, PA-60). A
 * second host is therefore something a reverse proxy already publishes on
 * this origin, and this dialog records where. `normalizeBasePath` cannot
 * produce an absolute URL from whatever is typed, so this input cannot point
 * *this browser* at another origin even deliberately.
 *
 * The default prefix matches the Hub's own routing table (`/h/<id>/api/**`),
 * so a host registered by hand today keeps the same address once a Hub is
 * put in front of the same backends.
 *
 * ## Hub mode: a URL, not a path
 *
 * With a Hub, `directory.add` sends this same field as `baseUrl` straight to
 * `POST /api/hub/hosts` — the address the *Hub process* dials directly on its
 * own network (e.g. `http://dev01:8787`), which is an entirely different hop
 * from anything the browser touches. A path prefix here would be rejected by
 * the Hub's own `baseUrlProblem` (`new URL('/h/dev02')` throws), and
 * `/h/<id>` — the right default for local mode — would be actively wrong
 * advice in this one, so no default is offered here at all.
 *
 * ## No id field (PA-107)
 *
 * The routing id (`#/h/<id>/`, `/h/<id>/api/**`) is generated from the name
 * by `directory.proposeId` — see `generateHostId` for the rules and for why
 * the browser rather than the Hub mints it. It is shown, not asked for: a
 * user who pastes a deep link should be able to see where it points, but
 * nobody should have to invent a URL slug beside a name. It is fixed at add
 * time; `EditHostDialog` renames the label only.
 *
 * ## The token field is Hub-only, and optional
 *
 * Adding a Hub host and binding it are still two different calls
 * (`POST /api/hub/hosts` then `POST /api/hub/hosts/:id/bind` — see
 * `README.md`'s own "add a host, then bind it" wording), but a token
 * pasted in here lets this one submit do both in sequence, since that is
 * the overwhelmingly common case: you have the backend's token in hand
 * *because* you are adding it right now. Leaving it blank still adds the
 * host, unbound, exactly as before — `HostSheet`'s per-row Bind/Re-bind
 * action (`BindHostDialog`) is what covers a host added without one, or
 * one whose stored credential stopped decrypting after the Hub's own
 * `POCKETAGENT_SETTINGS_ENC_KEY` changed.
 */
export function AddHostDialog({
  directory,
  onClose,
}: {
  directory: HostDirectory;
  onClose: () => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [basePath, setBasePath] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isHub = directory.source === 'hub';
  const trimmedLabel = label.trim();
  // Empty until there is a name, so the preview does not flash `host-x3k9q2`
  // (the empty-slug fallback) before anything has been typed.
  const id = trimmedLabel === '' ? '' : directory.proposeId(trimmedLabel);

  // Proposed, not forced, and *local mode only*: typing a name fills the
  // prefix, but an operator whose proxy mounts somewhere else can still say
  // so. In Hub mode `/h/<id>` is a path, not a reachable address, so there is
  // no sensible default to fall back to — an empty field stays empty and the
  // submit button below refuses it instead.
  const effectiveBasePath =
    !isHub && basePath.trim() === '' ? directory.defaultBasePathFor(id) : basePath;

  const trimmedToken = token.trim();

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const added = await directory.add({
      id,
      label: trimmedLabel,
      basePath: effectiveBasePath,
    });
    if (added.error !== null) {
      setBusy(false);
      setError(added.error);
      return;
    }
    if (isHub && trimmedToken !== '') {
      // `added.id`, not `id`: on a Hub conflict `add` re-derives it.
      const bindProblem = await directory.bind(added.id, trimmedToken);
      setBusy(false);
      if (bindProblem) {
        // The host was added either way — only the bind half failed — so this
        // is not the same kind of error as the block above: closing now would
        // hide that the host exists but still needs `HostSheet`'s Bind action.
        setError(`Host added, but bind failed: ${bindProblem} You can bind it later from the Hosts panel.`);
        return;
      }
      onClose();
      return;
    }
    setBusy(false);
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
          <span>Name</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Second workstation"
            maxLength={200}
          />
        </label>
        {id !== '' && (
          <p className="hint host-id-preview">
            Links to this host will use <code>#/h/{id}/</code>. It stays the same if you rename it.
          </p>
        )}

        <label className="field">
          <span>{isHub ? 'Backend address (as the Hub can reach it)' : 'Path prefix on this origin'}</span>
          <input
            type="text"
            value={basePath}
            onChange={(e) => setBasePath(e.target.value)}
            placeholder={
              isHub
                ? 'http://dev02:8787'
                : id === ''
                  ? '/h/second-workstation'
                  : directory.defaultBasePathFor(id)
            }
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>

        {isHub && (
          <label className="field">
            <span>Access token (optional — binds immediately)</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="that backend's POCKETAGENT_AUTH_TOKEN"
              autoComplete="new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
        )}

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
            // Hub mode has no default to fall back to (see `effectiveBasePath`),
            // so an empty field here is a missing required address, not a
            // "use the convention" signal the way it is in local mode.
            disabled={busy || trimmedLabel === '' || (isHub && basePath.trim() === '')}
          >
            {busy ? (isHub && trimmedToken !== '' ? 'Adding & binding…' : 'Adding…') : 'Add host'}
          </button>
        </div>
      </div>
    </div>
  );
}
