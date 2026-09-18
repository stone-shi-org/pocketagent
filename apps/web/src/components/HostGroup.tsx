import { Icon } from './Icon.js';
import {
  hostDotClass,
  hostDriftMessage,
  hostStatusSummary,
  type HostRecord,
} from '../hosts/host-status.js';

/**
 * A host heading, wrapping that host's three home-screen categories (PA-67).
 *
 * ## Why a heading and not a badge per row
 *
 * The ticket names this tension itself: an aggregated home needs to say which
 * machine a chat is on, and the standing convention is that "the home screen
 * carries no metadata per row on purpose — a chat is its title and, if running,
 * a green dot". Both survive because the host rides *above* the rows. Nothing
 * inside `PocketAgentsSection`, `ShellSection` or `ProjectList` learned about
 * hosts at all, which is also what keeps them shared between the two layouts:
 * a component that never sees a host cannot render one differently on a phone.
 *
 * ## Why it disappears with one host
 *
 * `children` is returned bare when `show` is false, so a standalone install
 * renders precisely the pre-PA-67 home screen — no heading, no chevron, no
 * wrapper element. That is the property the whole ticket was shaped around, and
 * it is one line here.
 *
 * An offline or incompatible host renders its heading *and* a legible reason,
 * never an empty list and never a spinner: the categories below it are simply
 * not rendered, because there is nothing to render, and the reason is what
 * takes their place.
 */
export function HostGroup({
  host,
  show,
  collapsed,
  onToggle,
  onSelect,
  actions,
  children,
}: {
  host: HostRecord;
  /** False when there is only one host — see the doc comment. */
  show: boolean;
  collapsed: boolean;
  onToggle: () => void;
  /** Scopes the whole view to this host (`#/h/<id>/`). */
  onSelect: () => void;
  /** Per-host chrome: a "new chat here" button, the host's own overflow menu. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  if (!show) return <>{children}</>;

  const unusable = host.status === 'offline' || host.status === 'incompatible';
  const drift = hostDriftMessage(host);

  return (
    <section className={`host-group${collapsed ? ' collapsed' : ''}`}>
      <div className="host-group-head">
        <button
          type="button"
          className="host-group-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${host.label}` : `Collapse ${host.label}`}
        >
          {/* One rotated chevron rather than a second asset, the same
              `project-caret` affordance every other collapsible section on
              this screen already uses. */}
          <Icon name="chevron-down" className={`project-caret${collapsed ? ' closed' : ''}`} size={16} />
        </button>
        <button type="button" className="host-group-name" onClick={onSelect}>
          <span className={hostDotClass(host.status)} aria-hidden="true" />
          <span className="host-name">{host.label}</span>
          <span className="host-group-summary">{hostStatusSummary(host)}</span>
          {/* PA-69: drift is advisory, so it rides on the host row as a quiet
              badge rather than as a notice competing with the unusable
              branch below. `hostDriftMessage` returns null for an
              incompatible host, so the two can never both speak. */}
          {drift !== null && (
            <span className="host-group-update" title={drift}>
              update
            </span>
          )}
        </button>
        {actions}
      </div>
      {!collapsed &&
        (unusable ? (
          // The "legible state" the acceptance criteria ask for. Deliberately
          // not an empty category list: "no chats" and "this machine is not
          // answering" look identical, and only one of them is worth acting on.
          <div className="notice inline warn host-group-problem" role="status">
            {host.message}
          </div>
        ) : (
          <div className="host-group-body">{children}</div>
        ))}
    </section>
  );
}
