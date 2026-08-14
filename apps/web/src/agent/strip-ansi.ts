/**
 * Strip ANSI escapes so a fleet-card preview shows rendered text, not control
 * codes.
 *
 * Mirrors `apps/server/src/terminal/classifier.ts`'s `stripAnsi` — that one is
 * server-only (used for heuristic hint detection) and not part of the web
 * bundle, so this is a deliberate small duplicate rather than a shared
 * package: the fleet card's use is purely cosmetic (a few preview lines),
 * unlike the classifier's, so it does not need to track that file if its
 * heuristics evolve.
 */

const ESC = '\x1b';
const OSC_PATTERN = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\u0007|${ESC}\\\\)`, 'g');
const CSI_PATTERN = new RegExp(
  `${ESC}[\\[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nqry=><~]`,
  'g',
);

export function stripAnsi(input: string): string {
  return input.replace(OSC_PATTERN, '').replace(CSI_PATTERN, '');
}

/**
 * A shell prompt redraws itself with a bare `\r` (no `\n`) far more often
 * than it prints a real new line — every prompt-library segment, spinner
 * frame, and `PS1` refresh does it. Splitting on `\n` alone concatenates
 * every one of those overwrites onto the same "line", which reads as
 * garbage. This is not full VT100 cursor emulation (nothing here is,
 * `create-terminal.ts` owns that for the real terminal view) — just the
 * one rule that matters for a plain-text preview: only what comes after the
 * *last* `\r` in a line is what a real terminal would still be showing.
 */
function collapseCarriageReturns(line: string): string {
  const idx = line.lastIndexOf('\r');
  return idx === -1 ? line : line.slice(idx + 1);
}

/**
 * The last `n` non-empty plain-text lines of raw (possibly ANSI-laden)
 * terminal output, newest last. A fleet card only has room for a handful of
 * lines and no interest in blank padding a spinner redraw tends to leave
 * behind.
 */
export function lastPlainLines(raw: string, n: number): string[] {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((line) => collapseCarriageReturns(line).trimEnd())
    .filter((line) => line.length > 0);
  return lines.slice(-n);
}
