import { useCallback, useEffect, useState } from 'react';
import type { BrowseEntry, DiscoveredFolder } from '@pocketagent/protocol';
import { api, ApiError } from '../api/client.js';
import { Icon } from './Icon.js';
import { formatRelative } from './StatusBadge.js';

type Tab = 'suggested' | 'browse';

/**
 * Pick a folder on the host to work in.
 *
 * Not an OS file dialog, and it cannot be one: a browser's directory picker
 * returns a handle to storage on *this* device, and a file input never reveals
 * an absolute path. The agents run on the server, so the server lists its own
 * directories and this navigates them.
 *
 * The suggested tab exists because navigating a filesystem on a phone is
 * tedious, and the agents already know which folders you work in.
 */
export function AddProject({
  onClose,
  onAdded,
  onApiError,
}: {
  onClose: () => void;
  onAdded: (path: string) => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [tab, setTab] = useState<Tab>('suggested');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = useCallback(
    async (path: string, opts?: { create?: boolean }) => {
      setBusy(path);
      setError(null);
      try {
        await api.addWorkspace(path, opts);
        onAdded(path);
        onClose();
      } catch (err) {
        onApiError(err);
        setError(
          err instanceof ApiError
            ? err.message
            : opts?.create
              ? 'Could not create that folder.'
              : 'Could not add that folder.',
        );
      } finally {
        setBusy(null);
      }
    },
    [onAdded, onClose, onApiError],
  );

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add a project"
      >
        <h2>Add a project</h2>

        <div className="mode-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'suggested'}
            className={tab === 'suggested' ? 'active' : ''}
            onClick={() => setTab('suggested')}
          >
            Suggested
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'browse'}
            className={tab === 'browse' ? 'active' : ''}
            onClick={() => setTab('browse')}
          >
            Browse
          </button>
        </div>

        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}

        {tab === 'suggested' ? (
          <Suggested onAdd={add} busy={busy} onApiError={onApiError} />
        ) : (
          <Browser onAdd={add} busy={busy} onApiError={onApiError} />
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

/** Folders Claude Code and Codex have already run in. */
function Suggested({
  onAdd,
  busy,
  onApiError,
}: {
  onAdd: (path: string) => void;
  busy: string | null;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [folders, setFolders] = useState<DiscoveredFolder[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listDiscovered()
      .then((r) => !cancelled && setFolders(r.folders))
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [onApiError]);

  if (folders === null) return <div className="spinner">Looking…</div>;
  if (folders.length === 0) {
    return (
      <div className="empty">
        Nothing to suggest — no agent history outside the folders you already have.
        <br />
        Use Browse to pick one.
      </div>
    );
  }

  return (
    <>
      <p className="transport-hint">
        Folders Claude Code and Codex have run in before. Adding one lets PocketAgent start
        sessions there.
      </p>
      <div className="pick-list">
        {folders.map((folder) => (
          <button
            key={folder.path}
            type="button"
            className="pick-row pick-main"
            onClick={() => onAdd(folder.path)}
            disabled={busy !== null}
          >
            <div className="pick-title">{folder.label}</div>
            <div className="pick-detail">
              {folder.agents.join(' · ')} · {folder.sessions} session
              {folder.sessions === 1 ? '' : 's'} · {formatRelative(folder.lastUsedAt)}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

/** Join a browsed directory with a leaf name; `state.path` is always absolute. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/** Navigate the host's directories. */
function Browser({
  onAdd,
  busy,
  onApiError,
}: {
  onAdd: (path: string, opts?: { create?: boolean }) => void;
  busy: string | null;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [at, setAt] = useState<string | undefined>(undefined);
  const [state, setState] = useState<{
    path: string;
    label: string;
    parent: string | null;
    added: boolean;
    entries: BrowseEntry[];
  } | null>(null);
  const [newFolder, setNewFolder] = useState('');

  useEffect(() => {
    let cancelled = false;
    setState(null);
    api
      .browse(at)
      .then((r) => !cancelled && setState(r))
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [at, onApiError]);

  if (state === null) return <div className="spinner">Loading…</div>;

  const trimmedNewFolder = newFolder.trim();

  return (
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
        <button
          type="button"
          className="primary"
          onClick={() => onAdd(state.path)}
          disabled={busy !== null || state.added}
        >
          {state.added ? 'Added' : 'Add this'}
        </button>
      </div>

      <form
        className="browse-create"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmedNewFolder || trimmedNewFolder.includes('/') || busy !== null) return;
          onAdd(joinPath(state.path, trimmedNewFolder), { create: true });
        }}
      >
        <input
          type="text"
          value={newFolder}
          onChange={(e) => setNewFolder(e.target.value)}
          placeholder={`New folder in ${state.label}`}
          aria-label="New folder name"
          disabled={busy !== null}
        />
        <button type="submit" disabled={busy !== null || !trimmedNewFolder || trimmedNewFolder.includes('/')}>
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
              <button
                type="button"
                onClick={() => onAdd(entry.path)}
                disabled={busy !== null || entry.added}
              >
                {entry.added ? 'Added' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
