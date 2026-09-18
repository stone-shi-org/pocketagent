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
import { HostProvider } from '../hosts/HostContext.js';
import { useHostFleet } from '../hosts/useHostFleet.js';
import { currentHostId, visibleHosts } from '../hosts/selected-host.js';
import { loadCollapsedHosts, toggleCollapsedHost } from '../hosts/collapsed-pref.js';
import type { HostDirectory } from '../hosts/directory.js';
import type { HostNav } from '../hosts/HostNav.js';

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
            onAdvanced={() => {
              setMenuOpen(false);
              setShowAdvanced(here);
            }}
            onRefresh={() => {
              setMenuOpen(false);
              void fleet.refreshAll();
              directory.refresh();
            }}
            onHidden={() => {
              setMenuOpen(false);
              setShowHidden(here);
            }}
            onRunning={() => {
              setMenuOpen(false);
              setShowRunning(here);
            }}
            onHosts={() => {
              setMenuOpen(false);
              setShowHostSheet(true);
            }}
            onShell={() => {
              setMenuOpen(false);
              setShowShell(here);
            }}
            runningCount={runningCount}
            onAgents={() => {
              setMenuOpen(false);
              onOpenAgents();
            }}
            onSettings={() => {
              setMenuOpen(false);
              onOpenSettings();
            }}
            onCron={() => {
              setMenuOpen(false);
              onOpenCron();
            }}
            onWebhooks={() => {
              setMenuOpen(false);
              onOpenWebhooks();
            }}
            onPlanner={() => {
              setMenuOpen(false);
              onOpenPlanner();
            }}
            onLogout={onLogout}
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
          selectedHostId={selected}
          onSelectAll={() => nav.goToHost(null)}
          onSelect={(hostId) => nav.goToHost(hostId)}
          onAdd={() => setShowAddHost(true)}
          onRemove={(hostId) => {
            void directory.remove(hostId);
            // A removed host cannot stay selected, or the very next render is
            // the "no such host" screen for a host the user just deleted.
            if (selected === hostId) nav.goToHost(null);
          }}
          onClose={() => setShowHostSheet(false)}
          canManage={directory.canManage}
        />
      )}

      {showAddHost && (
        <AddHostDialog directory={directory} onClose={() => setShowAddHost(false)} />
      )}

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

export function OverflowMenu({
  onClose,
  onAdvanced,
  onRefresh,
  onHidden,
  onRunning,
  onHosts,
  onShell,
  runningCount = 0,
  onAgents,
  onSettings,
  onCron,
  onWebhooks,
  onPlanner,
  onLogout,
}: {
  onClose: () => void;
  onAdvanced: () => void;
  onRefresh: () => void;
  onHidden: () => void;
  onRunning: () => void;
  /**
   * Opens the host sheet (PA-67).
   *
   * The phone's header chip already opens it, but the desktop's own switcher
   * is the rail — and the rail is hidden while there is only one host, which
   * would otherwise leave a standalone desktop with no way to register a
   * second one at all. Chrome that already exists, rather than a permanent
   * column that earns its width only once it has something to switch between.
   */
  onHosts?: () => void;
  onShell?: () => void;
  /** Shown next to the menu item so a growing pile of live sessions is noticed before opening it. */
  runningCount?: number;
  /**
   * Omitted on desktop, which already has a dedicated sidebar button for
   * the same destination (`DesktopShell`'s `.agents-nav-btn`) — the phone
   * shell has no such button, so this is its only way in.
   */
  onAgents?: () => void;
  onSettings: () => void;
  onCron: () => void;
  onWebhooks: () => void;
  onPlanner: () => void;
  onLogout: () => void;
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
        <button type="button" role="menuitem" onClick={onRefresh}>
          Refresh
        </button>
        {onShell && (
          <button type="button" role="menuitem" onClick={onShell}>
            Shell (Tmux sessions)…
          </button>
        )}
        <button type="button" role="menuitem" onClick={onHidden}>
          Hidden projects…
        </button>
        <button type="button" role="menuitem" onClick={onRunning}>
          Active sessions{runningCount > 0 ? ` (${runningCount})` : ''}…
        </button>
        {onHosts && (
          <button type="button" role="menuitem" onClick={onHosts}>
            Hosts…
          </button>
        )}
        {onAgents && (
          <button type="button" role="menuitem" onClick={onAgents}>
            Agents…
          </button>
        )}
        <button type="button" role="menuitem" onClick={onCron}>
          Cron jobs…
        </button>
        <button type="button" role="menuitem" onClick={onWebhooks}>
          Webhooks…
        </button>
        <button type="button" role="menuitem" onClick={onPlanner}>
          Pocket Agent settings…
        </button>
        <button type="button" role="menuitem" onClick={onAdvanced}>
          More session options…
        </button>
        <button type="button" role="menuitem" onClick={onSettings}>
          Settings…
        </button>
        <button type="button" role="menuitem" className="danger" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </>
  );
}
