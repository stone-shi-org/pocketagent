import { useEffect } from 'react';
import { Icon } from './Icon.js';
import {
  hostDotClass,
  hostDriftMessage,
  hostStatusSummary,
  type HostRecord,
} from '../hosts/host-status.js';

/**
 * The phone host switcher: a bottom sheet behind the header chip (PA-67).
 *
 * ## Which "sheet" this reuses
 *
 * The ticket says "reusing the existing `ApprovalSheet` pattern". The pattern
 * actually wanted is the **picker sheet** — `.sheet-backdrop`, `.sheet`,
 * `.sheet-title`, `.sheet-options`, `.sheet-option`, `.sheet-cancel` — which
 * `WorktreeDialog` and the composer's own pickers already use, and which is
 * exactly "a bottom sheet listing options with a dot each".
 *
 * `ApprovalSheet` itself is a different animal despite the name: a draggable,
 * minimizable, `pointer-events`-juggling pane built so a *blocked agent's*
 * decision cannot cover the transcript the user needs to read before deciding.
 * None of that applies to switching machines, and inheriting it would mean a
 * host switcher that can be dragged half off screen and minimized to a pill.
 * Flagged on the ticket rather than silently substituted.
 *
 * Every row carries the same dot and the same summary as the desktop rail and
 * the group heading, from the same `HostRecord` — three surfaces, one verdict,
 * which is the point of computing status in one place.
 */
