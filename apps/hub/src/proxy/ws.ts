import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';
import { upstreamHeaders } from './headers.js';
import type { SocketRegistry } from './sockets.js';

/**
 * How long to wait for a backend to answer an upgrade handshake.
 *
 * Deliberately bounded, unlike everything about an *established* session:
 * see `abandonDial` for why a stalled handshake is not work in progress.
 */
export const DIAL_TIMEOUT_MS = 10_000;

export interface WsSpliceOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly upstreamPath: string;
  readonly hostId: string;
  readonly clientIp: string | undefined;
  readonly clientProto: string;
  readonly sockets: SocketRegistry;
  readonly log: {
    info: (obj: unknown, msg: string) => void;
    warn: (obj: unknown, msg: string) => void;
  };
}

/** `net.Socket.setNoDelay`, if this duplex happens to be one. */
function setNoDelay(socket: Duplex): void {
  const candidate = socket as Duplex & { setNoDelay?: (value: boolean) => void };
  candidate.setNoDelay?.(true);
}

/**
 * Refuse an upgrade before anything upstream is dialed.
 *
 * The destroy waits on the write callback: `destroy()` discards whatever is
 * still queued, so calling it straight after `write()` can drop the status
 * line and present to the browser as a bare connection reset instead of the
 * 401/403/404 that says why. Small enough to usually flush first, which is
 * exactly what makes it the kind of bug that shows up only under load.
 */
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/**
 * Splice a WebSocket through to a backend at the TCP level.
 *
 * This is PA-66's second hard constraint, and the shape of the solution is the
 * argument for it. "Terminal I/O is never logged or persisted" now has to hold
 * in a second process, and the way to make that true is not to be careful — it
 * is to have nothing that *could* log a frame.
 *
 * So the Hub has no WebSocket library on this path. It does not construct a
 * `WebSocket`, never sees a `message` event, owns no frame parser, and takes
 * no part in the `permessage-deflate` negotiation (the extension header passes
 * through untouched, so compression is agreed end to end between the browser
 * and the backend, and the Hub could not decompress a frame if it wanted to).
 * Once the 101 is relayed, the two sockets are `pipe()`d and the Hub is a pair
 * of file descriptors. Backpressure, fragmentation, ping/pong, binary/text and
 * close codes are all *not handled* — which is precisely correct, because none
 * of them are the Hub's to interpret. PA-61's 4001 protocol-mismatch close and
 * its reason string therefore reach the browser byte-identical.
 *
 * The one thing that *is* rewritten is the handshake head, and that is stated
 * rather than hidden: the Hub authors the upstream request line and headers
 * (host, credential, stripped cookie and Origin — see `headers.ts`). The
 * frames are the dumb pipe; the handshake is not.
 *
 * Rejected alternative: `ws` in `noServer` mode with a client `WebSocket` and
 * `on('message')` forwarding. That decodes and re-encodes every frame, which
 * makes "must not inspect" a convention someone has to keep rather than a
 * property of the code, has to re-negotiate compression on both sides, and
 * adds a copy per frame on the terminal hot path.
 */
