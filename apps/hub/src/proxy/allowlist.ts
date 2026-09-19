import { isHubHostId } from '@pocketagent/protocol';

/**
 * Which backend path prefixes the Hub refuses to proxy, ever.
 *
 * Read the list as one rule with one exception, rather than as five
 * unrelated entries: **nothing in a backend's unauthenticated surface is
 * reachable through the Hub.** The backend's `PUBLIC_API_PATHS` is exactly
 * `/health`, `/api/auth/login`, `/api/auth/me`, `/api/auth/hub-bind`, plus the
 * dynamic `/api/hooks/` prefix. Four of those five are here; `/health` is the
 * exception and is allowed through deliberately (see `resolveProxyTarget`),
 * because reading a version range is the one thing in that set with no
 * security content and the browser's own protocol negotiation needs it.
 *
 * Each entry still carries its own reason, because they are not the same
 * reason and a future reader deciding whether one may be relaxed needs the
 * specific argument rather than the summary.
 */
export const PROXY_DENY_PREFIXES: readonly { prefix: string; why: string }[] = [
  {
    // PA-66 hard constraint #1, and the one with consequences beyond this file.
    // `POST /api/hooks/:slug` is the only unauthenticated route in the backend,
    // and CLAUDE.md's standing guarantee is that `grep '/api/hooks/'`
    // enumerates the entire dynamic unauthenticated surface. Re-exposing it at
    // `/h/<id>/api/hooks/:slug` would break that guarantee *and* make the Hub
    // inherit the whole slug-enumeration-oracle design — unknown slug,
    // disabled webhook and bad signature all having to be one indistinguishable
    // response, HMAC over raw bytes, a dummy-key hash on the unknown path.
    // None of that is reimplemented here because none of it is reachable here:
    // Jira delivers straight to the backend.
    prefix: '/api/hooks/',
    why: 'inbound webhook deliveries go straight to the backend, never through the Hub',
  },
  {
    // Single sign-on means the browser authenticates to the Hub and to nothing
    // else. Proxying this would also relay master-token guesses, spending the
    // backend's rate limit on behalf of whoever can reach the Hub.
    prefix: '/api/auth/login',
    why: 'the browser signs in to the Hub, never to a backend',
  },
  {
    prefix: '/api/auth/logout',
    why: 'the browser signs in to the Hub, never to a backend',
  },
  {
    // A Hub credential cannot mint another (PA-63), so this would always need
    // a master token in the body — a thing that must reach the Hub's own bind
    // route and stop there, never be a path the browser can drive.
    prefix: '/api/auth/hub-bind',
    why: 'binding is the Hub’s own operation and needs the master token',
  },
  {
    // Answered locally instead. The backend reports *cookie* sessions only, so
    // a bearer-authenticated proxy call reads as `authenticated: false` and
    // would tell a per-host `me()` the operator is signed out of a host they
    // can plainly reach.
    prefix: '/api/auth/me',
    why: 'answered by the Hub from its own session',
  },
  {
    // PA-73: push subscriptions belong to the Hub origin, not individual backends.
    prefix: '/api/push/',
    why: 'push notifications are managed by the Hub origin and fanned out from bound hosts',
  },
];

export type ProxyTarget =
  | { kind: 'hub' }
  | { kind: 'static' }
  | { kind: 'proxy'; hostId: string | null; upstreamPath: string }
  | { kind: 'reject'; reason: string };

/**
 * Sequences that would make one spelling of a path decode into another.
 *
 * The posture is **reject, not canonicalize**, but that phrase needs to be
 * precise about what it applies to. Two things are rejected outright:
 *
 * - `%25`, the encoding of `%` itself. It is the only way a path can need
 *   decoding *twice*, and rejecting it is what makes "decode once" below the
 *   final word rather than one step of an unbounded loop.
 * - a literal backslash, and any `.` or `..` segment, in either spelling.
 *
 * Everything else encoded is allowed through — because the decision is then
 * made on the **decoded** path while the **raw** path is what gets forwarded.
 * Deciding on the decoded form is not optional: `/api/%68ooks/foo` reaches a
 * backend's router as `/api/hooks/foo`, so a deny check run against the raw
 * string alone would wave it straight through. (That is not hypothetical —
 * it is the bug `proxy-allowlist.test.ts` caught in the first cut of this
 * file.) Forwarding the raw form is equally not optional: a legitimate id can
 * legitimately contain `%3A` — an agent id like `custom-claude:x` — and
 * re-encoding a decoded path is exactly the lossy round trip
 * `routes/webhook-delivery.ts` already records the cost of.
 */
const REJECTED_OUTRIGHT = /%25|\\/i;

function hasDotSegment(pathname: string): boolean {
  return pathname.split('/').some((segment) => segment === '.' || segment === '..');
}

