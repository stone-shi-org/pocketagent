import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentInfo, InstallAgentAction, InstallableAgent, InstallableAgentId } from '@pocketagent/protocol';
import { isCustomClaudeProviderId } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { useHostApi } from '../hosts/HostContext.js';
import { Icon } from './Icon.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import {
  applyInstallEvent,
  canOfferInstall,
  emptyInstallProgress,
  installProgressTitle,
  otherCopyNotices,
  primaryInstallAction,
  setupBadge,
  setupHint,
  setupStateOf,
  unofficialCopyWarning,
  type CopyNotice,
  type InstallProgress,
} from '../agent/agent-setup.js';

interface Props {
  /**
   * Shown when the dialog is opened for one specific agent (from the composer
   * picking an agent that is not installed). Omitted for the Settings entry
   * point, which reviews all of them.
   */
  focusAgentId?: string;
  onApiError: (error: unknown) => void;
  /** Called after any install finishes, so the opener can refresh its list. */
  onChanged?: () => void;
  onClose: () => void;
}

/**
 * "Which coding agents does this host have, and what is missing?" (PA-68).
 *
 * The component the ticket describes as a bind-time dialog. It deliberately
 * takes no host and no client of its own — `useHostApi()` supplies both from
 * context — so the same component serves the Settings entry point today and a
 * post-bind entry point once a Hub exists to bind from (PA-66), with no
 * changes here. That is the whole reason it is a dialog rather than a section:
 * a section could not be opened from somewhere else.
 *
 * ## Three states, and why the fourth exists
 *
 * See `AgentSetupState`. The short version is that "installed" is not
 * "signed in", and for two of the five agents this server knows about there is
 * no way to ask — so `unknown` is shown as its own neutral state rather than
 * being rounded to either a tick or a warning.
 *
 * ## Official installers, official locations (PA-104)
 *
 * Every row says which installer it would run (its URL, never an input), what
 * "Update" does for that agent, which binary the server actually runs, and
 * every *other* copy on the host. The last two exist because the bug PA-104
 * fixed was invisible from here: Settings installed a second copy the server
 * ran while a human's shell ran the official one, and the dialog showed a
 * green tick for both. A leftover copy in the install prefix can be removed
 * from here, behind a confirmation; any other copy is reported only.
 *
 * ## The install is not cancellable from here, on purpose
 *
 * Closing the dialog detaches the progress stream and leaves the install
 * running; reopening attaches to it and replays the log. A half-installed
 * package tree is worse than either finishing or never starting, and an
 * operator who locked their phone has not asked to abort anything.
 */
