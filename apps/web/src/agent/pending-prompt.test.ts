import { beforeEach, describe, expect, it } from 'vitest';
import { setPendingPrompt, takePendingPrompt } from './pending-prompt.js';

describe('pending prompt handoff', () => {
  beforeEach(() => {
    // Drain anything a previous test left behind.
    takePendingPrompt('a');
    takePendingPrompt('b');
  });

  it('hands the prompt to the session it was typed for', () => {
    setPendingPrompt('a', 'do the thing');
    expect(takePendingPrompt('a')).toBe('do the thing');
  });

  it('yields it exactly once', () => {
    // The session page re-runs its effect on reconnect; sending the first
    // prompt twice would silently start two turns.
    setPendingPrompt('a', 'do the thing');
    expect(takePendingPrompt('a')).toBe('do the thing');
    expect(takePendingPrompt('a')).toBeNull();
  });

  it('never gives one session the prompt meant for another', () => {
    setPendingPrompt('a', 'for a');
    expect(takePendingPrompt('b')).toBeNull();
    expect(takePendingPrompt('a')).toBe('for a');
  });

  it('trims, and treats blank input as nothing to send', () => {
    setPendingPrompt('a', '  spaced  ');
    expect(takePendingPrompt('a')).toBe('spaced');

    setPendingPrompt('a', '   ');
    expect(takePendingPrompt('a')).toBeNull();
  });

  it('replaces an earlier prompt rather than queueing behind it', () => {
    setPendingPrompt('a', 'first');
    setPendingPrompt('b', 'second');
    expect(takePendingPrompt('a')).toBeNull();
    expect(takePendingPrompt('b')).toBe('second');
  });
});
