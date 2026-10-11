import type { FastifyPluginAsync } from 'fastify';
import {
  RestartRequest,
  type DrainStateResponse,
  type RestartAcceptedResponse,
} from '@pocketagent/protocol';
import { RESTART_EXIT_CODE } from '../admin/index.js';

/**
 * Draining and restarting this backend (PA-69).
 *
 * Its own route module, like `routes/agent-install.ts`, so `grep` finds the
 * whole of the most consequential thing an authenticated request can do in one
 * file. Both routes are authenticated and Origin-checked by `app.ts`'s single
 * `onRequest` gate exactly like every other `/api/` route: nothing here is
 * added to `PUBLIC_API_PATHS`, and the state-changing one is a `POST` so the
 * Origin check applies — the same reason the webhook secret's reveal and
 * rotate are POSTs.
 *
 * `/api/admin/` is a new namespace and is deliberately *not* under
 * `/api/hooks/`, which remains the only unauthenticated surface. Worth stating
 * because the two guarantees in CLAUDE.md are that `grep PUBLIC_API_PATHS` and
 * `grep '/api/hooks/'` between them enumerate everything reachable without a
 * credential, and this ticket adds to neither.
 */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  const { admin } = app.pocket;

  /**
   * What restarting would cost, right now — read-only.
   *
   * This exists because the alternative is a trap: with only the POST below,
   * the sole way to learn what is blocking is to ask for a restart, and if
   * nothing is blocking, that restarts the server. An operator has to be able
   * to look before committing.
   */
  app.get('/api/admin/drain-state', async (): Promise<DrainStateResponse> => {
    return { restartSupported: admin.restartSupported, blockers: admin.blockers() };
  });

  /**
   * Drain and exit; a supervisor brings us back.
   *
   * Rate-limited on the same per-route opt-in `POST /api/agents/install` uses.
   * The cap is low because there is no legitimate reason to ask twice: the
   * first accepted request already scheduled the exit.
   */
  app.post(
    '/api/admin/restart',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = RestartRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message:
              'Restart accepts only { force?: boolean }. There is deliberately no way to name a version, image or artifact — the update source is fixed at deploy time.',
          },
        });
      }
      const { force } = parsed.data;

      // Answered before the hook is consulted, because this is the one failure
      // an operator cannot undo remotely: a server that drains into no
      // supervisor stays down until somebody reaches the machine.
      if (!admin.restartSupported) {
        return reply.code(501).send({
          error: {
            code: 'restart_unsupported',
            message:
              'This process cannot ask a supervisor to restart it, so it will not exit. Run it under systemd, launchd (macOS), or Docker with a restart policy.',
          },
        });
      }

      const result = admin.requestRestart(force);

      if (!result.accepted) {
        // 409 rather than 4xx-generic: the request is well-formed and
        // authorized, it conflicts with the current state. The message names
        // the blockers so a `curl` caller is told why without a second call,
        // and `blockers` carries the structured form for anything that wants
        // to render it — the browser re-reads `drain-state` instead, because
        // `ApiError` deliberately carries only a code and a message.
        return reply.code(409).send({
          error: {
            code: 'drain_blocked',
            message: `Not restarting: ${describeBlockers(result.blockers)}. Answer or finish the work, or retry with force to interrupt it.`,
          },
          blockers: result.blockers,
        });
      }

      request.log.info(
        { forced: force, blockers: result.blockers.length, exitCode: RESTART_EXIT_CODE },
        'restart requested over the API',
      );

      const response: RestartAcceptedResponse = {
        accepted: true,
        forced: force && result.blockers.length > 0,
        overridden: result.blockers,
        exitCode: RESTART_EXIT_CODE,
      };
      // 202, not 200: the work this describes has been accepted and has not
      // happened yet. The process is still up when these bytes leave.
      return reply.code(202).send(response);
    },
  );
};

/**
 * "2 sessions and 1 Pocket Agent chat are still working" — one clause, in the
 * refusal message itself.
 *
 * The acceptance criterion is that a refusal *names* what is blocking, so this
 * has to be in the message and not only in the structured field: a `curl` or a
 * script sees the message, and a message that said "something is running"
 * would send the operator looking through the UI for it.
 */
function describeBlockers(blockers: readonly { kind: string; title: string }[]): string {
  if (blockers.length === 1) return `${blockers[0]!.title} is still working`;
  const names = blockers.slice(0, 3).map((b) => b.title);
  const rest = blockers.length - names.length;
  const list = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ');
  return `${list} are still working`;
}
