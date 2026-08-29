import { z } from 'zod';
import { EffortLevel } from './agent-events.js';
import { LIMITS } from './limits.js';
import { isValidCron } from './cron-expr.js';

const Minute = z.number().int().min(0).max(59);
const Hour = z.number().int().min(0).max(23);

/**
 * The structured half of the schedule picker.
 *
 * `dayOfMonth` stops at 28 rather than 31 on purpose: a monthly preset on the
 * 29th–31st silently never fires in February (and the 31st skips four more
 * months). The picker must not be able to build a schedule that quietly
 * misses. Anyone who genuinely means "the 31st" types it into the raw
 * expression field, where the next-runs preview makes the gaps visible.
 */
export const CronSchedulePreset = z.discriminatedUnion('every', [
  z.object({ every: z.literal('hour'), minute: Minute }),
  z.object({ every: z.literal('day'), minute: Minute, hour: Hour }),
  z.object({
    every: z.literal('week'),
    minute: Minute,
    hour: Hour,
    /** Cron's own numbering: 0 = Sunday. */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  }),
  z.object({
    every: z.literal('month'),
    minute: Minute,
    hour: Hour,
    dayOfMonth: z.number().int().min(1).max(28),
  }),
]);
export type CronSchedulePreset = z.infer<typeof CronSchedulePreset>;

/** Compile a preset to the canonical 5-field expression. Deliberately one-way. */
export function compileCronPreset(preset: CronSchedulePreset): string {
  switch (preset.every) {
    case 'hour':
      return `${preset.minute} * * * *`;
    case 'day':
      return `${preset.minute} ${preset.hour} * * *`;
    case 'week':
      return `${preset.minute} ${preset.hour} * * ${[...preset.weekdays]
        .sort((a, b) => a - b)
        .join(',')}`;
    case 'month':
      return `${preset.minute} ${preset.hour} ${preset.dayOfMonth} * *`;
  }
}

/**
 * Where a run's working directory comes from.
 *
 * `new-branch` mints a fresh worktree per run so a nightly job cannot trip
 * over its own uncommitted changes from last night. `none` runs in the job's
 * directory as-is, which is what a read-only job wants.
 */
export const CronWorktreeMode = z.enum(['none', 'new-branch', 'current-branch']);
export type CronWorktreeMode = z.infer<typeof CronWorktreeMode>;

/**
 * Deliberately not `SessionStatus`: a *run* is one prompt and one turn, which
 * is a shorter and differently-shaped life than the session hosting it. A run
 * can be `succeeded` while its session is still alive and being chatted to.
 *
 * `skipped` means "never started, on purpose" — the overlap policy refused, or
 * a stretch of occurrences missed while the server was down was coalesced away.
 */
export const CronRunStatus = z.enum(['starting', 'running', 'succeeded', 'failed', 'skipped']);
export type CronRunStatus = z.infer<typeof CronRunStatus>;

export const CronRunTrigger = z.enum(['schedule', 'manual']);
export type CronRunTrigger = z.infer<typeof CronRunTrigger>;

/**
 * What to do when a job comes due while its previous run is still going.
 *
 * `skip` is the default because two agents editing one worktree concurrently
 * is a live hazard, and because a run parked on an unanswered approval never
 * finishes — `allow` on such a job would pile up sessions until `maxSessions`.
 * `allow` is only really sane together with a per-run worktree; the editor
 * warns rather than refusing, since two read-only runs in one directory is a
 * legitimate thing to want.
 */
export const CronOverlapPolicy = z.enum(['skip', 'allow']);
export type CronOverlapPolicy = z.infer<typeof CronOverlapPolicy>;

/**
 * A saved job spec plus the scheduler's own bookkeeping.
 *
 * `cronExpr` is authoritative — it is the only thing the scheduler reads.
 * `schedule` says which editor round-trips it: `preset` re-opens the picker it
 * was built with, `expression` opens the raw text field. The two cannot
 * disagree, because the server recompiles `cronExpr` from a supplied preset on
 * every write.
 *
 * `workspaceLabel` and `agentDisplayName` are composed server-side the way
 * `SessionInfo` composes them, so a list row needs no second lookup.
 * `skipPermissionsEnabled` shares its name with
 * `SessionInfo.skipPermissionsEnabled` deliberately: same meaning, and the
 * same "must say so persistently in the UI" rule applies.
 */
