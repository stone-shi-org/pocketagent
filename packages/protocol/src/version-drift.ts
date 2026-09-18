/**
 * Version drift: "is this host running an older build than the newest one we
 * know about?" (PA-69).
 *
 * Lives in the protocol package beside `protocol-negotiation.ts`, and for the
 * identical reason that one records: three components need the same answer.
 * The browser's host rail and host sheet draw the badge, `apps/hub` (PA-66)
 * will draw the same badge in its own host list, and the two must not be able
 * to describe the same skew differently. A second copy of semver comparison is
 * a second set of edge cases around prereleases, and the first time the two
 * disagree the UI is simply lying about which machine needs attention.
 *
 * ## Drift is not compatibility, and the two must not be merged
 *
 * `negotiateProtocol` answers "can this bundle talk to that host *at all*" and
 * its answer is binary and blocking. This module answers "is that host behind"
 * — advisory, never blocking, and true of hosts that work perfectly well.
 * `HostInfo` keeps `version` and `protocol` as independent fields for exactly
 * this reason (see its own doc comment), so the two checks stay independent
 * here too. `hostVersionStatus` below is the one place their precedence is
 * decided, so no consumer has to re-derive it.
 *
 * Deliberately imports nothing but `protocol-negotiation.js`, which itself
 * imports only zod — `session.ts` needs `HostInfo` to stay cycle-free.
 */
import type { HostCompatibility } from './protocol-negotiation.js';

/** The numeric core plus optional prerelease and build-metadata parts. */
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated prerelease identifiers; empty for a normal release. */
  readonly prerelease: readonly string[];
}

/**
 * Parses a semver string, or returns null if it is not one.
 *
 * Null rather than a throw because every caller here has a real "I do not
 * know" state to fall into — a host that has never been probed, or one so old
 * its `/health` predates `version` — and turning that into an exception would
 * make one unparseable host break the whole list's rendering.
 */
function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    // Build metadata (`+abc1234`) is captured by the regex and then dropped:
    // semver says it is explicitly *not* part of precedence, so `1.4.2+a` and
    // `1.4.2+b` are the same version and must not read as drift. CI stamps a
    // git SHA there (see `resolveServerVersion`), so this is the common case
    // rather than a hypothetical one.
    prerelease: prerelease === undefined ? [] : prerelease.split('.'),
  };
}

/** Numeric identifiers are all-digits and compare numerically, not as text. */
function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * Compares two prerelease identifier lists by semver §11 precedence.
 *
 * The three rules, each of which is a real case for this repo's own tags
 * (`1.2.3-rc.1` and `0.0.0-dev` both occur): a version *with* a prerelease
 * sorts below the same version without one; numeric identifiers compare
 * numerically so `rc.10` is above `rc.9` rather than below it lexically; and
 * when one list is a prefix of the other, the longer one wins.
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  // A release outranks any prerelease of the same core version.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const idA = a[i]!;
    const idB = b[i]!;
    if (idA === idB) continue;
    const numA = isNumericIdentifier(idA);
    const numB = isNumericIdentifier(idB);
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (numA && !numB) return -1;
    if (!numA && numB) return 1;
    if (numA && numB) return Number(idA) < Number(idB) ? -1 : 1;
    return idA < idB ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * Semver precedence: negative if `a` is older, positive if newer, 0 if equal.
 *
 * Returns null when either side is unparseable, which is a *distinct* answer
 * from "equal" and has to stay distinct: collapsing it to 0 would report a
 * host running a garbage version string as up to date.
 */
export function compareSemver(a: string, b: string): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * The newest parseable version in a set, or null if there is none.
 *
 * This is the fallback definition of "the latest known release" while no Hub
 * is answering: with several backends registered, the newest one any of them
 * reports is real evidence that a release exists, and it needs no network call
 * and no hardcoded release feed. It is deliberately *evidence*, not authority
 * — a fleet where every host is equally stale reports no drift at all, which
 * is honest rather than wrong, since nothing here has seen a newer build.
 *
 * A Hub that does know (`HubHostListResponse.latestRelease`) supersedes it.
 */
