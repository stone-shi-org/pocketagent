/**
 * A minimal line diff, written by hand rather than pulled in as a dependency.
 *
 * The only consumer is the Edit/Write tool card, where inputs are a few hundred
 * lines at most. A full diff library would be more code than this and buy
 * nothing at that size.
 */

import type { DocRedlineBlock, DocRedlineSegment } from '@pocketagent/protocol';

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
  // PA-121: the Pocket Agent's own file tools. `edit_file` carries a list of
  // replacements; they are shown as one diff, separated by a marker line,
  // which is what a human approving the call needs to see.
  if (name === 'edit_file' && Array.isArray(input.edits)) {
    const edits = (input.edits as unknown[]).filter(
      (e): e is { oldText: string; newText: string } =>
        !!e && typeof (e as { oldText?: unknown }).oldText === 'string' && typeof (e as { newText?: unknown }).newText === 'string',
    );
    if (edits.length > 0) {
      return {
        before: edits.map((e) => e.oldText).join('\n⋯\n'),
        after: edits.map((e) => e.newText).join('\n⋯\n'),
      };
    }
  }
  if (name === 'write_file') {
    const after = str(input.content);
    if (after !== null) return { before: '', after };
  }
  // PA-140 / PA-145: `sheet_edit`, `doc_edit`, `create_sheet`, `create_doc`, and
  // `export_pdf` carry a server-computed `_diff` (`{ before, after }`); fall back
  // to formatting `input` client-side if `_diff` is absent.
  const rawDiff = input._diff;
  if (rawDiff && typeof rawDiff === 'object') {
    const before = str((rawDiff as { before?: unknown }).before);
    const after = str((rawDiff as { after?: unknown }).after);
    if (before !== null && after !== null) return { before, after };
  }
  if (name === 'sheet_edit') {
    if (Array.isArray(input.edits)) {
      const beforeLines: string[] = [];
      const afterLines: string[] = [];
      for (const raw of input.edits as unknown[]) {
        if (!raw || typeof raw !== 'object') continue;
        const edit = raw as Record<string, unknown>;
        if (edit.op === 'add_sheet' && typeof edit.name === 'string') {
          beforeLines.push('(sheets)');
          afterLines.push(`(sheets) + ${edit.name}`);
        } else if (edit.op === 'append_table_rows' && typeof edit.table === 'string') {
          const count = Array.isArray(edit.rows) ? edit.rows.length : 0;
          beforeLines.push(`Table ${edit.table}`);
          afterLines.push(`Table ${edit.table}: +${count} row(s)`);
        } else if (typeof edit.sheet === 'string' && typeof edit.cell === 'string') {
          const ref = `${edit.sheet}!${edit.cell}`;
          beforeLines.push(`${ref}: (current)`);
          const nextDesc =
            edit.clear === true
              ? '(empty)'
              : typeof edit.formula === 'string'
                ? edit.formula.startsWith('=')
                  ? edit.formula
                  : `=${edit.formula}`
                : edit.value !== undefined
                  ? JSON.stringify(edit.value)
                  : '(unchanged)';
          const fmtSuffix = typeof edit.numFmt === 'string' && edit.numFmt ? ` [numFmt: ${edit.numFmt}]` : '';
          afterLines.push(`${ref}: ${nextDesc}${fmtSuffix}`);
        }
      }
      if (afterLines.length > 0) {
        return { before: beforeLines.join('\n'), after: afterLines.join('\n') };
      }
    }
  }
  if (name === 'doc_edit' && Array.isArray(input.edits)) {
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    for (const raw of input.edits as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const edit = raw as Record<string, unknown>;
      const loc = typeof edit.paragraphId === 'string' ? `[${edit.paragraphId}] ` : '';
      if (edit.op === 'replace_text') {
        beforeLines.push(`${loc}${str(edit.target) ?? ''}`);
        afterLines.push(`${loc}${str(edit.replacement) ?? ''}`);
      } else if (edit.op === 'insert_text') {
        beforeLines.push(`${loc}${str(edit.anchor) ?? ''}`);
        afterLines.push(`${loc}${str(edit.text) ?? ''}`);
      } else if (edit.op === 'delete_text') {
        beforeLines.push(`${loc}${str(edit.target) ?? ''}`);
        afterLines.push(`${loc}(deleted)`);
      } else if (edit.op === 'set_table_cell') {
        const ref = `[table ${String(edit.tableIndex ?? 0)} r${String(edit.row ?? 0)}c${String(edit.col ?? 0)}]`;
        beforeLines.push(`${ref}: (current)`);
        afterLines.push(`${ref}: ${str(edit.text) ?? ''}`);
      } else if (edit.op === 'add_comment') {
        beforeLines.push(`${loc}${str(edit.target) ?? ''}`);
        afterLines.push(`${loc}[Comment: ${str(edit.comment) ?? ''}]`);
      }
    }
    if (afterLines.length > 0) {
      return { before: beforeLines.join('\n'), after: afterLines.join('\n') };
    }
  }
  if (name === 'create_doc') {
    const md = str(input.markdown);
    if (md !== null) return { before: '', after: md };
  }
  if (name === 'create_sheet' && Array.isArray(input.sheets)) {
    const lines: string[] = [];
    for (const raw of input.sheets as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const rowCount = Array.isArray(s.rows) ? s.rows.length : 0;
      lines.push(`Sheet "${str(s.name) ?? 'Sheet'}": ${rowCount} row(s)`);
    }
    if (lines.length > 0) return { before: '', after: lines.join('\n') };
  }
  if (name === 'export_pdf') {
    const src = str(input.source);
    if (src !== null) {
      const out = str(input.output) ?? '(PDF)';
      return { before: '', after: `Export ${src} → ${out}` };
    }
  }
  if (name === 'NotebookEdit') {
    const after = str(input.new_source);
    if (after !== null) return { before: str(input.old_source) ?? '', after };
  }
  return null;
}

