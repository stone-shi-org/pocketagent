import { Icon } from './Icon.js';
import {
  hostDotClass,
  hostDriftMessage,
  hostStatusSummary,
  hostTitle,
  type HostRecord,
} from '../hosts/host-status.js';

/**
 * The desktop host switcher: a narrow rail of tiles left of the sidebar (PA-67).
 *
 * **Chrome, not a category.** The standing convention is that both layouts
 * render the same three home-screen categories in the same order, and a
 * fourth-category host switcher would break it. A rail sits *outside* the
 * sidebar entirely — it switches what the sidebar is about, the same way the
 * tab strip switches what the workspace pane is about — so the three categories
 * below are untouched, in both layouts.
 *
 * Rendered only when there is something to switch between (see `show`): a 56 px
 * column containing one tile is not chrome, it is clutter, and suppressing it is
 * half of what keeps a single-host desktop identical to the pre-PA-67 one.
 *
 * The phone deliberately gets `HostSheet` instead of this. A permanent vertical
 * rail costs scarce width for something switched rarely, which is the trade the
 * ticket makes explicitly.
 */
export function HostRail({
  hosts,
  selectedHostId,
  onSelectAll,
  onSelect,
  onAdd,
  canManage,
  hub = null,
}: {
  hosts: readonly HostRecord[];
  /** Null in the aggregated "all hosts" view — and while the Hub is selected. */
  selectedHostId: string | null;
  /**
   * The Hub's own tile (PA-110), present only when a Hub serves this page.
   *
   * First in the rail because it is what the others hang off, and because on
   * a Hub with no hosts it is the only tile that leads anywhere. While it is
   * active no host tile is — the Hub is a third selection beside "all" and
   * "one", not a host — which is what lets the overflow menu offer Hub items
   * only (see `overflowMenuItems`).
   */
  hub?: { active: boolean; onSelect: () => void } | null;
  onSelectAll: () => void;
  onSelect: (hostId: string) => void;
  onAdd: () => void;
  canManage: boolean;
}): JSX.Element {
  const hubActive = hub?.active === true;
  const allActive = !hubActive && selectedHostId === null;
  return (
    <nav className="host-rail" aria-label="Hosts">
      {hub && (
        <button
          type="button"
          className={`host-tile hub${hubActive ? ' active' : ''}`}
          onClick={hub.onSelect}
          aria-pressed={hubActive}
          title="Hub — hosts, discovery and templates"
        >
          <Icon name="hub" size={18} />
          <span className="host-tile-label">Hub</span>
        </button>
      )}
      {/* Nothing to aggregate without a host; the Hub tile is the whole rail then. */}
      {hosts.length > 0 && (
        <button
          type="button"
          className={`host-tile${allActive ? ' active' : ''}`}
          onClick={onSelectAll}
          aria-pressed={allActive}
          title="All hosts"
        >
          <Icon name="agents" size={18} />
          <span className="host-tile-label">All</span>
        </button>
      )}

      {hosts.map((host) => {
        const drift = hostDriftMessage(host);
        return (
        <button
          key={host.endpoint.id}
          type="button"
          className={`host-tile${!hubActive && selectedHostId === host.endpoint.id ? ' active' : ''}`}
          onClick={() => onSelect(host.endpoint.id)}
          aria-pressed={!hubActive && selectedHostId === host.endpoint.id}
          // The tooltip carries the whole sentence for a host that cannot be
          // used; the tile itself only has room for a dot and a word, and a
          // phone-sized truth ("version") is not an explanation.
          // PA-69: the drift sentence joins the same tooltip, because it is
          // exactly the case the tile has no room to spell out. It cannot
          // collide with `host.message`: a host with a message is offline or
          // incompatible, and `hostDriftMessage` is null for both.
          title={host.message ?? drift ?? `${hostTitle(host)} — ${hostStatusSummary(host)}`}
        >
          <div className="host-tile-icon">
            <Icon name="host" size={18} />
            <span className={hostDotClass(host.status)} aria-hidden="true" />
          </div>
          <span className="host-tile-label">{host.label}</span>
          {host.runningSessions !== null && host.runningSessions > 0 && (
            <span className="host-tile-count">{host.runningSessions}</span>
          )}
          {drift !== null && <span className="host-tile-update" aria-hidden="true" />}
        </button>
        );
      })}

      {canManage && (
        <button type="button" className="host-tile add" onClick={onAdd} title="Add a host">
          <Icon name="plus" size={18} />
          <span className="host-tile-label">Add</span>
        </button>
      )}
    </nav>
  );
}
