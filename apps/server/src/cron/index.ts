import crypto from 'node:crypto';
import type {
  CronJob,
  CronJobRun,
  CronJobSummary,
  CronRunStatus,
  CronSchedulePreset,
} from '@pocketagent/protocol';
import { CronError, compileCronPreset, nextRunAt, serverTimeZone } from '@pocketagent/protocol';
import type { CronJobRow, CronRunRow, Db } from '../db/index.js';
import {
  deleteCronJob,
  deleteCronRunsForJob,
  insertCronJob,
  insertCronRun,
  markStaleCronRunsFailed,
  pruneOldCronRuns,
  readActiveCronRuns,
  readCronJob,
  readCronJobs,
  readCronRun,
  readCronRuns,
  readDueCronJobs,
  updateCronJob,
  updateCronRun,
} from '../db/index.js';
import type { SessionManager } from '../sessions/manager.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { WorktreeService } from '../git/worktree.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { RunSink, RunSpec } from '../runs/executor.js';
import { RunExecutor, mintBranchName } from '../runs/executor.js';

/**
 * How often to look for due jobs.
 *
 * Not 60s: with a minute-long tick phased to boot time, a job set for :00 is
 * systematically up to a minute late. Not 15s (matching `SWEEP_INTERVAL_MS`):
 * cron's finest granularity is a minute, so a faster tick buys nothing while
 * each tick may spawn an agent. 30s bounds lateness at 30s and divides a
 * minute, so the phase error does not wander.
 */
const TICK_INTERVAL_MS = 30_000;

/**
 * How late a due firing may be and still run.
 *
 * This is the whole catch-up policy, and it exists to discriminate a blip from
 * an outage. A `systemctl restart` at 08:59:58 must not lose the 09:00 daily
 * run; a week offline must not detonate into 168 hourly runs at boot. Anything
 * later than this is coalesced into a single `skipped` row and the schedule
 * rolls forward from now.
 */
const CATCH_UP_GRACE_MS = 60 * 60_000;

/** Run rows kept per job. Per-job so a frequent job cannot evict a rare one's history. */
const KEEP_RUNS_PER_JOB = 50;

export class CronServiceError extends Error {
  override readonly name = 'CronServiceError';
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'run_in_progress'
      | 'invalid_schedule'
      | 'unsatisfiable_schedule'
      | 'unknown_agent'
      | 'unsupported_transport'
      | 'unknown_time_zone',
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface CronServiceOptions {
  db: Db;
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  worktrees: WorktreeService;
  agents: AgentRegistry;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  /** Injectable for tests, so schedule behaviour is checkable without waiting. */
  now?: () => number;
}

/** The fields a create/update accepts, already normalized by the route. */
export interface CronJobSpec {
  name: string;
  enabled: boolean;
  schedule: { kind: 'preset'; preset: CronSchedulePreset } | { kind: 'expression'; cronExpr: string };
  timeZone: string;
  cwd: string;
  agent: string;
  worktreeMode: 'none' | 'new-branch' | 'current-branch';
  model: string | null;
  /** Absent means "use the agent's cached default"; present-and-null means "the model's own default". */
  effort?: string | null;
  skipPermissions: boolean;
  prompt: string;
  overlapPolicy: 'skip' | 'allow';
}

/**
 * Runs saved jobs on a schedule.
 *
 * Modelled on `SessionManager`'s sweep timer rather than on a chain of
 * `setTimeout(nextRunAt - now)`: a single long timer is exactly what a laptop
 * suspend or an NTP step breaks silently, and Node makes no promises about
 * very long timers across a suspend. A fixed poll comparing against the clock
 * recovers from both for free — a forward clock jump is indistinguishable from
 * the server having been down, which is why there is one catch-up policy here
 * and not two.
 */
export class CronService {
  private timer: NodeJS.Timeout | null = null;
  private readonly db: Db;
  /** Guards against a slow tick overlapping the next one. */
  private ticking = false;
  /**
   * The shared worktree → session → prompt composite.
   *
   * Constructed here rather than injected, because the only state it holds is
   * its own set of in-flight watchers and `abandonAll()` must not settle
   * another service's runs. One executor per service is the correct
   * granularity, not one per process.
   */
  private readonly executor: RunExecutor;

