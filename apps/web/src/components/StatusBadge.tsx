import type { SessionStatus } from '@pocketagent/protocol';
import type { ConnectionState } from '../api/ws-client.js';
import { Icon } from './Icon.js';

const SESSION_LABELS: Record<SessionStatus, string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Exited',
  killed: 'Killed',
  error: 'Error',
  interrupted: 'Interrupted',
};

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
};

export function StatusBadge({ status }: { status: SessionStatus }): JSX.Element {
  return <span className={`badge ${status}`}>{SESSION_LABELS[status]}</span>;
}

export function ConnectionBadge({ state }: { state: ConnectionState }): JSX.Element {
  return <span className={`badge ${state}`}>{CONNECTION_LABELS[state]}</span>;
}

/**
 * Compact colored status indicator with icon for webhook deliveries and history entries.
 */
export function WebhookStatusIcon({ status }: { status: string }): JSX.Element {
  switch (status) {
    case 'succeeded':
      return (
        <span className="webhook-status-badge status--ok" title="Succeeded">
          <Icon name="check" size={11} />
          <span>Ran</span>
        </span>
      );
    case 'running':
    case 'starting':
      return (
        <span className="webhook-status-badge status--active" title={status}>
          <span className="webhook-status-dot" />
          <span>{status === 'running' ? 'Running' : 'Starting'}</span>
        </span>
      );
    case 'failed':
    case 'rejected':
    case 'invalid':
      return (
        <span className="webhook-status-badge status--danger" title={status}>
          <Icon name="close" size={11} />
          <span>{status === 'failed' ? 'Failed' : status === 'rejected' ? 'Rejected' : 'Invalid'}</span>
        </span>
      );
    case 'throttled':
    case 'disabled':
      return (
        <span className="webhook-status-badge status--warn" title={status}>
          <Icon name="close" size={11} />
          <span>{status === 'throttled' ? 'Throttled' : 'Disabled'}</span>
        </span>
      );
    case 'filtered':
    case 'duplicate':
    case 'skipped':
    case 'unmatched':
    default:
      return (
        <span className="webhook-status-badge status--dim" title={status}>
          <span className="webhook-status-dot dim" />
          <span>{status}</span>
        </span>
      );
  }
}

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return '—';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
