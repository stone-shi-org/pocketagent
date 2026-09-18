import type { DrainBlocker } from '@pocketagent/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { SessionManager } from '../sessions/manager.js';
import type { PlannerChatService } from '../planner/chats.js';

/**
 * PA-69: choosing a safe moment to stop.
 *
 * ## The whole feature, stated once
 *
 * "The frontend can upgrade the backend" is only safe in one shape: the
 * frontend *detects and reports*, a supervisor *applies*. A process that
 * replaces itself has no supervisor left to replace it, and if the update
 * source were selectable from the UI then "upgrade this host" would mean "run
 * an arbitrary image on that host" — a strictly larger grant than the terminal
 * access this app already hands out, because it survives every later
 * revocation. So this module downloads nothing, installs nothing, and cannot be
 * told what to run. Its entire job is to answer "would stopping now destroy
 * work?" and, if not, to exit in a way a supervisor turns into a restart.
 *
 * ## Why the exit is injected rather than performed here
 *
 * `process.exit` from inside `buildApp` would kill the test runner — every
 * test app is built by the same function. So the *decision* lives here and the
 * *act* is a hook `server.ts` installs (`setRestartHook`). Absent hook means
 * the route refuses with a clear reason instead of pretending: a server that
 * drains and then stays down forever is far worse than one that never offered
 * to restart, which is the same reasoning behind reporting `exitCode` in the
 * response at all.
 */

export type RestartHook = (reason: { forced: boolean }) => void;

export interface AdminServiceOptions {
  sessions: SessionManager;
  plannerChats: PlannerChatService;
  logger?: FastifyBaseLogger;
}

/**
 * The exit status this process uses when asked to restart.
 *
 * **Deliberately non-zero, and this is the load-bearing detail of the whole
 * ticket.** The ticket assumed systemd `Restart=always`; this repo's own
 * README recommends `Restart=on-failure` and its production unit uses it.
 * Under `on-failure` a clean `exit(0)` is a *successful* exit, so systemd does
 * nothing and the server simply stays down — the endpoint would be a remote
 * off switch on every deployment that followed our own documentation.
 *
 * 75 is `EX_TEMPFAIL` ("temporary failure, try again later"), which is the
 * closest standard meaning to "stop me, I expect to come back", and it sits
 * beside the 78 (`EX_CONFIG`) this server already exits with on a bad config.
 * A non-zero status restarts under every supervisor policy that restarts at
 * all: systemd `always` and `on-failure`, Docker `always`, `unless-stopped`
 * and `on-failure`. The cost is one misleading "failed" line in the journal,
 * which is why the drain logs an explicit message first.
 */
export const RESTART_EXIT_CODE = 75;

export class AdminService {
  private restartHook: RestartHook | null = null;

  constructor(private readonly opts: AdminServiceOptions) {}

  /**
   * Installed once, by `server.ts`. Not a constructor argument because the
   * hook needs the built Fastify instance in order to close it, and that does
   * not exist until `buildApp` has returned — the same after-construction
   * wiring `PlannerChatService.attachRunServices` uses, and for the same
   * ordering reason.
   */
  setRestartHook(hook: RestartHook): void {
    this.restartHook = hook;
  }

  /** False in tests and anywhere else nothing installed a hook. */
  get restartSupported(): boolean {
    return this.restartHook !== null;
  }

  /**
   * Everything a restart would destroy right now.
   *
   * Two sources, because there are two kinds of live work and only one of them
   * is a session. Sessions come from `SessionManager.midTurnSessions`, which
   * shares its predicate with the run queue's own occupancy check so a drain
   * and the queue cannot disagree about what "busy" means. Pocket Agent turns
   * come from `PlannerChatService.inFlightTurns`, because they have no session
   * and are therefore invisible to the first source entirely — the gap that
   * would otherwise make this check confidently wrong for every webhook- or
   * Telegram-driven chat.
   *
   * Asked fresh on every call, never cached, for the reason `busyTreeRoots`
   * records: a stale answer either blocks a restart forever or permits one
   * that destroys a turn.
   *
   * What is deliberately *not* a blocker: queued webhook deliveries and queued
   * human prompts. Both are persisted (`queued_spec_json`,
   * `session_prompt_queue`) and both are deliberately left alone by the boot
   * sweeps, so they survive a restart and resume afterwards — counting them
   * would refuse a restart to protect work that is in no danger. Terminal
   * sessions are not blockers either: a PTY has no end-of-turn signal, so an
   * idle shell would otherwise block every restart forever. Both are stated
   * here because their absence is a decision, not an oversight.
   */
  blockers(): DrainBlocker[] {
    const blockers: DrainBlocker[] = [];

    for (const session of this.opts.sessions.midTurnSessions()) {
      blockers.push({
        kind: 'session',
        id: session.id,
        title: session.title,
        reason: session.awaitingApproval ? 'awaiting_approval' : 'mid_turn',
        agentDisplayName: session.agentDisplayName,
        cwd: session.cwd,
        since: session.busySince,
      });
    }

    for (const turn of this.opts.plannerChats.inFlightTurns()) {
      blockers.push({
        kind: 'planner_chat',
        id: turn.chatId,
        title: turn.title,
        reason: turn.reason,
        // The Pocket Agent the chat belongs to is the closest thing it has to
        // "which agent is doing this", and it is what the UI labels the row
        // with. A planner workspace is app-owned scratch space, not a
        // checkout, so there is genuinely no cwd to report.
        agentDisplayName: turn.workspaceName,
        cwd: null,
        // A pocket turn's start time is not tracked: `busySince` is a session
        // concept and adding a parallel timestamp would be a second source of
        // truth for "is this busy". Null rather than invented, so the UI omits
        // the duration instead of showing a wrong one.
        since: null,
      });
    }

    return blockers;
  }

  /**
   * Ask to drain and exit.
   *
   * Refuses by default while anything is mid-turn and reports what, which is
   * the acceptance criterion: an operator decides, nothing decides for them.
   * There is **no timeout and no deferral queue** — a request blocked by an
   * unanswered approval waits for a human rather than eventually proceeding on
   * its own, which is the same no-decay rule every other approval path in this
   * app follows. `force` is the one override, the same shape as `force` on a
   * human's own queued prompt, and it is logged with what it overrode so the
   * journal records the decision rather than just the exit.
   */
  requestRestart(force: boolean): { accepted: boolean; blockers: DrainBlocker[] } {
    const blockers = this.blockers();
    if (blockers.length > 0 && !force) return { accepted: false, blockers };

    if (this.restartHook === null) {
      // Callers check `restartSupported` first and answer 501; this is the
      // belt-and-suspenders half, because exiting into no supervisor is the
      // one failure here that an operator cannot undo remotely.
      return { accepted: false, blockers };
    }

    if (blockers.length > 0) {
      this.opts.logger?.warn(
        {
          forced: true,
          overridden: blockers.map((b) => ({ kind: b.kind, id: b.id, reason: b.reason })),
        },
        'restart forced while work was still in progress',
      );
    }

    this.restartHook({ forced: force && blockers.length > 0 });
    return { accepted: true, blockers };
  }
}
