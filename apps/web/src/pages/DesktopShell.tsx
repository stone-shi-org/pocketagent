import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Route } from '../hooks/useHashRoute.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { SettingsPage } from './SettingsPage.js';
import { RunningSessions } from '../components/RunningSessions.js';
import { Icon } from '../components/Icon.js';
import { HostChip, ProjectList, SearchField, allChats, useProjects } from '../components/ProjectList.js';
import { TabBar, type Tab } from '../components/TabBar.js';
import { UsageBar } from '../components/UsageBar.js';
import { formatBuildInfo } from '../version.js';
import { OverflowMenu } from './ProjectsPage.js';
import { ComposerPage } from './ComposerPage.js';
import { AgentsFleetPage } from './AgentsFleetPage.js';
import { CronJobsPage } from './CronJobsPage.js';
import { CronJobEditorPage } from './CronJobEditorPage.js';
import { WebhooksPage } from './WebhooksPage.js';
import { WebhookEditorPage } from './WebhookEditorPage.js';
import { WebhookHistoryPage } from './WebhookHistoryPage.js';
import { SessionRoute } from './SessionRoute.js';
import { ChatPreviewPage } from './ChatPreviewPage.js';
import { loadOpenTabRoutes, saveOpenTabRoutes, type StoredTabRoute } from '../agent/open-tabs-pref.js';
import { fallbackAfterClose, isTabRoute, tabIdFor, tabListReducer, type TabRoute } from '../agent/tab-list.js';

import { ShellDialog } from '../components/ShellDialog.js';

interface Props {
  route: Route;
  onNavigate: (route: Route) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}

function storedToRoute(stored: StoredTabRoute): TabRoute {
  return stored.name === 'terminal'
    ? { name: 'terminal', sessionId: stored.sessionId }
    : { name: 'chat', conversationId: stored.conversationId };
}

