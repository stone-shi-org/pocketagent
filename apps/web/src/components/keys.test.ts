import { describe, expect, it } from 'vitest';
import { KEY_SEQUENCES, ctrlSequence } from './MobileKeyBar.js';

describe('on-screen key sequences', () => {
  it('emits the same bytes a physical terminal would', () => {
    expect(KEY_SEQUENCES.escape).toBe('\u001b');
    expect(KEY_SEQUENCES.enter).toBe('\r');
    expect(KEY_SEQUENCES.tab).toBe('\t');
    expect(KEY_SEQUENCES.ctrlC).toBe('\u0003');
    expect(KEY_SEQUENCES.backspace).toBe('\u007f');
  });

  it('emits standard CSI arrow sequences', () => {
    expect(KEY_SEQUENCES.up).toBe('\u001b[A');
    expect(KEY_SEQUENCES.down).toBe('\u001b[B');
    expect(KEY_SEQUENCES.right).toBe('\u001b[C');
    expect(KEY_SEQUENCES.left).toBe('\u001b[D');
  });

  it('emits shift-tab as CSI Z', () => {
    expect(KEY_SEQUENCES.shiftTab).toBe('\u001b[Z');
  });
});

describe('ctrlSequence', () => {
  it('maps letters to their control codes', () => {
    expect(ctrlSequence('c')).toBe('\u0003');
    expect(ctrlSequence('C')).toBe('\u0003');
    expect(ctrlSequence('a')).toBe('\u0001');
    expect(ctrlSequence('d')).toBe('\u0004');
    expect(ctrlSequence('z')).toBe('\u001a');
  });

  it('maps the bracket family', () => {
    expect(ctrlSequence('[')).toBe('\u001b');
    expect(ctrlSequence('\\')).toBe('\u001c');
    expect(ctrlSequence(']')).toBe('\u001d');
  });

  it('returns null for input it cannot map, so the raw keystroke passes through', () => {
    expect(ctrlSequence('')).toBeNull();
    expect(ctrlSequence('abc')).toBeNull();
    expect(ctrlSequence('1')).toBeNull();
  });
});
