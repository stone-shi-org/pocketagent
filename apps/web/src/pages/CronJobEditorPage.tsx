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
import { SelectorRow, type SelectorOption } from '../components/SelectorRow.js';
import { formatRelative } from '../components/StatusBadge.js';
import { formatAbsolute, formatCountdown, WEEKDAY_LABELS } from '../agent/cron-format.js';
import { flattenProjects } from '../agent/search.js';
import { agentIconName } from '../agent/agent-icon.js';

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
  const dirOptions: SelectorOption[] = useMemo(() => {
    const seen = new Set<string>();
    const out: SelectorOption[] = [];
    for (const w of workspaces) {
      if (seen.has(w.path)) continue;
      seen.add(w.path);
      out.push({ value: w.path, label: w.path.split('/').pop() ?? w.path, detail: w.path });
    }
    for (const p of flatProjects) {
      if (seen.has(p.cwd) || p.cwd === 'virtual:shell') continue;
      seen.add(p.cwd);
      out.push({ value: p.cwd, label: p.name, detail: p.workspaceLabel });
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
    const schedule =
      scheduleKind === 'preset' ? { preset } : { cronExpr };

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
    <div className="spinner">Loading…</div>
  ) : (
    <div className="cron-editor">
      <label className="cron-field">
        <span>Name</span>
        <input
          className="settings-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nightly review"
          maxLength={128}
        />
      </label>

      <div className="selector-stack">
        <SelectorRow
          icon="folder"
          label="Project"
          value={cwd}
          options={dirOptions}
          onChange={setCwd}
          ariaLabel="Project directory"
        />
        <SelectorRow
          icon={agentIconName(agent)}
          label="Agent"
          value={agent}
          options={structuredAgents.map((a) => ({
            value: a.id,
            label: a.displayName,
            detail: a.available ? undefined : 'not installed',
          }))}
          onChange={setAgent}
          ariaLabel="Agent"
        />
        <SelectorRow
          icon="branch"
          label="Working copy"
          value={worktreeMode}
          options={[
            { value: 'none', label: 'The project directory', detail: 'Runs in place' },
            {
              value: 'new-branch',
              label: 'A fresh worktree per run',
              detail: 'New branch each time',
            },
            {
              value: 'current-branch',
              label: 'A worktree off the current branch',
              detail: 'New branch from its tip',
            },
          ]}
          onChange={(v) => setWorktreeMode(v as CronWorktreeMode)}
          ariaLabel="Working copy"
        />
      </div>

      {worktreeMode !== 'none' && (
        <p className="cron-note">
          Each run gets its own worktree under <code>.worktrees/</code>, and they are not
          cleaned up automatically — that is where the run's work is.
        </p>
      )}

      {/* ---- Schedule ---- */}
      <div className="cron-section">
        <div className="cron-section-head">
          <h3>Schedule</h3>
          <div className="cron-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={scheduleKind === 'preset'}
              className={scheduleKind === 'preset' ? 'active' : ''}
              onClick={() => setScheduleKind('preset')}
            >
              Simple
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scheduleKind === 'expression'}
              className={scheduleKind === 'expression' ? 'active' : ''}
              onClick={() => {
                // Seed the raw field from the picker, so switching to Advanced
                // starts from what was already chosen rather than blank.
                setCronExpr(compileCronPreset(preset));
                setScheduleKind('expression');
              }}
            >
              Advanced
            </button>
          </div>
        </div>

        {scheduleKind === 'preset' ? (
          <div className="cron-preset">
            <div className="cron-chips" role="radiogroup" aria-label="How often">
              {(['hour', 'day', 'week', 'month'] as Every[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={every === option}
                  className={every === option ? 'chip active' : 'chip'}
                  onClick={() => setEvery(option)}
                >
                  {option === 'hour'
                    ? 'Hourly'
                    : option === 'day'
                      ? 'Daily'
                      : option === 'week'
                        ? 'Weekly'
                        : 'Monthly'}
                </button>
              ))}
            </div>

            <div className="cron-time">
              {every !== 'hour' && (
                <label className="cron-field inline">
                  <span>Hour</span>
                  <input
                    className="settings-input"
                    type="number"
                    min={0}
                    max={23}
                    value={hour}
                    onChange={(e) => setHour(clamp(Number(e.target.value), 0, 23))}
                  />
                </label>
              )}
              <label className="cron-field inline">
                <span>Minute</span>
                <input
                  className="settings-input"
                  type="number"
                  min={0}
                  max={59}
                  value={minute}
                  onChange={(e) => setMinute(clamp(Number(e.target.value), 0, 59))}
                />
              </label>
              {every === 'month' && (
                <label className="cron-field inline">
                  <span>Day of month</span>
                  <input
                    className="settings-input"
                    type="number"
                    min={1}
                    max={28}
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(clamp(Number(e.target.value), 1, 28))}
                  />
                </label>
              )}
            </div>

            {every === 'month' && (
              <p className="cron-note">
                Capped at the 28th: a job set for the 29th–31st would silently skip February.
                Use Advanced if you really mean the last days of a month.
              </p>
            )}

            {every === 'week' && (
              <div className="cron-chips" role="group" aria-label="Days of the week">
                {WEEKDAY_LABELS.map((label, index) => (
                  <button
                    key={label}
                    type="button"
                    aria-pressed={weekdays.includes(index)}
                    className={weekdays.includes(index) ? 'chip active' : 'chip'}
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
            )}
          </div>
        ) : (
          <label className="cron-field">
            <span>Cron expression</span>
            <input
              className="settings-input mono"
              value={cronExpr}
              onChange={(e) => setCronExpr(e.target.value)}
              placeholder="*/15 9-17 * * 1-5"
              spellCheck={false}
              autoCapitalize="off"
            />
            <small>minute hour day-of-month month day-of-week</small>
          </label>
        )}

        {exprError !== null && (
          <div className="error-box" role="alert">
            {exprError}
          </div>
        )}

        <label className="cron-field">
          <span>Time zone</span>
          <input
            className="settings-input"
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            spellCheck={false}
          />
        </label>

        <div className="cron-preview">
          <strong>Next runs</strong>
          {preview.length === 0 ? (
            <span className="cron-preview-empty">
              This schedule has no upcoming run.
            </span>
          ) : (
            <ul>
              {preview.map((ts) => (
                <li key={ts}>
                  {formatAbsolute(ts, timeZone)} <span>({formatCountdown(ts)})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* ---- Prompt ---- */}
      <label className="cron-field">
        <span>Prompt</span>
        <textarea
          className="settings-input cron-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          placeholder="Review the commits from yesterday and open issues for anything risky."
        />
      </label>

      {/* ---- Model / effort: free text, because each CLI has its own vocabulary ---- */}
      <div className="cron-row-2">
        <label className="cron-field">
          <span>Model</span>
          <input
            className="settings-input"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={selectedAgent?.defaultModel ?? 'the agent’s default'}
            list="cron-model-options"
          />
          <datalist id="cron-model-options">
            {(selectedAgent?.cachedModels ?? []).map((m) => (
              <option key={m.value} value={m.value}>
                {m.displayName}
              </option>
            ))}
          </datalist>
        </label>
        <label className="cron-field">
          <span>Effort</span>
          <input
            className="settings-input"
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            placeholder={selectedAgent?.defaultEffort ?? 'the model’s default'}
          />
        </label>
      </div>

      {/* ---- Approvals ---- */}
      <div className="cron-section">
        <h3>Approvals</h3>
        <label className="settings-row">
          <span className="settings-row-label">Skip tool approvals</span>
          <span className="settings-row-control">
            <span className="switch">
              <input
                type="checkbox"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
                aria-label="Skip tool approvals"
              />
              <span className="switch-track" />
            </span>
          </span>
        </label>
        {skipPermissions ? (
          <div className="warn-callout">
            This job will run with every tool approval bypassed. Nobody is watching at the
            scheduled time, so it will edit files and run commands without asking.
          </div>
        ) : (
          <p className="cron-note">
            Approvals go to the browser. Since nothing answers them at the scheduled time, a run
            that needs one will wait — indefinitely — until you answer it. You will get a
            notification.
          </p>
        )}
        <label className="settings-row">
          <span className="settings-row-label">If the previous run is still going</span>
          <span className="settings-row-control">
            <select
              className="settings-select"
              value={overlapPolicy}
              onChange={(e) => setOverlapPolicy(e.target.value as 'skip' | 'allow')}
            >
              <option value="skip">Skip this run</option>
              <option value="allow">Start anyway</option>
            </select>
          </span>
        </label>
        {overlapPolicy === 'allow' && worktreeMode === 'none' && (
          <p className="cron-note">
            Two runs will share one directory. That is fine for a read-only job, and a hazard
            for one that edits files.
          </p>
        )}
      </div>

      {error !== null && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      <div className="cron-save-bar">
        <button type="button" className="cron-save" disabled={busy} onClick={() => void save()}>
          {isNew ? 'Create job' : 'Save changes'}
        </button>
        {!isNew && (
          <>
            <button type="button" className="cron-secondary" disabled={busy} onClick={() => void runNow()}>
              <Icon name="play" size={16} />
              Run now
            </button>
            {confirmingDelete ? (
              <button type="button" className="cron-danger" disabled={busy} onClick={() => void remove()}>
                Really delete? Runs are kept.
              </button>
            ) : (
              <button
                type="button"
                className="cron-secondary danger"
                onClick={() => setConfirmingDelete(true)}
              >
                <Icon name="trash" size={16} />
                Delete
              </button>
            )}
          </>
        )}
      </div>

      {/* ---- Run history ---- */}
      {!isNew && (
        <div className="cron-section">
          <h3>Run history</h3>
          {runs.length === 0 ? (
            <p className="cron-note">No runs yet.</p>
          ) : (
            <div className="cron-runs">
              {runs.map((run) => {
                const openable = run.sessionId !== null || run.agentSessionId !== null;
                return (
                  <div key={run.id} className="cron-run">
                    <button
                      type="button"
                      className="cron-run-main"
                      disabled={!openable}
                      onClick={() => openRun(run)}
                      title={openable ? 'Open this run’s transcript' : 'No transcript available'}
                    >
                      <span className={`cron-status cron-status--${run.status}`}>{run.status}</span>
                      <span className="cron-run-when">
                        {formatRelative(run.startedAt)}
                        {run.trigger === 'manual' && ' · by hand'}
                      </span>
                      {run.error !== null && <span className="cron-run-error">{run.error}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
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

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(value)));
}
