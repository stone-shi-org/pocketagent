import { useEffect } from 'react';
import { Icon } from './Icon.js';
import { hostDotClass, hostStatusSummary, type HostRecord } from '../hosts/host-status.js';

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
  onClose,
  canManage,
}: {
  hosts: readonly HostRecord[];
  selectedHostId: string | null;
  onSelectAll: () => void;
  onSelect: (hostId: string) => void;
  onAdd: () => void;
  onRemove: (hostId: string) => void;
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
          <button
            type="button"
            className={`sheet-option${selectedHostId === null ? ' selected' : ''}`}
            onClick={() => {
              onSelectAll();
              onClose();
            }}
          >
            <Icon name="agents" size={18} />
            <span>All hosts</span>
          </button>

          {hosts.map((host) => (
            <div key={host.endpoint.id} className="host-sheet-row">
              <button
                type="button"
                className={`sheet-option${selectedHostId === host.endpoint.id ? ' selected' : ''}`}
                onClick={() => {
                  onSelect(host.endpoint.id);
                  onClose();
                }}
              >
                <span className={hostDotClass(host.status)} aria-hidden="true" />
                <span>{host.label}</span>
                <span className="sheet-option-detail">{hostStatusSummary(host)}</span>
                {/* The full sentence, not a tooltip: a phone has no hover, so
                    an unusable host has to explain itself in place. */}
                {host.message && <span className="host-sheet-problem">{host.message}</span>}
              </button>
              {canManage && host.canRemove && (
                <button
                  type="button"
                  className="round-btn plain host-sheet-remove"
                  onClick={() => onRemove(host.endpoint.id)}
                  aria-label={`Remove ${host.label}`}
                  title={`Remove ${host.label}`}
                >
                  <Icon name="trash" size={16} />
                </button>
              )}
            </div>
          ))}

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
        <button type="button" className="sheet-cancel" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
