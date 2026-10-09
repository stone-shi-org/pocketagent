import { useState } from 'react';
import { RETRYABLE_DELIVERY_STATUSES } from '@pocketagent/protocol';
import type { WebhookDelivery } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { Icon } from './Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

export interface RetryOutcome {
  deliveryId: string | null;
  status: string;
  reason: string | null;
}

/**
 * Whether a delivery gets a Retry button at all (PA-125). A retryable status
 * whose payload was not kept still shows one, disabled with the server's
 * reason, so "why can't I retry this" answers itself instead of the button
 * silently not being there.
 */
export const showsRetry = (d: Pick<WebhookDelivery, 'status'>): boolean =>
  RETRYABLE_DELIVERY_STATUSES.includes(d.status);

/**
 * Re-runs a failed/throttled/skipped delivery's stored payload as a new
 * delivery. Shared by the call-history feed, the webhook editor's delivery
 * list and the detail dialog, so the three cannot disagree about when a retry
 * is offered. The parent reloads its list in `onRetried`; the new row appears
 * there, tagged `retry`, and the original stays as it was.
 */
export function RetryDeliveryButton({
  delivery,
  onRetried,
  onError,
  onApiError,
  variant = 'icon',
}: {
  delivery: Pick<WebhookDelivery, 'id' | 'webhookId' | 'status' | 'retryProblem'>;
  onRetried: (outcome: RetryOutcome) => void;
  onError: (message: string) => void;
  onApiError: (error: unknown) => void;
  variant?: 'icon' | 'text';
}): JSX.Element | null {
  const api = useHostApi();
  const [busy, setBusy] = useState(false);
  if (!showsRetry(delivery) || delivery.webhookId === null) return null;
  const webhookId = delivery.webhookId;
  const blocked = delivery.retryProblem;
  const title = blocked ?? 'Run this delivery again with the webhook’s current settings';

  const retry = async (): Promise<void> => {
    setBusy(true);
    try {
      onRetried(await api.retryWebhookDelivery(webhookId, delivery.id));
    } catch (err) {
      onApiError(err);
      onError(err instanceof ApiError ? err.message : 'Could not retry this delivery.');
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'text') {
    return (
      <button type="button" disabled={busy || blocked !== null} onClick={() => void retry()} title={title}>
        {busy ? 'Retrying…' : 'Retry'}
      </button>
    );
  }
  return (
    <button
      type="button"
      className="round-btn plain history-detail-btn"
      disabled={busy || blocked !== null}
      onClick={() => void retry()}
      aria-label="Retry delivery"
      title={title}
    >
      <Icon name="rotate" size={15} />
    </button>
  );
}

/** One sentence for a retry that did not start a run, or null when it did. */
export function retryOutcomeMessage(outcome: RetryOutcome): string | null {
  return outcome.reason !== null ? `Retry: ${outcome.status} — ${outcome.reason}` : null;
}
