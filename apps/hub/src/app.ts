import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { isOriginAllowed } from '@pocketagent/node-kit';
import { SERVER_PROTOCOL_RANGE, type HealthResponse } from '@pocketagent/protocol';
import { HubAuthService, HUB_AUTH_COOKIE_NAME } from './auth.js';
import type { HubConfig } from './config.js';
import { openHubDatabase, purgeExpiredHubSessions, type HubDb } from './db.js';
import { HealthPoller } from './registry/health.js';
import { HostRegistry } from './registry/store.js';
import { hubAuthRoutes } from './routes/auth.js';
import { hubHostRoutes } from './routes/hosts.js';
import { hubTemplateRoutes } from './routes/templates.js';
import { hubPushRoutes } from './routes/push.js';
import { HubPushService } from './push/service.js';
import { PushNotificationRelay } from './push/relay.js';
import { Provisioner } from './templates/provisioner.js';
import { TemplateStore } from './templates/store.js';
import { resolveProxyTarget } from './proxy/allowlist.js';
import { proxyHttp } from './proxy/http.js';
import { SocketRegistry } from './proxy/sockets.js';
import { refuseUpgrade, spliceWebSocket } from './proxy/ws.js';
import { HUB_VERSION } from './version.js';

/**
 * Copied verbatim from `apps/server/src/app.ts`, not re-derived.
 *
 * `authorization` is the important one here and it is already present: the Hub
 * *presents* a backend credential on every proxied request, so "nothing logs
 * the credential" has to hold on this side too — and it holds by construction
 * rather than by a rule someone has to remember, which is the same property
 * PA-63 arranged on the backend.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.body.token',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.body',
];

/**
 * The Hub's unauthenticated surface, and it is deliberately smaller than the
 * backend's.
 *
 * Three entries, not four: there is no `hub-bind` here, because binding is
 * something the *operator* does from inside an authenticated session, not
 * something an unauthenticated caller presents a token for. Like the
 * backend's, this stays an exact-string `Set` — turning it into a prefix set
 * is how `/api/auth/logout` accidentally becomes public.
 *
 * Note what is absent and must stay absent: nothing under `/h/`. A proxied
 * request always requires a Hub session, including `/h/<id>/health`, so the
 * Hub never becomes an unauthenticated reachability scanner for whoever can
 * reach the port.
 */
const PUBLIC_API_PATHS = new Set(['/health', '/api/auth/login', '/api/auth/me']);

export interface HubContext {
  readonly config: HubConfig;
  readonly db: HubDb;
  readonly auth: HubAuthService;
  readonly registry: HostRegistry;
  readonly health: HealthPoller;
  readonly sockets: SocketRegistry;
  /** PA-70: config templates, and the ledger of what was provisioned where. */
  readonly templates: TemplateStore;
  readonly provisioner: Provisioner;
  readonly fetchImpl: typeof fetch;
  /** PA-73: Hub Web Push service and bound backend notification relay. */
  readonly push: HubPushService;
  readonly pushRelay: PushNotificationRelay;
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: HubContext;
  }
}

export interface BuildHubOptions {
  readonly config: HubConfig;
  readonly db?: HubDb;
  /** Injected so a test never makes a real outbound call. */
  readonly fetchImpl?: typeof fetch;
  readonly serveStatic?: boolean;
  /** Disabled in tests that assert on the registry without a live poller. */
  readonly startHealthPoller?: boolean;
  /** Disabled in tests that assert without a live push relay. */
  readonly startPushRelay?: boolean;
}

export interface BuiltHub {
  readonly app: FastifyInstance;
  readonly context: HubContext;
}