/**
 * PA-145: Extract redline blocks (`deleted` struck, `inserted` underlined,
 * `comment` badged) from a `doc_edit` call's input. Uses the server-computed
 * `_redline` when available, falling back to synthesizing redline blocks from
 * `input.edits`.
 */
export function redlineFromToolInput(
  name: string,
  input: Record<string, unknown>,
): DocRedlineBlock[] | null {
  if (name !== 'doc_edit') return null;
  if (Array.isArray(input._redline) && input._redline.length > 0) {
    return input._redline as DocRedlineBlock[];
  }
  if (!Array.isArray(input.edits) || input.edits.length === 0) return null;
  const blocks: DocRedlineBlock[] = [];
  let idx = 0;
  for (const raw of input.edits as unknown[]) {
    idx++;
    if (!raw || typeof raw !== 'object') continue;
    const edit = raw as Record<string, unknown>;
    const location =
      typeof edit.paragraphId === 'string' && edit.paragraphId
        ? edit.paragraphId
        : edit.op === 'set_table_cell'
          ? `table ${String(edit.tableIndex ?? 0)} r${String(edit.row ?? 0)}c${String(edit.col ?? 0)}`
          : null;
    const segments: DocRedlineSegment[] = [];
    if (edit.op === 'replace_text') {
      if (typeof edit.target === 'string' && edit.target) {
        segments.push({ type: 'del', text: edit.target });
      }
      if (typeof edit.replacement === 'string' && edit.replacement) {
        segments.push({ type: 'ins', text: edit.replacement });
      }
    } else if (edit.op === 'insert_text') {
      if (typeof edit.anchor === 'string' && edit.anchor) {
        segments.push({ type: 'text', text: edit.anchor });
      }
      if (typeof edit.text === 'string' && edit.text) {
        segments.push({ type: 'ins', text: edit.text });
      }
    } else if (edit.op === 'delete_text') {
      if (typeof edit.target === 'string' && edit.target) {
        segments.push({ type: 'del', text: edit.target });
      }
    } else if (edit.op === 'set_table_cell') {
      if (typeof edit.text === 'string') {
        segments.push({ type: 'ins', text: edit.text });
      }
    } else if (edit.op === 'add_comment') {
      if (typeof edit.target === 'string' && edit.target) {
        segments.push({ type: 'text', text: edit.target });
      }
      if (typeof edit.comment === 'string' && edit.comment) {
        segments.push({ type: 'comment', text: edit.comment });
      }
    }
    if (segments.length > 0) {
      blocks.push({
        id: typeof edit.paragraphId === 'string' && edit.paragraphId ? edit.paragraphId : `edit-${idx}`,
        ...(location ? { location } : {}),
        segments,
      });
    }
  }
  return blocks.length > 0 ? blocks : null;
}

/**
 * PA-145: Extract an Office lock warning (`~$book.xlsx` / `~$doc.docx`) from
 * a tool call's input when present.
 */
export function lockWarningFromToolInput(input: Record<string, unknown>): string | null {
  return typeof input._lockWarning === 'string' && input._lockWarning.trim()
    ? input._lockWarning.trim()
    : null;
}

