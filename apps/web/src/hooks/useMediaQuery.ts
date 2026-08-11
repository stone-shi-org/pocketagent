import { useEffect, useState } from 'react';

/**
 * Layout decisions, made from what the browser can actually do.
 *
 * Deliberately not user-agent sniffing. UA strings lie by design — every
 * browser claims to be several others — the platform parts are being frozen in
 * favour of Client Hints, and none of it answers the question that matters
 * anyway: a desktop window dragged to half width wants the compact layout, and
 * an iPad with a trackpad wants the roomy one. Width and pointer type answer
 * that directly, and keep answering it when the window is resized.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => read(query));

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = (): void => setMatches(list.matches);
    // Re-read on subscribe: the query can have changed between render and
    // effect, and a resize during that window would otherwise be missed.
    onChange();
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * Wide enough for two panes, and driven by something other than a fingertip.
 *
 * Both halves matter. Width alone would give a landscape tablet a sidebar it
 * has no room to use once a keyboard appears; pointer alone would give a
 * narrow desktop window a layout that does not fit.
 */
export const DESKTOP_QUERY = '(min-width: 900px) and (pointer: fine)';

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

function read(query: string): boolean {
  // `matchMedia` is missing in non-browser test environments; assume compact,
  // which is the layout that works everywhere.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}