export function latestKnownVersion(
  versions: readonly (string | null | undefined)[],
): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (version === null || version === undefined || version === '') continue;
    if (parseSemver(version) === null) continue;
    if (best === null) {
      best = version;
      continue;
    }
    const cmp = compareSemver(version, best);
    if (cmp !== null && cmp > 0) best = version;
  }
  return best;
}

/** Where one host's build sits relative to the newest known one. */
export type VersionDriftState =
  /** Running the newest version anything has reported. */
  | 'current'
  /** A newer build exists. The only state that is surfaced as an action. */
  | 'behind'
  /**
   * Newer than the newest *known* release — so what is stale is our idea of
   * "latest", not the host. Kept separate from `current` rather than folded
   * into it because it means something different and a reader of the badge
   * would otherwise have no way to tell a canary host from an up-to-date one.
   */
  | 'ahead'
  /** No version to compare: never probed, unparseable, or nothing newer seen. */
  | 'unknown';

export interface VersionDrift {
  readonly state: VersionDriftState;
  /** What this host reports, verbatim, or null if unknown. */
  readonly hostVersion: string | null;
  /** The newest version known anywhere, or null. */
  readonly latestVersion: string | null;
}

/**
 * Compares one host's reported build against the newest known one.
 *
 * Pure and total: every combination of missing, malformed and valid inputs
 * lands in one of the four states rather than throwing, because this runs
 * inside a list render where one bad row must not blank the page.
 */
export function detectVersionDrift(
  hostVersion: string | null | undefined,
  latestVersion: string | null | undefined,
): VersionDrift {
  const host = hostVersion === undefined || hostVersion === '' ? null : hostVersion;
  const latest = latestVersion === undefined || latestVersion === '' ? null : latestVersion;
  if (host === null || latest === null) {
    return { state: 'unknown', hostVersion: host, latestVersion: latest };
  }
  const cmp = compareSemver(host, latest);
  if (cmp === null) return { state: 'unknown', hostVersion: host, latestVersion: latest };
  if (cmp < 0) return { state: 'behind', hostVersion: host, latestVersion: latest };
  if (cmp > 0) return { state: 'ahead', hostVersion: host, latestVersion: latest };
  return { state: 'current', hostVersion: host, latestVersion: latest };
}

/**
 * The sentence the ticket asks for, worded once.
 *
 * Null for every state but `behind`: `current` needs no prose, `unknown` has
 * nothing true to say, and `ahead` describes a stale idea of "latest" rather
 * than anything an operator should act on — announcing any of the three would
 * turn a list of five healthy hosts into five notices.
 *
 * It deliberately does **not** offer to do anything about it. The server never
 * replaces its own code (that is this ticket's entire premise), so the only
 * honest phrasing names the two versions and stops; how a new image reaches
 * that machine is fixed at deploy time and is not this UI's business.
 */
export function describeVersionDrift(hostName: string, drift: VersionDrift): string | null {
  if (drift.state !== 'behind') return null;
  return `${hostName} is on ${drift.hostVersion}, ${drift.latestVersion} available.`;
}

/**
 * What one host row should say about its version, with the precedence between
 * drift and protocol incompatibility decided *here* rather than in each
 * renderer.
 *
 * Incompatibility wins, and that is the acceptance criterion this function
 * exists to hold: "behind" and "protocol-incompatible" must stay
 * distinguishable, and a host this bundle cannot talk to has a blocking
 * problem that an advisory "update available" badge would bury. The reverse
 * ordering would be actively misleading — an unusable host is not merely
 * lagging, and an unreachable one may be mid-restart with no version to read.
 *
 * Note that `incompatible` covers `above_max` (the host is too old to talk to)
 * and that this is the same underlying condition as an extreme `behind`. They
 * are still reported separately because the remedy differs: `behind` is
 * optional, `above_max` is mandatory before that host can be used at all.
 */
export function hostVersionStatus(
  compatibility: HostCompatibility,
  drift: VersionDrift,
): 'incompatible' | 'behind' | 'ok' {
  if (!compatibility.compatible) return 'incompatible';
  return drift.state === 'behind' ? 'behind' : 'ok';
}
