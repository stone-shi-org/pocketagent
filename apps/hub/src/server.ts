import type { FastifyInstance } from 'fastify';
import { buildHubApp } from './app.js';
import { HubConfigError, loadHubConfig } from './config.js';
import { HUB_VERSION, HUB_VERSION_WARNING } from './version.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadHubConfig();
  } catch (error) {
    if (error instanceof HubConfigError) {
      console.error(`\nPocketAgent Hub configuration error:\n\n${error.message}\n`);
      // 78 is EX_CONFIG, the same status `apps/server/src/server.ts` exits
      // with for the same class of problem — a supervisor can tell "this will
      // never start until a human edits something" from "this crashed".
      process.exit(78);
    }
    throw error;
  }

  const { app } = await buildHubApp({ config });
  if (HUB_VERSION_WARNING !== null) app.log.warn(HUB_VERSION_WARNING);

  await app.listen({ host: config.host, port: config.port });
  // Logged at boot for the same reason the backend logs its data root: when a
  // Hub behaves as though it has someone else's registry, this is the first
  // line to check.
  app.log.info(
    { version: HUB_VERSION, dataDir: config.dataDir, host: config.host, port: config.port },
    'pocketagent hub listening',
  );
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    app.log.warn(
      { host: config.host },
      'the Hub is bound to a non-loopback address; it reaches every bound backend, so put TLS in front of it',
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await Promise.race([app.close(), forcedExitAfter(app, SHUTDOWN_TIMEOUT_MS)]);
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * Belt-and-suspenders around `app.close()` above — mirrors
 * `apps/server/src/server.ts`'s own constant of the same name and for the
 * same reason (duplicated rather than shared, like `EX_CONFIG` above: the two
 * are separate deployables and this file must not depend on `apps/server`).
 * A spliced WS proxy connection is this Hub's normal steady state, not an
 * edge case, so it is the most exposed of any known way to hang
 * `app.close()` — see `apps/hub/src/app.ts`'s `preClose` hook, which is what
 * actually fixes that case. This is the fallback for the next one.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

function forcedExitAfter(app: FastifyInstance, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      app.log.warn(
        { timeoutMs: ms },
        'app.close() did not resolve in time; forcing exit rather than waiting for systemd to SIGKILL',
      );
      resolve();
    }, ms);
    timer.unref?.();
  });
}

void main();
