import {
  chatDotState,
  isTerminalStatus,
  plannerChatDotState,
  type ChatDotState,
  type PlannerChat,
  type ProjectInfo,
  type QueuedRunSummary,
  type SessionInfo,
} from '@pocketagent/protocol';
import type { IconName } from '../components/Icon.js';

/**
 * Pure grouping, status-dot, and Kanban layout logic for the "Agents" fleet
 * view (`AgentsFleetPage`). Kept separate from React components so every
 * bucketing, sorting, and metadata-resolution rule is directly unit-testable.
 *
 * **The transport split (PA-22) still holds in the PA-182 Kanban redesign:**
 * structured coding agents and Pocket Agents flow through the three status
 * columns (`Pending`, `In Progress`, `Idle / Ready`), while raw `terminal`
 * sessions (direct PTYs and adopted tmux panes) stay in a dedicated section
 * below — terminals have no turn lifecycle, approvals, or unread state, and
 * "Close all finished agents" must never touch them.
 */

export type FleetGroupKey = 'agents' | 'terminals';

export interface FleetGroup {
  key: FleetGroupKey;
  title: string;
  icon: IconName;
  /** One line under the heading saying what this group *is*. */
  hint: string;
  sessions: SessionInfo[];
}

const GROUP_META: Record<FleetGroupKey, Omit<FleetGroup, 'sessions'>> = {
  agents: {
    key: 'agents',
    title: 'Agent sessions',
    icon: 'agents',
    hint: 'Structured sessions — tool calls, approvals and sub-agents.',
  },
  terminals: {
    key: 'terminals',
    title: 'Terminal sessions',
    icon: 'terminal',
    hint: 'Raw terminals you drive with keystrokes — tmux panes included.',
  },
};

export function groupFleet(sessions: readonly SessionInfo[]): FleetGroup[] {
  const groups: FleetGroup[] = [
    { ...GROUP_META.agents, sessions: sessions.filter((s) => s.transport === 'structured') },
    { ...GROUP_META.terminals, sessions: sessions.filter((s) => s.transport === 'terminal') },
  ];
  return groups.filter((g) => g.sessions.length > 0);
}

/**
 * PA-172: whether a live session on the Agents page is a structured coding
 * agent that has finished its turn and is sitting idle.
 *
 * Three guards:
 * - Structured sessions only: a raw terminal or adopted tmux pane has no
 *   turn lifecycle and must never be closed by "Close all finished agents".
 * - Not `busy`: a mid-turn agent is actively working.
 * - No pending tool approvals: an agent parked on an approval is waiting on a
 *   human decision to continue its turn, never finished.
 */
export function isFinishedFleetAgent(session: SessionInfo): boolean {
  if (session.transport !== 'structured') return false;
  if (session.busy) return false;
  if ((session.pendingApprovalsCount ?? 0) > 0) return false;
  return true;
}

/** All idle structured agent sessions eligible for batch close (PA-172). */
export function finishedFleetAgents(sessions: readonly SessionInfo[]): SessionInfo[] {
  return sessions.filter(isFinishedFleetAgent);
}

/**
 * PA-172: filters the Agents page session list when "Show running only" is
 * checked, dropping idle sessions (`!session.busy` or parked on approval).
 */
export function filterRunningFleetSessions(
  sessions: readonly SessionInfo[],
  runningOnly: boolean,
): SessionInfo[] {
  if (!runningOnly) return [...sessions];
  return sessions.filter((s) => s.busy && (s.pendingApprovalsCount ?? 0) === 0);
}

const FLEET_RUNNING_ONLY_KEY = 'pocketagent:fleet-running-only';
const FLEET_GROUP_BY_PROJECT_KEY = 'pocketagent:fleet-group-by-project';
const FLEET_HIDE_IDLE_KEY = 'pocketagent:fleet-hide-idle';

