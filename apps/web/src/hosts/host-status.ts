import {
  PROTOCOL_VERSION,
  describeIncompatibility,
  negotiateProtocol,
  type HostCompatibility,
  type HostInfo,
} from '@pocketagent/protocol';
import { DEFAULT_HOST_ID, type HostEndpoint } from '../api/host.js';

/**
 * What one host is currently worth to this browser (PA-67).
 *
 * Four states rather than a boolean, because the ticket requires that an
 * offline *or* protocol-incompatible host "render as a legible state in all
 * three surfaces, never as an empty list or a spinner that never resolves" —
 * and those two need genuinely different sentences (one may be rebooting, the
 * other needs somebody to upgrade something, per `describeIncompatibility`).
 *
 * `unknown` is the fourth and is not a failure: it is "no probe has completed
 * yet". Kept distinct from `online` so a host never shows a green dot the app
 * has not earned, and distinct from `offline` so the first 8 seconds of a
 * cold load do not accuse a healthy machine of being down.
 */
export type HostStatus = 'unknown' | 'online' | 'offline' | 'incompatible';

/** Outcome of one status-tier probe. `info` is null when nothing usable came back. */
export interface HostProbe {
  readonly info: HostInfo | null;
  /**
   * Why the probe failed, when it did. Deliberately a *reason* rather than a
   * raw exception message: this string reaches the screen, and `TypeError:
   * Failed to fetch` is not something an operator can act on.
   */
  readonly error: string | null;
  readonly checkedAt: number;
}

/**
 * One row in every host surface: the rail tile, the sheet row, the group
 * heading.
 *
 * A single shape for all three is the point — the ticket asks for "the same
 * status dots" in each, and three components deriving status independently is
 * how they end up disagreeing. Everything here is already-decided: no
 * consumer calls `negotiateProtocol` itself.
 */
export interface HostRecord {
  /** Address, and the id that appears in `#/h/<id>/...`. */
  readonly endpoint: HostEndpoint;
  /** What to show: the host's own reported name once known, else its id. */
  readonly label: string;
  readonly status: HostStatus;
  readonly compatibility: HostCompatibility | null;
  /**
   * One sentence for a non-`online` host, or null when there is nothing to
   * say. This is the "legible state" the acceptance criteria require.
   */
  readonly message: string | null;
  /** `HostInfo.runningSessions`, or null for a host that does not report it. */
  readonly runningSessions: number | null;
  readonly version: string | null;
  /**
   * Other ids that name this same machine — in practice the backend's own
   * `HostInfo.id`, a sha256 of hostname + workspace roots.
   *
   * This is what PA-60 left for this ticket to do. Its `resolveHostEndpoint`
   * fell back to the default host for *any* unrecognised id, which was right
   * while there was one host (an id either named it or named nothing) and is
   * wrong now: silently talking to the wrong machine is exactly the failure
   * mode that fallback existed to avoid in the first place. With aliases, the
   * sha256-spelled bookmark resolves to the default host *because it is
   * genuinely that host*, and a truly unknown id gets a legible "no such
   * host" instead of a quiet redirect.
   */
  readonly aliases: readonly string[];
  readonly isDefault: boolean;
  /** False for the host serving this bundle, which cannot be un-registered. */
  readonly canRemove: boolean;
}

/** Whether `id` names this record, by its routing id or by an alias. */
export function hostMatches(record: HostRecord, id: string): boolean {
  return record.endpoint.id === id || record.aliases.includes(id);
}

/** The record `id` names, or null. Aliases included, so a bookmark resolves. */
export function findHost(records: readonly HostRecord[], id: string): HostRecord | null {
  return records.find((record) => hostMatches(record, id)) ?? null;
}

/**
 * Turns a probe into a status, deciding the verdict exactly once.
 *
 * Note what makes a host `offline` rather than `incompatible`: an unreadable
 * response, which includes a host so old that `HostInfo` no longer parses. The
 * honest verdict there is "cannot be negotiated with", not "understood and
 * found wanting" — the same distinction `probeHost` already draws for
 * `/health`.
 */
