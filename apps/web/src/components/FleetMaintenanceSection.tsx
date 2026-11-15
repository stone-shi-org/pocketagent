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

export interface AgentUpdateItemOutcome {
  readonly agentId: InstallableAgentId;
  readonly agentLabel: string;
  readonly progress: InstallProgress;
}

export interface AgentUpdateHostOutcome {
  readonly hostId: string;
  readonly label: string;
  readonly agents: readonly AgentUpdateItemOutcome[];
  readonly progress: InstallProgress;
}

function deriveHostUpdateProgress(items: readonly AgentUpdateItemOutcome[]): InstallProgress {
  if (items.length === 0) return emptyInstallProgress('update');
  if (items.length === 1) return items[0]!.progress;

  const running = items.find((item) => item.progress.status === 'running');
  if (running !== undefined) {
    return { ...running.progress, status: 'running' };
  }
  if (items.every((item) => item.progress.status === 'idle')) {
    return emptyInstallProgress('update');
  }
  if (items.some((item) => item.progress.status === 'idle')) {
    return { ...emptyInstallProgress('update'), status: 'running' };
  }

  const lines = items.flatMap((item) =>
    item.progress.lines.map((line) => `[${item.agentLabel}] ${line}`),
  );
  const failed = items.filter((item) => item.progress.status === 'failed');
  if (failed.length > 0) {
    return {
      ...emptyInstallProgress('update'),
      status: 'failed',
      lines,
      error: failed
        .map((item) => `${item.agentLabel}: ${item.progress.error ?? 'Update failed.'}`)
        .join(' · '),
    };
  }
  return {
    ...emptyInstallProgress('update'),
    status: 'succeeded',
    lines,
    error: null,
  };
}

