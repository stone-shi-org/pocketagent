/**
 * Which hosts the home screen actually fetches from, and how often (PA-67).
 *
 * The ticket's constraint is one line — "the aggregate view is built from
 * per-host `GET /api/projects` polling, lazily" — and the reason it matters is
 * arithmetic. The single-host home already runs *two* 5 s pollers issuing three
 * requests between them (`useProjects` for the project list, `usePlannerChats`
 * for workspaces and chats). Repeating that per host is 3N requests every five
 * seconds, forever, on a phone — so "lazily" has to mean something more
 * specific than "later".
 *
 * Three tiers, and the middle one is what stops the aggregate home from being
 * either wasteful or empty:
 *
 * - **Foreground** (`FOREGROUND_MS`, the existing 5 s): the selected host, plus
 *   any host with an open desktop tab. A tab holds a live socket and a visible
 *   transcript; its chat list must not lag behind it.
 * - **Background** (`BACKGROUND_MS`): a host whose group is expanded in the
 *   all-hosts view but which you are not looking *at*. Rejected alternative:
 *   collapse every group by default and poll nothing, which makes the
 *   "aggregated home" a list of headings — the opposite of what the ticket
 *   asks for. Groups start expanded and the cadence carries the cost instead.
 * - **Never**: a collapsed group. Its heading still shows a dot and a running
 *   count, because those come from the status tier (one `GET /api/hosts` per
 *   host per 30 s), not from this.
 *
 * All of it is pure so the policy is testable without a DOM, which is the only
 * way anything in `apps/web` gets a unit test (see `vitest.config.ts`: the web
 * project runs in `environment: 'node'` with no React Testing Library).
 */

/** The pre-existing home-screen cadence, unchanged for the host you are on. */
export const FOREGROUND_MS = 5_000;

/**
 * Cadence for an expanded host you are not looking at.
 *
 * 15 s rather than 5 s: three times cheaper per host, and still fresh enough
 * that a chat started elsewhere shows up while you are still on the screen.
 */
export const BACKGROUND_MS = 15_000;

/** Status-tier cadence: cheap, every host, drives every dot. */
export const STATUS_MS = 30_000;

/**
 * Per-request ceiling for both tiers.
 *
 * `request()` has no timeout and deliberately keeps none — a prompt or a git
 * operation may legitimately take minutes. A *poll* is the opposite: a host
 * that has not answered in eight seconds is a host to draw as offline and
 * retry, and without this the acceptance criterion "never a spinner that never
 * resolves" is unenforceable, because a black-holed TCP connection hangs a
 * `fetch` until the browser gives up on its own schedule.
 */
export const PROBE_TIMEOUT_MS = 8_000;

export interface PollInputs {
  /** Host this view is scoped to, or null in the all-hosts view. */
  readonly selectedHostId: string | null;
  /** Hosts whose group the user has collapsed. */
  readonly collapsedHostIds: readonly string[];
  /** Hosts with at least one open desktop tab. */
  readonly tabHostIds: readonly string[];
  /** True when there is exactly one host, which has no collapsible heading. */
  readonly singleHost: boolean;
}

/**
 * How often to fetch one host's home payload, or null to not fetch at all.
 *
 * With a single host this always returns `FOREGROUND_MS`, which is what keeps
 * the standalone deployment byte-identical to the pre-PA-67 behaviour: same
 * cadence, same three requests, no new conditions reached.
 */
export function pollIntervalFor(hostId: string, inputs: PollInputs): number | null {
  if (inputs.singleHost) return FOREGROUND_MS;
  if (inputs.tabHostIds.includes(hostId)) return FOREGROUND_MS;
  if (inputs.selectedHostId !== null) {
    // Scoped to one host: nothing else is on screen, so nothing else is worth
    // a request beyond the tab hosts already allowed above.
    return hostId === inputs.selectedHostId ? FOREGROUND_MS : null;
  }
  return inputs.collapsedHostIds.includes(hostId) ? null : BACKGROUND_MS;
}

/** Every host that should be fetched at all, in the order given. */
export function activeHostIds(hostIds: readonly string[], inputs: PollInputs): string[] {
  return hostIds.filter((id) => pollIntervalFor(id, inputs) !== null);
}

/** Longest a failing host's own backoff may reach. */
export const MAX_BACKOFF_MS = 60_000;

/**
 * How long to wait before retrying a host whose last `consecutiveFailures`
 * fetches failed.
 *
 * Without this, one dead host in the registry costs a request every five
 * seconds indefinitely — and on a phone that is a battery and data cost paid
 * for a machine that is switched off. Doubling from the tier's own interval and
 * capping at a minute keeps a briefly-rebooting host recovering quickly while a
 * permanently-gone one settles into background noise.
 *
 * Deliberately no jitter: with a handful of hosts there is no thundering herd
 * to spread, and a deterministic schedule is one a test can assert.
 */
export function backoffMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  const grown = baseMs * 2 ** Math.min(consecutiveFailures, 8);
  return Math.min(grown, MAX_BACKOFF_MS);
}

/** Whether a host is due, given when it was last attempted. */
export function isDue(now: number, lastAttemptAt: number | undefined, intervalMs: number): boolean {
  if (lastAttemptAt === undefined) return true;
  return now - lastAttemptAt >= intervalMs;
}
