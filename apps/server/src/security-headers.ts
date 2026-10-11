/**
 * The two Content-Security-Policies this server sends.
 *
 * `APP_CSP` is the default for every response (`app.ts`'s `onSend` hook).
 * `ARTIFACT_CSP` replaces it for a Pocket Agent artifact served inline
 * (`routes/planner.ts`), and is the only override: the hook sets `APP_CSP`
 * unless the route already set this exact policy.
 */

export const APP_CSP = [
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
].join('; ');

/**
 * An artifact is HTML an agent wrote, often a self-contained page whose
 * animation is an inline `<script>` — which `APP_CSP` blocks, so a page that
 * played from disk sat still when opened from the artifacts panel. Letting it
 * run on this origin is not an option: it would be logged in as the operator
 * and could drive the API, terminal sessions included, and an agent may have
 * written it from text it read on the web or in a Jira ticket.
 *
 * `sandbox allow-scripts` *without* `allow-same-origin` is what makes running
 * it safe. The document gets an opaque origin, so the `SameSite=Strict` session
 * cookie is never attached to anything it requests, and it cannot read this
 * origin's storage. Inline script and style are then allowed so a page works
 * as it does from a file; the network, forms, framing and popups stay shut
 * (`connect-src 'none'`, no `allow-forms`/`allow-popups`). The cost is that an
 * artifact cannot load a CDN script or web font — a self-contained page does
 * not notice.
 */
export const ARTIFACT_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
