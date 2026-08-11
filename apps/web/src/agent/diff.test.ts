import { describe, expect, it } from 'vitest';
import { collapseContext, diffFromToolInput, diffLines, diffStat } from './diff.js';

describe('diffLines', () => {
  it('marks unchanged lines as context', () => {
    const lines = diffLines('a\nb', 'a\nb');
    expect(lines.every((l) => l.op === 'context')).toBe(true);
  });

  it('detects a single-line change as one remove plus one add', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    expect(lines.map((l) => l.op)).toEqual(['context', 'remove', 'add', 'context']);
    expect(diffStat(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('handles pure insertion', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    expect(diffStat(lines)).toEqual({ added: 1, removed: 0 });
  });

  it('handles pure deletion', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    expect(diffStat(lines)).toEqual({ added: 0, removed: 1 });
  });

  it('treats an empty before as all additions', () => {
    const lines = diffLines('', 'x\ny');
    expect(diffStat(lines)).toEqual({ added: 2, removed: 0 });
  });

  it('numbers lines on the correct side', () => {
    const lines = diffLines('a\nb', 'a\nB');
    const removed = lines.find((l) => l.op === 'remove');
    const added = lines.find((l) => l.op === 'add');
    expect(removed).toMatchObject({ oldLine: 2, newLine: null });
    expect(added).toMatchObject({ oldLine: null, newLine: 2 });
  });

  it('finds the minimal edit rather than replacing everything', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line TEN');
    expect(diffStat(diffLines(before, after))).toEqual({ added: 1, removed: 1 });
  });
});

describe('collapseContext', () => {
  it('elides long unchanged runs', () => {
    const before = Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l20', 'CHANGED');
    const collapsed = collapseContext(diffLines(before, after), 2);

    expect(collapsed).toContain(null); // at least one elision marker
    expect(collapsed.length).toBeLessThan(41);
    const kept = collapsed.filter((l): l is NonNullable<typeof l> => l !== null);
    expect(kept.some((l) => l.op === 'add' && l.text === 'CHANGED')).toBe(true);
  });

  it('keeps everything when the file is short', () => {
    const lines = diffLines('a\nb', 'a\nB');
    expect(collapseContext(lines, 3).every((l) => l !== null)).toBe(true);
  });

  it('emits one marker per elided run, not one per skipped line', () => {
    const before = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n');
    const after = before.replace('l5', 'X').replace('l50', 'Y');
    const lines = diffLines(before, after);
    const collapsed = collapseContext(lines, 1);
    const nulls = collapsed.filter((l) => l === null).length;

    // Two change regions in the middle of the file means three unchanged runs:
    // before the first, between them, and after the last.
    expect(nulls).toBe(3);
    // Far fewer rows than the ~50 unchanged lines those runs stand in for.
    expect(collapsed.length).toBeLessThan(lines.length / 2);
  });
});

describe('diffFromToolInput', () => {
  it('reads an Edit as before/after', () => {
    expect(diffFromToolInput('Edit', { old_string: 'a', new_string: 'b' })).toEqual({
      before: 'a',
      after: 'b',
    });
  });

  it('renders a Write as all additions, since there is no client-side before', () => {
    expect(diffFromToolInput('Write', { content: 'hello' })).toEqual({ before: '', after: 'hello' });
  });

  it('returns null for tools that are not edits', () => {
    expect(diffFromToolInput('Bash', { command: 'ls' })).toBeNull();
    expect(diffFromToolInput('Read', { file_path: '/a' })).toBeNull();
    expect(diffFromToolInput('Edit', { old_string: 'a' })).toBeNull();
  });
});