function routeToStored(route: TabRoute): StoredTabRoute {
  return route.name === 'terminal'
    ? { name: 'terminal', sessionId: route.sessionId }
    : { name: 'chat', conversationId: route.conversationId };
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
 * Which layout you get is decided by viewport width and pointer type, never by
 * sniffing the user agent. See `useMediaQuery`.
 */
export function DesktopShell({ route, onNavigate, onApiError, onLogout }: Props): JSX.Element {
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showRunning, setShowRunning] = useState(false);
  const [showShell, setShowShell] = useState(false);

  const [tabs, dispatch] = useReducer(tabListReducer, undefined, () =>
    loadOpenTabRoutes().map((stored) => {
      const tabRoute = storedToRoute(stored);
      return { id: tabIdFor(tabRoute), route: tabRoute };
    }),
  );

  // Computed synchronously during render — not in an effect — so navigating to
  // a session shows its tab immediately, with no one-frame flash of the
  // welcome pane while an effect catches up.
  const openTabs = useMemo(() => tabListReducer(tabs, { type: 'sync', route }), [tabs, route]);

  // Reconcile the persisted reducer state once the merge above actually added
  // a tab (or a close/reorder below has run).
  useEffect(() => {
    if (openTabs !== tabs) dispatch({ type: 'sync', route });
  }, [openTabs, tabs, route]);

  useEffect(() => {
    saveOpenTabRoutes(tabs.map((t) => routeToStored(t.route)));
  }, [tabs]);

  const activeTabId = isTabRoute(route) ? tabIdFor(route) : null;

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

  /** Removes a tab from the strip only — never an API call, so the session
      underneath keeps running exactly as it would if the strip did not exist. */
  const closeTab = useCallback(
    (id: string) => {
      const current = openTabsRef.current;
      if (!current.some((t) => t.id === id)) return;

      const activeId = isTabRoute(routeRef.current) ? tabIdFor(routeRef.current) : null;
      const next = tabListReducer(current, { type: 'close', id });
      openTabsRef.current = next;
      dispatch({ type: 'close', id });

      if (activeId === id) {
        // Same "closing a tab focuses a neighbor" affordance as a browser.
        const fallback = fallbackAfterClose(current, id);
        const fallbackRoute = fallback ? fallback.route : ({ name: 'list' } as const);
        routeRef.current = fallbackRoute;
        onNavigate(fallbackRoute);
      }
    },
    [onNavigate],
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
    (tabRoute: TabRoute) => {
      openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'openPreview', route: tabRoute });
      dispatch({ type: 'openPreview', route: tabRoute });
      routeRef.current = tabRoute;
      onNavigate(tabRoute);
    },
    [onNavigate],
  );

  /** A double click: "keeps" the tab open for good, same slot, immune to
      being replaced by the next single click elsewhere in the tree. */
  const openPermanentTab = useCallback(
    (tabRoute: TabRoute) => {
      openTabsRef.current = tabListReducer(openTabsRef.current, { type: 'openPermanent', route: tabRoute });
      dispatch({ type: 'openPermanent', route: tabRoute });
      routeRef.current = tabRoute;
      onNavigate(tabRoute);
    },
    [onNavigate],
  );

  // Single click from the sidebar previews; double click keeps. Anything
  // that opens a chat some other way (compose, resuming from a chat preview,
  // the tab-list dropdown, Agents fleet) calls `onNavigate` directly and
  // always lands as a normal permanent tab via the plain `sync` merge below.
  const state = useProjects(
    (sessionId, opts) => {
      const tabRoute: TabRoute = { name: 'terminal', sessionId };
      if (opts?.preview) openPreviewTab(tabRoute);
      else openPermanentTab(tabRoute);
    },
    (conversationId, opts) => {
      const tabRoute: TabRoute = { name: 'chat', conversationId };
      if (opts?.preview) openPreviewTab(tabRoute);
      else openPermanentTab(tabRoute);
    },
    onApiError,
  );

  // Title and live status for the tab strip come from the same polled project
  // list the sidebar already renders from — no separate fetch per tab.
  const chatById = useMemo(() => {
    const map = new Map<string, { title: string; live: boolean }>();
    for (const chat of allChats(state.projects ?? [])) {
      if (chat.sessionId) map.set(`t:${chat.sessionId}`, { title: chat.title, live: chat.live });
      if (chat.conversationId) map.set(`c:${chat.conversationId}`, { title: chat.title, live: chat.live });
    }
    return map;
  }, [state.projects]);

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

  const tabsForBar: Tab[] = openTabs.map((tab) => {
    const found = chatById.get(tab.id) ?? knownTitles.current.get(tab.id);
    if (found) return { id: tab.id, title: found.title, live: found.live, preview: tab.preview ?? false };
    // Never seen at all — a tab restored from `open-tabs-pref` whose chat had
    // already aged out of the poll window before this tab bar ever mounted.
    // Same fallback `AgentPage`'s own topbar uses (`session?.title ??
    // sessionId`); the tab closes itself via the "this session no longer
    // exists" screen if it really is gone rather than just unpolled.
    const fallback = tab.route.name === 'terminal' ? tab.route.sessionId : tab.route.conversationId;
    return {
      id: tab.id,
      title: fallback,
      live: tab.route.name === 'terminal',
      preview: tab.preview ?? false,
    };
  });

  const activeSessionId = route.name === 'terminal' ? route.sessionId : null;
  const activeConversationId = route.name === 'chat' ? route.conversationId : null;
  const runningCount =
    state.projects?.reduce((n, p) => n + p.chats.filter((c) => c.live).length, 0) ?? 0;

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="sidebar-brand">
            <strong>Remote</strong>
            <HostChip host={state.host} />
            {/* Which exact build is running, at a glance — same string
                Settings shows (`formatBuildInfo`), but visible without
                opening a dialog. Desktop-only: the phone header's
                `.home-title` reuses the same `HostChip` but has no room for
                a second line without wrapping the host name. */}
            <span className="sidebar-version">{formatBuildInfo()}</span>
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
              onAdvanced={() => {
                setMenuOpen(false);
                setShowAdvanced(true);
              }}
              onRefresh={() => {
                setMenuOpen(false);
                void state.refresh();
              }}
              onHidden={() => {
                setMenuOpen(false);
                setShowHidden(true);
              }}
              onRunning={() => {
                setMenuOpen(false);
                setShowRunning(true);
              }}
              onShell={() => {
                setMenuOpen(false);
                setShowShell(true);
              }}
              runningCount={runningCount}
              onSettings={() => {
                setMenuOpen(false);
                onNavigate({ name: 'settings' });
              }}
              onCron={() => {
                setMenuOpen(false);
                onNavigate({ name: 'cron' });
              }}
              onWebhooks={() => {
                setMenuOpen(false);
                onNavigate({ name: 'webhooks' });
              }}
              onWebhookHistory={() => {
                setMenuOpen(false);
                onNavigate({ name: 'webhook-history' });
              }}
              onLogout={onLogout}
            />
          )}
        </header>

        <div className="sidebar-actions">
          <button
            type="button"
            className="new-chat-btn"
            onClick={() => onNavigate({ name: 'compose' })}
          >
            <Icon name="compose" size={18} />
            New chat
          </button>
          <button
            type="button"
            className="shell-nav-btn"
            onClick={() => setShowShell(true)}
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
          {state.error && (
            <div className="error-box" role="alert">
              {state.error}
            </div>
          )}
          <ProjectList
            state={state}
            search={search}
            onCompose={(cwd) => onNavigate({ name: 'compose', cwd })}
          onAddProject={() => setShowAdd(true)}
            activeSessionId={activeSessionId}
            activeConversationId={activeConversationId}
            onOpenCronJob={(jobId) => onNavigate({ name: 'cron-job', jobId })}
            onOpenWebhook={(webhookId) => onNavigate({ name: 'webhook', webhookId })}
            emptyHint="Nothing here yet. Start a chat to see it listed."
          />
        </div>

        <UsageBar />
      </aside>

      <main className="workspace">
        {openTabs.length > 0 && (
          <TabBar
            tabs={tabsForBar}
            activeId={activeTabId}
            onSelect={(id) => {
              const tab = openTabs.find((t) => t.id === id);
              if (tab) onNavigate(tab.route);
            }}
            onClose={closeTab}
            onReorder={reorderTabs}
            onCloseAll={closeAllTabs}
            onCloseOthers={closeOtherTabs}
          />
        )}

        {openTabs.length > 0 && (
          <div className={`tab-panels${activeTabId === null ? ' collapsed' : ''}`}>
            {openTabs.map((tab) => (
              <div
                key={tab.id}
                className={`tab-panel${tab.id === activeTabId ? '' : ' inactive'}`}
              >
                {tab.route.name === 'terminal' ? (
                  <SessionRoute
                    sessionId={tab.route.sessionId}
                    onBack={() => closeTab(tab.id)}
                    onApiError={onApiError}
                    onResumed={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
                  />
                ) : (
                  <ChatPreviewPage
                    conversationId={tab.route.conversationId}
                    onBack={() => closeTab(tab.id)}
                    onApiError={onApiError}
                    onStarted={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        {route.name === 'compose' ? (
          <ComposerPage
            // Keyed on cwd so picking a different project's "new chat" while the
            // composer is already open remounts it instead of reusing the old
            // instance's `cwd` state (composer and list are on screen together
            // here, unlike the mobile flow).
            key={route.cwd ?? ''}
            {...(route.cwd !== undefined ? { initialCwd: route.cwd } : {})}
            onBack={() => onNavigate({ name: 'list' })}
            onCreated={(sessionId) => {
              void state.refresh();
              onNavigate({ name: 'terminal', sessionId });
            }}
            onApiError={onApiError}
          />
        ) : route.name === 'agents' ? (
          <AgentsFleetPage
            onOpen={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
            onApiError={onApiError}
          />
        ) : route.name === 'settings' ? (
          <SettingsPage onApiError={onApiError} />
        ) : route.name === 'cron' ? (
          <CronJobsPage
            onOpenJob={(jobId) => onNavigate({ name: 'cron-job', jobId })}
            onApiError={onApiError}
          />
        ) : route.name === 'cron-job' ? (
          <CronJobEditorPage
            key={route.jobId}
            jobId={route.jobId}
            onDone={() => {
              void state.refresh();
              onNavigate({ name: 'cron' });
            }}
            onOpenSession={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
            onOpenChat={(conversationId) => onNavigate({ name: 'chat', conversationId })}
            onApiError={onApiError}
          />
        ) : route.name === 'webhooks' ? (
          <WebhooksPage
            onOpenWebhook={(webhookId) => onNavigate({ name: 'webhook', webhookId })}
            onOpenHistory={() => onNavigate({ name: 'webhook-history' })}
            onApiError={onApiError}
          />
        ) : route.name === 'webhook' ? (
          <WebhookEditorPage
            key={route.webhookId}
            webhookId={route.webhookId}
            onDone={() => {
              void state.refresh();
              onNavigate({ name: 'webhooks' });
            }}
            onOpenSession={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
            onOpenChat={(conversationId) => onNavigate({ name: 'chat', conversationId })}
            onApiError={onApiError}
          />
        ) : route.name === 'webhook-history' ? (
          <WebhookHistoryPage
            onOpenSession={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
            onOpenChat={(conversationId) => onNavigate({ name: 'chat', conversationId })}
            onOpenWebhook={(webhookId) => onNavigate({ name: 'webhook', webhookId })}
            onApiError={onApiError}
          />
        ) : activeTabId === null ? (
          <WelcomePane onCompose={() => onNavigate({ name: 'compose' })} />
        ) : null}
      </main>

      {showAdd && (
        <AddProject
          onClose={() => setShowAdd(false)}
          onAdded={() => void state.refresh()}
          onApiError={onApiError}
        />
      )}

      {showHidden && (
        <HiddenProjects
          onClose={() => setShowHidden(false)}
          onChanged={() => void state.refresh()}
          onApiError={onApiError}
        />
      )}

      {showRunning && (
        <RunningSessions
          onClose={() => setShowRunning(false)}
          onOpen={(sessionId) => onNavigate({ name: 'terminal', sessionId })}
          onApiError={onApiError}
        />
      )}

      {showAdvanced && (
        <NewSessionDialog
          onCancel={() => setShowAdvanced(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowAdvanced(false);
            void state.refresh();
            onNavigate({ name: 'terminal', sessionId: id });
          }}
        />
      )}

      {showShell && (
        <ShellDialog
          onClose={() => setShowShell(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowShell(false);
            void state.refresh();
            onNavigate({ name: 'terminal', sessionId: id });
          }}
        />
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
