import { z } from 'zod';

/**
 * The span of wire-protocol versions one server will accept (PA-61).
 *
 * Lives in the *protocol* package next to the schemas rather than in the
 * server, and the negotiation below is a pure function, for the same reason
 * `cron-expr.ts` and `webhook-template.ts` do: three separate components need
 * the same answer. The server decides which sockets to accept, the browser
 * decides whether a host is usable before it opens one, and the Hub polls
 * `/health` across every bound backend to draw the host list. A second copy of
 * this arithmetic in `apps/web` or in `apps/hub` guarantees the host
 * list eventually disagrees with what the socket handshake actually does.
 *
 * Deliberately imports nothing but zod. `session.ts` needs it for `HostInfo`
 * and `ws.ts` needs it for the server's own range, and `ws.ts` already imports
 * `session.ts` — so anything this module imported from either would close a
 * cycle.
 */
export const ProtocolRange = z.object({
  /** Oldest version the server still accepts. Inclusive. */
  min: z.number().int().positive(),
  /** Newest version the server speaks. Inclusive. */
  max: z.number().int().positive(),
});
export type ProtocolRange = z.infer<typeof ProtocolRange>;

/** Why a host cannot be talked to. */
export type IncompatibilityReason =
  /** The bundle is older than anything the host still accepts. */
  | 'below_min'
  /** The bundle is newer than the host understands — the host is lagging. */
  | 'above_max'
  /** `/health` did not answer, or did not answer something parseable. */
  | 'unreachable';

/**
 * Whether this bundle can talk to one host.
 *
 * A discriminated union rather than a boolean plus loose fields, because every
 * consumer needs *both* versions to render the sentence the ticket asks for
 * ("which host, which version it has, which it needs") and a boolean would
 * leave each of them re-deriving it.
 */
export type HostCompatibility =
  | { readonly compatible: true; readonly clientVersion: number; readonly hostRange: ProtocolRange }
  | {
      readonly compatible: false;
      readonly reason: IncompatibilityReason;
      readonly clientVersion: number;
      /** Null only when the reason is `unreachable`. */
      readonly hostRange: ProtocolRange | null;
    };

/**
 * Compares this bundle's protocol version against what a host reports.
 *
 * `hostRange` is null when `/health` could not be read at all, which is a
 * distinct outcome from a version mismatch and stays distinct all the way to
 * the UI: an unreachable host may simply be rebooting, while an out-of-range
 * one will keep refusing until somebody upgrades something.
 *
 * Note the asymmetry with the server-side handshake check: the browser speaks
 * exactly one version (whatever `PROTOCOL_VERSION` was compiled into the
 * bundle) while a server accepts a span. So this is a point-in-interval test,
 * not a range intersection — and it must stay that way, because a bundle
 * cannot choose to emit an older frame set on request. If a client ever gains
 * a real range, this is the one function that changes.
 */
export function negotiateProtocol(
  clientVersion: number,
  hostRange: ProtocolRange | null,
): HostCompatibility {
  if (hostRange === null) {
    return { compatible: false, reason: 'unreachable', clientVersion, hostRange: null };
  }
  if (clientVersion < hostRange.min) {
    return { compatible: false, reason: 'below_min', clientVersion, hostRange };
  }
  if (clientVersion > hostRange.max) {
    return { compatible: false, reason: 'above_max', clientVersion, hostRange };
  }
  return { compatible: true, clientVersion, hostRange };
}

/**
 * One sentence a human can act on, naming the host and both versions.
 *
 * Built here rather than in the React tree so the Hub's own host list and the
 * browser's cannot describe the same skew differently. `hostName` is whatever
 * the operator would recognise — `HostInfo.name`, or the host id before any
 * response has arrived.
 *
 * The three reasons get genuinely different advice, which is the whole point
 * of keeping them apart: a stale *bundle* is fixed by reloading, a stale
 * *host* is fixed by upgrading that machine, and neither is true of a host
 * that is merely not answering.
 */
export function describeIncompatibility(
  hostName: string,
  compatibility: HostCompatibility,
): string | null {
  if (compatibility.compatible) return null;
  const { reason, clientVersion, hostRange } = compatibility;
  if (reason === 'unreachable' || hostRange === null) {
    return `${hostName} did not answer a version check, so it cannot be used yet. It may be starting up or unreachable from here.`;
  }
  const speaks =
    hostRange.min === hostRange.max
      ? `protocol v${hostRange.min}`
      : `protocol v${hostRange.min}–v${hostRange.max}`;
  if (reason === 'below_min') {
    return `This app speaks protocol v${clientVersion}, but ${hostName} requires ${speaks}. Reload the page to pick up a newer app.`;
  }
  return `This app speaks protocol v${clientVersion}, but ${hostName} only speaks ${speaks}. Upgrade ${hostName} to use it.`;
}
