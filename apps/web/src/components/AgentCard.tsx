import { useCallback, useEffect, useState } from 'react';
import { isCustomClaudeProviderId, type SessionInfo } from '@pocketagent/protocol';
import { TerminalConnection } from '../api/ws-client.js';
import { agentAccentClass, agentIconName } from '../agent/agent-icon.js';
import { lastPlainLines } from '../agent/strip-ansi.js';
import {
  applyFleetEvent,
  applyFleetEvents,
  emptyFleetPreview,
  type FleetPreviewState,
} from '../agent/fleet-preview.js';
import {
  formatElapsed,
  formatShortRelative,
  sessionFleetDotState,
  stopAffordance,
  terminalKindTag,
  type FleetProjectContext,
  type FleetSessionProvenance,
} from '../agent/fleet-groups.js';
import { ChatStatusDot } from './ChatStatusDot.js';
import { Icon } from './Icon.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { useHostApi, useHostEndpoint } from '../hosts/HostContext.js';

/** Only the last few KB matter for a five-line preview; no reason to grow forever. */
const RAW_TAIL_CHARS = 4000;
const PREVIEW_LINES = 5;

interface Props {
  session: SessionInfo;
  /** PA-182: Project name, linked worktree, and git branch resolved from `/api/projects`. */
  project?: FleetProjectContext;
  /** PA-182: Optional provenance (cron, webhook, subagent, MCP) from `/api/projects`. */
  provenance?: FleetSessionProvenance | null;
  onOpen: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Called after a successful stop, so the fleet page can drop the card
   * immediately instead of waiting out its own poll interval.
   */
  onStopped?: (sessionId: string) => void;
  /**
   * PA-182: notifies the Kanban board when the card's live WS stream observes
   * `permission_request` / `permission_resolved`, so the card moves into or
   * out of Pending immediately without waiting for the next HTTP poll.
   */
  onAwaitingApprovalChange?: (sessionId: string, awaiting: boolean) => void;
  /**
   * False when the parent Agents tab is hidden in the background — tears down
   * the peek WebSocket until the tab becomes visible again. Defaults to true.
   */
  active?: boolean;
}

/**
 * One coding-agent or terminal card on the "Agents" view.
 *
 * Owns its own background WebSocket attach (`peek: true` so it never inflates
 * a session's "N viewer(s)" count elsewhere).
 */
