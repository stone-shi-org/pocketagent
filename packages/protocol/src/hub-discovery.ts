import { z } from 'zod';
import { ProtocolRange } from './protocol-negotiation.js';

/**
 * Backends a Hub has *heard about* on the local network (PA-110).
 *
 * The contract between `apps/hub`'s mDNS browser and the Hub page's
 * "Discovered on this network" list. Everything here is a suggestion: a
 * discovered backend is not registered, not bound and not reachable through
 * the Hub until an operator adds it (and binds it with that backend's own
 * master token, PA-63). That is why nothing on this shape is trusted beyond
 * display — an mDNS advertisement is unauthenticated by nature, and anyone on
 * the LAN can send one.
 */

/**
 * The TXT keys a backend publishes. One constant for both sides so the
 * advertiser and the reader cannot disagree about a spelling.
 *
 * The budget is `/health`'s and no more (see the `/health` invariant in
 * CLAUDE.md): a version and a protocol range, both already readable by anyone
 * who can reach the port. An advertisement reaches further than that port —
 * every machine on the LAN, whether or not it can connect — so it must never
 * carry *more*.
 */
export const MDNS_TXT_KEYS = {
  /** TXT record format version, so a later shape can be told apart. */
  txtVersion: 'txtvers',
  /** `server` for a backend. Reserved so a Hub could later advertise itself distinctly. */
  role: 'role',
  /** The backend's build semver, as `/health` reports it. */
  version: 'version',
  /** `min-max`, as `/health`'s `protocol` range. */
  protocol: 'proto',
  /** `http` or `https` — what the backend itself serves. */
  scheme: 'scheme',
} as const;

/** Parses the `proto` TXT value (`"14-14"`), or null when absent or malformed. */
export function parseProtocolTxt(value: string | undefined): ProtocolRange | null {
  const match = /^(\d+)-(\d+)$/.exec(value?.trim() ?? '');
  if (!match) return null;
  const parsed = ProtocolRange.safeParse({ min: Number(match[1]), max: Number(match[2]) });
  return parsed.success && parsed.data.min <= parsed.data.max ? parsed.data : null;
}

/** The inverse of `parseProtocolTxt`. */
export function formatProtocolTxt(range: ProtocolRange): string {
  return `${range.min}-${range.max}`;
}

/**
 * `disabled` — the operator turned discovery off (`POCKETAGENT_HUB_MDNS=false`).
 * `starting` — the socket is not open yet.
 * `listening` — browsing; an empty list means nothing has answered.
 * `failed` — the socket could not be opened (see `message`); the Hub works
 *   exactly as before, it just cannot hear advertisements.
 */
export const HubDiscoveryState = z.enum(['disabled', 'starting', 'listening', 'failed']);
export type HubDiscoveryState = z.infer<typeof HubDiscoveryState>;

export const DiscoveredHubHost = z.object({
  /** The full DNS-SD instance name. Stable; the list key. */
  instance: z.string().min(1).max(512),
  /** Human-facing instance label, e.g. `stone-dev01 (8787)`. */
  name: z.string().min(1).max(256),
  /** The advertiser's own hostname part, for a proposed host name. */
  hostname: z.string().max(256),
  port: z.number().int().min(1).max(65535),
  /** Every address the backend advertised, in its own preference order. */
  addresses: z.array(z.string().max(64)).max(32),
  /**
   * The address this Hub would dial — an advertised address a packet actually
   * arrived from where there is one, since that is evidence of a route rather
   * than a claim.
   */
  baseUrl: z.string().min(1).max(2048),
  version: z.string().max(128).nullable(),
  protocol: ProtocolRange.nullable(),
  /** The registry row this already is, matched on address and port — or null. */
  registeredHostId: z.string().nullable(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
});
export type DiscoveredHubHost = z.infer<typeof DiscoveredHubHost>;

export const HubDiscoveryResponse = z.object({
  state: HubDiscoveryState,
  /** Why discovery is disabled or failed, in a sentence an operator can act on. */
  message: z.string().nullable(),
  hosts: z.array(DiscoveredHubHost),
});
export type HubDiscoveryResponse = z.infer<typeof HubDiscoveryResponse>;
