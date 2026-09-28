import { useEffect, useMemo, useRef, useState } from 'react';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { RunningSessions } from '../components/RunningSessions.js';
import { ShellDialog } from '../components/ShellDialog.js';
import { Icon } from '../components/Icon.js';
import {
  HostChip,
  HostCompatibilityNotice,
  ProjectList,
  SearchField,
} from '../components/ProjectList.js';
import { UsageBar } from '../components/UsageBar.js';
import { PocketAgentsSection } from '../components/PocketAgentsSection.js';
import { ShellSection } from '../components/ShellSection.js';
import { HostGroup } from '../components/HostGroup.js';
import { HostSheet } from '../components/HostSheet.js';
import { AddHostDialog } from '../components/AddHostDialog.js';
import { BindHostDialog } from '../components/BindHostDialog.js';
import { EditHostDialog } from '../components/EditHostDialog.js';
import { findHostByManageId } from '../hosts/host-status.js';
import { HostProvider } from '../hosts/HostContext.js';
import { useHostFleet } from '../hosts/useHostFleet.js';
import { currentHostId, visibleHosts } from '../hosts/selected-host.js';
import { loadCollapsedHosts, toggleCollapsedHost } from '../hosts/collapsed-pref.js';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostNav } from '../hosts/HostNav.js';
import { overflowMenuItems, type MenuItem, type MenuItemId } from '../hosts/hub-view.js';

interface Props {
  nav: HostNav;
  directory: HostDirectory;
  onOpen: (hostId: string, sessionId: string) => void;
  /** A finished chat, opened to read before deciding to continue it. */
  onOpenChat: (hostId: string, conversationId: string) => void;
  onCompose: (hostId: string, cwd?: string) => void;
  onOpenAgents: () => void;
  onOpenSettings: () => void;
  onOpenCron: () => void;
  /** Opens one job's editor, from its row in the project tree. */
  onOpenCronJob: (hostId: string, jobId: string) => void;
  onOpenWebhooks: () => void;
  /** Opens one webhook's editor, from its row in the project tree. */
  onOpenWebhook: (hostId: string, webhookId: string) => void;
  /** PA-6: opens the Pocket Agent settings page (LLM endpoint, agents, tools). */
  onOpenPlanner: () => void;
  /** PA-6: opens one Pocket Agent chat, from the home screen's own "Pocket Agents" section. */
  onOpenPlannerChat: (hostId: string, chatId: string) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
  /** PA-110: the Hub's own view, offered from the host sheet when a Hub serves this page. */
  onOpenHub?: () => void;
}

/**
 * Home screen on a phone: a folder per workspace directory, the chats inside
 * it, and one button to start another.
 *
 * The grouping is the point. A flat list of sessions answers "what is running",
 * which is a server's question; the thing you actually want on a phone is
 * "what was I doing on this project", and a chat that has finished is still an
 * answer to that. So live sessions and finished conversations sit in one list,
 * distinguished by a dot rather than by being filed somewhere else.
 *
 * Since PA-67 there is one more grouping level above the three categories: the
 * **host**. It is a heading, never a badge per row, so the "no metadata per
 * row" convention survives — and with one registered host the heading is not
 * rendered at all, which is what keeps a standalone install's home screen
 * exactly as it was. The switcher is the header chip, which opens `HostSheet`;
 * a permanent rail is the desktop's answer and would cost scarce width here.
 */
