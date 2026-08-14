import { useEffect, useState } from 'react';
import type { SessionInfo } from '@pocketagent/protocol';
import { TerminalConnection } from '../api/ws-client.js';
import { agentIconName } from '../agent/agent-icon.js';
import { lastPlainLines } from '../agent/strip-ansi.js';
import { applyFleetEvent, applyFleetEvents, emptyFleetPreview, type FleetPreviewState } from '../agent/fleet-preview.js';
import { Icon } from './Icon.js';

/** Only the last few KB matter for a five-line preview; no reason to grow forever. */
const RAW_TAIL_CHARS = 4000;
const PREVIEW_LINES = 5;

interface Props {
  session: SessionInfo;
  onOpen: (sessionId: string) => void;
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
export function AgentCard({ session, onOpen }: Props): JSX.Element {
  const [rawTail, setRawTail] = useState('');
  const [preview, setPreview] = useState<FleetPreviewState>(emptyFleetPreview);
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

  return (
    <button type="button" className="agent-card" onClick={() => onOpen(session.id)}>
      <div className="agent-card-head">
        <span className="agent-mascot">
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
        {lines.length === 0 ? (
          <div className="agent-output-line agent-output-empty">Waiting for output…</div>
        ) : (
          lines.map((line, i) => (
            <div
              key={i === lines.length - 1 ? `last-${flashSeq}` : i}
              className={i === lines.length - 1 ? 'agent-output-line agent-output-line--new' : 'agent-output-line'}
            >
              {line}
            </div>
          ))
        )}
      </div>

      {preview.subagents.length > 0 && (
        <div className="agent-subagents">
          {preview.subagents.map((s) => (
            <div className="agent-subagent" key={s.toolUseId}>
              <span className="agent-mascot">
                <Icon name="agent-generic" size={12} />
              </span>
              {s.summary}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}
