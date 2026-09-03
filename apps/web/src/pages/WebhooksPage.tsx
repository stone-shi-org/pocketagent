import { useCallback, useEffect, useState } from 'react';
import type { Webhook } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import { WebhookHistoryPanel } from '../components/WebhookHistoryPanel.js';

const REFRESH_MS = 5000;

interface Props {
  /** Opens one webhook's editor and delivery history. */
  onOpenWebhook: (webhookId: string) => void;
  /** Opens a call-history row's live or finished transcript. */
  onOpenSession: (sessionId: string) => void;
  onOpenChat: (conversationId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route. `DesktopShell` renders this in its right
   * pane with the sidebar already on screen, so it passes nothing — the same
   * "shared content, per-shell chrome" split `CronJobsPage` uses.
   */
  onBack?: () => void;
}

/**
 * The list of inbound webhooks, and — below it, on the same page — every
 * webhook's call history in one feed.
 *
 * These used to be two destinations (`#/hooks` and `#/hooks/history`), which
 * meant navigating into history needed its own way back. Folding history into
 * a second section here removes that question entirely: there is nowhere to
 * navigate back *from*, because you never left. `WebhookHistoryPanel` owns its
 * own fetch/loading/error state independently of the list above it.
 *
 * The list itself polls like `CronJobsPage`, for a slightly different reason:
 * a webhook has no countdown to tick, but `lastDeliveryStatus` changes when
 * something outside this machine decides it should, and that is exactly what
 * someone watching this page is waiting for.
 */
export function WebhooksPage({
  onOpenWebhook,
  onOpenSession,
  onOpenChat,
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

      {hooks && hooks.length > 0 && (
        <div className="webhook-grid">
          {hooks.map((hook) => (
            <div key={hook.id} className={`webhook-card${hook.enabled ? '' : ' disabled'}`}>
              <div className="webhook-card-head">
                <div className="webhook-card-title-wrap">
                  <Icon name="webhook" size={18} className="webhook-card-icon" />
                  <strong className="webhook-card-name">{hook.name}</strong>
                  {hook.skipPermissionsEnabled && (
                    <Icon
                      name="shield"
                      size={14}
                      className="cron-shield"
                      aria-label="Approvals bypassed"
                    />
                  )}
                </div>
                <div className="webhook-card-actions">
                  <button
                    type="button"
                    className="round-btn plain"
                    disabled={busy.has(hook.id)}
                    onClick={(e) => {
                      e.stopPropagation();
                      void withBusy(hook.id, () => api.sendTestDelivery(hook.id));
                    }}
                    aria-label={`Send a test delivery to ${hook.name}`}
                    title="Send test delivery"
                  >
                    <Icon name="play" size={15} />
                  </button>
                  <label
                    className="switch"
                    title={hook.enabled ? 'Disable this webhook' : 'Enable this webhook'}
                    onClick={(e) => e.stopPropagation()}
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

              <button
                type="button"
                className="webhook-card-body"
                onClick={() => onOpenWebhook(hook.id)}
              >
                <div className="webhook-card-path-row">
                  <code className="hook-path">{hook.deliveryPath}</code>
                  <span className="webhook-card-ws">{hook.workspaceLabel}</span>
                </div>

                <div className="webhook-card-meta-row">
                  <span className="webhook-card-status">
                    {hook.enabled ? (
                      hook.lastDeliveryAt === null ? (
                        <span className="webhook-meta-never">Never fired</span>
                      ) : (
                        <>
                          <span
                            className={`cron-status cron-status--${hook.lastDeliveryStatus ?? 'unknown'}`}
                          >
                            {hook.lastDeliveryStatus ?? 'delivered'}
                          </span>
                          <span className="webhook-meta-time">
                            {formatRelative(hook.lastDeliveryAt)}
                          </span>
                        </>
                      )
                    ) : (
                      <span className="webhook-meta-disabled">Disabled</span>
                    )}
                  </span>
                  {hook.deliveryCounts.total > 0 && (
                    <span className="webhook-card-counts">
                      {hook.deliveryCounts.ran} ran
                      {hook.deliveryCounts.filtered > 0 && ` · ${hook.deliveryCounts.filtered} filtered`}
                      {hook.deliveryCounts.rejected > 0 && ` · ${hook.deliveryCounts.rejected} rejected`}
                    </span>
                  )}
                </div>
                {hook.lastError !== null && (
                  <div className="webhook-card-error">{hook.lastError}</div>
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cron-head" style={{ marginTop: 32 }}>
        <div>
          <h2>Call history</h2>
          <p className="cron-sub">
            Every call to a webhook URL, across every webhook — including one that matched
            nothing at all.
          </p>
        </div>
      </div>
      <WebhookHistoryPanel
        onOpenSession={onOpenSession}
        onOpenChat={onOpenChat}
        onOpenWebhook={onOpenWebhook}
        onApiError={onApiError}
      />
    </div>
  );

  if (!onBack) return content;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Webhooks</strong>
        </div>
      </header>
      {content}
    </div>
  );
}
