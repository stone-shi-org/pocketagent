/**
 * PA-121: the pure half of the planner's `edit_file` tool — find each
 * `oldText` in a file and replace it with `newText`.
 *
 * Before this the planner's only way to change a file was `write_file`,
 * which sends the whole file back: a one-line fix to a 3 000-line file cost
 * the model 3 000 lines of output tokens, ran into the output limit on any
 * large file, and every unchanged line it re-typed was a chance to silently
 * corrupt one. pi's `edit` tool (`coding-agent/src/core/tools/edit.ts`) is
 * the model here, and its rules are the ones worth keeping:
 *
 * - **Every `oldText` must occur exactly once**, so an edit can never land
 *   somewhere the model did not mean; a miss or a duplicate is an error that
 *   says which, so the model can add context and try again.
 * - **All edits are matched against the original file**, not one after
 *   another, and overlapping edits are refused — the result does not depend
 *   on the order the model happened to list them in.
 * - **Exact first, then a tolerant match.** Models reproduce text with
 *   trailing whitespace dropped, curly quotes straightened and dashes
 *   normalised; a tolerant match (`normalizeForMatch`) finds that text
 *   anyway, and only the lines the edit touches are rewritten — every other
 *   byte of the file is left exactly as it was.
 * - **Line endings and a BOM survive.** A CRLF file stays CRLF.
 */

export interface FileEdit {
  oldText: string;
  newText: string;
}

export type EditOutcome =
  | { ok: true; content: string; replaced: number; firstChangedLine: number }
  | { ok: false; message: string };

/**
 * The `edits` argument in the shapes models actually send, coerced to a list
 * (pi's `prepareArguments` shims): an array, an array serialized as a JSON
 * string, a single `{oldText, newText}` object, or `oldText`/`newText` at the
 * top level of the call. `null` when none of those fit.
 */
export function normalizeEditsArgument(args: Record<string, unknown>): FileEdit[] | null {
  let edits: unknown = args.edits;
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits);
    } catch {
      return null;
    }
  }
  if (edits === undefined && typeof args.oldText === 'string') {
    edits = [{ oldText: args.oldText, newText: args.newText }];
  }
  if (edits && typeof edits === 'object' && !Array.isArray(edits)) edits = [edits];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const out: FileEdit[] = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') return null;
    const { oldText, newText } = edit as Record<string, unknown>;
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null;
    out.push({ oldText, newText });
  }
  return out;
}

/**
 * Lowers the bar for "the same text" to what a model reliably reproduces:
 * NFKC, trailing whitespace on every line removed, typographic quotes,
 * dashes and spaces mapped to their ASCII forms. pi's
 * `normalizeForFuzzyMatch`. Line structure is preserved exactly — the
 * mapping back to the original relies on it.
 */
function normalizeLine(line: string): string {
  return line
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ')
    .replace(/[ \t]+$/, '');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + 1)) count += 1;
  return count;
}

/** Where one edit applies, in the original (LF-normalized) text. */
interface Match {
  start: number;
  end: number;
  newText: string;
}

/**
 * Finds `oldText` in `content`: exactly, or else line by line under
 * `normalizeLine`. A tolerant match is always widened to whole lines — the
 * lines it spans are replaced, which is what "rewrite only the lines the
 * edit touches" means.
 */
function findMatch(content: string, edit: FileEdit): { match: Match } | { error: 'missing' | 'ambiguous'; count?: number } {
  const exact = countOccurrences(content, edit.oldText);
  if (exact === 1) {
    const start = content.indexOf(edit.oldText);
    return { match: { start, end: start + edit.oldText.length, newText: edit.newText } };
  }
  if (exact > 1) return { error: 'ambiguous', count: exact };

  const lines = content.split('\n');
  const target = edit.oldText.split('\n').map(normalizeLine);
  // A trailing newline in oldText leaves an empty last element, which says
  // "to the end of the line before" and has no content of its own to match.
  while (target.length > 1 && target[target.length - 1] === '') target.pop();
  if (target.every((l) => l === '')) return { error: 'missing' };

  const hits: Array<{ line: number; prefix: string; suffix: string }> = [];
  for (let i = 0; i + target.length <= lines.length; i++) {
    const hit = matchAt(lines, i, target);
    if (hit) hits.push({ line: i, ...hit });
  }
  if (hits.length === 0) return { error: 'missing' };
  if (hits.length > 1) return { error: 'ambiguous', count: hits.length };

  const { line: first, prefix, suffix } = hits[0]!;
  const last = first + target.length - 1;
  let start = 0;
  for (let i = 0; i < first; i++) start += lines[i]!.length + 1;
  let end = start;
  for (let i = first; i <= last; i++) end += lines[i]!.length + (i < last ? 1 : 0);
  // The lines spanned are rebuilt from the original: the untouched text
  // before the match on its first line and after it on its last is kept
  // byte for byte, and only what the model quoted is replaced.
  // The tolerant match never includes the newline that ends its last line,
  // so a trailing newline the model put on both texts is dropped from the
  // replacement too — otherwise every such edit would add a blank line.
  const newText =
    edit.oldText.endsWith('\n') && edit.newText.endsWith('\n') ? edit.newText.slice(0, -1) : edit.newText;
  return { match: { start, end, newText: `${prefix}${newText}${suffix}` } };
}

