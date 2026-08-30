import crypto from 'node:crypto';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import { SessionError } from '../sessions/manager.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { WorkspaceError } from '../workspaces/index.js';
import type { WorktreeService } from '../git/worktree.js';
import { WorktreeError } from '../git/worktree.js';

/**
 * The worktree → session → prompt composite, shared by every trigger that
 * starts agent work with no human present.
 *
 * Extracted from `CronService`, which was its only caller until inbound
 * webhooks arrived. The two triggers differ entirely in *when* they fire and
 * in what they record — a schedule solves a clock, a webhook verifies a
 * signature — but the act of starting the run is identical, and it is the part
 * with the subtle ordering (watch before prompt) and the exact failure strings
 * that a second copy would get subtly wrong.
 *
 * What stays with the caller is bookkeeping: the executor never touches a
 * table. It reports progress through a `RunSink`, so one implementation writes
 * `cron_runs` and another writes `webhook_deliveries` without this file
 * knowing either exists.
 */

/** What to run. `cwd` is the *saved* path; the executor re-resolves it. */
export interface RunSpec {
  cwd: string;
  agent: string;
  title: string;
  prompt: string;
  skipPermissions: boolean;
  model?: string | null;
  /**
   * Omit the key entirely for "use the agent's cached default"; present-and-null
   * means "the model's own default". The same tri-state `CreateSessionInput`
   * uses, and the reason this is `?:` rather than `| undefined`.
   */
  effort?: string | null;
  worktree:
    | { mode: 'none' }
    | { mode: 'current-branch' }
    /**
     * `branchName` is minted per call by the caller, never stored on a spec: a
     * repeating trigger with a *fixed* branch name succeeds exactly once and
     * then throws `branch_exists` forever. `mintBranchName` is here for that.
     */
    | { mode: 'new-branch'; branchName: string };
  /**
   * Continue an existing agent conversation instead of starting a fresh one.
   *
   * `forkSession` is pinned to `false` below rather than left to the default.
   * `CreateSessionInput.forkSession`'s doc comment claims it defaults to true,
   * but `structured-session.ts` only forks on `=== true` and the HTTP schema
   * defaults it to `false` — the comment is stale. Being explicit here means a
   * later correction of that default cannot silently start branching a
   * duplicate chat per run.
   */
  resume?: { agentSessionId: string };
  /**
   * Run in this already-resolved directory instead of making a worktree.
   *
   * Used by a webhook's `per-issue` mode, where the worktree belongs to the
   * issue and was created by the first delivery. Still re-resolved for
   * containment — a path that was inside a project folder last week is not
   * automatically inside one now.
   */
  reuseCwd?: string;
  /** Message recorded when the adapter hands back a terminal session. */
  notStructuredMessage?: string;
}

/**
 * Where a run's progress is recorded.
 *
 * `onSettled` is called exactly once per run, from whichever path finishes
 * first — the `settled` latch lives in the executor so no sink has to own one,
 * and so a `turn_complete` followed minutes later by an `exit` cannot flip a
 * succeeded run to failed.
 */
export interface RunSink {
  /** The directory the run actually used — a per-run worktree, when it made one. */
  onCwd(cwd: string): void;
  onSessionStarted(sessionId: string): void;
  /** Arrives asynchronously in the first event; links the run to a transcript on disk. */
  onAgentSessionId(agentSessionId: string): void;
  onSettled(status: 'succeeded' | 'failed', error: string | null): void;
}

export type RunOutcome =
  | { ok: true; sessionId: string; cwd: string; session: StructuredLikeSession }
  | { ok: false; error: string };

export interface RunExecutorOptions {
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  worktrees: WorktreeService;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  /** Prefixes the "run failed unexpectedly" log line, so the two callers are distinguishable. */
  label?: string;
  /** Injectable for tests, matching `CronService`. */
  now?: () => number;
}

export class RunExecutor {
  /**
   * Runs whose completion listeners are still attached, so `abandonAll()` can
   * close them out. Keyed by an opaque caller-chosen id, holding the sink so
   * shutdown does not need the caller to remember anything.
   */
  private readonly inFlight = new Map<string, RunSink>();

