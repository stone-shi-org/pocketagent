/**
 * Which host groups the user has collapsed on the home screen (PA-67).
 *
 * Remembered like every other small UI preference here (`sidebar-width-pref`,
 * `open-tabs-pref`, `terminal-font-pref`) rather than held in memory, because
 * collapsing a host is a statement about how you work — a machine you keep
 * registered but rarely look at — and re-collapsing it on every load would make
 * the choice feel like it did not stick.
 *
 * It is also load-bearing for cost, not just tidiness: a collapsed group is not
 * polled at all (`poll-policy.ts`), so this is what a user reaches for when a
 * host they keep registered is one they do not want fetched every 15 seconds.
 *
 * Reads are validated and every access is wrapped — `localStorage` may be
 * unavailable (private browsing) or absent entirely (a unit test with no DOM),
 * and the worst outcome of a corrupt value must be "nothing collapsed".
 */
const KEY = 'pocketagent:collapsed-hosts';

export function loadCollapsedHosts(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    return [];
  }
}

export function saveCollapsedHosts(hostIds: readonly string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(hostIds));
  } catch {
    /* best effort only */
  }
}

/** Collapsed-set toggle that also persists, returning the new set. */
export function toggleCollapsedHost(hostIds: readonly string[], hostId: string): string[] {
  const next = hostIds.includes(hostId)
    ? hostIds.filter((id) => id !== hostId)
    : [...hostIds, hostId];
  saveCollapsedHosts(next);
  return next;
}
