import { z } from 'zod';

/**
 * PA-69: draining and restarting one backend.
 *
 * ## What this is *not*
 *
 * There is no field here — and there must never be one — naming an image, a
 * tag, a digest, a registry, a branch or a URL. The whole premise of the
 * ticket is that the frontend *detects and reports* while a supervisor
 * *applies*: the server never downloads or replaces its own code, and the
 * update source is fixed at deploy time in the compose file or systemd unit.
 * A server that could be told what to install would turn "restart this host"
 * into "run an arbitrary image on that host", which is a strictly larger
 * grant than the terminal access this app already hands out, because it
 * survives every later revocation.
 *
 * So `RestartRequest` carries exactly one bit — whether the operator accepts
 * interrupting work that is still running — and a test asserts the schema has
 * no other key, so re-adding one is a decision somebody has to defend rather
 * than a field that slips in with a refactor. The same reasoning
 * `agent-install.ts` records for keeping its id set a closed `z.enum`.
 */

/** Why one piece of live work would be destroyed by restarting now. */
export const DrainBlockerReason = z.enum([
  /**
   * A turn is running right now — the agent is working, or a tool call is
   * executing. Restarting loses it outright.
   */
  'mid_turn',
  /**
   * A turn is parked on an unanswered approval. Counted as blocking for the
   * same reason `SessionManager.busyTreeRoots` counts it as occupying a tree:
   * `busySince` is stamped at the prompt and cleared only on `turn_complete`,
   * so a run waiting for a human is *genuinely still running*. For a Pocket
   * Agent chat this is the case with no recovery path at all — the pending
   * approval lives in memory only, so a restart does not pause it, it
   * destroys it.
   */
  'awaiting_approval',
]);
export type DrainBlockerReason = z.infer<typeof DrainBlockerReason>;

/**
 * One reason a drain is not safe, named well enough for an operator to go and
 * look at it.
 *
 * `kind` plus `id` is deliberately enough to build the link (`#/s/<id>` for a
 * session, `#/planner/<id>` for a Pocket Agent chat) rather than shipping a
 * href the server composed: the server has no reliable notion of its own
 * external origin, which is the same reason `Webhook.deliveryPath` is a path
 * and not a URL.
 */
export const DrainBlocker = z.object({
  kind: z.enum(['session', 'planner_chat']),
  id: z.string(),
  /** Whatever the operator would recognise this work by in the UI. */
  title: z.string(),
  reason: DrainBlockerReason,
  /** Display name of the agent doing the work, when there is one. */
  agentDisplayName: z.string().nullable(),
  /** Working directory, for a session. Null for a Pocket Agent chat, which has none. */
  cwd: z.string().nullable(),
  /** Epoch ms the turn started, when known. Lets the UI say "busy for 3m". */
  since: z.number().int().nullable(),
});
export type DrainBlocker = z.infer<typeof DrainBlocker>;

/**
 * `GET /api/admin/drain-state` — what restarting would cost, right now.
 *
 * A read-only preflight exists because the alternative is unacceptable: with
 * only `POST /api/admin/restart`, the sole way to discover what is blocking is
 * to ask for a restart, and if nothing is blocking, that *restarts the
 * server*. An operator must be able to look before committing.
 */
export const DrainStateResponse = z.object({
  /**
   * False when this process was started in a way that cannot ask a supervisor
   * to bring it back — `buildApp` without a restart hook, which is every test
   * app. The UI disables the action instead of offering one that fails, and
   * the server refuses rather than exiting into nothing, because a server that
   * drains and stays down is worse than one that never offered to.
   */
  restartSupported: z.boolean(),
  blockers: z.array(DrainBlocker),
});
export type DrainStateResponse = z.infer<typeof DrainStateResponse>;

/**
 * `POST /api/admin/restart` — drain and exit; the supervisor restarts us.
 *
 * `force` is the one deliberate override, and it is the same shape as the only
 * other override of live-work occupancy in the app: `force` on a human's own
 * queued prompt (`sessions/prompt-queue.ts`). Both are available only where a
 * person is present to own the consequence, and neither decays into itself
 * over time — there is no timeout anywhere in this path, so a restart request
 * blocked by an unanswered approval waits for a human rather than eventually
 * proceeding on its own.
 */
export const RestartRequest = z.object({
  force: z.boolean().optional().default(false),
});
export type RestartRequest = z.infer<typeof RestartRequest>;

/**
 * Answered *before* the process exits, with 202: the exit is deliberately not
 * awaited, because a response written after `app.close()` has torn down the
 * HTTP server never reaches anybody. An operator who gets no answer cannot
 * tell "accepted" from "refused" from "already gone".
 */
export const RestartAcceptedResponse = z.object({
  accepted: z.literal(true),
  /** True when live work was overridden. Echoed so the client can say so. */
  forced: z.boolean(),
  /** What was running when the override was used. Empty for a clean drain. */
  overridden: z.array(DrainBlocker),
  /**
   * The exit status this process will use.
   *
   * Reported rather than assumed because it is the one detail an operator
   * debugging "it did not come back" needs, and because the choice is
   * non-obvious: it is deliberately *non-zero* so that a unit or container
   * configured with `Restart=on-failure` — which is what this repo's own
   * README recommends and what its production unit uses — restarts it. A clean
   * `exit(0)` is a *successful* exit, which `on-failure` correctly ignores,
   * and the endpoint would then be a remote off switch.
   */
  exitCode: z.number().int(),
});
export type RestartAcceptedResponse = z.infer<typeof RestartAcceptedResponse>;

/**
 * The 409 body when live work is in the way.
 *
 * Carries the blockers alongside the standard `error` envelope so one round
 * trip both refuses and explains; the UI turns this straight into "N things
 * are still running" plus a "Restart anyway" affordance.
 */
export const RestartRefusedResponse = z.object({
  error: z.object({ code: z.literal('drain_blocked'), message: z.string() }),
  blockers: z.array(DrainBlocker),
});
export type RestartRefusedResponse = z.infer<typeof RestartRefusedResponse>;
