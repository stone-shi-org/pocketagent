import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/planner/token-estimate.js';

/**
 * PA-59: `estimateTokens` is a display-only heuristic (~4 chars/token) —
 * these tests pin its exact rounding behavior so a future tweak to the
 * ratio is a deliberate, visible change rather than an accidental one, not
 * an attempt to validate it against a real tokenizer (there isn't one in
 * this repo — see the function's own doc comment).
 */
describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up to the nearest whole token', () => {
    expect(estimateTokens('abc')).toBe(1); // 3 chars / 4 -> 0.75 -> 1
    expect(estimateTokens('abcd')).toBe(1); // exactly 4 chars -> 1
    expect(estimateTokens('abcde')).toBe(2); // 5 chars -> 1.25 -> 2
  });

  it('scales roughly linearly with length', () => {
    const short = estimateTokens('a'.repeat(40));
    const long = estimateTokens('a'.repeat(400));
    expect(long).toBe(short * 10);
  });

  it('never returns a negative number', () => {
    expect(estimateTokens(' ')).toBeGreaterThanOrEqual(0);
  });
});
