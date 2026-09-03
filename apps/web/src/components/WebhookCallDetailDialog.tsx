import { useEffect, useState } from 'react';
import type { WebhookDeliveryDetail, WebhookHistoryEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { formatRelative } from './StatusBadge.js';

/** One `label: value` line — skipped entirely when `value` is null, so the dialog never shows "—". */
function Fact({ label, value }: { label: string; value: string | number | null }): JSX.Element | null {
  if (value === null) return null;
  return (
    <p className="transport-hint">
      <strong>{label}:</strong> {value}
    </p>
  );
}

/**
 * Full detail for one row of the call history — the "Detail" button next to
 * each row's own click-to-open-session action.
 *
 * The plumbing for this already existed and was never called from any page:
 * `GET /api/webhooks/:id/deliveries/:deliveryId` and `api.getWebhookDelivery`
 * both predate this dialog. A `kind: 'hit'` entry needs no fetch at all —
 * `WebhookHit` already carries everything there is to show (there is no
 * payload for a call that matched no webhook; see `webhook_hit_log`'s
 * migration comment for why).
 */
export function WebhookCallDetailDialog({
  entry,
  onClose,
  onApiError,
}: {
  entry: WebhookHistoryEntry;
  onClose: () => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [detail, setDetail] = useState<WebhookDeliveryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(entry.kind === 'delivery' && entry.webhookId !== null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (entry.kind !== 'delivery' || entry.webhookId === null) return;
    let cancelled = false;
    setLoading(true);
    api
      .getWebhookDelivery(entry.webhookId, entry.id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load this delivery.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `entry` is a fresh object per render of the list; keying on the two
    // fields that actually identify the delivery avoids re-fetching on every
    // parent re-render.
  }, [entry.kind === 'delivery' ? entry.webhookId : null, entry.kind === 'delivery' ? entry.id : null]);

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Call detail"
      >
        <h2>{entry.kind === 'delivery' ? 'Delivery detail' : 'Unmatched call'}</h2>

        {entry.kind === 'hit' ? (
          <>
            <Fact label="Slug" value={entry.slug} />
            <Fact
              label="Reason"
              value={
                entry.reason === 'disabled'
                  ? `Matched ${entry.webhookName ?? 'a webhook'}, which is disabled`
                  : 'No webhook has this path'
              }
            />
            <Fact label="Received" value={formatRelative(entry.receivedAt)} />
          </>
        ) : (
          <>
            <Fact label="Webhook" value={entry.webhookName} />
            <Fact label="Status" value={entry.status} />
            <Fact label="Reason" value={entry.reason} />
            <Fact label="Event" value={entry.event} />
            <Fact label="Issue" value={entry.issueKey} />
            <Fact label="Project" value={entry.projectKey} />
            <Fact label="Actor" value={entry.actor} />
            <Fact label="Directory" value={entry.cwd} />
            <Fact label="Received" value={formatRelative(entry.receivedAt)} />
            <Fact label="Error" value={entry.error} />

            {entry.webhookId === null && (
              <p className="transport-hint">
                This webhook has been deleted, so the stored payload and rendered prompt (if any)
                can no longer be retrieved — everything else on this row is copied onto the
                delivery itself.
              </p>
            )}
            {error !== null && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            {loading && <div className="spinner">Loading…</div>}
            {detail?.payload !== null && detail?.payload !== undefined && (
              <>
                <p className="transport-hint" style={{ marginTop: 12 }}>
                  <strong>Stored payload{detail.payloadTruncated ? ' (truncated)' : ''}:</strong>
                </p>
                <pre className="hook-preview">{detail.payload}</pre>
              </>
            )}
            {detail?.renderedPrompt !== null && detail?.renderedPrompt !== undefined && (
              <>
                <p className="transport-hint" style={{ marginTop: 12 }}>
                  <strong>Rendered prompt:</strong>
                </p>
                <pre className="hook-preview">{detail.renderedPrompt}</pre>
              </>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
