import type { FastifyPluginAsync } from 'fastify';

/**
 * Rate-limit usage for every agent that knows how to report its own — today
 * Claude and Codex — for the status area next to `HostChip`. The first
 * request after boot primes each source (spawning `claude`, and starting
 * `codex app-server` if not already running); every one after that just
 * reads the cache — see `UsageService`.
 */
export const usageRoutes: FastifyPluginAsync = async (app) => {
  const { usage } = app.pocket;

  app.get('/api/usage', async () => ({ usage: await usage.list() }));
};
