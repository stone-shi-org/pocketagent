import { useState } from 'react';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  PermissionDecision,
  PermissionRequestEvent,
} from '@pocketagent/protocol';
import { collapseContext, diffFromToolInput, diffLines } from '../agent/diff.js';

interface Props {
  request: PermissionRequestEvent;
  /** How many more are queued behind this one. */
  queued: number;
  onDecide: (decision: PermissionDecision, message?: string, answer?: AskUserQuestionAnswer) => void;
  disabled: boolean;
}

/**
 * The approval prompt, as a native bottom sheet rather than keystrokes.
 *
 * This is the payoff of the structured transport: in terminal mode the user has
 * to read a TUI and press `1`; here the same decision is three buttons with the
 * agent's own wording, a diff of what would change, and a place to say why not.
 *
 * One tool is not approve/deny-shaped at all: the SDK's built-in
 * `AskUserQuestion` uses this exact same channel to ask a genuine multiple-choice
 * (or free-text) question, and reads the answer back as the tool's own result
 * rather than as permission to proceed. `request.questions` is only ever
 * populated for that tool, so it is what selects the question form below
 * instead of the generic allow/deny body.
 */
export function ApprovalSheet({ request, queued, onDecide, disabled }: Props): JSX.Element {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  const isQuestion = request.questions !== null && request.questions.length > 0;

  const diff = isQuestion ? null : diffFromToolInput(request.toolName, request.input);
  const lines = diff ? collapseContext(diffLines(diff.before, diff.after), 2) : null;

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="Approval required">
      <div className="approval-sheet">
        <div className="approval-head">
          <span className="approval-badge">{isQuestion ? 'Question' : 'Approval needed'}</span>
          {queued > 0 && <span className="approval-queued">+{queued} more</span>}
        </div>

        {!isQuestion && <h2 className="approval-title">{request.title}</h2>}
        {!isQuestion && request.filePath && <div className="approval-path">{request.filePath}</div>}
        {!isQuestion && request.reason && <div className="approval-reason">{request.reason}</div>}

        {!isQuestion && lines && (
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

        {!isQuestion && !lines && (
          <pre className="approval-input">{JSON.stringify(request.input, null, 2).slice(0, 1200)}</pre>
        )}

        {isQuestion && !denying && (
          <QuestionForm
            questions={request.questions ?? []}
            disabled={disabled}
            onSubmit={(answer) => onDecide('allow', undefined, answer)}
          />
        )}

        {denying ? (
          <>
            <label className="field">
              <span>Tell the agent why (optional)</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder={isQuestion ? 'e.g. neither option applies' : 'e.g. edit the config instead'}
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
                {isQuestion ? 'Decline' : 'Deny'}
              </button>
            </div>
          </>
        ) : isQuestion ? (
          <div className="approval-actions">
            <button
              type="button"
              className="danger"
              onClick={() => setDenying(true)}
              disabled={disabled}
            >
              Decline to answer…
            </button>
          </div>
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

/**
 * One or more multiple-choice (or free-text) questions from `AskUserQuestion`.
 *
 * Every question gets an "Other" text field alongside its options — the tool's
 * own contract is that the user can always type past the suggested choices —
 * and a single submit covers every question in the call at once, matching how
 * the tool itself batches up to four of them in one ask.
 */
function QuestionForm({
  questions,
  disabled,
  onSubmit,
}: {
  questions: AskUserQuestionItem[];
  disabled: boolean;
  onSubmit: (answer: AskUserQuestionAnswer) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [customText, setCustomText] = useState<Record<number, string>>({});

  function pick(qIndex: number, label: string, multiSelect: boolean): void {
    setCustomText((prev) => ({ ...prev, [qIndex]: '' }));
    setSelected((prev) => {
      const current = prev[qIndex] ?? [];
      if (!multiSelect) return { ...prev, [qIndex]: [label] };
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      return { ...prev, [qIndex]: next };
    });
  }

  function typeOther(qIndex: number, value: string): void {
    setCustomText((prev) => ({ ...prev, [qIndex]: value }));
    if (value.trim()) setSelected((prev) => ({ ...prev, [qIndex]: [] }));
  }

  const answers: Record<string, string> = {};
  let complete = questions.length > 0;
  for (const [index, q] of questions.entries()) {
    const custom = customText[index]?.trim();
    const picks = selected[index] ?? [];
    if (custom) answers[q.question] = custom;
    else if (picks.length > 0) answers[q.question] = picks.join(', ');
    else complete = false;
  }

  return (
    <div className="question-form">
      {questions.map((q, index) => (
        <div key={index} className="question-block">
          <div className="question-header">{q.header}</div>
          <div className="question-text">{q.question}</div>
          <div className="question-options">
            {q.options.map((opt) => {
              const isSelected = (selected[index] ?? []).includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={`question-option${isSelected ? ' selected' : ''}`}
                  onClick={() => pick(index, opt.label, q.multiSelect)}
                  disabled={disabled}
                  aria-pressed={isSelected}
                >
                  <div className="question-option-label">{opt.label}</div>
                  {opt.description && <div className="question-option-desc">{opt.description}</div>}
                </button>
              );
            })}
          </div>
          <label className="field question-other">
            <span>Other</span>
            <input
              type="text"
              value={customText[index] ?? ''}
              onChange={(e) => typeOther(index, e.target.value)}
              placeholder="Type your own answer"
              disabled={disabled}
            />
          </label>
        </div>
      ))}

      <div className="approval-actions">
        <button
          type="button"
          className="primary"
          onClick={() => onSubmit({ answers })}
          disabled={disabled || !complete}
        >
          {questions.length > 1 ? 'Submit answers' : 'Submit answer'}
        </button>
      </div>
    </div>
  );
}