export function ProjectsPage({
  nav,
  directory,
  onOpen,
  onOpenChat,
  onCompose,
  onOpenAgents,
  onOpenSettings,
  onOpenCron,
  onOpenCronJob,
  onOpenWebhooks,
  onOpenWebhook,
  onOpenPlanner,
  onOpenPlannerChat,
  onApiError,
  onLogout,
  onOpenHub,
}: Props): JSX.Element {
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
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
  const selected = nav.selection.mode === 'one' ? nav.selection.hostId : null;
  const here = currentHostId(nav.selection, hosts);
  const visible = useMemo(() => visibleHosts(nav.selection, hosts), [nav.selection, hosts]);
  const singleHost = hosts.length <= 1;

  const fleet = useHostFleet({
    hosts,
    poll: {
      selectedHostId: selected,
      collapsedHostIds: collapsed,
      // The phone layout has no tab strip, so nothing forces a host onto the
      // foreground tier beyond the one being looked at.
      tabHostIds: [],
      singleHost,
    },
    onOpen,
    onOpenChat,
    onApiError,
  });

  // Counts shells too: they left `projects` when they became their own
  // category (PA-25), and a badge that stopped counting live terminals would
  // read as "nothing running" with three of them open. Summed across every
  // host on screen, since that is what the screen is showing.
  const runningCount = visible.reduce((total, host) => {
    const state = fleet.stateFor(host.endpoint.id);
    return (
      total +
      (state.projects?.reduce((n, p) => n + p.chats.filter((c) => c.live).length, 0) ?? 0) +
      (state.shells?.filter((s) => s.live).length ?? 0)
    );
  }, 0);

  const hereState = fleet.stateFor(here);

  return (
    <div className="app projects-page">
      <header className="home-bar">
        <div className="home-title">
          <strong>Remote</strong>
          {/* The chip is the switcher on a phone (PA-67). With one host it
              still opens the sheet, which is the only way to add a second. */}
          <HostChip
            host={hereState.host}
            record={hosts.find((candidate) => candidate.endpoint.id === here) ?? null}
            compatibility={hereState.hostCompatibility}
            allHosts={nav.selection.mode === 'all' && !singleHost}
            onClick={() => setShowHostSheet(true)}
          />
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="round-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More"
          aria-expanded={menuOpen}
        >
          <Icon name="ellipsis" size={20} />
        </button>
        {menuOpen && (
          <OverflowMenu
            onClose={() => setMenuOpen(false)}
            items={overflowMenuItems({
              view: 'host',
              source: directory.source,
              layout: 'phone',
              runningCount,
            })}
            handlers={menuHandlers((action) => {
              setMenuOpen(false);
              action();
            }, {
              refresh: () => {
                void fleet.refreshAll();
                directory.refresh();
              },
              shell: () => setShowShell(here),
              hidden: () => setShowHidden(here),
              running: () => setShowRunning(here),
              hosts: () => setShowHostSheet(true),
              agents: onOpenAgents,
              cron: onOpenCron,
              webhooks: onOpenWebhooks,
              planner: onOpenPlanner,
              advanced: () => setShowAdvanced(here),
              settings: onOpenSettings,
              signout: onLogout,
            })}
          />
        )}
      </header>

      <div className="home-scroll">
        {visible.map((host) => {
          const hostId = host.endpoint.id;
          const state = fleet.stateFor(hostId);
          const planner = fleet.plannerFor(hostId);
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
                    onClick={() => onCompose(hostId)}
                    aria-label={`New chat on ${host.label}`}
                    title={`New chat on ${host.label}`}
                  >
                    <Icon name="compose" size={18} />
                  </button>
                }
              >
                {/* Per host, so one failing machine says so in its own group
                    rather than above everybody's rows. */}
                {state.error && (
                  <div className="error-box" role="alert">
                    {state.error}
                  </div>
                )}
                <HostCompatibilityNotice compatibility={state.hostCompatibility} />
                <PocketAgentsSection
                  workspaces={planner.workspaces}
                  chats={planner.chats}
                  refresh={planner.refresh}
                  onOpenChat={(chatId) => onOpenPlannerChat(hostId, chatId)}
                  onApiError={onApiError}
                />
                {/* "Shell" sits between the other two categories (PA-25): a terminal is
                    more likely to be what you came back for than a project folder, but
                    Pocket Agents keeps the top spot it already had. */}
                <ShellSection
                  state={state}
                  open={state.open}
                  onNewShell={() => setShowShell(hostId)}
                  search={search}
                />
                <ProjectList
                  state={state}
                  search={search}
                  onCompose={(cwd) => onCompose(hostId, cwd)}
                  onAddProject={() => setShowAdd(hostId)}
                  onOpenCronJob={(jobId) => onOpenCronJob(hostId, jobId)}
                  onOpenWebhook={(webhookId) => onOpenWebhook(hostId, webhookId)}
                  onOpenPlannerChat={(chatId) => onOpenPlannerChat(hostId, chatId)}
                  onApiError={onApiError}
                  emptyHint="Nothing here yet. Tap the compose button to start a chat."
                />
              </HostGroup>
            </HostProvider>
          );
        })}
      </div>

      <UsageBar />

      <div className="home-dock">
        <SearchField value={search} onChange={setSearch} />
        <PushToggle compact />
        <button
          type="button"
          className="round-btn plain"
          onClick={() => setShowShell(here)}
          aria-label="Shell"
          title="Shell tmux sessions"
          style={{ width: 38, height: 38, flexShrink: 0 }}
        >
          <Icon name="agent-shell" size={20} />
        </button>
        <button
          type="button"
          className="compose-fab"
          onClick={() => onCompose(here)}
          aria-label="New chat"
        >
          <Icon name="compose" size={23} />
        </button>
      </div>

      {showHostSheet && (
        <HostSheet
          hosts={hosts}
          hubVersion={directory.hubVersion}
          selectedHostId={selected}
          hub={directory.source === 'hub' && onOpenHub ? { active: false, onSelect: onOpenHub } : null}
          onSelectAll={() => nav.goToHost(null)}
          onSelect={(hostId) => nav.goToHost(hostId)}
          onAdd={() => setShowAddHost(true)}
          onRemove={(hostId) => {
            // `hostId` here is a *management* id (see `HostSheet`'s prop doc
            // comment), which for a Hub's default host differs from the
            // routing id `selected` is compared against — resolve the record
            // first rather than comparing the two ids directly.
            const record = findHostByManageId(hosts, hostId);
            void directory.remove(hostId);
            // A removed host cannot stay selected, or the very next render is
            // the "no such host" screen for a host the user just deleted.
            if (record && selected === record.endpoint.id) nav.goToHost(null);
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

      {/* Every dialog below acts on exactly one host, so each is mounted inside
          that host's provider and its open-state *is* the host id. Reached
          either from a host group's own row (unambiguous) or from the chrome,
          which targets the current host. */}
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
            onOpen={(sessionId) => onOpen(showRunning, sessionId)}
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
              onOpen(hostId, id);
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
              onOpen(hostId, id);
            }}
          />
        </HostProvider>
      )}
    </div>
  );
}

