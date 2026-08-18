import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { TerminalConnection } from '../api/ws-client.js';
import { api } from '../api/client.js';
import { agentAccentClass, agentIconName } from '../agent/agent-icon.js';
import { lastPlainLines } from '../agent/strip-ansi.js';
import { applyFleetEvent, applyFleetEvents, emptyFleetPreview, type FleetPreviewState } from '../agent/fleet-preview.js';
import { Icon } from './Icon.js';
import { ConfirmDialog } from './ConfirmDialog.js';

/** Only the last few KB matter for a five-line preview; no reason to grow forever. */
const RAW_TAIL_CHARS = 4000;
const PREVIEW_LINES = 5;

interface Props {
  session: SessionInfo;
  onOpen: (sessionId: string) => void;
  onApiError: (error: unknown) => void;
  /**
   * Called after a successful stop, so the fleet page can drop the card
   * immediately instead of waiting out its own poll interval.
   */
  onStopped?: (sessionId: string) => void;
}

/**
 * One card in the "Agents" fleet view.
 *
 * Owns its own background WebSocket attach — there is no bulk "tail for many
 * sessions" endpoint, so this is the only way to get live output per agent
 * without opening its full session view. `peek: true` keeps it from counting
 * as a real viewer (see `AttachMessage.peek`'s doc comment): a card nobody
 * asked to watch must not inflate a session's own "N viewer(s)" badge
 * elsewhere.
 */
export function AgentCard({ session, onOpen, onApiError, onStopped }: Props): JSX.Element {
  const [rawTail, setRawTail] = useState('');
  const [preview, setPreview] = useState<FleetPreviewState>(emptyFleetPreview);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  // Bumped on every incoming frame so the newest preview line's key changes,
  // which remounts that one DOM node and replays its flash animation. A
  // stable key would keep the same node and the CSS animation would never
  // restart on the second, third, ... line.
  const [flashSeq, setFlashSeq] = useState(0);

  useEffect(() => {
    setRawTail('');
    setPreview(emptyFleetPreview());
    setFlashSeq(0);

    const conn = new TerminalConnection({
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
    // No `cols`/`rows`: a peek attach never drives the terminal, so there is
    // nothing to size (see the "adopted panes are not resized" invariant —
    // same reasoning applies to a background viewer that isn't even that).
    conn.open(session.id, undefined, { peek: true });

    return () => conn.close();
    // Reconnects if the session identity changes; the poll in
    // `AgentsFleetPage` only ever remounts this component for a genuinely
    // different session (see its `key`), so this is not "every 4s".
  }, [session.id]);

  const lines = session.transport === 'terminal' ? lastPlainLines(rawTail, PREVIEW_LINES) : preview.lines;
  // `SessionInfo.busy` is coarse (mid-turn or not); a structured card's own
  // richer event stream corrects the one case that would otherwise mislead —
  // see `FleetPreviewState.awaitingApproval`'s doc comment.
  const busy = session.busy && !preview.awaitingApproval;

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
  }, [session.id, onApiError, onStopped]);

  return (
    <div className="agent-card">
      {/* The open action and the stop action can't both be the same
          `<button>` — a button can't nest another button — so the card is a
          plain div with an invisible full-size button for "open" and the
          stop control as a sibling laid over its corner, same "row plus
          overlaid remove control" split `ProjectList`'s `.chat-line` uses. */}
      <button type="button" className="agent-card-open" onClick={() => onOpen(session.id)}>
        <div className="agent-card-head">
          <span className={`agent-mascot ${agentAccentClass(session.agent)}`}>
            <Icon name={agentIconName(session.agent)} size={20} />
          </span>
          <span className="agent-card-title">
            <span className="title">{session.title}</span>
            <span className="meta">
              {session.agentDisplayName} · {session.workspaceLabel}
            </span>
          </span>
          <span
            className={`agent-dot ${busy ? 'agent-dot--busy' : 'agent-dot--idle'}`}
            aria-hidden="true"
            title={busy ? 'Running' : 'Idle'}
          />
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
      </button>

      <button
        type="button"
        className="agent-card-stop"
        onClick={() => setConfirmingStop(true)}
        aria-label={`Stop ${session.title}`}
        title="Stop agent"
      >
        <Icon name="close" size={14} />
      </button>

      {confirmingStop && (
        <ConfirmDialog
          title="Stop this agent?"
          body={`${session.title} will be stopped.`}
          confirmLabel={stopping ? 'Stopping…' : 'Stop'}
          busy={stopping}
          onConfirm={() => void stop()}
          onCancel={() => setConfirmingStop(false)}
        />
      )}
    </div>
  );
}
