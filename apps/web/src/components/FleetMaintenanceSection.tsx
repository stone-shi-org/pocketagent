import { useEffect, useState } from 'react';
import {
  INSTALLABLE_AGENT_IDS,
  type DrainBlocker,
  type InstallableAgentId,
} from '@pocketagent/protocol';
import { ApiError, createApiClient, type ApiClient } from '../api/client.js';
import {
  applyInstallEvent,
  emptyInstallProgress,
  type InstallProgress,
} from '../agent/agent-setup.js';
import type { HostRecord } from '../hosts/host-status.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

/**
 * PA-135 Tier 3: human-only fleet maintenance actions on `HubPage`.
 *
 * Neither restarting a host nor installing/updating a coding agent CLI is ever
 * exposed on `/mcp` or reachable from an unattended trigger (PA-68/104, PA-69).
 * The Fleet agent may *recommend* these actions and link the operator to `#/hub`,
 * where a human selects the hosts and presses the button.
 */

export const FLEET_INSTALLABLE_AGENT_LABELS: Readonly<Record<InstallableAgentId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'Opencode',
  pi: 'Pi',
  agy: 'Antigravity',
};

export interface RestartHostOutcome {
  readonly hostId: string;
  readonly label: string;
  readonly status: 'running' | 'restarting' | 'blocked' | 'unsupported' | 'failed';
  readonly message: string;
  readonly blockers: readonly DrainBlocker[];
}

export interface AgentUpdateHostOutcome {
  readonly hostId: string;
  readonly label: string;
  readonly progress: InstallProgress;
}

export function blockerDeepLink(host: HostRecord, blocker: DrainBlocker): string {
  const prefix = host.isDefault ? '#' : `#/h/${encodeURIComponent(host.endpoint.id)}`;
  return blocker.kind === 'session'
    ? `${prefix}/s/${encodeURIComponent(blocker.id)}`
    : `${prefix}/planner/${encodeURIComponent(blocker.id)}`;
}

/**
 * Calls `POST /api/admin/restart` with `force: false` on each selected host.
 *
 * Never passes `force: true`. A 409 `drain_blocked` records that host's
 * mid-turn blockers so the operator can inspect them or confirm a per-host
 * forced restart separately.
 */
export async function restartDrainedHosts(
  targets: readonly HostRecord[],
  onProgress?: (outcomes: Readonly<Record<string, RestartHostOutcome>>) => void,
  clientFactory: (host: HostRecord) => ApiClient = (host) => createApiClient(host.endpoint),
): Promise<Record<string, RestartHostOutcome>> {
  const outcomes: Record<string, RestartHostOutcome> = {};
  for (const host of targets) {
    const id = host.hubHostId ?? host.endpoint.id;
    outcomes[id] = {
      hostId: id,
      label: host.label,
      status: 'running',
      message: 'Requesting drain and restart…',
      blockers: [],
    };
  }
  onProgress?.({ ...outcomes });

  await Promise.all(
    targets.map(async (host) => {
      const id = host.hubHostId ?? host.endpoint.id;
      const client = clientFactory(host);
      try {
        await client.restartServer(false);
        outcomes[id] = {
          hostId: id,
          label: host.label,
          status: 'restarting',
          message: 'Draining and restarting.',
          blockers: [],
        };
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'drain_blocked' || err.status === 409)) {
          let blockers: readonly DrainBlocker[] = err.blockers ?? [];
          if (blockers.length === 0) {
            try {
              const state = await client.getDrainState();
              blockers = state.blockers;
            } catch {
              // Keep the 409 message even if the follow-up drain-state read fails.
            }
          }
          outcomes[id] = {
            hostId: id,
            label: host.label,
            status: 'blocked',
            message: err.message,
            blockers,
          };
        } else if (err instanceof ApiError && (err.code === 'restart_not_supported' || err.status === 501)) {
          outcomes[id] = {
            hostId: id,
            label: host.label,
            status: 'unsupported',
            message: err.message,
            blockers: [],
          };
        } else {
          outcomes[id] = {
            hostId: id,
            label: host.label,
            status: 'failed',
            message: err instanceof Error ? err.message : 'Could not restart this host.',
            blockers: [],
          };
        }
      }
      onProgress?.({ ...outcomes });
    }),
  );

  return outcomes;
}

/**
 * Sends `POST /api/admin/restart` with `force: true` to a single host after the
 * operator has explicitly confirmed interrupting its mid-turn work.
 */
export async function forceRestartHost(
  host: HostRecord,
  clientFactory: (host: HostRecord) => ApiClient = (host) => createApiClient(host.endpoint),
): Promise<RestartHostOutcome> {
  const id = host.hubHostId ?? host.endpoint.id;
  const client = clientFactory(host);
  try {
    await client.restartServer(true);
    return {
      hostId: id,
      label: host.label,
      status: 'restarting',
      message: 'Force-restarting now.',
      blockers: [],
    };
  } catch (err) {
    return {
      hostId: id,
      label: host.label,
      status: 'failed',
      message: err instanceof Error ? err.message : 'Could not force-restart this host.',
      blockers: [],
    };
  }
}

