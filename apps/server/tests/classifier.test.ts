import { describe, expect, it } from 'vitest';
import { HeuristicTerminalClassifier, stripAnsi } from '../src/terminal/classifier.js';

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

describe('HeuristicTerminalClassifier', () => {
  it('flags a yes/no question as a possible approval prompt', () => {
    const classifier = new HeuristicTerminalClassifier();
    const hints = classifier.process('Do you want to make this edit to app.ts?\n1. Yes\n2. No\n');
    expect(hints).toContain('possible_approval_prompt');
    expect(hints).toContain('waiting_for_input');
  });

  it('flags a bare shell prompt as waiting for input', () => {
    const classifier = new HeuristicTerminalClassifier();
    expect(classifier.process('user@host:~/src$ ')).toContain('waiting_for_input');
  });

  it('flags spinner output as working', () => {
    const classifier = new HeuristicTerminalClassifier();
    expect(classifier.process('⠹ Thinking… (esc to interrupt)')).toContain('working');
  });

  it('does not re-emit an unchanged state', () => {
    const classifier = new HeuristicTerminalClassifier();
    expect(classifier.process('$ ').length).toBeGreaterThan(0);
    expect(classifier.process('$ ')).toEqual([]);
  });

  it('reports idle only after the quiet period', () => {
    const classifier = new HeuristicTerminalClassifier(4096, 1000);
    const t0 = 1_000_000;
    classifier.process('working…', t0);
    expect(classifier.checkIdle(t0 + 500)).toEqual([]);
    expect(classifier.checkIdle(t0 + 2000)).toEqual(['idle']);
  });

  it('returns no hints before any output', () => {
    expect(new HeuristicTerminalClassifier().checkIdle()).toEqual([]);
  });
});
