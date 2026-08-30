import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentInfo,
  CronJob,
  CronJobRun,
  CronSchedulePreset,
  CronWorktreeMode,
  ProjectInfo,
  WorkspaceEntry,
} from '@pocketagent/protocol';
import { compileCronPreset, cronErrorFor, nextRuns, serverTimeZone } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from '../components/Icon.js';
import { formatRelative } from '../components/StatusBadge.js';
import { formatAbsolute, formatCountdown, WEEKDAY_LABELS } from '../agent/cron-format.js';
import { flattenProjects } from '../agent/search.js';
import { SelectRowNative } from '../components/SelectRowNative.js';
import { NumberRow, SectionCard, TextRow } from './SettingsPage.js';

interface Props {
  /** `'new'` for an unsaved job. */
  jobId: string;
  onApiError: (error: unknown) => void;
  /** Navigate to a live session — used by "run now" and by a run row. */
  onOpenSession: (sessionId: string) => void;
  /** Navigate to a finished transcript. */
  onOpenChat: (conversationId: string) => void;
  onDone: () => void;
  onBack?: () => void;
}

type Every = CronSchedulePreset['every'];

/**
 * The job editor, plus that job's run history.
 *
 * Built from `SettingsPage`'s own card-and-row vocabulary (`SectionCard`,
 * `TextRow`, `NumberRow`, imported straight from there — same reuse `OverflowMenu`
 * gets from `ProjectsPage`) rather than a parallel set of look-alike classes:
 * a job's form is exactly the same kind of "grouped settings with help text"
 * `SettingsPage` already renders, and drifting the two apart is how a page
 * ends up looking like it wandered in from a different app.
 *
 * Explicit Save, deliberately unlike `SettingsPage`'s auto-save: a half-typed
 * cron expression must never become a live schedule, and a job is a single
 * coherent thing (directory + agent + schedule + prompt) rather than a bag of
 * independent switches. The one exception is the run list, which is read-only.
 */
