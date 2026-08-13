import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { AUTH_COOKIE_NAME, LIMITS } from '@pocketagent/protocol';
import type { Config } from './config/index.js';
import { AuthService, isOriginAllowed } from './auth/index.js';
import {
  deleteWorkspace,
  insertWorkspace,
  openDatabase,
  purgeExpiredAuthSessions,
  readSetting,
  readWorkspaces,
  writeSetting,
  type Db,
} from './db/index.js';
import { WorkspaceRegistry, createWorkspaceStore } from './workspaces/index.js';
import { createDefaultRegistry } from './agents/registry.js';
import { createBackend, DirectPtyBackend } from './backends/index.js';
import { SessionManager } from './sessions/manager.js';
import { buildChildEnv } from './sessions/env.js';
import { PushService } from './push/index.js';
import { ConversationStore } from './conversations/index.js';
import { AdoptionService } from './adopt/index.js';
import { ProjectService } from './projects/index.js';
import { authRoutes } from './routes/auth.js';
import { pushRoutes } from './routes/push.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { websocketRoutes } from './ws/index.js';
import type { PocketContext } from './types.js';

export const VERSION = '0.1.0';


/** Routes reachable without a session cookie. Everything else is closed. */
const PUBLIC_API_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/me']);

export interface BuildAppOptions {
  config: Config;
  /** Injected in tests so each run gets an isolated database. */
  db?: Db;
  serveStatic?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  context: PocketContext;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { config } = options;

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Terminal traffic is never logged. Only lifecycle events are.
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'req.body.token'],
        censor: '[redacted]',
      },
      transport: config.isProduction
        ? undefined
        : { target: 'pino/file', options: { destination: 1 } },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // Per-request access logs are off: they add little for a single-user tool,
    // and every terminal WebSocket would write a line naming a session the user
    // may not want on disk. Lifecycle events are logged explicitly instead.
    logController: new LogController({ disableRequestLogging: true }),
  });

  // Only close a database we opened. An injected one belongs to the caller,
  // which is what lets a test restart the app against the same data.
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(config.databasePath);
  purgeExpiredAuthSessions(db);

  const auth = new AuthService(db, config.authToken, config.sessionTtlMs);
  const workspaces = new WorkspaceRegistry(
    config.workspaceRoots,
    createWorkspaceStore({
      read: (key) => readSetting(db, key),
      write: (key, value) => writeSetting(db, key, value),
      list: () => readWorkspaces(db),
      insert: (path) => insertWorkspace(db, path),
      delete: (path) => deleteWorkspace(db, path),
    }),
  );
  if (workspaces.getRoots().length === 0) {
    app.log.warn(
      'No project folders yet. Add one from the app, or set ' +
        'POCKETAGENT_WORKSPACE_ROOTS to seed the list on a fresh database.',
    );
  }
  const agents = createDefaultRegistry({
    shell: config.shell,
    claudeBin: config.claudeBin,
    agyBin: config.agyBin,
  });

  const backend = createBackend({
    id: config.backend,
    tmuxBin: config.tmuxBin,
    tmuxSocket: config.tmuxSocket,
    // The tmux server is long-lived and inherits whatever we hand it, so it
    // must never see the master token.
    serverEnv: buildChildEnv({ cwd: config.workspaceRoots[0] ?? process.cwd() }),
    logger: app.log,
  });

  const backendStatus = await backend.checkAvailable();
  if (!backendStatus.available) {
    throw new Error(
      `Process backend "${backend.id}" is unavailable: ${backendStatus.reason ?? 'unknown reason'}`,
    );
  }

  const push = new PushService(db, app.log);
  push.init(config.pushContact);

  const childEnv = buildChildEnv({ cwd: config.workspaceRoots[0] ?? process.cwd() });
  const conversations = new ConversationStore({ workspaces });
  const adoption = new AdoptionService({
    socket: config.adoptTmuxSocket,
    bin: config.tmuxBin,
    workspaces,
    env: childEnv,
  });
  if (adoption.isEnabled()) {
    app.log.warn(
      { socket: config.adoptTmuxSocket },
      'tmux adoption is enabled: panes on that socket whose cwd is inside a ' +
        'workspace root can be attached from the browser',
    );
  }

  const projects = new ProjectService({ workspaces, conversations, db, version: VERSION });

  const sessions = new SessionManager({
    db,
    agents,
    workspaces,
    backend,
    directBackend: new DirectPtyBackend(),
    push,
    maxSessions: config.maxSessions,
    outputBufferBytes: config.outputBufferBytes,
    idleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
    logger: app.log,
    globalSkipPermissionsDefault: config.globalSkipPermissionsDefault,
    titleFor: (cwd, agentSessionId) => conversations.titleFor(cwd, agentSessionId),
  });
  if (sessions.getGlobalSkipPermissions()) {
    app.log.warn(
      'global skip-permissions switch is ON: every session bypasses approval instead of asking',
    );
  }

  const context: PocketContext = {
    config,
    auth,
    sessions,
    workspaces,
    agents,
    db,
    backend,
    push,
    conversations,
    adoption,
    projects,
  };
  app.decorate('pocket', context);

  const { interrupted, recovered } = await sessions.init();
  if (recovered > 0) app.log.info({ recovered }, 'reattached to sessions from a previous run');
  if (interrupted > 0) {
    app.log.info({ interrupted }, 'marked sessions interrupted after restart');
  }

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });
  await app.register(websocket, {
    options: { maxPayload: LIMITS.maxMessageBytes },
  });

  // ---- Security headers -----------------------------------------------------
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        // xterm.js injects inline styles for cell rendering.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: wss:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    return payload;
  });

  // ---- Authentication -------------------------------------------------------
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? '';

    // Static assets and the SPA shell are public; they contain no secrets and
    // the login screen has to be reachable.
    if (!url.startsWith('/api/') && url !== '/health') return;

    if (PUBLIC_API_PATHS.has(url)) return;

    // CSRF: SameSite=Strict already blocks cross-site cookie sends, but browsers
    // vary. An explicit Origin check on state-changing verbs closes the gap.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }
    }

    const session = auth.validateSession(request.cookies[AUTH_COOKIE_NAME]);
    if (!session) {
      return reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'Authentication required.' } });
    }
  });

  // ---- Routes ---------------------------------------------------------------
  const startedAt = Date.now();
  app.get('/health', async () => ({
    status: 'ok' as const,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  }));

  await app.register(authRoutes);
  await app.register(sessionRoutes);
  await app.register(settingsRoutes);
  await app.register(pushRoutes);
  await app.register(websocketRoutes);

  // ---- Static frontend ------------------------------------------------------
  const shouldServeStatic = options.serveStatic ?? fs.existsSync(config.webDistPath);
  if (shouldServeStatic && fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, { root: config.webDistPath, index: false });

    // Read once: index.html cannot change while the process is running.
    const indexHtml = fs.readFileSync(path.join(config.webDistPath, 'index.html'));
    const sendIndex = (reply: FastifyReply): FastifyReply =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(indexHtml);

    // `index: false` above makes @fastify/static answer 403 for a directory, so
    // the SPA shell is served explicitly rather than by directory listing.
    app.get('/', async (_request, reply) => sendIndex(reply));

    // Deep links such as /#/s/abc are client-routed; anything that is not an
    // API path falls back to the shell.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return sendIndex(reply);
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return reply
        .code(404)
        .type('text/plain')
        .send(
          'The web UI has not been built.\n\n' +
            'Run `pnpm build` for a single-process deployment, or `pnpm dev` and use the Vite dev server.\n',
        );
    });
  }

  app.addHook('onClose', async () => {
    await sessions.shutdown();
    if (ownsDb) db.close();
  });

  return { app, context };
}