  constructor(private readonly opts: CronServiceOptions) {
    this.db = opts.db;
    this.executor = new RunExecutor({
      sessions: opts.sessions,
      workspaces: opts.workspaces,
      worktrees: opts.worktrees,
      label: 'cron run',
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Reconcile against reality, then start ticking.
   *
   * Must run *after* `SessionManager.init()`: this reconciles run rows against
   * an already-reconciled session table, and its first tick can create a
   * session.
   */
  async init(): Promise<void> {
    const failed = markStaleCronRunsFailed(this.db, this.now());
    if (failed > 0) {
      this.opts.logger?.info({ failed }, 'closed out cron runs left open by a previous server');
    }

    // The expression's meaning did not change while we were down, but the
    // clock moved a lot. Re-solve every enabled job and apply the catch-up
    // policy before the first tick can fire anything.
    for (const job of readCronJobs(this.db)) {
      if (job.enabled !== 1) continue;
      this.applyCatchUpPolicy(job);
    }

    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();

    // Fire immediately rather than idling up to a tick: a server booting at
    // 09:00:05 with a 09:00 job should not wait until 09:00:35.
    await this.tick();
  }

  /**
   * Stop scheduling and close out anything in flight.
   *
   * Called *before* `SessionManager.shutdown()` so no new run can be started
   * into a manager that is tearing down. In-flight runs are failed with the
   * real reason here, because we know it now; `markStaleCronRunsFailed` at the
   * next boot stays as the crash path only.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.executor.abandonAll('The server shut down while this run was in progress.');
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /**
   * Solve the next firing for a job, or `null` if it can never fire again.
   *
   * Throws `CronServiceError` for a schedule that cannot even be parsed, which
   * only happens for a row written before a validation gap was closed — the
   * routes reject bad input long before it reaches here.
   */
  private solve(job: Pick<CronJobRow, 'cron_expr' | 'time_zone'>, from: number): number | null {
    try {
      return nextRunAt(job.cron_expr, from, job.time_zone);
    } catch (err) {
      if (err instanceof CronError) {
        throw new CronServiceError(err.message, 'invalid_schedule');
      }
      throw err;
    }
  }

  /**
   * Decide what to do about a job whose `next_run_at` is already in the past.
   *
   * Deliberately coalescing: recording every dropped occurrence would just
   * move the storm from processes into rows, and make the run list useless at
   * exactly the moment someone wants to read it.
   */
  private applyCatchUpPolicy(job: CronJobRow): void {
    const now = this.now();

    if (job.next_run_at === null) {
      // Never scheduled, or previously unsatisfiable. Try again from now.
      this.writeNextRun(job, now);
      return;
    }
    if (job.next_run_at > now) return;

    const lateBy = now - job.next_run_at;
    if (lateBy <= CATCH_UP_GRACE_MS) return; // The next tick fires it, once.

    const missedFrom = new Date(job.next_run_at).toISOString();
    const message =
      `Missed scheduled runs between ${missedFrom} and now while the server was not running; ` +
      `skipped rather than running them all at once.`;
    this.recordSkippedRun(job, job.next_run_at, message);
    this.writeNextRun(job, now, { lastError: message });
  }

  private writeNextRun(
    job: Pick<CronJobRow, 'id' | 'cron_expr' | 'time_zone'>,
    from: number,
    extra?: { lastError?: string | null },
  ): void {
    let next: number | null = null;
    let error: string | null | undefined = extra?.lastError;
    try {
      next = this.solve(job, from);
      if (next === null && error === undefined) {
        error = 'This schedule has no future run.';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    updateCronJob(this.db, job.id, {
      next_run_at: next,
      ...(error !== undefined ? { last_error: error } : {}),
    });
  }

  /** Recompute a job's schedule after it was created, edited, or re-enabled. */
  jobChanged(id: string): void {
    const job = readCronJob(this.db, id);
    if (job === null) return;
    if (job.enabled !== 1) {
      updateCronJob(this.db, id, { next_run_at: null });
      return;
    }
    this.writeNextRun(job, this.now(), { lastError: null });
  }

  // -------------------------------------------------------------------------
  // The tick
  // -------------------------------------------------------------------------

  /**
   * One scheduling pass. Public so tests can drive it deterministically
   * instead of waiting 30 seconds.
   *
   * Never throws: a broken job must not starve the others, and an exception
   * out of a `setInterval` callback is an unhandled rejection.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.reconcileActiveRuns();

      const now = this.now();
      for (const job of readDueCronJobs(this.db, now)) {
        try {
          await this.fire(job, job.next_run_at ?? now);
        } catch (err) {
          this.opts.logger?.warn({ jobId: job.id, err }, 'cron job failed to fire');
          // Never leave a due job due: it would be retried every 30 seconds
          // forever.
          this.writeNextRun(job, this.now(), {
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      }

      pruneOldCronRuns(this.db, KEEP_RUNS_PER_JOB);
    } catch (err) {
      this.opts.logger?.warn({ err }, 'cron tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Close out runs whose session is gone.
   *
   * This is what removes the need for a "stale run" timeout. The obvious way
   * to stop a wedged run from blocking a `skip` job forever is to force-fail it
   * after N minutes, but that would kill a legitimately long agent turn — and
   * a run parked on an unanswered approval is *genuinely still running*, so
   * force-failing it is the same disrespect for an undecided decision that the
   * no-timeout-on-approvals invariant exists to prevent. Asking whether the
   * session is still alive answers the real question instead.
   */
  private reconcileActiveRuns(): void {
    for (const run of readActiveCronRuns(this.db)) {
      if (run.session_id === null) continue;
      if (this.executor.isAlive(run.session_id)) continue;
      updateCronRun(this.db, run.id, {
        status: 'failed',
        error: run.error ?? 'The session ended before the run completed.',
        finished_at: this.now(),
      });
      if (run.job_id !== null) {
        updateCronJob(this.db, run.job_id, { last_run_status: 'failed' });
      }
    }
  }

  private hasActiveRun(jobId: string): boolean {
    return readActiveCronRuns(this.db, jobId).some(
      // A null session id means still mid-composite, which counts as active:
      // nothing may escape `startRun` with the row open, so this is a run that
      // has not finished resolving a directory or creating a session yet.
      (run) => run.session_id === null || this.executor.isAlive(run.session_id),
    );
  }

  private async fire(job: CronJobRow, scheduledFor: number): Promise<void> {
    if (job.overlap_policy === 'skip' && this.hasActiveRun(job.id)) {
      this.recordSkippedRun(job, scheduledFor, 'The previous run was still in progress.');
      this.writeNextRun(job, this.now());
      return;
    }
    await this.startRun(job, scheduledFor, 'schedule');
    this.writeNextRun(job, this.now());
  }

  // -------------------------------------------------------------------------
  // Running a job
  // -------------------------------------------------------------------------

  /**
   * Record a run, then hand it to the shared executor.
   *
   * The run row is inserted *first*, so nothing can happen unrecorded, and the
   * sink below is the only thing that writes to it afterwards. Every failure
   * closes that row out rather than throwing, because a background job has
   * nobody to show an exception to — the run list is the only place a failure
   * can surface. `RunExecutor.start` guarantees exactly one `onSettled`, so
   * this method never has to reason about whether a row is still open.
   */
  private async startRun(
    job: CronJobRow,
    scheduledFor: number,
    trigger: 'schedule' | 'manual',
  ): Promise<CronRunRow> {
    const runId = crypto.randomUUID();
    const startedAt = this.now();

    insertCronRun(this.db, {
      id: runId,
      job_id: job.id,
      job_name: job.name,
      agent: job.agent,
      status: 'starting',
      trigger,
      scheduled_for: scheduledFor,
      started_at: startedAt,
      finished_at: null,
      session_id: null,
      agent_session_id: null,
      cwd: null,
      error: null,
    });

    const sink: RunSink = {
      onCwd: (cwd) => {
        updateCronRun(this.db, runId, { cwd });
      },
      onSessionStarted: (sessionId) => {
        updateCronRun(this.db, runId, { status: 'running', session_id: sessionId });
        updateCronJob(this.db, job.id, {
          last_run_at: startedAt,
          last_run_status: 'running',
          last_error: null,
        });
      },
      onAgentSessionId: (agentSessionId) => {
        updateCronRun(this.db, runId, { agent_session_id: agentSessionId });
      },
      onSettled: (status, error) => {
        updateCronRun(this.db, runId, { status, error, finished_at: this.now() });
        // `last_run_at` is set here as well as in `onSessionStarted` because a
        // failure before the session existed never reached that callback, and a
        // job that failed at 09:00 still ran at 09:00. After a successful start
        // this rewrites the same value.
        updateCronJob(this.db, job.id, {
          last_run_at: startedAt,
          last_run_status: status,
          last_error: error,
        });
      },
    };

    await this.executor.start(runId, this.specFor(job, scheduledFor), sink);
    return readCronRun(this.db, runId) as CronRunRow;
  }

  /** A job row as the executor wants it. */
  private specFor(job: CronJobRow, scheduledFor: number): RunSpec {
    const worktree: RunSpec['worktree'] =
      job.worktree_mode === 'new-branch'
        ? {
            mode: 'new-branch',
            // Minted per run, never stored: `new` with a fixed name succeeds
            // exactly once and then throws `branch_exists` forever.
            branchName: mintBranchName(job.name, job.time_zone, scheduledFor, 'cron'),
          }
        : job.worktree_mode === 'current-branch'
          ? { mode: 'current-branch' }
          : { mode: 'none' };

    return {
      cwd: job.cwd,
      agent: job.agent,
      title: job.name,
      prompt: job.prompt,
      skipPermissions: job.skip_permissions === 1,
      model: job.model,
      // `effort_set` distinguishes "omitted" from "explicitly null"; only pass
      // the key at all when it was set.
      ...(job.effort_set === 1 ? { effort: job.effort } : {}),
      worktree,
      notStructuredMessage:
        'A scheduled job needs a structured session, but a terminal one was created.',
    };
  }

  private recordSkippedRun(job: CronJobRow, scheduledFor: number, reason: string): void {
    const now = this.now();
    insertCronRun(this.db, {
      id: crypto.randomUUID(),
      job_id: job.id,
      job_name: job.name,
      agent: job.agent,
      status: 'skipped',
      trigger: 'schedule',
      scheduled_for: scheduledFor,
      started_at: now,
      finished_at: now,
      session_id: null,
      agent_session_id: null,
      cwd: null,
      error: reason,
    });
    updateCronJob(this.db, job.id, { last_run_status: 'skipped', last_error: reason });
  }

  // -------------------------------------------------------------------------
  // Public API used by the routes
  // -------------------------------------------------------------------------

  create(spec: CronJobSpec): CronJobRow {
    const now = this.now();
    const cronExpr =
      spec.schedule.kind === 'preset' ? compileCronPreset(spec.schedule.preset) : spec.schedule.cronExpr;

    const id = crypto.randomUUID();
    const row: CronJobRow = {
      id,
      name: spec.name,
      enabled: spec.enabled ? 1 : 0,
      cron_expr: cronExpr,
      time_zone: spec.timeZone,
      schedule_kind: spec.schedule.kind,
      preset_json: spec.schedule.kind === 'preset' ? JSON.stringify(spec.schedule.preset) : null,
      cwd: spec.cwd,
      agent: spec.agent,
      worktree_mode: spec.worktreeMode,
      model: spec.model,
      effort: spec.effort ?? null,
      effort_set: 'effort' in spec && spec.effort !== undefined ? 1 : 0,
      skip_permissions: spec.skipPermissions ? 1 : 0,
      prompt: spec.prompt,
      overlap_policy: spec.overlapPolicy,
      created_at: now,
      updated_at: now,
      next_run_at: null,
      last_run_at: null,
      last_run_status: null,
      last_error: null,
    };
    insertCronJob(this.db, row);
    this.jobChanged(id);
    return readCronJob(this.db, id) as CronJobRow;
  }

  update(id: string, patch: Partial<CronJobSpec>): CronJobRow {
    const existing = readCronJob(this.db, id);
    if (existing === null) throw new CronServiceError('No such scheduled job.', 'not_found', 404);

    const row: Partial<CronJobRow> = { updated_at: this.now() };
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.enabled !== undefined) row.enabled = patch.enabled ? 1 : 0;
    if (patch.cwd !== undefined) row.cwd = patch.cwd;
    if (patch.agent !== undefined) row.agent = patch.agent;
    if (patch.worktreeMode !== undefined) row.worktree_mode = patch.worktreeMode;
    if (patch.model !== undefined) row.model = patch.model;
    if ('effort' in patch) {
      row.effort = patch.effort ?? null;
      row.effort_set = patch.effort === undefined ? 0 : 1;
    }
    if (patch.skipPermissions !== undefined) row.skip_permissions = patch.skipPermissions ? 1 : 0;
    if (patch.prompt !== undefined) row.prompt = patch.prompt;
    if (patch.overlapPolicy !== undefined) row.overlap_policy = patch.overlapPolicy;
    if (patch.timeZone !== undefined) row.time_zone = patch.timeZone;
    if (patch.schedule !== undefined) {
      row.schedule_kind = patch.schedule.kind;
      if (patch.schedule.kind === 'preset') {
        row.cron_expr = compileCronPreset(patch.schedule.preset);
        row.preset_json = JSON.stringify(patch.schedule.preset);
      } else {
        row.cron_expr = patch.schedule.cronExpr;
        // Switching to a hand-edited expression genuinely stops being "hourly
        // at :15", so the picker descriptor is dropped rather than kept stale.
        row.preset_json = null;
      }
    }

    updateCronJob(this.db, id, row);
    this.jobChanged(id);
    return readCronJob(this.db, id) as CronJobRow;
  }

  /** Deleting a job never deletes its history — see the migration comment. */
  remove(id: string): { runsKept: number } {
    const runs = readCronRuns(this.db, { jobId: id, limit: Number.MAX_SAFE_INTEGER });
    if (!deleteCronJob(this.db, id)) {
      throw new CronServiceError('No such scheduled job.', 'not_found', 404);
    }
    return { runsKept: runs.length };
  }

  clearRuns(id: string): number {
    return deleteCronRunsForJob(this.db, id);
  }

  /**
   * Fire a job right now, by hand.
   *
   * Respects the overlap policy but reports it as an error rather than writing
   * a silent `skipped` row: somebody pressed a button and deserves an answer,
   * not a shrug.
   */
  async runNow(id: string): Promise<CronRunRow> {
    const job = readCronJob(this.db, id);
    if (job === null) throw new CronServiceError('No such scheduled job.', 'not_found', 404);
    if (job.overlap_policy === 'skip' && this.hasActiveRun(job.id)) {
      throw new CronServiceError(
        'This job already has a run in progress.',
        'run_in_progress',
        409,
      );
    }
    return this.startRun(job, this.now(), 'manual');
  }

  list(): CronJobRow[] {
    return readCronJobs(this.db);
  }

  get(id: string): CronJobRow | null {
    return readCronJob(this.db, id);
  }

  runs(opts: { jobId?: string; limit: number }): CronRunRow[] {
    return readCronRuns(this.db, opts);
  }

  // -------------------------------------------------------------------------
  // DTO mapping
  // -------------------------------------------------------------------------

  toJob(row: CronJobRow): CronJob {
    const adapter = this.opts.agents.get(row.agent);
    const preset = parsePreset(row.preset_json);
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      cronExpr: row.cron_expr,
      timeZone: row.time_zone,
      schedule:
        row.schedule_kind === 'preset' && preset !== null
          ? { kind: 'preset', preset }
          : { kind: 'expression' },
      cwd: row.cwd,
      workspaceLabel: this.opts.workspaces.labelFor(row.cwd),
      agent: row.agent,
      agentDisplayName: adapter?.displayName ?? row.agent,
      worktreeMode: row.worktree_mode as CronJob['worktreeMode'],
      model: row.model,
      ...(row.effort_set === 1 ? { effort: row.effort } : {}),
      skipPermissionsEnabled: row.skip_permissions === 1,
      prompt: row.prompt,
      overlapPolicy: row.overlap_policy as CronJob['overlapPolicy'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastError: row.last_error,
      lastRunStatus: (row.last_run_status as CronRunStatus | null) ?? null,
    };
  }

  toRun(row: CronRunRow): CronJobRun {
    return {
      id: row.id,
      jobId: row.job_id,
      jobName: row.job_name,
      agent: row.agent,
      status: row.status as CronRunStatus,
      trigger: row.trigger as CronJobRun['trigger'],
      scheduledFor: row.scheduled_for,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      sessionId: row.session_id,
      agentSessionId: row.agent_session_id,
      cwd: row.cwd,
      error: row.error,
    };
  }

  /** Job summaries grouped by directory, for the home screen's project tree. */
  summariesByCwd(): Map<string, CronJobSummary[]> {
    const out = new Map<string, CronJobSummary[]>();
    for (const row of readCronJobs(this.db)) {
      const list = out.get(row.cwd) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        cronExpr: row.cron_expr,
        timeZone: row.time_zone,
        nextRunAt: row.next_run_at,
        lastRunStatus: (row.last_run_status as CronRunStatus | null) ?? null,
        skipPermissionsEnabled: row.skip_permissions === 1,
      });
      out.set(row.cwd, list);
    }
    return out;
  }
}

function parsePreset(json: string | null): CronSchedulePreset | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as CronSchedulePreset;
  } catch {
    return null;
  }
}

export { serverTimeZone };
