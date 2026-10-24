import { useCallback, useEffect, useState } from 'react';
import type { WebhookHistoryEntry } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { Icon } from './Icon.js';
import { formatRelative, WebhookStatusIcon } from './StatusBadge.js';
import { WebhookCallDetailDialog } from './WebhookCallDetailDialog.js';
import { RetryDeliveryButton, retryOutcomeMessage } from './RetryDeliveryButton.js';
import type { RetryOutcome } from './RetryDeliveryButton.js';
import { useHostApi } from '../hosts/HostContext.js';
import {
  remoteDeliveryRoute,
  remoteDeliveryStateText,
  type RemoteHostLinks,
} from '../hosts/webhook-remote.js';

interface Props {
  /** Opens a `kind: 'delivery'` row's live or finished transcript. */
  onOpenSession: (sessionId: string) => void;
  onOpenChat: (conversationId: string) => void;
  /** PA-10: opens a Pocket Agent delivery's chat — its only transcript. */
  onOpenPlannerChat: (chatId: string) => void;
  /** Opens a `kind: 'hit', reason: 'disabled'` row's owning webhook. */
  onOpenWebhook: (webhookId: string) => void;
  /** PA-171: opens a delivery that ran on another host, there. Absent without a Hub. */
  remoteHosts?: RemoteHostLinks;
  onApiError: (error: unknown) => void;
}

/** Delivery statuses that mean "this call never became a run". A hit is always this. */
const DID_NOT_RUN = new Set(['filtered', 'duplicate', 'throttled', 'skipped', 'rejected', 'invalid']);

const isNoise = (e: WebhookHistoryEntry): boolean =>
  e.kind === 'hit' || DID_NOT_RUN.has(e.status);

/** `cron-status--<this>`, and the visible label. Shared so the two can never drift apart. */
const statusFor = (e: WebhookHistoryEntry): string =>
  e.kind === 'delivery' ? e.status : e.reason === 'disabled' ? 'disabled' : 'unmatched';

/**
 * PA-171: where a dispatched delivery opens — a routing id plus a route on that
 * host — or null when it did not run elsewhere or cannot be reached from here.
 */
const remoteTarget = (
  e: WebhookHistoryEntry,
  remote: RemoteHostLinks | undefined,
): { routingId: string; route: NonNullable<ReturnType<typeof remoteDeliveryRoute>> } | null => {
  if (e.kind !== 'delivery' || e.remoteHostId === null) return null;
  const route = remoteDeliveryRoute(e);
  const routingId = remote?.routingId(e.remoteHostId) ?? null;
  return route !== null && routingId !== null ? { routingId, route } : null;
};

const isOpenable = (e: WebhookHistoryEntry, remote: RemoteHostLinks | undefined): boolean =>
  e.kind === 'delivery'
    ? e.remoteHostId !== null
      ? remoteTarget(e, remote) !== null
      : e.sessionId !== null || e.agentSessionId !== null || e.plannerChatId !== null
    : e.reason === 'disabled' && e.webhookId !== null;

const titleFor = (e: WebhookHistoryEntry, remote: RemoteHostLinks | undefined, hostLabel: string | null): string => {
  if (e.kind === 'hit') {
    return e.reason === 'disabled'
      ? 'Open the disabled webhook’s editor'
      : 'No webhook has this path';
  }
  if (e.remoteHostId !== null) {
    return remoteTarget(e, remote) !== null
      ? `Open this delivery’s transcript on ${hostLabel ?? e.remoteHostId}`
      : remoteDeliveryRoute(e) !== null
        ? `Ran on ${hostLabel ?? e.remoteHostId} — open it through the Hub`
        : (e.reason ?? 'No transcript available');
  }
  return e.sessionId !== null || e.agentSessionId !== null || e.plannerChatId !== null
    ? 'Open this delivery’s transcript'
    : (e.reason ?? 'No transcript available');
};

/**
 * The call-history feed: every webhook's deliveries, merged with calls that
 * matched no runnable webhook at all — see `GET /api/webhooks/history`.
 */