export function hostStatusFor(probe: HostProbe | undefined): {
  status: HostStatus;
  compatibility: HostCompatibility | null;
} {
  if (!probe) return { status: 'unknown', compatibility: null };
  if (probe.info === null) return { status: 'offline', compatibility: null };
  const compatibility = negotiateProtocol(PROTOCOL_VERSION, probe.info.protocol);
  return { status: compatibility.compatible ? 'online' : 'incompatible', compatibility };
}

/**
 * The sentence shown under a host that cannot be used.
 *
 * An offline host's message names *where* the browser looked, because in the
 * standalone (no-Hub) deployment the overwhelmingly likely cause is that
 * nothing is proxying that path prefix on this origin yet — and "unreachable"
 * with no path in it sends the reader to check the wrong machine.
 */
export function hostMessageFor(
  label: string,
  endpoint: HostEndpoint,
  probe: HostProbe | undefined,
  status: HostStatus,
  compatibility: HostCompatibility | null,
): string | null {
  if (status === 'online' || status === 'unknown') return null;
  if (status === 'incompatible' && compatibility) {
    return describeIncompatibility(label, compatibility);
  }
  if (probe?.error) return probe.error;
  const where = endpoint.basePath === '' ? 'this origin' : `${endpoint.basePath}/`;
  return `${label} did not answer at ${where}. It may be offline, or nothing is proxying it here yet.`;
}

/** Assembles one record from an entry and its latest probe. */
export function hostRecordFor(entry: {
  endpoint: HostEndpoint;
  label: string;
  probe?: HostProbe | undefined;
  isDefault?: boolean;
  canRemove?: boolean;
  /** Overrides the derived status, for a host the Hub reports as disabled. */
  forced?: { status: HostStatus; message: string } | undefined;
}): HostRecord {
  const { status, compatibility } = entry.forced
    ? { status: entry.forced.status, compatibility: null }
    : hostStatusFor(entry.probe);
  const info = entry.probe?.info ?? null;
  // The host's own name wins once known: an operator recognises `stone-dev01`,
  // not the slug they happened to type when registering it.
  const label = info?.name ?? entry.label;
  return {
    endpoint: entry.endpoint,
    label,
    status,
    compatibility,
    message:
      entry.forced?.message ??
      hostMessageFor(label, entry.endpoint, entry.probe, status, compatibility),
    runningSessions: info?.runningSessions ?? null,
    version: info?.version ?? null,
    // The reported id is only an alias when it differs from the routing id, so
    // a Hub-registered host whose slug already matches does not list itself.
    aliases: info && info.id !== entry.endpoint.id ? [info.id] : [],
    isDefault: entry.isDefault ?? entry.endpoint.id === DEFAULT_HOST_ID,
    canRemove: entry.canRemove ?? entry.endpoint.basePath !== '',
  };
}

/** Short text beside a dot: "3 running", "offline", "v-mismatch", "…". */
export function hostStatusSummary(record: HostRecord): string {
  switch (record.status) {
    case 'offline':
      return 'offline';
    case 'incompatible':
      return 'version';
    case 'unknown':
      return 'checking…';
    default:
      if (record.runningSessions === null) return 'online';
      if (record.runningSessions === 0) return 'idle';
      return `${record.runningSessions} running`;
  }
}

/**
 * Modifier for `.host-dot`, which already had `offline` before this ticket
 * (PA-61 added the incompatible state to the chip). Kept as a class suffix
 * rather than an inline colour so the palette stays in the token block.
 */
export function hostDotClass(status: HostStatus): string {
  switch (status) {
    case 'offline':
      return 'host-dot offline';
    case 'incompatible':
      return 'host-dot incompatible';
    case 'unknown':
      return 'host-dot unknown';
    default:
      return 'host-dot';
  }
}
