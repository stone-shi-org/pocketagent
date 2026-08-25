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
 * Wide enough for two panes, and either driven by something other than a
 * fingertip, or roomy enough on both axes to be a tablet rather than a phone.
 *
 * The `pointer: fine` branch is the desktop case: it excludes a narrow
 * desktop window dragged to half width (fails min-width) and a landscape
 * phone (fails pointer, since a touchscreen is always `coarse` — "request
 * desktop site" changes the UA string, not the hardware pointer the media
 * feature reports, so it cannot flip this).
 *
 * The second branch exists for iPads, which are touch-only (`pointer:
 * coarse`) but have room for the sidebar. Width alone can't tell an iPad
 * from a landscape phone — a large phone's landscape width (e.g. an iPhone
 * Pro Max at 932px) clears 900px too. What actually separates them is the
 * *short* side: an iPad's shortest dimension is its portrait width
 * (744px+), while a landscape phone's shortest dimension is its height
 * (~430px or less). Requiring both min-width and min-height at 700px passes
 * every iPad in both orientations and fails every phone in both
 * orientations. This is still feature detection, not UA sniffing — it reads
 * real viewport dimensions, not a spoofable platform string.
 */
export const DESKTOP_QUERY =
  '(min-width: 900px) and (pointer: fine), (min-width: 700px) and (min-height: 700px) and (pointer: coarse)';

export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}

function read(query: string): boolean {
  // `matchMedia` is missing in non-browser test environments; assume compact,
  // which is the layout that works everywhere.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}