export function CronJobEditorPage({
  jobId,
  onApiError,
  onOpenSession,
  onOpenChat,
  onDone,
  onBack,
}: Props): JSX.Element {
  const isNew = jobId === 'new';

  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [runs, setRuns] = useState<CronJobRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // ---- The form ------------------------------------------------------------
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [agent, setAgent] = useState('claude');
  const [prompt, setPrompt] = useState('');
  const [worktreeMode, setWorktreeMode] = useState<CronWorktreeMode>('none');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [skipPermissions, setSkipPermissions] = useState(true);
  const [overlapPolicy, setOverlapPolicy] = useState<'skip' | 'allow'>('skip');
  const [enabled, setEnabled] = useState(true);
  const [timeZone, setTimeZone] = useState(serverTimeZone());

  /** `'preset'` drives the picker; `'expression'` the raw field. */
  const [scheduleKind, setScheduleKind] = useState<'preset' | 'expression'>('preset');
  const [every, setEvery] = useState<Every>('day');
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekdays, setWeekdays] = useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [cronExpr, setCronExpr] = useState('0 9 * * *');

  const loadRuns = useCallback(async () => {
    if (isNew) return;
    try {
      const { runs: all } = await api.listCronRuns(jobId);
      setRuns(all);
    } catch (err) {
      onApiError(err);
    }
  }, [isNew, jobId, onApiError]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAgents(),
      api.listWorkspaces(),
      api.listProjects().catch(() => ({ projects: [] as ProjectInfo[] })),
      isNew ? Promise.resolve(null) : api.getCronJob(jobId),
    ])
      .then(([a, w, p, job]) => {
        if (cancelled) return;
        setAgents(a.agents);
        setWorkspaces(w.workspaces);
        setProjects(p.projects);

        if (job) {
          hydrate(job);
        } else {
          setCwd(w.workspaces[0]?.path ?? '');
          const structured = a.agents.find(
            (x) => x.transports.includes('structured') && x.available,
          );
          setAgent(structured?.id ?? 'claude');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not load this job.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };

    function hydrate(job: CronJob): void {
      setName(job.name);
      setCwd(job.cwd);
      setAgent(job.agent);
      setPrompt(job.prompt);
      setWorktreeMode(job.worktreeMode);
      setModel(job.model ?? '');
      setEffort(job.effort ?? '');
      setSkipPermissions(job.skipPermissionsEnabled);
      setOverlapPolicy(job.overlapPolicy);
      setEnabled(job.enabled);
      setTimeZone(job.timeZone);
      setCronExpr(job.cronExpr);
      setScheduleKind(job.schedule.kind);
      if (job.schedule.kind === 'preset') {
        const p = job.schedule.preset;
        setEvery(p.every);
        setMinute(p.minute);
        if (p.every !== 'hour') setHour(p.hour);
        if (p.every === 'week') setWeekdays(p.weekdays);
        if (p.every === 'month') setDayOfMonth(p.dayOfMonth);
      }
    }
  }, [isNew, jobId, onApiError]);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  /** The preset the picker currently describes. */
  const preset = useMemo((): CronSchedulePreset => {
    switch (every) {
      case 'hour':
        return { every: 'hour', minute };
      case 'day':
        return { every: 'day', hour, minute };
      case 'week':
        return { every: 'week', hour, minute, weekdays: weekdays.length > 0 ? weekdays : [1] };
      case 'month':
        return { every: 'month', hour, minute, dayOfMonth };
    }
  }, [every, hour, minute, weekdays, dayOfMonth]);

  /** What will actually be scheduled, whichever editor is showing. */
  const effectiveExpr = scheduleKind === 'preset' ? compileCronPreset(preset) : cronExpr;
  const exprError = scheduleKind === 'expression' ? cronErrorFor(cronExpr) : null;

  const preview = useMemo(() => {
    if (exprError !== null) return [];
    try {
      return nextRuns(effectiveExpr, Date.now(), timeZone, 3);
    } catch {
      return [];
    }
  }, [effectiveExpr, timeZone, exprError]);

  const structuredAgents = agents.filter((a) => a.transports.includes('structured'));
  const selectedAgent = agents.find((a) => a.id === agent) ?? null;

  const flatProjects = useMemo(() => flattenProjects(projects), [projects]);
  const dirOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const w of workspaces) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      out.push({ value: w.path, label: w.path });
    }
    for (const p of flatProjects) {
      if (seen.has(p.cwd) || p.cwd === 'virtual:shell') continue;
      seen.add(p.cwd);
      out.push({ value: p.cwd, label: p.workspaceLabel || p.name });
    }
    return out;
  }, [workspaces, flatProjects]);

  const save = async (): Promise<void> => {
    if (busy) return;
    if (name.trim() === '') {
      setError('Give the job a name.');
      return;
    }
    if (prompt.trim() === '') {
      setError('A job needs a prompt to send.');
      return;
    }
    if (exprError !== null) {
      setError(exprError);
      return;
    }
    setBusy(true);
    setError(null);

    // Exactly one of `preset`/`cronExpr` — the server refuses both.
    const schedule = scheduleKind === 'preset' ? { preset } : { cronExpr };

    try {
      if (isNew) {
        await api.createCronJob({
          name: name.trim(),
          enabled,
          cwd,
          agent,
          prompt,
          worktreeMode,
          overlapPolicy,
          skipPermissions,
          timeZone,
          // On create, an empty field is left absent so the agent's own cached
          // default applies — distinct from the explicit `null` a PATCH sends
          // to clear a value. See `CreateCronJobRequest.effort`.
          ...(model.trim() !== '' ? { model: model.trim() } : {}),
          ...(effort.trim() !== '' ? { effort: effort.trim() } : {}),
          ...schedule,
        });
      } else {
        await api.updateCronJob(jobId, {
          name: name.trim(),
          enabled,
          cwd,
          agent,
          prompt,
          worktreeMode,
          overlapPolicy,
          skipPermissions,
          timeZone,
          // Explicit `null` rather than omitted: an emptied field means
          // "clear it", and an omitted key would silently keep the old value.
          model: model.trim() === '' ? null : model.trim(),
          effort: effort.trim() === '' ? null : effort.trim(),
          ...schedule,
        });
      }
      onDone();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not save the job.');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.runCronJobNow(jobId);
      await loadRuns();
      if (run.sessionId) onOpenSession(run.sessionId);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not start the run.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.deleteCronJob(jobId);
      onDone();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not delete the job.');
      setBusy(false);
    }
  };

  const openRun = (run: CronJobRun): void => {
    // Prefer the session: `GET /api/sessions/:id/history` resolves for every
    // agent, live or finished. The conversation id is the fallback for when the
    // session row itself has been pruned, and only resolves for claude.
    if (run.sessionId) onOpenSession(run.sessionId);
    else if (run.agentSessionId) onOpenChat(run.agentSessionId);
  };

  const body = loading ? (
    <div className="settings-page">
      <div className="spinner">Loading…</div>
    </div>
  ) : (
    <div className="settings-page">
      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="settings-header">
        <div className="settings-header-icon">
          <Icon name="clock" size={26} />
        </div>
        <div className="settings-header-title">
          <h1>{isNew ? 'New scheduled job' : name || 'Scheduled job'}</h1>
          <p className="settings-header-sub">
            Runs a prompt in a project on a repeating schedule, unattended.
          </p>
        </div>
      </div>

      <SectionCard title="Job" icon="folder">
        <TextRow
          label="Name"
          value={name}
          busy={busy}
          placeholder="Nightly review"
          onChange={setName}
        />
        <SelectRowNative
          busy={busy}
          label="Project"
          value={cwd}
          options={dirOptions}
          onChange={setCwd}
        />
        <SelectRowNative
          busy={busy}
          label="Agent"
          value={agent}
          options={structuredAgents.map((a) => ({
            value: a.id,
            label: a.available ? a.displayName : `${a.displayName} (not installed)`,
          }))}
          onChange={setAgent}
        />
        <SelectRowNative
          busy={busy}
          label="Working copy"
          value={worktreeMode}
          options={[
            { value: 'none', label: 'The project directory — runs in place' },
            { value: 'new-branch', label: 'A fresh worktree per run — new branch each time' },
            {
              value: 'current-branch',
              label: 'A worktree off the current branch — new branch from its tip',
            },
          ]}
          help={
            worktreeMode !== 'none'
              ? 'Each run gets its own worktree under .worktrees/ in the project. These accumulate and are not cleaned up automatically — that is where the run’s work is.'
              : undefined
          }
          onChange={(v) => setWorktreeMode(v as CronWorktreeMode)}
        />
      </SectionCard>

      <SectionCard title="Prompt" icon="compose" desc="Sent to the agent the moment the run starts.">
        <TextRow
          label="Prompt"
          value={prompt}
          busy={busy}
          multiline
          rows={5}
          placeholder="Review the commits from yesterday and open issues for anything risky."
          onChange={setPrompt}
        />
      </SectionCard>

      <SectionCard title="Schedule" icon="clock">
        <SelectRowNative
          busy={busy}
          label="Schedule type"
          value={scheduleKind}
          options={[
            { value: 'preset', label: 'Simple' },
            { value: 'expression', label: 'Advanced — raw cron expression' },
          ]}
          onChange={(v) => {
            if (v === 'expression') {
              // Seed the raw field from the picker, so switching to Advanced
              // starts from what was already chosen rather than blank.
              setCronExpr(compileCronPreset(preset));
            }
            setScheduleKind(v as 'preset' | 'expression');
          }}
        />

        {scheduleKind === 'preset' ? (
          <>
            <SelectRowNative
              busy={busy}
              label="Runs"
              value={every}
              options={[
                { value: 'hour', label: 'Every hour' },
                { value: 'day', label: 'Every day' },
                { value: 'week', label: 'Every week' },
                { value: 'month', label: 'Every month' },
              ]}
              onChange={(v) => setEvery(v as Every)}
            />
            {every !== 'hour' && (
              <NumberRow label="Hour" value={hour} min={0} max={23} busy={busy} onChange={setHour} />
            )}
            <NumberRow label="Minute" value={minute} min={0} max={59} busy={busy} onChange={setMinute} />
            {every === 'month' && (
              <NumberRow
                label="Day of month"
                value={dayOfMonth}
                min={1}
                max={28}
                busy={busy}
                help="Capped at the 28th: a job set for the 29th–31st would silently skip February. Use Advanced if you really mean the last days of a month."
                onChange={setDayOfMonth}
              />
            )}
            {every === 'week' && (
              <div className="settings-row settings-row-stacked">
                <div className="settings-row-info">
                  <label className="settings-row-label">Days of the week</label>
                </div>
                <div className="cron-weekday-group" role="group" aria-label="Days of the week">
                  {WEEKDAY_LABELS.map((label, index) => (
                    <button
                      key={label}
                      type="button"
                      className={`cron-weekday${weekdays.includes(index) ? ' active' : ''}`}
                      aria-pressed={weekdays.includes(index)}
                      disabled={busy}
                      onClick={() =>
                        setWeekdays((prev) =>
                          prev.includes(index)
                            ? prev.filter((d) => d !== index)
                            : [...prev, index].sort((a, b) => a - b),
                        )
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <TextRow
            label="Cron expression"
            value={cronExpr}
            busy={busy}
            mono
            placeholder="*/15 9-17 * * 1-5"
            help="minute hour day-of-month month day-of-week"
            onChange={setCronExpr}
          />
        )}

        {exprError !== null && (
          <div className="error-box" role="alert">
            {exprError}
          </div>
        )}

        <TextRow
          label="Time zone"
          value={timeZone}
          busy={busy}
          help="An IANA name, e.g. America/New_York. Defaults to this server's own zone."
          onChange={setTimeZone}
        />

        <div className="settings-row">
          <div className="settings-row-info" style={{ width: '100%' }}>
            <label className="settings-row-label">Next runs</label>
            {preview.length === 0 ? (
              <p className="transport-hint" style={{ color: 'var(--danger)' }}>
                This schedule has no upcoming run.
              </p>
            ) : (
              <ul className="cron-next-runs">
                {preview.map((ts) => (
                  <li key={ts}>
                    {formatAbsolute(ts, timeZone)} <span>({formatCountdown(ts)})</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Model & effort" icon="code" desc="Free text — each agent has its own vocabulary.">
        <TextRow
          label="Model"
          value={model}
          busy={busy}
          placeholder={selectedAgent?.defaultModel ?? "the agent's default"}
          listId="cron-model-options"
          onChange={setModel}
        >
          <datalist id="cron-model-options">
            {(selectedAgent?.cachedModels ?? []).map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </TextRow>
        <TextRow
          label="Effort"
          value={effort}
          busy={busy}
          placeholder={selectedAgent?.defaultEffort ?? "the model's default"}
          onChange={setEffort}
        />
      </SectionCard>

      <SectionCard title="Approvals" icon="shield">
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-info">
              <label className="settings-row-label">Skip tool approvals</label>
              <p className="transport-hint">
                {skipPermissions
                  ? 'Nobody is watching at the scheduled time, so every tool call runs immediately, unattended.'
                  : 'Approvals go to the browser. Since nothing answers them at the scheduled time, a run that needs one waits — indefinitely — until you answer it, and you will get a notification.'}
              </p>
            </div>
            <div className="settings-row-control">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={skipPermissions}
                  disabled={busy}
                  onChange={(e) => setSkipPermissions(e.target.checked)}
                  aria-label="Skip tool approvals"
                />
                <span className="switch-track" />
              </label>
            </div>
          </div>
        </div>
        {skipPermissions && (
          <div className="warn-callout" role="alert">
            This job will run with every tool approval bypassed. It will edit files and run
            commands without asking.
          </div>
        )}
        <SelectRowNative
          busy={busy}
          label="If the previous run is still going"
          value={overlapPolicy}
          options={[
            { value: 'skip', label: 'Skip this run' },
            { value: 'allow', label: 'Start anyway' },
          ]}
          help={
            overlapPolicy === 'allow' && worktreeMode === 'none'
              ? 'Two runs will share one directory. That is fine for a read-only job, and a hazard for one that edits files.'
              : undefined
          }
          onChange={(v) => setOverlapPolicy(v as 'skip' | 'allow')}
        />
      </SectionCard>

      <div className="cron-save-bar">
        <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
          {isNew ? 'Create job' : 'Save changes'}
        </button>
        {!isNew && (
          <>
            <button type="button" disabled={busy} onClick={() => void runNow()}>
              <Icon name="play" size={16} />
              Run now
            </button>
            {confirmingDelete ? (
              <button
                type="button"
                className="danger primary-danger"
                disabled={busy}
                onClick={() => void remove()}
              >
                Really delete? Runs are kept.
              </button>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
                <Icon name="trash" size={16} />
                Delete
              </button>
            )}
          </>
        )}
      </div>

      {!isNew && (
        <SectionCard title="Run history" icon="terminal">
          {runs.length === 0 ? (
            <p className="transport-hint">No runs yet.</p>
          ) : (
            runs.map((run) => {
              const openable = run.sessionId !== null || run.agentSessionId !== null;
              return (
                <button
                  key={run.id}
                  type="button"
                  className="cron-run-row"
                  disabled={!openable}
                  onClick={() => openRun(run)}
                  title={openable ? 'Open this run’s transcript' : 'No transcript available'}
                >
                  <span className="cron-run-row-main">
                    <span className={`cron-status cron-status--${run.status}`}>{run.status}</span>
                    <span className="cron-run-when">
                      {formatRelative(run.startedAt)}
                      {run.trigger === 'manual' && ' · by hand'}
                    </span>
                  </span>
                  {run.error !== null && <span className="cron-run-error">{run.error}</span>}
                </button>
              );
            })
          )}
        </SectionCard>
      )}
    </div>
  );

  if (!onBack) return body;
  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <strong>{isNew ? 'New scheduled job' : name || 'Scheduled job'}</strong>
      </header>
      {body}
    </div>
  );
}
