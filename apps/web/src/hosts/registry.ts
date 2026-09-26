import { isHubHostId } from '@pocketagent/protocol';
import { normalizeBasePath } from '../api/host.js';

/**
 * Hosts this browser knows about when there is no Hub answering (PA-67).
 *
 * ## Why a local registry exists at all
 *
 * The Hub (PA-66) is the real registry: it holds the scoped credentials, polls
 * health, and is the only component that is *supposed* to know several backends
 * exist. It is planned and not implemented. Meanwhile this ticket's acceptance
 * criteria include "adding, switching and removing a host works from both
 * layouts", and a UI that cannot be exercised is a UI that cannot be reviewed.
 *
 * So the host list has two sources and exactly one is live at a time
 * (`directory.ts` picks between them at boot, never merges them — two
 * registries disagreeing about which hosts exist is precisely the confusion
 * worth avoiding). This is the fallback one: a list of same-origin path
 * prefixes, remembered per browser, which is what a reverse proxy in front of
 * two backends already provides without any new service. When a Hub answers,
 * none of this is read.
 *
 * ## Why it cannot become a security hole
 *
 * A registered host is a **base path**, never a URL, and every write goes
 * through `normalizeBasePath`, which forces a leading `/` and cannot produce an
 * absolute URL: `https://evil.example` normalizes to the path
 * `/https:/evil.example`. So the worst a hand-edited or hostile
 * `localStorage` value can do is make requests to this same origin that 404 —
 * it can neither redirect credentials to another origin nor widen what the
 * cookie is sent to. `host.test.ts` pins that.
 *
 * Reads are validated rather than trusted and degrade to "no extra hosts",
 * the same discipline `open-tabs-pref.ts` applies for the same reason: a
 * shape change or a corrupted value must not stop the app booting.
 * `localStorage` itself may be absent (private browsing, or no DOM at all in a
 * unit test), so every access is wrapped.
 */
const KEY = 'pocketagent:hosts';

export interface LocalHostEntry {
  /** Routing id, and what appears in `#/h/<id>/...`. */
  readonly id: string;
  readonly label: string;
  /** Same-origin prefix, e.g. `/h/dev02`. Never empty — that is the default host. */
  readonly basePath: string;
}

/**
 * The prefix a newly added host is proposed at.
 *
 * Matches the Hub's own routing table (`/h/<id>/api/**`) so that a host
 * registered by hand today keeps working unchanged once a Hub is put in front
 * of the same backends — the path a human configures in their proxy is the path
 * the Hub would have served.
 */
export function defaultBasePathFor(id: string): string {
  return `/h/${id}`;
}

function isLocalHostEntry(value: unknown): value is LocalHostEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !isHubHostId(entry.id)) return false;
  if (typeof entry.label !== 'string' || entry.label.length === 0) return false;
  if (typeof entry.basePath !== 'string') return false;
  // An empty prefix *is* the host serving this bundle, which is synthesized
  // separately and must never be duplicated by a stored row.
  return normalizeBasePath(entry.basePath) !== '';
}

export function loadLocalHosts(): LocalHostEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    return parsed.filter(isLocalHostEntry).filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  } catch {
    return [];
  }
}

export function saveLocalHosts(entries: readonly LocalHostEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* private browsing, or no storage at all — best effort only */
  }
}

/** Why an entry cannot be added, or null when it can. */
export function localHostProblem(
  entry: { id: string; label: string; basePath: string },
  existing: readonly LocalHostEntry[],
  reservedIds: readonly string[],
): string | null {
  if (!isHubHostId(entry.id)) {
    return 'A host id is 1–40 lowercase letters, digits or inner hyphens.';
  }
  if (reservedIds.includes(entry.id) || existing.some((row) => row.id === entry.id)) {
    return 'That host id is already taken.';
  }
  if (entry.label.trim().length === 0) return 'Give the host a name.';
  if (normalizeBasePath(entry.basePath) === '') {
    return 'The path prefix cannot be empty — that is this server.';
  }
  return null;
}

/** Adds an entry, normalizing its prefix. Returns the new list. */
export function addLocalHost(
  entry: { id: string; label: string; basePath: string },
  existing: readonly LocalHostEntry[],
): LocalHostEntry[] {
  const next: LocalHostEntry[] = [
    ...existing.filter((row) => row.id !== entry.id),
    { id: entry.id, label: entry.label.trim(), basePath: normalizeBasePath(entry.basePath) },
  ];
  saveLocalHosts(next);
  return next;
}

export function removeLocalHost(id: string, existing: readonly LocalHostEntry[]): LocalHostEntry[] {
  const next = existing.filter((row) => row.id !== id);
  saveLocalHosts(next);
  return next;
}

/** `HUB_HOST_ID_PATTERN`'s length bound, restated for the truncation below. */
const MAX_HOST_ID_LENGTH = 40;

/**
 * A routing id derived from the name a human typed (PA-107).
 *
 * The id is a URL slug (`#/h/<id>/`, `/h/<id>/api/**`), and asking a person
 * to invent one next to a free-text name was asking them to name the same
 * thing twice. So it is generated here, **once**, at add time — and never
 * again: renaming a host edits `label` only, because every bookmark, deep
 * link, persisted tab (`t:<hostId>:<sessionId>`) and Hub-push deep link keys
 * on the id. Re-deriving it on rename would silently break all of them.
 *
 * Generated in the browser rather than by the Hub, and deliberately so: the
 * local directory has no server to ask, so the browser needs this generator
 * regardless, and one generator for both sources means one set of rules. It
 * also leaves `CreateHubHostRequest.id` required and the Hub's schema
 * untouched, so an older bundle keeps working against a newer Hub and vice
 * versa. The Hub still refuses a duplicate (409), which is what covers two
 * browsers adding at once — `directory.add` re-derives against the fresh list
 * and retries once.
 *
 * Rules: NFKD-fold and drop diacritics ("Büro" → "buro"), lowercase, collapse
 * every other run to `-`, trim hyphens, and truncate so the result *plus any
 * collision suffix* still fits the pattern. A clash gets `-2`, `-3`, … A name
 * with nothing slug-able in it (e.g. only CJK) gets `host-<random>`, because a
 * transliteration table is not worth carrying for an id nobody has to read.
 */
export function generateHostId(
  name: string,
  existingIds: Iterable<string>,
  random: () => number = Math.random,
): string {
  const taken = new Set(existingIds);
  const base = slugifyHostName(name);
  if (base === '') {
    for (;;) {
      const candidate = `host-${randomSuffix(random)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const stem = trimHyphens(base.slice(0, MAX_HOST_ID_LENGTH - suffix.length));
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The slug half of `generateHostId`, exported for its tests. Empty when nothing survives. */
export function slugifyHostName(name: string): string {
  const folded = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
  return trimHyphens(trimHyphens(folded).slice(0, MAX_HOST_ID_LENGTH));
}

function trimHyphens(value: string): string {
  return value.replace(/^-+|-+$/g, '');
}

function randomSuffix(random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}
