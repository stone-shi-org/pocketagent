import { useState } from 'react';
import type { PermissionDecision, PermissionRequestEvent } from '@pocketagent/protocol';
import { collapseContext, diffFromToolInput, diffLines } from '../agent/diff.js';

interface Props {
  request: PermissionRequestEvent;
  /** How many more are queued behind this one. */
  queued: number;
  onDecide: (decision: PermissionDecision, message?: string) => void;
  disabled: boolean;
}

/**
 * The approval prompt, as a native bottom sheet rather than keystrokes.
 *
 * This is the payoff of the structured transport: in terminal mode the user has
 * to read a TUI and press `1`; here the same decision is three buttons with the
 * agent's own wording, a diff of what would change, and a place to say why not.
 */
export function ApprovalSheet({ request, queued, onDecide, disabled }: Props): JSX.Element {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  const diff = diffFromToolInput(request.toolName, request.input);
  const lines = diff ? collapseContext(diffLines(diff.before, diff.after), 2) : null;

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="Approval required">
      <div className="approval-sheet">
        <div className="approval-head">
          <span className="approval-badge">Approval needed</span>
          {queued > 0 && <span className="approval-queued">+{queued} more</span>}
        </div>

        <h2 className="approval-title">{request.title}</h2>

        {request.filePath && <div className="approval-path">{request.filePath}</div>}
        {request.reason && <div className="approval-reason">{request.reason}</div>}

        {lines && (
          <div className="approval-diff diff">
            {lines.map((line, index) =>
              line === null ? (
                <div key={`g${index}`} className="diff-gap">
                  ⋯
                </div>
              ) : (
                <div key={index} className={`diff-line ${line.op}`}>
                  <span className="gutter">
                    {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}
                  </span>
                  <span className="code">{line.text || ' '}</span>
                </div>
              ),
            )}
          </div>
        )}

        {!lines && (
          <pre className="approval-input">{JSON.stringify(request.input, null, 2).slice(0, 1200)}</pre>
        )}

        {denying ? (
          <>
            <label className="field">
              <span>Tell the agent why (optional)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. edit the config instead"
                autoFocus
              />
            </label>
            <div className="approval-actions">
              <button type="button" onClick={() => setDenying(false)} disabled={disabled}>
                Back
              </button>
              <button
                type="button"
                className="danger primary-danger"
                onClick={() => onDecide('deny', reason)}
                disabled={disabled}
              >
                Deny
              </button>
            </div>
          </>
        ) : (
          <div className="approval-actions column">
            <button
              type="button"
              className="primary"
              onClick={() => onDecide('allow')}
              disabled={disabled}
            >
              Allow once
            </button>
            {request.canAllowForSession && (
              <button
                type="button"
                onClick={() => onDecide('allow_session')}
                disabled={disabled}
                title="Adopt the agent's suggested rule so it stops asking for this"
              >
                Allow for this session
              </button>
            )}
            <button
              type="button"
              className="danger"
              onClick={() => setDenying(true)}
              disabled={disabled}
            >
              Deny…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
