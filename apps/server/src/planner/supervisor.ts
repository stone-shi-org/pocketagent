import type { AgentEvent } from '@pocketagent/protocol';
import { isTerminalStatus } from '@pocketagent/protocol';
import type { SessionManager } from '../sessions/manager.js';
import { readSessionHistory, type SessionHistoryDeps } from '../sessions/history.js';
import { lastMessageSummary, type SubagentChatStatus } from './tools.js';

export interface MailboxMessage {
  subagentId: string;
  kind: 'coding_agent' | 'pocket_agent';
  status: string;
  summary: string;
}

export interface SubagentSupervisorDeps {
  sessions: SessionManager;
  historyDeps: SessionHistoryDeps;
  getPlannerChatHistory: (chatId: string) => Promise<AgentEvent[]>;
  observePlannerChat: (chatId: string, listener: (event: AgentEvent) => void) => () => void;
  enqueueMailbox: (chatId: string, message: MailboxMessage) => void;
  logger?: { warn: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void };
}

export interface SubagentOutcome {
  status: 'running' | 'paused_for_approval' | 'done' | 'error' | 'exited' | 'idle' | 'gone';
  summary: string;
  pendingApproval?: boolean;
}

/**
 * PA-76: Coordinates subagent completion and approval notifications.
 *
 * One component with two adapters (coding agent and pocket agent) producing
 * a uniform SubagentOutcome { status, summary, pendingApproval }.
 * Results are cached so get_subagent_status does not re-read transcripts on every poll,
 * and completion events are routed to the parent chat's turn mailbox.
 */
export class SubagentSupervisor {
  private readonly outcomes = new Map<string, SubagentOutcome>();
  private readonly codingParents = new Map<string, string>();
  private readonly pocketParents = new Map<string, string>();
  private readonly disposers = new Map<string, () => void>();
  private readonly unsubTurnComplete: () => void;
  private readonly unsubPermissionChange: () => void;

  constructor(private readonly deps: SubagentSupervisorDeps) {
    this.unsubTurnComplete = deps.sessions.onSessionTurnComplete((sessionId) => {
      void this.onCodingSessionTurnComplete(sessionId);
    });
    this.unsubPermissionChange = deps.sessions.onSessionPermissionChange((sessionId, pendingCount) => {
      this.onCodingSessionPermissionChange(sessionId, pendingCount);
    });
  }

  dispose(): void {
    this.unsubTurnComplete();
    this.unsubPermissionChange();
    for (const dispose of this.disposers.values()) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    this.disposers.clear();
  }

  getOutcome(kind: 'coding_agent' | 'pocket_agent', id: string): SubagentChatStatus | null {
    const outcome = this.outcomes.get(id);
    if (!outcome) return null;
    return {
      status: outcome.status,
      summary: outcome.summary,
    };
  }

  trackCodingSubagent(sessionId: string, parentChatId: string): void {
    this.codingParents.set(sessionId, parentChatId);
    this.outcomes.set(sessionId, {
      status: 'running',
      summary: 'Still working on its assigned task.',
      pendingApproval: false,
    });

    const session = this.deps.sessions.get(sessionId);
    if (session && session.transport === 'structured') {
      const onEvent = (_seq: number, event: AgentEvent) => {
        if (event.kind === 'permission_request') {
          this.onCodingSessionPermissionChange(sessionId, 1);
        }
      };
      session.on('event', onEvent);
      this.disposers.set(`coding:${sessionId}`, () => {
        session.off('event', onEvent);
      });
    }
  }

