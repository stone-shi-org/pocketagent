import type { FastifyPluginAsync } from 'fastify';
import { InstallAgentRequest, type InstallableAgentListResponse } from '@pocketagent/protocol';
import { AgentInstallError, type InstallSubscribe } from '../agents/install.js';
import { openSseStream } from './sse.js';

/**
 * Keeps a proxy's idle timeout from cutting a long install's stream. Well
 * under the 60s nginx default and the 30s many tunnels use.
 */
const HEARTBEAT_MS = 15_000;

/**
 * On-demand agent CLI installation (PA-68).
 *
 * Its own route module rather than two more handlers in `routes/sessions.ts`
 * for the same reason `routes/webhook-delivery.ts` is separate: this is the
 * one place in the server that deliberately executes third-party code, and
 * `grep` should find all of it in one file.
 *
 * Both routes are authenticated and Origin-checked by `app.ts`'s single
 * `onRequest` gate like everything else under `/api/` — nothing here is added
 * to `PUBLIC_API_PATHS`, and `POST` means the Origin check applies, which is
 * the same reason the webhook secret's reveal and rotate are POSTs.
 */
export const agentInstallRoutes: FastifyPluginAsync = async (app) => {
  const { agentInstall } = app.pocket;

  /**
   * The server-declared catalog. Disclosure, not input: the operator sees the
   * package and the pinned version they would be agreeing to run, and the
   * prefix it lands in, before pressing anything.
   */
  app.get('/api/agents/installable', async () => {
    const response: InstallableAgentListResponse = {
      agents: agentInstall.catalog(),
      prefix: app.pocket.config.agentInstallPrefix,
      prefixDetectable: agentInstall.prefixDetectable(),
    };
    return response;
  });

  /**
   * Start an install (or attach to one already running for the same agent) and
   * stream its progress.
   *
   * The body is `{ id }` where `id` is a `z.enum` over the catalog, so an
   * arbitrary package name is refused *here*, by request validation, before
   * any handler logic runs — see `packages/protocol/src/agent-install.ts` for
   * why the closed id set lives in the protocol rather than only in the
   * server's catalog module.
   *
   * Rate-limited because an install is by far the most expensive thing a
   * single authenticated request can start, following the same per-route
   * opt-in the webhook secret routes use. The cap is generous enough that an
   * operator setting up a host never meets it and low enough that a loop
   * cannot spawn installs faster than they can be refused.
   */
  app.post(
    '/api/agents/install',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = InstallAgentRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message:
              'Unknown agent. Install accepts only an id from GET /api/agents/installable — never a package name.',
          },
        });
      }

      // Everything that can fail with a status code fails before the stream
      // opens, exactly as `streamPlannerEvents` arranges for a chat turn:
      // past `openSseStream` the headers are sent and there is no status left.
      let started: { attached: boolean; subscribe: InstallSubscribe };
      try {
        started = agentInstall.start(parsed.data.id, parsed.data.target ?? 'pinned');
      } catch (err) {
        if (err instanceof AgentInstallError) {
          return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }

      // A resumed view asks for everything after the last chunk it rendered,
      // the same `afterSeq` contract terminal replay uses.
      const afterSeq = Number((request.query as { afterSeq?: string }).afterSeq ?? 0);

      // The install is a job and this stream is only a view of it: closing the
      // connection unsubscribes and must never cancel the work. An operator
      // who locks their phone mid-install has not asked to abort it, and a
      // half-finished package tree is worse than either outcome.
      let finish: (() => void) | undefined;
      // Resolving on disconnect as well as on completion matters: without it
      // an abandoned install leaves this handler awaiting a promise nothing
      // will ever settle, so every closed tab leaks one pending request for as
      // long as the process lives.
      // `unsubscribe` is filled in below; `finish` closes over the box so the
      // disconnect handler can detach even though the handler is installed
      // before `subscribe` returns.
      const box: { unsubscribe?: () => void } = {};
      const done = new Promise<void>((resolve) => {
        finish = () => {
          box.unsubscribe?.();
          resolve();
        };
      });
      const stream = openSseStream(request, reply, {
        heartbeatMs: HEARTBEAT_MS,
        onClose: () => finish?.(),
      });

      box.unsubscribe = started.subscribe(
        Number.isFinite(afterSeq) ? Math.max(0, afterSeq) : 0,
        (event) => {
          stream.write(event);
          if (event.kind === 'install_finished') {
            stream.end();
            finish?.();
          }
        },
      );
      // A job that had already finished emits `install_finished` synchronously
      // during `subscribe` above, before `box.unsubscribe` was assigned — so
      // check the stream rather than assume the callback will fire again.
      if (stream.closed) finish?.();
      await done;
    },
  );
};
