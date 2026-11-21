import { useCallback, useEffect, useState } from 'react';
import { plannerChatDotState, type PlannerChat } from '@pocketagent/protocol';
import {
  applyFleetEvent,
  applyFleetEvents,
  emptyFleetPreview,
  type FleetPreviewState,
} from '../agent/fleet-preview.js';
import { formatShortRelative } from '../agent/fleet-groups.js';
import { useHostApi } from '../hosts/HostContext.js';
import { ChatStatusDot } from './ChatStatusDot.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { Icon } from './Icon.js';

interface Props {
  chat: PlannerChat;
  onOpen: (chatId: string) => void;
  onApiError: (error: unknown) => void;
  onInterrupted?: (chatId: string) => void;
  onAwaitingApprovalChange?: (chatId: string, awaiting: boolean) => void;
}

/**
 * PA-182: One Pocket Agent chat card on the "Agents" Kanban board.
 *
 * Unlike a coding-agent `AgentCard` (which opens a WebSocket peek attach), a
 * Pocket Agent chat seeds its 5-line preview from `GET /api/planner/chats/:id/history`
 * and subscribes to `GET /api/planner/chats/:id/events` SSE while a turn is in
 * flight — reusing the exact same `applyFleetEvent` reducer.
 *
 * Safety: never offers a destructive delete button on the board; while a turn
 * is active, the corner button only interrupts the in-flight turn.
 */
