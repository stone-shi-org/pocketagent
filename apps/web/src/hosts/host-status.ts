import {
  PROTOCOL_VERSION,
  describeIncompatibility,
  describeVersionDrift,
  detectVersionDrift,
  hostVersionStatus,
  latestKnownVersion,
  negotiateProtocol,
  type HostCompatibility,
  type HostInfo,
  type HubHostCapabilities,
  type VersionDrift,
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
  /**
   * What to call this host, everywhere it is named: the name a human gave it
   * when registering it (PA-107). The backend's reported hostname is
   * `reportedName`, secondary text only — the one exception is the local-mode
   * default host, which has no stored name at all, so its hostname still
   * stands in for the placeholder `local`.
   */
  readonly label: string;
  /** `HostInfo.name` — the machine's own hostname — once a probe has returned it. */
  readonly reportedName: string | null;
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
  /**
   * Whether a Hub holds a usable scoped credential for this host — `null` in
   * local mode, where the concept does not exist at all (a same-origin path
   * prefix authenticates on the browser's own cookie, never on a credential
   * the Hub holds). `false` covers both "never bound" and "bound, but the
   * stored credential no longer decrypts" (a rotated
   * `POCKETAGENT_SETTINGS_ENC_KEY`) — `HostRegistry.credentialFor` collapses
   * those the same way for the same reason, and a fresh bind fixes either.
   */
  readonly hubBound: boolean | null;
  /**
   * The Hub registry's own row id for this host — `null` in local mode.
   *
   * Deliberately *not* the same thing as `endpoint.id`: a Hub's default host
   * is aliased to `DEFAULT_HOST_ID` there (PA-66 D6b, so old bare `/api/*`
   * links keep working through the Hub), so `endpoint.id` for that one row
   * reads `'local'` no matter what it is actually called in the registry.
   * Any call that addresses the *Hub's* API by id — bind, edit, remove — has
   * to use this field instead, or it 404s on exactly the host most likely to
   * be the only one registered so far (a first-added host is auto-promoted
   * to default). That 404 is a bug this field exists to make impossible to
   * reintroduce, not a hypothetical.
   */
  readonly hubHostId: string | null;
  /**
   * The address the *Hub* dials for this host, e.g. `http://dev02:8787` —
   * `null` in local mode, where `endpoint.basePath` already is the address
   * the browser itself would use and there is no second one to show.
   */
  readonly hubBaseUrl: string | null;
  /**
   * Where this host's build sits against the newest one we know of (PA-69).
   *
   * On the record rather than derived in each renderer because a record is the
   * one already-decided shape all three surfaces read — the same rule the
   * interface's own doc comment states for status. It cannot be filled by
   * `hostRecordFor`, though, which sees one host: "the latest known version"
   * is a property of the whole list, so `withVersionDrift` does a second pass
   * once every record exists.
   *
   * Defaults to `unknown`, which is also the honest answer for a standalone
   * install: one host compared against itself is not evidence of anything.
   */
  readonly drift: VersionDrift;
  /**
   * PA-133: per-host capability card cached by the Hub's health poller for
   * bound hosts (`{ status: 'ok', card }` or `{ status: 'unavailable' }`).
   * `null` (or omitted) in local mode or before the first bound probe.
   */
  readonly capabilities?: HubHostCapabilities | null;
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
 * The record whose *management* id (`hubHostId`, falling back to
 * `endpoint.id`) is `id` — the id `HostSheet` hands to `onBind`/`onEdit`/
 * `onRemove`, which is deliberately not always `endpoint.id`. Looking a
 * management id up with plain `findHost` would silently fail for a Hub's
 * default host, whose `endpoint.id` is aliased to `DEFAULT_HOST_ID` — see
 * `HostRecord.hubHostId`'s own doc comment.
 */
export function findHostByManageId(records: readonly HostRecord[], id: string): HostRecord | null {
  return records.find((record) => (record.hubHostId ?? record.endpoint.id) === id) ?? null;
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
  /**
   * True when `label` is a placeholder rather than a name anyone chose — the
   * local-mode default host, which is not a registry row and so has only its
   * id. Only then may the backend's hostname replace it.
   */
  labelIsPlaceholder?: boolean;
  probe?: HostProbe | undefined;
  isDefault?: boolean;
  canRemove?: boolean;
  /** Overrides the derived status, for a host the Hub reports as disabled. */
  forced?: { status: HostStatus; message: string } | undefined;
  /** `HubHostEntry.boundAt !== null`, or omitted entirely in local mode. */
  hubBound?: boolean;
  /** `HubHostEntry.id`, or omitted entirely in local mode. */
  hubHostId?: string;
  /** `HubHostEntry.baseUrl`, or omitted entirely in local mode. */
  hubBaseUrl?: string;
  /** `HubHostEntry.capabilities`, or omitted in local mode. */
  capabilities?: HubHostCapabilities | null;
}): HostRecord {
  const { status, compatibility } = entry.forced
    ? { status: entry.forced.status, compatibility: null }
    : hostStatusFor(entry.probe);
  const info = entry.probe?.info ?? null;
  // The registered name wins (PA-107). It used to be the other way round —
  // "an operator recognises `stone-dev01`, not the slug they typed" — which
  // was true while the dialog asked for a slug, and made the name field a
  // no-op the moment a probe came back. With the id generated, the label is
  // the one thing the user chose, so it is what they see. The hostname stays
  // available as `reportedName`, and still stands in for a placeholder.
  const reportedName = info?.name ?? null;
  const label = entry.labelIsPlaceholder ? (reportedName ?? entry.label) : entry.label;
  return {
    endpoint: entry.endpoint,
    label,
    reportedName,
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
    hubBound: entry.hubBound ?? null,
    hubHostId: entry.hubHostId ?? null,
    hubBaseUrl: entry.hubBaseUrl ?? null,
    // Filled by `withVersionDrift` below, which is the only thing that can:
    // drift needs the whole list, and this function sees one host.
    drift: detectVersionDrift(info?.version ?? null, null),
    capabilities: entry.capabilities ?? null,
  };
}