  trackPocketSubagent(childChatId: string, parentChatId: string): void {
    this.pocketParents.set(childChatId, parentChatId);
    this.outcomes.set(childChatId, {
      status: 'running',
      summary: '(still working on its assigned task)',
      pendingApproval: false,
    });

    const unsubscribe = this.deps.observePlannerChat(childChatId, (event) => {
      if (event.kind === 'permission_request') {
        this.outcomes.set(childChatId, {
          status: 'paused_for_approval',
          summary: `Waiting on a human to approve tool "${event.toolName}" — open this chat in the Pocket Agent UI to answer.`,
          pendingApproval: true,
        });
      } else if (event.kind === 'permission_resolved') {
        const existing = this.outcomes.get(childChatId);
        if (existing?.status === 'paused_for_approval') {
          this.outcomes.set(childChatId, {
            status: 'running',
            summary: '(still working on its assigned task)',
            pendingApproval: false,
          });
        }
      } else if (event.kind === 'turn_complete') {
        this.disposers.get(`pocket:${childChatId}`)?.();
        this.disposers.delete(`pocket:${childChatId}`);
        void this.handlePocketTurnComplete(childChatId, parentChatId, event.isError);
      }
    });

    this.disposers.set(`pocket:${childChatId}`, unsubscribe);
  }

  private async handlePocketTurnComplete(childChatId: string, parentChatId: string, isError: boolean): Promise<void> {
    try {
      const events = await this.deps.getPlannerChatHistory(childChatId);
      const summary = lastMessageSummary(events);
      const status: SubagentChatStatus['status'] = isError ? 'error' : 'done';
      this.outcomes.set(childChatId, { status, summary, pendingApproval: false });
      this.deps.enqueueMailbox(parentChatId, {
        subagentId: childChatId,
        kind: 'pocket_agent',
        status,
        summary,
      });
    } catch (err) {
      this.deps.logger?.warn({ err, childChatId, parentChatId }, 'failed to handle pocket subagent turn complete');
    }
  }

  private async onCodingSessionTurnComplete(sessionId: string): Promise<void> {
    const parentChatId = this.codingParents.get(sessionId) ?? this.deps.sessions.find(sessionId)?.plannerChatId;
    if (!parentChatId) return;

    this.disposers.get(`coding:${sessionId}`)?.();
    this.disposers.delete(`coding:${sessionId}`);

    try {
      const summary = await this.readCodingSubagentSummary(sessionId);
      const info = this.deps.sessions.find(sessionId);
      const status: SubagentChatStatus['status'] = info && isTerminalStatus(info.status) ? 'exited' : 'idle';
      this.outcomes.set(sessionId, { status, summary, pendingApproval: false });
      this.deps.enqueueMailbox(parentChatId, {
        subagentId: sessionId,
        kind: 'coding_agent',
        status,
        summary,
      });
    } catch (err) {
      this.deps.logger?.warn({ err, sessionId, parentChatId }, 'failed to handle coding subagent turn complete');
    }
  }

  private onCodingSessionPermissionChange(sessionId: string, pendingCount: number): void {
    const parentChatId = this.codingParents.get(sessionId) ?? this.deps.sessions.find(sessionId)?.plannerChatId;
    if (!parentChatId) return;

    if (pendingCount > 0) {
      this.outcomes.set(sessionId, {
        status: 'paused_for_approval',
        summary: `Waiting on a human to approve ${pendingCount} tool call(s) — open this session in the Pocket Agent UI to answer.`,
        pendingApproval: true,
      });
    } else {
      const existing = this.outcomes.get(sessionId);
      if (existing?.status === 'paused_for_approval') {
        this.outcomes.set(sessionId, {
          status: 'running',
          summary: 'Still working on its assigned task.',
          pendingApproval: false,
        });
      }
    }
  }

  private async readCodingSubagentSummary(sessionId: string): Promise<string> {
    const live = this.deps.sessions.get(sessionId);
    if (live) {
      if (live.transport === 'terminal') {
        return '(terminal output)';
      }
      const buffered = live.buffer.replayAfter(0).events.map((e) => e.event);
      const { events: priorEvents } = await readSessionHistory(this.deps.historyDeps, sessionId);
      const allEvents = [...priorEvents, ...buffered];
      return lastMessageSummary(allEvents);
    }
    const { events } = await readSessionHistory(this.deps.historyDeps, sessionId);
    return lastMessageSummary(events);
  }
}
