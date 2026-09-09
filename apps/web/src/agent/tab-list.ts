import type { Route } from '../hooks/useHashRoute.js';

/**
 * A tab is a live/finished terminal session, a read-only chat preview, a
 * Pocket Agent chat (PA-36), or one of the "full screen" admin pages —
 * Settings, Cron, Webhooks, Pocket Agents (the `planner` route — the agent
 * *list*, not a `planner-chat`) and each one's own detail/editor sub-route
 * (PA-36 round 2, reporter: "'Setting' tab concept should also apply to
 * webhook, pocket agent, cron ... all those share one tab"). These are the
 * only route kinds that open beside the sidebar rather than replacing the
 * whole workspace pane.
 */
export type TabRoute = Extract<
  Route,
  | { name: 'terminal' }
  | { name: 'chat' }
  | { name: 'planner-chat' }
  | { name: 'settings' }
  | { name: 'cron' }
  | { name: 'cron-job' }
  | { name: 'webhooks' }
  | { name: 'webhook' }
  | { name: 'planner' }
  | { name: 'planner-agent' }
>;

export interface OpenTab {
  id: string;
  route: TabRoute;
  /** VS Code's name for the one tab a single click in the explorer reuses,
      rather than piling up a new tab per click — see `tabListReducer`'s
      `openPreview`/`openPermanent` cases. Absent (not `false`) for a tab
      opened any other way, same as `dragging` on `TabBar`'s own tab state. */
  preview?: boolean;
}

export function isTabRoute(route: Route): route is TabRoute {
  return (
    route.name === 'terminal' ||
    route.name === 'chat' ||
    route.name === 'planner-chat' ||
    route.name === 'settings' ||
    route.name === 'cron' ||
    route.name === 'cron-job' ||
    route.name === 'webhooks' ||
    route.name === 'webhook' ||
    route.name === 'planner' ||
    route.name === 'planner-agent'
  );
}

/**
 * Every admin-page route kind (`settings`/`cron`/`cron-job`/`webhooks`/
 * `webhook`/`planner`/`planner-agent`) maps to the same fixed sentinel id —
 * `s:settings`, kept as the literal string from before this generalized
 * beyond just Settings, so a tab already persisted under that id from an
 * older build restores into the same slot rather than orphaning it. That is
 * also what gives the whole group "only one tab, ever, showing whichever of
 * the seven you're currently on" for free: `openPermanent`/`sync` already
 * dedup by id, so navigating from Cron to Webhooks just updates the one
 * existing tab's route (see `sync`'s own comment on why it has to, unlike
 * every other tab kind) rather than opening a second tab.
 */
export function tabIdFor(route: TabRoute): string {
  switch (route.name) {
    case 'terminal':
      return `t:${route.sessionId}`;
    case 'chat':
      return `c:${route.conversationId}`;
    case 'planner-chat':
      return `p:${route.chatId}`;
    case 'settings':
    case 'cron':
    case 'cron-job':
    case 'webhooks':
    case 'webhook':
    case 'planner':
    case 'planner-agent':
      return 's:settings';
  }
}

export type TabListAction =
  | { type: 'sync'; route: Route }
  | { type: 'openPreview'; route: TabRoute }
  | { type: 'openPermanent'; route: TabRoute }
  | { type: 'replace'; id: string; route: TabRoute }
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
      const index = tabs.findIndex((t) => t.id === id);
      const existing = tabs[index];
      if (index === -1 || !existing) return [...tabs, { id, route: action.route }];
      // A terminal/chat/planner-chat tab's own id already encodes the only
      // field its route carries, so re-syncing the same session/chat is
      // always a true no-op. The shared admin-page tab (PA-36 round 2) is
      // the one place that isn't true: `settings`, `cron`, `webhook`, ... all
      // collapse to the fixed `s:settings` id, so navigating from Cron to
      // Webhooks re-syncs *the same* tab id with a genuinely different
      // route, and that has to overwrite what's stored or the tab would
      // freeze on whichever of the seven pages it was first opened to. The
      // reference check (rather than a deep-equal) is enough: every real
      // navigation — a hash change, a click — constructs a fresh route
      // object, so this only ever short-circuits the truly-unchanged case
      // (e.g. re-selecting a tab that's already active), which is what keeps
      // this returning the exact same array reference for that case, same as
      // before this route ever needed updating.
      if (existing.route === action.route) return tabs;
      const next = tabs.slice();
      next[index] = { ...existing, route: action.route };
      return next;
    }
    case 'openPreview': {
      // A single click on a project-tree row: same chat twice in a row (or
      // any other already-open tab) just switches to it, untouched. A new
      // chat replaces whichever tab is *currently* marked preview, in that
      // tab's own slot, rather than appending — there is only ever one
      // preview tab, exactly like VS Code's explorer.
      const id = tabIdFor(action.route);
      if (tabs.some((t) => t.id === id)) return tabs;
      const previewIndex = tabs.findIndex((t) => t.preview);
      if (previewIndex === -1) return [...tabs, { id, route: action.route, preview: true }];
      const next = tabs.slice();
      next[previewIndex] = { id, route: action.route, preview: true };
      return next;
    }
    case 'openPermanent': {
      // A double click: a chat not open yet gets a normal, non-preview tab.
      // One already open as *this strip's* preview tab is "kept" in place —
      // same slot, just no longer liable to be replaced by the next single
      // click elsewhere. Already open and not the preview tab: nothing to do.
      const id = tabIdFor(action.route);
      const index = tabs.findIndex((t) => t.id === id);
      if (index === -1) return [...tabs, { id, route: action.route }];
      if (!tabs[index]?.preview) return tabs;
      const next = tabs.slice();
      next[index] = { id, route: action.route };
      return next;
    }
    case 'replace': {
      // Replaces an existing tab (e.g. promoting a preview tab or superseded
      // session to a newly created session) in-place in its same slot,
      // cleared of the `preview` flag.
      const newId = tabIdFor(action.route);
      const index = tabs.findIndex((t) => t.id === action.id);
      if (index === -1) {
        if (tabs.some((t) => t.id === newId)) return tabs;
        return [...tabs, { id: newId, route: action.route }];
      }
      const filtered = tabs.filter((t, i) => i === index || t.id !== newId);
      const filteredIndex = filtered.findIndex((t) => t.id === action.id);
      const next = filtered.slice();
      next[filteredIndex] = { id: newId, route: action.route };
      return next;
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
