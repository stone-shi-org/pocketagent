import type { SessionInfo } from '@pocketagent/protocol';
import type { IconName } from '../components/Icon.js';

/**
 * Splits the fleet view's live sessions into the two kinds of thing it can
 * show. Pure, and separate from `AgentsFleetPage` for the same reason
 * `fleet-preview.ts` is separate from `AgentCard`: the interesting part is
 * the rule, and the rule is worth a test.
 *
 * **The split is by `transport`, not by `backend`.** A user asks for this in
 * terms of "agents vs tmux sessions" (PA-22), but tmux is the wrong
 * discriminator: a `terminal` session may run on the `direct` backend and is
 * still a raw PTY someone types into, while a `structured` session is an
 * agent whose events we understand regardless of what owns its process. What
 * genuinely differs between the two groups is everything downstream —
 * `AgentCard` reads ANSI bytes for one and normalized `AgentEvent`s for the
 * other, the busy dot means "classifier guessed `working`" versus "mid-turn",
 * and only a structured card can ever show sub-agents. So the honest grouping
 * is the transport, and the tmux-ness of a terminal session is surfaced as a
 * per-card tag below instead of as the grouping itself.
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
  // "Agent sessions", not "Agents": the page's own h1 already says the
  // latter, and two identical headings 40px apart read as a rendering bug.
  // Parallel wording with the group below is also the ticket's own phrasing.
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

/**
 * Groups in fixed order, agents first. Empty groups are dropped rather than
 * rendered as an empty state each: two "nothing here" panels on a quiet
 * machine is worse than the page's own single empty state, and a group
 * appearing the moment its first session starts is the same
 * self-hiding-when-empty behaviour `ProjectInfo.queued`'s tree group has.
 */
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

/**
 * The header's one-line count. Says the split rather than a bare total, so
 * "3 running" cannot hide that all three are terminals — which is precisely
 * the conflation PA-22 asked to undo. Only non-empty kinds are named, so a
 * machine running two agents reads `2 agents`, not `2 agents · 0 terminals`.
 */
export function fleetSummary(sessions: readonly SessionInfo[]): string {
  const parts = groupFleet(sessions).map((g) => {
    const n = g.sessions.length;
    const noun = g.key === 'agents' ? 'agent' : 'terminal';
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
  });
  return parts.length === 0 ? 'Nothing running' : parts.join(' · ');
}

/**
 * A short tag for a *terminal* card's meta line, naming what is actually
 * holding the PTY — the thing the group heading deliberately does not claim.
 * `adopted` wins over `tmux` because it is the stronger fact: the pane
 * belongs to someone else and this session must not even resize it (see the
 * "adopted panes are not resized" invariant), which matters more than which
 * backend spawned the client. Null for a structured session, whose process is
 * the SDK's and has no terminal to describe.
 */
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

/**
 * The wording for a card's stop control, which is not one sentence for all
 * three kinds of card. Two of them were wrong before PA-22 grouped the view:
 * a terminal session is not "an agent", and stopping an *adopted* one only
 * detaches — the pane is someone else's and killing our tmux client must
 * never read as terminating their work (the "killing it must only ever
 * detach" half of the adoption design). Deliberately the same three strings
 * `TerminalPage`'s own confirm dialog already uses, so the card and the full
 * view cannot describe the same button differently.
 */
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
