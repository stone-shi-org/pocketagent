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

  it('does not re-fire idle after unrelated output that matches no pattern', () => {
    // Regression: an adopted tmux pane keeps producing bytes nobody typed —
    // the default status line redraws on its own `status-interval` timer
    // (15s by default) and shows a clock by default. That redraw does not
    // match any working/approval/prompt pattern, but it used to reset the
    // classifier's internal state the same as any other output, which
    // re-armed `checkIdle` and fired `idle` again on the next quiet spell —
    // forever, on a session nobody was touching.
    const classifier = new HeuristicTerminalClassifier(4096, 1000);
    const t0 = 1_000_000;
    classifier.process('user@host:~$ ', t0);
    expect(classifier.checkIdle(t0 + 2000)).toEqual(['idle']);

    // A status-line-only redraw: no recognizable pattern, so `process` itself
    // reports nothing new...
    expect(classifier.process('some unrelated text', t0 + 2100)).toEqual([]);
    // ...and the still-idle pane must not be re-notified after another quiet
    // spell just because that redraw happened.
    expect(classifier.checkIdle(t0 + 4200)).toEqual([]);
  });

  it('still reports idle again once real activity resumes and quiets down', () => {
    // The guard above must not make `idle` sticky forever — a genuine new
    // state (a fresh prompt, here) still ends the idle stretch, so a later
    // quiet spell notifies again.
    const classifier = new HeuristicTerminalClassifier(4096, 1000);
    const t0 = 1_000_000;
    classifier.process('user@host:~$ ', t0);
    expect(classifier.checkIdle(t0 + 2000)).toEqual(['idle']);

    classifier.process('user@host:~/other$ ', t0 + 2100);
    expect(classifier.checkIdle(t0 + 2600)).toEqual([]);
    expect(classifier.checkIdle(t0 + 3200)).toEqual(['idle']);
  });
});
