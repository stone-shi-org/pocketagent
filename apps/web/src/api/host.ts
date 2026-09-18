/**
 * Where a host lives, as far as *this browser* is concerned (PA-60).
 *
 * Before this existed, the origin was the host identity: `request()` fetched
 * relative paths and `wsUrl()` read `window.location.host`, so "which backend
 * am I talking to" was answered by the page's own URL and could only be
 * changed by a full page load. A `HostEndpoint` makes that answer an explicit
 * value threaded through the API client and the socket clients instead.
 *
 * ## Why a base *path* and not a base URL
 *
 * This is load-bearing rather than incidental. `request()` authenticates with
 * an HttpOnly cookie and `credentials: 'same-origin'`; a same-origin path
 * prefix leaves that entire model untouched. A cross-origin base URL would
 * need `credentials: 'include'`, a credentialed CORS allowlist, and
 * `SameSite=None; Secure` — none of which the loopback-bind-over-plain-HTTP
 * posture in CLAUDE.md can provide. So a second host is reachable only as a
 * path prefix on *this* origin, i.e. through a same-origin reverse proxy, and
 * that is the constraint the Hub service inherits rather than a limitation to
 * be lifted later by widening this type.
 */

/**
 * Id of the host this bundle was served by.
 *
 * Deliberately a fixed sentinel rather than the server's own
 * `HostInfo.id` (a sha256 of hostname + workspace roots, minted in
 * `ProjectService.host()`): the router has to resolve a hash like
 * `#/h/<id>/s/x` on the very first render, long before any response has
 * arrived, so the default host needs an id that is knowable without a round
 * trip. `resolveHostEndpoint` is what reconciles the two.
 */
export const DEFAULT_HOST_ID = 'local';

/** A machine's address from this browser's point of view. */
export interface HostEndpoint {
  /** Opaque, and exactly what appears in `#/h/<hostId>/...`. */
  readonly id: string;
  /**
   * Prefix every request and socket URL is built on. Always either `''` or a
   * string that starts with `/` and does not end with one, so concatenating
   * an `/api/...` path needs no separator logic at the call site.
   *
   * Empty for the default host, which is what makes every URL this module
   * emits byte-identical to the ones emitted before PA-60.
   */
  readonly basePath: string;
}

/**
 * The host that served this bundle: no prefix, so it addresses exactly what a
 * relative `/api/...` fetch addressed before.
 */
export const DEFAULT_HOST: HostEndpoint = { id: DEFAULT_HOST_ID, basePath: '' };

/**
 * Trims a configured prefix into the shape `basePath` promises.
 *
 * Accepts the sloppy forms a human or a config file produces (`h/a`, `/h/a/`,
 * `//h/a`) because the alternative is every caller remembering which of them
 * is canonical, and a doubled or missing slash only shows up as a 404 at
 * runtime.
 */
export function normalizeBasePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  // Collapse repeated slashes anywhere, then drop any trailing one.
  return withLeading.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

/**
 * Every endpoint object ever built, keyed by its own two fields.
 *
 * Interned rather than freshly allocated, because endpoint *identity* is load
 * bearing in the React tree (PA-67): a `HostEndpoint` is a `HostProvider`
 * prop, a `useMemo` dependency in that provider, and a dependency of effects
 * that open WebSockets. The host directory rebuilds its records on every status
 * poll, so a new object each time would re-create every host's API client and
 * tear down and reopen a live terminal socket every 30 seconds — a reconnect
 * storm with no visible cause. Two endpoints with the same id and prefix are
 * the same address, so they may as well be the same object.
 */
const interned = new Map<string, HostEndpoint>();

/** Builds a `HostEndpoint`, normalizing `basePath` so callers cannot skew it. */
export function hostEndpoint(id: string, basePath: string): HostEndpoint {
  const normalized = normalizeBasePath(basePath);
  if (normalized === '' && id === DEFAULT_HOST_ID) return DEFAULT_HOST;
  const key = `${id} ${normalized}`;
  const existing = interned.get(key);
  if (existing) return existing;
  const created: HostEndpoint = { id, basePath: normalized };
  interned.set(key, created);
  return created;
}