export function AgentSetupDialog({ focusAgentId, onApiError, onChanged, onClose }: Props): JSX.Element {
  const api = useHostApi();
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [catalog, setCatalog] = useState<InstallableAgent[] | null>(null);
  const [prefix, setPrefix] = useState<{ path: string; detectable: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState<InstallableAgentId | null>(null);
  const [progress, setProgress] = useState<InstallProgress>(emptyInstallProgress());
  const [confirmRemove, setConfirmRemove] = useState<{ id: InstallableAgentId; displayName: string; notice: CopyNotice } | null>(null);

  const load = useCallback(async () => {
    try {
      const [agentList, installable] = await Promise.all([api.listAgents(), api.listInstallableAgents()]);
      setAgents(agentList.agents);
      setCatalog(installable.agents);
      setPrefix({ path: installable.prefix, detectable: installable.prefixDetectable });
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not read this host’s agents.');
    }
  }, [api, onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape closes, matching `ConfirmDialog`. Disabled mid-install: the stream
  // would detach silently and the operator would reasonably read that as the
  // install having been cancelled, which it would not be.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && installing === null) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [installing, onClose]);

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // Follow the tail. Unconditional rather than "unless the user scrolled up"
    // (`Transcript.tsx`'s rule) because this box is short, short-lived, and the
    // interesting line is always the newest.
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [progress.lines.length]);

  async function install(id: InstallableAgentId, action: InstallAgentAction): Promise<void> {
    setInstalling(id);
    setProgress(emptyInstallProgress(action));
    let latest = emptyInstallProgress(action);
    try {
      await api.installAgent(id, (event) => {
        latest = applyInstallEvent(latest, event);
        setProgress(latest);
      }, 0, action);
    } catch (err) {
      // If the install already completed successfully, a trailing socket disconnect
      // must not overwrite success with a failure.
      if (latest.status === 'succeeded') {
        return;
      }
      onApiError(err);
      setProgress({
        ...latest,
        status: 'failed',
        error:
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'The install could not be started.',
      });
    } finally {
      setInstalling(null);
      // Re-read rather than patching the row from the event: `available` and
      // the sign-in probe are both server-side facts, and the server has just
      // re-derived them.
      await load();
      onChanged?.();
    }
  }

  // Coding agents only: `shell` is not an agent anyone installs, and a
  // `custom-claude:` variant is the *same* `claude` binary with a different
  // base URL — installing `claude` serves every variant at once, so listing
  // them here would offer the same install several times under other names.
  const rows = (agents ?? []).filter(
    (a) => a.transports.includes('structured') && !isCustomClaudeProviderId(a.id),
  );
  const ordered = focusAgentId
    ? [...rows].sort((a, b) => Number(b.id === focusAgentId) - Number(a.id === focusAgentId))
    : rows;
  const catalogById = new Map((catalog ?? []).map((c) => [c.id, c]));

  return (
    <div className="dialog-backdrop" onClick={() => installing === null && onClose()}>
      <div
        className="dialog agent-setup-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Agent setup"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Agent setup</h2>
        <p className="transport-hint">
          Which coding agent CLIs this host has, and whether each one is signed in. Installing runs
          on the host itself.
        </p>

        {error !== null && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {prefix !== null && !prefix.detectable && (catalog ?? []).some((c) => c.method === 'npm') && (
          <div className="warn-callout" role="alert">
            Installs are configured to go to <code>{prefix.path}</code>, which this server does not
            search for agent binaries — an install there would not be found. Change{' '}
            <strong>Agent install prefix</strong> in Settings first.
          </div>
        )}

        {agents === null ? (
          <div className="spinner">Loading…</div>
        ) : (
          ordered.map((agent) => {
            const state = setupStateOf(agent);
            const badge = setupBadge(state);
            const hint = setupHint(agent);
            const entry = catalogById.get(agent.id as InstallableAgentId);
            const offer = canOfferInstall(agent, entry, prefix?.detectable ?? false);
            const primary = primaryInstallAction(agent);
            const busy = installing === agent.id;
            const unofficial = unofficialCopyWarning(agent);
            const copies = otherCopyNotices(agent);
            return (
              <div key={agent.id} className="planner-model-row">
                <span>
                  <strong>{agent.displayName}</strong>{' '}
                  <span className={`settings-badge badge-${badge.tone}`}>{badge.label}</span>
                  {hint !== null && (
                    <>
                      <br />
                      <span className="planner-row-meta">{hint}</span>
                    </>
                  )}
                  {agent.installedVersion && (
                    <>
                      <br />
                      <span className="planner-row-meta">Installed: v{agent.installedVersion}</span>
                    </>
                  )}
                  {agent.hasUpdate && agent.latestVersion && (
                    <>
                      <br />
                      <span className="planner-row-meta" style={{ color: 'var(--tone-warn, #d97706)' }}>
                        Update available: v{agent.latestVersion}
                      </span>
                    </>
                  )}
                  {agent.resolvedPath && (
                    <>
                      <br />
                      <span className="planner-row-meta" style={{ wordBreak: 'break-all' }}>
                        Runs <code>{agent.resolvedPath}</code>
                      </span>
                    </>
                  )}
                  {entry !== undefined && (
                    <>
                      <br />
                      <span className="planner-row-meta" style={{ wordBreak: 'break-all' }}>
                        {/* An older host sends `method: 'npm'` with no `source`. */}
                        {entry.method === 'official-script'
                          ? `Official installer: ${entry.source}`
                          : `npm: ${entry.source ?? entry.packageName}${entry.version ? `@${entry.version}` : ''}`}
                      </span>
                      {entry.updateDescription && (
                        <>
                          <br />
                          <span className="planner-row-meta">Update: {entry.updateDescription}</span>
                        </>
                      )}
                      {(entry.notes ?? []).map((note) => (
                        <span key={note}>
                          <br />
                          <span className="planner-row-meta">{note}</span>
                        </span>
                      ))}
                    </>
                  )}
                  {unofficial !== null && (
                    <>
                      <br />
                      <span className="planner-row-meta" style={{ color: 'var(--tone-warn, #d97706)' }}>
                        {unofficial}
                      </span>
                    </>
                  )}
                  {copies.map((notice) => (
                    <span key={notice.copy.path}>
                      <br />
                      <span className="planner-row-meta" style={{ wordBreak: 'break-all' }}>
                        {notice.message}{' '}
                        {notice.removable && (
                          <button
                            type="button"
                            className="planner-btn"
                            disabled={installing !== null}
                            onClick={() =>
                              setConfirmRemove({
                                id: agent.id as InstallableAgentId,
                                displayName: agent.displayName,
                                notice,
                              })
                            }
                          >
                            Remove
                          </button>
                        )}
                      </span>
                    </span>
                  ))}
                  {agent.lastInstallOk === false && agent.lastInstallError !== null && !busy && (
                    <>
                      <br />
                      <span className="planner-row-meta">Last install failed — {agent.lastInstallError}</span>
                    </>
                  )}
                </span>
                <div className="planner-row-actions">
                  {offer && (
                    <button
                      type="button"
                      className="planner-btn"
                      disabled={installing !== null}
                      onClick={() => void install(agent.id as InstallableAgentId, primary.action)}
                    >
                      {busy ? primary.busyLabel : primary.label}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}

        {progress.status !== 'idle' && (
          <div className="planner-section">
            <h3>{installProgressTitle(progress)}</h3>
            {progress.truncated && (
              <p className="planner-row-meta">Earlier output was dropped to bound memory.</p>
            )}
            <pre className="hook-preview agent-install-log" ref={logRef}>
              {progress.lines.length > 0
                ? progress.lines.join('\n')
                : progress.status === 'failed'
                  ? 'Install could not proceed.'
                  : 'Starting…'}
            </pre>
            {progress.error !== null && (
              <div className="error-box" role="alert">
                {progress.error}
              </div>
            )}
            {progress.status === 'succeeded' && progress.action !== 'remove-prefix-copy' && (
              <p className="planner-row-meta">
                <Icon name="check" size={14} /> {progress.action === 'update' ? 'Updated' : 'Installed'}. If
                it now shows “Not signed in”, open a Shell session on this host to sign in.
              </p>
            )}
            {progress.status === 'succeeded' && progress.action === 'remove-prefix-copy' && (
              <p className="planner-row-meta">
                <Icon name="check" size={14} /> Leftover copy removed.
              </p>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="planner-btn" disabled={installing !== null} onClick={onClose}>
            {installing !== null ? 'Working…' : 'Done'}
          </button>
        </div>
      </div>
      {confirmRemove !== null && (
        <ConfirmDialog
          title={`Remove leftover ${confirmRemove.displayName} copy?`}
          body={`This runs npm uninstall for the copy at ${confirmRemove.notice.copy.path}, which an earlier install from this page put there. It is not the copy that runs, and the official install is not touched.`}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            void install(target.id, 'remove-prefix-copy');
          }}
        />
      )}
    </div>
  );
}
