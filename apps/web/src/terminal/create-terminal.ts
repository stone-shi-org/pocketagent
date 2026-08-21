import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { copyText } from '../agent/clipboard.js';
import { decodeOsc52Payload } from './osc52.js';
import { resolveFontFamily } from './font-family.js';

export interface TerminalBundle {
  term: Terminal;
  fit: FitAddon;
  dispose: () => void;
}

/**
 * xterm.js owns all ANSI interpretation — colours, cursor movement, the
 * alternate screen buffer that full-screen TUIs use. We never parse or rewrite
 * the byte stream; the browser is a terminal emulator, not an HTML renderer.
 */
export function createTerminal(element: HTMLElement): TerminalBundle {
  const term = new Terminal({
    cursorBlink: true,
    allowProposedApi: true,
    convertEol: false,
    scrollback: 5000,
    fontSize: window.innerWidth < 480 ? 12 : 13,
    fontFamily: resolveFontFamily(),
    lineHeight: 1.15,
    macOptionIsMeta: true,
    // The terminal stays dark inside a light app, deliberately: ANSI palettes
    // are drawn for dark backgrounds, and bright yellow on white is unreadable.
    theme: {
      background: '#0b0e13',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      selectionBackground: '#264f78',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(element);

  try {
    fit.fit();
  } catch {
    /* element not laid out yet; the first resize observation will fix it */
  }

  // The very first `fit()` above can run before the bundled Nerd Font (or an
  // override) has actually loaded — nothing awaits it, deliberately, so a
  // slow font fetch never delays the terminal's first paint. Until it loads,
  // the browser measures cell size against whatever fallback font matched
  // instead, which can be a slightly different width and leaves `fit()`'s
  // column/row count a little off. `document.fonts` does not exist outside a
  // real browser (the demo scripts' Playwright pages aside), hence the guard.
  let disposed = false;
  void document.fonts?.ready?.then(() => {
    if (disposed) return;
    try {
      fit.fit();
    } catch {
      /* still not laid out; nothing more to correct here */
    }
  });

  // OSC 52 ("set clipboard") is how a remote mouse-copy — tmux's
  // `set -g mouse on` copy-mode included — reaches whatever terminal is
  // actually rendering the byte stream. Over a plain ssh+iTerm2 session that
  // terminal is iTerm2 itself, which intercepts OSC 52 and writes to the
  // macOS pasteboard; here it is xterm.js in the browser, and core xterm.js
  // has no built-in OSC 52 handler at all (only `@xterm/addon-clipboard`
  // adds one, and it is not installed) — so without this, the escape
  // sequence arrives byte-for-byte (see `TerminalPage`'s plain `term.write`)
  // and is silently dropped. `copyText` is the same fallback the app's own
  // copy buttons use, so this also works over the plain-HTTP, non-secure-
  // context deployment this app is written for.
  const oscClipboardHandler = term.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52Payload(data);
    if (text) void copyText(text);
    return true;
  });

  return {
    term,
    fit,
    dispose: () => {
      disposed = true;
      oscClipboardHandler.dispose();
      term.dispose();
    },
  };
}
