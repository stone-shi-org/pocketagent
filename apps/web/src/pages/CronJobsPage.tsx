import { useCallback, useEffect, useState } from 'react';
import type { CronJob } from '@pocketagent/protocol';
import { describeCron } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import { formatCountdown } from '../agent/cron-format.js';

const REFRESH_MS = 5000;

interface Props {
  /** Opens one job's editor and run history. */
  onOpenJob: (jobId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Present only on the phone route. `DesktopShell` renders this in its right
   * pane with the sidebar already on screen, so it passes nothing — same
   * "shared content, per-shell chrome" split as `AgentsFleetPage`.
   */
  onBack?: () => void;
}

/**
 * The list of scheduled jobs.
 *
 * Polls on its own timer like `AgentsFleetPage`: `nextRunAt` is a countdown and
 * `lastRunStatus` changes without anyone touching the page, so a static list
 * would go stale while being looked at.
 */
export function CronJobsPage({ onOpenJob, onApiError, onBack }: Props): JSX.Element {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Job ids with an action in flight, so a row cannot be double-fired. */
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const { jobs: all } = await api.listCronJobs();
      setJobs(all);
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load scheduled jobs.');
      setJobs([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const withBusy = useCallback(
    async (id: string, action: () => Promise<unknown>) => {
      setBusy((prev) => new Set(prev).add(id));
      try {
        await action();
        await load();
      } catch (err) {
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'That did not work.');
        // Undo whatever was applied optimistically below.
        await load();
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [load, onApiError],
  );

  /**
   * Flip the switch locally before the request lands.
   *
   * Without this the checkbox is driven purely by server state, so a tap
   * visibly snaps back to its old position until the PATCH round-trips and the
   * poll catches up — which over a tailnet is long enough to read as "the
   * toggle is broken". Same optimistic-then-reconcile shape `SettingsPage`
   * uses, and `withBusy` re-loads on failure to undo it.
   */
  const setEnabled = useCallback(
    (id: string, enabled: boolean) => {
      setJobs((prev) => prev?.map((j) => (j.id === id ? { ...j, enabled } : j)) ?? prev);
      void withBusy(id, () => api.updateCronJob(id, { enabled }));
    },
    [withBusy],
  );

  const content = (
    <div className="cron-page">
      <div className="cron-head">
        <div>
          <h2>Scheduled jobs</h2>
          <p className="cron-sub">
            Each job starts an agent on its own schedule and sends it a prompt.
          </p>
        </div>
        <button type="button" className="cron-new" onClick={() => onOpenJob('new')}>
          <Icon name="plus" size={18} />
          New job
        </button>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {jobs === null && <div className="spinner">Loading…</div>}
      {jobs?.length === 0 && (
        <div className="cron-empty">
          Nothing scheduled yet. A job runs a prompt in a project on a repeating schedule —
          a nightly review, a morning dependency check.
        </div>
      )}

      {jobs?.map((job) => (
        <div key={job.id} className={`cron-row${job.enabled ? '' : ' disabled'}`}>
          <button type="button" className="cron-main" onClick={() => onOpenJob(job.id)}>
            <span className="cron-row-title">
              <Icon name="clock" size={17} className="cron-row-icon" />
              {job.name}
              {job.skipPermissionsEnabled && (
                // Persistent, not just at creation: a job running with
                // approvals bypassed has to say so every time it is seen.
                <Icon
                  name="shield"
                  size={14}
                  className="cron-shield"
                  aria-label="Approvals bypassed"
                />
              )}
            </span>
            <span className="cron-row-meta">
              {describeCron(job.cronExpr)}
              {' · '}
              {job.workspaceLabel}
            </span>
            <span className="cron-row-meta">
              {job.enabled ? (
                job.nextRunAt !== null ? (
                  <>Next run {formatCountdown(job.nextRunAt)}</>
                ) : (
                  <>No future run</>
                )
              ) : (
                <>Paused</>
              )}
              {job.lastRunAt !== null && (
                <>
                  {' · '}
                  <span className={`cron-status cron-status--${job.lastRunStatus ?? 'unknown'}`}>
                    {job.lastRunStatus ?? 'ran'}
                  </span>{' '}
                  {formatRelative(job.lastRunAt)}
                </>
              )}
            </span>
            {job.lastError !== null && <span className="cron-row-error">{job.lastError}</span>}
          </button>

          <div className="cron-actions">
            <button
              type="button"
              className="round-btn plain"
              disabled={busy.has(job.id)}
              onClick={() => void withBusy(job.id, () => api.runCronJobNow(job.id))}
              aria-label={`Run ${job.name} now`}
              title="Run now"
            >
              <Icon name="play" size={16} />
            </button>
            <label className="switch" title={job.enabled ? 'Pause this job' : 'Resume this job'}>
              <input
                type="checkbox"
                checked={job.enabled}
                onChange={(e) => setEnabled(job.id, e.target.checked)}
                aria-label={`${job.name} enabled`}
              />
              <span className="switch-track" />
            </label>
          </div>
        </div>
      ))}
    </div>
  );

  if (!onBack) return content;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Scheduled jobs</strong>
        </div>
      </header>
      {content}
    </div>
  );
}
