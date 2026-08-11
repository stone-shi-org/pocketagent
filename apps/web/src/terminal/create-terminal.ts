import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';

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
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: 1.15,
    macOptionIsMeta: true,
    theme: {
      background: '#000000',
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

  return {
    term,
    fit,
    dispose: () => term.dispose(),
  };
}
