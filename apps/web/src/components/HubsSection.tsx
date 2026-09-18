import { useCallback, useEffect, useState } from 'react';
import type { HubCredentialSummary } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { useHostApi } from '../hosts/HostContext.js';

interface Props {
  onApiError: (error: unknown) => void;
}

/**
 * PA-63: the bound hubs of this backend — list and revoke.
 *
 * Read-and-revoke only, with no "add" affordance, which is the one way this
 * section differs from every other secret-backed list on this page
 * (`CustomClaudeProvidersSection`, `TelegramSection`). A hub credential is
 * minted by a *Hub* calling `POST /api/auth/hub-bind` with the master token an
 * operator pastes into it once; a button here could only work by this app
 * holding the master token, which is precisely what the feature exists to stop
 * anyone from having to store. So what the backend side offers is the property
 * a master token cannot: seeing what is bound, and cutting one off.
 *
 * There is no reveal, and unlike the provider/bot sections that is not a policy
 * choice this component implements — the server keeps only `sha256(token)`, so
 * there is nothing to reveal. `tokenPrefix` is shown instead: enough to match a
 * row against the token in hand on the Hub side, which is the only question an
 * operator can actually need answered here.
 */
export function HubsSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [hubs, setHubs] = useState<HubCredentialSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<HubCredentialSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listHubs();
      setHubs(res.hubs);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load bound hubs.');
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(hub: HubCredentialSummary): Promise<void> {
    setBusy(true);
    try {
      await api.revokeHub(hub.id);
      setConfirming(null);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not revoke that hub.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        A hub credential lets a Hub reach this backend without storing its access token. A Hub
        binds itself by sending that token once, to <code>/api/auth/hub-bind</code>, and keeps only
        what it gets back. Revoking here takes effect on the very next request — no restart.
      </p>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {hubs === null ? (
        <div className="spinner">Loading…</div>
      ) : hubs.length === 0 ? (
        <p className="planner-row-meta">No hubs bound.</p>
      ) : (
        hubs.map((hub) => (
          <div key={hub.id} className="planner-model-row">
            <span>
              <strong>{hub.label}</strong>
              <br />
              <span className="planner-row-meta">
                <code>{hub.tokenPrefix}…</code> · bound{' '}
                {new Date(hub.createdAt).toLocaleString()}
              </span>
              <br />
              <span className="planner-row-meta">
                {hub.lastSeenAt === null
                  ? 'Never used'
                  : `Last seen ${new Date(hub.lastSeenAt).toLocaleString()}${
                      hub.lastSeenIp === null ? '' : ` from ${hub.lastSeenIp}`
                    }`}
              </span>
            </span>
            <button
              type="button"
              className="planner-btn"
              disabled={busy}
              onClick={() => setConfirming(hub)}
            >
              Revoke
            </button>
          </div>
        ))
      )}

      {confirming && (
        <ConfirmDialog
          title={`Revoke ${confirming.label}?`}
          body={
            'That Hub stops reaching this backend immediately, including any session it is ' +
            'currently streaming. Sessions themselves keep running, and the Hub can bind again ' +
            'with the access token.'
          }
          confirmLabel="Revoke"
          busy={busy}
          onConfirm={() => void revoke(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}
