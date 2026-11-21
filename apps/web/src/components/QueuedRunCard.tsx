import { agentAccentClass, agentIconName } from '../agent/agent-icon.js';
import { formatShortRelative, type FleetQueuedItem } from '../agent/fleet-groups.js';
import { Icon } from './Icon.js';

interface Props {
  queued: FleetQueuedItem;
  onOpenSession: (sessionId: string) => void;
  onOpenWebhook?: (webhookId: string) => void;
}

/**
 * PA-182: A queued webhook delivery or follow-up prompt waiting in `RunQueue`
 * for a working tree to free up, rendered in the Kanban board's Pending lane.
 */
export function QueuedRunCard({ queued, onOpenSession, onOpenWebhook }: Props): JSX.Element {
  const { item, project } = queued;
  const agentId = item.agent ?? '';
  const iconName = agentId ? agentIconName(agentId) : item.kind === 'webhook' ? 'webhook' : 'queue';
  const accent = agentId ? agentAccentClass(agentId) : '';
  const showWorktree = project.worktreeName !== null && project.worktreeName !== project.gitBranch;
  const queuedAgo = formatShortRelative(item.queuedAt);

  const canOpen =
    (item.kind === 'prompt' && item.sessionId !== null) ||
    (item.kind === 'webhook' && item.webhookId !== null && onOpenWebhook !== undefined);

  const handleOpen = (): void => {
    if (item.kind === 'prompt' && item.sessionId) {
      onOpenSession(item.sessionId);
    } else if (item.kind === 'webhook' && item.webhookId) {
      onOpenWebhook?.(item.webhookId);
    }
  };

  return (
    <div className="agent-card agent-card--queued">
      <button
        type="button"
        className="agent-card-open agent-card-open--no-corner"
        onClick={handleOpen}
        disabled={!canOpen}
      >
        <div className="agent-card-head">
          <span
            className={`agent-mascot ${accent}`}
            title={item.agentDisplayName || 'Queued run'}
            aria-label={item.agentDisplayName || 'Queued run'}
          >
            <Icon name={iconName} size={20} />
          </span>
          <span className="agent-card-title">
            <span className="title" title={item.title}>
              {item.title}
            </span>
            <span className="meta">
              <span className="agent-card-project">{project.projectName}</span>
              {showWorktree && (
                <span className="agent-card-worktree" title={`Worktree: ${project.worktreeName}`}>
                  / {project.worktreeName}
                </span>
              )}
              {project.gitBranch && (
                <span className="agent-card-branch" title={`Branch: ${project.gitBranch}`}>
                  <Icon name="branch" size={11} />
                  <span>{project.gitBranch}</span>
                </span>
              )}
            </span>
          </span>
          <span className="agent-card-status">
            <span
              className="agent-chip agent-chip--queued"
              title={`Position #${item.position} in queue for this working tree`}
            >
              <Icon name="queue" size={11} />
              <span>#{item.position}</span>
            </span>
          </span>
        </div>

        <div className="agent-card-footer">
          <div className="agent-card-badges">
            <span className="agent-chip" title="Waiting for working tree to free up">
              <Icon name={item.kind === 'webhook' ? 'webhook' : 'branch'} size={11} />
              <span>{item.kind === 'webhook' ? item.webhookName ?? 'Webhook' : 'Queued prompt'}</span>
            </span>
            {item.skipPermissionsEnabled && (
              <span className="agent-chip agent-chip--warn" title="Approvals bypassed for this run">
                <Icon name="shield" size={11} />
                <span>Auto-approve</span>
              </span>
            )}
          </div>
          {queuedAgo && <span className="agent-card-time">queued {queuedAgo}</span>}
        </div>
      </button>
    </div>
  );
}
