import { getTerminalFontOverride } from '../agent/terminal-font-pref.js';

/**
 * The bundled default — see `styles.css`'s `@font-face` block and
 * `public/fonts/LICENSE.txt` for what it is and why it is self-hosted rather
 * than left to the system-font fallback list below: Powerline/Nerd Font
 * glyphs in a tmux prompt need a patched font that ships with the app,
 * because a phone almost never has one installed on its own.
 */
const DEFAULT_TERMINAL_FONT = '"JetBrainsMono Nerd Font Mono"';
const FALLBACK_FONTS = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

/**
 * `getTerminalFontOverride`'s value, if any, wins — someone who already has
 * their own Nerd Font installed on this device can use it instead — but the
 * bundled default and the system fallback stack always follow it, so a typo
 * or an uninstalled font name degrades to the same experience as not
 * overriding anything rather than an invisible/blank terminal.
 *
 * Kept in its own module, separate from `create-terminal.ts`: that file pulls
 * in `@xterm/xterm`'s addons, which assume a browser/worker global (`self`)
 * and cannot even be imported under the plain-Node test environment this
 * repo's unit tests run in — this function has no such dependency and is
 * worth testing directly.
 */
export function resolveFontFamily(): string {
  const override = getTerminalFontOverride();
  const family = override ? `"${override.replace(/"/g, '')}"` : null;
  return [family, DEFAULT_TERMINAL_FONT, FALLBACK_FONTS].filter(Boolean).join(', ');
}