/**
 * Fills in `drift` across a whole list of records (PA-69).
 *
 * `hubLatestRelease` is what a Hub reports it knows exists
 * (`HubHostListResponse.latestRelease`) and wins when present. Without it the
 * fallback is the newest version any listed host reports, which is *evidence*
 * rather than authority: a fleet where every host is equally stale reports no
 * drift at all, and a standalone install reports none ever. Both are honest —
 * nothing here has seen a newer build — and both are strongly preferable to
 * the alternative, which is this app phoning a release feed on the internet to
 * find out.
 *
 * Offline hosts are included in the comparison basis on purpose: the last
 * version a host reported is still evidence that that version exists, and
 * dropping it would make a fleet's drift flicker as hosts go up and down.
 */
export function withVersionDrift(
  records: readonly HostRecord[],
  hubLatestRelease?: string | null,
): HostRecord[] {
  const latest =
    hubLatestRelease ?? latestKnownVersion(records.map((record) => record.version));
  return records.map((record) => ({
    ...record,
    drift: detectVersionDrift(record.version, latest),
  }));
}

/**
 * The drift sentence for one host, or null when there is nothing to say.
 *
 * Wraps `hostVersionStatus` so that the precedence rule — an incompatible host
 * reports its incompatibility, not an advisory "update available" — is applied
 * here, once, rather than in each of the three surfaces. That precedence is
 * the acceptance criterion: "behind" and "protocol-incompatible" have to stay
 * distinguishable, and an unusable host has a blocking problem that a badge
 * about versions would bury.
 */
export function hostDriftMessage(record: HostRecord): string | null {
  if (record.compatibility === null) return null;
  if (hostVersionStatus(record.compatibility, record.drift) !== 'behind') return null;
  return describeVersionDrift(record.label, record.drift);
}

/**
 * A host's tooltip-sized self-description: its name, then the machine's own
 * hostname when that says something the name does not (PA-107).
 */
export function hostTitle(record: HostRecord): string {
  return record.reportedName !== null && record.reportedName !== record.label
    ? `${record.label} (${record.reportedName})`
    : record.label;
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

/**
 * The "Server …" half of the build-version line (PA-107).
 *
 * That line used to be the *web bundle's* version with no label, which reads
 * as "the server's version" and is only true standalone: behind a Hub the Hub
 * serves the bundle. So it now names the component and reads the selected
 * host's own `HostInfo.version`. In the aggregated view no single host is
 * "the" server, so it summarises instead — one version if the fleet agrees,
 * a count if it does not (the per-host figures are in `detail`).
 *
 * `text` is null only when nothing has reported a version yet.
 */
export function serverVersionLine(
  hosts: readonly HostRecord[],
  selected: HostRecord | null,
): { text: string | null; detail: string | null } {
  if (selected !== null) {
    return {
      text: selected.version === null ? null : `Server ${selected.version}`,
      detail: null,
    };
  }
  const reported = hosts.filter((host) => host.version !== null);
  const versions = [...new Set(reported.map((host) => host.version!))];
  const detail =
    reported.length === 0 ? null : reported.map((host) => `${host.label}: ${host.version}`).join('\n');
  if (versions.length === 0) return { text: null, detail };
  if (versions.length === 1) {
    return {
      text: hosts.length > 1 ? `Servers ${versions[0]} (all ${hosts.length})` : `Server ${versions[0]}`,
      detail,
    };
  }
  return { text: `Servers: ${versions.length} versions`, detail };
}
