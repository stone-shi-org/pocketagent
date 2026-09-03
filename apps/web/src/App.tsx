import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api/client.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { LoginPage } from './pages/LoginPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ComposerPage } from './pages/ComposerPage.js';
import { DesktopShell } from './pages/DesktopShell.js';
import { useIsDesktop } from './hooks/useMediaQuery.js';
import { SessionRoute } from './pages/SessionRoute.js';
import { ChatPreviewPage } from './pages/ChatPreviewPage.js';
import { AgentsFleetPage } from './pages/AgentsFleetPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { CronJobsPage } from './pages/CronJobsPage.js';
import { CronJobEditorPage } from './pages/CronJobEditorPage.js';
import { WebhooksPage } from './pages/WebhooksPage.js';
import { WebhookEditorPage } from './pages/WebhookEditorPage.js';
import { api } from './api/client.js';

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
      <AgentsFleetPage
        onBack={() => navigate({ name: 'list' })}
        onOpen={(sessionId) => navigate({ name: 'terminal', sessionId })}
        onApiError={handleApiError}
      />
    );
  }

  if (route.name === 'settings') {
    return <SettingsPage onBack={() => navigate({ name: 'list' })} onApiError={handleApiError} />;
  }

  if (route.name === 'cron') {
    return (
      <CronJobsPage
        onBack={() => navigate({ name: 'list' })}
        onOpenJob={(jobId) => navigate({ name: 'cron-job', jobId })}
        onApiError={handleApiError}
      />
    );
  }

  if (route.name === 'cron-job') {
    return (
      <CronJobEditorPage
        key={route.jobId}
        jobId={route.jobId}
        onBack={() => navigate({ name: 'cron' })}
        onDone={() => navigate({ name: 'cron' })}
        onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
        onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
        onApiError={handleApiError}
      />
    );
  }

  if (route.name === 'webhooks') {
    return (
      <WebhooksPage
        onBack={() => navigate({ name: 'list' })}
        onOpenWebhook={(webhookId) => navigate({ name: 'webhook', webhookId })}
        onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
        onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
        onApiError={handleApiError}
      />
    );
  }

  if (route.name === 'webhook') {
    return (
      <WebhookEditorPage
        key={route.webhookId}
        webhookId={route.webhookId}
        onBack={() => navigate({ name: 'webhooks' })}
        onDone={() => navigate({ name: 'webhooks' })}
        onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
        onOpenChat={(conversationId) => navigate({ name: 'chat', conversationId })}
        onApiError={handleApiError}
      />
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
