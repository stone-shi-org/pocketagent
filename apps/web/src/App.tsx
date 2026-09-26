import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { registerAudioUnlockListeners } from './audio/audio-context.js';
import { ApiError } from './api/client.js';
import { useHashRoute, type Route } from './hooks/useHashRoute.js';
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
  HubTemplateEditorPage,
  HubTemplatesPage,
  PlannerAgentEditorPage,
  PlannerChatPage,
  PlannerPage,
  SettingsPage,
  WebhookEditorPage,
  WebhooksPage,
} from './lazy-pages.js';
import { api } from './api/client.js';
import { useHostDirectory } from './hosts/directory.js';
import { HostProvider } from './hosts/HostContext.js';
import { currentHostId, resolveSelection } from './hosts/selected-host.js';
import { endpointFor, hostSegmentFor, type HostNav } from './hosts/HostNav.js';

/** Shared fallback while a lazily-loaded page's chunk is still fetching —
    same spinner the auth check above uses, so there's no visual seam
    between "checking who you are" and "loading the page you asked for". */
function PageFallback(): JSX.Element {
  return <div className="spinner">Loading…</div>;
}

type AuthState = 'checking' | 'anonymous' | 'authenticated';

export function App(): JSX.Element {
  const [auth, setAuth] = useState<AuthState>('checking');

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

  useEffect(() => {
    return registerAudioUnlockListeners();
  }, []);

  if (auth === 'checking') {
    return <div className="spinner">Loading…</div>;
  }

  if (auth === 'anonymous') {
    return <LoginPage onAuthenticated={() => setAuth('authenticated')} />;
  }

  // The host directory only exists for a signed-in operator (its very first
  // request is authenticated), and `useHostDirectory` owns timers — so it lives
  // below the auth gate in its own component rather than being started and torn
  // down around the login screen.
  return <AuthenticatedApp onAnonymous={() => setAuth('anonymous')} />;
}

