import type { Route } from '../hooks/useHashRoute.js';
import { DEFAULT_HOST_ID } from '../api/host.js';
import { findHost, type HostRecord } from './host-status.js';

/**
 * Which host (or hosts) the current hash is asking for (PA-67).
 *
 * `all` is the aggregated home — the ticket's default view, where host is a
 * grouping dimension rather than a mode. `one` is a host-scoped view. `unknown`
 * is an id no registered host answers to, and it exists so that case can be
 * *rendered* rather than silently redirected; see `resolveSelection`.
 */
export type HostSelection =
  | { readonly mode: 'all' }
  | { readonly mode: 'one'; readonly hostId: string }
  | { readonly mode: 'unknown'; readonly hostId: string };

/**
 * Resolves the hash's optional host segment against the registered hosts.
 *
 * Two rules, and the interesting part is that they differ by route:
 *
 * 1. **No host segment on the list route ⇒ all hosts.** This is what makes the
 *    aggregate view the default without inventing a second spelling of `#/`
 *    (a `#/all` route would mean every one of the ~42 `navigate({name:'list'})`
 *    call sites having to choose between two equivalent destinations). With
 *    exactly one host the aggregate view renders that host with no heading, so
 *    a standalone install sees precisely today's home screen.
 * 2. **No host segment on any other route ⇒ the default host.** PA-60 promised
 *    that `#/s/<id>` keeps working, and "all hosts" is meaningless for a
 *    session pane, a composer or an editor anyway — there is nothing to
 *    aggregate.
 *
 * An unrecognised id resolves to `unknown` rather than falling back to the
 * default host. That is the deliberate reversal of PA-60's own fallback, which
 * its comment flagged for exactly this ticket: with one host, an id either
 * named it or named nothing, so falling back was safe; with several, quietly
 * substituting a different machine is the worst available outcome, because
 * every action taken on the page then lands somewhere the URL did not say. The
 * sha256-spelled bookmark that fallback was protecting keeps working through
 * `HostRecord.aliases` instead — it resolves to the default host because it
 * genuinely *is* the default host, not because nothing else matched.
 */
export function resolveSelection(
  hostIdFromHash: string | null,
  route: Route,
  records: readonly HostRecord[],
): HostSelection {
  if (hostIdFromHash === null) {
    if (route.name === 'list') return { mode: 'all' };
    const fallback = records.find((record) => record.isDefault) ?? records[0];
    return { mode: 'one', hostId: fallback?.endpoint.id ?? DEFAULT_HOST_ID };
  }
  const match = findHost(records, hostIdFromHash);
  if (match) return { mode: 'one', hostId: match.endpoint.id };
  return { mode: 'unknown', hostId: hostIdFromHash };
}

/**
 * The host whose chrome-level actions (Settings, Cron, a new shell, the
 * composer's default) apply, even in the all-hosts view.
 *
 * Those actions are per-host — a cron job runs on one machine, a project folder
 * is added to one machine — so "all hosts" cannot answer them. Rather than
 * disabling them in the aggregate view (which would make the default view the
 * crippled one), they target the default host, and every surface that offers
 * them per host does so from a host group's own heading, where the machine is
 * unambiguous.
 */
export function currentHostId(selection: HostSelection, records: readonly HostRecord[]): string {
  if (selection.mode === 'one') return selection.hostId;
  const fallback = records.find((record) => record.isDefault) ?? records[0];
  return fallback?.endpoint.id ?? DEFAULT_HOST_ID;
}

/**
 * Hosts to render on the home screen, in order, for a given selection.
 *
 * `all` keeps the registry's order (default host first — it is the one the
 * operator is sitting at); `one` narrows to that host. `unknown` returns none,
 * which is what lets the caller render the not-found state instead of an
 * arbitrary machine's chats.
 */
export function visibleHosts(
  selection: HostSelection,
  records: readonly HostRecord[],
): HostRecord[] {
  if (selection.mode === 'unknown') return [];
  if (selection.mode === 'one') {
    const match = findHost(records, selection.hostId);
    return match ? [match] : [];
  }
  return [...records];
}
