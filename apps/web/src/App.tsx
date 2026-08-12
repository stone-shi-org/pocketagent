import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api/client.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ComposerPage } from './pages/ComposerPage.js';
import { DesktopShell } from './pages/DesktopShell.js';
import { useIsDesktop } from './hooks/useMediaQuery.js';
import { TerminalPage } from './pages/TerminalPage.js';
import { AgentPage } from './pages/AgentPage.js';
import { api } from './api/client.js';

type AuthState = 'checking' | 'anonymous' | 'authenticated';

/**
 * Pick the renderer for a session.
 *
 * The transport is a property of the session, not of the URL, so this resolves
 * it once and then hands off. A short loading state is better than guessing and
 * mounting the wrong UI, which would clear the wrong kind of buffer.
 */
function SessionRoute({
  sessionId,
  onBack,
  onApiError,
}: {
  sessionId: string;
  onBack: () => void;
  onApiError: (error: unknown) => void;
}): JSX.Element {
  const [transport, setTransport] = useState<'terminal' | 'structured' | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setTransport(null);
    setMissing(false);
    api
      .getSession(sessionId)
      .then((info) => {
        if (!cancelled) setTransport(info.transport);
      })
      .catch((err) => {
        if (cancelled) return;
        onApiError(err);
        setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, onApiError]);

  if (missing) {
    return (
      <div className="app">
        <div className="empty">
          This session no longer exists.
          <br />
          <button type="button" onClick={onBack} style={{ marginTop: 16 }}>
            Back to sessions
          </button>
        </div>
      </div>
    );
  }
  if (transport === null) return <div className="spinner">Opening session…</div>;
  if (transport === 'structured') {
    return <AgentPage sessionId={sessionId} onBack={onBack} onApiError={onApiError} />;
  }
  return <TerminalPage sessionId={sessionId} onBack={onBack} onApiError={onApiError} />;
}

export function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>('checking');
  const [route, navigate] = useHashRoute();
  const desktop = useIsDesktop();

  useEffect(() => {
    let cancelled = false;
    api
      .me()
      .then((me) => {
        if (!cancelled) setAuth(me.authenticated ? 'authenticated' : 'anonymous');
      })
      .catch(() => {
        if (!cancelled) setAuth('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Any 401 from anywhere in the app drops us back to the login screen. */
  const handleApiError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.isUnauthorized) setAuth('anonymous');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setAuth('anonymous');
      navigate({ name: 'list' });
    }
  }, [navigate]);

  if (auth === 'checking') {
    return <div className="spinner">Loading…</div>;
  }

  if (auth === 'anonymous') {
    return <LoginPage onAuthenticated={() => setAuth('authenticated')} />;
  }

  // Desktop keeps the list and the session on screen together, so the shell
  // owns the route and the session pane is handed to it as a child.
  if (desktop) {
    return (
      <DesktopShell
        route={route}
        onNavigate={navigate}
        onApiError={handleApiError}
        onLogout={logout}
      >
        {route.name === 'terminal' && (
          <SessionRoute
            key={route.sessionId}
            sessionId={route.sessionId}
            onBack={() => navigate({ name: 'list' })}
            onApiError={handleApiError}
          />
        )}
      </DesktopShell>
    );
  }

  if (route.name === 'terminal') {
    return (
      <SessionRoute
        sessionId={route.sessionId}
        onBack={() => navigate({ name: 'list' })}
        onApiError={handleApiError}
      />
    );
  }

  if (route.name === 'compose') {
    return (
      <ComposerPage
        key={route.cwd ?? ''}
        {...(route.cwd !== undefined ? { initialCwd: route.cwd } : {})}
        onBack={() => navigate({ name: 'list' })}
        onCreated={(sessionId) => navigate({ name: 'terminal', sessionId })}
        onApiError={handleApiError}
      />
    );
  }

  return (
    <ProjectsPage
      onOpen={(sessionId) => navigate({ name: 'terminal', sessionId })}
      onCompose={(cwd) => navigate(cwd ? { name: 'compose', cwd } : { name: 'compose' })}
      onApiError={handleApiError}
      onLogout={logout}
    />
  );
}
