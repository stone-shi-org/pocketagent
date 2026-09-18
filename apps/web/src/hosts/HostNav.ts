import type { Route } from '../hooks/useHashRoute.js';
import { DEFAULT_HOST, type HostEndpoint } from '../api/host.js';
import { findHost, type HostRecord } from './host-status.js';
import type { HostSelection } from './selected-host.js';

/**
 * Navigating *with* a host, in one place (PA-67).
 *
 * Every surface that opens something — a chat row, a tab, a rail tile, the
 * composer — has to answer "on which machine", and the answer has to end up in
 * the URL without every call site growing a field. `HostNav` is the object
 * those surfaces are handed instead.
 */
export interface HostNav {
  readonly selection: HostSelection;
  readonly hosts: readonly HostRecord[];
  /** Endpoint for a host id, falling back to the default host. */
  readonly endpointFor: (hostId: string) => HostEndpoint;
  /** Scope the view to one host, or to all of them with `null`. */
  readonly goToHost: (hostId: string | null) => void;
  /** Open a route on a specific host. */
  readonly openOn: (hostId: string, route: Route) => void;
}

export function endpointFor(hosts: readonly HostRecord[], hostId: string): HostEndpoint {
  return findHost(hosts, hostId)?.endpoint ?? DEFAULT_HOST;
}

/**
 * Whether a navigation to `hostId` should write a `#/h/<id>/` segment.
 *
 * The default host's routes stay **bare**, which is what keeps a single-host
 * install's URLs byte-identical to the pre-PA-67 ones — PA-60 went out of its
 * way not to rewrite existing bookmarks into `#/h/local/...` on the first
 * navigation, and a multi-host UI that did it anyway would undo that for the
 * overwhelmingly common deployment.
 *
 * The one exception is the **list** route, where the segment is the only thing
 * distinguishing "this host's home" from the aggregated all-hosts home: they
 * are genuinely different views, so the default host's own home is
 * `#/h/<defaultId>` while `#/` means all of them.
 */
export function hostSegmentFor(
  hosts: readonly HostRecord[],
  hostId: string,
  route: Route,
): string | null {
  const record = findHost(hosts, hostId);
  if (record && !record.isDefault) return record.endpoint.id;
  if (route.name === 'list') return record?.endpoint.id ?? hostId;
  return null;
}
