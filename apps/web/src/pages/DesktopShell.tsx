import { useState } from 'react';
import type { Route } from '../hooks/useHashRoute.js';
import { NewSessionDialog } from '../components/NewSessionDialog.js';
import { HiddenProjects } from '../components/HiddenProjects.js';
import { AddProject } from '../components/AddProject.js';
import { PushToggle } from '../components/PushToggle.js';
import { Icon } from '../components/Icon.js';
import { HostChip, ProjectList, SearchField, useProjects } from '../components/ProjectList.js';
import { OverflowMenu } from './ProjectsPage.js';
import { ComposerPage } from './ComposerPage.js';

interface Props {
  route: Route;
  onNavigate: (route: Route) => void;
  onApiError: (error: unknown) => void;
  onLogout: () => void;
  /** The session pane, resolved by the router so transport choice stays there. */
  children: React.ReactNode;
}

/**
 * Desktop layout: the chat list stays put and the session opens beside it.
 *
 * On a phone the list and a session compete for the one screen, so opening a
 * chat has to replace the list. Given width there is no reason to keep paying
 * that cost — you can see what else is running while you read one of them, and
 * switching chats is a click instead of a round trip through the home screen.
 *
 * Which layout you get is decided by viewport width and pointer type, never by
 * sniffing the user agent. See `useMediaQuery`.
 */
export function DesktopShell({
  route,
  onNavigate,
  onApiError,
  onLogout,
  children,
}: Props): JSX.Element {
  const state = useProjects(
    (sessionId) => onNavigate({ name: 'terminal', sessionId }),
    onApiError,
  );
  const [search, setSearch] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const activeSessionId = route.name === 'terminal' ? route.sessionId : null;

  return (
    <div className="desktop-shell">
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="sidebar-brand">
            <strong>Remote</strong>
            <HostChip host={state.host} />
          </div>
          <PushToggle compact />
          <button
            type="button"
            className="round-btn plain"
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

        <div className="sidebar-actions">
          <button
            type="button"
            className="new-chat-btn"
            onClick={() => onNavigate({ name: 'compose' })}
          >
            <Icon name="compose" size={18} />
            New chat
          </button>
        </div>

        <div className="sidebar-search">
          <SearchField value={search} onChange={setSearch} />
        </div>

        <div className="sidebar-scroll">
          {state.error && (
            <div className="error-box" role="alert">
              {state.error}
            </div>
          )}
          <ProjectList
            state={state}
            search={search}
            onCompose={(cwd) => onNavigate({ name: 'compose', cwd })}
          onAddProject={() => setShowAdd(true)}
            activeSessionId={activeSessionId}
            emptyHint="Nothing here yet. Start a chat to see it listed."
          />
        </div>
      </aside>

      <main className="workspace">
        {route.name === 'compose' ? (
          <ComposerPage
            {...(route.cwd !== undefined ? { initialCwd: route.cwd } : {})}
            onBack={() => onNavigate({ name: 'list' })}
            onCreated={(sessionId) => {
              void state.refresh();
              onNavigate({ name: 'terminal', sessionId });
            }}
            onApiError={onApiError}
          />
        ) : route.name === 'terminal' ? (
          children
        ) : (
          <WelcomePane onCompose={() => onNavigate({ name: 'compose' })} />
        )}
      </main>

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
            void state.refresh();
            onNavigate({ name: 'terminal', sessionId: id });
          }}
        />
      )}
    </div>
  );
}

/** What fills the pane before a chat is chosen. */
function WelcomePane({ onCompose }: { onCompose: () => void }): JSX.Element {
  return (
    <div className="welcome">
      <Icon name="terminal" size={38} />
      <h2>Pick up where you left off</h2>
      <p>
        Choose a chat on the left to read it, or start a new one. Sessions keep running when
        you close this tab.
      </p>
      <button type="button" className="primary" onClick={onCompose}>
        New chat
      </button>
    </div>
  );
}
