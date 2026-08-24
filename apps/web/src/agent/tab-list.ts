import type { Route } from '../hooks/useHashRoute.js';

/** A tab is either a live/finished terminal session or a read-only chat preview. */
export type TabRoute = Extract<Route, { name: 'terminal' } | { name: 'chat' }>;

export interface OpenTab {
  id: string;
  route: TabRoute;
}

export function isTabRoute(route: Route): route is TabRoute {
  return route.name === 'terminal' || route.name === 'chat';
}

export function tabIdFor(route: TabRoute): string {
  return route.name === 'terminal' ? `t:${route.sessionId}` : `c:${route.conversationId}`;
}

export type TabListAction =
  | { type: 'sync'; route: Route }
  | { type: 'close'; id: string }
  | { type: 'reorder'; orderedIds: string[] };

/**
 * The open-tab list as a pure reducer, deliberately free of side effects.
 *
 * `DesktopShell` used to manage this with a `setState` updater that also
 * called `onNavigate` (a side effect on a *different* component's state)
 * from inside itself, keyed off a `activeTabId` value captured in a
 * `useCallback` closure. That closure only refreshes once a render commits —
 * so closing two tabs back to back (a fast double-click, or closing the very
 * tab a first close just fell back to) had the second call check the closed
 * tab's id against a *stale* `activeTabId` still naming the first tab, silently
 * skip the fallback navigation, and leave the route pointing at a tab that no
 * longer existed. The next render then saw that route "missing" from the list
 * and added it right back — a closed tab resurrected as an inert, unreachable
 * ghost in the strip. A pure reducer can't drift out of sync with itself like
 * that: every action is applied to whatever the list actually is, in the order
 * dispatched, with nothing keyed off a value that might be stale. Whatever
 * navigation is still needed after a close is `DesktopShell`'s job, computed
 * from this same function's return value at the moment of the call — see its
 * own doc comment for how it stays correct across rapid, same-tick closes too.
 */
export function tabListReducer(tabs: OpenTab[], action: TabListAction): OpenTab[] {
  switch (action.type) {
    case 'sync': {
      if (!isTabRoute(action.route)) return tabs;
      const id = tabIdFor(action.route);
      if (tabs.some((t) => t.id === id)) return tabs;
      return [...tabs, { id, route: action.route }];
    }
    case 'close':
      return tabs.filter((t) => t.id !== action.id);
    case 'reorder': {
      const byId = new Map(tabs.map((t) => [t.id, t]));
      const next = action.orderedIds.map((id) => byId.get(id)).filter((t): t is OpenTab => t !== undefined);
      // Anything not present in `orderedIds` shouldn't happen, but stays
      // appended rather than silently dropped if it ever does.
      const missing = tabs.filter((t) => !action.orderedIds.includes(t.id));
      return [...next, ...missing];
    }
    default:
      return tabs;
  }
}

/**
 * The tab a browser-style "closing a tab focuses a neighbor" affordance would
 * land on: the one that slides into the closed tab's slot, else the one
 * before it, else nothing is left to show.
 */
export function fallbackAfterClose(tabsBeforeClose: OpenTab[], closedId: string): OpenTab | null {
  const index = tabsBeforeClose.findIndex((t) => t.id === closedId);
  if (index === -1) return null;
  const next = tabListReducer(tabsBeforeClose, { type: 'close', id: closedId });
  return next[index] ?? next[index - 1] ?? null;
}
