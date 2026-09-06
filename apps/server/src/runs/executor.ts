import crypto from 'node:crypto';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import { SessionError } from '../sessions/manager.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { WorkspaceError } from '../workspaces/index.js';
import type { WorktreeService } from '../git/worktree.js';
import { WorktreeError } from '../git/worktree.js';
import type { PlannerChatService } from '../planner/chats.js';
import { PlannerChatError } from '../planner/chats.js';

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
  /**
   * PA-10: the Pocket Agent chat this run is happening in — the pocket
   * equivalent of `onSessionStarted`, and the only handle a pocket run has.
   *
   * Optional so `CronService`'s sink, which cannot start a pocket run today,
   * needs no change at all. `startPocketAgent` is the only caller.
   */
  onPlannerChat?(chatId: string): void;
  onSettled(status: 'succeeded' | 'failed', error: string | null): void;
}

export type RunOutcome =
  | { ok: true; sessionId: string; cwd: string; session: StructuredLikeSession }
  | { ok: false; error: string };

/**
 * PA-10: what to run when the trigger's agent is a *Pocket Agent* rather than
 * a coding agent.
 *
 * A separate spec rather than a variant of `RunSpec`, because almost nothing
 * carries over: a Pocket Agent chat has no worktree (its workspace is
 * app-owned scratch space that the planner's own tools write to directly), no
 * git branch, no `cwd` to validate against the project workspace list, no
 * effort level, and no session. What survives is the part the trigger actually
 * cares about — a directory-less place to put one prompt, and a sink to report
 * it through.
 */
export interface PocketRunSpec {
  /** The planner workspace ("agent") to run in. */
  plannerWorkspaceId: string;
  /** Becomes the chat's title, so the run is identifiable in the Pocket Agent list. */
  title: string;
  prompt: string;
  /**
   * The trigger's own skip-permissions decision, passed straight through to
   * `PlannerChat.skipToolApprovalsEnabled`.
   *
   * With it off, a mutating tool call parks the turn and the run stays
   * genuinely in progress until a human answers in the Pocket Agent UI —
   * never a timeout, never a decay into an allow. That is the same
   * "unattended run waits forever" behaviour a cron job with the toggle off
   * already has, and the reason the sink observes the chat rather than only
   * draining its own generator.
   */
  skipPermissions: boolean;
  /** The planner model id to use; absent/null leaves the chat's own default. */
  model?: string | null;
  /**
   * Continue this chat instead of creating one — a webhook's `per-issue` mode,
   * where the conversation belongs to the issue.
   *
   * A chat id that no longer resolves (deleted from the Pocket Agent UI, or
   * pruned) silently starts a fresh chat rather than failing the run: the
   * mapping row is a cache, exactly as it already is for a session.
   */
  resumeChatId?: string;
}

export type PocketRunOutcome = { ok: true; chatId: string } | { ok: false; error: string };