/**
 * Whether the normalized `target` lines match `lines` starting at `at`, and
 * if so the original text before and after the match. The first and last
 * lines may match partially (a model often quotes from mid-line); inner lines
 * must match whole. A partial match is only trusted where normalization kept
 * the line's shape — the same length once trailing whitespace is dropped — so
 * a position in the normalized line is the same position in the original.
 */
function matchAt(lines: readonly string[], at: number, target: readonly string[]): { prefix: string; suffix: string } | null {
  const sameShape = (orig: string, norm: string): boolean => norm.length === orig.replace(/[ \t]+$/, '').length;
  if (target.length === 1) {
    const orig = lines[at]!;
    const norm = normalizeLine(orig);
    const want = target[0]!;
    if (norm === want) return { prefix: '', suffix: '' };
    if (!sameShape(orig, norm)) return null;
    const pos = norm.indexOf(want);
    if (pos < 0 || norm.indexOf(want, pos + 1) >= 0) return null;
    return { prefix: orig.slice(0, pos), suffix: orig.slice(pos + want.length) };
  }
  let prefix = '';
  let suffix = '';
  for (let j = 0; j < target.length; j++) {
    const orig = lines[at + j]!;
    const norm = normalizeLine(orig);
    const want = target[j]!;
    if (norm === want) continue;
    if (j === 0 && norm.endsWith(want) && sameShape(orig, norm)) {
      prefix = orig.slice(0, norm.length - want.length);
    } else if (j === target.length - 1 && norm.startsWith(want) && sameShape(orig, norm)) {
      suffix = orig.slice(want.length);
    } else {
      return null;
    }
  }
  return { prefix, suffix };
}

/**
 * Applies `edits` to `fileContent`. Pure: the caller reads and writes the
 * file. Every failure says what to do about it, because the model reads it.
 */
export function applyEdits(fileContent: string, edits: readonly FileEdit[], displayPath: string): EditOutcome {
  const bom = fileContent.startsWith('\uFEFF') ? '\uFEFF' : '';
  const raw = bom ? fileContent.slice(1) : fileContent;
  const crlf = raw.includes('\r\n');
  const content = crlf ? raw.replace(/\r\n/g, '\n') : raw;

  const matches: Array<Match & { index: number }> = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = {
      oldText: edits[i]!.oldText.replace(/\r\n/g, '\n'),
      newText: edits[i]!.newText.replace(/\r\n/g, '\n'),
    };
    const label = edits.length > 1 ? `edits[${i}]` : 'oldText';
    if (edit.oldText.length === 0) {
      return { ok: false, message: `${label} is empty. To create or replace a whole file, use write_file.` };
    }
    const found = findMatch(content, edit);
    if ('error' in found) {
      return {
        ok: false,
        message:
          found.error === 'missing'
            ? `Could not find ${label} in ${displayPath}. It must match the file exactly, including whitespace ` +
              'and line breaks — read the file again and copy the text from it.'
            : `${label} occurs ${found.count} times in ${displayPath}; it must be unique. Include more of the ` +
              'surrounding lines so it matches only once.',
      };
    }
    matches.push({ ...found.match, index: i });
  }

  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      return {
        ok: false,
        message:
          `edits[${ordered[i - 1]!.index}] and edits[${ordered[i]!.index}] overlap in ${displayPath}. ` +
          'Merge them into one edit, or target separate parts of the file.',
      };
    }
  }

  let result = content;
  for (const m of [...ordered].reverse()) {
    result = result.slice(0, m.start) + m.newText + result.slice(m.end);
  }
  if (result === content) {
    return { ok: false, message: `No changes made to ${displayPath}: the replacement text is the same as the original.` };
  }
  const firstChangedLine = content.slice(0, ordered[0]!.start).split('\n').length;
  const restored = bom + (crlf ? result.replace(/\n/g, '\r\n') : result);
  return { ok: true, content: restored, replaced: matches.length, firstChangedLine };
}
