import { describe, expect, it } from 'vitest';
import { isSkipCommand } from './voice-commands.js';

describe('isSkipCommand', () => {
  it('matches the bare word, any case', () => {
    expect(isSkipCommand('skip')).toBe(true);
    expect(isSkipCommand('Skip')).toBe(true);
    expect(isSkipCommand('SKIP')).toBe(true);
  });

  it('matches with STT-added trailing punctuation and whitespace', () => {
    expect(isSkipCommand('skip.')).toBe(true);
    expect(isSkipCommand('Skip!')).toBe(true);
    expect(isSkipCommand('  skip  ')).toBe(true);
  });

  it('matches the short documented variants', () => {
    expect(isSkipCommand('skip it')).toBe(true);
    expect(isSkipCommand('skip that')).toBe(true);
    expect(isSkipCommand('stop talking')).toBe(true);
    expect(isSkipCommand('never mind')).toBe(true);
  });

  it('does not match a real prompt that merely contains the word', () => {
    expect(isSkipCommand('can you skip the intro and summarize the rest')).toBe(false);
    expect(isSkipCommand('skip to the good part please')).toBe(false);
  });

  it('does not match an empty or unrelated utterance', () => {
    expect(isSkipCommand('')).toBe(false);
    expect(isSkipCommand('hello there')).toBe(false);
  });
});