export function loadFleetRunningOnly(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FLEET_RUNNING_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveFleetRunningOnly(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (on) localStorage.setItem(FLEET_RUNNING_ONLY_KEY, '1');
    else localStorage.removeItem(FLEET_RUNNING_ONLY_KEY);
  } catch {
    /* unavailable storage: the filter simply does not persist */
  }
}

/** PA-182: defaults to true (project sub-groups enabled inside each Kanban column). */
export function loadFleetGroupByProject(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true;
    const raw = localStorage.getItem(FLEET_GROUP_BY_PROJECT_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

export function saveFleetGroupByProject(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FLEET_GROUP_BY_PROJECT_KEY, on ? '1' : '0');
  } catch {
    /* unavailable storage */
  }
}

/** PA-182: whether to hide grey-dot read idle coding sessions from the Idle column. */
export function loadFleetHideIdle(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(FLEET_HIDE_IDLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveFleetHideIdle(on: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (on) localStorage.setItem(FLEET_HIDE_IDLE_KEY, '1');
    else localStorage.removeItem(FLEET_HIDE_IDLE_KEY);
  } catch {
    /* unavailable storage */
  }
}

export function fleetSummary(sessions: readonly SessionInfo[]): string {
  const parts = groupFleet(sessions).map((g) => {
    const n = g.sessions.length;
    const noun = g.key === 'agents' ? 'agent' : 'terminal';
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  });
  return parts.length === 0 ? 'Nothing running' : parts.join(' · ');
}

export function terminalKindTag(session: SessionInfo): string | null {
  if (session.transport !== 'terminal') return null;
  if (session.adopted) return 'adopted pane';
  return session.backend === 'tmux' ? 'tmux' : 'direct';
}

export interface StopAffordance {
  /** The corner control's `aria-label` and tooltip. */
  ariaLabel: string;
  tooltip: string;
  confirmTitle: string;
  confirmBody: string;
  confirmLabel: string;
  busyLabel: string;
}

export function stopAffordance(session: SessionInfo): StopAffordance {
  if (session.transport === 'terminal' && session.adopted) {
    return {
      ariaLabel: `Detach from ${session.title}`,
      tooltip: 'Detach from tmux session',
      confirmTitle: 'Detach from tmux session?',
      confirmBody: 'The terminal client will detach. Your tmux session will remain running.',
      confirmLabel: 'Detach',
      busyLabel: 'Detaching…',
    };
  }
  if (session.transport === 'terminal') {
    return {
      ariaLabel: `Terminate ${session.title}`,
      tooltip: 'Terminate session',
      confirmTitle: 'Terminate this session?',
      confirmBody: 'The running process will be stopped.',
      confirmLabel: 'Terminate',
      busyLabel: 'Stopping…',
    };
  }
  return {
    ariaLabel: `Stop ${session.title}`,
    tooltip: 'Stop agent',
    confirmTitle: 'Stop this agent?',
    confirmBody: `${session.title} will be stopped.`,
    confirmLabel: 'Stop',
    busyLabel: 'Stopping…',
  };
}

// ---- PA-182: Project context, status dots, Pocket Agents, and Kanban board ----

export const POCKET_AGENTS_GROUP_KEY = 'pocket-agents';

export interface FleetProjectContext {
  /** Top-level project name (or folder basename fallback). */
  projectName: string;
  /** Stable group key (top-level project cwd, or session cwd fallback). */
  projectKey: string;
  /** Linked git worktree directory name when running inside a folded worktree, else null. */
  worktreeName: string | null;
  /** Current git branch name of this checkout or worktree, or null. */
  gitBranch: string | null;
}

export interface FleetSessionProvenance {
  cronJobId: string | null;
  webhookId: string | null;
  plannerChatId: string | null;
  mcpClient: string | null;
}

export interface FleetQueuedItem {
  item: QueuedRunSummary;
  cwd: string;
  project: FleetProjectContext;
}

/**
 * Indexes every project and folded worktree by its canonical `cwd` so cards
 * show the exact same parent project name, worktree name, and git branch as
 * the project tree without re-guessing paths on the client.
 */
export function buildProjectContextMap(
  projects: readonly ProjectInfo[],
): Map<string, FleetProjectContext> {
  const map = new Map<string, FleetProjectContext>();
  for (const project of projects) {
    map.set(project.cwd, {
      projectName: project.name,
      projectKey: project.cwd,
      worktreeName: null,
      gitBranch: project.gitBranch,
    });
    for (const worktree of project.worktrees) {
      map.set(worktree.cwd, {
        projectName: project.name,
        projectKey: project.cwd,
        worktreeName: worktree.name,
        gitBranch: worktree.gitBranch,
      });
    }
  }
  return map;
}

/**
 * Extracts chat provenance (cron / webhook / subagent / MCP) for live sessions
 * from the `/api/projects` snapshot so cards can render the same provenance
 * badges as the project tree.
 */
export function buildSessionProvenanceMap(
  projects: readonly ProjectInfo[],
): Map<string, FleetSessionProvenance> {
  const map = new Map<string, FleetSessionProvenance>();
  const collect = (p: ProjectInfo): void => {
    for (const chat of [...p.chats, ...(p.subagents ?? [])]) {
      if (!chat.sessionId) continue;
      map.set(chat.sessionId, {
        cronJobId: chat.cronJobId,
        webhookId: chat.webhookId,
        plannerChatId: chat.plannerChatId,
        mcpClient: chat.mcpClient ?? null,
      });
    }
    for (const w of p.worktrees) collect(w);
  };
  for (const p of projects) collect(p);
  return map;
}

/** Collects every queued run across all projects and their folded worktrees. */
export function extractFleetQueuedRuns(projects: readonly ProjectInfo[]): FleetQueuedItem[] {
  const out: FleetQueuedItem[] = [];
  for (const project of projects) {
    const projectCtx: FleetProjectContext = {
      projectName: project.name,
      projectKey: project.cwd,
      worktreeName: null,
      gitBranch: project.gitBranch,
    };
    for (const item of project.queued ?? []) {
      out.push({ item, cwd: project.cwd, project: projectCtx });
    }
    for (const worktree of project.worktrees) {
      const worktreeCtx: FleetProjectContext = {
        projectName: project.name,
        projectKey: project.cwd,
        worktreeName: worktree.name,
        gitBranch: worktree.gitBranch,
      };
      for (const item of worktree.queued ?? []) {
        out.push({ item, cwd: worktree.cwd, project: worktreeCtx });
      }
    }
  }
  return out.sort((a, b) => a.item.position - b.item.position || a.item.queuedAt - b.item.queuedAt);
}

/** Fallback project context when a session's cwd is absent from `/api/projects`. */
export function resolveProjectContext(
  session: SessionInfo,
  map: ReadonlyMap<string, FleetProjectContext>,
): FleetProjectContext {
  const hit = map.get(session.cwd);
  if (hit) return hit;
  const raw = (session.workspaceLabel || session.cwd).replace(/\/+$/, '');
  const parts = raw.split('/').filter(Boolean);
  const projectName = parts.at(-1) ?? (raw || 'Workspace');
  return {
    projectName,
    projectKey: session.cwd,
    worktreeName: null,
    gitBranch: null,
  };
}

/**
 * PA-182: computes the PA-165 four-state dot for a live `SessionInfo`,
 * accepting an optional live `awaitingApprovalOverride` from the card's WS
 * event stream so approval prompts flip to yellow immediately without waiting
 * for the next HTTP poll.
 */
export function sessionFleetDotState(
  session: SessionInfo,
  awaitingApprovalOverride?: boolean,
): ChatDotState {
  const awaitingApproval = (session.pendingApprovalsCount ?? 0) > 0 || awaitingApprovalOverride === true;
  const busySince =
    session.busySince ?? (session.busy ? (session.startedAt ?? session.createdAt) : null);
  return (
    chatDotState({
      live: !isTerminalStatus(session.status),
      busySince,
      awaitingApproval,
      unread: session.unread,
    }) ?? 'idle'
  );
}

/**
 * PA-182: Pocket Agent chats eligible for the Agents board. Unlike coding
 * sessions, Pocket Agent chats have no persistent process — historical chats
 * live in SQLite forever — so only chats with an active attention state
 * (`approval`, `running`, or `unread`) appear on the board.
 */
export function activeFleetPlannerChats(chats: readonly PlannerChat[]): PlannerChat[] {
  return chats
    .filter((chat) => plannerChatDotState(chat) !== null)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export type FleetKanbanColumnKey = 'pending' | 'in_progress' | 'idle';

export type FleetKanbanItem =
  | {
      kind: 'session';
      id: string;
      session: SessionInfo;
      dotState: ChatDotState;
      project: FleetProjectContext;
      provenance: FleetSessionProvenance | null;
      groupKey: string;
      groupLabel: string;
      groupIcon: IconName;
      sortPriority: number;
      sortTime: number;
    }
  | {
      kind: 'planner';
      id: string;
      chat: PlannerChat;
      dotState: ChatDotState;
      groupKey: string;
      groupLabel: string;
      groupIcon: IconName;
      sortPriority: number;
      sortTime: number;
    }
  | {
      kind: 'queued';
      id: string;
      queued: FleetQueuedItem;
      groupKey: string;
      groupLabel: string;
      groupIcon: IconName;
      sortPriority: number;
      sortTime: number;
    };

export interface FleetProjectSubGroup {
  key: string;
  label: string;
  icon: IconName;
  items: FleetKanbanItem[];
}

export interface FleetKanbanColumn {
  key: FleetKanbanColumnKey;
  title: string;
  hint: string;
  items: FleetKanbanItem[];
  subGroups: FleetProjectSubGroup[];
}

export interface FleetTerminalItem {
  session: SessionInfo;
  dotState: ChatDotState;
  project: FleetProjectContext;
  provenance: FleetSessionProvenance | null;
}

export interface FleetProjectFilterOption {
  key: string;
  label: string;
  count: number;
}

export interface FleetKanbanBoard {
  columns: FleetKanbanColumn[];
  terminals: FleetTerminalItem[];
  projectOptions: FleetProjectFilterOption[];
  totalVisibleCards: number;
  summary: string;
}

const COLUMN_META: Record<FleetKanbanColumnKey, { title: string; hint: string }> = {
  pending: {
    title: 'Pending',
    hint: 'Waiting for approval or queued for a directory',
  },
  in_progress: {
    title: 'In Progress',
    hint: 'Actively running turns',
  },
  idle: {
    title: 'Idle / Ready',
    hint: 'Finished unread turns and live idle agents',
  },
};

function compareKanbanItems(a: FleetKanbanItem, b: FleetKanbanItem): number {
  if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
  // Queued items sort FIFO (lowest queue position / earliest queuedAt first);
  // everything else sorts most recent first.
  if (a.kind === 'queued' && b.kind === 'queued') {
    return (
      a.queued.item.position - b.queued.item.position ||
      a.queued.item.queuedAt - b.queued.item.queuedAt
    );
  }
  return b.sortTime - a.sortTime;
}

function buildSubGroups(items: readonly FleetKanbanItem[]): FleetProjectSubGroup[] {
  const sorted = [...items].sort(compareKanbanItems);
  const byKey = new Map<string, FleetProjectSubGroup>();
  for (const item of sorted) {
    let group = byKey.get(item.groupKey);
    if (!group) {
      group = {
        key: item.groupKey,
        label: item.groupLabel,
        icon: item.groupIcon,
        items: [],
      };
      byKey.set(item.groupKey, group);
    }
    group.items.push(item);
  }
  // Because `sorted` is already in priority + recency order, Map insertion
  // order naturally puts the group containing the highest-priority / newest
  // item first.
  return [...byKey.values()];
}

export interface BuildFleetKanbanInput {
  sessions: readonly SessionInfo[];
  plannerChats: readonly PlannerChat[];
  projects: readonly ProjectInfo[];
  awaitingApprovalOverrides?: ReadonlyMap<string, boolean>;
  plannerAwaitingApprovalOverrides?: ReadonlyMap<string, boolean>;
  hideIdle?: boolean;
  /** `null` or `'all'` shows every project; otherwise matches `groupKey`. */
  projectFilter?: string | null;
}

/**
 * Builds the PA-182 Kanban board (3 columns with compact project sub-groups),
 * the separate raw terminal section, project filter options, and header summary.
 */
export function buildFleetKanban(input: BuildFleetKanbanInput): FleetKanbanBoard {
  const {
    sessions,
    plannerChats,
    projects,
    awaitingApprovalOverrides,
    plannerAwaitingApprovalOverrides,
    hideIdle = false,
    projectFilter = null,
  } = input;

  const projectMap = buildProjectContextMap(projects);
  const provenanceMap = buildSessionProvenanceMap(projects);
  const queuedRuns = extractFleetQueuedRuns(projects);

  const allKanbanItems: Array<{ column: FleetKanbanColumnKey; item: FleetKanbanItem }> = [];
  const allTerminals: FleetTerminalItem[] = [];

  for (const session of sessions) {
    const project = resolveProjectContext(session, projectMap);
    const provenance = provenanceMap.get(session.id) ?? null;
    const dotState = sessionFleetDotState(session, awaitingApprovalOverrides?.get(session.id));

    if (session.transport === 'terminal') {
      allTerminals.push({ session, dotState, project, provenance });
      continue;
    }

    const baseTime =
      session.busySince ??
      session.lastTurnEndedAt ??
      session.lastActivityAt ??
      session.startedAt ??
      session.createdAt;

    let column: FleetKanbanColumnKey;
    let sortPriority: number;
    if (dotState === 'approval') {
      column = 'pending';
      sortPriority = 0;
    } else if (dotState === 'running') {
      column = 'in_progress';
      sortPriority = 0;
    } else if (dotState === 'unread') {
      column = 'idle';
      sortPriority = 0;
    } else {
      column = 'idle';
      sortPriority = 1;
    }

    allKanbanItems.push({
      column,
      item: {
        kind: 'session',
        id: `session:${session.id}`,
        session,
        dotState,
        project,
        provenance,
        groupKey: project.projectKey,
        groupLabel: project.projectName,
        groupIcon: 'folder',
        sortPriority,
        sortTime: baseTime,
      },
    });
  }

  for (const chat of activeFleetPlannerChats(plannerChats)) {
    const liveApproval = plannerAwaitingApprovalOverrides?.get(chat.id);
    const effectiveDot =
      plannerChatDotState({
        busy: chat.busy,
        awaitingApproval: chat.awaitingApproval || liveApproval === true,
        unread: chat.unread,
      }) ?? 'unread';

    let column: FleetKanbanColumnKey;
    if (effectiveDot === 'approval') {
      column = 'pending';
    } else if (effectiveDot === 'running') {
      column = 'in_progress';
    } else {
      column = 'idle';
    }

    allKanbanItems.push({
      column,
      item: {
        kind: 'planner',
        id: `planner:${chat.id}`,
        chat,
        dotState: effectiveDot,
        groupKey: POCKET_AGENTS_GROUP_KEY,
        groupLabel: 'Pocket Agents',
        groupIcon: 'agent-generic',
        sortPriority: 0,
        sortTime: chat.lastActivityAt,
      },
    });
  }

  for (const queued of queuedRuns) {
    allKanbanItems.push({
      column: 'pending',
      item: {
        kind: 'queued',
        id: `queued:${queued.item.id}`,
        queued,
        groupKey: queued.project.projectKey,
        groupLabel: queued.project.projectName,
        groupIcon: 'folder',
        sortPriority: 1,
        sortTime: queued.item.queuedAt,
      },
    });
  }

  // Build project filter options before applying `projectFilter` so switching
  // projects keeps all other options selectable in the dropdown.
  const optionCounts = new Map<string, FleetProjectFilterOption>();
  const addOption = (key: string, label: string): void => {
    const existing = optionCounts.get(key);
    if (existing) existing.count += 1;
    else optionCounts.set(key, { key, label, count: 1 });
  };
  for (const entry of allKanbanItems) {
    if (hideIdle && entry.item.kind === 'session' && entry.item.dotState === 'idle') continue;
    addOption(entry.item.groupKey, entry.item.groupLabel);
  }
  for (const term of allTerminals) {
    addOption(term.project.projectKey, term.project.projectName);
  }
  const projectOptions = [...optionCounts.values()].sort((a, b) => {
    if (a.key === POCKET_AGENTS_GROUP_KEY) return 1;
    if (b.key === POCKET_AGENTS_GROUP_KEY) return -1;
    return a.label.localeCompare(b.label);
  });

  const activeFilter = projectFilter && projectFilter !== 'all' ? projectFilter : null;

  const buckets: Record<FleetKanbanColumnKey, FleetKanbanItem[]> = {
    pending: [],
    in_progress: [],
    idle: [],
  };

  let pendingCount = 0;
  let runningCount = 0;
  let unreadCount = 0;
  let idleCount = 0;

  for (const entry of allKanbanItems) {
    if (hideIdle && entry.item.kind === 'session' && entry.item.dotState === 'idle') continue;
    if (activeFilter && entry.item.groupKey !== activeFilter) continue;
    buckets[entry.column].push(entry.item);
    if (entry.column === 'pending') pendingCount += 1;
    else if (entry.column === 'in_progress') runningCount += 1;
    else if (entry.item.kind !== 'queued' && entry.item.dotState === 'unread') unreadCount += 1;
    else idleCount += 1;
  }

  const terminals = activeFilter
    ? allTerminals.filter((t) => t.project.projectKey === activeFilter)
    : allTerminals;

  const columnKeys: FleetKanbanColumnKey[] = ['pending', 'in_progress', 'idle'];
  const columns: FleetKanbanColumn[] = columnKeys.map((key) => {
    const sorted = [...buckets[key]].sort(compareKanbanItems);
    return {
      key,
      title: COLUMN_META[key].title,
      hint: COLUMN_META[key].hint,
      items: sorted,
      subGroups: buildSubGroups(sorted),
    };
  });

  const summaryParts: string[] = [];
  if (pendingCount > 0) summaryParts.push(`${pendingCount} pending`);
  if (runningCount > 0) summaryParts.push(`${runningCount} running`);
  if (unreadCount > 0) summaryParts.push(`${unreadCount} unread`);
  if (idleCount > 0) summaryParts.push(`${idleCount} idle`);
  if (terminals.length > 0) {
    summaryParts.push(`${terminals.length} terminal${terminals.length === 1 ? '' : 's'}`);
  }

  const totalVisibleCards = pendingCount + runningCount + unreadCount + idleCount + terminals.length;
  const summary = summaryParts.length === 0 ? 'Nothing active' : summaryParts.join(' · ');

  return {
    columns,
    terminals,
    projectOptions,
    totalVisibleCards,
    summary,
  };
}

/** Compact elapsed duration for a running turn (`<1m`, `4m`, `1h 12m`, `2d`). */
export function formatElapsed(sinceMs: number | null | undefined, now = Date.now()): string | null {
  if (sinceMs == null) return null;
  const delta = Math.max(0, now - sinceMs);
  if (delta < 60_000) return '<1m';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Compact relative timestamp (`just now`, `3m ago`, `2h ago`, `1d ago`). */
export function formatShortRelative(
  timestamp: number | null | undefined,
  now = Date.now(),
): string | null {
  if (timestamp == null) return null;
  const delta = Math.max(0, now - timestamp);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}