export function spliceWebSocket(
  request: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  options: WsSpliceOptions,
): void {
  let target: URL;
  try {
    target = new URL(options.upstreamPath, options.baseUrl);
  } catch {
    refuseUpgrade(clientSocket, 502, 'Bad Gateway');
    return;
  }

  const headers = upstreamHeaders(request.headers, {
    host: target.host,
    credential: options.credential,
    clientIp: options.clientIp,
    clientProto: options.clientProto,
  });
  // `upstreamHeaders` strips the hop-by-hop set, which includes the two that
  // *make* this an upgrade. They are re-added here rather than exempted there,
  // because they genuinely are per-hop: these are the Hub's own upgrade
  // request to the backend, not a relay of the browser's. Every `Sec-WebSocket-*`
  // header passes through untouched — the key, the version, the subprotocol
  // and the extension offer are all end-to-end.
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const transport = target.protocol === 'https:' ? https : http;
  const upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: 'GET',
    path: `${target.pathname}${target.search}`,
    headers,
  });

  const openedAt = Date.now();
  let detach: (() => void) | null = null;
  let upgraded = false;

  /**
   * Nothing below the `upgrade` event tears down the dial if the *client*
   * goes away first.
   *
   * The only pre-upgrade cleanup used to be `clientSocket.on('error')`, and a
   * browser that closes cleanly emits `close`, not `error` — so a client that
   * gave up while the backend was still deciding left the upstream socket
   * open with nothing left to close it. Against a backend that accepts TCP
   * and never answers the handshake that is two leaked descriptors per
   * attempt, unbounded, because an upgrade is outside the server's own
   * `requestTimeout`/`headersTimeout` and this path had no timeout of its own.
   */
  const abandonDial = (): void => {
    if (!upgraded) upstream.destroy();
  };
  clientSocket.once('close', abandonDial);
  // Bounds the dial only — never the established connection, which is a
  // terminal that may idle for hours and must not be killed by a timer. This
  // is the same distinction the standing no-timeout rule draws: a handshake
  // that has not completed is not work in progress, it is a stall.
  upstream.setTimeout(DIAL_TIMEOUT_MS, () => {
    if (!upgraded) {
      options.log.warn({ hostId: options.hostId }, 'websocket dial timed out');
      upstream.destroy();
      refuseUpgrade(clientSocket, 504, 'Gateway Timeout');
    }
  });

  /**
   * Bookkeeping only — deliberately does not tear anything down.
   *
   * The first cut destroyed the peer socket here, and it cost the close
   * *code*: a backend closing with 4001 writes a close frame and then FINs,
   * and destroying the client socket on the upstream's `close` event raced
   * the flush of that frame, so the browser saw 1006 (abnormal) instead. The
   * browser's whole protocol-mismatch branch keys on 4001, so PA-61 would
   * have degraded to "reconnect forever" through a Hub. Graceful teardown is
   * left to `pipe()`, which ends the destination when the source ends; only
   * an error path destroys.
   */
  const finish = (why: string): void => {
    if (detach === null) return;
    detach();
    detach = null;
    options.log.info(
      { hostId: options.hostId, durationMs: Date.now() - openedAt, why },
      'proxied websocket closed',
    );
  };

  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    upgraded = true;
    clientSocket.off('close', abandonDial);
    // Past the handshake the socket belongs to the session, not to the dial.
    upstream.setTimeout(0);
    // Relay the backend's own 101 verbatim. `rawHeaders` keeps the original
    // casing and order, which is the closest Node lets us get to handing back
    // the exact bytes the backend sent — and it matters, because
    // `Sec-WebSocket-Accept` and the negotiated extension parameters are what
    // the browser validates the handshake against.
    const raw = upstreamResponse.rawHeaders;
    const lines: string[] = [
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`,
    ];
    for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);

    // Terminal keystrokes are tiny and latency-sensitive; Nagle would coalesce
    // them into visible input lag. Both of these are really `net.Socket`s —
    // `Duplex` is what the `upgrade` event's type says, and it is the wider
    // type — so the capability is checked rather than assumed.
    setNoDelay(clientSocket);
    setNoDelay(upstreamSocket);

    detach = options.sockets.track(options.hostId, clientSocket, upstreamSocket);

    // Bytes each parser read past its own handshake, before the pipes existed.
    //
    // Each buffer is pushed back onto the *readable* side of the socket it
    // arrived on, so the pipe below forwards it in the right direction.
    // Getting this backwards is not a dropped byte, it is a loop: the first
    // cut unshifted `upstreamHead` into the client socket, which sent the
    // backend's own first frame straight back to the backend. It presented as
    // a close code of 1006 instead of 4001, because the close frame a backend
    // writes immediately after the 101 lands in exactly this buffer — which
    // would have silently broken PA-61's protocol-mismatch handling through a
    // Hub while every ordinary session looked fine.
    if (head.length > 0) clientSocket.unshift(head);
    if (upstreamHead.length > 0) upstreamSocket.unshift(upstreamHead);

    const onError = (err: Error): void => {
      options.log.warn({ hostId: options.hostId, err: err.message }, 'proxied websocket error');
      clientSocket.destroy();
      upstreamSocket.destroy();
      finish('error');
    };
    clientSocket.on('error', onError);
    upstreamSocket.on('error', onError);
    // The browser is already gone by the time this fires, so there is nothing
    // left to flush towards it and the upstream should stop immediately.
    clientSocket.on('close', () => {
      upstreamSocket.destroy();
      finish('client closed');
    });
    // Nothing is destroyed here: `upstreamSocket.pipe(clientSocket)` has
    // already ended the client side *after* flushing, which is what delivers
    // the close frame the backend just wrote.
    upstreamSocket.on('close', () => finish('host closed'));

    // The whole of the data path. No transform, no tap, no counter.
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);

    options.log.info({ hostId: options.hostId }, 'proxied websocket opened');
  });

  // The backend answered without upgrading — a revoked credential (401), a
  // rejected Origin (403), or a route that is not there. Relay the status so
  // the browser sees a failed handshake rather than a silent hang, but do not
  // try to be clever: a WebSocket that never opened has no close code to carry
  // a reason in, so the status line is all there is.
  upstream.on('response', (response) => {
    response.resume();
    options.log.warn(
      { hostId: options.hostId, status: response.statusCode },
      'host refused the websocket upgrade',
    );
    refuseUpgrade(clientSocket, response.statusCode ?? 502, 'Upgrade Refused');
  });

  upstream.on('error', (error: Error) => {
    options.log.warn({ hostId: options.hostId, err: error.message }, 'websocket dial failed');
    refuseUpgrade(clientSocket, 502, 'Bad Gateway');
  });

  clientSocket.on('error', () => upstream.destroy());
  upstream.end();
}
