import { useEffect, useRef, useState } from 'react';

export interface WorktreeChoice {
  mode: 'main' | 'new';
  branchMode: 'new' | 'current';
  branchName: string;
}

interface Props {
  /** Current branch of the checkout this worktree would be created from, for labels. */
  branch: string | null;
  initial: WorktreeChoice;
  onConfirm: (choice: WorktreeChoice) => void;
  onCancel: () => void;
}

/**
 * Everything needed to decide where a fresh chat runs, in one sheet.
 *
 * This used to be two extra rows in the composer's selector stack plus a bare
 * `.field` text input bolted on below them — the input had no leading icon to
 * line up with, so it visually drifted left of everything above it. Folding
 * mode, branch choice and the name into one dialog fixes the misalignment and
 * means the composer only ever shows one line ("Worktree: ...") for this,
 * whatever was picked.
 */
export function WorktreeDialog({ branch, initial, onConfirm, onCancel }: Props): JSX.Element {
  const [mode, setMode] = useState(initial.mode);
  const [branchMode, setBranchMode] = useState(initial.branchMode);
  const [branchName, setBranchName] = useState(initial.branchName);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Focus the name field the moment it becomes the relevant next step, same
  // as the picker sheet focusing its first option.
  useEffect(() => {
    if (mode === 'new' && branchMode === 'new') nameRef.current?.focus();
  }, [mode, branchMode]);

  const canConfirm = mode === 'main' || branchMode === 'current' || branchName.trim().length > 0;

  return (
    <div className="sheet-backdrop" onClick={onCancel} role="presentation">
      <div
        className="sheet worktree-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Worktree"
      >
        <div className="sheet-title">Worktree</div>

        <div className="segmented" role="radiogroup" aria-label="Where this chat runs">
          <button type="button" className={mode === 'main' ? 'active' : ''} onClick={() => setMode('main')}>
            Main{branch ? ` — ${branch}` : ''}
          </button>
          <button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
            New worktree
          </button>
        </div>

        {mode === 'new' && (
          <>
            <div className="segmented" role="radiogroup" aria-label="Branch">
              <button
                type="button"
                className={branchMode === 'new' ? 'active' : ''}
                onClick={() => setBranchMode('new')}
              >
                New branch
              </button>
              <button
                type="button"
                className={branchMode === 'current' ? 'active' : ''}
                onClick={() => setBranchMode('current')}
              >
                Current{branch ? ` (${branch})` : ''}
              </button>
            </div>

            {branchMode === 'new' ? (
              <div className="field">
                <label htmlFor="worktree-branch-name">Branch name</label>
                <input
                  id="worktree-branch-name"
                  ref={nameRef}
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canConfirm) {
                      e.preventDefault();
                      onConfirm({ mode, branchMode, branchName });
                    }
                  }}
                  placeholder="feature/my-branch"
                />
              </div>
            ) : (
              <p className="transport-hint">
                Git can&rsquo;t check {branch ?? 'the current branch'} out in two worktrees at
                once, so this creates a new branch from its current tip instead — a real,
                committable branch, just not named {branch ?? 'the same'}.
              </p>
            )}

            <p className="transport-hint">
              New worktree at <code>.worktrees/</code> inside this project.
            </p>
          </>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canConfirm}
            onClick={() => onConfirm({ mode, branchMode, branchName })}
          >
            {mode === 'new' ? 'Use new worktree' : 'Use main checkout'}
          </button>
        </div>
      </div>
    </div>
  );
}
