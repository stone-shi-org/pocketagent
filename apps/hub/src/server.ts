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

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
