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

/** Builds a `HostEndpoint`, normalizing `basePath` so callers cannot skew it. */
export function hostEndpoint(id: string, basePath: string): HostEndpoint {
  return { id, basePath: normalizeBasePath(basePath) };
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
 * Exactly one, and there is deliberately no way to add to it yet: registering
 * a second host is the multi-host UI ticket's job, and shipping the mechanism
 * early would mean shipping an unreachable code path with no UI to exercise
 * it.
 */
const KNOWN_HOSTS: readonly HostEndpoint[] = [DEFAULT_HOST];

/**
 * Resolves a host id out of a hash route to something addressable.
 *
 * An unrecognised id falls back to the default host rather than erroring, and
 * that is the behaviour the acceptance criteria actually require: the id in a
 * `#/h/<hostId>/...` bookmark will normally be the server's *own*
 * `HostInfo.id`, which is a sha256 this module cannot predict (see
 * `DEFAULT_HOST_ID`), so treating "not in the list" as fatal would break the
 * one link shape the ticket asks to support. With a single host every id
 * either names it or names nothing, so there is no case where falling back
 * silently talks to the wrong machine. Once the Hub can report several hosts,
 * this is the single place that has to start distinguishing "the default host,
 * spelled differently" from "a host I have never heard of".
 */
export function resolveHostEndpoint(hostId: string | null): HostEndpoint {
  if (hostId === null) return DEFAULT_HOST;
  return KNOWN_HOSTS.find((host) => host.id === hostId) ?? DEFAULT_HOST;
}