export async function buildHubApp(options: BuildHubOptions): Promise<BuiltHub> {
  const { config } = options;
  const ownsDb = options.db === undefined;
  const db = options.db ?? openHubDatabase(config.databasePath);
  purgeExpiredHubSessions(db);

  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
      transport: config.isProduction
        ? undefined
        : { target: 'pino/file', options: { destination: 1 } },
    },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    // No per-request access log, as on the backend. `/h/*` gets one open and
    // one close line per socket from the splice instead — and by construction
    // there is no code path that could log a frame.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const fetchImpl = options.fetchImpl ?? fetch;
  const registry = new HostRegistry(db, config.settingsEncKey);
  const sockets = new SocketRegistry();
  const health = new HealthPoller({ registry, fetchImpl, log: app.log });
  const auth = new HubAuthService(db, config.authToken, config.sessionTtlMs);
  const templates = new TemplateStore(db);
  const provisioner = new Provisioner({ registry, store: templates, fetchImpl, log: app.log });
  const push = new HubPushService(db, app.log);
  push.init(config.pushContact);
  const pushRelay = new PushNotificationRelay({ registry, pushService: push, fetchImpl, log: app.log });

  const context: HubContext = {
    config,
    db,
    auth,
    registry,
    health,
    sockets,
    templates,
    provisioner,
    fetchImpl,
    push,
    pushRelay,
  };
  app.decorate('hub', context);

  await app.register(cookie);
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  // ---- Security headers -----------------------------------------------------
  // Identical to the backend's, because the Hub serves the identical bundle:
  // the same xterm inline styles, the same `ws:`/`wss:` connect-src.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
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
  /**
   * One gate, exactly as the backend has one, and for the sharper version of
   * the same reason: `/h/**` is a wildcard onto someone else's whole API, so a
   * route here that could acquire its own auth path is a route that could
   * acquire a weaker one. The upgrade handler below calls the same helpers
   * rather than repeating the logic.
   *
   * Note there is no bearer branch. A Hub *presents* credentials; it does not
   * accept them. Adding one would make the Hub itself a thing that can be
   * fronted, which nothing asks for and which would need its own revocation
   * story.
   */
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/') && !url.startsWith('/h/') && url !== '/health') return;
    if (PUBLIC_API_PATHS.has(url)) return;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // The CSRF boundary lives here now. A proxied request reaches its
      // backend with `Origin` stripped (see `proxy/headers.ts`), so this is
      // the only place an ambient-cookie request is checked — the check did
      // not disappear when the header did, it moved to where the cookie is.
      if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
        return reply
          .code(403)
          .send({ error: { code: 'forbidden_origin', message: 'Origin not allowed.' } });
      }
    }

    if (auth.validateSession(request.cookies[HUB_AUTH_COOKIE_NAME])) return;

    return reply
      .code(401)
      .send({ error: { code: 'unauthorized', message: 'Authentication required.' } });
  });

  // ---- The Hub's own routes -------------------------------------------------
  const startedAt = Date.now();
  app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    version: HUB_VERSION,
    // The Hub speaks no wire protocol of its own — it forwards frames it never
    // parses — so what it can honestly advertise is the range of the protocol
    // package it was built against. Reported so a monitor can see this process
    // is alive; a browser negotiates against each *host*, never against this.
    protocol: SERVER_PROTOCOL_RANGE,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  await app.register(hubAuthRoutes);
  await app.register(hubHostRoutes);
  await app.register(hubTemplateRoutes);
  await app.register(hubPushRoutes);

  // ---- The proxy ------------------------------------------------------------
  /**
   * Its own plugin scope for the same reason `routes/webhook-delivery.ts` is
   * one on the backend: content-type parsers are encapsulated per scope, so
   * removing them here leaves every sibling route — including the registry
   * CRUD above, which takes JSON bodies — parsing exactly as before. What it
   * buys is different, though. There the point was to *verify* a signature
   * over the received bytes; here it is to *re-send* them, and a body that has
   * been through `JSON.parse` and back is not the body that arrived.
   */
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_request, payload, done) => {
      done(null, payload);
    });

    const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const target = resolveProxyTarget(request.url);
      if (target.kind !== 'proxy') {
        // Everything that is not a live proxy route answers one 404. A
        // rejected path, an unknown host and a disabled host are deliberately
        // indistinguishable — the same posture the backend takes for an
        // unknown slug, so that being able to reach the Hub does not let
        // someone enumerate which machines are behind it.
        return void reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      const resolved = registry.resolve(target.hostId);
      if (resolved === null) {
        return void reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      if (resolved.credential === null) {
        // Never dial without a credential: the backend would answer 401 and
        // the failure would read as the backend's fault rather than as "this
        // host was never bound, or the encryption key was rotated".
        return void reply.code(409).send({
          error: {
            code: 'host_not_bound',
            message: `${resolved.row.label} has no usable credential. Bind it again from the Hub.`,
          },
        });
      }
      await proxyHttp(request, reply, {
        baseUrl: resolved.row.base_url,
        credential: resolved.credential,
        upstreamPath: target.upstreamPath,
        hostId: resolved.row.id,
        // The bare-root mount (D6b) has no prefix, so a rewritten `Location`
        // there is the backend's own path unchanged — which is right: that is
        // exactly how the unmodified single-host bundle addresses it.
        basePath: target.hostId === null ? '' : `/h/${target.hostId}`,
      });
    };

    scope.all('/h/*', handler);
    // PA-66 D6b: the default host is also mounted at the bare root, so the
    // unmodified single-host bundle — whose `DEFAULT_HOST.basePath` is `''` —
    // works through the Hub with no client change at all. That is what makes
    // this service shippable before PA-67's picker has anything to pick, and
    // it is the broadest regression test the proxy has: every existing browser
    // demo can be pointed at the Hub and must behave identically.
    scope.all('/api/*', handler);
  });

  // ---- The WebSocket upgrade ------------------------------------------------
  /**
   * Attached to the raw server rather than registered as a route, because the
   * splice must happen below Fastify: there is no `@fastify/websocket` here
   * and deliberately no WebSocket library at all. See `proxy/ws.ts`.
   */
  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const target = resolveProxyTarget(request.url ?? '/');
    if (target.kind !== 'proxy') {
      return refuseUpgrade(socket, 404, 'Not Found');
    }
    // The same gate the HTTP path runs, called rather than re-derived. An
    // upgrade carries a cookie like any other request, so there is no reason
    // for it to be checked differently — and every reason for it not to be.
    const cookies = app.parseCookie(request.headers.cookie ?? '');
    if (!auth.validateSession(cookies[HUB_AUTH_COOKIE_NAME])) {
      return refuseUpgrade(socket, 401, 'Unauthorized');
    }
    if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
      return refuseUpgrade(socket, 403, 'Forbidden');
    }
    const resolved = registry.resolve(target.hostId);
    if (resolved === null) return refuseUpgrade(socket, 404, 'Not Found');
    if (resolved.credential === null) return refuseUpgrade(socket, 409, 'Host Not Bound');

    spliceWebSocket(request, socket, head, {
      baseUrl: resolved.row.base_url,
      credential: resolved.credential,
      upstreamPath: target.upstreamPath,
      hostId: resolved.row.id,
      clientIp: request.socket.remoteAddress,
      clientProto: 'http',
      sockets,
      log: app.log,
    });
  });

  // ---- Static frontend ------------------------------------------------------
  // The same bundle the backend serves, served the same way — including the
  // read-index-once rule, which means the Hub inherits CLAUDE.md's "rebuild
  // *then* restart" caveat verbatim.
  const shouldServeStatic = options.serveStatic ?? fs.existsSync(config.webDistPath);
  if (shouldServeStatic && fs.existsSync(config.webDistPath)) {
    await app.register(fastifyStatic, { root: config.webDistPath, index: false });
    const indexHtml = fs.readFileSync(path.join(config.webDistPath, 'index.html'));
    const sendIndex = (reply: FastifyReply): FastifyReply =>
      reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(indexHtml);
    app.get('/', async (_request, reply) => sendIndex(reply));
    app.setNotFoundHandler(async (request, reply) => {
      // `/h/` joins `/api/` here: a path under a host prefix that reached the
      // not-found handler is a *refused proxy path*, and answering it with the
      // SPA shell and a 200 would make a refusal indistinguishable from a
      // route that exists — the exact oracle the backend avoids by keeping
      // `/api/hooks/` under `/api/`.
      if (request.url.startsWith('/api/') || request.url.startsWith('/h/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return sendIndex(reply);
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/h/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return reply
        .code(404)
        .type('text/plain')
        .send('The web UI has not been built.\n\nRun `pnpm build`.\n');
    });
  }

  // Not awaited: boot must not block on a backend that is down. The first
  // sweep lands within a moment and the list simply reads "never checked"
  // until it does.
  if (options.startHealthPoller !== false) void health.start();
  if (options.startPushRelay !== false) void pushRelay.start();

  app.addHook('onClose', async () => {
    health.stop();
    pushRelay.stop();
    sockets.closeAll();
    if (ownsDb) db.close();
  });

  return { app, context };
}
