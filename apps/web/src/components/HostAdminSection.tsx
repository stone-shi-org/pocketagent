import { useCallback, useEffect, useRef, useState } from 'react';
import type { DrainBlocker } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { useHostApi } from '../hosts/HostContext.js';

interface Props {
  onApiError: (error: unknown) => void;
}

/** How often to ask whether the host is back, and for how long. */
const HEALTH_POLL_MS = 2_000;
const HEALTH_POLL_LIMIT_MS = 120_000;

/**
 * PA-69: this host's build, and asking it to drain and restart.
 *
 * ## What this is not
 *
 * There is no version to choose, no image to name and no "upgrade" button,
 * because the server never replaces its own code. The update source is fixed
 * at deploy time in the compose file or the systemd unit; what this offers is
 * the *timing* — stop at a moment that does not destroy work — and the
 * supervisor does the rest. A UI that could name the artifact would turn
 * "restart this host" into "run an arbitrary image on that host".
 *
 * ## Why it lives in Settings rather than on its own route
 *
 * Settings is already per-host: its tab is wrapped in a `HostProvider`, so
 * `useHostApi()` talks to the machine whose settings are on screen and this
 * section is host-correct with no new route, no `Route` variant and no
 * `tabIdFor` case. It also closes a gap that was already here — the page
 * badges settings with "Applies after restart" and until now offered no way to
 * perform one.
 *
 * Version *drift* is deliberately not shown here. Comparing builds needs the
 * whole fleet, which this page does not know; that badge belongs in the host
 * list (`HostGroup`/`HostRail`/`HostSheet`), where the comparison is possible.
 */
