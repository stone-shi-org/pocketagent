import { useState } from 'react';
import { Icon, type IconName } from './Icon.js';

interface Props {
  variant: 'danger' | 'warn';
  icon: IconName;
  label: string;
  tooltip: string;
}

/**
 * Compact standing disclosure badge for the session title bar (`AgentPage` and
 * `TerminalPage`). Keeps persistent notices (such as skip-permissions and
 * `providerDisclosure`) visible in the header without spending vertical chat
 * space on full-width banners; hovering, focusing, or tapping reveals the full
 * explanation in a tooltip below the badge.
 */
export function TopbarDisclosureBadge({ variant, icon, label, tooltip }: Props): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <button
      type="button"
      className={`topbar-badge topbar-badge--${variant}${open ? ' open' : ''}`}
      aria-label={`${label}: ${tooltip}`}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      onBlur={() => setOpen(false)}
    >
      <Icon name={icon} size={13} />
      <span className="topbar-badge-label">{label}</span>
      <span className="topbar-badge-tooltip" role="tooltip">
        {tooltip}
      </span>
    </button>
  );
}