  constructor(private readonly opts: RunExecutorOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Resolve cwd → optional worktree → structured session → watch → prompt.
   *
   * Never throws. Every failure is reported through both the return value and
   * `sink.onSettled('failed', …)`, because a background run has nobody to show
   * an exception to — the run list is the only place a failure can surface, and
   * a row left open in `starting` with no session cannot be reconciled later
   * (there is no session to ask about) and would block a `skip`-policy trigger
   * forever, with no timeout anywhere to rescue it.
   *
   * `runId` is the caller's own id for this run; it is used only as the
   * in-flight key and in log lines.
   */
  async start(runId: string, spec: RunSpec, sink: RunSink): Promise<RunOutcome> {
    try {
      return await this.run(runId, spec, sink);
    } catch (err) {
      // The specific failure modes are handled inside with their own messages;
      // this catches the ones nobody thought of. The raw message is preserved
      // deliberately — a generic replacement here is how an unexplained
      // `failed` row becomes unexplainable.
      this.opts.logger?.warn(
        { label: this.opts.label, runId, err },
        `${this.opts.label ?? 'run'} failed unexpectedly`,
      );
      const message = err instanceof Error ? err.message : String(err);
      this.settleNow(runId, sink, 'failed', message);
      return { ok: false, error: message };
    }
  }

  private async run(runId: string, spec: RunSpec, sink: RunSink): Promise<RunOutcome> {
    const fail = (message: string): RunOutcome => {
      this.settleNow(runId, sink, 'failed', message);
      return { ok: false, error: message };
    };

    // 1. Re-validate the directory. A folder can be removed from the workspace
    //    list, unmounted, or deleted long after the trigger was saved, and an
    //    unattended run is the last place to weaken containment.
    let projectCwd: string;
    try {
      projectCwd = await this.opts.workspaces.resolveWorkspacePath(spec.reuseCwd ?? spec.cwd);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const reason =
          err.code === 'not_found'
            ? 'The project folder no longer exists.'
            : err.code === 'forbidden'
              ? 'The project folder is no longer inside an added project folder.'
              : err.code === 'not_a_directory'
                ? 'The project path is no longer a directory.'
                : err.message;
        return fail(reason);
      }
      throw err;
    }

    // 2. A per-run worktree, when asked for. Skipped entirely when the caller
    //    supplied `reuseCwd`: that directory already *is* a worktree, made by
    //    an earlier run that owns it.
    let cwd = projectCwd;
    if (spec.reuseCwd === undefined && spec.worktree.mode !== 'none') {
      const worktree = spec.worktree;
      try {
        const created = await this.opts.worktrees.create({
          projectCwd,
          branchMode: worktree.mode === 'new-branch' ? 'new' : 'current',
          ...(worktree.mode === 'new-branch' ? { branchName: worktree.branchName } : {}),
        });
        cwd = created.cwd;
      } catch (err) {
        if (err instanceof WorktreeError) return fail(`Could not create a worktree: ${err.message}`);
        throw err;
      }
    }
    sink.onCwd(cwd);

    // 3. Start the session. `create()` surfaces a missing agent binary as
    //    `agent_unavailable` for us, so there is no separate preflight.
    let session: StructuredLikeSession;
    try {
      const created = await this.opts.sessions.create({
        agent: spec.agent,
        cwd,
        // Legal because `cols`/`rows` are `nonnegative()`, and honest: a
        // structured session has no character grid and reports 0 anyway.
        cols: 0,
        rows: 0,
        transport: 'structured',
        title: spec.title,
        skipPermissions: spec.skipPermissions,
        ...(spec.model !== undefined && spec.model !== null ? { model: spec.model } : {}),
        // Only pass the key at all when the caller set it — see `RunSpec.effort`.
        ...('effort' in spec ? { effort: spec.effort } : {}),
        ...(spec.resume !== undefined
          ? { resumeAgentSessionId: spec.resume.agentSessionId, forkSession: false }
          : {}),
      });
      if (created.transport !== 'structured') {
        return fail(
          spec.notStructuredMessage ??
            'This run needs a structured session, but a terminal one was created.',
        );
      }
      session = created as StructuredLikeSession;
    } catch (err) {
      if (err instanceof SessionError) return fail(err.message);
      throw err;
    }

    sink.onSessionStarted(session.id);

    // 4. Watch for completion *before* prompting, so a turn that finishes
    //    instantly cannot land before anyone is listening.
    this.watch(runId, session, sink);

    // 5. Send the prompt. No wait, no poll, no timeout: every structured
    //    backend sets `running` synchronously inside its own awaited
    //    `start()`, so by the time `create()` resolves there is nothing left
    //    to wait for. `prompt()` returning false therefore means the session
    //    is already dead — an asynchronous start failure surfacing between
    //    those two lines — not that it is not ready yet.
    if (!session.prompt(spec.prompt)) {
      return fail('The session ended before its prompt could be sent.');
    }

    return { ok: true, sessionId: session.id, cwd, session };
  }

