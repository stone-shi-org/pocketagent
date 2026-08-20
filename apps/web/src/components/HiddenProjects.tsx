import { useCallback, useEffect, useState } from 'react';
import type { ProjectInfo } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { flattenProjects } from '../agent/search.js';

/**
 * The way back from hiding something.
 *
 * Build-output directories are hidden by default, so without this there is no
 * way to discover that `dist` was excluded, let alone get it back — a filter
 * you cannot see is indistinguishable from a bug.
 */
export function HiddenProjects({
  onClose,
  onChanged,
  onApiError,
}: {
  onClose: () => void;
  onChanged: () => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [hidden, setHidden] = useState<ProjectInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { projects } = await api.listProjects(true);
      // A hidden worktree is folded under its (visible) main checkout's card
      // rather than listed at the top level, so it would never surface here
      // without flattening first — and a filter you can't see is exactly the
      // bug this dialog exists to avoid.
      setHidden(flattenProjects(projects).filter((p) => p.hidden));
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not load hidden projects.');
      setHidden([]);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const unhide = async (cwd: string): Promise<void> => {
    setBusy(cwd);
    try {
      await api.unhideProject(cwd);
      await load();
      onChanged();
    } catch (err) {
      onApiError(err);
      setError(err instanceof ApiError ? err.message : 'Could not unhide that project.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Hidden projects"
      >
        <h2>Hidden projects</h2>
        <p className="transport-hint">
          Hidden folders are left out of the list. Nothing was deleted, and the chats inside
          them are still on disk.
        </p>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {hidden === null && <div className="spinner">Loading…</div>}

        {hidden?.length === 0 && (
          <div className="empty">
            Nothing is hidden, apart from build directories with no chats in them.
          </div>
        )}

        {hidden && hidden.length > 0 && (
          <div className="pick-list">
            {hidden.map((project) => (
              <div key={project.cwd} className="pick-row hidden-row">
                <div className="pick-main">
                  <div className="pick-title">{project.name}</div>
                  <div className="pick-detail">
                    {project.workspaceLabel} · {project.chats.length} chat
                    {project.chats.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void unhide(project.cwd)}
                  disabled={busy !== null}
                >
                  {busy === project.cwd ? 'Unhiding…' : 'Unhide'}
                </button>
              </div>
            ))}
          </div>
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
