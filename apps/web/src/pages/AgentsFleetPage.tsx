import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  isTerminalStatus,
  type PlannerChat,
  type ProjectInfo,
  type SessionInfo,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { AgentCard } from '../components/AgentCard.js';
import { PlannerAgentCard } from '../components/PlannerAgentCard.js';
import { QueuedRunCard } from '../components/QueuedRunCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  buildFleetKanban,
  finishedFleetAgents,
  loadFleetGroupByProject,
  loadFleetHideIdle,
  saveFleetGroupByProject,
  saveFleetHideIdle,
  type FleetKanbanColumn,
  type FleetKanbanColumnKey,
  type FleetKanbanItem,
} from '../agent/fleet-groups.js';
import { Icon } from '../components/Icon.js';
import { useHostApi } from '../hosts/HostContext.js';

const REFRESH_MS = 4000;

interface Props {
  /** Opens a coding-agent or terminal session's full view. */
  onOpen: (sessionId: string) => void;
  /** PA-182: Opens a Pocket Agent chat. */
  onOpenPlannerChat?: (chatId: string) => void;
  /** PA-182: Opens a queued webhook's editor/delivery view. */
  onOpenWebhook?: (webhookId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * False when mounted inside an inactive desktop tab — pauses polling and
   * child card WS/SSE connections so background Agents tabs don't consume
   * connections while hidden. Defaults to true (phone view / active tab).
   */
  active?: boolean;
  /**
   * Present only on the phone route, which has no sidebar to fall back to —
   * `DesktopShell` renders this in its right pane with the sidebar already
   * on screen, so it passes nothing here.
   */
  onBack?: () => void;
}

/**
 * PA-182: The "Agents" fleet view — a 3-column Kanban board (`Pending`,
 * `In Progress`, `Idle / Ready`) with collapsible project sub-groups inside
 * each lane, Pocket Agent chats alongside coding agents, PA-165 status dots,
 * and a dedicated "Terminal sessions" section below (PA-22).
 *
 * Polls `/api/sessions`, `/api/projects`, and `/api/planner/chats` on a 4s
 * interval so the board stays live regardless of whether the sidebar is
 * mounted.
 */
export function AgentsFleetPage({
  onOpen,
  onOpenPlannerChat,
  onOpenWebhook,
  onApiError,
  active = true,
  onBack,
}: Props): JSX.Element {
  const api = useHostApi();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [plannerChats, setPlannerChats] = useState<PlannerChat[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [groupByProject, setGroupByProjectState] = useState(loadFleetGroupByProject);
  const [hideIdle, setHideIdleState] = useState(loadFleetHideIdle);
  const [projectFilter, setProjectFilter] = useState<string>('all');
  const [collapsedSubGroups, setCollapsedSubGroups] = useState<Set<string>>(() => new Set());
  const [confirmingCloseFinished, setConfirmingCloseFinished] = useState(false);
  const [closingFinished, setClosingFinished] = useState(false);

  // Instantaneous approval overrides reported by individual cards' WS/SSE
  // streams so a permission prompt moves a card into Pending without waiting
  // for the 4s HTTP poll.
  const [sessionApprovalOverrides, setSessionApprovalOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [plannerApprovalOverrides, setPlannerApprovalOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );

  const setGroupByProject = (on: boolean): void => {
    setGroupByProjectState(on);
    saveFleetGroupByProject(on);
  };

  const setHideIdle = (on: boolean): void => {
    setHideIdleState(on);
    saveFleetHideIdle(on);
  };

  const handleSessionApprovalChange = useCallback((sessionId: string, awaiting: boolean) => {
    setSessionApprovalOverrides((prev) => {
      if (prev.get(sessionId) === awaiting) return prev;
      const next = new Map(prev);
      if (awaiting) next.set(sessionId, true);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  const handlePlannerApprovalChange = useCallback((chatId: string, awaiting: boolean) => {
    setPlannerApprovalOverrides((prev) => {
      if (prev.get(chatId) === awaiting) return prev;
      const next = new Map(prev);
      if (awaiting) next.set(chatId, true);
      else next.delete(chatId);
      return next;
    });
  }, []);

  const toggleSubGroup = useCallback((columnKey: FleetKanbanColumnKey, groupKey: string) => {
    const id = `${columnKey}:${groupKey}`;
    setCollapsedSubGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const [sessionsRes, projectsRes, plannerRes] = await Promise.allSettled([
        api.listSessions(),
        api.listProjects(),
        api.listPlannerChats(),
      ]);

      if (sessionsRes.status === 'rejected') {
        throw sessionsRes.reason;
      }

      const alive = sessionsRes.value.sessions
        .filter((s) => !isTerminalStatus(s.status))
        .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
      setSessions(alive);

      if (projectsRes.status === 'fulfilled') {
        setProjects(projectsRes.value.projects);
      }
      if (plannerRes.status === 'fulfilled') {
        setPlannerChats(plannerRes.value.chats);
      }
      setError(null);
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load agents.');
      setSessions([]);
    }
  }, [api, onApiError]);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const finishedAgents = useMemo(
    () => (sessions ? finishedFleetAgents(sessions) : []),
    [sessions],
  );

  const board = useMemo(
    () =>
      sessions === null
        ? null
        : buildFleetKanban({
            sessions,
            plannerChats,
            projects,
            awaitingApprovalOverrides: sessionApprovalOverrides,
            plannerAwaitingApprovalOverrides: plannerApprovalOverrides,
            hideIdle,
            projectFilter,
          }),
    [
      sessions,
      plannerChats,
      projects,
      sessionApprovalOverrides,
      plannerApprovalOverrides,
      hideIdle,
      projectFilter,
    ],
  );

  // If the selected project disappears (its last session finished), reset filter
  // back to All so the user isn't stranded looking at an empty filtered board.
  useEffect(() => {
    if (projectFilter === 'all' || !board) return;
    if (!board.projectOptions.some((o) => o.key === projectFilter)) {
      setProjectFilter('all');
    }
  }, [board, projectFilter]);

  const closeAllFinished = useCallback(async () => {
    if (finishedAgents.length === 0) {
      setConfirmingCloseFinished(false);
      return;
    }
    setClosingFinished(true);
    try {
      const results = await Promise.allSettled(
        finishedAgents.map((s) => api.deleteSession(s.id)),
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) {
        onApiError(failed.reason);
      }
      await load();
    } finally {
      setClosingFinished(false);
      setConfirmingCloseFinished(false);
    }
  }, [api, finishedAgents, load, onApiError]);

  const renderCard = (item: FleetKanbanItem): JSX.Element => {
    if (item.kind === 'session') {
      return (
        <AgentCard
          key={item.session.id}
          session={item.session}
          project={item.project}
          provenance={item.provenance}
          active={active}
          onOpen={onOpen}
          onApiError={onApiError}
          onStopped={() => void load()}
          onAwaitingApprovalChange={handleSessionApprovalChange}
        />
      );
    }
    if (item.kind === 'planner') {
      return (
        <PlannerAgentCard
          key={item.id}
          chat={item.chat}
          active={active}
          onOpen={(chatId) => onOpenPlannerChat?.(chatId)}
          onApiError={onApiError}
          onInterrupted={() => void load()}
          onAwaitingApprovalChange={handlePlannerApprovalChange}
        />
      );
    }
    return (
      <QueuedRunCard
        key={item.id}
        queued={item.queued}
        onOpenSession={onOpen}
        {...(onOpenWebhook ? { onOpenWebhook } : {})}
      />
    );
  };

  const renderColumn = (column: FleetKanbanColumn): JSX.Element => {
    const columnDotClass =
      column.key === 'pending'
        ? 'fleet-lane-dot--pending'
        : column.key === 'in_progress'
          ? 'fleet-lane-dot--progress'
          : 'fleet-lane-dot--idle';

    return (
      <section
        className={`fleet-lane fleet-lane--${column.key}`}
        key={column.key}
        aria-label={column.title}
      >
        <div className="fleet-lane-head">
          <div className="fleet-lane-title-row">
            <span className={`fleet-lane-dot ${columnDotClass}`} aria-hidden="true" />
            <h2>{column.title}</h2>
            <span className="fleet-section-count">{column.items.length}</span>
          </div>
          <p className="fleet-lane-hint">{column.hint}</p>
        </div>

        <div className="fleet-lane-body">
          {column.items.length === 0 ? (
            <div className="fleet-lane-empty">None right now</div>
          ) : groupByProject ? (
            column.subGroups.map((sub) => {
              const collapseKey = `${column.key}:${sub.key}`;
              const isCollapsed = collapsedSubGroups.has(collapseKey);
              return (
                <div className="fleet-subgroup" key={sub.key}>
                  <button
                    type="button"
                    className="fleet-subgroup-head"
                    onClick={() => toggleSubGroup(column.key, sub.key)}
                    aria-expanded={!isCollapsed}
                  >
                    <Icon
                      name={isCollapsed ? 'chevron-right' : 'chevron-down'}
                      size={13}
                      className="fleet-subgroup-caret"
                    />
                    <Icon name={sub.icon} size={13} className="fleet-subgroup-icon" />
                    <span className="fleet-subgroup-label">{sub.label}</span>
                    <span className="fleet-subgroup-count">{sub.items.length}</span>
                  </button>
                  {!isCollapsed && (
                    <div className="fleet-subgroup-cards">{sub.items.map(renderCard)}</div>
                  )}
                </div>
              );
            })
          ) : (
            <div className="fleet-subgroup-cards">{column.items.map(renderCard)}</div>
          )}
        </div>
      </section>
    );
  };

  const hasKanbanCards = board ? board.columns.some((c) => c.items.length > 0) : false;

  const content = (
    <div className="fleet-page">
      <div className="fleet-header">
        <div className="fleet-header-title">
          {!onBack && <h1>Agents</h1>}
          <span className="fleet-count">{board === null ? 'Loading…' : board.summary}</span>
        </div>
        <div className="fleet-header-actions">
          {board && board.projectOptions.length >= 2 && (
            <label className="fleet-project-filter">
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                aria-label="Filter by project"
              >
                <option value="all">All projects</option>
                {board.projectOptions.map((opt) => (
                  <option key={opt.key} value={opt.key}>
                    {opt.label} ({opt.count})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="fleet-running-only-toggle">
            <input
              type="checkbox"
              checked={groupByProject}
              onChange={(e) => setGroupByProject(e.target.checked)}
            />
            <span>Group by project</span>
          </label>
          <label className="fleet-running-only-toggle">
            <input
              type="checkbox"
              checked={hideIdle}
              onChange={(e) => setHideIdle(e.target.checked)}
            />
            <span>Hide idle</span>
          </label>
          <button
            type="button"
            className="fleet-close-finished-btn"
            disabled={finishedAgents.length === 0 || closingFinished}
            onClick={() => setConfirmingCloseFinished(true)}
          >
            {closingFinished ? 'Closing…' : 'Close all finished agents'}
          </button>
        </div>
      </div>

      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}

      {sessions === null && <div className="spinner">Loading…</div>}

      {board !== null && board.totalVisibleCards === 0 && (
        <div className="fleet-empty">
          {hideIdle && finishedAgents.length > 0
            ? 'No active or unread agents right now (idle agents are hidden).'
            : 'Nothing running right now.'}
        </div>
      )}

      {board !== null && hasKanbanCards && (
        <div className="fleet-kanban">{board.columns.map(renderColumn)}</div>
      )}

      {board !== null && board.terminals.length > 0 && (
        <section className="fleet-section fleet-terminals-section">
          <div className="fleet-section-head">
            <h2>
              <Icon name="terminal" size={16} />
              Terminal sessions
              <span className="fleet-section-count">{board.terminals.length}</span>
            </h2>
            <p className="fleet-section-hint">
              Raw terminals you drive with keystrokes — tmux panes included.
            </p>
          </div>
          <div className="fleet-grid">
            {board.terminals.map(({ session, project, provenance }) => (
              <AgentCard
                key={session.id}
                session={session}
                project={project}
                provenance={provenance}
                active={active}
                onOpen={onOpen}
                onApiError={onApiError}
                onStopped={() => void load()}
              />
            ))}
          </div>
        </section>
      )}

      {confirmingCloseFinished && (
        <ConfirmDialog
          title={`Close ${finishedAgents.length} finished agent${finishedAgents.length === 1 ? '' : 's'}?`}
          body={`All ${finishedAgents.length} idle coding agent session${finishedAgents.length === 1 ? '' : 's'} will be stopped. Running agents, Pocket Agents, and terminal sessions will not be affected.`}
          confirmLabel={closingFinished ? 'Closing…' : 'Close all'}
          busy={closingFinished}
          onConfirm={() => void closeAllFinished()}
          onCancel={() => setConfirmingCloseFinished(false)}
        />
      )}
    </div>
  );

  if (!onBack) return content;

  return (
    <div className="app">
      <header className="home-bar">
        <button type="button" className="round-btn" onClick={onBack} aria-label="Back">
          <Icon name="chevron-left" size={20} />
        </button>
        <div className="home-title">
          <strong>Agents</strong>
        </div>
      </header>
      {content}
    </div>
  );
}
