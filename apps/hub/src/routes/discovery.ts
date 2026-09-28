import type { FastifyPluginAsync } from 'fastify';
import type { HubDiscoveryResponse } from '@pocketagent/protocol';

/**
 * How long a refresh waits for answers before replying. A LAN answers an mDNS
 * query in milliseconds; RFC 6762 §6 lets a responder delay up to 500 ms, and
 * a second pass after that is what a human pressing "Scan again" expects to
 * have been covered.
 */
export const DISCOVERY_REFRESH_WAIT_MS = 1500;

/**
 * `GET /api/hub/discovery` and its refresh (PA-110).
 *
 * Both sit behind the Hub's one `onRequest` gate like every other `/api/hub/*`
 * route — a list of machines on the operator's network is not something to
 * hand an unauthenticated caller. The refresh is a POST, so the Origin check
 * covers it, even though the only thing it does is send one multicast query.
 */
export const hubDiscoveryRoutes: FastifyPluginAsync<{ refreshWaitMs?: number }> = async (app, opts) => {
  const { discovery } = app.hub;
  const wait = opts.refreshWaitMs ?? DISCOVERY_REFRESH_WAIT_MS;

  app.get('/api/hub/discovery', async (): Promise<HubDiscoveryResponse> => discovery.snapshot());

  app.post('/api/hub/discovery/refresh', async (): Promise<HubDiscoveryResponse> => {
    discovery.refresh();
    await new Promise((resolve) => setTimeout(resolve, wait));
    return discovery.snapshot();
  });
};
