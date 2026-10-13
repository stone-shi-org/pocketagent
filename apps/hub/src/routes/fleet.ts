import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  EnableHubFleetRequest,
  MoveHubFleetRequest,
  type HubFleetActionResponse,
  type HubFleetState,
} from '@pocketagent/protocol';
import { FleetError } from '../fleet/service.js';

/**
 * PA-134: the Fleet agent's management routes, behind the Hub session like
 * every other `/api/hub/*` route — the `phm_` bearer is accepted on `/mcp`
 * only, so a coordinator can never reach these (asserted in
 * `fleet-mcp-gate.test.ts`). Every action is a POST so the Origin check covers
 * it, and each answers with the steps it took, because every interesting case
 * here is a partial one (a host that could not be reached for its token).
 */
export const hubFleetRoutes: FastifyPluginAsync = async (app) => {
  const { fleet } = app.hub;

  app.get('/api/hub/fleet', async (): Promise<HubFleetState> => fleet.state());

  app.post('/api/hub/fleet/enable', async (request, reply) => {
    const parsed = EnableHubFleetRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message);
    return run(reply, () => fleet.enable(parsed.data.hostId, parsed.data.hubUrl));
  });

  app.post('/api/hub/fleet/move', async (request, reply) => {
    const parsed = MoveHubFleetRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message);
    return run(reply, () => fleet.move(parsed.data.hostId, parsed.data.hubUrl));
  });

  app.post('/api/hub/fleet/disable', async (_request, reply) => run(reply, () => fleet.disable()));

  async function run(reply: FastifyReply, action: () => Promise<HubFleetActionResponse['steps']>) {
    try {
      const steps = await action();
      const body: HubFleetActionResponse = { fleet: fleet.state(), steps };
      return reply.send(body);
    } catch (err) {
      if (err instanceof FleetError) {
        return reply.code(err.status).send({
          error: { code: err.code, message: err.message },
          steps: err.steps,
          fleet: fleet.state(),
        });
      }
      throw err;
    }
  }
};

function badRequest(reply: FastifyReply, message: string | undefined) {
  return reply.code(400).send({ error: { code: 'bad_request', message: message ?? 'Invalid body.' } });
}
