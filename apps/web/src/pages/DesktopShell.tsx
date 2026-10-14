import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Route } from '../hooks/useHashRoute.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { RunningSessions } from '../components/RunningSessions.js';
import { Icon } from '../components/Icon.js';
import {
  HostChip,
  HostCompatibilityNotice,
  ProjectList,
  SearchField,
  allChats,
} from '../components/ProjectList.js';
import { HostRail } from '../components/HostRail.js';
import { HostGroup } from '../components/HostGroup.js';
import { HostSheet } from '../components/HostSheet.js';
import { AddHostDialog } from '../components/AddHostDialog.js';
import { BindHostDialog } from '../components/BindHostDialog.js';
import { EditHostDialog } from '../components/EditHostDialog.js';
import {
  findHostByManageId,
  hostDotClass,
  hostDriftMessage,
  hostStatusSummary,
  serverVersionLine,
} from '../hosts/host-status.js';
import { useFleetEntry, useOpenFleetChat } from '../hosts/fleet.js';
import { hubViewActive, overflowMenuItems } from '../hosts/hub-view.js';
import { BuildVersions } from '../components/BuildVersions.js';
import { HostProvider } from '../hosts/HostContext.js';
import { useHostFleet } from '../hosts/useHostFleet.js';
import { currentHostId, visibleHosts } from '../hosts/selected-host.js';
import { loadCollapsedHosts, toggleCollapsedHost } from '../hosts/collapsed-pref.js';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostRecord } from '../hosts/host-status.js';
import type { HostNav } from '../hosts/HostNav.js';
import { DEFAULT_HOST_ID } from '../api/host.js';
import { PocketAgentsSection } from '../components/PocketAgentsSection.js';
import { ShellSection } from '../components/ShellSection.js';
import { TabBar, type Tab } from '../components/TabBar.js';
import { UsageBar } from '../components/UsageBar.js';
import { OverflowMenu, menuHandlers } from './ProjectsPage.js';
import { ComposerPage } from './ComposerPage.js';
import {
  AgentsFleetPage,
  CronJobEditorPage,
  CronJobsPage,
  HubPage,
  HubTemplateEditorPage,
  HubTemplatesPage,
  PlannerAgentEditorPage,
  PlannerChatPage,
  PlannerPage,
  ProvidersAndModelsPage,
  SettingsPage,
  WebhookEditorPage,
  WebhooksPage,
} from '../lazy-pages.js';
import { SessionRoute } from './SessionRoute.js';
import { ChatPreviewPage } from './ChatPreviewPage.js';
import {
  loadOpenTabRoutes,
  saveOpenTabRoutes,
  type StoredRouteShape,
  type StoredTabRoute,
} from '../agent/open-tabs-pref.js';
import { fallbackAfterClose, isTabRoute, tabIdFor, tabListReducer, type TabRoute } from '../agent/tab-list.js';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  getSidebarWidthPref,
  setSidebarWidthPref,
} from '../agent/sidebar-width-pref.js';

import { ShellDialog } from '../components/ShellDialog.js';

interface Props {
  route: Route;
  /** Host selection, and how to navigate carrying one (PA-67). */
  nav: HostNav;
  directory: HostDirectory;
  onNavigate: (route: Route, opts?: { hostId?: string | null }) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}

/** Fallback for the lazily-loaded admin pages (`../lazy-pages.js`) while
    their chunk is still fetching — same spinner used everywhere else. */
function PageFallback(): JSX.Element {
  return <div className="spinner">Loading…</div>;
}

function storedToRoute(stored: StoredTabRoute): TabRoute {
  switch (stored.name) {
    case 'terminal':
      return { name: 'terminal', sessionId: stored.sessionId };
    case 'chat':
      return { name: 'chat', conversationId: stored.conversationId };
    case 'planner-chat':
      return { name: 'planner-chat', chatId: stored.chatId };
    case 'settings':
      return { name: 'settings' };
    case 'providers':
      return { name: 'providers' };
    case 'cron':
      return { name: 'cron' };
    case 'cron-job':
      return { name: 'cron-job', jobId: stored.jobId };
    case 'webhooks':
      return { name: 'webhooks' };
    case 'webhook':
      return { name: 'webhook', webhookId: stored.webhookId };
    case 'planner':
      return { name: 'planner' };
    case 'planner-agent':
      return { name: 'planner-agent', agentId: stored.agentId };
  }
}

function routeToStored(route: TabRoute): StoredRouteShape {
  switch (route.name) {
    case 'terminal':
      return { name: 'terminal', sessionId: route.sessionId };
    case 'chat':
      return { name: 'chat', conversationId: route.conversationId };
    case 'planner-chat':
      return { name: 'planner-chat', chatId: route.chatId };
    case 'settings':
      return { name: 'settings' };
    case 'providers':
      return { name: 'providers' };
    case 'cron':
      return { name: 'cron' };
    case 'cron-job':
      return { name: 'cron-job', jobId: route.jobId };
    case 'webhooks':
      return { name: 'webhooks' };
    case 'webhook':
      return { name: 'webhook', webhookId: route.webhookId };
    case 'planner':
      return { name: 'planner' };
    case 'planner-agent':
      return { name: 'planner-agent', agentId: route.agentId };
  }
}

type UtilityTabRoute = Exclude<TabRoute, { name: 'terminal' } | { name: 'chat' } | { name: 'planner-chat' }>;

/** A type predicate, not a plain boolean check, so narrowing `tab.route` on
    this survives into the `tabsForBar` branch that handles everything else —
    that branch reads `tab.route.sessionId`/`conversationId`/`chatId`, none of
    which exist on a `UtilityTabRoute`, and TypeScript only carries that
    exclusion forward through a real type guard. */
function isUtilityTabRoute(route: TabRoute): route is UtilityTabRoute {
  return (
    route.name === 'settings' ||
    route.name === 'providers' ||
    route.name === 'cron' ||
    route.name === 'cron-job' ||
    route.name === 'webhooks' ||
    route.name === 'webhook' ||
    route.name === 'planner' ||
    route.name === 'planner-agent'
  );
}

/** The two Hub-scoped routes, which are panes rather than tabs (PA-70). */
function isHubTemplateRoute(
  route: Route,
): route is { name: 'hub-templates' } | { name: 'hub-template'; templateId: string } {
  return route.name === 'hub-templates' || route.name === 'hub-template';
}

/**
 * Display title for the one shared admin-page tab (PA-36 round 2) — plain
 * per-route-kind labels, deliberately not "Cron Job: <name>" or similar:
 * getting a job's/webhook's/agent's own name into the tab bar would mean an
 * extra fetch (or threading one through from a page that doesn't otherwise
 * report upward) for a label that's only ever visible while that one tab is
 * frontmost, where the page itself already shows the full detail.
 */
