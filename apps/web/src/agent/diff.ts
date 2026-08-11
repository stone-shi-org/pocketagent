/**
 * A minimal line diff, written by hand rather than pulled in as a dependency.
 *
 * The only consumer is the Edit/Write tool card, where inputs are a few hundred
 * lines at most. A full diff library would be more code than this and buy
 * nothing at that size.
 */

export type DiffOp = 'context' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old text, null for additions. */
  oldLine: number | null;
  /** 1-based line number in the new text, null for removals. */
  newLine: number | null;
}

/** Longest-common-subsequence line diff. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.length === 0 ? [] : before.split('\n');
  const b = after.length === 0 ? [] : after.split('\n');

  // lcs[i][j] = length of the LCS of a[i:] and b[j:]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'context', text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: 'remove', text: a[i]!, oldLine: i + 1, newLine: null });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]!, oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < a.length) {
    out.push({ op: 'remove', text: a[i]!, oldLine: i + 1, newLine: null });
    i++;
  }
  while (j < b.length) {
    out.push({ op: 'add', text: b[j]!, oldLine: null, newLine: j + 1 });
    j++;
  }
  return out;
}

/**
 * Drop long runs of unchanged lines, keeping `context` lines around each change.
 * Returns the kept lines with `null` marking an elision.
 */
export function collapseContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.op === 'context') return;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < lines.length) keep.add(k);
    }
  });

  const out: (DiffLine | null)[] = [];
  let elided = false;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      out.push(line);
      elided = false;
    } else if (!elided) {
      out.push(null);
      elided = true;
    }
  });
  return out;
}

export interface DiffStat {
  added: number;
  removed: number;
}

export function diffStat(lines: DiffLine[]): DiffStat {
  return {
    added: lines.filter((l) => l.op === 'add').length,
    removed: lines.filter((l) => l.op === 'remove').length,
  };
}

/**
 * Extract a before/after pair from a tool call's input, when the tool is one
 * whose shape we understand. Returns null for tools that are not edits.
 */
export function diffFromToolInput(
  name: string,
  input: Record<string, unknown>,
): { before: string; after: string } | null {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

  if (name === 'Edit') {
    const before = str(input.old_string);
    const after = str(input.new_string);
    if (before !== null && after !== null) return { before, after };
  }
  if (name === 'Write') {
    const after = str(input.content) ?? str(input.file_text);
    // A Write has no "before" available client-side; render it as all-additions.
    if (after !== null) return { before: '', after };
  }
  if (name === 'NotebookEdit') {
    const after = str(input.new_source);
    if (after !== null) return { before: str(input.old_source) ?? '', after };
  }
  return null;
}