function AuthenticatedApp({ onAnonymous }: { onAnonymous: () => void }): JSX.Element {
  const [route, navigate, , hashHostId] = useHashRoute();
  const desktop = useIsDesktop();
  const directory = useHostDirectory();

  /** Any 401 from anywhere in the app drops us back to the login screen. */
  const handleApiError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.isUnauthorized) onAnonymous();
    },
    [onAnonymous],
  );

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      onAnonymous();
      navigate({ name: 'list' }, { hostId: null });
    }
  }, [navigate, onAnonymous]);

  const hosts = directory.hosts;
  const selection = useMemo(
    () => resolveSelection(hashHostId, route, hosts),
    [hashHostId, route, hosts],
  );

  const nav = useMemo<HostNav>(
    () => ({
      selection,
      hosts,
      endpointFor: (hostId) => endpointFor(hosts, hostId),
      goToHost: (hostId) =>
        navigate(
          { name: 'list' },
          { hostId: hostId === null ? null : hostSegmentFor(hosts, hostId, { name: 'list' }) },
        ),
      openOn: (hostId, target) =>
        navigate(target, { hostId: hostSegmentFor(hosts, hostId, target) }),
    }),
    [selection, hosts, navigate],
  );

  // Nothing host-scoped renders until the directory has published its list.
  // That gate is what makes `resolveHostEndpoint`'s default-host fallback
  // harmless: a `#/h/dev02/s/x` deep link never gets a frame in which `dev02`
  // is unknown and its requests would quietly go to the wrong machine.
  if (!directory.ready) {
    return <div className="spinner">Loading…</div>;
  }

  if (selection.mode === 'unknown') {
    return <UnknownHost hostId={selection.hostId} onAllHosts={() => nav.goToHost(null)} />;
  }

  // Desktop keeps the list and the sessions on screen together, so the shell
  // owns the route and mounts every open tab itself (see `DesktopShell`'s own
  // tab-strip state) rather than being handed a single resolved child. It also
  // owns the host rail, which switches what the sidebar is about.
  if (desktop) {
    return (
      <DesktopShell
        route={route}
        nav={nav}
        directory={directory}
        onNavigate={navigate}
        onApiError={handleApiError}
        onLogout={logout}
      />
    );
  }

  // PA-70: the Hub's config templates are not one host's anything — they talk
  // to the origin that served this bundle — so they are resolved here, above
  // the `HostProvider` every other non-home route is wrapped in, and in both
  // layouts (`DesktopShell` has the same pair in its own pane). Rendered only
  // when a Hub is answering: on a standalone install there is no template API,
  // and a hand-typed `#/hub/templates` gets the home screen rather than a page
  // whose every request would 404.
  if (route.name === 'hub-templates' || route.name === 'hub-template') {
    // Rendered rather than redirected, for the reason `UnknownHost` is: a
    // `navigate` during render is a side effect in the wrong phase, and a
    // silent bounce to the home screen leaves a shared link looking broken
    // instead of explaining itself.
    if (directory.source !== 'hub') {
      return <NoHub onHome={() => nav.goToHost(null)} />;
    }
    return (
      <Suspense fallback={<PageFallback />}>
        {route.name === 'hub-templates' ? (
          <HubTemplatesPage
            onOpenTemplate={(templateId) =>
              navigate({ name: 'hub-template', templateId }, { hostId: null })
            }
            onBack={() => navigate({ name: 'settings' })}
            onApiError={handleApiError}
          />
        ) : (
          <HubTemplateEditorPage
            key={route.templateId}
            templateId={route.templateId}
            onCreated={(templateId) =>
              navigate({ name: 'hub-template', templateId }, { hostId: null })
            }
            onBack={() => navigate({ name: 'hub-templates' }, { hostId: null })}
            onDone={() => navigate({ name: 'hub-templates' }, { hostId: null })}
            onApiError={handleApiError}
          />
        )}
      </Suspense>
    );
  }

  // The phone layout resolves one route at a time, so everything below the home
  // screen is bound to exactly one host: the one the hash names, or the default
  // one for a bare URL. `ProjectsPage` is the exception and wraps its own
  // per-host providers, because the aggregated home shows several at once.
  if (route.name === 'list') {
    return (
      <ProjectsPage
        nav={nav}
        directory={directory}
        onOpen={(hostId, sessionId) => nav.openOn(hostId, { name: 'terminal', sessionId })}
        onOpenChat={(hostId, conversationId) =>
          nav.openOn(hostId, { name: 'chat', conversationId })
        }
        onCompose={(hostId, cwd) =>
          nav.openOn(hostId, cwd ? { name: 'compose', cwd } : { name: 'compose' })
        }
        onOpenAgents={() => navigate({ name: 'agents' })}
        onOpenSettings={() => navigate({ name: 'settings' })}
        onOpenCron={() => navigate({ name: 'cron' })}
        onOpenCronJob={(hostId, jobId) => nav.openOn(hostId, { name: 'cron-job', jobId })}
        onOpenWebhooks={() => navigate({ name: 'webhooks' })}
        onOpenWebhook={(hostId, webhookId) => nav.openOn(hostId, { name: 'webhook', webhookId })}
        onOpenPlanner={() => navigate({ name: 'planner' })}
        onOpenPlannerChat={(hostId, chatId) => nav.openOn(hostId, { name: 'planner-chat', chatId })}
        onApiError={handleApiError}
        onLogout={logout}
      />
    );
  }

  const hostId = currentHostId(selection, hosts);

  return (
    <HostProvider endpoint={nav.endpointFor(hostId)}>
      <PhoneRoute
        route={route}
        navigate={navigate}
        onApiError={handleApiError}
        hubVersion={directory.hubVersion}
      />
    </HostProvider>
  );
}

/**
 * Everything the phone layout shows that is not the home screen.
 *
 * Split out of `App` only so it sits inside the `HostProvider` above: each of
 * these pages fetches through `useHostApi()`, and the whole point is that a
 * page reached via `#/h/dev02/...` talks to `dev02` without knowing that it is
 * doing anything unusual.
 */