/**
 * The header's overflow menu, in both layouts.
 *
 * Which items appear is `overflowMenuItems`' decision, not this component's
 * (PA-110): the Hub view and a host view offer disjoint sets, and the rule
 * lives in one tested function so the phone and desktop cannot drift apart
 * on it. This only renders the list and wires each id to its handler — an id
 * with no handler is skipped rather than rendered dead, so a caller that
 * cannot offer something (the phone has no tab strip to open Settings in, say)
 * simply omits it.
 */
export function OverflowMenu({
  items,
  handlers,
  onClose,
}: {
  items: readonly MenuItem[];
  handlers: Partial<Record<MenuItemId, () => void>>;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      {/* A full-page click-away target. It must not be `.menu`'s DOM parent:
          `.menu-backdrop` is `position: fixed`, which would become the
          containing block for an absolutely-positioned child and place it
          against the *viewport's* edge instead of the trigger button's own
          header — exactly right on the phone's full-width bar, wildly wrong
          in the desktop sidebar, which sits far from that edge. Siblings let
          `.menu` anchor to `.home-bar`/`.sidebar-head` (both already
          `position: relative`) instead. */}
      <div className="menu-backdrop" onClick={onClose} role="presentation" />
      <div className="menu" ref={ref} role="menu">
        {items.map((item) => {
          const handler = handlers[item.id];
          if (!handler) return null;
          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={item.danger ? 'danger' : undefined}
              onClick={handler}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

/**
 * Wraps every handler so choosing an item closes the menu first — the one
 * thing all of them share, written once rather than in fifteen closures.
 */
export function menuHandlers(
  wrap: (action: () => void) => void,
  actions: Partial<Record<MenuItemId, () => void>>,
): Partial<Record<MenuItemId, () => void>> {
  const out: Partial<Record<MenuItemId, () => void>> = {};
  for (const [id, action] of Object.entries(actions) as [MenuItemId, (() => void) | undefined][]) {
    if (action) out[id] = () => wrap(action);
  }
  return out;
}
