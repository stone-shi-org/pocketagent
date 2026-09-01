import { useCallback, useEffect, useState } from 'react';
import type { WebhookHistoryEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';

interface Props {
  /** Opens a `kind: 'delivery'` row's live or finished transcript. */
  onOpenSession: (sessionId: string) => void;
  onOpenChat: (conversationId: string) => void;
  /** Opens a `kind: 'hit', reason: 'disabled'` row's owning webhook. */
  onOpenWebhook: (webhookId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route, exactly like `WebhooksPage` — see that
   * component's own note on why `DesktopShell` passes nothing.
   */
  onBack?: () => void;
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
 * Every webhook's call history, in one feed — including calls that matched no
 * runnable webhook at all.
 *
 * `WebhookEditorPage`'s own delivery list only ever shows one webhook's rows,
 * because it's scoped to that webhook's id. This page reads
 * `GET /api/webhooks/history`, which merges every webhook's deliveries with
 * `webhook_hit_log` (unknown slugs and disabled-webhook hits — see that
 * table's migration comment for why those are recorded at all). Loads once
 * on mount rather than polling, matching the per-webhook list it's modeled
 * on.
 */
export function WebhookHistoryPage({
  onOpenSession,
  onOpenChat,
  onOpenWebhook,
  onApiError,
  onBack,
}: Props): JSX.Element {
  const [entries, setEntries] = useState<WebhookHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);

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

  const content = (
    <div className="cron-page">
      <div className="cron-head">
        <div>
          <h2>Call history</h2>
          <p className="cron-sub">
            Every call to a webhook URL, across every webhook — including one that matched
            nothing at all.
          </p>
        </div>
      </div>

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
          <button
            key={e.id}
            type="button"
            className={`cron-run-row${isNoise(e) ? ' inert' : ''}`}
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
        );
      })}
    </div>
  );

  if (!onBack) return content;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <strong>Call history</strong>
      </header>
      {content}
    </div>
  );
}