function PhoneRoute({
  route,
  navigate,
  onApiError,
  hubVersion,
}: {
  route: Route;
  navigate: (route: Route, opts?: { hostId?: string | null }) => void;
  onApiError: (error: unknown) => void;
  /** `HostDirectory.hubVersion`, for Settings' version footer (PA-107). */
  hubVersion: string | null;
}): JSX.Element {
  if (route.name === 'terminal') {
    return (
      <SessionRoute
        sessionId={route.sessionId}
        onBack={() => navigate({ name: 'list' })}
        onApiError={onApiError}
        onResumed={(sessionId) => navigate({ name: 'terminal', sessionId })}
      />
    );
  }

  if (route.name === 'chat') {
    return (
      <ChatPreviewPage
        conversationId={route.conversationId}
        onBack={() => navigate({ name: 'list' })}
        onApiError={onApiError}
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
        onApiError={onApiError}
      />
    );
  }

  if (route.name === 'agents') {
    return (
      <Suspense fallback={<PageFallback />}>
        <AgentsFleetPage
          onBack={() => navigate({ name: 'list' })}
          onOpen={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onApiError={onApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'settings') {
    return (
      <Suspense fallback={<PageFallback />}>
        <SettingsPage
          onBack={() => navigate({ name: 'list' })}
          onApiError={onApiError}
          hubVersion={hubVersion}
        />
      </Suspense>
    );
  }

  if (route.name === 'cron') {
    return (
      <Suspense fallback={<PageFallback />}>
        <CronJobsPage
          onBack={() => navigate({ name: 'list' })}
          onOpenJob={(jobId) => navigate({ name: 'cron-job', jobId })}
          onApiError={onApiError}
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
          onOpenPlannerChat={(chatId) => navigate({ name: 'planner-chat', chatId })}
          onApiError={onApiError}
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
          onOpenPlannerChat={(chatId) => navigate({ name: 'planner-chat', chatId })}
          onApiError={onApiError}
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
          onOpenPlannerChat={(chatId) => navigate({ name: 'planner-chat', chatId })}
          onApiError={onApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'planner') {
    return (
      <Suspense fallback={<PageFallback />}>
        <PlannerPage
          onBack={() => navigate({ name: 'list' })}
          onOpenAgent={(agentId) => navigate({ name: 'planner-agent', agentId })}
          onApiError={onApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'planner-agent') {
    return (
      <Suspense fallback={<PageFallback />}>
        <PlannerAgentEditorPage
          key={route.agentId}
          agentId={route.agentId}
          onBack={() => navigate({ name: 'planner' })}
          onDone={() => navigate({ name: 'planner' })}
          onApiError={onApiError}
        />
      </Suspense>
    );
  }

  if (route.name === 'planner-chat') {
    return (
      <Suspense fallback={<PageFallback />}>
        <PlannerChatPage
          key={route.chatId}
          chatId={route.chatId}
          onBack={() => navigate({ name: 'planner' })}
          onOpenSession={(sessionId) => navigate({ name: 'terminal', sessionId })}
          onOpenPlannerChat={(chatId) => navigate({ name: 'planner-chat', chatId })}
          onApiError={onApiError}
        />
      </Suspense>
    );
  }

  // `list` is the only remaining route and its caller handles it (the
  // aggregated home wraps its own per-host providers, so it cannot live inside
  // this one). Unreachable, but a spinner is the right thing to show if a
  // future route kind ever slips through.
  return <PageFallback />;
}

/**
 * `#/hub/templates` on an install with no Hub in front of it (PA-70).
 *
 * The surface exists in this bundle because the Hub serves this same bundle
 * (PA-66), so the route is reachable on a backend too — where there is no
 * template API to talk to. Saying so beats a page of failed requests.
 */
function NoHub({ onHome }: { onHome: () => void }): JSX.Element {
  return (
    <div className="app">
      <div className="empty">
        Config templates live on a PocketAgent Hub, and this app is not being served by one.
        <br />
        <button type="button" onClick={onHome} style={{ marginTop: 16 }}>
          Home
        </button>
      </div>
    </div>
  );
}

/**
 * A `#/h/<id>/...` link naming a host this browser does not know (PA-67).
 *
 * Rendered instead of silently substituting the default host, which is what
 * PA-60's `resolveHostEndpoint` did while there was only one host to substitute
 * — harmless then, actively dangerous now: every action taken on the page would
 * land on a machine the URL did not name. A removed host's stale bookmark, or a
 * link shared out of a Hub deployment into a standalone one, lands here.
 */
function UnknownHost({
  hostId,
  onAllHosts,
}: {
  hostId: string;
  onAllHosts: () => void;
}): JSX.Element {
  return (
    <div className="app">
      <div className="empty">
        No host called <code>{hostId}</code> is registered in this browser.
        <br />
        <button type="button" onClick={onAllHosts} style={{ marginTop: 16 }}>
          All hosts
        </button>
      </div>
    </div>
  );
}
