import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildHubApp, type HubContext } from '../src/app.js';
import type { HubConfig } from '../src/config.js';
import { openHubDatabase } from '../src/db.js';

export const HUB_TOKEN = 'hub-test-token-that-is-long-enough-123';
export const MASTER_TOKEN = 'backend-master-token-long-enough-1234567';

/** A 32-byte base64 key, the shape `POCKETAGENT_SETTINGS_ENC_KEY` takes. */
export function testEncKey(): Buffer {
  return crypto.randomBytes(32);
}

export function makeHubConfig(overrides: Partial<HubConfig> = {}): HubConfig {
  return {
    nodeEnv: 'test',
    isProduction: false,
    logLevel: 'silent',
    host: '127.0.0.1',
    port: 0,
    authToken: HUB_TOKEN,
    sessionTtlMs: 3600_000,
    dataDir: '/tmp/pa-hub-test',
    databasePath: ':memory:',
    settingsEncKey: testEncKey(),
    allowedOrigins: null,
    cookieSecure: false,
    trustProxy: false,
    webDistPath: '/nonexistent-web-dist',
    latestRelease: null,
    ...overrides,
  };
}

export interface TestHub {
  app: FastifyInstance;
  context: HubContext;
  baseUrl: string;
  /** A `Cookie` header for an authenticated operator session. */
  cookie: string;
  cleanup: () => Promise<void>;
}

/**
 * Boot a Hub on a real ephemeral port.
 *
 * Real, not `app.inject()`, because the thing most worth testing here cannot
 * be injected: a TCP splice has no Fastify request lifecycle to hook into.
 * Using one transport for every suite also means the HTTP tests exercise the
 * same server the WebSocket tests do, rather than a second configuration that
 * only resembles it.
 */
export async function createTestHub(
  options: { config?: Partial<HubConfig>; fetchImpl?: typeof fetch } = {},
): Promise<TestHub> {
  const config = makeHubConfig(options.config ?? {});
  const db = openHubDatabase(':memory:');
  const { app, context } = await buildHubApp({
    config,
    db,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    serveStatic: false,
    // Off by default: a suite that wants health behaviour starts it itself,
    // and the rest should not have background probes racing their assertions.
    startHealthPoller: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: config.authToken }),
  });
  const setCookie = login.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';

  return {
    app,
    context,
    baseUrl,
    cookie,
    cleanup: async () => {
      await app.close();
    },
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface StubBackend {
  baseUrl: string;
  /** Every HTTP request that actually reached this process. */
  requests: RecordedRequest[];
  /** Every WebSocket upgrade that reached it, with the messages exchanged. */
  wsConnections: { url: string; headers: http.IncomingHttpHeaders }[];
  /** What the next HTTP request should be answered with. */
  respondWith: (handler: StubHandler) => void;
  /** Echo server behaviour for a spliced socket. */
  onSocket: (fn: (socket: WebSocket) => void) => void;
  close: () => Promise<void>;
}

export type StubHandler = (
  request: RecordedRequest,
  response: http.ServerResponse,
) => void;

/**
 * A backend that records exactly what reached it.
 *
 * Deliberately raw `node:http` plus `ws` rather than a real PocketAgent
 * server, for the assertions these suites actually make: "the Hub never dialed
 * this at all" needs a request *counter*, and "the body arrived byte-identical"
 * needs the raw buffer before any framework has touched it. `bind.test.ts` is
 * the one suite that talks to the real backend instead, because the thing it
 * verifies is the PA-63 contract rather than the proxy.
 */
export async function startStubBackend(): Promise<StubBackend> {
  const requests: RecordedRequest[] = [];
  const wsConnections: { url: string; headers: http.IncomingHttpHeaders }[] = [];
  let handler: StubHandler = (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  };
  let socketHandler: (socket: WebSocket) => void = (socket) => {
    // Echo, preserving binary-ness, so a test can assert byte identity.
    socket.on('message', (data: Buffer, isBinary: boolean) => socket.send(data, { binary: isBinary }));
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      handler(recorded, response);
    });
  });

  // `perMessageDeflate` on, because the splice has to survive a negotiated
  // extension it is not a party to — that is the strongest available evidence
  // that the Hub is not reframing anything.
  const wss = new WebSocketServer({ server, perMessageDeflate: true });
  wss.on('connection', (socket, request) => {
    wsConnections.push({ url: request.url ?? '/', headers: request.headers });
    socketHandler(socket);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    wsConnections,
    respondWith: (fn) => {
      handler = fn;
    },
    onSocket: (fn) => {
      socketHandler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}

/** Register and bind a host, without going through the real bind handshake. */
export function registerHost(
  hub: TestHub,
  entry: { id: string; label?: string; baseUrl: string; credential?: string },
): void {
  hub.context.registry.create({
    id: entry.id,
    label: entry.label ?? entry.id,
    baseUrl: entry.baseUrl,
  });
  hub.context.registry.bind(
    entry.id,
    { id: `cred-${entry.id}`, token: entry.credential ?? `pah_${entry.id}-token` },
    null,
  );
}
