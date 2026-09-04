/**
 * Remembers the user's preferred sidebar width in desktop environment.
 *
 * Persisted in `localStorage` so the custom width survives tab closures and
 * reloads. Clamped to sensible min/max bounds so the sidebar cannot become
 * invisible or overwhelm the screen.
 */

export const DEFAULT_SIDEBAR_WIDTH = 312;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

const KEY = 'pocketagent:desktop-sidebar-width';

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.round(width)));
}

export function getSidebarWidthPref(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SIDEBAR_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    return clampSidebarWidth(parsed);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

export function setSidebarWidthPref(width: number): void {
  try {
    const clamped = clampSidebarWidth(width);
    localStorage.setItem(KEY, clamped.toString());
  } catch {
    /* private browsing, or no storage at all — best effort only */
  }
}
