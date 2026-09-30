import { useCallback, useEffect, useState } from 'react';
import type { CronJob, CronJobExportData } from '@pocketagent/protocol';
import { describeCron } from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import { formatCountdown } from '../agent/cron-format.js';
import { useHostApi } from '../hosts/HostContext.js';
import { exportToJsonFile } from '../agent/json-transfer.js';
import { useJsonImport } from '../hooks/useJsonImport.js';

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
  const api = useHostApi();
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

  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const { trigger: triggerImport, fileInputProps } = useJsonImport<CronJobExportData | CronJobExportData[]>({
    expectedKind: 'cron-job',
    onSuccess: async ({ data: imported }) => {
      try {
        setError(null);
        setImportSuccess(null);
        const list = Array.isArray(imported) ? imported : [imported];
        let importedCount = 0;
        for (const item of list) {
          await api.createCronJob({
            name: item.name,
            enabled: item.enabled ?? true,
            preset: item.preset,
            cronExpr: item.cronExpr,
            timeZone: item.timeZone,
            cwd: item.cwd ?? '',
            agent: item.agent,
            worktreeMode: item.worktreeMode ?? 'none',
            model: item.model,
            effort: item.effort,
            skipPermissions: item.skipPermissions ?? true,
            prompt: item.prompt,
            overlapPolicy: item.overlapPolicy ?? 'skip',
            retentionDays: item.retentionDays ?? 10,
          });
          importedCount++;
        }
        await load();
        setImportSuccess(
          importedCount === 1
            ? `Job "${list[0]!.name}" imported successfully.`
            : `Imported ${importedCount} scheduled jobs successfully.`,
        );
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not import scheduled job.');
      }
    },
    onError: (err) => {
      setError(err);
      setImportSuccess(null);
    },
  });

  const toExportData = (job: CronJob): CronJobExportData => ({
    name: job.name,
    enabled: job.enabled,
    cronExpr: job.cronExpr,
    timeZone: job.timeZone,
    cwd: job.cwd,
    agent: job.agent,
    worktreeMode: job.worktreeMode,
    model: job.model,
    effort: job.effort,
    skipPermissions: job.skipPermissionsEnabled,
    prompt: job.prompt,
    overlapPolicy: job.overlapPolicy,
    retentionDays: job.retentionDays,
  });

  const exportJob = (job: CronJob): void => {
    exportToJsonFile('cron-job', toExportData(job), job.name);
  };

  const exportAllJobs = (): void => {
    if (!jobs || jobs.length === 0) return;
    const payloads = jobs.map(toExportData);
    exportToJsonFile('cron-job', payloads, 'all');
  };

  const content = (
    <div className="cron-page">
      <input {...fileInputProps} />
      <div className="cron-head">
        <div>
          <h2>Scheduled jobs</h2>
          <p className="cron-sub">
            Each job starts an agent on its own schedule and sends it a prompt.
          </p>
        </div>
        <div className="cron-head-actions" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            className="cron-secondary"
            disabled={!jobs || jobs.length === 0}
            onClick={exportAllJobs}
            title="Export all jobs to a JSON file"
          >
            <Icon name="download" size={16} />
            Export all
          </button>
          <button
            type="button"
            className="cron-secondary"
            onClick={triggerImport}
            title="Import job from a JSON file"
          >
            <Icon name="upload" size={16} />
            Import JSON
          </button>
          <button type="button" className="cron-new" onClick={() => onOpenJob('new')}>
            <Icon name="plus" size={18} />
            New job
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {importSuccess && (
        <div className="success-box" role="status">
          {importSuccess}
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
              onClick={() => exportJob(job)}
              aria-label={`Export ${job.name} to JSON`}
              title="Export to JSON"
            >
              <Icon name="download" size={16} />
            </button>
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
