import { z } from 'zod';
import { ProtocolRange } from './protocol-negotiation.js';

/**
 * PA-67/PA-66: the Hub's *registry* API — which backends exist, how to reach
 * them, and whether each is usable right now.
 *
 * Deliberately a separate module from `hub.ts`, which is PA-63's *credential*
 * protocol: that one is "what a backend must implement so a Hub can hold a
 * revocable key", this one is "what the Hub offers the browser". Keeping them
 * apart is what stops `apps/server` from ever growing a dependency on the
 * second — a backend has no business knowing a registry of its peers exists,
 * the same reason `GET /api/hosts` on a backend still returns exactly itself.
 *
 * These types are declared here, in the shared package, *before* `apps/hub`
 * exists (PA-66 is planned, not implemented) because they are a contract
 * between two tickets rather than one component's internals. The multi-host UI
 * consumes them today through `apps/web/src/hosts/directory.ts`; PA-66's
 * registry routes implement them. A shape invented twice is a shape that
 * eventually disagrees, which is the same argument `cron-expr.ts` and
 * `webhook-template.ts` already record for living here.
 *
 * Until a Hub answers, the browser runs the *local* source instead (see
 * `apps/web/src/hosts/registry.ts`) and nothing here is read at runtime. That
 * is a deliberate seam, not dead code: it is what lets the UI ship, be
 * demonstrated and be reviewed one ticket ahead of the service.
 */

/**
 * A Hub-local host id, and the exact thing that appears in `#/h/<hostId>/` and
 * in the `/h/<hostId>/api/**` proxy prefix.
 *
 * A slug rather than the backend's own `HostInfo.id` (a sha256 of hostname +
 * workspace roots) for two independent reasons. It is typeable and readable in
 * a shared link, which a 16-character base64url digest is not. And it is
 * *stable under backend reconfiguration*: adding a workspace root changes
 * `HostInfo.id`, which would silently invalidate every bookmark and every
 * persisted tab pointing at that machine if the URL were keyed on it.
 *
 * Constrained to the DNS-label shape (lowercase alphanumerics and inner
 * hyphens) so that a host id needs no escaping in a URL path, cannot collide
 * with the Hub's own `/api/` namespace, and cannot contain the `/` or `?` that
 * `HOST_SEGMENT` in `useHashRoute.ts` stops at.
 */
export const HUB_HOST_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Whether `value` is usable as a host id, in one place both sides can read. */
export function isHubHostId(value: string): boolean {
  return HUB_HOST_ID_PATTERN.test(value);
}

export const HubHostId = z.string().regex(HUB_HOST_ID_PATTERN, {
  message: 'A host id is 1–40 lowercase letters, digits or inner hyphens.',
});

/**
 * What the Hub's health poller last learned about one backend.
 *
 * `protocol` is the range the host *reports*, and it is nullable precisely
 * because the verdict is not the Hub's to render: the browser runs
 * `negotiateProtocol` against its own compiled-in `PROTOCOL_VERSION`, which
 * the Hub cannot know. Null means "could not be read" — a host that is down,
 * or one so old its `/health` predates `protocol` — and is a distinct state
 * from a range that simply does not include this bundle.
 */
export const HubHostStatus = z.object({
  /** Whether the last probe reached the backend at all. */
  online: z.boolean(),
  /** The backend's build semver, or null if never successfully read. */
  version: z.string().nullable(),
  protocol: ProtocolRange.nullable(),
  /** Epoch ms of the last probe, or null if one has never completed. */
  lastCheckedAt: z.number().nullable(),
  /** Human-readable reason the last probe failed; null when it succeeded. */
  error: z.string().nullable(),
});
export type HubHostStatus = z.infer<typeof HubHostStatus>;