  /**
   * Send a follow-up prompt into a session this executor is already watching.
   *
   * Used by a webhook's `per-issue` mode when a second event arrives for an
   * issue whose conversation is still live: the run is a new *row*, but not a
   * new session, so there is nothing to create and nothing to resume.
   */
  followUp(runId: string, session: StructuredLikeSession, prompt: string, sink: RunSink): boolean {
    sink.onSessionStarted(session.id);
    this.watch(runId, session, sink);
    if (!session.prompt(prompt)) {
      this.settleNow(runId, sink, 'failed', 'The session ended before its prompt could be sent.');
      return false;
    }
    return true;
  }

  /**
   * Attach completion listeners for one run.
   *
   * The first `turn_complete` ends the run. One run is one prompt and one turn
   * — if someone then keeps chatting in the session it created, the session
   * lives on but the *run* is finished. A run records what the trigger did, not
   * everything that ever happened downstream of it.
   */
  private watch(runId: string, session: StructuredLikeSession, sink: RunSink): void {
    this.inFlight.set(runId, sink);
    let settled = false;

    const settle = (status: 'succeeded' | 'failed', error: string | null): void => {
      if (settled) return;
      settled = true;
      this.inFlight.delete(runId);
      sink.onSettled(status, error);
    };

    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started' && event.agentSessionId) {
        sink.onAgentSessionId(event.agentSessionId);
      }
      if (event.kind === 'turn_complete') {
        settle(
          event.isError ? 'failed' : 'succeeded',
          event.isError ? 'The agent reported an error.' : null,
        );
      }
    });

    session.on('exit', () => {
      settle('failed', 'The session ended before its turn completed.');
    });
  }

  /**
   * Settle a run that never got as far as `watch`, so pre-session failures and
   * post-session ones take the same path out.
   */
  private settleNow(
    runId: string,
    sink: RunSink,
    status: 'succeeded' | 'failed',
    error: string | null,
  ): void {
    this.inFlight.delete(runId);
    sink.onSettled(status, error);
  }

  /**
   * Settle every in-flight run through its own sink.
   *
   * Called on shutdown, where the real reason is known now; the next boot's
   * "mark stale rows failed" pass stays as the crash path only.
   */
  abandonAll(reason: string): void {
    for (const [, sink] of this.inFlight) {
      sink.onSettled('failed', reason);
    }
    this.inFlight.clear();
  }

  /**
   * Liveness, asked of the session rather than inferred from a clock.
   *
   * A timeout would kill a legitimately long turn, and a run parked on an
   * unanswered approval is *genuinely still running* — force-failing it is the
   * same disrespect for an undecided decision that the no-timeout rule exists
   * to prevent.
   */
  isAlive(sessionId: string | null): boolean {
    if (sessionId === null) return false;
    const info = this.opts.sessions.find(sessionId);
    return info !== null && (info.status === 'starting' || info.status === 'running');
  }
}

/**
 * `nightly-review-20260828-0900-a3f9c1` — readable in `git branch`, and unique
 * per call.
 *
 * The stamp is derived from the firing instant in the trigger's own zone so the
 * branch reads correctly, and the hex suffix removes the "fire twice in one
 * minute" collision.
 */
export function mintBranchName(
  base: string,
  timeZone: string,
  instant: number,
  fallback = 'run',
): string {
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || fallback;
  return `${slug}-${stampIn(instant, timeZone)}-${crypto.randomBytes(3).toString('hex')}`;
}

/** `YYYYMMDD-HHmm` in the given zone, so the branch name reads correctly. */
export function stampIn(ms: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
  } catch {
    return String(ms);
  }
}
