import type { IncomingHttpHeaders } from 'node:http';

/**
 * Headers that describe *this* connection rather than the message, and so must
 * never be relayed onto the next one (RFC 9110 §7.6.1).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers the Hub strips on the way *up*, beyond the hop-by-hop set.
 *
 * `cookie` — the Hub's session cookie means nothing to a backend and must not
 * travel; a credential should only ever go where it can be used.
 *
 * `origin` — the one that is counter-intuitive and the likeliest way to get
 * this whole feature subtly wrong. The backend's `isOriginAllowed` falls back
 * to comparing the Origin's host against the `Host` the request was routed to,
 * which for a proxied request is the *backend's*. Forwarding the browser's
 * Origin therefore 403s every non-GET while every read keeps working — a
 * failure that presents as a permissions bug, not a proxy bug. Stripping it
 * puts the request in the "no Origin, i.e. not a browser" branch the backend
 * already documents as the Hub's case. The CSRF check does not disappear; it
 * moves to the Hub, which is where the ambient cookie actually is.
 *
 * `authorization` — replaced wholesale with the host's credential, so a client
 * can never smuggle its own bearer through.
 */
const STRIP_UPSTREAM = new Set(['cookie', 'origin', 'authorization', 'host', 'content-length']);

/** Headers the Hub strips on the way *down*. */
const STRIP_DOWNSTREAM = new Set([
  // A backend has no business setting a cookie on the Hub's origin, and with
  // `/api/auth/*` denied it has no reason to try. Stripping is belt and
  // braces: a stray Set-Cookie reaching the browser could overwrite the Hub's
  // own session cookie.
  'set-cookie',
]);

/**
 * How the outbound request's body will be delimited.
 *
 * This exists because getting it wrong is a request-smuggling hole, and the
 * obvious implementation has one. Stripping the client's `content-length` and
 * `transfer-encoding` (both are per-hop, so stripping is right) and then
 * piping the body leaves the framing to Node — and Node's `ClientRequest`
 * sets chunked encoding by default only for methods it expects to have a
 * body. For `GET`, `HEAD`, `DELETE`, `OPTIONS` and `TRACE` it does not, so the
 * request goes out with **no framing at all**: the body bytes are simply
 * appended after the blank line, on a `Connection: keep-alive` socket from
 * Node's pooled global agent. The backend then reads them as the start of the
 * *next* request on that connection.
 *
 * That is a complete bypass of everything in `allowlist.ts`: a body of
 * `POST /api/hooks/evil HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n`
 * is executed by the backend having passed through no deny list, carrying no
 * credential, and therefore landing on exactly the unauthenticated surface
 * this Hub exists to keep unreachable. `proxy-headers.test.ts` reproduces it.
 *
 * So the framing is decided here and stated explicitly on every request,
 * rather than inferred. `request.raw` is already de-chunked by Node's server,
 * so a `content-length` the client sent describes exactly the bytes about to
 * be piped and can be forwarded verbatim; a chunked request has no known
 * length and is re-chunked; and a request with neither header has no body at
 * all, so nothing is piped.
 */
export type BodyFraming =
  | { readonly kind: 'none' }
  | { readonly kind: 'length'; readonly value: string }
  | { readonly kind: 'chunked' };

export function bodyFramingFor(incoming: IncomingHttpHeaders): BodyFraming {
  const transferEncoding = incoming['transfer-encoding'];
  const encoding = Array.isArray(transferEncoding)
    ? transferEncoding.join(',')
    : (transferEncoding ?? '');
  // Chunked wins: per RFC 9112 a message with both is to be treated as
  // chunked, and Node's own server rejects the combination before we see it.
  if (/(^|,)\s*chunked\s*($|,)/i.test(encoding)) return { kind: 'chunked' };

  const contentLength = incoming['content-length'];
  const length = Array.isArray(contentLength) ? contentLength[0] : contentLength;
  // Anything but a plain non-negative integer is refused rather than
  // forwarded or guessed at — Node's server has already validated it, so a
  // surprise here means an assumption broke.
  if (length !== undefined && /^\d+$/.test(length.trim())) {
    return { kind: 'length', value: length.trim() };
  }
  return { kind: 'none' };
}

export interface UpstreamHeaderOptions {
  /** Authority to present to the backend, e.g. `dev01.tail:8787`. */
  readonly host: string;
  /** The `pah_` credential for this host, decrypted. */
  readonly credential: string;
  /** The browser's address as the Hub itself observed it. */
  readonly clientIp: string | undefined;
  /** `https` when the browser reached the Hub over TLS. */
  readonly clientProto: string;
  /**
   * How to delimit the body upstream. Omitted by the WebSocket path, which
   * has no body — an upgrade request with one is not something to relay.
   */
  readonly framing?: BodyFraming;
}

/**
 * Build the header set to send upstream.
 *
 * Returns a flat record because both callers need one: `http.request` takes it
 * directly, and the WebSocket upgrade serialises it into a raw request head.
 * One function so the two transports cannot end up with different hygiene —
 * which is the whole reason the upgrade path does not hand-roll its own.
 */
export function upstreamHeaders(
  incoming: IncomingHttpHeaders,
  options: UpstreamHeaderOptions,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_UPSTREAM.has(lower)) continue;
    // Never relay a forwarding claim the client made about itself. The Hub is
    // the first hop that actually observed the peer, so it is the only one
    // entitled to assert this; anything the client sent is a claim.
    if (lower.startsWith('x-forwarded-')) continue;
    out[name] = value;
  }
  out.host = options.host;
  out.authorization = `Bearer ${options.credential}`;
  // Explicit, always. See `BodyFraming` for what happens when this is left to
  // Node to infer.
  const framing = options.framing ?? { kind: 'none' as const };
  if (framing.kind === 'length') out['content-length'] = framing.value;
  else if (framing.kind === 'chunked') out['transfer-encoding'] = 'chunked';
  if (options.clientIp !== undefined) out['x-forwarded-for'] = options.clientIp;
  out['x-forwarded-proto'] = options.clientProto;
  return out;
}

/**
 * Filter a backend's response headers before they reach the browser.
 *
 * `basePath` is the prefix this host is mounted under (`/h/<id>`, or `''` for
 * the default host at the bare root), used to rewrite `Location`. A backend
 * that redirects has no idea it is behind a gateway, so an absolute
 * `Location` names its *own* origin — which on the Hub's origin is both an
 * open redirect and a disclosure of the internal address. Rewriting it to the
 * equivalent path under this host is what a redirect through a proxy is
 * supposed to mean; a `Location` pointing anywhere else is left alone, since
 * it is a genuine off-site redirect and not ours to rewrite.
 */
export function downstreamHeaders(
  incoming: IncomingHttpHeaders,
  options: { readonly baseUrl: string; readonly basePath: string },
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_DOWNSTREAM.has(lower)) continue;
    if (lower === 'location') {
      out[name] = rewriteLocation(Array.isArray(value) ? (value[0] ?? '') : value, options);
      continue;
    }
    out[name] = value;
  }
  return out;
}

function rewriteLocation(
  location: string,
  options: { readonly baseUrl: string; readonly basePath: string },
): string {
  // A relative redirect is already relative to the path the browser asked
  // for, which is the prefixed one, so it needs no help.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return location;
  try {
    const target = new URL(location);
    const backend = new URL(options.baseUrl);
    if (target.origin !== backend.origin) return location;
    return `${options.basePath}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return location;
  }
}