export function summarizeHostAgentUpdate(outcome: AgentUpdateHostOutcome): string {
  const total = outcome.agents.length;
  if (total <= 1) {
    const prefix = total === 1 ? `${outcome.agents[0]!.agentLabel}: ` : '';
    switch (outcome.progress.status) {
      case 'running':
        return `${prefix}Updating…`;
      case 'succeeded':
        return `${prefix}Updated`;
      case 'failed':
        return `${prefix}Update failed`;
      default:
        return `${prefix}Queued`;
    }
  }

  const runningIdx = outcome.agents.findIndex((item) => item.progress.status === 'running');
  if (runningIdx !== -1) {
    const current = outcome.agents[runningIdx]!;
    return `Updating ${current.agentLabel} (${runningIdx + 1}/${total})…`;
  }

  const idleCount = outcome.agents.filter((item) => item.progress.status === 'idle').length;
  if (idleCount === total) return 'Queued';

  const succeededCount = outcome.agents.filter((item) => item.progress.status === 'succeeded').length;
  const failedCount = outcome.agents.filter((item) => item.progress.status === 'failed').length;
  if (idleCount > 0) {
    return `Updating (${succeededCount + failedCount}/${total})…`;
  }
  if (failedCount === 0) {
    return `Updated (${succeededCount}/${total})`;
  }
  if (succeededCount === 0) {
    return `Update failed (${failedCount}/${total} failed)`;
  }
  return `${succeededCount} updated, ${failedCount} failed`;
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
 * Runs `POST /api/agents/install` with `action: 'update'` for each requested
 * coding agent on each selected host **one host and one agent at a time**
 * (sequentially — each backend enforces a single active install/update slot),
 * streaming live log lines via `onProgress`.
 */
export async function updateAgentsOnHosts(
  agentIds: readonly InstallableAgentId[],
  targets: readonly HostRecord[],
  onProgress?: (outcomes: Readonly<Record<string, AgentUpdateHostOutcome>>) => void,
  clientFactory: (host: HostRecord) => ApiClient = (host) => createApiClient(host.endpoint),
): Promise<Record<string, AgentUpdateHostOutcome>> {
  const orderedAgentIds = INSTALLABLE_AGENT_IDS.filter((id) => agentIds.includes(id));
  if (orderedAgentIds.length === 0 || targets.length === 0) {
    return {};
  }

  const outcomes: Record<string, AgentUpdateHostOutcome> = {};
  for (const host of targets) {
    const id = host.hubHostId ?? host.endpoint.id;
    const initialAgents: AgentUpdateItemOutcome[] = orderedAgentIds.map((agentId) => ({
      agentId,
      agentLabel: FLEET_INSTALLABLE_AGENT_LABELS[agentId],
      progress: emptyInstallProgress('update'),
    }));
    outcomes[id] = {
      hostId: id,
      label: host.label,
      agents: initialAgents,
      progress: deriveHostUpdateProgress(initialAgents),
    };
  }
  onProgress?.({ ...outcomes });

  for (const host of targets) {
    const id = host.hubHostId ?? host.endpoint.id;
    const client = clientFactory(host);
    const items: AgentUpdateItemOutcome[] = [...outcomes[id]!.agents];

    const publishHost = (): void => {
      const snapshot = [...items];
      outcomes[id] = {
        hostId: id,
        label: host.label,
        agents: snapshot,
        progress: deriveHostUpdateProgress(snapshot),
      };
      onProgress?.({ ...outcomes });
    };

    for (let idx = 0; idx < orderedAgentIds.length; idx += 1) {
      const agentId = orderedAgentIds[idx]!;
      const agentLabel = FLEET_INSTALLABLE_AGENT_LABELS[agentId];
      let latest: InstallProgress = {
        ...emptyInstallProgress('update'),
        status: 'running',
      };
      items[idx] = { agentId, agentLabel, progress: latest };
      publishHost();

      try {
        await client.installAgent(
          agentId,
          (event) => {
            latest = applyInstallEvent(latest, event);
            items[idx] = { agentId, agentLabel, progress: latest };
            publishHost();
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
          items[idx] = { agentId, agentLabel, progress: latest };
          publishHost();
        }
      }
    }
  }

  return outcomes;
}

/**
 * Convenience wrapper for updating a single coding agent sequentially across
 * `targets`.
 */
export async function updateAgentOnHosts(
  agentId: InstallableAgentId,
  targets: readonly HostRecord[],
  onProgress?: (outcomes: Readonly<Record<string, AgentUpdateHostOutcome>>) => void,
  clientFactory: (host: HostRecord) => ApiClient = (host) => createApiClient(host.endpoint),
): Promise<Record<string, AgentUpdateHostOutcome>> {
  return updateAgentsOnHosts([agentId], targets, onProgress, clientFactory);
}

interface Props {
  hosts: readonly HostRecord[];
  onApiError: (error: unknown) => void;
}

export function FleetMaintenanceSection({ hosts, onApiError }: Props): JSX.Element {
  const bound = hosts.filter((host) => host.hubBound === true);
  const manageId = (host: HostRecord): string => host.hubHostId ?? host.endpoint.id;

  const [selectedIds, setSelectedIds] = useState<string[]>(() => bound.map(manageId));
  const [selectedAgentIds, setSelectedAgentIds] = useState<InstallableAgentId[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [restartOutcomes, setRestartOutcomes] = useState<Record<string, RestartHostOutcome>>({});
  const [forceTarget, setForceTarget] = useState<HostRecord | null>(null);
  const [forceBusy, setForceBusy] = useState(false);
  const [updatingMode, setUpdatingMode] = useState<'selected' | 'all' | null>(null);
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
  const toggleAgent = (id: InstallableAgentId): void => {
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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

  const runAgentUpdate = async (
    targetAgentIds: readonly InstallableAgentId[],
    mode: 'selected' | 'all',
  ): Promise<void> => {
    if (selectedHosts.length === 0 || targetAgentIds.length === 0) return;
    setUpdatingMode(mode);
    try {
      await updateAgentsOnHosts(targetAgentIds, selectedHosts, (next) => setUpdateOutcomes({ ...next }));
    } catch (err) {
      onApiError(err);
    } finally {
      setUpdatingMode(null);
    }
  };

  const updatingAgent = updatingMode !== null;
  const busy = restarting || updatingAgent || forceBusy;

  return (
    <section className="hub-section" id="hub-maintenance" aria-labelledby="hub-maintenance-heading">
      <h2 id="hub-maintenance-heading">Host maintenance</h2>
      <div className="hub-row-card fleet-card">
        <Icon name="terminal" size={20} className="hub-row-icon" />
        <div className="hub-row-main">
          <strong>Human-only host actions</strong>
          <span>
            Restarting a host and updating coding agent CLIs are never exposed to the Fleet agent or
            any MCP client. Select the bound hosts and coding agents to act on below; restarts check
            each host’s drain state first and never force-interrupt active work without a separate
            per-host confirmation, and agent updates run sequentially one host and agent at a time.
          </span>

          {bound.length === 0 ? (
            <span className="hub-muted">Bind at least one host above to run maintenance actions.</span>
          ) : (
            <div className="fleet-field">
              <span>Target hosts</span>
              <div className="fleet-host-Checkboxes hub-checkbox-inline" role="group" aria-label="Target hosts">
                {bound.map((host) => {
                  const id = manageId(host);
                  const checked = selectedIds.includes(id);
                  return (
                    <label key={id} className="fleet-host-checkbox">
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
            </div>
          )}

          <div className="fleet-field" style={{ marginTop: 8 }}>
            <span>Coding agents to update</span>
            <div
              className="fleet-agent-checkboxes hub-checkbox-inline"
              role="group"
              aria-label="Coding agents to update"
            >
              {INSTALLABLE_AGENT_IDS.map((id) => {
                const checked = selectedAgentIds.includes(id);
                return (
                  <label key={id} className="fleet-host-checkbox" title={id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={busy || bound.length === 0}
                      onChange={() => toggleAgent(id)}
                    />
                    <span>{FLEET_INSTALLABLE_AGENT_LABELS[id]}</span>
                  </label>
                );
              })}
            </div>
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
                    {outcome.label} — {summarizeHostAgentUpdate(outcome)}
                  </strong>
                  {outcome.agents.length <= 1 ? (
                    <>
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
                    </>
                  ) : (
                    <div className="fleet-agent-outcomes">
                      {outcome.agents.map((item) => {
                        const statusText =
                          item.progress.status === 'running'
                            ? 'Updating…'
                            : item.progress.status === 'succeeded'
                              ? 'Updated'
                              : item.progress.status === 'failed'
                                ? 'Update failed'
                                : 'Queued';
                        if (item.progress.status === 'idle') {
                          return (
                            <div key={item.agentId} className="fleet-agent-outcome-queued">
                              <span>{item.agentLabel}</span>
                              <span className="hub-muted"> — {statusText}</span>
                            </div>
                          );
                        }
                        return (
                          <details
                            key={`${item.agentId}:${item.progress.status}`}
                            className="fleet-agent-outcome"
                            open={item.progress.status === 'running' || item.progress.status === 'failed'}
                          >
                            <summary>
                              <span>{item.agentLabel}</span>
                              {' — '}
                              <span
                                className={
                                  item.progress.status === 'failed'
                                    ? 'warn'
                                    : item.progress.status === 'succeeded'
                                      ? 'ok'
                                      : undefined
                                }
                              >
                                {statusText}
                              </span>
                            </summary>
                            <pre className="hook-preview agent-install-log" style={{ marginTop: 4 }}>
                              {item.progress.lines.length > 0 ? item.progress.lines.join('\n') : 'Starting…'}
                            </pre>
                            {item.progress.error !== null && (
                              <div className="error-box" role="alert">
                                {item.progress.error}
                              </div>
                            )}
                          </details>
                        );
                      })}
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
            id="hub-update-selected-agents-btn"
            disabled={busy || selectedHosts.length === 0 || selectedAgentIds.length === 0}
            title={
              selectedAgentIds.length === 0
                ? 'Select at least one coding agent above, or click Update All.'
                : undefined
            }
            onClick={() => void runAgentUpdate(selectedAgentIds, 'selected')}
          >
            {updatingMode === 'selected' ? 'Updating Selected…' : 'Update Selected'}
          </button>
          <button
            type="button"
            id="hub-update-all-agents-btn"
            disabled={busy || selectedHosts.length === 0}
            onClick={() => void runAgentUpdate(INSTALLABLE_AGENT_IDS, 'all')}
          >
            {updatingMode === 'all' ? 'Updating All…' : 'Update All'}
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