export const CronJob = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  cronExpr: z.string(),
  /** IANA zone name. Never a UTC offset — an offset does not survive DST. */
  timeZone: z.string(),
  schedule: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('preset'), preset: CronSchedulePreset }),
    z.object({ kind: z.literal('expression') }),
  ]),
  cwd: z.string(),
  workspaceLabel: z.string(),
  agent: z.string(),
  agentDisplayName: z.string(),
  worktreeMode: CronWorktreeMode,
  model: z.string().nullable(),
  /**
   * Absent means "whatever was cached for this agent"; explicit `null` means
   * "the model's own default". The same tri-state as
   * `CreateSessionRequest.effort` — a read DTO has to expose all three or a
   * PATCH cannot round-trip what it read.
   */
  effort: EffortLevel.nullable().optional(),
  skipPermissionsEnabled: z.boolean(),
  prompt: z.string(),
  overlapPolicy: CronOverlapPolicy,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Null when disabled, or when the schedule has no next occurrence at all. */
  nextRunAt: z.number().int().nullable(),
  lastRunAt: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** Denormalized so the list view needs no per-job runs query. */
  lastRunStatus: CronRunStatus.nullable(),
});
export type CronJob = z.infer<typeof CronJob>;

/**
 * One firing.
 *
 * `jobId` goes null once the job is deleted — history outlives the spec — which
 * is why `jobName` and `agent` are copied here rather than joined. Renaming a
 * job therefore does not rewrite what its old runs say they were, which is the
 * point.
 *
 * Two transcript links, in preference order. `sessionId` is the good one and
 * works for every agent, live or finished: `GET /api/sessions/:id/history`
 * falls back to the session row's own conversation id once the session has left
 * memory (see `SessionManager.resumedConversationId`). `agentSessionId` is the
 * last resort for when the session row itself has been pruned, and only
 * resolves for `claude` — `ConversationStore` is the one transcript reader that
 * can find a conversation with no session at all.
 */
