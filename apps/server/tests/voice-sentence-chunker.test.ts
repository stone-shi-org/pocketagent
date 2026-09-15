import { describe, it, expect } from 'vitest';
import { SentenceChunker } from '../src/voice/sentence-chunker.js';

describe('SentenceChunker', () => {
  it('emits nothing until a sentence boundary is seen', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello there')).toEqual([]);
  });

  it('emits a complete sentence once punctuation + whitespace arrives', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('Hello there. ')).toEqual(['Hello there.']);
  });

  it('emits multiple sentences delivered in a single delta', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('First one. Second one! Third?')).toEqual(['First one.', 'Second one!']);
    // "Third?" has no trailing whitespace yet — held back correctly.
    expect(chunker.flush()).toBe('Third?');
  });

  it('reassembles a sentence split across multiple deltas', () => {
    const chunker = new SentenceChunker();
    expect(chunker.push('The weather ')).toEqual([]);
    expect(chunker.push('today is ')).toEqual([]);
    expect(chunker.push('sunny. ')).toEqual(['The weather today is sunny.']);
  });

  it('does not treat a decimal number as a sentence boundary', () => {
    const chunker = new SentenceChunker();
    // No whitespace immediately after "3." — must not split there.
    expect(chunker.push('The value is 3.14 exactly. ')).toEqual(['The value is 3.14 exactly.']);
  });

  it('does not falsely split when a delta boundary happens to land right after punctuation', () => {
    // Regression: matching "end of buffer" as a sentence boundary would
    // treat *every* delta ending in a period as complete, since a freshly
    // appended chunk is always "the end of the buffer so far" — including a
    // delta that stops mid-abbreviation/decimal purely due to streaming
    // timing, not real punctuation. Only literal trailing whitespace (or an
    // explicit flush()) may end a sentence.
    const chunker = new SentenceChunker();
    expect(chunker.push('The value is 3.')).toEqual([]);
    expect(chunker.push('14 exactly. ')).toEqual(['The value is 3.14 exactly.']);
  });

  it('flush() returns trailing text with no terminal punctuation', () => {
    const chunker = new SentenceChunker();
    chunker.push('No terminal punctuation here');
    expect(chunker.flush()).toBe('No terminal punctuation here');
  });

  it('flush() returns null when nothing is buffered', () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toBeNull();
  });

  it('flush() returns null after whitespace-only trailing content', () => {
    const chunker = new SentenceChunker();
    chunker.push('Done. ');
    chunker.push('   ');
    expect(chunker.flush()).toBeNull();
  });

  it('falls back to a length-based cut for a very long run with no punctuation', () => {
    const chunker = new SentenceChunker();
    const longRun = 'word '.repeat(60); // 300 chars, well past the 200-char fallback
    const emitted = chunker.push(longRun);
    expect(emitted.length).toBeGreaterThan(0);
    // Every emitted chunk must actually respect the cap, and the cut must
    // land on a word boundary (no chunk ends with a fragment of "word").
    for (const chunk of emitted) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.endsWith('word') || /^(word\s*)*word$/.test(chunk)).toBe(true);
    }
  });

  it('falls back to a hard cut for one absurdly long word with no whitespace at all', () => {
    const chunker = new SentenceChunker();
    const longWord = 'a'.repeat(500);
    const emitted = chunker.push(longWord);
    expect(emitted.length).toBeGreaterThan(0);
    for (const chunk of emitted) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    // Nothing is lost: every char reappears across the emitted chunks plus
    // whatever's left buffered.
    const total = emitted.join('').length + (chunker.flush()?.length ?? 0);
    expect(total).toBe(500);
  });

  it('reset() discards buffered text without emitting it', () => {
    const chunker = new SentenceChunker();
    chunker.push('unfinished clause');
    chunker.reset();
    expect(chunker.flush()).toBeNull();
  });
});