function utilityTabTitle(route: UtilityTabRoute): string {
  switch (route.name) {
    case 'settings':
      return 'Settings';
    case 'providers':
      return 'Providers and Models';
    case 'cron':
    case 'cron-job':
      return 'Cron Jobs';
    case 'webhooks':
    case 'webhook':
      return 'Webhooks';
    case 'planner':
    case 'planner-agent':
      return 'Pocket Agents';
  }
}

/**
 * Desktop layout: the chat list stays put and sessions open beside it, as
 * browser-style tabs.
 *
 * On a phone the list and a session compete for the one screen, so opening a
 * chat has to replace the list. Given width there is no reason to keep paying
 * that cost — you can see what else is running while you read one of them, and
 * switching chats is a click instead of a round trip through the home screen.
 * Multiple tabs push that further: every open session/chat stays mounted at
 * once (only the active one is visible) so a background tab keeps its socket
 * connected instead of dropping it, and switching to it is instant rather
 * than a reconnect. Closing a tab only ever removes it from the strip — the
 * session itself keeps running, same "remove ≠ end the process" split the
 * sidebar's own "Remove from list" action already relies on.
 *
 * Compose and the Agents fleet view are deliberately *not* tabbable: they are
 * single panes that replace whatever's showing, exactly as before.
 *
 * Settings, Cron, Webhooks and Pocket Agents (the `planner` route, plus every
 * one's own detail/editor sub-route) are tabbable, but as one *shared*
 * singleton tab rather than one each (PA-36 round 2) — see
 * `isUtilityTabRoute`'s own comment for the mechanics. Mentally, treat that
 * one tab as its own small stack of admin pages, not seven independent tabs
 * that happen to collapse.
 *

 * Which layout you get is decided by viewport width and pointer type, never by
 * sniffing the user agent. See `useMediaQuery`.
 */
