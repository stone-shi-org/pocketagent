import { useCallback, useEffect, useState } from 'react';
import type { HubWebhookRoutingHost } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { disableHubWebhookRouting, getHubWebhookRouting, setHubWebhookRouting } from '../api/hub.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/**
 * PA-171: which backends' webhooks may send runs to which other hosts.
 *
 * The allowlist is the control, and it lives here rather than on the source
 * backend because a backend choosing its own targets would be one machine
 * deciding to start work on another. Switching routing on hands that backend a
 * dispatch-only Hub token limited to the hosts ticked; the backend never sees
 * any other credential, and the target's own approval gate still applies.
 *
 * The address is prefilled from this browser's origin and editable, for the
 * reason `FleetAgentCard` gives: the Hub cannot know the address a backend
 * reaches it by. Talks only to the Hub origin (`api/hub.ts`).
 */

interface Props {
  onApiError: (error: unknown) => void;
}

type Pending = { kind: 'save'; host: HubWebhookRoutingHost; targets: string[] } | { kind: 'off'; host: HubWebhookRoutingHost };

export function HubWebhookRoutingCard({ onApiError }: Props): JSX.Element {
  const [hosts, setHosts] = useState<HubWebhookRoutingHost[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [hubUrl, setHubUrl] = useState<string>(() => window.location.origin);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);

  const apply = useCallback((next: HubWebhookRoutingHost[]) => {
    setHosts(next);
    // A draft is reset to what the Hub reports after every load, so a row
    // never shows ticks that are not what is actually in force.
    setDrafts(Object.fromEntries(next.map((h) => [h.hostId, [...h.allowedHosts]])));
  }, []);

  const load = useCallback(async () => {
    try {
      apply((await getHubWebhookRouting()).hosts);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load webhook routing.');
    }
  }, [apply, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  const labelOf = (id: string): string => hosts?.find((h) => h.hostId === id)?.label ?? id;
  const toggle = (hostId: string, target: string): void =>
    setDrafts((prev) => {
      const list = prev[hostId] ?? [];
      return { ...prev, [hostId]: list.includes(target) ? list.filter((t) => t !== target) : [...list, target] };
    });
  const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((x) => b.includes(x));

  async function confirm(p: Pending): Promise<void> {
    setBusy(true);
    try {
      const next =
        p.kind === 'save'
          ? await setHubWebhookRouting(p.host.hostId, {
              hubUrl: hubUrl.trim().replace(/\/+$/, ''),
              allowedHosts: p.targets,
            })
          : await disableHubWebhookRouting(p.host.hostId);
      apply(next.hosts);
      setError(null);
      setPending(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not change webhook routing.');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="hub-section" aria-labelledby="hub-webhook-routing-heading">
      <h2 id="hub-webhook-routing-heading">Webhook routing</h2>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        Lets a host&rsquo;s webhooks map a Jira project or Bamboo plan to a folder on another host, and run it there
        through this Hub. Each run&rsquo;s approvals are answered on the host it runs on, and that host&rsquo;s own
        setting decides whether they are skipped.
      </p>
      <label className="settings-row-label" htmlFor="hub-webhook-routing-url">
        Hub address the hosts will use
      </label>
      <input
        id="hub-webhook-routing-url"
        className="settings-input"
        value={hubUrl}
        onChange={(e) => setHubUrl(e.target.value)}
        aria-describedby="hub-webhook-routing-url-hint"
      />
      <p id="hub-webhook-routing-url-hint" className="transport-hint">
        Prefilled with this browser&rsquo;s address. Change it if the hosts reach the Hub by another name.
      </p>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {hosts === null ? (
        <div className="spinner">Loading…</div>
      ) : hosts.length === 0 ? (
        <p className="planner-row-meta">No bound hosts.</p>
      ) : (
        hosts.map((host) => {
          const others = hosts.filter((h) => h.hostId !== host.hostId);
          const draft = drafts[host.hostId] ?? [];
          const changed = !sameSet(draft, host.allowedHosts);
          return (
            <div key={host.hostId} className="settings-row settings-row-stacked">
              <div className="settings-row-info">
                <label className="settings-row-label">{host.label}</label>
                <p className="planner-row-meta">
                  {host.state === 'routed'
                    ? `Routing on (${host.tokenPrefix ?? ''}…) · may send runs to ${
                        host.allowedHosts.length === 0 ? 'no host' : host.allowedHosts.map(labelOf).join(', ')
                      }`
                    : host.state === 'failed'
                      ? 'The last attempt did not land.'
                      : 'Routing off · its webhooks run only on this host.'}
                </p>
                {host.message && <p className="transport-hint">{host.message}</p>}
              </div>
              <div className="settings-row-control">
                {others.length === 0 ? (
                  <p className="planner-row-meta">No other host to send runs to.</p>
                ) : (
                  others.map((target) => (
                    <label key={target.hostId} className="planner-checkbox-row">
                      <input
                        type="checkbox"
                        checked={draft.includes(target.hostId)}
                        disabled={busy}
                        onChange={() => toggle(host.hostId, target.hostId)}
                      />{' '}
                      {target.label}
                    </label>
                  ))
                )}
                <span style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button
                    type="button"
                    className="planner-btn"
                    disabled={busy || draft.length === 0 || hubUrl.trim() === '' || (!changed && host.state === 'routed')}
                    title={draft.length === 0 ? 'Tick at least one host, or switch routing off.' : undefined}
                    onClick={() => setPending({ kind: 'save', host, targets: draft })}
                  >
                    {host.state === 'routed' ? 'Save' : 'Switch on'}
                  </button>
                  {host.state !== 'none' && (
                    <button
                      type="button"
                      className="planner-btn"
                      disabled={busy}
                      onClick={() => setPending({ kind: 'off', host })}
                    >
                      Switch off
                    </button>
                  )}
                </span>
              </div>
            </div>
          );
        })
      )}

      {pending && (
        <ConfirmDialog
          title={
            pending.kind === 'save'
              ? `Let ${pending.host.label}'s webhooks run on other hosts?`
              : `Switch off webhook routing for ${pending.host.label}?`
          }
          body={
            pending.kind === 'save'
              ? `${pending.host.label} gets a dispatch-only token for ${hubUrl.trim().replace(/\/+$/, '')}, limited to ` +
                `${pending.targets.map(labelOf).join(', ')} and stored encrypted on ${pending.host.label}. Its webhook ` +
                'editor then offers those hosts on each mapping row. Runs sent there wait for approval on that host ' +
                'unless that host has chosen to skip approvals for dispatched runs.'
              : `The token ${pending.host.label} holds is revoked now. Its webhook rows that name another host stop ` +
                'being sent there; runs already started keep going on the host they are on.'
          }
          confirmLabel={pending.kind === 'save' ? (pending.host.state === 'routed' ? 'Save' : 'Switch on') : 'Switch off'}
          busy={busy}
          danger={pending.kind === 'off'}
          onConfirm={() => void confirm(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}
