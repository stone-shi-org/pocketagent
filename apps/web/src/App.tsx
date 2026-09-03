import { Suspense, useCallback, useEffect, useState } from 'react';
import { ApiError } from './api/client.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ComposerPage } from './pages/ComposerPage.js';
import { DesktopShell } from './pages/DesktopShell.js';
import { useIsDesktop } from './hooks/useMediaQuery.js';
import { SessionRoute } from './pages/SessionRoute.js';
import { ChatPreviewPage } from './pages/ChatPreviewPage.js';
import {
  AgentsFleetPage,
  CronJobEditorPage,
  CronJobsPage,
  SettingsPage,
  WebhookEditorPage,
  WebhooksPage,
} from './lazy-pages.js';
import { api } from './api/client.js';

/** Shared fallback while a lazily-loaded page's chunk is still fetching —
    same spinner the auth check above uses, so there's no visual seam
    between "checking who you are" and "loading the page you asked for". */
function PageFallback(): JSX.Element {
  return <div className="spinner">Loading…</div>;
}

type AuthState = 'checking' | 'anonymous' | 'authenticated';

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

  // Desktop keeps the list and the sessions on screen together, so the shell
  // owns the route and mounts every open tab itself (see `DesktopShell`'s own
  // tab-strip state) rather than being handed a single resolved child.
  if (desktop) {
    return (
      <DesktopShell
        route={route}
        onNavigate={navigate}
        onApiError={handleApiError}
        onLogout={logout}
      />
    );
  }

  if (route.name === 'terminal') {
    return (
      <SessionRoute
        sessionId={route.sessionId}
        onBack={() => navigate({ name: 'list' })}
        onApiError={handleApiError}
        onResumed={(sessionId) => navigate({ name: 'terminal', sessionId })}
      />
    );
  }

  if (route.name === 'chat') {
    return (
      <ChatPreviewPage
        conversationId={route.conversationId}
        onBack={() => navigate({ name: 'list' })}
        onApiError={handleApiError}
        onStarted={(sessionId) => navigate({ name: 'terminal', sessionId })}
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

  if (route.name === 'agents') {
    return (
      <Suspense fallback={<PageFallback />}>
        <AgentsFleetPage
          onBack={() => navigate({ name: 'list' })}
          onOpen={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onApiError={handleApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'settings') {
    return (
      <Suspense fallback={<PageFallback />}>
        <SettingsPage onBack={() => navigate({ name: 'list' })} onApiError={handleApiError} />
      </Suspense>
    );
  }

  if (route.name === 'cron') {
    return (
      <Suspense fallback={<PageFallback />}>
        <CronJobsPage
          onBack={() => navigate({ name: 'list' })}
          onOpenJob={(jobId) => navigate({ name: 'cron-job', jobId })}
          onApiError={handleApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'cron-job') {
    return (
      <Suspense fallback={<PageFallback />}>
        <CronJobEditorPage
          key={route.jobId}
          jobId={route.jobId}
          onBack={() => navigate({ name: 'cron' })}
          onDone={() => navigate({ name: 'cron' })}
          onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
          onApiError={handleApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'webhooks') {
    return (
      <Suspense fallback={<PageFallback />}>
        <WebhooksPage
          onBack={() => navigate({ name: 'list' })}
          onOpenWebhook={(webhookId) => navigate({ name: 'webhook', webhookId })}
          onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
          onApiError={handleApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'webhook') {
    return (
      <Suspense fallback={<PageFallback />}>
        <WebhookEditorPage
          key={route.webhookId}
          webhookId={route.webhookId}
          onBack={() => navigate({ name: 'webhooks' })}
          onDone={() => navigate({ name: 'webhooks' })}
          onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
          onApiError={handleApiError}
        />
      </Suspense>
    );
  }

  return (
    <ProjectsPage
      onOpen={(sessionId) => navigate({ name: 'terminal', sessionId })}
      onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
      onCompose={(cwd) => navigate(cwd ? { name: 'compose', cwd } : { name: 'compose' })}
      onOpenAgents={() => navigate({ name: 'agents' })}
      onOpenSettings={() => navigate({ name: 'settings' })}
      onOpenCron={() => navigate({ name: 'cron' })}
      onOpenCronJob={(jobId) => navigate({ name: 'cron-job', jobId })}
      onOpenWebhooks={() => navigate({ name: 'webhooks' })}
      onOpenWebhook={(webhookId) => navigate({ name: 'webhook', webhookId })}
      onApiError={handleApiError}
      onLogout={logout}
    />
  );
}