/** The `<hostId>` in `/h/<hostId>/...`, or the whole tail if there is no slash. */
function segmentAfterHostPrefix(pathname: string): string {
  const rest = pathname.slice('/h/'.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

/** Decode one layer, or null if the path is not valid percent-encoding. */
function decodeOnce(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Decide what a request path is, before anything is dialed.
 *
 * `rawUrl` is `request.url` — path plus query, exactly as received and *not*
 * decoded. The query is carried through untouched (it holds `?v=` for the
 * WebSocket handshake among other things) but plays no part in the decision.
 */
export function resolveProxyTarget(rawUrl: string): ProxyTarget {
  const queryAt = rawUrl.indexOf('?');
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = queryAt === -1 ? '' : rawUrl.slice(queryAt);

  if (REJECTED_OUTRIGHT.test(pathname)) {
    return { kind: 'reject', reason: 'unsupported characters in path' };
  }
  const decoded = decodeOnce(pathname);
  if (decoded === null) return { kind: 'reject', reason: 'malformed percent-encoding' };
  // An encoded separator makes the raw and decoded forms disagree about where
  // the segments are, which would break the index arithmetic below as well as
  // the deny check. Refused rather than reconciled.
  if (decoded.includes('\\') || hasDotSegment(pathname) || hasDotSegment(decoded)) {
    return { kind: 'reject', reason: 'unsupported characters in path' };
  }
  if (decoded.split('/').length !== pathname.split('/').length) {
    return { kind: 'reject', reason: 'encoded separator in path' };
  }
  // A protocol-relative or absolute-form request line would make `hostId`
  // parsing meaningless. Fastify normally gives origin-form, but this is the
  // one function that must not assume.
  if (!pathname.startsWith('/') || pathname.startsWith('//')) {
    return { kind: 'reject', reason: 'unsupported request target' };
  }

  if (decoded.startsWith('/h/')) {
    // Parsed from **both** spellings and required to agree.
    //
    // An earlier version took the id from the decoded path and then applied
    // `'/h/'.length + hostId.length` as an offset into the raw one, on the
    // reasoning that a valid host id has no percent-encodable characters.
    // That is wrong — *any* character can be percent-encoded, and the pattern
    // is tested against the decoded form. `/h/%61bc/api/sessions` decodes to
    // host `abc` with remainder `/api/sessions`, while the same offset into
    // the raw path yields `bc/api/sessions`: the deny list would then have
    // been evaluated against a different string from the one forwarded,
    // which is the single invariant this module exists to hold.
    //
    // Requiring the two spellings to be identical is the cheap fix, and it
    // costs nothing real: a host id is a DNS-label slug, so there is no
    // legitimate reason to encode one.
    const rawId = segmentAfterHostPrefix(pathname);
    const decodedId = segmentAfterHostPrefix(decoded);
    if (rawId !== decodedId) return { kind: 'reject', reason: 'encoded host id' };
    if (!isHubHostId(rawId)) return { kind: 'reject', reason: 'not a host id' };
    const offset = '/h/'.length + rawId.length;
    return hostPathTarget(rawId, decoded.slice(offset), pathname.slice(offset), query);
  }

  // The Hub's own surface. Checked before the bare-root proxy below, so a
  // backend can never shadow the registry or the login route.
  if (decoded === '/health') return { kind: 'hub' };
  if (decoded.startsWith('/api/hub/') || decoded === '/api/hub') return { kind: 'hub' };
  if (decoded.startsWith('/api/auth/')) return { kind: 'hub' };
  if (decoded.startsWith('/api/push/') || decoded === '/api/push') return { kind: 'hub' };

  if (decoded.startsWith('/api/')) {
    // PA-66 D6b: the default host is mounted at the bare root as well, so an
    // unmodified single-host bundle — whose `DEFAULT_HOST.basePath` is `''` —
    // works through the Hub unchanged. `hostId: null` means "whichever row is
    // the default", resolved per request so changing the default takes effect
    // with no restart.
    return hostPathTarget(null, decoded, pathname, query);
  }

  // Assets and the SPA shell, served by the Hub from its own bundle.
  return { kind: 'static' };
}

function hostPathTarget(
  hostId: string | null,
  decodedRemainder: string,
  rawRemainder: string,
  query: string,
): ProxyTarget {
  // The two path shapes a browser ever asks a *host* for: `hostUrl()` is only
  // ever called with `/api/...` or `/health`. Everything else under `/h/<id>/`
  // is refused rather than forwarded — a backend's SPA fallback answers 200
  // with its own copy of the shell for any non-API path, so forwarding would
  // serve a second, differently-based bundle from inside the Hub's origin.
  const isHealth = decodedRemainder === '/health';
  const isApi = decodedRemainder.startsWith('/api/');
  if (!isHealth && !isApi) {
    return { kind: 'reject', reason: 'only /api/* and /health are proxied' };
  }

  // Case-insensitive because the deny list is a security boundary and the
  // backend's own `isWebhookDelivery` is an exact-case `startsWith`: a request
  // for `/api/HOOKS/x` would 404 there rather than match, but a Hub that
  // forwarded it would still have been *willing* to, which is not a property
  // worth depending on the upstream to save us from.
  const lowered = decodedRemainder.toLowerCase();
  for (const entry of PROXY_DENY_PREFIXES) {
    // Three forms, not one. `startsWith` alone lets `/api/hooks` through
    // because the entry carries a trailing slash — harmless against today's
    // backend, which also requires the slash and so merely 404s it as an
    // authenticated request, but the posture this list states is that the Hub
    // is never even *willing* to forward these, and that must not depend on
    // no route ever being mounted at the bare path.
    const bare = entry.prefix.endsWith('/') ? entry.prefix.slice(0, -1) : entry.prefix;
    if (lowered === entry.prefix || lowered === bare || lowered.startsWith(entry.prefix)) {
      return { kind: 'reject', reason: entry.why };
    }
  }

  // Decided on the decoded form, forwarded in the raw one.
  return { kind: 'proxy', hostId, upstreamPath: `${rawRemainder}${query}` };
}
