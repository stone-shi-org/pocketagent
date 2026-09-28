import type { Route } from '../hooks/useHashRoute.js';
import type { HostSource } from './directory.js';

/**
 * Where the Hub's own surface begins and a host's ends (PA-110).
 *
 * Before this, a Hub served the backend UI and nothing else: with no host
 * registered, "New chat", Settings, Cron and the rest all rendered and all
 * talked to a default host that did not exist. The fix is a third thing to
 * select beside "all hosts" and "one host" — the Hub itself — and this module
 * is the one place that decides when it is selected and what each selection's
 * overflow menu may offer, so the two layouts cannot disagree about either.
 */

/** The routes that belong to the Hub rather than to any host. */
export type HubRoute = Extract<Route, { name: 'hub' } | { name: 'hub-templates' } | { name: 'hub-template' }>;

export function isHubRoute(route: Route): route is HubRoute {
  return route.name === 'hub' || route.name === 'hub-templates' || route.name === 'hub-template';
}

/**
 * Whether the Hub's view replaces the host UI.
 *
 * Only ever with a Hub (a standalone install has no Hub view at all, which is
 * what keeps it byte-identical), and then for two reasons: a Hub route was
 * asked for, or **there is no host to show anything else about**. The second
 * is the reported bug — with zero hosts every host-scoped surface is a dead
 * end, so the Hub's page, whose first job is "add a host", is the home screen.
 */
export function hubViewActive(source: HostSource, hostCount: number, route: Route): boolean {
  if (source !== 'hub') return false;
  return isHubRoute(route) || hostCount === 0;
}

export type MenuItemId =
  | 'refresh'
  | 'shell'
  | 'hidden'
  | 'running'
  | 'hosts'
  | 'agents'
  | 'cron'
  | 'webhooks'
  | 'planner'
  | 'advanced'
  | 'settings'
  | 'hub-overview'
  | 'hub-add-host'
  | 'hub-templates'
  | 'signout';

export interface MenuItem {
  readonly id: MenuItemId;
  readonly label: string;
  readonly danger?: boolean;
}

export interface MenuContext {
  /** What the switcher has selected: the Hub itself, or a host (one, or all of them). */
  readonly view: 'hub' | 'host';
  readonly source: HostSource;
  readonly layout: 'phone' | 'desktop';
  /** Shown beside "Active sessions" so a growing pile is noticed before the menu is opened. */
  readonly runningCount?: number;
}

const SIGN_OUT: MenuItem = { id: 'signout', label: 'Sign out', danger: true };

/**
 * The overflow menu's items for a selection, in order.
 *
 * **Hub selected: Hub items only.** Hosts, adding one, templates — nothing a
 * backend answers, because with the Hub selected there may be no backend at
 * all, and an item that cannot work is the bug this exists to fix.
 *
 * **A host selected: that host's items only.** In hub mode that means *not*
 * "Hosts…": host management is the Hub's, reached from its tile, and a
 * server's menu offering it again is the mixing the ticket asked to end. A
 * standalone install keeps "Hosts…" because there is no Hub tile to reach it
 * from — it is the only way a desktop with one host can register a second.
 *
 * "Sign out" is in both: authenticating is per origin, and with a Hub in
 * front that origin is the Hub, so it is neither a host item nor something to
 * make unreachable from either view.
 */
export function overflowMenuItems(context: MenuContext): MenuItem[] {
  if (context.view === 'hub') {
    return [
      { id: 'refresh', label: 'Refresh' },
      { id: 'hub-overview', label: 'Hosts overview' },
      { id: 'hub-add-host', label: 'Add host…' },
      { id: 'hub-templates', label: 'Config templates…' },
      SIGN_OUT,
    ];
  }
  const running = context.runningCount ?? 0;
  return [
    { id: 'refresh', label: 'Refresh' },
    { id: 'shell', label: 'Shell (Tmux sessions)…' },
    { id: 'hidden', label: 'Hidden projects…' },
    { id: 'running', label: `Active sessions${running > 0 ? ` (${running})` : ''}…` },
    ...(context.source === 'local' ? [{ id: 'hosts', label: 'Hosts…' } as const] : []),
    // The desktop has a dedicated sidebar button for the fleet view.
    ...(context.layout === 'phone' ? [{ id: 'agents', label: 'Agents…' } as const] : []),
    { id: 'cron', label: 'Cron jobs…' },
    { id: 'webhooks', label: 'Webhooks…' },
    { id: 'planner', label: 'Pocket Agent settings…' },
    { id: 'advanced', label: 'More session options…' },
    { id: 'settings', label: 'Settings…' },
    SIGN_OUT,
  ];
}
