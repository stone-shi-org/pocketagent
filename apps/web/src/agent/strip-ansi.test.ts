import { describe, expect, it } from 'vitest';
import { lastPlainLines, stripAnsi } from './strip-ansi.js';

describe('stripAnsi', () => {
  it('removes colour codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('removes cursor movement and bracketed-paste toggles', () => {
    expect(stripAnsi('\x1b[?2004hprompt$ \x1b[2K\x1b[G')).toBe('prompt$ ');
  });

  it('removes OSC window-title sequences', () => {
    expect(stripAnsi('\x1b]0;my title\x07done')).toBe('done');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('just text')).toBe('just text');
  });
});

describe('lastPlainLines', () => {
  it('keeps only the last n non-empty lines, newest last', () => {
    const raw = 'one\ntwo\nthree\nfour\nfive\n';
    expect(lastPlainLines(raw, 3)).toEqual(['three', 'four', 'five']);
  });

  it('drops blank lines a spinner redraw tends to leave behind', () => {
    const raw = 'one\n\n\ntwo\n   \nthree\n';
    expect(lastPlainLines(raw, 5)).toEqual(['one', 'two', 'three']);
  });

  it('strips ANSI before splitting', () => {
    const raw = '\x1b[2K\x1b[Gline one\n\x1b[31mline two\x1b[0m\n';
    expect(lastPlainLines(raw, 5)).toEqual(['line one', 'line two']);
  });

  it('returns an empty array for output with no visible lines', () => {
    expect(lastPlainLines('\x1b[2K\x1b[G   \n', 5)).toEqual([]);
  });

  it('keeps only what comes after the last \\r on a line, not every overwrite concatenated', () => {
    // A shell prompt redraws itself with a bare \r far more often than a
    // real \n — every prompt-segment refresh does it. Regression for a bug
    // where a real shell's prompt rendered as run-together garbage because
    // every \r-redraw was kept instead of only the last one.
    const raw = 'part1\rpart2\rfinal prompt$ \n';
    expect(lastPlainLines(raw, 5)).toEqual(['final prompt$']);
  });

  it('collapses carriage returns independently on each line', () => {
    const raw = 'aaa\rone\nbbb\rtwo\n';
    expect(lastPlainLines(raw, 5)).toEqual(['one', 'two']);
  });
});
