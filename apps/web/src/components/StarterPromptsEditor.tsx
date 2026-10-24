import { useEffect, useState } from 'react';
import {
  PLANNER_STARTER_PROMPT_LABEL_MAX,
  PLANNER_STARTER_PROMPT_TEXT_MAX,
  PLANNER_STARTER_PROMPTS_MAX,
  type PlannerStarterPrompt,
} from '@pocketagent/protocol';
import { validateStarterPromptDrafts } from '../agent/starter-prompts.js';

interface Props {
  /** The saved list. The editor keeps its own draft and resets to this
      whenever it changes (a save, or switching agents). */
  value: readonly PlannerStarterPrompt[];
  busy: boolean;
  onSave: (prompts: PlannerStarterPrompt[]) => void;
  idPrefix: string;
}

/**
 * Edits a list of starter chips: a short label (what the chip shows) and the
 * prompt it sends. Unlike the auto-saving fields around it, this saves on an
 * explicit button: a half-typed row (a label with no prompt yet) is not a
 * valid chip, and saving on every blur would either reject it or store it.
 * Used for the global list (Settings → Pocket Agent) and for one agent's own
 * list (`PlannerAgentEditorPage`).
 */
export function StarterPromptsEditor({ value, busy, onSave, idPrefix }: Props): JSX.Element {
  const [draft, setDraft] = useState<PlannerStarterPrompt[]>(() => value.map((p) => ({ ...p })));
  useEffect(() => {
    setDraft(value.map((p) => ({ ...p })));
  }, [value]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const problem = validateStarterPromptDrafts(draft);

  const update = (index: number, patch: Partial<PlannerStarterPrompt>): void => {
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const move = (index: number, delta: -1 | 1): void => {
    setDraft((rows) => {
      const target = index + delta;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      const [moved] = next.splice(index, 1);
      next.splice(target, 0, moved!);
      return next;
    });
  };
  const remove = (index: number): void => {
    setDraft((rows) => rows.filter((_, i) => i !== index));
  };
  const add = (): void => {
    setDraft((rows) => [...rows, { label: '', prompt: '' }]);
  };

  return (
    <div className="starter-prompts-editor">
      {draft.length === 0 && <p className="planner-row-meta">No chips — an empty chat shows none.</p>}
      {draft.map((row, i) => (
        <div key={i} className="starter-prompts-editor-row">
          <div className="starter-prompts-editor-fields">
            <label className="starter-prompts-editor-label">
              <span className="planner-row-meta">
                Chip label ({row.label.trim().length}/{PLANNER_STARTER_PROMPT_LABEL_MAX})
              </span>
              <input
                id={`${idPrefix}-label-${i}`}
                type="text"
                value={row.label}
                maxLength={PLANNER_STARTER_PROMPT_LABEL_MAX}
                disabled={busy}
                placeholder="Open Jira issues"
                onChange={(e) => update(i, { label: e.target.value })}
              />
            </label>
            <label className="starter-prompts-editor-label">
              <span className="planner-row-meta">Prompt sent when tapped</span>
              <textarea
                id={`${idPrefix}-prompt-${i}`}
                value={row.prompt}
                maxLength={PLANNER_STARTER_PROMPT_TEXT_MAX}
                disabled={busy}
                rows={2}
                placeholder="Search Jira for open issues assigned to me and summarise them by priority."
                onChange={(e) => update(i, { prompt: e.target.value })}
                style={{ width: '100%', resize: 'vertical' }}
              />
            </label>
          </div>
          <div className="planner-row-actions">
            <button
              type="button"
              className="planner-btn"
              disabled={busy || i === 0}
              onClick={() => move(i, -1)}
              aria-label={`Move chip ${i + 1} up`}
            >
              ↑
            </button>
            <button
              type="button"
              className="planner-btn"
              disabled={busy || i === draft.length - 1}
              onClick={() => move(i, 1)}
              aria-label={`Move chip ${i + 1} down`}
            >
              ↓
            </button>
            <button type="button" className="planner-btn" disabled={busy} onClick={() => remove(i)}>
              Remove
            </button>
          </div>
        </div>
      ))}
      <div className="planner-inline" style={{ gap: 8, marginTop: 8 }}>
        <button
          type="button"
          className="planner-btn"
          disabled={busy || draft.length >= PLANNER_STARTER_PROMPTS_MAX}
          onClick={add}
        >
          Add chip
        </button>
        <button
          type="button"
          className="planner-btn active"
          disabled={busy || !dirty || problem !== null}
          onClick={() => onSave(draft.map((p) => ({ label: p.label.trim(), prompt: p.prompt.trim() })))}
        >
          Save chips
        </button>
        {dirty && (
          <button
            type="button"
            className="planner-btn"
            disabled={busy}
            onClick={() => setDraft(value.map((p) => ({ ...p })))}
          >
            Cancel
          </button>
        )}
      </div>
      {dirty && problem && (
        <p className="planner-row-meta" role="alert" style={{ marginTop: 6 }}>
          {problem}
        </p>
      )}
    </div>
  );
}