export function WebhookHistoryPanel({
  onOpenSession,
  onOpenChat,
  onOpenPlannerChat,
  onOpenWebhook,
  remoteHosts,
  onApiError,
}: Props): JSX.Element {
  const api = useHostApi();
  const [entries, setEntries] = useState<WebhookHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNoise, setShowNoise] = useState(false);
  const [detailEntry, setDetailEntry] = useState<WebhookHistoryEntry | null>(null);
  const [busyAction, setBusyAction] = useState(false);

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

  // PA-125: the retry is a new row; reloading is what shows it.
  const onRetried = (outcome: RetryOutcome): void => {
    setDetailEntry(null);
    void load().then(() => setError(retryOutcomeMessage(outcome)));
  };

  const handleAcceptRoute = async (webhookId: string, routeKey: string, cwd: string): Promise<void> => {
    if (busyAction) return;
    setBusyAction(true);
    try {
      await api.acceptWebhookRoute(webhookId, routeKey, { cwd });
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not accept route suggestion.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleDismissRoute = async (webhookId: string, routeKey: string): Promise<void> => {
    if (busyAction) return;
    setBusyAction(true);
    try {
      await api.dismissWebhookRoute(webhookId, routeKey);
      await load();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not dismiss route suggestion.');
    } finally {
      setBusyAction(false);
    }
  };

  const openEntry = (e: WebhookHistoryEntry): void => {
    if (e.kind === 'hit') {
      if (e.reason === 'disabled' && e.webhookId !== null) onOpenWebhook(e.webhookId);
      return;
    }
    // PA-171 before everything: a dispatched delivery's ids are ids on the
    // other host, and opening them here would show this host's, or nothing.
    if (e.remoteHostId !== null) {
      const target = remoteTarget(e, remoteHosts);
      if (target !== null) remoteHosts?.open(target.routingId, target.route);
      return;
    }
    // PA-10 first: a pocket delivery's chat is its only transcript, with no
    // session or conversation id to fall back through.
    if (e.plannerChatId) onOpenPlannerChat(e.plannerChatId);
    else if (e.sessionId) onOpenSession(e.sessionId);
    else if (e.agentSessionId) onOpenChat(e.agentSessionId);
  };

  return (
    <div className="webhook-history-container">
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
        <div className="webhook-history-bar">
          <span className="webhook-history-count">{entries.length} recorded</span>
          <button type="button" className="linkish" onClick={() => setShowNoise((v) => !v)}>
            {showNoise ? 'Hide' : 'Show'} filtered & skipped ({entries.filter(isNoise).length})
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <div className="webhook-history-panel">
          {visible.map((e) => {
            const openable = isOpenable(e, remoteHosts);
            const remoteLabel =
              e.kind === 'delivery' && e.remoteHostId !== null
                ? (remoteHosts?.label(e.remoteHostId) ?? e.remoteHostId)
                : null;
            const remoteState =
              e.kind === 'delivery' && remoteLabel !== null ? remoteDeliveryStateText(e, remoteLabel) : null;
            return (
              <div key={e.id} className={`history-row${isNoise(e) ? ' inert' : ''}`}>
                <button
                  type="button"
                  className="history-row-main"
                  disabled={!openable}
                  onClick={() => openEntry(e)}
                  title={titleFor(e, remoteHosts, remoteLabel)}
                >
                  <div className="history-row-primary">
                    <WebhookStatusIcon status={statusFor(e)} />

                    {remoteLabel !== null && (
                      <span className="history-host-tag" title={`Ran on ${remoteLabel}`}>
                        {remoteLabel}
                      </span>
                    )}
                    {remoteState !== null && <span className="history-remote-state">{remoteState}</span>}

                    {e.kind === 'delivery' && e.issueKey && (
                      <span className="jira-issue-badge">{e.issueKey}</span>
                    )}

                    {e.kind === 'delivery' && e.eventType && (
                      <span className="jira-event-badge">
                        {e.eventType.replace(/^jira:/, '').replace(/^issue_/, '')}
                      </span>
                    )}

                    <span className="history-row-target">
                      {e.kind === 'delivery'
                        ? e.webhookName
                        : e.reason === 'disabled'
                          ? (e.webhookName ?? 'Disabled webhook')
                          : `/api/hooks/${e.slug}`}
                    </span>

                    {e.kind === 'delivery' && e.actor && (
                      <span className="history-row-actor">by {e.actor}</span>
                    )}

                    {e.kind === 'delivery' && (e.trigger === 'test' || e.trigger === 'retry') && (
                      <span className="history-test-tag">{e.trigger}</span>
                    )}

                    {e.kind === 'delivery' && e.queueSkippedByLabel && (
                      <span
                        className="history-skip-queue-tag"
                        title="Ran ahead of a busy directory because it carried the skip-queue label"
                      >
                        skip-queue
                      </span>
                    )}
                  </div>

                  <div className="history-row-secondary">
                    <span className="history-row-time">{formatRelative(e.receivedAt)}</span>
                    {e.kind === 'delivery' && e.remoteRef !== null && !openable && (
                      <span className="delivery-reason">
                        <code>{e.remoteRef}</code> on {remoteLabel} — open through the Hub
                      </span>
                    )}
                    {e.kind === 'delivery' && e.reason !== null && (
                      <span className="delivery-reason">{e.reason}</span>
                    )}
                    {e.kind === 'delivery' && e.error !== null && (
                      <span className="history-row-error">{e.error}</span>
                    )}
                  </div>
                </button>

                <div className="history-row-actions">
                  {e.kind === 'delivery' &&
                    e.status === 'filtered' &&
                    e.webhookId !== null &&
                    e.routeSuggestion &&
                    e.routeSuggestion.confirmedAt === null &&
                    e.routeSuggestion.dismissedAt === null && (
                      <>
                        <button
                          type="button"
                          className="primary"
                          disabled={busyAction}
                          title={`Map ${e.routeSuggestion.routeKey} → ${e.routeSuggestion.workspaceLabel ?? e.routeSuggestion.cwd}`}
                          onClick={() =>
                            void handleAcceptRoute(
                              e.webhookId!,
                              e.routeSuggestion!.routeKey,
                              e.routeSuggestion!.cwd,
                            )
                          }
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          disabled={busyAction}
                          title={`Dismiss suggestion for ${e.routeSuggestion.routeKey}`}
                          onClick={() =>
                            void handleDismissRoute(e.webhookId!, e.routeSuggestion!.routeKey)
                          }
                        >
                          Dismiss
                        </button>
                      </>
                    )}
                  {e.kind === 'delivery' && (
                    <RetryDeliveryButton
                      delivery={e}
                      onRetried={onRetried}
                      onError={setError}
                      onApiError={onApiError}
                    />
                  )}
                  <button
                    type="button"
                    className="round-btn plain history-detail-btn"
                    onClick={() => setDetailEntry(e)}
                    aria-label="Show call detail"
                    title="Show call detail"
                  >
                    <Icon name="code" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detailEntry !== null && (
        <WebhookCallDetailDialog
          entry={detailEntry}
          onClose={() => setDetailEntry(null)}
          onApiError={onApiError}
          onRetried={onRetried}
        />
      )}
    </div>
  );
}
