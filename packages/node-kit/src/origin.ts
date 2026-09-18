/**
 * Cross-site WebSocket connections are not covered by SameSite cookies in every
 * browser/version combination, and `fetch` preflight does not apply to WS. So we
 * check `Origin` explicitly on both the REST mutations and the WS handshake.
 *
 * Returns true when the request should be allowed.
 *
 * PA-66 note, because the Hub makes the "no Origin is allowed" branch load
 * bearing rather than merely convenient: a Hub proxying to a backend *strips*
 * `Origin` before forwarding, so a proxied request lands in that branch by
 * design. It is not a hole — the request still has to carry a hub credential,
 * and the CSRF question (can a hostile page drive a browser that holds an
 * ambient cookie?) is answered at the Hub, which is where the cookie is. What
 * would be a hole is *forwarding* the browser's Origin: the same-origin
 * fallback below compares it to the `Host` the request was routed to, which for
 * a proxied request is the backend's, so every non-GET would 403 while reads
 * kept working.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[] | null,
  host: string | undefined,
): boolean {
  // Non-browser clients (curl, tests, native apps, a proxying Hub) send no
  // Origin. A credential is still required, so this is not an authentication
  // bypass.
  if (origin === undefined) return true;

  const normalized = origin.replace(/\/$/, '');

  if (allowedOrigins && allowedOrigins.length > 0) {
    return allowedOrigins.includes(normalized);
  }

  // Default policy: same-origin only. Compare the Origin's host against the
  // Host header the request was routed to.
  if (!host) return false;
  try {
    return new URL(normalized).host === host;
  } catch {
    return false;
  }
}
