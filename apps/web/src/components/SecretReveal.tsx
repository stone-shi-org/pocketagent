import { useEffect, useState } from 'react';
import { copyText } from '../agent/clipboard.js';
import { CopyButton } from './CopyButton.js';
import { Icon } from './Icon.js';

/** Where a viewer's own origin override is remembered. Not server state. */
const ORIGIN_KEY = 'pocketagent.webhookOrigin';

/**
 * The endpoint panel: the URL to paste into Jira, and the secret to sign with.
 *
 * Two things here are deliberately not what they first look like.
 *
 * **The secret is recoverable.** "Shown once at creation" is imported from
 * password UX, where it follows from storing a hash. HMAC verification needs the
 * plaintext server-side, so the database holds it either way and the server can
 * always re-display it — making it unrecoverable in the UI would cost the user
 * their afternoon and buy nothing. So it is shown at creation *and* behind an
 * explicit Reveal, and is never in a list or get response.
 *
 * **The URL is composed in the browser.** The server cannot know its own
 * external origin: the bind is loopback by default and `Host`/`X-Forwarded-Host`
 * are attacker-supplied claims, so any server-composed URL is a guess presented
 * as a fact — and a wrong one sends the user off to debug Jira for an hour.
 * Instead the origin comes from this browser — which demonstrably reaches the
 * server, since it is being served by it — overridable per browser for the real
 * topology where you administer over one address and Jira reaches another. The
 * panel always says which it used.
 */
export function SecretReveal({
  deliveryPath,
  secret,
  firstDeliveryAt,
  authMode,
  token,
  onReveal,
  onRotate,
}: {
  deliveryPath: string;
  /** Non-null right after creation or a reveal; null when collapsed. */
  secret: string | null;
  /**
   * When the first delivery arrived, or null if none ever has.
   *
   * That null is load-bearing information rather than an empty state to hide:
   * nothing can prove Jira is able to reach this server, so a received delivery
   * is the only evidence and its absence is what the panel shows.
   */
  firstDeliveryAt: number | null;
  authMode: 'hmac' | 'bearer';
  token?: string | null;
  onReveal: () => Promise<void>;
  onRotate: () => Promise<void>;
}): JSX.Element {
  const [override, setOverride] = useState<string>(
    () => window.localStorage.getItem(ORIGIN_KEY) ?? '',
  );
  const [editingOrigin, setEditingOrigin] = useState(false);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (override.trim() === '') window.localStorage.removeItem(ORIGIN_KEY);
    else window.localStorage.setItem(ORIGIN_KEY, override.trim());
  }, [override]);

  const browserOrigin = window.location.origin;
  const chosen =
    override.trim() !== ''
      ? { origin: override.trim().replace(/\/+$/, ''), why: 'from your override below' }
      : { origin: browserOrigin, why: 'as this browser reached the server' };
  const url = `${chosen.origin}${deliveryPath}`;

  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="settings-row settings-row-stacked">
        <div className="settings-row-info">
          <label className="settings-row-label">URL for Jira</label>
        </div>
        <div className="settings-row-control">
          <div className="endpoint-url">
            <code>{url}</code>
            <CopyButton text={url} label="Copy URL" />
          </div>
        </div>
        <p className="endpoint-origin-note">
          Origin {chosen.why}.{' '}
          <button type="button" className="linkish" onClick={() => setEditingOrigin((v) => !v)}>
            {editingOrigin ? 'Hide' : 'Change'}
          </button>
        </p>
        {override.trim() !== '' && override.trim() !== browserOrigin && (
          <p className="transport-hint">
            This browser reached the server at <code>{browserOrigin}</code>, which is different.
          </p>
        )}
        {editingOrigin && (
          <div className="settings-row-control">
            <input
              type="text"
              className="settings-input mono"
              value={override}
              placeholder={browserOrigin}
              spellCheck={false}
              onChange={(e) => setOverride(e.target.value)}
            />
            <p className="transport-hint">
              Remembered in this browser only. Use it when you administer PocketAgent over one
              address but Jira reaches it through another — a tunnel or a reverse proxy.
            </p>
          </div>
        )}
        <p className="transport-hint">
          {/* No "Test connection" button: it would originate from the server and
              prove nothing about the path from Jira. A delivery is the only
              ground truth, so its presence or absence is the test. */}
          PocketAgent cannot check that Jira can reach this URL.{' '}
          {firstDeliveryAt === null
            ? 'No delivery has arrived yet — that is how you will know it works.'
            : 'A delivery has arrived, so the path from Jira works.'}
        </p>
      </div>

      <div className="secret-callout">
        <div className="secret-head">
          <Icon name="shield" size={16} />
          <strong>{authMode === 'bearer' ? 'Bearer token' : 'Signing secret'}</strong>
        </div>

        {secret === null ? (
          <>
            <p className="transport-hint">
              Paste this into Jira&rsquo;s webhook secret field so it can sign each request.
            </p>
            <div className="secret-actions">
              <button type="button" disabled={busy} onClick={() => void act(onReveal)}>
                <Icon name="key" size={15} />
                Reveal
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Selectable and fully wrapped rather than ellipsised: a secret you
                cannot see is a secret you cannot transcribe when copy fails, and
                on a plain-HTTP origin copy genuinely can fail. */}
            <div className="secret-value">{secret}</div>
            <div className="secret-actions">
              <CopyButton text={secret} label="Copy secret" />
              {/* The real unit of work is filling two adjacent fields on Jira's
                  admin screen, so offer both at once — two trips back to a phone
                  are two chances to lose the tab. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void copyText(`URL: ${url}\nSecret: ${secret}`);
                }}
              >
                <Icon name="copy" size={15} />
                Copy URL + secret
              </button>
            </div>
            {token != null && (
              <>
                <p className="transport-hint">Bearer token, for a sender that cannot sign:</p>
                <div className="secret-value">{token}</div>
              </>
            )}
          </>
        )}

        <div className="secret-actions">
          {confirmingRotate ? (
            <button
              type="button"
              className="danger primary-danger"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await onRotate();
                  setConfirmingRotate(false);
                })
              }
            >
              Really rotate? Jira needs the new secret.
            </button>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmingRotate(true)}>
              <Icon name="rotate" size={15} />
              Rotate
            </button>
          )}
        </div>
        {/* No grace period, deliberately: an overlap window where both secrets
            verify doubles the exposure window to save one paste. A botched
            rotation is made loud instead — rejected rows appear in the delivery
            history within one Jira event. */}
        <p className="transport-hint">
          Rotating takes effect immediately. Deliveries signed with the old secret start being
          rejected, and show up in the history below.
        </p>
      </div>
    </>
  );
}
