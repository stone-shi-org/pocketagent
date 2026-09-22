import type { FastifyInstance } from 'fastify';
import { buildApp, VERSION } from './app.js';
import { RESTART_EXIT_CODE } from './admin/index.js';
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
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal, exitCode }, 'shutting down; terminating PTY sessions');
    try {
      await Promise.race([app.close(), forcedExitAfter(app, SHUTDOWN_TIMEOUT_MS)]);
    } finally {
      process.exit(exitCode);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // PA-69: `POST /api/admin/restart`. The decision about whether stopping is
  // safe is `AdminService`'s; this is only the act, and it lives here because
  // `buildApp` is what every test calls — a `process.exit` reachable from it
  // would kill the test runner.
  context.admin.setRestartHook(({ forced }) => {
    // The 202 has been written to the socket but not necessarily flushed, and
    // `app.close()` tears the HTTP server down. Without this grace an operator
    // gets a dropped connection and cannot tell "accepted" from "refused" from
    // "already gone" — which, for the one action whose whole purpose is to stop
    // the process, is the difference between a confirmation and a mystery.
    setTimeout(() => {
      app.log.warn(
        { forced, exitCode: RESTART_EXIT_CODE },
        // Said out loud because the exit status is deliberately non-zero: the
        // journal will show this unit as "failed", and the next line an
        // operator reads should explain why rather than look like a crash.
        // Non-zero is what makes `Restart=on-failure` — this repo's own
        // recommended unit, and what production uses — actually restart it.
        'draining for a requested restart; exiting non-zero so the supervisor restarts us',
      );
      void shutdown('api-restart', RESTART_EXIT_CODE);
    }, RESPONSE_FLUSH_GRACE_MS);
  });
}

/**
 * Long enough for a 202 to reach the client, short enough that an operator
 * does not wonder whether the request worked. The response is small and the
 * caller is usually on the same machine or a tailnet.
 */
const RESPONSE_FLUSH_GRACE_MS = 250;

/**
 * Belt-and-suspenders around `app.close()` in `shutdown()` above. Every known
 * way to hang it — a held-open SSE stream, an attached browser WebSocket, a
 * plain keep-alive HTTP connection — already ends itself via its own
 * `preClose` hook (`push.ts`, `ws/index.ts`, `app.ts`), because Fastify's own
 * internal shutdown calls the underlying `http.Server.close()`, which does
 * not resolve while any connection stays open and non-idle. Without a bound
 * here, a *future* hook that misses this and hangs `app.close()` would wait
 * out systemd's `TimeoutStopSec` (90s by default, unset in the recommended
 * unit) before a SIGKILL forces the restart through — which on the next boot
 * reads as "refuses to start" rather than as a slow stop, and is exactly the
 * incident this constant exists to keep from recurring. Long enough that a
 * healthy shutdown (normally milliseconds) never races it.
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

main().catch((err) => {
  process.stderr.write(`PocketAgent failed to start: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