/**
 * Runs `POST /api/agents/install` with `action: 'update'` on each selected host
 * **one host at a time** (sequentially), streaming each host's log lines via
 * `onProgress`.
 */
export async function updateAgentOnHosts(
  agentId: InstallableAgentId,
  targets: readonly HostRecord[],
  onProgress?: (outcomes: Readonly<Record<string, AgentUpdateHostOutcome>>) => void,
  clientFactory: (host: HostRecord) => ApiClient = (host) => createApiClient(host.endpoint),
): Promise<Record<string, AgentUpdateHostOutcome>> {
  const outcomes: Record<string, AgentUpdateHostOutcome> = {};
  for (const host of targets) {
    const id = host.hubHostId ?? host.endpoint.id;
    outcomes[id] = {
      hostId: id,
      label: host.label,
      progress: emptyInstallProgress('update'),
    };
  }
  onProgress?.({ ...outcomes });

  for (const host of targets) {
    const id = host.hubHostId ?? host.endpoint.id;
    const client = clientFactory(host);
    let latest: InstallProgress = {
      ...emptyInstallProgress('update'),
      status: 'running',
    };
    outcomes[id] = { hostId: id, label: host.label, progress: latest };
    onProgress?.({ ...outcomes });

    try {
      await client.installAgent(
        agentId,
        (event) => {
          latest = applyInstallEvent(latest, event);
          outcomes[id] = { hostId: id, label: host.label, progress: latest };
          onProgress?.({ ...outcomes });
        },
        0,
        'update',
      );
    } catch (err) {
      if (latest.status !== 'succeeded') {
        latest = {
          ...latest,
          status: 'failed',
          error:
            err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? err.message
                : 'The update could not be completed.',
        };
        outcomes[id] = { hostId: id, label: host.label, progress: latest };
        onProgress?.({ ...outcomes });
      }
    }
  }

  return outcomes;
}

interface Props {
  hosts: readonly HostRecord[];
  onApiError: (error: unknown) => void;
}