export interface RunExecutorOptions {
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  worktrees: WorktreeService;
  /**
   * PA-10: required only to start a *Pocket Agent* run (`startPocketAgent`).
   *
   * Optional because `CronService` constructs an executor before this feature
   * reached it, and a cron job still cannot name a Pocket Agent — absent, a
   * pocket run fails with a clear message rather than crashing, which is the
   * same posture every other missing precondition in this file takes.
   */
  plannerChats?: PlannerChatService;
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
  /**
   * PA-10: teardown for a pocket run's chat observer, keyed the same way as
   * `inFlight`, so settling a run — including from `abandonAll` — always
   * detaches its listener instead of leaking one per delivery.
   */
  private readonly pocketDisposers = new Map<string, () => void>();

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
          ...(worktree.mode === 'new-branch'
            ? { branchName: worktree.branchName, reuseExisting: true }
            : {}),
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
   * PA-10: the Pocket Agent equivalent of `start` — chat → watch → prompt.
   *
   * Deliberately its own method rather than a branch inside `run()`: the two
   * share the *contract* (never throws, exactly one `onSettled`, liveness asked
   * rather than timed) but none of the steps. There is no directory to
   * re-validate, no worktree to mint and no session to create; what there is
   * instead is a chat, and a turn that is driven by a generator nobody else is
   * holding.
   *
   * Two things here are subtler than they look.
   *
   * First, the ordering still matches `run()`'s "watch before prompt", and for
   * a sharper reason: `sendMessage` is a generator, so *nothing happens* until
   * its first `next()`. Subscribing before that call is therefore not merely
   * early enough — it is the only way to be sure no event is missed, since the
   * first `next()` can already produce `user_prompt` and, for a trivially short
   * turn, everything after it.
   *
   * Second, the run is settled by the *observer*, not by draining the
   * generator, because a turn that parks on an approval ends its generator
   * while genuinely still running. When a human eventually answers in the
   * Pocket Agent UI, the continuation is driven by `resolveApproval` streaming
   * to their browser; the observer is what lets this run's sink see the
   * `turn_complete` that comes out of it. Draining still happens — somebody has
   * to pull the generator or the turn never advances — but it is the pump, not
   * the sensor.
   */
  async startPocketAgent(
    runId: string,
    spec: PocketRunSpec,
    sink: RunSink,
  ): Promise<PocketRunOutcome> {
    const fail = (message: string): PocketRunOutcome => {
      this.settleNow(runId, sink, 'failed', message);
      return { ok: false, error: message };
    };

    const planner = this.opts.plannerChats;
    if (planner === undefined) {
      return fail('This trigger names a Pocket Agent, but Pocket Agents are not available here.');
    }

    // 1. Resolve the chat. `resumeChatId` is a cache hint, so a stale one
    //    starts a fresh chat rather than failing the run.
    let chat = spec.resumeChatId !== undefined ? planner.get(spec.resumeChatId) : null;
    if (chat === null) {
      try {
        chat = planner.create({
          workspaceId: spec.plannerWorkspaceId,
          title: spec.title,
          ...(spec.model !== undefined && spec.model !== null ? { modelId: spec.model } : {}),
          skipToolApprovals: spec.skipPermissions,
        });
      } catch (err) {
        if (err instanceof PlannerChatError) {
          return fail(
            err.code === 'not_found'
              ? 'The Pocket Agent this trigger names no longer exists.'
              : err.message,
          );
        }
        throw err;
      }
    }
    const chatId = chat.id;
    sink.onPlannerChat?.(chatId);

    // 2. Watch, before the turn can produce anything. See the doc comment.
    this.inFlight.set(runId, sink);
    let settled = false;
    const settle = (status: 'succeeded' | 'failed', error: string | null): void => {
      if (settled) return;
      // Also guarded on still being in flight, not only on the local latch:
      // `abandonAll` settles this run's sink directly and clears the map, and
      // the background drain below can outlive that call by a microtask (it is
      // pumping a generator nobody is waiting on). Without this, a shutdown
      // during a pocket turn would report the delivery settled twice, breaking
      // `RunSink`'s documented "exactly once" contract.
      if (!this.inFlight.has(runId)) return;
      settled = true;
      this.inFlight.delete(runId);
      this.pocketDisposers.get(runId)?.();
      this.pocketDisposers.delete(runId);
      sink.onSettled(status, error);
    };

    const unsubscribe = planner.observe(chatId, (event) => {
      if (event.kind === 'turn_complete') {
        settle(
          event.isError ? 'failed' : 'succeeded',
          event.isError ? 'The Pocket Agent reported an error.' : null,
        );
      }
      if (event.kind === 'permission_request') {
        // Not a failure and not a settle: the run is parked, exactly as a
        // coding-agent run parked on an unanswered approval is. Logged because
        // "my webhook says running and nothing is happening" has exactly one
        // answer, and this line is it.
        this.opts.logger?.info(
          { label: this.opts.label, runId, chatId, toolName: event.toolName },
          'pocket agent run is waiting for a tool approval',
        );
      }
    });
    this.pocketDisposers.set(runId, unsubscribe);

    // 3. Prompt, and keep pumping. The first `next()` is awaited separately so
    //    a synchronous precondition failure (no LLM endpoint configured, no
    //    model chosen) still becomes a `failed` run with its own message rather
    //    than an unhandled rejection in the background drain below.
    const turn = planner.sendMessage(chatId, spec.prompt);
    try {
      const first = await turn.next();
      if (first.done === true) {
        // A turn that produced nothing at all. Nothing can settle it later, so
        // it has to be settled here or the row stays open forever.
        settle('failed', 'The Pocket Agent turn ended without producing anything.');
        return { ok: false, error: 'The Pocket Agent turn ended without producing anything.' };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      settle('failed', message);
      return { ok: false, error: message };
    }

    void (async () => {
      try {
        while (true) {
          const next = await turn.next();
          if (next.done === true) break;
        }
      } catch (err) {
        this.opts.logger?.warn(
          { label: this.opts.label, runId, chatId, err },
          'pocket agent run failed while streaming',
        );
        settle('failed', err instanceof Error ? err.message : String(err));
      }
    })();

    return { ok: true, chatId };
  }

  /**
   * Liveness for a pocket run, asked of this executor rather than of a session
   * — a pocket run has none.
   *
   * In-memory only, and that is the honest answer: after a restart nothing is
   * pumping that turn any more, and the caller's own boot-time "close out rows
   * a previous server left open" pass is what reconciles it. Same no-timeout
   * discipline as `isAlive`.
   */
  isPocketRunAlive(runId: string): boolean {
    return this.inFlight.has(runId);
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
    // PA-10: a pocket run's listener lives on `PlannerChatService`, which
    // outlives this executor's shutdown, so dropping `inFlight` alone would
    // leave it attached and firing into an already-settled sink.
    for (const dispose of this.pocketDisposers.values()) dispose();
    this.pocketDisposers.clear();
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
