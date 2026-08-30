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
import { applyRuntimeSettings } from './settings/index.js';
import { createDefaultRegistry } from './agents/registry.js';
import { createBackend, DirectPtyBackend } from './backends/index.js';
import { SessionManager } from './sessions/manager.js';
import { buildChildEnv } from './sessions/env.js';
import { PushService } from './push/index.js';
import { ConversationStore } from './conversations/index.js';
import { AgyTranscriptStore } from './conversations/agy.js';
import { PiTranscriptStore } from './conversations/pi.js';
import { AdoptionService } from './adopt/index.js';
import { ProjectService } from './projects/index.js';
import { WorktreeService } from './git/worktree.js';
import {
  UsageService,
  createClaudeUsageSource,
  createCodexUsageSource,
  createAgyUsageSource,
} from './usage/index.js';
import { CronService } from './cron/index.js';
import { authRoutes } from './routes/auth.js';
import { cronRoutes } from './routes/cron.js';
import { pushRoutes } from './routes/push.js';
import { sessionRoutes } from './routes/sessions.js';
import { settingsRoutes } from './routes/settings.js';
import { usageRoutes } from './routes/usage.js';
import { worktreeRoutes } from './routes/worktrees.js';
import { webhookRoutes } from './routes/webhooks.js';
import { websocketRoutes } from './ws/index.js';
import { WebhookService } from './webhooks/index.js';
import type { PocketContext } from './types.js';

export const VERSION = '0.1.0';


/**
 * Fields scrubbed from every log line.
 *
 * Exported so a test can assert the exact spelling. Bracket-with-quotes syntax
 * is mandatory for any path containing a dash — pino's dotted form silently
 * matches nothing, which is the worst possible failure mode for a redaction
 * rule. `req.body` is redacted wholesale rather than per-field because a webhook
 * payload is untrusted text of unbounded size and is never worth writing to a
 * log at any level.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body.token',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.body',
];

/** Routes reachable without a session cookie. Everything else is closed. */
const PUBLIC_API_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/me']);

/**
 * The one *dynamic* unauthenticated surface: inbound webhook deliveries.
 *
 * `PUBLIC_API_PATHS` stays an exact-string Set — that is its safety property,
 * and turning it into a prefix set is how `/api/auth/logout` accidentally
 * becomes public. A slug cannot be enumerated in advance, so it gets this
 * narrowly-scoped predicate instead.
 *
 * Deliberately its own flat namespace rather than a prefix under
 * `/api/webhooks/`: the management routes live there, and an exemption that has
 * to tell a slug apart from an `:id` (and from `:id/deliveries`) is one bad
 * `startsWith` away from opening `DELETE /api/webhooks/:id` to the internet.
 * Nothing but the delivery route may ever be mounted under `/api/hooks/`, and
 * `grep '/api/hooks/'` must therefore enumerate the whole unauthenticated
 * surface.
 */
const WEBHOOK_DELIVERY_PREFIX = '/api/hooks/';

function isWebhookDelivery(url: string, method: string): boolean {
  // Method-gated, so `GET /api/hooks/foo` still meets the cookie gate and 401s
  // rather than reaching a handler unauthenticated.
  if (method !== 'POST') return false;
  if (!url.startsWith(WEBHOOK_DELIVERY_PREFIX)) return false;
  const slug = url.slice(WEBHOOK_DELIVERY_PREFIX.length);
  // Exactly one non-empty segment: no sub-paths, nothing to smuggle.
  return slug.length > 0 && !slug.includes('/');
}

export interface BuildAppOptions {
  config: Config;
  /** Injected in tests so each run gets an isolated database. */
  db?: Db;
  /** Injected in tests to point at a fixture directory instead of a real `~/.gemini`. */
  agyTranscripts?: AgyTranscriptStore;
  /** Injected in tests to point at a fixture directory instead of a real `~/.pi`. */
  piTranscripts?: PiTranscriptStore;
  serveStatic?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  context: PocketContext;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  // `config` starts as whatever `.env` produced. The database has to open
  // first — `databasePath` itself can never live in it — but everything else
  // in `SETTINGS_FIELDS` is then seeded-once-and-overlaid *before* anything
  // else in this function reads a field off `config`, including Fastify's own
  // `logger.level`/`trustProxy` options below: those are boot-only (Fastify
  // can't be reconfigured after construction), so they must already reflect
  // whatever is persisted as of this boot, not the raw env value.
  let config = options.config;

  // Only close a database we opened. An injected one belongs to the caller,
  // which is what lets a test restart the app against the same data.
  const ownsDb = options.db === undefined;
  const db = options.db ?? openDatabase(config.databasePath);
  purgeExpiredAuthSessions(db);

