import { useEffect, useRef, useState } from 'react';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { RunningSessions } from '../components/RunningSessions.js';
import { ShellDialog } from '../components/ShellDialog.js';
import { Icon } from '../components/Icon.js';
import {
  HostChip,
  ProjectList,
  SearchField,
  useProjects,
} from '../components/ProjectList.js';
import { UsageBar } from '../components/UsageBar.js';

interface Props {
  onOpen: (sessionId: string) => void;
  /** A finished chat, opened to read before deciding to continue it. */
  onOpenChat: (conversationId: string) => void;
  onCompose: (cwd?: string) => void;
  onOpenAgents: () => void;
  onOpenSettings: () => void;
  onOpenCron: () => void;
  /** Opens one job's editor, from its row in the project tree. */
  onOpenCronJob: (jobId: string) => void;
  onOpenWebhooks: () => void;
  /** Opens one webhook's editor, from its row in the project tree. */
  onOpenWebhook: (webhookId: string) => void;
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
 */
export function ProjectsPage({
  onOpen,
  onOpenChat,
  onCompose,
  onOpenAgents,
  onOpenSettings,
  onOpenCron,
  onOpenCronJob,
  onOpenWebhooks,
  onOpenWebhook,
  onApiError,
  onLogout,
}: Props): JSX.Element {
  const state = useProjects(onOpen, onOpenChat, onApiError);
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showRunning, setShowRunning] = useState(false);
  const [showShell, setShowShell] = useState(false);

  const runningCount =
    state.projects?.reduce((n, p) => n + p.chats.filter((c) => c.live).length, 0) ?? 0;

  return (
    <div className="app projects-page">
      <header className="home-bar">
        <div className="home-title">
          <strong>Remote</strong>
          <HostChip host={state.host} />
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
            onLogout={onLogout}
          />
        )}
      </header>

      <div className="home-scroll">
        {state.error && (
          <div className="error-box" role="alert">
            {state.error}
          </div>
        )}
        <ProjectList
          state={state}
          search={search}
          onCompose={onCompose}
          onAddProject={() => setShowAdd(true)}
          onOpenCronJob={onOpenCronJob}
          onOpenWebhook={onOpenWebhook}
          emptyHint="Nothing here yet. Tap the compose button to start a chat."
        />
      </div>

      <UsageBar />

      <div className="home-dock">
        <SearchField value={search} onChange={setSearch} />
        <PushToggle compact />
        <button
          type="button"
          className="round-btn plain"
          onClick={() => setShowShell(true)}
          aria-label="Shell"
          title="Shell tmux sessions"
          style={{ width: 38, height: 38, flexShrink: 0 }}
        >
          <Icon name="agent-shell" size={20} />
        </button>
        <button
          type="button"
          className="compose-fab"
          onClick={() => onCompose()}
          aria-label="New chat"
        >
          <Icon name="compose" size={23} />
        </button>
      </div>

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
          onOpen={onOpen}
          onApiError={onApiError}
        />
      )}

      {showAdvanced && (
        <NewSessionDialog
          onCancel={() => setShowAdvanced(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowAdvanced(false);
            onOpen(id);
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
            onOpen(id);
          }}
        />
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
  onShell,
  runningCount = 0,
  onAgents,
  onSettings,
  onCron,
  onWebhooks,
  onLogout,
}: {
  onClose: () => void;
  onAdvanced: () => void;
  onRefresh: () => void;
  onHidden: () => void;
  onRunning: () => void;
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
