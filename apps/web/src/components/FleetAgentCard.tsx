import { useCallback, useEffect, useState } from 'react';
import type { HubFleetState, HubFleetStep } from '@pocketagent/protocol';
import { getHubFleet, runHubFleetAction } from '../api/hub.js';
import { announceFleetChanged } from '../hosts/fleet.js';
import { findHostByManageId, type HostRecord } from '../hosts/host-status.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

/**
 * PA-134: the Fleet agent's card on the Hub page — where it is enabled, moved
 * and disabled.
 *
 * Every action names what it will do before it does it, because each one
 * writes to other machines: a scoped dispatch token on every bound host, and on
 * the coordinator a Pocket Agent plus an MCP registry pointing back here. The
 * outcome lists each step, since the interesting cases are partial ones (one
 * host unreachable for its token while the rest succeeded).
 *
 * Talks only to the Hub origin (`api/hub.ts`), like the rest of `HubPage`.
 */

interface Props {
  hosts: readonly HostRecord[];
  onOpenChat: (fleet: HubFleetState) => void;
  onApiError: (error: unknown) => void;
}

type Pending = { kind: 'enable' | 'move'; hostId: string } | { kind: 'disable' } | null;

export function FleetAgentCard({ hosts, onOpenChat, onApiError }: Props): JSX.Element {
  const [fleet, setFleet] = useState<HubFleetState | null>(null);
  const [hostId, setHostId] = useState<string>('');
  // The Hub cannot know the address its coordinator reaches it by (one
  // Compose network calls it `http://hub:8788`), so the operator says, and the
  // field starts at the address this browser used — labelled as just that.
  const [hubUrl, setHubUrl] = useState<string>(() => window.location.origin);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<HubFleetStep[]>([]);
  const [error, setError] = useState<string | null>(null);

  const bound = hosts.filter((host) => host.hubBound === true);
  const manageId = (host: HostRecord): string => host.hubHostId ?? host.endpoint.id;

  const load = useCallback(async () => {
    try {
      const next = await getHubFleet();
      setFleet(next);
      if (next.hubUrl) setHubUrl(next.hubUrl);
    } catch (err) {
      onApiError(err);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Default the picker to the coordinator, else the Hub's default host.
  useEffect(() => {
    if (hostId !== '' || bound.length === 0) return;
    const preferred =
      (fleet?.coordinatorHostId && bound.find((h) => manageId(h) === fleet.coordinatorHostId)) ||
      bound.find((h) => h.isDefault) ||
      bound[0];
    if (preferred) setHostId(manageId(preferred));
  }, [bound, fleet, hostId]);

  const run = async (action: NonNullable<Pending>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await runHubFleetAction(
        action.kind,
        action.kind === 'disable' ? undefined : { hostId: action.hostId, hubUrl: hubUrl.trim() },
      );
      setSteps(outcome.steps);
      setError(outcome.error);
      if (outcome.fleet) setFleet(outcome.fleet);
      announceFleetChanged();
    } catch (err) {
      onApiError(err);
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const coordinator = fleet?.coordinatorHostId ? findHostByManageId(hosts, fleet.coordinatorHostId) : null;
  const enabled = fleet?.enabled === true;
  const coordinatorLabel = fleet?.coordinatorLabel ?? fleet?.coordinatorHostId ?? '';
  const unreachable =
    enabled && (coordinator === null || coordinator.status === 'offline' || fleet?.coordinatorOnline === false);
  const target = bound.find((h) => manageId(h) === hostId) ?? null;

  return (
    <section className="hub-section" aria-labelledby="hub-fleet-heading">
      <h2 id="hub-fleet-heading">Fleet agent</h2>
      <div className="hub-row-card fleet-card">
        <Icon name="agents" size={20} className="hub-row-icon" />
        <div className="hub-row-main">
          <strong>
            {fleet === null
              ? 'Fleet agent'
              : enabled
                ? `Runs on ${coordinatorLabel}`
                : 'Off'}
          </strong>
          <span>
            A Pocket Agent that finds the right host for a task and dispatches it there — Xcode work to the
            macOS host, project work to the host that has the files. It runs on one host (the coordinator)
            and reaches every host through this Hub. Every dispatch asks you first, per host; approvals the
            work needs on a host are answered there.
          </span>
          {unreachable && (
            <span className="warn" role="status">
              Coordinator {coordinatorLabel} unreachable — move the role to another host?
            </span>
          )}
          {enabled && fleet && (
            <ul className="fleet-tokens" aria-label="Dispatch tokens">
              {fleet.hosts.map((host) => (
                <li key={host.hostId} className={host.state === 'ok' ? undefined : 'warn'}>
                  {host.label}: {host.state === 'ok' ? `can be dispatched to (${host.tokenPrefix ?? 'token'}…)` : tokenText(host.state)}
                </li>
              ))}
            </ul>
          )}
          <label className="fleet-field">
            <span>{enabled ? 'Move to' : 'Run on'}</span>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)} disabled={busy || bound.length === 0}>
              {bound.length === 0 && <option value="">No bound host</option>}
              {bound.map((host) => (
                <option key={manageId(host)} value={manageId(host)}>
                  {host.label}
                  {host.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="fleet-field">
            <span>Hub address, as the coordinator reaches it</span>
            <input
              type="url"
              value={hubUrl}
              onChange={(e) => setHubUrl(e.target.value)}
              disabled={busy}
              spellCheck={false}
              aria-describedby="fleet-url-help"
            />
          </label>
          <span id="fleet-url-help" className="hub-muted">
            Started from this browser’s address. Inside one Docker network use the Hub’s service name
            instead. The coordinator dials it when the role is set up, so a wrong address fails there.
          </span>
          {error && (
            <span className="warn" role="alert">
              {error}
            </span>
          )}
          {steps.length > 0 && (
            <ol className="fleet-steps">
              {steps.map((step, i) => (
                <li key={i} className={step.ok ? undefined : 'warn'}>
                  {step.ok ? '✓' : '✗'} {step.label} — {step.message}
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="hub-row-actions">
          {enabled && (
            <button type="button" className="primary" onClick={() => fleet && onOpenChat(fleet)} disabled={unreachable}>
              Open chat
            </button>
          )}
          {!enabled ? (
            <button
              type="button"
              className="primary"
              disabled={busy || target === null}
              onClick={() => target && setPending({ kind: 'enable', hostId: manageId(target) })}
            >
              Enable
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || target === null || manageId(target) === fleet?.coordinatorHostId}
                onClick={() => target && setPending({ kind: 'move', hostId: manageId(target) })}
              >
                Move
              </button>
              <button
                type="button"
                disabled={busy || coordinator === null}
                title="Mint fresh tokens and re-check the coordinator’s route to the Hub"
                onClick={() => fleet?.coordinatorHostId && setPending({ kind: 'enable', hostId: fleet.coordinatorHostId })}
              >
                Repair
              </button>
              <button type="button" className="hub-danger" disabled={busy} onClick={() => setPending({ kind: 'disable' })}>
                Disable
              </button>
            </>
          )}
        </div>
      </div>

      {pending !== null && (
        <ConfirmDialog
          title={confirmTitle(pending, hosts, coordinatorLabel)}
          body={confirmBody(pending, hosts, coordinatorLabel)}
          confirmLabel={pending.kind === 'disable' ? 'Disable' : pending.kind === 'move' ? 'Move' : 'Enable'}
          busy={busy}
          onConfirm={() => void run(pending)}
          onCancel={() => setPending(null)}
        />
      )}
    </section>
  );
}

function tokenText(state: string): string {
  switch (state) {
    case 'unbound':
      return 'not bound to this Hub';
    case 'unreadable':
      return 'token no longer decrypts — use Repair';
    case 'missing':
      return 'no dispatch token — use Repair';
    default:
      return state;
  }
}

function labelFor(hosts: readonly HostRecord[], id: string): string {
  return findHostByManageId(hosts, id)?.label ?? id;
}

function confirmTitle(pending: NonNullable<Pending>, hosts: readonly HostRecord[], current: string): string {
  if (pending.kind === 'disable') return 'Disable the Fleet agent?';
  if (pending.kind === 'move') return `Move the Fleet agent from ${current} to ${labelFor(hosts, pending.hostId)}?`;
  return `Run the Fleet agent on ${labelFor(hosts, pending.hostId)}?`;
}

function confirmBody(pending: NonNullable<Pending>, hosts: readonly HostRecord[], current: string): string {
  if (pending.kind === 'disable') {
    return (
      'The Hub revokes its dispatch token on every host and the coordinator’s token for this Hub, and removes ' +
      `the Hub registry from ${current}. The Fleet agent itself, its chats and its memory stay on ${current}.`
    );
  }
  const label = labelFor(hosts, pending.hostId);
  const common =
    'Every bound host gets a new MCP token for this Hub (read, sessions and planner — never admin), visible in ' +
    `its Settings → MCP. ${label} gets a "Fleet agent" Pocket Agent (if it has none yet) and an MCP registry ` +
    'pointing at this Hub, which any Pocket Agent there with MCP on can use. Each dispatch still asks for approval.';
  if (pending.kind === 'move') {
    return `${common} ${current} keeps its Fleet agent and its chats, but loses its route to this Hub.`;
  }
  return common;
}