export const CronJobRun = z.object({
  id: z.string(),
  jobId: z.string().nullable(),
  jobName: z.string(),
  agent: z.string(),
  status: CronRunStatus,
  trigger: CronRunTrigger,
  /** The matched schedule instant. Equals `startedAt` for a manual run. */
  scheduledFor: z.number().int(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  agentSessionId: z.string().nullable(),
  /** The directory the run actually used — a per-run worktree, when it made one. */
  cwd: z.string().nullable(),
  error: z.string().nullable(),
});
export type CronJobRun = z.infer<typeof CronJobRun>;

/**
 * Every editable field, with no `.default()` and no refinement.
 *
 * The shared base exists because of two Zod traps that the rest of this
 * package has no precedent for:
 *
 * 1. `.refine()` returns a `ZodEffects`, which has **no `.partial()`** — so a
 *    refined create schema cannot be the basis of the update schema.
 * 2. `.partial()` does not remove a `.default()`; it still *applies* the
 *    default when the key is absent. A PATCH omitting `overlapPolicy` would
 *    therefore silently reset it to `'skip'` rather than leave it alone. So
 *    defaults live only on `CreateCronJobRequest`.
 *
 * Note what is absent. No `transport`: a cron job is always structured, because
 * delivering a prompt to a terminal session means writing keystrokes into a TUI
 * with no readiness signal and no way to tell a finished turn from a hung one —
 * precisely the judgement `terminal/classifier.ts` is forbidden from making. No
 * `cols`/`rows`: there is no character grid. No `resumeAgentSessionId` /
 * `forkSession`: each run starts a fresh conversation, because resuming one on
 * a schedule grows a transcript without bound and makes every run cost more
 * than the last, while forking one per run mints a duplicate chat a day. No
 * `adoptTargetId`: adopting a pane is inherently interactive.
 */
const CronJobFields = z
  .object({
    name: z.string().min(1).max(128),
    enabled: z.boolean(),
    /** Provide exactly one of `preset` / `cronExpr`. A preset mints the expression. */
    preset: CronSchedulePreset,
    cronExpr: z.string().min(1).max(200),
    /** Omitted on create means the server's own zone, captured at that moment. */
    timeZone: z.string().min(1).max(64),
    cwd: z.string().min(1).max(4096),
    agent: z.string().min(1).max(64),
    worktreeMode: CronWorktreeMode,
    /**
     * Nullable, not merely optional: absence in a PATCH means "leave it
     * alone", so without an explicit `null` there would be no way to clear a
     * model once one had been set.
     */
    model: z.string().min(1).max(200).nullable(),
    effort: EffortLevel.nullable(),
    skipPermissions: z.boolean(),
    prompt: z.string().min(1).max(LIMITS.maxInputChars),
    overlapPolicy: CronOverlapPolicy,
  })
  .partial({
    preset: true,
    cronExpr: true,
    timeZone: true,
    model: true,
    effort: true,
  });

const notBothSchedules = (v: { preset?: unknown; cronExpr?: unknown }): boolean =>
  !(v.preset !== undefined && v.cronExpr !== undefined);

const cronExprValid = (v: { cronExpr?: string }): boolean =>
  v.cronExpr === undefined || isValidCron(v.cronExpr);

export const CreateCronJobRequest = CronJobFields.extend({
  enabled: z.boolean().default(true),
  worktreeMode: CronWorktreeMode.default('none'),
  overlapPolicy: CronOverlapPolicy.default('skip'),
  /**
   * Defaults to **true**, and this is the one place in the codebase where a
   * skip-permissions default is on rather than off.
   *
   * A cron job is unattended by definition: there is nobody at 3am to answer
   * an approval, so a job created with approvals routed to the browser would
   * simply park on the first tool call and never finish. The invariant that
   * actually matters is preserved — an unanswered approval still never decays
   * into an allow, because with this set to `false` the run parks *forever*
   * (no timeout is added anywhere) and pushes a notification instead.
   *
   * Because this inverts the usual default, two things are mandatory: the
   * editor warns whenever it is on, and `CronJob.skipPermissionsEnabled` is
   * surfaced persistently on the job and every run — never only at creation.
   * See CLAUDE.md, where this is recorded as a deliberate third override
   * alongside `POCKETAGENT_GLOBAL_SKIP_PERMISSIONS`.
   */
  skipPermissions: z.boolean().default(true),
})
  .refine((v) => v.preset !== undefined || v.cronExpr !== undefined, {
    message: 'Provide a schedule preset or a cron expression.',
    path: ['cronExpr'],
  })
  .refine(notBothSchedules, {
    message: 'Provide a preset or a cron expression, not both.',
    path: ['cronExpr'],
  })
  .refine(cronExprValid, {
    message: 'That is not a valid five-field cron expression.',
    path: ['cronExpr'],
  });
export type CreateCronJobRequest = z.infer<typeof CreateCronJobRequest>;

export const UpdateCronJobRequest = CronJobFields.partial()
  .refine(notBothSchedules, {
    message: 'Provide a preset or a cron expression, not both.',
    path: ['cronExpr'],
  })
  .refine(cronExprValid, {
    message: 'That is not a valid five-field cron expression.',
    path: ['cronExpr'],
  });
export type UpdateCronJobRequest = z.infer<typeof UpdateCronJobRequest>;

export const CronJobListResponse = z.object({ jobs: z.array(CronJob) });
export type CronJobListResponse = z.infer<typeof CronJobListResponse>;

export const CronRunListResponse = z.object({ runs: z.array(CronJobRun) });
export type CronRunListResponse = z.infer<typeof CronRunListResponse>;

/**
 * The slim shape `ProjectInfo` embeds so the home screen can show a job row
 * before it has ever run.
 */
export const CronJobSummary = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  cronExpr: z.string(),
  timeZone: z.string(),
  nextRunAt: z.number().int().nullable(),
  lastRunStatus: CronRunStatus.nullable(),
  skipPermissionsEnabled: z.boolean(),
});
export type CronJobSummary = z.infer<typeof CronJobSummary>;
