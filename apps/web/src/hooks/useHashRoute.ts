import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'list' }
  | { name: 'terminal'; sessionId: string }
  /** A finished chat, opened to read — not yet resumed into a session. See
      `ChatPreviewPage`. */
  | { name: 'chat'; conversationId: string }
  /** `cwd` preselects a workspace, e.g. when composing from a project header. */
  | { name: 'compose'; cwd?: string }
  /** The "Agents" fleet overview — every running agent, at a glance. */
  | { name: 'agents' }
  /** The full settings page — see `SettingsPage`. */
  | { name: 'settings' };

function parse(hash: string): Route {
  const session = /^#\/s\/([^/?]+)/.exec(hash);
  if (session?.[1]) return { name: 'terminal', sessionId: decodeURIComponent(session[1]) };

  const chat = /^#\/c\/([^/?]+)/.exec(hash);
  if (chat?.[1]) return { name: 'chat', conversationId: decodeURIComponent(chat[1]) };

  const compose = /^#\/new(?:\/(.*))?$/.exec(hash);
  if (compose) {
    const cwd = compose[1] ? decodeURIComponent(compose[1]) : undefined;
    return cwd ? { name: 'compose', cwd } : { name: 'compose' };
  }

  if (/^#\/agents$/.exec(hash)) return { name: 'agents' };

  if (/^#\/settings$/.exec(hash)) return { name: 'settings' };

  return { name: 'list' };
}

function toHash(route: Route): string {
  switch (route.name) {
    case 'terminal':
      return `#/s/${encodeURIComponent(route.sessionId)}`;
    case 'chat':
      return `#/c/${encodeURIComponent(route.conversationId)}`;
    case 'compose':
      return route.cwd ? `#/new/${encodeURIComponent(route.cwd)}` : '#/new';
    case 'agents':
      return '#/agents';
    case 'settings':
      return '#/settings';
    default:
      return '#/';
  }
}

/**
 * Hash routing rather than the History API: it needs no server-side rewrites
 * and, more importantly, reloading the page on a phone lands back on the same
 * session instead of the session list.
 */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Route) => {
    // Update state right away rather than waiting on `hashchange`, which the
    // browser fires as a separate, later task — not synchronously within this
    // call. A caller that reads its own props again in the same tick right
    // after calling `navigate` (e.g. `DesktopShell` closing a tab and falling
    // back to a neighbor) would otherwise still see the *old* route for one
    // more render, with nothing to say a new one is already on its way. The
    // `hashchange` listener still fires when the hash actually changes; it
    // just re-parses to the same route this already set, which is a harmless
    // no-op re-render.
    setRoute(next);
    const hash = toHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);

  return [route, navigate];
}
