import { useEffect, useRef, useState } from 'react';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { Icon } from '../components/Icon.js';
import {
  HostChip,
  ProjectList,
  SearchField,
  useProjects,
} from '../components/ProjectList.js';

interface Props {
  onOpen: (sessionId: string) => void;
  onCompose: (cwd?: string) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
}

/**
 * Home screen on a phone: a folder per workspace directory, the chats inside
 * it, and one button to start another.
 *
 * The grouping is the point. A flat list of sessions answers "what is running",
 * which is a server's question; the thing you actually want on a phone is
 * "what was I doing on this project", and a chat that has finished is still an
 * answer to that. So live sessions and finished conversations sit in one list,
 * distinguished by a dot rather than by being filed somewhere else.
 */
export function ProjectsPage({ onOpen, onCompose, onApiError, onLogout }: Props): JSX.Element {
  const state = useProjects(onOpen, onApiError);
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div className="app projects-page">
      <header className="home-bar">
        <div className="home-title">
          <strong>Remote</strong>
          <HostChip host={state.host} />
        </div>
        <span className="spacer" />
        <button
          type="button"
          className="round-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More"
          aria-expanded={menuOpen}
        >
          <Icon name="ellipsis" size={20} />
        </button>
        {menuOpen && (
          <OverflowMenu
            onClose={() => setMenuOpen(false)}
            onAdvanced={() => {
              setMenuOpen(false);
              setShowAdvanced(true);
            }}
            onRefresh={() => {
              setMenuOpen(false);
              void state.refresh();
            }}
            onHidden={() => {
              setMenuOpen(false);
              setShowHidden(true);
            }}
            onLogout={onLogout}
          />
        )}
      </header>

      <div className="home-scroll">
        {state.error && (
          <div className="error-box" role="alert">
            {state.error}
          </div>
        )}
        <ProjectList
          state={state}
          search={search}
          onCompose={onCompose}
          onAddProject={() => setShowAdd(true)}
          emptyHint="Nothing here yet. Tap the compose button to start a chat."
        />
      </div>

      <div className="home-dock">
        <SearchField value={search} onChange={setSearch} />
        <PushToggle compact />
        <button
          type="button"
          className="compose-fab"
          onClick={() => onCompose()}
          aria-label="New chat"
        >
          <Icon name="compose" size={23} />
        </button>
      </div>

      {showAdd && (
        <AddProject
          onClose={() => setShowAdd(false)}
          onAdded={() => void state.refresh()}
          onApiError={onApiError}
        />
      )}

      {showHidden && (
        <HiddenProjects
          onClose={() => setShowHidden(false)}
          onChanged={() => void state.refresh()}
          onApiError={onApiError}
        />
      )}

      {showAdvanced && (
        <NewSessionDialog
          onCancel={() => setShowAdvanced(false)}
          onApiError={onApiError}
          onCreated={(id) => {
            setShowAdvanced(false);
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}

export function OverflowMenu({
  onClose,
  onAdvanced,
  onRefresh,
  onHidden,
  onLogout,
}: {
  onClose: () => void;
  onAdvanced: () => void;
  onRefresh: () => void;
  onHidden: () => void;
  onLogout: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="menu-backdrop" onClick={onClose} role="presentation">
      <div className="menu" ref={ref} onClick={(e) => e.stopPropagation()} role="menu">
        <button type="button" role="menuitem" onClick={onRefresh}>
          Refresh
        </button>
        <button type="button" role="menuitem" onClick={onHidden}>
          Hidden projects…
        </button>
        <button type="button" role="menuitem" onClick={onAdvanced}>
          More session options…
        </button>
        <button type="button" role="menuitem" className="danger" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </div>
  );
}