/**
 * Absolute-path URL for `path` on `endpoint`.
 *
 * `path` is always an app-absolute `/api/...` string, so for the default host
 * this returns it unchanged — which is why nothing about the wire changes
 * while there is exactly one host.
 */
export function hostUrl(endpoint: HostEndpoint, path: string): string {
  return endpoint.basePath === '' ? path : `${endpoint.basePath}${path}`;
}

/**
 * Every host this client can currently address.
 *
 * Mutable module state, and deliberately so. `useHashRoute` has to turn
 * `#/h/<id>/s/x` into an address during its *first* render, before any response
 * has arrived, so this cannot be a promise or a React value — and the two
 * sources that populate it differ in kind: the local registry
 * (`hosts/registry.ts`) reads `localStorage` synchronously, so in the
 * standalone deployment the list is already correct on that first render,
 * while a Hub's list arrives over the network and `App` holds host-scoped
 * children back until it has.
 *
 * `hosts/directory.ts` is the only writer (`publishKnownHosts`). Nothing else
 * may add to it: a second writer would mean two answers to "where is host X",
 * which is the one question this module exists to answer once.
 */
let knownHosts: readonly HostEndpoint[] = [DEFAULT_HOST];

/**
 * Ids that name a host other than by its routing id — in practice a backend's
 * own `HostInfo.id`. See `HostRecord.aliases` for why this exists at all.
 */
let hostAliases: ReadonlyMap<string, string> = new Map();

/**
 * Publishes the resolved host list for the router to read (PA-67).
 *
 * Called from `HostDirectory` on every list change, including the first. The
 * default host is always present: it is the one that served this bundle, and a
 * registry that could omit it would leave a bare `#/` route unaddressable.
 */
export function publishKnownHosts(
  hosts: readonly HostEndpoint[],
  aliases: ReadonlyMap<string, string> = new Map(),
): void {
  knownHosts = hosts.some((host) => host.basePath === '') ? hosts : [DEFAULT_HOST, ...hosts];
  hostAliases = aliases;
}

/** Test seam: forget everything published, back to the single default host. */
export function resetKnownHosts(): void {
  knownHosts = [DEFAULT_HOST];
  hostAliases = new Map();
}

/** Every currently addressable host, in registry order. */
export function listKnownHosts(): readonly HostEndpoint[] {
  return knownHosts;
}

/**
 * Resolves a host id out of a hash route to something addressable.
 *
 * An id that names nothing still resolves to the default host, because this
 * function's return type is an address and every caller needs one — but that is
 * no longer where the decision is made. PA-60 shipped this fallback as the
 * whole answer, with a comment saying that once several hosts could be
 * reported, this became the place that has to tell "the default host, spelled
 * differently" from "a host I have never heard of". Both halves of that now
 * exist, and they are split deliberately:
 *
 * - *Spelled differently* is handled here, via `hostAliases`: a bookmark
 *   carrying the backend's own sha256 `HostInfo.id` resolves to the default
 *   host because it genuinely is that host.
 * - *Never heard of* is handled by `resolveSelection` (`hosts/selected-host.ts`),
 *   which reports `unknown` so `App` can render a legible "no such host"
 *   screen. It renders that **instead of** any host-scoped subtree, which is
 *   what guarantees the fallback address below is never actually fetched from:
 *   silently talking to the wrong machine is the failure this ticket had to
 *   remove, not preserve.
 */
export function resolveHostEndpoint(hostId: string | null): HostEndpoint {
  if (hostId === null) return DEFAULT_HOST;
  const direct = knownHosts.find((host) => host.id === hostId);
  if (direct) return direct;
  const aliased = hostAliases.get(hostId);
  if (aliased !== undefined) {
    const target = knownHosts.find((host) => host.id === aliased);
    if (target) return target;
  }
  return DEFAULT_HOST;
}
