import { buildApp, VERSION } from './app.js';
import { loadConfig, ConfigError } from './config/index.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\nPocketAgent configuration error\n\n${err.message}\n\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const { app, context } = await buildApp({ config });
  // `buildApp` may have overlaid `config` with persisted settings-table values
  // (see `applyRuntimeSettings`) — log the effective ones, not the raw env.
  const effective = context.config;

  await app.listen({ host: config.host, port: config.port });

  app.log.info(
    {
      version: VERSION,
      url: `http://${config.host}:${config.port}/`,
      workspaceRoots: effective.workspaceRoots,
      maxSessions: effective.maxSessions,
    },
    'PocketAgent listening',
  );

  if (config.isNetworkExposed) {
    app.log.warn(
      { host: config.host },
      'PocketAgent is bound to a non-loopback address. Anyone who reaches this port ' +
        'and holds the access token gets terminal access to this machine. Put it behind ' +
        'Tailscale/WireGuard or an HTTPS reverse proxy.',
    );
    if (!effective.cookieSecure) {
      app.log.warn(
        'Auth cookie is not marked Secure. Set POCKETAGENT_COOKIE_SECURE=true when serving over HTTPS.',
      );
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down; terminating PTY sessions');
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`PocketAgent failed to start: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
