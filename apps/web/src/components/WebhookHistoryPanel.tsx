import { useCallback, useEffect, useState } from 'react';
import type { WebhookHistoryEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from './Icon.js';
import { formatRelative } from './StatusBadge.js';
import { WebhookCallDetailDialog } from './WebhookCallDetailDialog.js';

interface Props {
  /** Opens a `kind: 'delivery'` row's live or finished transcript. */
  onOpenSession: (sessionId: string) => void;
  onOpenChat: (conversationId: string) => void;
  /** Opens a `kind: 'hit', reason: 'disabled'` row's owning webhook. */
  onOpenWebhook: (webhookId: string) => void;
  onApiError: (error: unknown) => void;
}

/** Delivery statuses that mean "this call never became a run". A hit is always this. */
const DID_NOT_RUN = new Set(['filtered', 'duplicate', 'throttled', 'skipped', 'rejected', 'invalid']);

const isNoise = (e: WebhookHistoryEntry): boolean =>
  e.kind === 'hit' || DID_NOT_RUN.has(e.status);

/** `cron-status--<this>`, and the visible label. Shared so the two can never drift apart. */
const statusFor = (e: WebhookHistoryEntry): string =>
  e.kind === 'delivery' ? e.status : e.reason === 'disabled' ? 'disabled' : 'unmatched';

const whoFor = (e: WebhookHistoryEntry): string =>
  e.kind === 'delivery'
    ? e.webhookName
    : e.reason === 'disabled'
      ? (e.webhookName ?? 'Unknown webhook')
      : `/api/hooks/${e.slug}`;

const isOpenable = (e: WebhookHistoryEntry): boolean =>
  e.kind === 'delivery'
    ? e.sessionId !== null || e.agentSessionId !== null
    : e.reason === 'disabled' && e.webhookId !== null;

const titleFor = (e: WebhookHistoryEntry): string => {
  if (e.kind === 'hit') {
    return e.reason === 'disabled'
      ? 'Open the disabled webhook’s editor'
      : 'No webhook has this path';
  }
  return e.sessionId !== null || e.agentSessionId !== null
    ? 'Open this delivery’s transcript'
    : (e.reason ?? 'No transcript available');
};

/**
 * The call-history feed: every webhook's deliveries, merged with calls that
 * matched no runnable webhook at all — see `GET /api/webhooks/history`.
 *
 * Content only, no page chrome: this used to be its own routed page
 * (`WebhookHistoryPage`, `#/hooks/history`), folded into `WebhooksPage` as a
 * second section on the same page instead of a second destination, so there
 * is nowhere for "how do I get back to the list" to even come up. Loads once
 * on mount rather than polling, matching the per-webhook delivery list it was
 * modeled on.
 */
export function WebhookHistoryPanel({
  onOpenSession,
  onOpenChat,
  onOpenWebhook,
  onApiError,
}: Props): JSX.Element {
  const [entries, setEntries] = useState<WebhookHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);
  const [detailEntry, setDetailEntry] = useState<WebhookHistoryEntry | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.listWebhookHistory();
      setEntries(res.entries);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load the call history.');
      setEntries([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = (entries ?? []).filter((e) => showNoise || !isNoise(e));

  const openEntry = (e: WebhookHistoryEntry): void => {
    if (e.kind === 'hit') {
      if (e.reason === 'disabled' && e.webhookId !== null) onOpenWebhook(e.webhookId);
      return;
    }
    if (e.sessionId) onOpenSession(e.sessionId);
    else if (e.agentSessionId) onOpenChat(e.agentSessionId);
  };

  return (
    <>
      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {entries === null && <div className="spinner">Loading…</div>}
      {entries !== null && entries.length === 0 && (
        <div className="cron-empty">
          No calls recorded yet. Until one arrives, nothing confirms this endpoint is reachable
          at all — from Jira, or from anyone else.
        </div>
      )}
      {entries !== null && entries.length > 0 && (
        <p className="transport-hint">
          {entries.length} recorded{' '}
          <button type="button" className="linkish" onClick={() => setShowNoise((v) => !v)}>
            {showNoise ? 'Hide' : 'Show'} the ones that did not run
          </button>
        </p>
      )}
      {visible.map((e) => {
        const openable = isOpenable(e);
        return (
          <div key={e.id} className={`call-row${isNoise(e) ? ' inert' : ''}`}>
            <button
              type="button"
              className="cron-run-row"
              disabled={!openable}
              onClick={() => openEntry(e)}
              title={titleFor(e)}
            >
              <span className="cron-run-row-main">
                <span className={`cron-status cron-status--${statusFor(e)}`}>{statusFor(e)}</span>
                <span className="cron-run-when">
                  {whoFor(e)}
                  {' · '}
                  {formatRelative(e.receivedAt)}
                </span>
              </span>
              {e.kind === 'delivery' && e.reason !== null && (
                <span className="delivery-reason">{e.reason}</span>
              )}
            </button>
            <button
              type="button"
              className="round-btn plain"
              onClick={() => setDetailEntry(e)}
              aria-label="Show call detail"
              title="Show call detail"
            >
              <Icon name="code" size={16} />
            </button>
          </div>
        );
      })}

      {detailEntry !== null && (
        <WebhookCallDetailDialog
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onApiError={onApiError}
        />
      )}
    </>
  );
}
