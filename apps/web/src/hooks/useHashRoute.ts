import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { name: 'list' }
  | { name: 'terminal'; sessionId: string }
  /** `cwd` preselects a workspace, e.g. when composing from a project header. */
  | { name: 'compose'; cwd?: string };

function parse(hash: string): Route {
  const session = /^#\/s\/([^/?]+)/.exec(hash);
  if (session?.[1]) return { name: 'terminal', sessionId: decodeURIComponent(session[1]) };

  const compose = /^#\/new(?:\/(.*))?$/.exec(hash);
  if (compose) {
    const cwd = compose[1] ? decodeURIComponent(compose[1]) : undefined;
    return cwd ? { name: 'compose', cwd } : { name: 'compose' };
  }

  return { name: 'list' };
}

function toHash(route: Route): string {
  switch (route.name) {
    case 'terminal':
      return `#/s/${encodeURIComponent(route.sessionId)}`;
    case 'compose':
      return route.cwd ? `#/new/${encodeURIComponent(route.cwd)}` : '#/new';
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
    const hash = toHash(next);
    if (window.location.hash === hash) setRoute(next);
    else window.location.hash = hash;
  }, []);

  return [route, navigate];
}