export function FleetMaintenanceSection({ hosts, onApiError }: Props): JSX.Element {
  const bound = hosts.filter((host) => host.hubBound === true);
  const manageId = (host: HostRecord): string => host.hubHostId ?? host.endpoint.id;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [agentId, setAgentId] = useState<InstallableAgentId>('claude');
  const [restarting, setRestarting] = useState(false);
  const [restartOutcomes, setRestartOutcomes] = useState<Record<string, RestartHostOutcome>>({});
  const [forceTarget, setForceTarget] = useState<HostRecord | null>(null);
  const [forceBusy, setForceBusy] = useState(false);
  const [updatingAgent, setUpdatingAgent] = useState(false);
  const [updateOutcomes, setUpdateOutcomes] = useState<Record<string, AgentUpdateHostOutcome>>({});

  // Default host selection to all bound hosts when the bound host set first loads.
  const boundKey = bound.map(manageId).join('|');
  useEffect(() => {
    setSelectedIds((prev) => {
      const valid = prev.filter((id) => bound.some((h) => manageId(h) === id));
      if (valid.length > 0) return valid;
      return bound.map(manageId);
    });
  }, [boundKey]);

  const selectedHosts = bound.filter((host) => selectedIds.includes(manageId(host)));
  const toggleHost = (id: string): void => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleRestartDrained = async (): Promise<void> => {
    if (selectedHosts.length === 0) return;
    setRestarting(true);
    try {
      await restartDrainedHosts(selectedHosts, (next) => setRestartOutcomes({ ...next }));
    } catch (err) {
      onApiError(err);
    } finally {
      setRestarting(false);
    }
  };

  const handleConfirmForceRestart = async (host: HostRecord): Promise<void> => {
    const id = manageId(host);
    setForceBusy(true);
    try {
      const outcome = await forceRestartHost(host);
      setRestartOutcomes((prev) => ({ ...prev, [id]: outcome }));
    } catch (err) {
      onApiError(err);
    } finally {
      setForceBusy(false);
      setForceTarget(null);
    }
  };

  const handleUpdateAgent = async (): Promise<void> => {
    if (selectedHosts.length === 0) return;
    setUpdatingAgent(true);
    try {
      await updateAgentOnHosts(agentId, selectedHosts, (next) => setUpdateOutcomes({ ...next }));
    } catch (err) {
      onApiError(err);
    } finally {
      setUpdatingAgent(false);
    }
  };

  const agentLabel = FLEET_INSTALLABLE_AGENT_LABELS[agentId];
  const busy = restarting || updatingAgent || forceBusy;

  return (
    <section className="hub-section" id="hub-maintenance" aria-labelledby="hub-maintenance-heading">
      <h2 id="hub-maintenance-heading">Host maintenance</h2>
      <div className="hub-row-card fleet-card">
        <Icon name="terminal" size={20} className="hub-row-icon" />
        <div className="hub-row-main">
          <strong>Human-only host actions</strong>
          <span>
            Restarting a host and updating a coding agent CLI are never exposed to the Fleet agent or
            any MCP client. Select the bound hosts to act on below; restarts check each host’s drain
            state first and never force-interrupt active work without a separate per-host confirmation,
            and agent updates run one host at a time.
          </span>

          {bound.length === 0 ? (
            <span className="hub-muted">Bind at least one host above to run maintenance actions.</span>
          ) : (
            <div className="fleet-host-Checkboxes" role="group" aria-label="Target hosts">
              {bound.map((host) => {
                const id = manageId(host);
                const checked = selectedIds.includes(id);
                return (
                  <label key={id} className="fleet-host-checkbox" style={{ marginRight: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy}
                      onChange={() => toggleHost(id)}
                    />
                    <span>{host.label}</span>
                  </label>
                );
              })}
            </div>
          )}

          <div className="fleet-field" style={{ marginTop: 8 }}>
            <span>Coding agent to update</span>
            <select
              value={agentId}
              disabled={busy || bound.length === 0}
              onChange={(e) => setAgentId(e.target.value as InstallableAgentId)}
              aria-label="Coding agent to update"
            >
              {INSTALLABLE_AGENT_IDS.map((id) => (
                <option key={id} value={id}>
                  {FLEET_INSTALLABLE_AGENT_LABELS[id]} ({id})
                </option>
              ))}
            </select>
          </div>

          {Object.keys(restartOutcomes).length > 0 && (
            <div className="fleet-maintenance-results" aria-label="Restart outcomes">
              {Object.values(restartOutcomes).map((outcome) => {
                const host = bound.find((h) => manageId(h) === outcome.hostId) ?? null;
                return (
                  <div key={outcome.hostId} className="planner-model-row" style={{ marginTop: 8 }}>
                    <span>
                      <strong>{outcome.label}</strong>:{' '}
                      <span className={outcome.status === 'restarting' ? undefined : 'warn'}>
                        {outcome.message}
                      </span>
                      {outcome.blockers.length > 0 && (
                        <ul className="fleet-steps" style={{ marginTop: 4 }}>
                          {outcome.blockers.map((blocker) => (
                            <li key={`${blocker.kind}:${blocker.id}`}>
                              <strong>{blocker.title}</strong> ({blocker.kind === 'session' ? 'Session' : 'Pocket Agent chat'}
                              {blocker.reason === 'awaiting_approval' ? ' · waiting for approval' : ' · mid-turn'})
                              {host !== null && (
                                <>
                                  {' — '}
                                  <a href={blockerDeepLink(host, blocker)}>Open</a>
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                    </span>
                    {outcome.status === 'blocked' && host !== null && (
                      <div className="planner-row-actions">
                        <button
                          type="button"
                          className="planner-btn danger"
                          disabled={busy}
                          onClick={() => setForceTarget(host)}
                        >
                          Force restart {host.label}…
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {Object.keys(updateOutcomes).length > 0 && (
            <div className="fleet-maintenance-results" aria-label="Agent update outcomes">
              {Object.values(updateOutcomes).map((outcome) => (
                <div key={outcome.hostId} className="planner-section" style={{ marginTop: 8 }}>
                  <strong>
                    {outcome.label} —{' '}
                    {outcome.progress.status === 'running'
                      ? 'Updating…'
                      : outcome.progress.status === 'succeeded'
                        ? 'Updated'
                        : outcome.progress.status === 'failed'
                          ? 'Update failed'
                          : 'Queued'}
                  </strong>
                  <pre className="hook-preview agent-install-log" style={{ marginTop: 4 }}>
                    {outcome.progress.lines.length > 0
                      ? outcome.progress.lines.join('\n')
                      : outcome.progress.status === 'idle'
                        ? 'Waiting for previous host to finish…'
                        : 'Starting…'}
                  </pre>
                  {outcome.progress.error !== null && (
                    <div className="error-box" role="alert">
                      {outcome.progress.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="hub-row-actions">
          <button
            type="button"
            id="hub-restart-drained-btn"
            disabled={busy || selectedHosts.length === 0}
            onClick={() => void handleRestartDrained()}
          >
            {restarting ? 'Restarting…' : 'Restart drained hosts'}
          </button>
          <button
            type="button"
            id="hub-update-agent-btn"
            disabled={busy || selectedHosts.length === 0}
            onClick={() => void handleUpdateAgent()}
          >
            {updatingAgent ? `Updating ${agentLabel}…` : `Update ${agentLabel} on hosts…`}
          </button>
        </div>
      </div>

      {forceTarget !== null && (
        <ConfirmDialog
          title={`Force restart ${forceTarget.label}?`}
          body={
            `${forceTarget.label} reported active work in progress. Forcing a restart now will ` +
            'immediately interrupt any mid-turn sessions, Pocket Agent chats, cron runs or webhook ' +
            'deliveries on that host.'
          }
          confirmLabel={`Force restart ${forceTarget.label}`}
          danger
          busy={forceBusy}
          onConfirm={() => void handleConfirmForceRestart(forceTarget)}
          onCancel={() => setForceTarget(null)}
        />
      )}
    </section>
  );
}