export function DesktopShell({
  route,
  nav,
  directory,
  onNavigate,
  onApiError,
  onLogout,
}: Props): JSX.Element {
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  // Each dialog's open-state is the *host id* it acts on, not a boolean
  // (PA-67): every one of them adds a project folder, lists tmux sessions or
  // creates a session on exactly one machine, and it can be opened either from
  // the chrome (meaning the current host) or from a host group's own row.
  const [showAdvanced, setShowAdvanced] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState<string | null>(null);
  const [showRunning, setShowRunning] = useState<string | null>(null);
  const [showShell, setShowShell] = useState<string | null>(null);
  const [showHostSheet, setShowHostSheet] = useState(false);
  const [showAddHost, setShowAddHost] = useState(false);
  const [bindHostId, setBindHostId] = useState<string | null>(null);
  const [editHostId, setEditHostId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsedHosts);

  const hosts = directory.hosts;
  const selectedHostId = nav.selection.mode === 'one' ? nav.selection.hostId : null;
  /** The host the chrome's own actions apply to — see `currentHostId`. */
  const here = currentHostId(nav.selection, hosts);
  const visible = useMemo(() => visibleHosts(nav.selection, hosts), [nav.selection, hosts]);
  const singleHost = hosts.length <= 1;
  const hubMode = directory.source === 'hub';
  /**
   * PA-110: the Hub is selected (its tile, or a Hub route) — or there is no
   * host at all, in which case every host surface would be a dead end and the
   * Hub's page is the only honest thing to show. See `hubViewActive`.
   */
  const hubView = hubViewActive(directory.source, hosts.length, route);
  /**
   * Tabs belong to hosts. A Hub with none has nothing a restored tab could be
   * talking to, so the strip is not rendered at all rather than showing tabs
   * whose every request fails.
   */
  const tabsAvailable = !(hubMode && hosts.length === 0);
  const openHub = (): void => onNavigate({ name: 'hub' }, { hostId: null });
  // PA-134: the Fleet agent's entry, in the Hub sidebar and the host sheet.
  const fleetEntry = useFleetEntry(directory);
  const openFleet = useOpenFleetChat(
    fleetEntry,
    useCallback((hostId: string, chatId: string) => nav.openOn(hostId, { name: 'planner-chat', chatId }), [nav]),
    onApiError,
  );
  const fleetProp = fleetEntry ? { problem: fleetEntry.problem, onOpen: openFleet, onProblem: openHub } : null;

  const [tabs, dispatch] = useReducer(tabListReducer, undefined, () =>
    // A tab persisted before PA-67 carries no host and is migrated onto the
    // default one — see `loadOpenTabRoutes`.
    loadOpenTabRoutes(DEFAULT_HOST_ID).map((stored) => {
      const tabRoute = storedToRoute(stored);
      return { id: tabIdFor(tabRoute, stored.hostId), hostId: stored.hostId, route: tabRoute };
    }),
  );

  // Computed synchronously during render — not in an effect — so navigating to
  // a session shows its tab immediately, with no one-frame flash of the
  // welcome pane while an effect catches up.
  const openTabs = useMemo(
    () => tabListReducer(tabs, { type: 'sync', route, hostId: here }),
    [tabs, route, here],
  );

  // Reconcile the persisted reducer state once the merge above actually added
  // a tab (or a close/reorder below has run).
  useEffect(() => {
    if (openTabs !== tabs) dispatch({ type: 'sync', route, hostId: here });
  }, [openTabs, tabs, route, here]);

  useEffect(() => {
    saveOpenTabRoutes(tabs.map((t) => ({ ...routeToStored(t.route), hostId: t.hostId })));
  }, [tabs]);

  const activeTabId = isTabRoute(route) ? tabIdFor(route, here) : null;

  // Mirrors of the two pieces of state `closeTab` needs to reason about,
  // updated on every render *and* eagerly by `closeTab` itself. Plain render
  // values would go stale between two calls in the same tick — e.g. closing a
  // tab and then, before React has re-rendered, closing the very neighbor it
  // just fell back to. `useCallback`'s closure over `activeTabId` would still
  // name the *first* tab in that second call, silently skip the fallback
  // navigation the second close actually needs, and leave `route` pointing at
  // a tab no longer in the list — which the sync effect above would then read
  // as "missing" and add straight back, resurrecting it as an inert ghost tab.
  // Reading and writing these refs synchronously, in the same call, keeps
  // consecutive same-tick closes each seeing the true result of the one
  // before it instead of a render that hasn't happened yet.
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const routeRef = useRef(route);
  routeRef.current = route;
  // Same-tick-correctness mirror for the current host, for exactly the reason
  // the two above exist: `closeTab` may run twice before a render commits, and
  // the second call must compute tab ids against the host the first one left
  // the route on.
  const hereRef = useRef(here);
  hereRef.current = here;

  /** Navigate to a route on a specific host, preserving tab semantics. */
  const navOn = useCallback(
    (hostId: string, target: Route) => {
      hereRef.current = hostId;
      nav.openOn(hostId, target);
    },
    [nav],
  );

  /** Removes a tab from the strip only — never an API call, so the session
      underneath keeps running exactly as it would if the strip did not exist. */
  const closeTab = useCallback(
    (id: string) => {
      const current = openTabsRef.current;
      if (!current.some((t) => t.id === id)) return;

      const activeId = isTabRoute(routeRef.current) ? tabIdFor(routeRef.current, hereRef.current) : null;
      const next = tabListReducer(current, { type: 'close', id });
      openTabsRef.current = next;
      dispatch({ type: 'close', id });

      if (activeId === id) {
        // Same "closing a tab focuses a neighbor" affordance as a browser. The
        // neighbour may live on another host, so the fallback navigation
        // carries that tab's own host rather than the current one — otherwise
        // closing the last tab of host A lands on host B's route under host
        // A's URL.
        const fallback = fallbackAfterClose(current, id);
        const fallbackRoute = fallback ? fallback.route : ({ name: 'list' } as const);
        routeRef.current = fallbackRoute;
        if (fallback) navOn(fallback.hostId, fallback.route);
        else onNavigate(fallbackRoute);
      }
    },
    [onNavigate, navOn],
  );

  const reorderTabs = useCallback((orderedIds: string[]) => {
    openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'reorder', orderedIds });
    dispatch({ type: 'reorder', orderedIds });
  }, []);

  /** Closes every open tab. A plain loop over `closeTab` is safe to call
      repeatedly in the same tick: each call reads and writes `openTabsRef`/
      `routeRef` synchronously, so it always sees the previous call's result
      rather than a stale render (see `closeTab`'s own comment). Snapshotting
      `openTabsRef.current` once, up front, means the loop closes exactly the
      tabs open when the menu action fired, not whatever `closeTab` leaves
      behind as it goes. */
  const closeAllTabs = useCallback(() => {
    for (const tab of openTabsRef.current) closeTab(tab.id);
  }, [closeTab]);

  /** Closes every open tab except `keepId`. No special-cased navigation
      needed: `closeTab`'s own "fall back to a neighbor" behavior cascades
      the active tab forward through the list as each one closes, and since
      `keepId` is never among the ids closed here, it's always the tab left
      standing by the time the loop finishes. */
  const closeOtherTabs = useCallback(
    (keepId: string) => {
      for (const tab of openTabsRef.current) {
        if (tab.id !== keepId) closeTab(tab.id);
      }
    },
    [closeTab],
  );

  /** A single click on a project-tree row: shows the chat without
      permanently adding a tab. Same ref-then-dispatch shape `closeTab` uses,
      for the same reason — a second click before this one's render commits
      must still see the tab this one just opened, not a stale empty list. */
  const openPreviewTab = useCallback(
    (hostId: string, tabRoute: TabRoute) => {
      openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'openPreview', route: tabRoute, hostId });
      dispatch({ type: 'openPreview', route: tabRoute, hostId });
      routeRef.current = tabRoute;
      navOn(hostId, tabRoute);
    },
    [navOn],
  );

  /** A double click: "keeps" the tab open for good, same slot, immune to
      being replaced by the next single click elsewhere in the tree. */
  const openPermanentTab = useCallback(
    (hostId: string, tabRoute: TabRoute) => {
      openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'openPermanent', route: tabRoute, hostId });
      dispatch({ type: 'openPermanent', route: tabRoute, hostId });
      routeRef.current = tabRoute;
      navOn(hostId, tabRoute);
    },
    [navOn],
  );

  /** Replaces an existing tab in place with a new route (e.g. promoting a preview
      tab or superseded session to a newly created session). */
  const replaceTab = useCallback(
    (id: string, hostId: string, tabRoute: TabRoute) => {
      openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'replace', id, route: tabRoute, hostId });
      dispatch({ type: 'replace', id, route: tabRoute, hostId });
      routeRef.current = tabRoute;
      navOn(hostId, tabRoute);
    },
    [navOn],
  );

  const onReplaceSession = useCallback(
    (hostId: string, oldSessionId: string, newSessionId: string) => {
      // Built through `tabIdFor` rather than by hand: the id format is
      // host-qualified since PA-67, and a second copy of the formula here is
      // exactly how a session gets promoted into a tab that does not exist.
      const oldTabId = tabIdFor({ name: 'terminal', sessionId: oldSessionId }, hostId);
      const tabRoute: TabRoute = { name: 'terminal', sessionId: newSessionId };
      replaceTab(oldTabId, hostId, tabRoute);
    },
    [replaceTab],
  );

  // Single click from the sidebar previews; double click keeps. Anything
  // that opens a chat some other way (compose, resuming from a chat preview,
  // the tab-list dropdown, Agents fleet) calls `onNavigate` directly and
  // always lands as a normal permanent tab via the plain `sync` merge below.
  //
  // One fleet, every host (PA-67): a tab keeps streaming while you browse
  // another machine, so the poller cannot be scoped to the host currently
  // selected — `tabHostIds` below is what puts a background tab's host on the
  // foreground tier.
  const tabHostIds = useMemo(() => [...new Set(openTabs.map((tab) => tab.hostId))], [openTabs]);

  const fleet = useHostFleet({
    hosts,
    poll: {
      selectedHostId,
      collapsedHostIds: collapsed,
      tabHostIds,
      singleHost,
    },
    onOpen: (hostId, sessionId, opts) => {
      const tabRoute: TabRoute = { name: 'terminal', sessionId };
      if (opts?.preview) openPreviewTab(hostId, tabRoute);
      else openPermanentTab(hostId, tabRoute);
    },
    onOpenChat: (hostId, conversationId, opts) => {
      const tabRoute: TabRoute = { name: 'chat', conversationId };
      if (opts?.preview) openPreviewTab(hostId, tabRoute);
      else openPermanentTab(hostId, tabRoute);
    },
    onApiError,
    onReplaceSession,
  });

  /** The host the chrome reads from: whichever one `here` names. */
  const hereState = fleet.stateFor(here);

  // Title and live status for the tab strip come from the same polled project
  // lists the sidebar already renders from — no separate fetch per tab. Keyed
  // by *tab id*, which is host-qualified, so two hosts' identically-titled
  // chats (or identical session ids) cannot overwrite each other's entry.
  const chatById = useMemo(() => {
    const map = new Map<string, { title: string; live: boolean }>();
    for (const host of hosts) {
      const hostId = host.endpoint.id;
      const state = fleet.stateFor(hostId);
      const planner = fleet.plannerFor(hostId);
      // Shells are folded in alongside the project tree's own chats. They left
      // `projects` when they became their own category (PA-25), and a shell is
      // very much tabbable — without this every open terminal tab decayed to
      // its raw session id, which is the exact failure `knownTitles` below
      // exists to soften and has no reason to be hit deliberately.
      const rows = [...allChats(state.projects ?? []), ...(state.shells ?? [])];
      for (const chat of rows) {
        if (chat.sessionId) {
          map.set(tabIdFor({ name: 'terminal', sessionId: chat.sessionId }, hostId), {
            title: chat.title,
            live: chat.live,
          });
        }
        if (chat.conversationId) {
          map.set(tabIdFor({ name: 'chat', conversationId: chat.conversationId }, hostId), {
            title: chat.title,
            live: chat.live,
          });
        }
      }
      // A planner chat has no "live" concept at all — see `PlannerChat`'s own
      // doc comment: a turn runs over a one-way SSE response, not a process
      // anything can observe as "still running" — so this is always `false`,
      // same as `PocketAgentsSection`'s own rows render no live dot either.
      // Unlike `state.projects` (bounded to the 60 most recently touched
      // conversations), `listPlannerChats()` returns every chat, so a planner
      // tab's title never ages out of this map the way an old project chat's
      // can — see `knownTitles` below for that case.
      for (const chat of planner.chats) {
        map.set(tabIdFor({ name: 'planner-chat', chatId: chat.id }, hostId), {
          title: chat.title ?? 'Untitled chat',
          live: false,
        });
      }
    }
    return map;
  }, [hosts, fleet]);

  // Every title/live pair this tab bar has ever seen for a given id, kept
  // around after `chatById` stops carrying it. `ProjectService.list` only
  // loads the `conversationLimit` (60) most recently touched transcripts —
  // an intentional bound on a long-lived install's disk-scan cost, not a
  // bug — so a tab left open on an old, otherwise-idle chat is expected to
  // silently age out of every future poll once enough newer chats pile up
  // elsewhere. Without this cache that tab's title decayed to its raw
  // session/conversation id and stayed that way, because nothing about an
  // idle chat ever bumps it back into the top 60. A `Map` ref, not state:
  // updating it must never itself trigger a render, only make the next one
  // (already scheduled by the `state.projects` change that fed `chatById`)
  // more informed.
  const knownTitles = useRef(new Map<string, { title: string; live: boolean }>());
  useEffect(() => {
    for (const [id, entry] of chatById) knownTitles.current.set(id, entry);
  }, [chatById]);

  // Only informative once two hosts have tabs open at the same time; before
  // that a label on every tab is noise repeating what the rail already says.
  const showTabHosts = tabHostIds.length > 1;
  const hostLabelFor = (hostId: string): string | null => {
    if (!showTabHosts) return null;
    return hosts.find((host) => host.endpoint.id === hostId)?.label ?? hostId;
  };

  const tabsForBar: Tab[] = openTabs.map((tab) => {
    // The shared admin-page tab (settings/cron/webhooks/planner and each
    // one's own detail route, PA-36 round 2) has a fixed title per
    // sub-route and no live concept — never sourced from `chatById`, so
    // it is special-cased before that lookup rather than needing a fake
    // row injected into that map.
    if (isUtilityTabRoute(tab.route)) {
      return {
        id: tab.id,
        title: utilityTabTitle(tab.route),
        live: false,
        preview: tab.preview ?? false,
        hostLabel: hostLabelFor(tab.hostId),
      };
    }
    const found = chatById.get(tab.id) ?? knownTitles.current.get(tab.id);
    if (found) {
      return {
        id: tab.id,
        title: found.title,
        live: found.live,
        preview: tab.preview ?? false,
        hostLabel: hostLabelFor(tab.hostId),
      };
    }
    // Never seen at all — a tab restored from `open-tabs-pref` whose chat had
    // already aged out of the poll window before this tab bar ever mounted
    // (or, for a planner chat, whose chat was deleted outright — see the
    // comment on `chatById` above for why that map can't simply be missing
    // it any other way). Same fallback `AgentPage`'s own topbar uses
    // (`session?.title ?? sessionId`); the tab closes itself via the "this
    // session/chat no longer exists" screen if it really is gone rather than
    // just unpolled.
    const fallback =
      tab.route.name === 'terminal'
        ? tab.route.sessionId
        : tab.route.name === 'chat'
          ? tab.route.conversationId
          : tab.route.chatId;
    return {
      id: tab.id,
      title: fallback,
      live: tab.route.name === 'terminal',
      preview: tab.preview ?? false,
      hostLabel: hostLabelFor(tab.hostId),
    };
  });

  const activeSessionId = route.name === 'terminal' ? route.sessionId : null;
  const activeConversationId = route.name === 'chat' ? route.conversationId : null;
  // Shells count too — see the same fix in `ProjectsPage` (PA-25). Summed
  // across the hosts on screen, which is what the badge is about.
  const runningCount = visible.reduce((total, host) => {
    const hostState = fleet.stateFor(host.endpoint.id);
    return (
      total +
      (hostState.projects?.reduce((n, p) => n + p.chats.filter((c) => c.live).length, 0) ?? 0) +
      (hostState.shells?.filter((s) => s.live).length ?? 0)
    );
  }, 0);

  const [sidebarWidth, setSidebarWidth] = useState<number>(getSidebarWidthPref);
  const [isResizing, setIsResizing] = useState(false);
  const isResizingRef = useRef(false);

  const handleResizerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = clampSidebarWidth(moveEvent.clientX);
      setSidebarWidth(newWidth);
    };

    const onMouseUp = (upEvent: MouseEvent) => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      const finalWidth = clampSidebarWidth(upEvent.clientX);
      setSidebarWidth(finalWidth);
      setSidebarWidthPref(finalWidth);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, []);

  const handleResizerDoubleClick = useCallback(() => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setSidebarWidthPref(DEFAULT_SIDEBAR_WIDTH);
  }, []);

  const handleResizerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 32 : 16;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = clampSidebarWidth(sidebarWidth - step);
        setSidebarWidth(next);
        setSidebarWidthPref(next);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        const next = clampSidebarWidth(sidebarWidth + step);
        setSidebarWidth(next);
        setSidebarWidthPref(next);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
        setSidebarWidthPref(DEFAULT_SIDEBAR_WIDTH);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const next = sidebarWidth > DEFAULT_SIDEBAR_WIDTH + 50 ? DEFAULT_SIDEBAR_WIDTH : 450;
        setSidebarWidth(next);
        setSidebarWidthPref(next);
      }
    },
    [sidebarWidth],
  );

  // The rail is chrome, not a category, so it is a *third grid column* rather
  // than anything inside the sidebar — which is what lets the three shared
  // home-screen categories stay identical to the phone's, in the same order,
  // with a host switcher that the phone expresses as a sheet instead. Hidden
  // entirely with a single host: a 56px column holding one tile is clutter,
  // and its absence is half of what keeps a standalone desktop unchanged.
  const showRail = !singleHost || directory.source === 'hub';

  return (
    <div
      className={`desktop-shell${showRail ? ' with-rail' : ''}`}
      style={{
        gridTemplateColumns: showRail
          ? `var(--host-rail-width) ${sidebarWidth}px minmax(0, 1fr)`
          : `${sidebarWidth}px minmax(0, 1fr)`,
      }}
    >
      {showRail && (
        <HostRail
          hosts={hosts}
          selectedHostId={selectedHostId}
          onSelectAll={() => nav.goToHost(null)}
          onSelect={(hostId) => nav.goToHost(hostId)}
          onAdd={() => setShowAddHost(true)}
          canManage={directory.canManage}
          hub={hubMode ? { active: hubView, onSelect: openHub } : null}
        />
      )}
      <aside className="sidebar">
        <div
          className={`sidebar-resizer${isResizing ? ' resizing' : ''}`}
          onMouseDown={handleResizerMouseDown}
          onDoubleClick={handleResizerDoubleClick}
          onKeyDown={handleResizerKeyDown}
          tabIndex={0}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          title="Drag or use arrow keys to resize sidebar (double-click or Home to reset)"
        />
        <header className="sidebar-head">
          <div className="sidebar-brand">
            <strong>Remote</strong>
            {/* No `onClick`: the rail is the desktop switcher, and a second
                affordance for the same action in the brand line is one too
                many. */}
            {hubView ? (
              <span className="host-chip">
                <Icon name="hub" />
                <span className="host-name">Hub</span>
              </span>
            ) : (
              <HostChip
                host={hereState.host}
                record={hosts.find((candidate) => candidate.endpoint.id === here) ?? null}
                compatibility={hereState.hostCompatibility}
                allHosts={nav.selection.mode === 'all' && !singleHost}
              />
            )}
            {/* Which exact builds are running, at a glance and labelled by
                component (PA-107) — see `BuildVersions`. Desktop-only: the
                phone header's `.home-title` reuses the same `HostChip` but
                has no room for more lines; the phone's host sheet carries
                the Hub line instead. */}
            {(() => {
              const allView = nav.selection.mode === 'all' && !singleHost;
              const selectedRecord = allView
                ? null
                : (hosts.find((candidate) => candidate.endpoint.id === here) ?? null);
              const line = serverVersionLine(hosts, selectedRecord);
              return (
                <BuildVersions
                  className="sidebar-version"
                  // The Hub view is about no one server (PA-110).
                  showServer={!hubView}
                  server={line.text}
                  serverDetail={line.detail}
                  drift={selectedRecord ? hostDriftMessage(selectedRecord) : null}
                  hubVersion={directory.hubVersion}
                />
              );
            })()}
          </div>
          <PushToggle compact />
          <button
            type="button"
            className="round-btn plain"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="More"
            aria-expanded={menuOpen}
          >
            <Icon name="ellipsis" size={20} />
          </button>
          {menuOpen && (
            <OverflowMenu
              onClose={() => setMenuOpen(false)}
              // PA-110: disjoint sets — Hub items with the Hub selected,
              // server items with a host selected. `overflowMenuItems` decides.
              items={overflowMenuItems({
                view: hubView ? 'hub' : 'host',
                source: directory.source,
                layout: 'desktop',
                runningCount,
              })}
              handlers={menuHandlers(
                (action) => {
                  setMenuOpen(false);
                  action();
                },
                hubView
                  ? {
                      refresh: () => directory.refresh(),
                      'hub-overview': openHub,
                      'hub-add-host': () => setShowAddHost(true),
                      'hub-templates': () => onNavigate({ name: 'hub-templates' }, { hostId: null }),
                      signout: onLogout,
                    }
                  : {
                      refresh: () => {
                        void fleet.refreshAll();
                        directory.refresh();
                      },
                      shell: () => setShowShell(here),
                      hidden: () => setShowHidden(here),
                      running: () => setShowRunning(here),
                      hosts: () => setShowHostSheet(true),
                      // PA-36: Settings is a singleton tab — `openPermanentTab`
                      // dedups by `tabIdFor`'s id, so opening it again from here
                      // just switches to the one already open rather than adding a
                      // second. Since PA-67 that id is per host, because a cron job
                      // or a webhook belongs to one machine and one global admin tab
                      // would show the wrong one's rows under the right title.
                      settings: () => openPermanentTab(here, { name: 'settings' }),
                      cron: () => onNavigate({ name: 'cron' }),
                      webhooks: () => onNavigate({ name: 'webhooks' }),
                      planner: () => onNavigate({ name: 'planner' }),
                      providers: () => onNavigate({ name: 'providers' }),
                      advanced: () => setShowAdvanced(here),
                      signout: onLogout,
                    },
              )}
            />
          )}
        </header>

        {hubView ? (
          <HubSidebar
            route={route}
            hosts={hosts}
            fleet={fleetProp}
            onOverview={openHub}
            onTemplates={() => onNavigate({ name: 'hub-templates' }, { hostId: null })}
            onOpenHost={(hostId) => nav.goToHost(hostId)}
            onAddHost={() => setShowAddHost(true)}
            canManage={directory.canManage}
          />
        ) : (
        <>
        <div className="sidebar-actions">
          <button
            type="button"
            className="new-chat-btn"
            onClick={() => nav.openOn(here, { name: 'compose' })}
          >
            <Icon name="compose" size={18} />
            New chat
          </button>
          <button
            type="button"
            className="shell-nav-btn"
            onClick={() => setShowShell(here)}
          >
            <Icon name="agent-shell" size={16} />
            Shell
          </button>
          <button
            type="button"
            className={route.name === 'agents' ? 'agents-nav-btn active' : 'agents-nav-btn'}
            onClick={() => onNavigate({ name: 'agents' })}
            aria-pressed={route.name === 'agents'}
          >
            <Icon name="agents" size={16} />
            Agents
          </button>
        </div>

        <div className="sidebar-search">
          <SearchField value={search} onChange={setSearch} />
        </div>

        <div className="sidebar-scroll">
          {visible.map((host) => {
            const hostId = host.endpoint.id;
            const hostState = fleet.stateFor(hostId);
            const planner = fleet.plannerFor(hostId);
            // The active highlight only applies to the host the route is on:
            // two hosts can share a session id, and highlighting both rows
            // would claim the other machine's chat is the one on screen.
            const activeHere = hostId === here;
            return (
              <HostProvider key={hostId} endpoint={host.endpoint}>
                <HostGroup
                  host={host}
                  show={!singleHost}
                  collapsed={collapsed.includes(hostId)}
                  onToggle={() => setCollapsed((prev) => toggleCollapsedHost(prev, hostId))}
                  onSelect={() => nav.goToHost(hostId)}
                  actions={
                    <button
                      type="button"
                      className="round-btn plain"
                      onClick={() => nav.openOn(hostId, { name: 'compose' })}
                      aria-label={`New chat on ${host.label}`}
                      title={`New chat on ${host.label}`}
                    >
                      <Icon name="compose" size={16} />
                    </button>
                  }
                >
                  {hostState.error && (
                    <div className="error-box" role="alert">
                      {hostState.error}
                    </div>
                  )}
                  {/* PA-61 — see `ProjectsPage` for why this sits above the categories. */}
                  <HostCompatibilityNotice compatibility={hostState.hostCompatibility} />
                  <PocketAgentsSection
                    workspaces={planner.workspaces}
                    chats={planner.chats}
                    docWorkspaces={planner.docWorkspaces}
                    refresh={planner.refresh}
                    // PA-36: a Pocket Agent chat row has no click/double-click
                    // distinction of its own today (unlike `ProjectList`'s chat
                    // rows), so this always opens a normal permanent tab rather than
                    // a preview one — nothing in this section currently produces the
                    // second click that would ever "promote" a preview anyway.
                    onOpenChat={(chatId) => openPermanentTab(hostId, { name: 'planner-chat', chatId })}
                    onCloseChat={(chatId) =>
                      closeTab(tabIdFor({ name: 'planner-chat', chatId }, hostId))
                    }
                    onApiError={onApiError}
                    activeChatId={
                      activeHere && route.name === 'planner-chat' ? route.chatId : null
                    }
                    codeServerBaseUrl={hostState.host?.codeServerBaseUrl}
                  />
                  {/* Between the other two categories, same order as the phone page
                      (PA-25) — the two layouts must not disagree about where a
                      category lives. */}
                  <ShellSection
                    state={hostState}
                    open={hostState.open}
                    onNewShell={() => setShowShell(hostId)}
                    activeSessionId={activeHere ? activeSessionId : null}
                    search={search}
                  />
                  <ProjectList
                    state={hostState}
                    search={search}
                    onCompose={(cwd) => nav.openOn(hostId, { name: 'compose', cwd })}
                    onAddProject={() => setShowAdd(hostId)}
                    activeSessionId={activeHere ? activeSessionId : null}
                    activeConversationId={activeHere ? activeConversationId : null}
                    onOpenCronJob={(jobId) => nav.openOn(hostId, { name: 'cron-job', jobId })}
                    onOpenWebhook={(webhookId) => nav.openOn(hostId, { name: 'webhook', webhookId })}
                    onOpenPlannerChat={(chatId) => openPermanentTab(hostId, { name: 'planner-chat', chatId })}
                    onApiError={onApiError}
                    emptyHint="Nothing here yet. Start a chat to see it listed."
                  />
                </HostGroup>
              </HostProvider>
            );
          })}
        </div>

        <UsageBar />
        </>
        )}
      </aside>

      <main className="workspace">
        {tabsAvailable && openTabs.length > 0 && (
          <TabBar
            tabs={tabsForBar}
            activeId={activeTabId}
            onSelect={(id) => {
              const tab = openTabs.find((t) => t.id === id);
              // Selecting a tab on another host switches the selected host
              // with it — that is what makes "a live session on host A keeps
              // streaming while you browse host B" reachable in both
              // directions rather than a one-way trip.
              if (tab) navOn(tab.hostId, tab.route);
            }}
            onClose={closeTab}
            onReorder={reorderTabs}
            onCloseAll={closeAllTabs}
            onCloseOthers={closeOtherTabs}
          />
        )}

        {tabsAvailable && openTabs.length > 0 && (
          <div className={`tab-panels${activeTabId === null ? ' collapsed' : ''}`}>
            {openTabs.map((tab) => (
              /* Every panel stays mounted (only the active one is visible),
                 and each is bound to its own host — which is what keeps a live
                 session on host A streaming while the sidebar shows host B:
                 the pane's client and socket come from this provider, not from
                 whichever host is currently selected. */
              <HostProvider key={tab.id} endpoint={nav.endpointFor(tab.hostId)}>
                <div className={`tab-panel${tab.id === activeTabId ? '' : ' inactive'}`}>
                {tab.route.name === 'terminal' ? (
                  <SessionRoute
                    sessionId={tab.route.sessionId}
                    onBack={() => closeTab(tab.id)}
                    onApiError={onApiError}
                    onResumed={(sessionId) => {
                      // PA-46: "promoting" a preview/dead session to a live session replaces
                      // the superseded tab in place with the live one.
                      replaceTab(tab.id, tab.hostId, { name: 'terminal', sessionId });
                    }}
                  />
                ) : tab.route.name === 'chat' ? (
                  <ChatPreviewPage
                    conversationId={tab.route.conversationId}
                    onBack={() => closeTab(tab.id)}
                    onApiError={onApiError}
                    onStarted={(sessionId) => {
                      // PA-36 / PA-46: "promoting" a preview to a live session replaces
                      // the preview tab in place with the live one.
                      replaceTab(tab.id, tab.hostId, { name: 'terminal', sessionId });
                    }}
                  />
                ) : tab.route.name === 'planner-chat' ? (
                  // PA-36: same "onBack closes this tab" wiring as the other
                  // two kinds — `PlannerChatPage` auto-fires it once it
                  // discovers the chat is gone (see its own `missing` effect),
                  // which is the fix for stale tabs surviving a restart.
                  <Suspense fallback={<PageFallback />}>
                    <PlannerChatPage
                      chatId={tab.route.chatId}
                      active={tab.id === activeTabId}
                      onBack={() => closeTab(tab.id)}
                      onOpenSession={(sessionId) => nav.openOn(tab.hostId, { name: 'terminal', sessionId })}
                      onOpenPlannerChat={(chatId) => nav.openOn(tab.hostId, { name: 'planner-chat', chatId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'settings' ? (
                  // PA-36 round 2: Settings, Providers and Models, Cron, Webhooks
                  // and Pocket Agents (the `planner` route) all share this one
                  // tab now — see `isUtilityTabRoute`'s own comment. Each list
                  // route's own "back" closes the whole tab (there's nothing
                  // above it within the group, same as Settings' own pre-existing
                  // behavior); each detail/editor sub-route's "back"/"done"
                  // instead navigates to its own list route, staying inside
                  // this same tab exactly as it did when these were their own
                  // full-pane routes below — only the container changed.
                  <Suspense fallback={<PageFallback />}>
                    <SettingsPage
                      onBack={() => closeTab(tab.id)}
                      onApiError={onApiError}
                      hubVersion={directory.hubVersion}
                    />
                  </Suspense>
                ) : tab.route.name === 'providers' ? (
                  <Suspense fallback={<PageFallback />}>
                    <ProvidersAndModelsPage
                      onBack={() => closeTab(tab.id)}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'cron' ? (
                  <Suspense fallback={<PageFallback />}>
                    <CronJobsPage
                      onBack={() => closeTab(tab.id)}
                      onOpenJob={(jobId) => nav.openOn(tab.hostId, { name: 'cron-job', jobId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'cron-job' ? (
                  <Suspense fallback={<PageFallback />}>
                    <CronJobEditorPage
                      key={tab.route.jobId}
                      jobId={tab.route.jobId}
                      onBack={() => nav.openOn(tab.hostId, { name: 'cron' })}
                      onDone={() => {
                        void fleet.refreshHost(tab.hostId);
                        nav.openOn(tab.hostId, { name: 'cron' });
                      }}
                      onOpenSession={(sessionId) => nav.openOn(tab.hostId, { name: 'terminal', sessionId })}
                      onOpenChat={(conversationId) => nav.openOn(tab.hostId, { name: 'chat', conversationId })}
                      onOpenPlannerChat={(chatId) => nav.openOn(tab.hostId, { name: 'planner-chat', chatId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'webhooks' ? (
                  <Suspense fallback={<PageFallback />}>
                    <WebhooksPage
                      onBack={() => closeTab(tab.id)}
                      onOpenWebhook={(webhookId) => nav.openOn(tab.hostId, { name: 'webhook', webhookId })}
                      onOpenSession={(sessionId) => nav.openOn(tab.hostId, { name: 'terminal', sessionId })}
                      onOpenChat={(conversationId) => nav.openOn(tab.hostId, { name: 'chat', conversationId })}
                      onOpenPlannerChat={(chatId) => nav.openOn(tab.hostId, { name: 'planner-chat', chatId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'webhook' ? (
                  <Suspense fallback={<PageFallback />}>
                    <WebhookEditorPage
                      key={tab.route.webhookId}
                      webhookId={tab.route.webhookId}
                      onBack={() => nav.openOn(tab.hostId, { name: 'webhooks' })}
                      onDone={() => {
                        void fleet.refreshHost(tab.hostId);
                        nav.openOn(tab.hostId, { name: 'webhooks' });
                      }}
                      onOpenSession={(sessionId) => nav.openOn(tab.hostId, { name: 'terminal', sessionId })}
                      onOpenChat={(conversationId) => nav.openOn(tab.hostId, { name: 'chat', conversationId })}
                      onOpenPlannerChat={(chatId) => nav.openOn(tab.hostId, { name: 'planner-chat', chatId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : tab.route.name === 'planner' ? (
                  <Suspense fallback={<PageFallback />}>
                    <PlannerPage
                      onBack={() => closeTab(tab.id)}
                      onOpenAgent={(agentId) => nav.openOn(tab.hostId, { name: 'planner-agent', agentId })}
                      onApiError={onApiError}
                    />
                  </Suspense>
                ) : (
                  <Suspense fallback={<PageFallback />}>
                    <PlannerAgentEditorPage
                      key={tab.route.agentId}
                      agentId={tab.route.agentId}
                      onBack={() => nav.openOn(tab.hostId, { name: 'planner' })}
                      onDone={() => {
                        void fleet.refreshHost(tab.hostId);
                        nav.openOn(tab.hostId, { name: 'planner' });
                      }}
                      onApiError={onApiError}
                    />
                  </Suspense>
                )}
                </div>
              </HostProvider>
            ))}
          </div>
        )}

        {hubView && !isHubTemplateRoute(route) ? (
          /* PA-110. Host-less, like the template pane below: nothing here is
             any one machine's, and with no host there is no provider to give. */
          <Suspense fallback={<PageFallback />}>
            <HubPage
              directory={directory}
              onOpenHost={(hostId) => nav.goToHost(hostId)}
              onOpenTemplates={() => onNavigate({ name: 'hub-templates' }, { hostId: null })}
              onOpenTemplate={(templateId) => onNavigate({ name: 'hub-template', templateId }, { hostId: null })}
              onOpenFleetChat={(hostId, chatId) => nav.openOn(hostId, { name: 'planner-chat', chatId })}
              onApiError={onApiError}
            />
          </Suspense>
        ) : route.name === 'compose' ? (
          <HostProvider endpoint={nav.endpointFor(here)}>
            <ComposerPage
              // Keyed on cwd *and host* so picking a different project's "new
              // chat" — or the same directory on another machine — remounts
              // instead of reusing the old instance's `cwd` state (composer
              // and list are on screen together here, unlike the mobile flow).
              key={`${here}:${route.cwd ?? ''}`}
              {...(route.cwd !== undefined ? { initialCwd: route.cwd } : {})}
              onBack={() => onNavigate({ name: 'list' })}
              onCreated={(sessionId) => {
                void fleet.refreshHost(here);
                nav.openOn(here, { name: 'terminal', sessionId });
              }}
              onApiError={onApiError}
            />
          </HostProvider>
        ) : route.name === 'agents' ? (
          <HostProvider endpoint={nav.endpointFor(here)}>
            <Suspense fallback={<PageFallback />}>
              <AgentsFleetPage
                onOpen={(sessionId) => nav.openOn(here, { name: 'terminal', sessionId })}
                onApiError={onApiError}
              />
            </Suspense>
          </HostProvider>
        ) : isHubTemplateRoute(route) && directory.source === 'hub' ? (
          /* PA-70. A full pane like `compose` and the fleet view rather than a
             tab, and deliberately *not* inside a `HostProvider`: a template
             belongs to the Hub, and putting it in the per-host admin tab —
             whose id is host-qualified since PA-67 — would file it under a
             machine it is not about. */
          <Suspense fallback={<PageFallback />}>
            {route.name === 'hub-templates' ? (
              <HubTemplatesPage
                onOpenTemplate={(templateId) =>
                  onNavigate({ name: 'hub-template', templateId }, { hostId: null })
                }
                onApiError={onApiError}
              />
            ) : (
              <HubTemplateEditorPage
                key={route.templateId}
                templateId={route.templateId}
                onCreated={(templateId) =>
                  onNavigate({ name: 'hub-template', templateId }, { hostId: null })
                }
                onBack={() => onNavigate({ name: 'hub-templates' }, { hostId: null })}
                onDone={() => onNavigate({ name: 'hub-templates' }, { hostId: null })}
                onApiError={onApiError}
              />
            )}
          </Suspense>
        ) : activeTabId === null ? (
          <WelcomePane onCompose={() => nav.openOn(here, { name: 'compose' })} />
        ) : null}
      </main>

      {showHostSheet && (
        <HostSheet
          hosts={hosts}
          hubVersion={directory.hubVersion}
          fleet={fleetProp}
          selectedHostId={selectedHostId}
          onSelectAll={() => nav.goToHost(null)}
          onSelect={(hostId) => nav.goToHost(hostId)}
          onAdd={() => setShowAddHost(true)}
          onRemove={(hostId) => {
            // `hostId` here is a *management* id (see `HostSheet`'s prop doc
            // comment), which for a Hub's default host differs from the
            // routing id `selectedHostId` is compared against — resolve the
            // record first rather than comparing the two ids directly.
            const record = findHostByManageId(hosts, hostId);
            void directory.remove(hostId);
            if (record && selectedHostId === record.endpoint.id) nav.goToHost(null);
          }}
          onBind={(hostId) => setBindHostId(hostId)}
          onEdit={(hostId) => setEditHostId(hostId)}
          onClose={() => setShowHostSheet(false)}
          canManage={directory.canManage}
        />
      )}

      {showAddHost && (
        <AddHostDialog directory={directory} onClose={() => setShowAddHost(false)} />
      )}

      {bindHostId !== null && (
        <BindHostDialog
          directory={directory}
          hostId={bindHostId}
          hostLabel={findHostByManageId(hosts, bindHostId)?.label ?? bindHostId}
          alreadyBound={findHostByManageId(hosts, bindHostId)?.hubBound === true}
          onClose={() => setBindHostId(null)}
        />
      )}

      {editHostId !== null &&
        (() => {
          const record = findHostByManageId(hosts, editHostId);
          return record ? (
            <EditHostDialog directory={directory} host={record} onClose={() => setEditHostId(null)} />
          ) : null;
        })()}

      {showAdd !== null && (
        <HostProvider endpoint={nav.endpointFor(showAdd)}>
          <AddProject
            onClose={() => setShowAdd(null)}
            onAdded={() => void fleet.refreshHost(showAdd)}
            onApiError={onApiError}
          />
        </HostProvider>
      )}

      {showHidden !== null && (
        <HostProvider endpoint={nav.endpointFor(showHidden)}>
          <HiddenProjects
            onClose={() => setShowHidden(null)}
            onChanged={() => void fleet.refreshHost(showHidden)}
            onApiError={onApiError}
          />
        </HostProvider>
      )}

      {showRunning !== null && (
        <HostProvider endpoint={nav.endpointFor(showRunning)}>
          <RunningSessions
            onClose={() => setShowRunning(null)}
            onOpen={(sessionId) => nav.openOn(showRunning, { name: 'terminal', sessionId })}
            onApiError={onApiError}
          />
        </HostProvider>
      )}

      {showAdvanced !== null && (
        <HostProvider endpoint={nav.endpointFor(showAdvanced)}>
          <NewSessionDialog
            onCancel={() => setShowAdvanced(null)}
            onApiError={onApiError}
            onCreated={(id) => {
              const hostId = showAdvanced;
              setShowAdvanced(null);
              void fleet.refreshHost(hostId);
              nav.openOn(hostId, { name: 'terminal', sessionId: id });
            }}
          />
        </HostProvider>
      )}

      {showShell !== null && (
        <HostProvider endpoint={nav.endpointFor(showShell)}>
          <ShellDialog
            onClose={() => setShowShell(null)}
            onApiError={onApiError}
            onCreated={(id) => {
              const hostId = showShell;
              setShowShell(null);
              void fleet.refreshHost(hostId);
              nav.openOn(hostId, { name: 'terminal', sessionId: id });
            }}
          />
        </HostProvider>
      )}
    </div>
  );
}

/** What fills the pane before a chat is chosen. */
function WelcomePane({ onCompose }: { onCompose: () => void }): JSX.Element {
  return (
    <div className="welcome">
      <Icon name="terminal" size={38} />
      <h2>Pick up where you left off</h2>
      <p>
        Choose a chat on the left to read it, or start a new one. Sessions keep running when
        you close this tab.
      </p>
      <button type="button" className="primary" onClick={onCompose}>
        New chat
      </button>
    </div>
  );
}

/**
 * The sidebar while the Hub is selected (PA-110).
 *
 * Replaces "New chat", "Shell", "Agents", search and the host groups — every
 * one of which acts on a host, and none of which has a host to act on here.
 * What it offers instead is the Hub's own two pages and the host list as a
 * way *out* of the Hub view: choosing a host goes to that host, exactly as its
 * rail tile does.
 */
function HubSidebar({
  route,
  hosts,
  fleet,
  onOverview,
  onTemplates,
  onOpenHost,
  onAddHost,
  canManage,
}: {
  route: Route;
  hosts: readonly HostRecord[];
  /** PA-134: the Fleet agent's entry, when the fleet is enabled. */
  fleet: { problem: string | null; onOpen: () => void; onProblem: () => void } | null;
  onOverview: () => void;
  onTemplates: () => void;
  onOpenHost: (hostId: string) => void;
  onAddHost: () => void;
  canManage: boolean;
}): JSX.Element {
  const templates = route.name === 'hub-templates' || route.name === 'hub-template';
  // Anything else is the overview — including a host route on a Hub with no
  // hosts, which renders the Hub page whatever the URL said.
  const overview = !templates;
  return (
    <div className="sidebar-scroll hub-sidebar">
      <nav className="hub-nav" aria-label="Hub">
        <button type="button" className={`hub-nav-item${overview ? ' active' : ''}`} onClick={onOverview}>
          <Icon name="hub" size={17} />
          Overview
        </button>
        <button type="button" className={`hub-nav-item${templates ? ' active' : ''}`} onClick={onTemplates}>
          <Icon name="template" size={17} />
          Config templates
        </button>
        {fleet && (
          <button
            type="button"
            className={`hub-nav-item${fleet.problem ? ' warn' : ''}`}
            onClick={fleet.problem ? fleet.onProblem : fleet.onOpen}
            title={fleet.problem ?? 'Open the Fleet agent’s chat on its coordinator'}
          >
            <Icon name="agents" size={17} />
            Fleet
            {fleet.problem && <span className="hub-nav-note">{fleet.problem}</span>}
          </button>
        )}
      </nav>
      <div className="hub-sidebar-hosts">
        <div className="hub-sidebar-label">Hosts</div>
        {hosts.length === 0 && <p className="hub-muted">None yet.</p>}
        {hosts.map((host) => (
          <button
            key={host.endpoint.id}
            type="button"
            className="hub-sidebar-host"
            onClick={() => onOpenHost(host.endpoint.id)}
            title={host.message ?? `Open ${host.label}`}
          >
            <span className={hostDotClass(host.status)} aria-hidden="true" />
            <span className="hub-sidebar-host-name">{host.label}</span>
            <span className="hub-sidebar-host-status">{hostStatusSummary(host)}</span>
          </button>
        ))}
        {canManage && (
          <button type="button" className="hub-sidebar-host add" onClick={onAddHost}>
            <Icon name="plus" size={15} />
            <span className="hub-sidebar-host-name">Add host</span>
          </button>
        )}
      </div>
    </div>
  );
}
