/**
 * An optional override for the terminal's font, typed into `SettingsDialog`.
 *
 * `create-terminal.ts` bundles "JetBrainsMono Nerd Font Mono" as the default
 * so Powerline/Nerd Font glyphs in a tmux prompt render on any device this
 * app is opened from, a phone included, with nothing to install. This lets
 * someone who already has their own Nerd Font installed on *this specific
 * device* (their laptop's browser, say) use it instead — the same tradeoff
 * `adopted-size-prefs.ts` documents for its own preference: a real choice,
 * not a default worth shipping, so it lives in `localStorage` rather than
 * the server's `settings` table. A font a laptop has and a phone does not
 * would otherwise apply globally and silently fall back to `monospace` on
 * every other device.
 *
 * `localStorage` (not `sessionStorage`) so the choice survives a closed tab
 * or a relaunched app, not just a reload. Every call is wrapped so a
 * storage failure (private browsing, disabled storage, no `localStorage`
 * global at all outside a real browser) degrades to "no override" rather
 * than throwing.
 */
const KEY = 'pocketagent:terminal-font-override';

/** The raw override string, or null when unset (use the bundled default). */
export function getTerminalFontOverride(): string | null {
  try {
    const value = localStorage.getItem(KEY);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

/** Empty/whitespace clears the override, same as never having set one. */
export function setTerminalFontOverride(value: string): void {
  try {
    if (value.trim()) localStorage.setItem(KEY, value.trim());
    else localStorage.removeItem(KEY);
  } catch {
    /* private browsing, or no storage at all — best effort only */
  }
}