/**
 * One registered backend.
 *
 * `baseUrl` is here for *display* and is emphatically not what the browser
 * fetches: a browser reaches a host as a same-origin path prefix
 * (`/h/<id>/api/...`, see `HostEndpoint`'s own doc comment for why a base URL
 * cannot work with an HttpOnly `SameSite` cookie). It is carried because two
 * surfaces genuinely need to show the operator which machine a row *is* — the
 * host list itself, and a webhook's delivery URL, which must name the
 * backend's own origin because the Hub is forbidden from proxying
 * `/api/hooks/*` at all.
 *
 * `backendHostId` and `identityChanged` are the reconciliation pair: the Hub
 * records the `HostInfo.id` it saw at bind time, and flags a row whose backend
 * now reports a different one. That is a real event (workspace roots changed,
 * or this base URL now points at a different machine) and it must be visible
 * rather than silently accepted, because every persisted tab and bookmark for
 * this host id was filed against the old identity.
 */
export const HubHostEntry = z.object({
  id: HubHostId,
  /** What a human calls this machine, e.g. `stone-dev01`. */
  label: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(2048),
  /** A disabled host is listed, greyed out, and never proxied to. */
  enabled: z.boolean(),
  /**
   * Exactly one row is the default, and it is also mounted at the bare
   * `/api/*` root so an unmodified single-host bundle keeps working through
   * the Hub (PA-66 D6b).
   */
  isDefault: z.boolean(),
  /** Epoch ms the scoped credential was obtained, or null if not bound yet. */
  boundAt: z.number().nullable(),
  /** Leading characters of the hub credential, for matching a row to a token. */
  credentialPrefix: z.string().nullable(),
  /** `HostInfo.id` as reported by the backend, or null before the first probe. */
  backendHostId: z.string().nullable(),
  identityChanged: z.boolean(),
  status: HubHostStatus,
});
export type HubHostEntry = z.infer<typeof HubHostEntry>;

export const HubHostListResponse = z.object({
  hosts: z.array(HubHostEntry),
  /**
   * The newest release the Hub knows exists, for PA-69's drift badge — e.g.
   * `1.5.0` while a host still reports `1.4.2`.
   *
   * Optional, and nullable when present, because a Hub that has no release
   * feed configured genuinely does not know. In that case the browser falls
   * back to `latestKnownVersion` over the hosts it can see, which is evidence
   * rather than authority: a fleet where every host is equally stale reports
   * no drift, which is honest — nothing has seen a newer build. Declared here
   * rather than invented later for the same reason the rest of this module is:
   * it is a contract between two tickets, and a shape invented twice
   * eventually disagrees.
   *
   * Deliberately *not* where an upgrade would be triggered from. This is a
   * version number to compare against and nothing else; naming an artifact to
   * install is the one thing PA-69 forbids end to end.
   */
  latestRelease: z.string().nullable().optional(),
});
export type HubHostListResponse = z.infer<typeof HubHostListResponse>;

/** Add a backend by base URL. Binding it is a second, explicit step. */
export const CreateHubHostRequest = z.object({
  id: HubHostId,
  label: z.string().min(1).max(200),
  baseUrl: z.string().min(1).max(2048),
});
export type CreateHubHostRequest = z.infer<typeof CreateHubHostRequest>;

export const UpdateHubHostRequest = z.object({
  label: z.string().min(1).max(200).optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});
export type UpdateHubHostRequest = z.infer<typeof UpdateHubHostRequest>;

/**
 * Paste a backend's master token once; the Hub exchanges it for a scoped
 * credential and discards it.
 *
 * The token never reaches this schema from a *browser* in the intended flow —
 * an operator hands it to the Hub — but the field exists so the exchange has a
 * typed body at all, and so the Hub's own route validates it the same way
 * `POST /api/auth/hub-bind` does on the backend side.
 */
export const BindHubHostRequest = z.object({
  token: z.string().min(24).max(4096),
  /** What the backend should call this Hub in its own revocation list. */
  label: z.string().min(1).max(200).optional(),
});
export type BindHubHostRequest = z.infer<typeof BindHubHostRequest>;

export const HubHostBindResponse = z.object({
  host: HubHostEntry,
});
export type HubHostBindResponse = z.infer<typeof HubHostBindResponse>;