export function AgentCard({
  session,
  project,
  provenance = null,
  onOpen,
  onApiError,
  onStopped,
  onAwaitingApprovalChange,
  active = true,
}: Props): JSX.Element {
  const api = useHostApi();
  const endpoint = useHostEndpoint();
  const [rawTail, setRawTail] = useState('');
  const [preview, setPreview] = useState<FleetPreviewState>(emptyFleetPreview);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Bumped on every incoming frame so the newest preview line's key changes,
  // replaying its flash animation.
  const [flashSeq, setFlashSeq] = useState(0);

  useEffect(() => {
    if (!active) return;
    setRawTail('');
    setPreview(emptyFleetPreview());
    setFlashSeq(0);

    const conn = new TerminalConnection({
      endpoint,
      handlers: {
        onReplay: (data) => {
          setRawTail((prev) => (prev + data).slice(-RAW_TAIL_CHARS));
          setFlashSeq((n) => n + 1);
        },
        onOutput: (data) => {
          setRawTail((prev) => (prev + data).slice(-RAW_TAIL_CHARS));
          setFlashSeq((n) => n + 1);
        },
        onAgentReplay: (events) => {
          setPreview((prev) => applyFleetEvents(prev, events));
          setFlashSeq((n) => n + 1);
        },
        onAgentEvent: (event) => {
          setPreview((prev) => applyFleetEvent(prev, event));
          setFlashSeq((n) => n + 1);
        },
      },
    });
    // No `cols`/`rows`: a peek attach never drives or resizes the terminal
    // (preserving the "adopted panes are not resized" invariant).
    conn.open(session.id, undefined, { peek: true });

    return () => conn.close();
  }, [active, endpoint, session.id]);

  useEffect(() => {
    onAwaitingApprovalChange?.(session.id, preview.awaitingApproval);
  }, [onAwaitingApprovalChange, preview.awaitingApproval, session.id]);

  const lines = session.transport === 'terminal' ? lastPlainLines(rawTail, PREVIEW_LINES) : preview.lines;
  const kindTag = terminalKindTag(session);
  const stopWords = stopAffordance(session);
  const dotState = sessionFleetDotState(session, preview.awaitingApproval);

  const projectName = project?.projectName ?? session.workspaceLabel;
  const worktreeName = project?.worktreeName ?? null;
  const gitBranch = project?.gitBranch ?? null;
  // Avoid duplicating the same label twice when a worktree folder name already
  // matches its branch name (e.g. `feature-ui` on branch `feature-ui`).
  const showWorktree = worktreeName !== null && worktreeName !== gitBranch;
  // Custom Claude providers share the Claude mascot icon, so surface a short
  // tag in the subtitle to distinguish them without needing to hover.
  const showProviderTag =
    isCustomClaudeProviderId(session.agent) || agentIconName(session.agent) === 'agent-generic';

  const pendingApprovals = Math.max(
    session.pendingApprovalsCount ?? 0,
    preview.awaitingApproval ? 1 : 0,
  );
  const isSubagent = Boolean(session.plannerChatId || provenance?.plannerChatId);
  const isCron = Boolean(provenance?.cronJobId);
  const isWebhook = Boolean(provenance?.webhookId);
  const mcpClient = provenance?.mcpClient ?? null;

  const timingLabel =
    dotState === 'running'
      ? (() => {
          const elapsed = formatElapsed(session.busySince ?? session.startedAt ?? session.createdAt);
          return elapsed ? `running ${elapsed}` : null;
        })()
      : formatShortRelative(
          session.lastTurnEndedAt ?? session.lastActivityAt ?? session.startedAt ?? session.createdAt,
        );

  const hasFooter =
    timingLabel !== null ||
    pendingApprovals > 0 ||
    session.skipPermissionsEnabled ||
    session.rateLimit !== null ||
    isCron ||
    isWebhook ||
    isSubagent ||
    mcpClient !== null;

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await api.deleteSession(session.id);
      onStopped?.(session.id);
    } catch (err) {
      onApiError(err);
    } finally {
      setStopping(false);
      setConfirmingStop(false);
    }
  }, [api, session.id, onApiError, onStopped]);

  const cardStateClass =
    dotState === 'approval'
      ? ' agent-card--approval'
      : dotState === 'unread'
        ? ' agent-card--unread'
        : '';

  return (
    <div className={`agent-card${cardStateClass}`}>
      <button type="button" className="agent-card-open" onClick={() => onOpen(session.id)}>
        <div className="agent-card-head">
          <span
            className={`agent-mascot ${agentAccentClass(session.agent)}`}
            title={session.agentDisplayName}
            aria-label={session.agentDisplayName}
          >
            <Icon name={agentIconName(session.agent)} size={20} />
          </span>
          <span className="agent-card-title">
            <span className="title" title={session.title}>
              {session.title}
            </span>
            <span className="meta" title={session.workspaceLabel}>
              {kindTag && <span className="agent-card-tag">{kindTag}</span>}
              {showProviderTag && (
                <span className="agent-card-tag" title={session.agentDisplayName}>
                  {session.agentDisplayName}
                </span>
              )}
              <span className="agent-card-project">{projectName}</span>
              {showWorktree && (
                <span className="agent-card-worktree" title={`Worktree: ${worktreeName}`}>
                  / {worktreeName}
                </span>
              )}
              {gitBranch && (
                <span className="agent-card-branch" title={`Branch: ${gitBranch}`}>
                  <Icon name="branch" size={11} />
                  <span>{gitBranch}</span>
                </span>
              )}
            </span>
          </span>
          <span className="agent-card-status">
            <ChatStatusDot state={dotState} />
          </span>
        </div>

        <div className="agent-output">
          {lines.map((line, i) => (
            <div
              key={i === lines.length - 1 ? `last-${flashSeq}` : i}
              className={i === lines.length - 1 ? 'agent-output-line agent-output-line--new' : 'agent-output-line'}
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

        {hasFooter && (
          <div className="agent-card-footer">
            <div className="agent-card-badges">
              {pendingApprovals > 0 && (
                <span className="agent-chip agent-chip--warn" title="Waiting for your approval">
                  <Icon name="shield" size={11} />
                  <span>
                    {pendingApprovals === 1 ? 'Needs approval' : `${pendingApprovals} approvals`}
                  </span>
                </span>
              )}
              {session.skipPermissionsEnabled && (
                <span
                  className="agent-chip agent-chip--warn"
                  title="Approvals bypassed for this session"
                >
                  <Icon name="shield" size={11} />
                  <span>Auto-approve</span>
                </span>
              )}
              {session.rateLimit && (
                <span
                  className="agent-chip agent-chip--danger"
                  title={
                    session.rateLimit.resetsAtLabel
                      ? `Rate limited until ${session.rateLimit.resetsAtLabel}`
                      : 'Rate limited'
                  }
                >
                  <Icon name="clock" size={11} />
                  <span>Rate limited</span>
                </span>
              )}
              {isCron && (
                <span className="agent-chip" title="Started by scheduled job">
                  <Icon name="clock" size={11} />
                  <span>Cron</span>
                </span>
              )}
              {isWebhook && (
                <span className="agent-chip" title="Started by webhook">
                  <Icon name="webhook" size={11} />
                  <span>Webhook</span>
                </span>
              )}
              {isSubagent && (
                <span className="agent-chip" title="Spawned by a Pocket Agent">
                  <Icon name="agents" size={11} />
                  <span>Subagent</span>
                </span>
              )}
              {mcpClient && (
                <span className="agent-chip" title={`Started over MCP (${mcpClient})`}>
                  <Icon name="mcp" size={11} />
                  <span>{mcpClient}</span>
                </span>
              )}
            </div>
            {timingLabel && <span className="agent-card-time">{timingLabel}</span>}
          </div>
        )}
      </button>

      <button
        type="button"
        className="agent-card-stop"
        onClick={() => setConfirmingStop(true)}
        aria-label={stopWords.ariaLabel}
        title={stopWords.tooltip}
      >
        <Icon name="close" size={14} />
      </button>

      {confirmingStop && (
        <ConfirmDialog
          title={stopWords.confirmTitle}
          body={stopWords.confirmBody}
          confirmLabel={stopping ? stopWords.busyLabel : stopWords.confirmLabel}
          busy={stopping}
          onConfirm={() => void stop()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}
