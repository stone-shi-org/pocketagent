/**
 * Remembers, per tmux pane, that the user already chose "Fit to this screen
 * anyway" on `TerminalPage`'s adopted-session notice.
 *
 * Keyed by `adoptTargetId` — the pane's own stable id (see
 * `SessionInfo.adoptTargetId`'s doc comment) — rather than the session id.
 * The session id is ephemeral: navigating away and back re-mounts the page
 * with a fresh `useState`, and detaching and re-attaching to the very same
 * pane (see `ProjectList`'s Re-attach action) mints a brand-new session id
 * every time. Either would silently reset a plain in-memory or session id
 * keyed preference, and the notice — and the fixed-grid sizing it explains —
 * would reappear every single time even though the user already decided.
 * `localStorage` (not `sessionStorage`) because the point is to survive a
 * closed tab or a relaunched app, not just a reload.
 *
 * `localStorage` can be unavailable (private browsing, disabled storage) or,
 * outside a real browser, simply not exist as a global at all — every call
 * is wrapped so that degrades to "not remembered" rather than throwing.
 */
const KEY_PREFIX = 'pocketagent:take-over-size:';

export function getTakeOverSizePref(adoptTargetId: string): boolean {
  try {
    return localStorage.getItem(KEY_PREFIX + adoptTargetId) === '1';
  } catch {
    return false;
  }
}

export function setTakeOverSizePref(adoptTargetId: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + adoptTargetId, '1');
  } catch {
    /* private browsing, or no storage at all — best effort only */
  }
}
