import type { SessionStatus } from '@pocketagent/protocol';
import type { ConnectionState } from '../api/ws-client.js';

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

export function formatRelative(timestamp: number | null): string {
  if (!timestamp) return '—';
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
