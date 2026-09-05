import { useEffect, useState } from 'react';
import type { BrowseEntry } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from './Icon.js';

/**
 * Pick an existing directory (or create a new one) on the host for a Pocket
 * Agent's own workspace. This is the same host-side directory browser
 * `AddProject`'s own `Browser` uses for project folders — kept as a separate
 * component rather than generalizing that one, because picking here means
 * something different: a project folder is read-mostly and containment-
 * checked, while an agent's workspace directory is handed full read/write/
 * delete trust the moment it is picked (see `CreatePlannerWorkspaceRequest`'s
 * doc comment) — the navigation UI is coincidentally identical, the meaning
 * of clicking "Use this" is not.
 */
export function PlannerDirectoryPicker({
  onClose,
  onPick,
  onApiError,
}: {
  onClose: () => void;
  onPick: (path: string, opts?: { create?: boolean }) => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [at, setAt] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{
    path: string;
    label: string;
    parent: string | null;
    entries: BrowseEntry[];
  } | null>(null);
  const [newFolder, setNewFolder] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    api
      .browse(at)
      .then((r) => !cancelled && setState(r))
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setError(err instanceof ApiError ? err.message : 'Could not browse this directory.');
      });
    return () => {
      cancelled = true;
    };
  }, [at, onApiError]);

  const trimmedNewFolder = newFolder.trim();

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Pick a directory"
      >
        <h2>Pick a directory</h2>
        <p className="transport-hint">
          This agent&apos;s tools will be able to freely read, write, and delete inside whatever
          you pick here — the same trust an app-created scratch folder already has, just for a
          directory you chose yourself.
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {state === null ? (
          <div className="spinner">Loading…</div>
        ) : (
          <>
            <div className="browse-bar">
              <button
                type="button"
                className="round-btn plain"
                onClick={() => state.parent && setAt(state.parent)}
                disabled={!state.parent}
                aria-label="Up one level"
              >
                <Icon name="chevron-left" size={18} />
              </button>
              <span className="browse-path" title={state.path}>
                {state.label}
              </span>
              <button type="button" className="primary" onClick={() => onPick(state.path)}>
                Use this
              </button>
            </div>

            <form
              className="browse-create"
              onSubmit={(e) => {
                e.preventDefault();
                if (!trimmedNewFolder || trimmedNewFolder.includes('/')) return;
                onPick(joinPath(state.path, trimmedNewFolder), { create: true });
              }}
            >
              <input
                type="text"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder={`New folder in ${state.label}`}
                aria-label="New folder name"
              />
              <button type="submit" disabled={!trimmedNewFolder || trimmedNewFolder.includes('/')}>
                Create &amp; use
              </button>
            </form>

            {state.entries.length === 0 ? (
              <div className="empty">No subdirectories here.</div>
            ) : (
              <div className="pick-list">
                {state.entries.map((entry) => (
                  <div key={entry.path} className="pick-row browse-row">
                    <button type="button" className="pick-main" onClick={() => setAt(entry.path)}>
                      <div className="pick-title">
                        <Icon name="folder" size={16} /> {entry.name}
                        {entry.isGitRepo && <span className="browse-git">git</span>}
                      </div>
                    </button>
                    <button type="button" onClick={() => onPick(entry.path)}>
                      Use
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Join a browsed directory with a leaf name; `state.path` is always absolute. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}