export function HostSheet({
  hosts,
  selectedHostId,
  onSelectAll,
  onSelect,
  onAdd,
  onRemove,
  onBind,
  onEdit,
  onClose,
  canManage,
  hubVersion = null,
  hub = null,
  fleet = null,
}: {
  /**
   * PA-134: the Fleet agent, under the Hub entry. Opens its chat on the
   * coordinator; with a `problem` (coordinator unreachable) it opens the Hub
   * page instead, where the role can be moved.
   */
  fleet?: { problem: string | null; onOpen: () => void; onProblem: () => void } | null;
  /**
   * The Hub's own entry (PA-110), first in the list — the phone's
   * counterpart of the rail's Hub tile, and the same third selection: while
   * it is active neither "All hosts" nor any host row is.
   */
  hub?: { active: boolean; onSelect: () => void } | null;
  hosts: readonly HostRecord[];
  /**
   * The Hub's own version, or null standalone (PA-107). Shown as a footer
   * because the phone has no sidebar version line, and the sheet is where a
   * phone user is already looking at "which machines, which builds".
   */
  hubVersion?: string | null;
  selectedHostId: string | null;
  onSelectAll: () => void;
  onSelect: (hostId: string) => void;
  onAdd: () => void;
  /**
   * All three of `onRemove`/`onBind`/`onEdit` receive the Hub's own registry
   * id (`host.hubHostId`) when there is one, never the routing
   * `host.endpoint.id` — see `HostRecord.hubHostId`'s doc comment for why
   * those two differ for a Hub's default host, and why using the wrong one
   * here 404s on exactly that host.
   */
  onRemove: (hostId: string) => void;
  /** Only ever called for a host whose `hubBound` is non-null — see below. */
  onBind: (hostId: string) => void;
  onEdit: (hostId: string) => void;
  onClose: () => void;
  canManage: boolean;
}): JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // The sheet is a *child* of the backdrop, which is the flex container that
  // positions it (bottom on a phone, centred past 600px) — the same structure
  // `WorktreeDialog` and the composer's pickers use. As siblings the backdrop
  // simply covers the sheet and nothing in it can be clicked, which is how the
  // multi-host demo caught this.
  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet host-sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Hosts"
      >
        <div className="sheet-title">Hosts</div>
        <div className="sheet-options">
          {hub && (
            <button
              type="button"
              className={`sheet-option${hub.active ? ' selected' : ''}`}
              onClick={() => {
                hub.onSelect();
                onClose();
              }}
            >
              <Icon name="hub" size={18} />
              <span>Hub</span>
              <span className="sheet-option-detail">Hosts, discovery and templates</span>
            </button>
          )}

          {fleet && (
            <button
              type="button"
              className="sheet-option"
              onClick={() => {
                if (fleet.problem) fleet.onProblem();
                else fleet.onOpen();
                onClose();
              }}
            >
              <Icon name="agents" size={18} />
              <span>Fleet</span>
              <span className={`sheet-option-detail${fleet.problem ? ' warn' : ''}`}>
                {fleet.problem ?? 'Dispatch tasks to the right host'}
              </span>
            </button>
          )}

          {hosts.length > 0 && (
            <button
              type="button"
              className={`sheet-option${!hub?.active && selectedHostId === null ? ' selected' : ''}`}
              onClick={() => {
                onSelectAll();
                onClose();
              }}
            >
              <Icon name="agents" size={18} />
              <span>All hosts</span>
            </button>
          )}

          {hosts.map((host) => {
            const drift = hostDriftMessage(host);
            // The id every management call below must use — see the prop
            // doc comment above for why this is not always `endpoint.id`.
            const manageId = host.hubHostId ?? host.endpoint.id;
            return (
            <div key={host.endpoint.id} className="host-sheet-row">
              <button
                type="button"
                className={`sheet-option${!hub?.active && selectedHostId === host.endpoint.id ? ' selected' : ''}`}
                onClick={() => {
                  onSelect(host.endpoint.id);
                  onClose();
                }}
              >
                <span className={hostDotClass(host.status)} aria-hidden="true" />
                <Icon name="host" size={18} />
                <span>{host.label}</span>
                {/* The machine's own hostname, secondary (PA-107): the name the
                    user gave it is primary, but a phone has no tooltip to put
                    "which box is this" in. */}
                {host.reportedName !== null && host.reportedName !== host.label && (
                  <span className="sheet-option-detail host-sheet-hostname">{host.reportedName}</span>
                )}
                <span className="sheet-option-detail host-sheet-status">{hostStatusSummary(host)}</span>
                {/* The full sentence, not a tooltip: a phone has no hover, so
                    an unusable host has to explain itself in place. */}
                {host.message && <span className="host-sheet-problem">{host.message}</span>}
                {/* Same reasoning one line up, and mutually exclusive with it:
                    a phone cannot hover, so drift says its whole sentence
                    here rather than hiding in a `title`. */}
                {drift !== null && <span className="host-sheet-note">{drift}</span>}
              </button>
              {/* Same gate `canRemove` already gives Remove below: false only
                  for the local-mode synthetic entry that *is* the origin
                  serving this bundle, which is not a registry row at all
                  and so has nothing here to edit. */}
              {canManage && host.canRemove && (
                <button
                  type="button"
                  className="round-btn plain host-sheet-edit"
                  onClick={() => {
                    onEdit(manageId);
                    onClose();
                  }}
                  aria-label={`Edit ${host.label}`}
                  title={`Edit ${host.label}`}
                >
                  <Icon name="edit" size={16} />
                </button>
              )}
              {/* `hubBound` is null in local mode, where there is no separate
                  credential to hold at all — see `HostRecord`'s own doc
                  comment. Shown for *every* Hub-mode row, bound or not: a
                  bound host can still need a fresh credential re-minted
                  (e.g. after `POCKETAGENT_SETTINGS_ENC_KEY` rotates on the
                  Hub), so "Re-bind" has to stay reachable even once
                  `hubBound` is true. */}
              {canManage && host.hubBound !== null && (
                <button
                  type="button"
                  className="round-btn plain host-sheet-bind"
                  onClick={() => {
                    // Closes the sheet first, the same order "Add host…" uses
                    // below — `BindHostDialog` is its own backdrop, and two
                    // stacked ones is not the intended layering.
                    onBind(manageId);
                    onClose();
                  }}
                  aria-label={`${host.hubBound ? 'Re-bind' : 'Bind'} ${host.label}`}
                  title={
                    host.hubBound
                      ? `Re-bind ${host.label} (mint a fresh credential)`
                      : `Bind ${host.label} (no usable credential yet)`
                  }
                >
                  <Icon name="key" size={16} />
                </button>
              )}
              {canManage && host.canRemove && (
                <button
                  type="button"
                  className="round-btn plain host-sheet-remove"
                  onClick={() => onRemove(manageId)}
                  aria-label={`Remove ${host.label}`}
                  title={`Remove ${host.label}`}
                >
                  <Icon name="trash" size={16} />
                </button>
              )}
            </div>
            );
          })}

          {canManage && (
            <button
              type="button"
              className="sheet-option"
              onClick={() => {
                onAdd();
                onClose();
              }}
            >
              <Icon name="plus" size={18} />
              <span>Add host…</span>
            </button>
          )}
        </div>
        {hubVersion !== null && <p className="host-sheet-hub-version">Hub {hubVersion}</p>}
        <button type="button" className="sheet-cancel" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