  // From here on `.env` is no longer consulted for anything in `SETTINGS_FIELDS`
  // — first boot seeds these rows from `config`, every later boot (and every
  // `PATCH /api/settings`) reads/writes only the database.
  config = applyRuntimeSettings(db, config);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      // Terminal traffic is never logged. Only lifecycle events are.
      redact: {
        paths: [...REDACT_PATHS],
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
    opencodeBin: config.opencodeBin,
    codexBin: config.codexBin,
    piBin: config.piBin,
  });

  const backend = createBackend({
    id: config.backend,
    tmuxBin: config.tmuxBin,
    tmuxSocket: config.tmuxSocket,
    // The tmux server is long-lived and inherits whatever we hand it, so it
    // must never see the master token.
    serverEnv: buildChildEnv({ cwd: config.workspaceRoots[0] ?? process.cwd() }),
    logger: app.log,
    ...(config.tmuxSessionScopeSlice !== null ? { tmuxSessionScopeSlice: config.tmuxSessionScopeSlice } : {}),
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
  const agyTranscripts = options.agyTranscripts ?? new AgyTranscriptStore();
  const piTranscripts = options.piTranscripts ?? new PiTranscriptStore();
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

  const projects = new ProjectService({
    workspaces,
    conversations,
    db,
    version: VERSION,
    getCodeServerBaseUrl: () => config.codeServerBaseUrl,
  });
  const worktrees = new WorktreeService({ workspaces });

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
    adoption,
    globalSkipPermissionsDefault: config.globalSkipPermissionsDefault,
    titleFor: (cwd, agentSessionId) => conversations.titleFor(cwd, agentSessionId),
  });
  if (sessions.getGlobalSkipPermissions()) {
    app.log.warn(
      'global skip-permissions switch is ON: every session bypasses approval instead of asking',
    );
  }

  const usage = new UsageService([
    createClaudeUsageSource({
      claudeBin: config.claudeBin,
      cwd: config.workspaceRoots[0] ?? process.cwd(),
      logger: app.log,
    }),
    // Reuses the same shared `codex app-server` process a real Codex session
    // would talk to (starting it on first use) rather than spawning a second
    // one just for usage — see `SessionManager.getCodexServerForUsage`.
    createCodexUsageSource({
      getServer: () => sessions.getCodexServerForUsage(),
      logger: app.log,
    }),
    createAgyUsageSource({
      agyBin: config.agyBin,
      cwd: config.workspaceRoots[0] ?? process.cwd(),
      logger: app.log,
    }),
  ]);

  const cron = new CronService({
    db,
    sessions,
    workspaces,
    worktrees,
    agents,
    logger: app.log,
  });

  const webhooks = new WebhookService({
    db,
    sessions,
    workspaces,
    worktrees,
    agents,
    // Shared with interactive sessions: the service carves a reservation out of
    // this so a Jira delivery storm can never take the user's last slots.
    maxSessions: config.maxSessions,
    logger: app.log,
  });

  const context: PocketContext = {
    config,
    auth,
    sessions,
    cron,
    webhooks,
    workspaces,
    agents,
    db,
    backend,
    push,
    conversations,
    agyTranscripts,
    piTranscripts,
    adoption,
    projects,
    usage,
    worktrees,
  };
  app.decorate('pocket', context);

  const { interrupted, recovered } = await sessions.init();
  if (recovered > 0) app.log.info({ recovered }, 'reattached to sessions from a previous run');
  if (interrupted > 0) {
    app.log.info({ interrupted }, 'marked sessions interrupted after restart');
  }

  // After `sessions.init()`: this reconciles cron run rows against an
  // already-reconciled session table, and its first tick can create a session.
  await cron.init();

  // Same ordering reason as cron's: this reconciles delivery rows against an
  // already-reconciled session table.
  webhooks.init();

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

    // Inbound webhook deliveries authenticate themselves, by HMAC over the raw
    // body, inside the handler.
    //
    // This must sit *above* the Origin check as well as the cookie check, and
    // that is not an oversight to be tidied up later: a Jira Data Center webhook
    // sends neither an Origin nor a cookie. The Origin gate exists to stop a
    // *browser* being used as a confused deputy, which is irrelevant to a
    // server-to-server POST whose authenticity comes from a signature over the
    // payload instead. Re-adding either check here rejects every real delivery.
    if (isWebhookDelivery(url, request.method)) return;

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
  await app.register(worktreeRoutes);
  await app.register(cronRoutes);
  await app.register(webhookRoutes);
  await app.register(settingsRoutes);
  await app.register(pushRoutes);
  await app.register(usageRoutes);
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
    usage.stop();
    // Before `sessions.shutdown()`: no new run may be started into a manager
    // that is already tearing down.
    cron.stop();
    webhooks.stop();
    await sessions.shutdown();
    if (ownsDb) db.close();
  });

  return { app, context };
}
