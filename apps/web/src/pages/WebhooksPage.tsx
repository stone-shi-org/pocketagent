import { useCallback, useEffect, useState } from 'react';
import type { Webhook } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';

const REFRESH_MS = 5000;

interface Props {
  /** Opens one webhook's editor and delivery history. */
  onOpenWebhook: (webhookId: string) => void;
  /** Every webhook's call history in one feed, including unmatched hits. */
  onOpenHistory: () => void;
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route. `DesktopShell` renders this in its right
   * pane with the sidebar already on screen, so it passes nothing — the same
   * "shared content, per-shell chrome" split `CronJobsPage` uses.
   */
  onBack?: () => void;
}

/**
 * The list of inbound webhooks.
 *
 * Polls like `CronJobsPage`, for a slightly different reason: a webhook has no
 * countdown to tick, but `lastDeliveryStatus` changes when something outside
 * this machine decides it should, and that is exactly what someone watching
 * this page is waiting for.
 */
export function WebhooksPage({
  onOpenWebhook,
  onOpenHistory,
  onApiError,
  onBack,
}: Props): JSX.Element {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Webhook ids with an action in flight, so a row cannot be double-fired. */
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { webhooks } = await api.listWebhooks();
      setHooks(webhooks);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load webhooks.');
      setHooks([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const withBusy = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusy((prev) => new Set(prev).add(id));
      try {
        await action();
        await load();
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'That did not work.');
        // Undo whatever was applied optimistically below.
        await load();
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [load, onApiError],
  );

  /** Optimistic-then-reconcile, same shape and reason as `CronJobsPage`. */
  const setEnabled = useCallback(
    (id: string, enabled: boolean) => {
      setHooks((prev) => prev?.map((h) => (h.id === id ? { ...h, enabled } : h)) ?? prev);
      void withBusy(id, () => api.updateWebhook(id, { enabled }));
    },
    [withBusy],
  );

  const content = (
    <div className="cron-page">
      <div className="cron-head">
        <div>
          <h2>Webhooks</h2>
          <p className="cron-sub">
            Each webhook gives an outside system a URL. A matching event starts an agent here.
          </p>
        </div>
        <div className="cron-head-actions">
          <button type="button" className="cron-secondary" onClick={onOpenHistory}>
            <Icon name="clock" size={16} />
            Call history
          </button>
          <button type="button" className="cron-new" onClick={() => onOpenWebhook('new')}>
            <Icon name="plus" size={18} />
            New webhook
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {hooks === null && <div className="spinner">Loading…</div>}
      {hooks?.length === 0 && (
        <div className="cron-empty">
          No webhooks yet. A webhook lets Jira start an agent in a project when an issue changes —
          for triage, for a first look at a bug report.
        </div>
      )}

      {hooks?.map((hook) => (
        <div key={hook.id} className={`cron-row${hook.enabled ? '' : ' disabled'}`}>
          <button type="button" className="cron-main" onClick={() => onOpenWebhook(hook.id)}>
            <span className="cron-row-title">
              <Icon name="webhook" size={17} className="cron-row-icon" />
              {hook.name}
              {hook.skipPermissionsEnabled && (
                // Persistent, not just at creation. More load-bearing here than
                // for a cron job: this one runs on a prompt partly written by
                // whoever can file a ticket.
                <Icon
                  name="shield"
                  size={14}
                  className="cron-shield"
                  aria-label="Approvals bypassed"
                />
              )}
            </span>
            <span className="cron-row-meta">
              <code className="hook-path">{hook.deliveryPath}</code>
              {' · '}
              {hook.workspaceLabel}
            </span>
            <span className="cron-row-meta">
              {hook.enabled ? (
                hook.lastDeliveryAt === null ? (
                  // Not an empty state to hide: a webhook that has never fired
                  // is the most likely broken one, and this is the only signal
                  // that anything is wrong.
                  <>Never fired</>
                ) : (
                  <>
                    <span
                      className={`cron-status cron-status--${hook.lastDeliveryStatus ?? 'unknown'}`}
                    >
                      {hook.lastDeliveryStatus ?? 'delivered'}
                    </span>{' '}
                    {formatRelative(hook.lastDeliveryAt)}
                  </>
                )
              ) : (
                <>Disabled — the URL answers as if it did not exist</>
              )}
              {hook.deliveryCounts.total > 0 && (
                <>
                  {' · '}
                  {hook.deliveryCounts.ran} ran
                  {hook.deliveryCounts.filtered > 0 && `, ${hook.deliveryCounts.filtered} filtered`}
                  {hook.deliveryCounts.rejected > 0 && `, ${hook.deliveryCounts.rejected} rejected`}
                </>
              )}
            </span>
            {hook.lastError !== null && <span className="cron-row-error">{hook.lastError}</span>}
          </button>

          <div className="cron-actions">
            {/* "Send test delivery" rather than cron's "Run now": for a webhook
                nobody can reach yet, "run now" answers the wrong question. A test
                delivery exercises the filter, the template and the runner at
                once, which is what is actually in doubt. */}
            <button
              type="button"
              className="round-btn plain"
              disabled={busy.has(hook.id)}
              onClick={() => void withBusy(hook.id, () => api.sendTestDelivery(hook.id))}
              aria-label={`Send a test delivery to ${hook.name}`}
              title="Send test delivery"
            >
              <Icon name="play" size={16} />
            </button>
            <label
              className="switch"
              title={hook.enabled ? 'Disable this webhook' : 'Enable this webhook'}
            >
              <input
                type="checkbox"
                checked={hook.enabled}
                onChange={(e) => setEnabled(hook.id, e.target.checked)}
                aria-label={`${hook.name} enabled`}
              />
              <span className="switch-track" />
            </label>
          </div>
        </div>
      ))}
    </div>
  );

  if (!onBack) return content;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <strong>Webhooks</strong>
      </header>
      {content}
    </div>
  );
}