export function HostAdminSection({ onApiError }: Props): JSX.Element {
  const api = useHostApi();
  const [version, setVersion] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<DrainBlocker[] | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<'clean' | 'force' | null>(null);
  const [phase, setPhase] = useState<'idle' | 'restarting' | 'back' | 'slow'>('idle');
  // Cleared on unmount so a poll cannot outlive the section and call setState
  // on a component the operator has navigated away from.
  const pollRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await api.getDrainState();
      setBlockers(state.blockers);
      setSupported(state.restartSupported);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not read this host’s drain state.');
    }
  }, [api, onApiError]);

  useEffect(() => {
    void load();
    void api
      .listHosts()
      .then((res) => setVersion(res.hosts[0]?.version ?? null))
      // A missing version is cosmetic here; the drain state is the part that
      // matters, and it has its own error path above.
      .catch(() => setVersion(null));
  }, [load, api]);

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    },
    [],
  );

  /**
   * Waits for the host to answer `/health` again after it exits.
   *
   * Worth doing rather than leaving the operator staring at a dead page: the
   * restart is the one action here whose success is only observable *after*
   * the connection drops, and "did my supervisor actually bring it back?" is
   * exactly the question this feature's non-zero exit code exists to answer.
   * A host that never comes back says so instead of spinning forever — that
   * is the `Restart=no` / missing-policy case, and naming it is the only way
   * an operator learns their unit is misconfigured.
   */
  function waitForHost(): void {
    const startedAt = Date.now();
    setPhase('restarting');
    pollRef.current = window.setInterval(() => {
      if (Date.now() - startedAt > HEALTH_POLL_LIMIT_MS) {
        if (pollRef.current !== null) window.clearInterval(pollRef.current);
        pollRef.current = null;
        setPhase('slow');
        return;
      }
      void api
        .health()
        .then((health) => {
          if (pollRef.current !== null) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setVersion(health.version);
          setPhase('back');
          void load();
        })
        // Still down, which is the expected answer for the first few seconds.
        .catch(() => undefined);
    }, HEALTH_POLL_MS);
  }

  async function restart(force: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.restartServer(force);
      setConfirming(null);
      waitForHost();
    } catch (err) {
      onApiError(err);
      if (err instanceof ApiError && err.code === 'drain_blocked') {
        // Something started between the preflight and the press. Re-read
        // rather than trusting the stale list the button was rendered from.
        setError(err.message);
        setConfirming(null);
        await load();
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not restart this host.');
      }
    } finally {
      setBusy(false);
    }
  }

  const blocked = blockers !== null && blockers.length > 0;

  return (
    <>
      <p className="transport-hint" style={{ marginBottom: 10 }}>
        This host is running <strong>{version ?? 'an unreported version'}</strong>. Restarting asks
        it to finish what it is doing and exit; whatever supervises it — systemd, Docker — starts
        it again, on whatever image that unit points at. This app never downloads or installs
        anything, and cannot choose a version.
      </p>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {phase === 'restarting' && (
        <div className="notice inline info" role="status">
          Draining and restarting. Waiting for this host to answer again…
        </div>
      )}
      {phase === 'back' && (
        <div className="notice inline info" role="status">
          Back up, running {version ?? 'an unreported version'}.
        </div>
      )}
      {phase === 'slow' && (
        <div className="notice inline warn" role="status">
          This host has not answered for two minutes. It exited cleanly, so if it has not come
          back its supervisor is not configured to restart it — check for{' '}
          <code>Restart=always</code> or <code>Restart=on-failure</code> in the unit, or a restart
          policy on the container.
        </div>
      )}

      {supported === false && (
        <div className="notice inline warn" role="status">
          This process has no supervisor that could restart it, so it will not exit on request.
          Run it under systemd or Docker with a restart policy.
        </div>
      )}

      {blockers === null ? (
        <div className="spinner">Loading…</div>
      ) : (
        <>
          {blocked ? (
            <>
              <p className="planner-row-meta">
                {blockers.length === 1 ? '1 thing is' : `${blockers.length} things are`} still
                working. Restarting now would interrupt {blockers.length === 1 ? 'it' : 'them'}.
              </p>
              {blockers.map((blocker) => (
                <div key={`${blocker.kind}:${blocker.id}`} className="planner-model-row">
                  <span>
                    <strong>{blocker.title}</strong>
                    <br />
                    <span className="planner-row-meta">
                      {blocker.kind === 'session' ? 'Session' : 'Pocket Agent chat'}
                      {blocker.agentDisplayName === null ? '' : ` · ${blocker.agentDisplayName}`}
                      {blocker.reason === 'awaiting_approval'
                        ? ' · waiting for your approval'
                        : ' · mid-turn'}
                      {blocker.since === null
                        ? ''
                        : ` · since ${new Date(blocker.since).toLocaleTimeString()}`}
                    </span>
                    {blocker.cwd !== null && (
                      <>
                        <br />
                        <span className="planner-row-meta">
                          <code>{blocker.cwd}</code>
                        </span>
                      </>
                    )}
                  </span>
                  <a
                    className="planner-btn"
                    href={
                      blocker.kind === 'session'
                        ? `#/s/${encodeURIComponent(blocker.id)}`
                        : `#/planner/${encodeURIComponent(blocker.id)}`
                    }
                  >
                    Open
                  </a>
                </div>
              ))}
            </>
          ) : (
            <p className="planner-row-meta">Nothing is mid-turn. A restart would lose no work.</p>
          )}

          <div className="planner-model-row">
            <span className="planner-row-meta">
              {/* Stated every time, not only when something is blocking: which
                  sessions survive a restart is not obvious, and it is the
                  thing an operator is actually deciding about. */}
              Terminal sessions on the tmux backend are re-adopted after a restart. Agent chats,
              cron runs and webhook deliveries are not — the agent SDK owns those processes, so
              they end whatever backend is configured, and show as interrupted afterwards.
            </span>
            <button
              type="button"
              className={blocked ? 'planner-btn danger' : 'planner-btn'}
              disabled={busy || supported === false || phase === 'restarting'}
              onClick={() => setConfirming(blocked ? 'force' : 'clean')}
            >
              {blocked ? 'Restart anyway' : 'Restart'}
            </button>
          </div>
        </>
      )}

      {confirming !== null && (
        <ConfirmDialog
          title={confirming === 'force' ? 'Interrupt work and restart?' : 'Restart this host?'}
          body={
            confirming === 'force'
              ? `${describeForce(blockers ?? [])} That work is lost, not paused — including any ` +
                'turn waiting on an approval, which cannot be answered afterwards. Terminal ' +
                'sessions on the tmux backend are re-adopted; agent chats are not.'
              : 'This host will finish draining and exit, and its supervisor will start it again ' +
                'on whatever image the unit points at. Nothing is mid-turn right now. Terminal ' +
                'sessions on the tmux backend are re-adopted; anything running under the agent ' +
                'SDK ends and shows as interrupted.'
          }
          confirmLabel={confirming === 'force' ? 'Interrupt and restart' : 'Restart'}
          danger={confirming === 'force'}
          busy={busy}
          onConfirm={() => void restart(confirming === 'force')}
          onCancel={() => setConfirming(null)}
        />
      )}
    </>
  );
}

/**
 * Names what is about to be interrupted, in the dialog itself.
 *
 * The ticket explicitly rejects "an upgrade that interrupts a turn without
 * saying so", so the confirmation has to list them rather than say "some work
 * is running" — and `ConfirmDialog.body` is a plain string, so this builds one
 * sentence instead of markup.
 */
function describeForce(blockers: readonly DrainBlocker[]): string {
  const names = blockers.slice(0, 3).map((b) => b.title);
  const rest = blockers.length - names.length;
  const list = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
  return blockers.length === 1
    ? `${list} is still working and will be interrupted.`
    : `${list} are still working and will be interrupted.`;
}