export function PlannerAgentCard({
  chat,
  onOpen,
  onApiError,
  onInterrupted,
  onAwaitingApprovalChange,
}: Props): JSX.Element {
  const api = useHostApi();
  const [preview, setPreview] = useState<FleetPreviewState>(emptyFleetPreview);
  const [flashSeq, setFlashSeq] = useState(0);
  const [confirmingInterrupt, setConfirmingInterrupt] = useState(false);
  const [interrupting, setInterrupting] = useState(false);

  const isLive = Boolean(chat.busy || chat.awaitingApproval);

  useEffect(() => {
    let cancelled = false;
    setPreview(emptyFleetPreview());
    setFlashSeq(0);

    void api
      .plannerChatHistory(chat.id)
      .then(({ events }) => {
        if (cancelled) return;
        setPreview((prev) => applyFleetEvents(prev, events));
      })
      .catch(() => {
        /* best-effort preview: card header and status dot stay useful even if history fails */
      });

    return () => {
      cancelled = true;
    };
  }, [api, chat.id]);

  useEffect(() => {
    if (!isLive) return;
    const unsubscribe = api.subscribePlannerChatEvents(chat.id, (event) => {
      setPreview((prev) => applyFleetEvent(prev, event));
      setFlashSeq((n) => n + 1);
    });
    return unsubscribe;
  }, [api, chat.id, isLive]);

  useEffect(() => {
    onAwaitingApprovalChange?.(chat.id, preview.awaitingApproval);
  }, [chat.id, onAwaitingApprovalChange, preview.awaitingApproval]);

  const dotState =
    plannerChatDotState({
      busy: chat.busy,
      awaitingApproval: chat.awaitingApproval || preview.awaitingApproval,
      unread: chat.unread,
    }) ?? 'unread';

  const title = chat.title?.trim() || 'Untitled chat';
  const timingLabel = formatShortRelative(chat.lastActivityAt);
  const queuedCount = chat.queuedPrompts?.length ?? 0;

  const interrupt = useCallback(async () => {
    setInterrupting(true);
    try {
      await api.interruptPlannerChat(chat.id);
      onInterrupted?.(chat.id);
    } catch (err) {
      onApiError(err);
    } finally {
      setInterrupting(false);
      setConfirmingInterrupt(false);
    }
  }, [api, chat.id, onApiError, onInterrupted]);

  const cardStateClass =
    dotState === 'approval'
      ? ' agent-card--approval'
      : dotState === 'unread'
        ? ' agent-card--unread'
        : '';

  return (
    <div className={`agent-card${cardStateClass}`}>
      <button
        type="button"
        className={`agent-card-open${isLive ? '' : ' agent-card-open--no-corner'}`}
        onClick={() => onOpen(chat.id)}
      >
        <div className="agent-card-head">
          <span
            className="agent-mascot agent-mascot--pocket"
            title={`Pocket Agent: ${chat.workspaceName}`}
            aria-label={`Pocket Agent: ${chat.workspaceName}`}
          >
            <Icon name="brain" size={20} />
          </span>
          <span className="agent-card-title">
            <span className="title" title={title}>
              {title}
            </span>
            <span className="meta">
              <span className="agent-card-project">{chat.workspaceName}</span>
              {chat.docWorkspaceName && (
                <span className="agent-card-worktree" title={`Workspace: ${chat.docWorkspaceName}`}>
                  / {chat.docWorkspaceName}
                </span>
              )}
            </span>
          </span>
          <span className="agent-card-status">
            <ChatStatusDot state={dotState} />
          </span>
        </div>

        <div className="agent-output">
          {preview.lines.map((line, i) => (
            <div
              key={i === preview.lines.length - 1 ? `last-${flashSeq}` : i}
              className={
                i === preview.lines.length - 1
                  ? 'agent-output-line agent-output-line--new'
                  : 'agent-output-line'
              }
            >
              {line}
            </div>
          ))}
        </div>

        {preview.subagents.length > 0 && (
          <div className="agent-subagents">
            {preview.subagents.map((s) => (
              <div className="agent-subagent" key={s.toolUseId}>
                <span className="agent-subagent-dot" aria-hidden="true" />
                <span className="agent-subagent-label">{s.summary}</span>
              </div>
            ))}
          </div>
        )}

        <div className="agent-card-footer">
          <div className="agent-card-badges">
            {dotState === 'approval' && (
              <span className="agent-chip agent-chip--warn" title="Waiting for your approval">
                <Icon name="shield" size={11} />
                <span>Needs approval</span>
              </span>
            )}
            {chat.skipToolApprovalsEnabled && (
              <span
                className="agent-chip agent-chip--warn"
                title="Tool approvals bypassed for this chat"
              >
                <Icon name="shield" size={11} />
                <span>Auto-approve</span>
              </span>
            )}
            {queuedCount > 0 && (
              <span className="agent-chip" title={`${queuedCount} queued follow-up prompt(s)`}>
                <Icon name="queue" size={11} />
                <span>{queuedCount} queued</span>
              </span>
            )}
            {chat.cronJobId && (
              <span className="agent-chip" title="Started by scheduled job">
                <Icon name="clock" size={11} />
                <span>Cron</span>
              </span>
            )}
            {chat.parentChatId && (
              <span className="agent-chip" title="Subagent chat">
                <Icon name="agents" size={11} />
                <span>Subagent</span>
              </span>
            )}
            {chat.mcpClient && (
              <span className="agent-chip" title={`Started over MCP (${chat.mcpClient})`}>
                <Icon name="mcp" size={11} />
                <span>{chat.mcpClient}</span>
              </span>
            )}
          </div>
          {timingLabel && <span className="agent-card-time">{timingLabel}</span>}
        </div>
      </button>

      {isLive && (
        <button
          type="button"
          className="agent-card-stop"
          onClick={() => setConfirmingInterrupt(true)}
          aria-label={`Interrupt ${title}`}
          title="Interrupt current turn"
        >
          <Icon name="stop" size={14} />
        </button>
      )}

      {confirmingInterrupt && (
        <ConfirmDialog
          title="Interrupt this Pocket Agent turn?"
          body={`The active turn in "${title}" will be stopped. Chat history is preserved.`}
          confirmLabel={interrupting ? 'Interrupting…' : 'Interrupt'}
          busy={interrupting}
          onConfirm={() => void interrupt()}
          onCancel={() => setConfirmingInterrupt(false)}
        />
      )}
    </div>
  );
}
