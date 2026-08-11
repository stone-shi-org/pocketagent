import { useCallback, useEffect, useState } from 'react';

export type Route = { name: 'list' } | { name: 'terminal'; sessionId: string };

function parse(hash: string): Route {
  const match = /^#\/s\/([^/?]+)/.exec(hash);
  if (match?.[1]) return { name: 'terminal', sessionId: decodeURIComponent(match[1]) };
  return { name: 'list' };
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
    const hash = next.name === 'terminal' ? `#/s/${encodeURIComponent(next.sessionId)}` : '#/';
    if (window.location.hash === hash) setRoute(next);
    else window.location.hash = hash;
  }, []);

  return [route, navigate];
}
