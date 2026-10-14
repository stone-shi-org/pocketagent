/**
 * PA-140: child-process worker for Pocket Agent spreadsheet tools
 * (`sheet_info`, `sheet_read`, `sheet_find`, `sheet_check`, `sheet_edit`).
 *
 * Runs in a forked child with an empty environment, no network, a hard wall
 * timeout, and an RSS watchdog — the same sandbox posture as
 * `attachments/extract-worker.ts`.
 *
 * Key invariants enforced here:
 * 1. Declared-size zip-bomb check before inflating any entry (`readZipSafe`).
 * 2. Refuses any XML entry containing `<!DOCTYPE` or `<!ENTITY` declarations.
 * 3. `sheet_edit` patches XML exclusively by byte/character offset spans from a
 *    streaming tokenizer (`scanXmlTags` / `findElements`), splicing right-to-left
 *    so untouched XML spans and untouched zip entries remain byte-identical.
 * 4. Strings written by `sheet_edit` use `t="inlineStr"` so `xl/sharedStrings.xml`
 *    is never re-indexed or modified.
 * 5. Shared formula groups (`t="shared"`) touched by an edit are expanded into
 *    standalone `<f>` elements before patching.
 * 6. Array formulas / dynamic spill ranges (`t="array"`, `cm=`) and row/column
 *    insertions or deletions are refused with a clear message.
 */

import * as fs from 'node:fs';
import type * as XlsxSharedModule from './xlsx-shared.js';
import type {
  ParsedSheetEntry,
  XlsxXfStyle,
} from './xlsx-shared.js';

let xlsxSharedPromise: Promise<typeof XlsxSharedModule> | null = null;
function loadXlsxShared(): Promise<typeof XlsxSharedModule> {
  if (!xlsxSharedPromise) {
    const specifier = new URL(
      import.meta.url.endsWith('.ts') ? './xlsx-shared.ts' : './xlsx-shared.js',
      import.meta.url,
    ).href;
    xlsxSharedPromise = import(specifier) as Promise<typeof XlsxSharedModule>;
  }
  return xlsxSharedPromise;
}

// ---- Worker IPC protocol -----------------------------------------------------

export interface SheetCellEditInput {
  op?: 'set_cell' | 'append_table_rows' | 'add_sheet';
  sheet?: string;
  cell?: string;
  value?: string | number | boolean | null;
  formula?: string;
  clear?: boolean;
  numFmt?: string;
  /** For `append_table_rows`: table name or displayName. */
  table?: string;
  /** For `append_table_rows`: rows of values (array per row or column-name map). */
  rows?: Array<Array<string | number | boolean | null> | Record<string, string | number | boolean | null>>;
  /** Alias for `rows` on table append. */
  appendRows?: Array<Array<string | number | boolean | null> | Record<string, string | number | boolean | null>>;
  /** Alias for `add_sheet`. */
  addSheet?: string;
  /** Sheet name for `add_sheet`. */
  name?: string;
}

export type SheetWorkerRequest =
  | {
      op: 'sheet_info';
      filePath: string;
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_read';
      filePath: string;
      sheet: string;
      range?: string | undefined;
      include?: string[] | undefined;
      maxLines?: number | undefined;
      maxBytes?: number | undefined;
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_find';
      filePath: string;
      query: string;
      scope?: 'values' | 'formulas' | 'both' | undefined;
      sheet?: string | undefined;
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_check';
      filePath: string;
      /** Optional path to a LibreOffice-recalculated copy of `filePath`. */
      recalculatedPath?: string | undefined;
      /** Whether headless LibreOffice was available on the host. */
      libreOfficeAvailable: boolean;
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_edit_preview';
      filePath: string;
      outputPath: string;
      edits: SheetCellEditInput[];
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_edit_apply';
      filePath: string;
      outputPath: string;
      edits: SheetCellEditInput[];
      maxUnzippedBytes: number;
      maxRssBytes: number;
    }
  | {
      op: 'sheet_edit_backpatch';
      originalPath: string;
      patchedPath: string;
      recalculatedPath: string;
      directlyEditedCells: string[];
      maxUnzippedBytes: number;
      maxRssBytes: number;
    };

export interface SheetDiffPayload {
  before: string;
  after: string;
  lines: string[];
}

export interface SheetDownstreamChange {
  sheet: string;
  cell: string;
  formula: string;
  before: string;
  after: string;
}

export interface SheetErrorCell {
  sheet: string;
  cell: string;
  error: string;
  formula?: string | undefined;
}

export type SheetWorkerResponse =
  | {
      ok: true;
      text: string;
      diff?: SheetDiffPayload | undefined;
      directlyEditedCells?: string[] | undefined;
      formulaChanged?: boolean | undefined;
      downstreamChanges?: SheetDownstreamChange[] | undefined;
      newErrors?: SheetErrorCell[] | undefined;
      warnings?: string[] | undefined;
    }
  | {
      ok: false;
      error: string;
    };

// ---- Security & XML Tokenizer ------------------------------------------------

const EXCEL_ERRORS = new Set([
  '#REF!',
  '#DIV/0!',
  '#NAME?',
  '#VALUE!',
  '#N/A',
  '#NUM!',
  '#NULL!',
  '#GETTING_DATA',
  '#CALC!',
  '#SPILL!',
]);

function isExcelError(val: string): boolean {
  return EXCEL_ERRORS.has(val.trim().toUpperCase());
}

/**
 * Refuses any XML text that declares a DOCTYPE or ENTITY. OOXML workbooks never
 * legitimately use DTDs or entity declarations, and rejecting them at the
 * boundary prevents XXE / billion-laughs payloads.
 */
export function assertNoXmlEntitiesOrDtd(xml: string, entryName = 'xml'): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(`Refusing ${entryName}: XML DOCTYPE and ENTITY declarations are not permitted.`);
  }
}

export interface XmlTagToken {
  kind: 'open' | 'close' | 'self';
  name: string;
  localName: string;
  attrs: string;
  start: number;
  end: number;
}

export interface XmlElementSpan {
  name: string;
  localName: string;
  attrs: string;
  openStart: number;
  openEnd: number;
  innerStart: number;
  innerEnd: number;
  closeStart: number;
  closeEnd: number;
  selfClosing: boolean;
}

export interface XmlSplice {
  start: number;
  end: number;
  replacement: string;
}

function stripPrefix(tagName: string): string {
  const colon = tagName.indexOf(':');
  return colon >= 0 ? tagName.slice(colon + 1) : tagName;
}

/**
 * Streaming tokenizer over `[rangeStart, rangeEnd)` of `xml`. Respects quoted
 * attributes (`"..."` and `'...'`), comments (`<!--...-->`), CDATA, and PIs so
 * `>` inside a formula attribute never terminates a tag early.
 */
export function* scanXmlTags(
  xml: string,
  rangeStart = 0,
  rangeEnd = xml.length,
): Generator<XmlTagToken, void, unknown> {
  let i = rangeStart;
  while (i < rangeEnd) {
    const lt = xml.indexOf('<', i);
    if (lt === -1 || lt >= rangeEnd) break;

    const next = xml.charCodeAt(lt + 1);
    // Comment `<!--` or CDATA `<![CDATA[` or other `<!`
    if (next === 33 /* '!' */) {
      if (xml.startsWith('<!--', lt)) {
        const endComment = xml.indexOf('-->', lt + 4);
        i = endComment === -1 ? rangeEnd : endComment + 3;
        continue;
      }
      if (xml.startsWith('<![CDATA[', lt)) {
        const endCdata = xml.indexOf(']]>', lt + 9);
        i = endCdata === -1 ? rangeEnd : endCdata + 3;
        continue;
      }
      const gt = xml.indexOf('>', lt + 2);
      i = gt === -1 ? rangeEnd : gt + 1;
      continue;
    }

    // Processing instruction `<?...?>`
    if (next === 63 /* '?' */) {
      const endPi = xml.indexOf('?>', lt + 2);
      i = endPi === -1 ? rangeEnd : endPi + 2;
      continue;
    }

    // Closing tag `</name>`
    if (next === 47 /* '/' */) {
      const gt = xml.indexOf('>', lt + 2);
      if (gt === -1 || gt >= rangeEnd) break;
      const name = xml.slice(lt + 2, gt).trim();
      yield {
        kind: 'close',
        name,
        localName: stripPrefix(name),
        attrs: '',
        start: lt,
        end: gt + 1,
      };
      i = gt + 1;
      continue;
    }

    // Opening or self-closing tag
    let p = lt + 1;
    while (p < rangeEnd) {
      const ch = xml.charCodeAt(p);
      if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 47 || ch === 62) break;
      p++;
    }
    const name = xml.slice(lt + 1, p);
    if (!name) {
      i = lt + 1;
      continue;
    }
    const attrsStart = p;
    let quote = 0;
    while (p < rangeEnd) {
      const ch = xml.charCodeAt(p);
      if (quote !== 0) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 /* '"' */ || ch === 39 /* "'" */) {
        quote = ch;
      } else if (ch === 62 /* '>' */) {
        break;
      }
      p++;
    }
    if (p >= rangeEnd) break;
    const selfClosing = xml.charCodeAt(p - 1) === 47 /* '/' */;
    const attrsEnd = selfClosing ? p - 1 : p;
    const attrs = xml.slice(attrsStart, attrsEnd);
    yield {
      kind: selfClosing ? 'self' : 'open',
      name,
      localName: stripPrefix(name),
      attrs,
      start: lt,
      end: p + 1,
    };
    i = p + 1;
  }
}

/**
 * Finds all elements matching `targetLocalName` within `[rangeStart, rangeEnd)`
 * and returns their exact character spans.
 */
export function findElements(
  xml: string,
  targetLocalName: string,
  rangeStart = 0,
  rangeEnd = xml.length,
): XmlElementSpan[] {
  const results: XmlElementSpan[] = [];
  const stack: XmlTagToken[] = [];
  for (const tok of scanXmlTags(xml, rangeStart, rangeEnd)) {
    if (tok.localName !== targetLocalName) continue;
    if (tok.kind === 'self') {
      if (stack.length === 0) {
        results.push({
          name: tok.name,
          localName: tok.localName,
          attrs: tok.attrs,
          openStart: tok.start,
          openEnd: tok.end,
          innerStart: tok.end,
          innerEnd: tok.end,
          closeStart: tok.end,
          closeEnd: tok.end,
          selfClosing: true,
        });
      }
    } else if (tok.kind === 'open') {
      stack.push(tok);
    } else if (tok.kind === 'close') {
      const open = stack.pop();
      if (open && stack.length === 0) {
        results.push({
          name: open.name,
          localName: open.localName,
          attrs: open.attrs,
          openStart: open.start,
          openEnd: open.end,
          innerStart: open.end,
          innerEnd: tok.start,
          closeStart: tok.start,
          closeEnd: tok.end,
          selfClosing: false,
        });
      }
    }
  }
  return results;
}

export function findFirstElement(
  xml: string,
  targetLocalName: string,
  rangeStart = 0,
  rangeEnd = xml.length,
): XmlElementSpan | null {
  let depth = 0;
  let openTok: XmlTagToken | null = null;
  for (const tok of scanXmlTags(xml, rangeStart, rangeEnd)) {
    if (tok.localName !== targetLocalName) continue;
    if (tok.kind === 'self') {
      if (depth === 0) {
        return {
          name: tok.name,
          localName: tok.localName,
          attrs: tok.attrs,
          openStart: tok.start,
          openEnd: tok.end,
          innerStart: tok.end,
          innerEnd: tok.end,
          closeStart: tok.end,
          closeEnd: tok.end,
          selfClosing: true,
        };
      }
    } else if (tok.kind === 'open') {
      if (depth === 0) openTok = tok;
      depth++;
    } else if (tok.kind === 'close') {
      depth--;
      if (depth === 0 && openTok) {
        return {
          name: openTok.name,
          localName: openTok.localName,
          attrs: openTok.attrs,
          openStart: openTok.start,
          openEnd: openTok.end,
          innerStart: openTok.end,
          innerEnd: tok.start,
          closeStart: tok.start,
          closeEnd: tok.end,
          selfClosing: false,
        };
      }
    }
  }
  return null;
}

/**
 * Applies non-overlapping splices to `xml` in descending offset order so
 * untouched spans remain byte-for-byte identical.
 */
export function applyXmlSplices(xml: string, splices: XmlSplice[]): string {
  if (splices.length === 0) return xml;
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (curr.end > prev.start) {
      throw new Error(
        `Internal XML patch error: overlapping splices [${curr.start}, ${curr.end}) and [${prev.start}, ${prev.end}).`,
      );
    }
  }
  let out = xml;
  for (const s of sorted) {
    out = out.slice(0, s.start) + s.replacement + out.slice(s.end);
  }
  return out;
}

function getAttr(attrs: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

/**
 * Produces a splice that updates/adds/removes attributes on `span`'s opening
 * tag without touching its children or closing tag.
 */
export function patchOpeningTagAttrs(
  xml: string,
  span: XmlElementSpan,
  updates: Record<string, string | null>,
  xmlEscapeFn: (s: string) => string,
): XmlSplice {
  let openTag = xml.slice(span.openStart, span.openEnd);
  for (const [attrName, attrVal] of Object.entries(updates)) {
    const escaped = attrName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existingRe = new RegExp(`(\\s+${escaped}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
    if (attrVal === null) {
      openTag = openTag.replace(existingRe, '');
    } else if (existingRe.test(openTag)) {
      openTag = openTag.replace(existingRe, `$1"${xmlEscapeFn(attrVal)}"`);
    } else {
      const insertPos = openTag.endsWith('/>') ? openTag.length - 2 : openTag.length - 1;
      openTag = `${openTag.slice(0, insertPos)} ${attrName}="${xmlEscapeFn(attrVal)}"${openTag.slice(insertPos)}`;
    }
  }
  return {
    start: span.openStart,
    end: span.openEnd,
    replacement: openTag,
  };
}

// ---- Formula Reference Shifting (Shared Formulas & Table Calculated Cols) ----

/**
 * Shifts relative A1 cell references in `formula` by `(dRow, dCol)`.
 * Respects string literals (`"..."`), quoted sheet names (`'...'`), structured
 * table references (`[...]`), unquoted sheet prefixes (`Q1!`), and function
 * names (`LOG10(`).
 */
function localColumnIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i);
    const upper = code >= 97 && code <= 122 ? code - 32 : code;
    n = n * 26 + (upper - 64);
  }
  return n - 1;
}

function localColumnLetters(colIdx: number): string {
  let c = colIdx + 1;
  let out = '';
  while (c > 0) {
    const rem = (c - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    c = Math.floor((c - 1) / 26);
  }
  return out;
}

export function shiftFormulaReferences(
  formula: string,
  dRow: number,
  dCol: number,
): string {
  if (dRow === 0 && dCol === 0) return formula;
  const columnIndex = localColumnIndex;
  const columnLetters = localColumnLetters;

  let out = '';
  let i = 0;
  const len = formula.length;

  while (i < len) {
    const ch = formula[i]!;
    // Double-quoted string literal
    if (ch === '"') {
      let end = i + 1;
      while (end < len) {
        if (formula[end] === '"') {
          if (formula[end + 1] === '"') {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      out += formula.slice(i, end);
      i = end;
      continue;
    }
    // Single-quoted sheet reference `'Sheet Name'!`
    if (ch === "'") {
      let end = i + 1;
      while (end < len) {
        if (formula[end] === "'") {
          if (formula[end + 1] === "'") {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      out += formula.slice(i, end);
      i = end;
      continue;
    }
    // Structured reference `[...]`
    if (ch === '[') {
      let depth = 1;
      let end = i + 1;
      while (end < len && depth > 0) {
        if (formula[end] === '[') depth++;
        else if (formula[end] === ']') depth--;
        end++;
      }
      out += formula.slice(i, end);
      i = end;
      continue;
    }

    const prevCh = i > 0 ? formula[i - 1]! : '';
    if (!/[A-Za-z0-9_.]/.test(prevCh)) {
      const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)/.exec(formula.slice(i));
      if (m) {
        const whole = m[0]!;
        const afterCh = formula[i + whole.length] ?? '';
        // Skip function names (`LOG10(`), unquoted sheet names (`Q1!`), or identifiers.
        if (afterCh !== '(' && afterCh !== '!' && !/[A-Za-z0-9_.]/.test(afterCh)) {
          const absCol = m[1] === '$';
          const colStr = m[2]!.toUpperCase();
          const absRow = m[3] === '$';
          const rowNum = Number(m[4]);
          const colIdx = columnIndex(colStr);
          if (colIdx >= 0 && colIdx < 16_384 && rowNum >= 1 && rowNum <= 1_048_576) {
            const newCol = absCol ? colIdx : colIdx + dCol;
            const newRow = absRow ? rowNum : rowNum + dRow;
            if (newCol < 0 || newCol >= 16_384 || newRow < 1 || newRow > 1_048_576) {
              out += '#REF!';
            } else {
              out += `${absCol ? '$' : ''}${columnLetters(newCol)}${absRow ? '$' : ''}${newRow}`;
            }
            i += whole.length;
            continue;
          }
        }
      }
    }

    out += ch;
    i++;
  }
  return out;
}

// ---- Worksheet Cell Parsing --------------------------------------------------

export interface ParsedWorksheetCell {
  ref: string;
  row: number;
  col: number;
  type: string;
  styleIdx?: number | undefined;
  style?: XlsxXfStyle | undefined;
  rawValue: string;
  value: string | number | boolean | null;
  formatted: string;
  formula?: string | undefined;
  formulaType?: 'normal' | 'shared' | 'array' | undefined;
  sharedIndex?: number | undefined;
  formulaRef?: string | undefined;
  cm?: string | undefined;
  span: XmlElementSpan;
}

export interface SharedFormulaMaster {
  si: number;
  masterRef: string;
  masterRow: number;
  masterCol: number;
  refRange: string;
  formula: string;
}

export interface ParsedWorksheet {
  cellsByRef: Map<string, ParsedWorksheetCell>;
  cellsInOrder: ParsedWorksheetCell[];
  sharedMasters: Map<number, SharedFormulaMaster>;
  sharedMembers: Map<number, ParsedWorksheetCell[]>;
  arrayRanges: Array<{ ref: string; startCol: number; startRow: number; endCol: number; endRow: number }>;
  merges: string[];
  usedRange: string | null;
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

async function parseWorksheet(
  xml: string,
  sharedStrings: string[],
  xfStyles: XlsxXfStyle[],
  date1904: boolean,
): Promise<ParsedWorksheet> {
  assertNoXmlEntitiesOrDtd(xml, 'worksheet');
  const {
    decodeXml,
    runs,
    columnLetters,
    parseCellRef,
    parseRangeRef,
    formatXlsxNumber,
  } = await loadXlsxShared();

  const cellsByRef = new Map<string, ParsedWorksheetCell>();
  const cellsInOrder: ParsedWorksheetCell[] = [];
  const sharedMasters = new Map<number, SharedFormulaMaster>();
  const sharedMembers = new Map<number, ParsedWorksheetCell[]>();
  const arrayRanges: Array<{ ref: string; startCol: number; startRow: number; endCol: number; endRow: number }> = [];
  const merges: string[] = [];

  for (const mc of findElements(xml, 'mergeCell')) {
    const ref = getAttr(mc.attrs, 'ref');
    if (ref) merges.push(ref);
  }

  const dimSpan = findFirstElement(xml, 'dimension');
  const declaredDim = dimSpan ? getAttr(dimSpan.attrs, 'ref') : undefined;

  let minRow = Infinity;
  let maxRow = 0;
  let minCol = Infinity;
  let maxCol = -1;

  const sheetDataSpan = findFirstElement(xml, 'sheetData');
  const rowSpans = sheetDataSpan && !sheetDataSpan.selfClosing
    ? findElements(xml, 'row', sheetDataSpan.innerStart, sheetDataSpan.innerEnd)
    : [];

  let lastRowNum = 0;
  for (const rowSpan of rowSpans) {
    const declaredRow = Number(getAttr(rowSpan.attrs, 'r') ?? 0);
    const rowNum = declaredRow > 0 ? declaredRow : lastRowNum + 1;
    lastRowNum = rowNum;
    if (rowSpan.selfClosing) continue;

    const cSpans = findElements(xml, 'c', rowSpan.innerStart, rowSpan.innerEnd);
    let nextCol = 0;
    for (const cSpan of cSpans) {
      const rAttr = getAttr(cSpan.attrs, 'r');
      const parsedCoord = rAttr ? parseCellRef(rAttr) : null;
      const col = parsedCoord ? parsedCoord.col : nextCol;
      const row = parsedCoord ? parsedCoord.row : rowNum;
      nextCol = col + 1;
      const cellRef = `${columnLetters(col)}${row}`;

      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;

      const type = getAttr(cSpan.attrs, 't') ?? 'n';
      const sAttr = getAttr(cSpan.attrs, 's');
      const styleIdx = sAttr !== undefined ? Number(sAttr) : undefined;
      const style = styleIdx !== undefined ? xfStyles[styleIdx] : undefined;
      const cm = getAttr(cSpan.attrs, 'cm');

      const body = cSpan.selfClosing ? '' : xml.slice(cSpan.innerStart, cSpan.innerEnd);
      const fSpan = cSpan.selfClosing ? null : findFirstElement(xml, 'f', cSpan.innerStart, cSpan.innerEnd);
      const vSpan = cSpan.selfClosing ? null : findFirstElement(xml, 'v', cSpan.innerStart, cSpan.innerEnd);

      let formula: string | undefined;
      let formulaType: 'normal' | 'shared' | 'array' | undefined;
      let sharedIndex: number | undefined;
      let formulaRef: string | undefined;

      if (fSpan) {
        const fType = getAttr(fSpan.attrs, 't');
        const siAttr = getAttr(fSpan.attrs, 'si');
        formulaRef = getAttr(fSpan.attrs, 'ref');
        if (siAttr !== undefined) sharedIndex = Number(siAttr);
        if (fType === 'shared') formulaType = 'shared';
        else if (fType === 'array') formulaType = 'array';
        else formulaType = 'normal';

        const fText = fSpan.selfClosing ? '' : decodeXml(xml.slice(fSpan.innerStart, fSpan.innerEnd)).trim();
        formula = fText;

        if (formulaType === 'shared' && sharedIndex !== undefined && fText) {
          sharedMasters.set(sharedIndex, {
            si: sharedIndex,
            masterRef: cellRef,
            masterRow: row,
            masterCol: col,
            refRange: formulaRef ?? cellRef,
            formula: fText,
          });
        }
        if (formulaType === 'array') {
          const arrRef = formulaRef ?? cellRef;
          const pr = parseRangeRef(arrRef);
          if (pr) {
            arrayRanges.push({
              ref: arrRef,
              startCol: pr.startCol,
              startRow: pr.startRow,
              endCol: pr.endCol,
              endRow: pr.endRow,
            });
          }
        }
      }

      let rawValue = '';
      let value: string | number | boolean | null = null;
      let formatted = '';

      if (type === 'inlineStr') {
        rawValue = runs(body, 't');
        value = rawValue;
        formatted = rawValue;
      } else if (vSpan && !vSpan.selfClosing) {
        rawValue = decodeXml(xml.slice(vSpan.innerStart, vSpan.innerEnd));
        if (type === 's') {
          const sVal = sharedStrings[Number(rawValue)] ?? '';
          value = sVal;
          formatted = sVal;
        } else if (type === 'b') {
          value = rawValue === '1' || rawValue.toUpperCase() === 'TRUE';
          formatted = value ? 'TRUE' : 'FALSE';
        } else if (type === 'e') {
          value = rawValue;
          formatted = rawValue;
        } else if (type === 'str') {
          value = rawValue;
          formatted = rawValue;
        } else {
          const num = Number(rawValue);
          value = Number.isFinite(num) && rawValue.trim() !== '' ? num : rawValue || null;
          formatted = formatXlsxNumber(rawValue, style?.style, date1904, { thousands: true });
        }
      }

      const cellObj: ParsedWorksheetCell = {
        ref: cellRef,
        row,
        col,
        type,
        ...(styleIdx !== undefined ? { styleIdx } : {}),
        ...(style !== undefined ? { style } : {}),
        rawValue,
        value,
        formatted,
        ...(formula !== undefined ? { formula } : {}),
        ...(formulaType !== undefined ? { formulaType } : {}),
        ...(sharedIndex !== undefined ? { sharedIndex } : {}),
        ...(formulaRef !== undefined ? { formulaRef } : {}),
        ...(cm !== undefined ? { cm } : {}),
        span: cSpan,
      };

      cellsByRef.set(cellRef, cellObj);
      cellsInOrder.push(cellObj);
      if (formulaType === 'shared' && sharedIndex !== undefined) {
        const list = sharedMembers.get(sharedIndex) ?? [];
        list.push(cellObj);
        sharedMembers.set(sharedIndex, list);
      }
    }
  }

  // Second pass: expand shared follower formulas using their master's formula.
  for (const [si, members] of sharedMembers.entries()) {
    const master = sharedMasters.get(si);
    if (!master) continue;
    for (const member of members) {
      if (member.ref === master.masterRef && member.formula) continue;
      member.formula = await shiftFormulaReferences(
        master.formula,
        member.row - master.masterRow,
        member.col - master.masterCol,
      );
    }
  }

  let usedRange: string | null = null;
  if (maxCol >= 0 && maxRow >= 1) {
    let sCol = minCol;
    let sRow = minRow;
    let eCol = maxCol;
    let eRow = maxRow;
    if (declaredDim) {
      const pr = parseRangeRef(declaredDim);
      if (pr) {
        sCol = Math.min(sCol, pr.startCol);
        sRow = Math.min(sRow, pr.startRow);
        eCol = Math.max(eCol, pr.endCol);
        eRow = Math.max(eRow, pr.endRow);
      }
    }
    usedRange = `${columnLetters(sCol)}${sRow}:${columnLetters(eCol)}${eRow}`;
  } else if (declaredDim) {
    usedRange = declaredDim;
  }

  return {
    cellsByRef,
    cellsInOrder,
    sharedMasters,
    sharedMembers,
    arrayRanges,
    merges,
    usedRange,
    minRow: minRow === Infinity ? 0 : minRow,
    maxRow,
    minCol: minCol === Infinity ? 0 : minCol,
    maxCol: maxCol < 0 ? 0 : maxCol,
  };
}

function findSheetByName(sheets: ParsedSheetEntry[], targetName: string): ParsedSheetEntry | null {
  const exact = sheets.find((s) => s.name === targetName);
  if (exact) return exact;
  const lower = targetName.trim().toLowerCase();
  return sheets.find((s) => s.name.toLowerCase() === lower) ?? null;
}

function resolveRelTarget(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const parts = [...baseDir.split('/').filter(Boolean), ...target.split('/')];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') resolved.pop();
    else resolved.push(part);
  }
  return resolved.join('/');
}

function parseRelsMap(relsXml: string, baseDir: string): Map<string, { type: string; target: string }> {
  assertNoXmlEntitiesOrDtd(relsXml, 'rels');
  const map = new Map<string, { type: string; target: string }>();
  for (const r of findElements(relsXml, 'Relationship')) {
    const id = getAttr(r.attrs, 'Id');
    const type = getAttr(r.attrs, 'Type') ?? '';
    const rawTarget = getAttr(r.attrs, 'Target') ?? '';
    const targetMode = getAttr(r.attrs, 'TargetMode');
    if (id && rawTarget) {
      const target = targetMode === 'External' ? rawTarget : resolveRelTarget(baseDir, rawTarget);
      map.set(id, { type, target });
    }
  }
  return map;
}

// ---- Tool 1: sheet_info ------------------------------------------------------

export async function runSheetInfo(
  files: Record<string, Uint8Array>,
): Promise<string> {
  const {
    utf8,
    decodeXml,
    runs,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
    parseWorksheetComments,
    parseRangeRef,
  } = await loadXlsxShared();

  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      assertNoXmlEntitiesOrDtd(utf8(bytes), name);
    }
  }

  const workbookXml = utf8(files['xl/workbook.xml']);
  const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
  const { xfStyles } = parseXlsxStylesFull(utf8(files['xl/styles.xml']));
  const { sheets, date1904 } = parseWorkbookSheets(files);

  const hasMacros = Boolean(files['xl/vbaProject.bin']);
  const hasSignatures = Object.keys(files).some((k) => k.startsWith('_xmlsignatures/'));
  const externalLinks: string[] = [];
  for (const k of Object.keys(files).filter((n) => /^xl\/externalLinks\/_rels\/externalLink\d+\.xml\.rels$/.test(n))) {
    const rels = parseRelsMap(utf8(files[k]), 'xl/externalLinks');
    for (const rel of rels.values()) {
      externalLinks.push(rel.target);
    }
  }
  if (externalLinks.length === 0) {
    for (const k of Object.keys(files).filter((n) => /^xl\/externalLinks\/externalLink\d+\.xml$/.test(n))) {
      externalLinks.push(k);
    }
  }

  // Defined names from workbook.xml
  const definedNames: Array<{ name: string; ref: string; sheet?: string | undefined; hidden?: boolean | undefined }> = [];
  for (const dn of findElements(workbookXml, 'definedName')) {
    const name = decodeXml(getAttr(dn.attrs, 'name') ?? '');
    const localSheetId = getAttr(dn.attrs, 'localSheetId');
    const hidden = getAttr(dn.attrs, 'hidden') === '1' || getAttr(dn.attrs, 'hidden') === 'true';
    const ref = dn.selfClosing ? '' : decodeXml(workbookXml.slice(dn.innerStart, dn.innerEnd)).trim();
    const sheetName = localSheetId !== undefined ? sheets[Number(localSheetId)]?.name : undefined;
    if (name) {
      definedNames.push({
        name,
        ref,
        ...(sheetName ? { sheet: sheetName } : {}),
        ...(hidden ? { hidden: true } : {}),
      });
    }
  }

  // Map pivot cache IDs -> pivotCacheDefinition files
  const wbRels = parseRelsMap(utf8(files['xl/_rels/workbook.xml.rels']), 'xl');
  const pivotCacheById = new Map<string, { file: string; sourceSheet?: string; sourceRef?: string; refreshOnLoad?: boolean }>();
  for (const pc of findElements(workbookXml, 'pivotCache')) {
    const cacheId = getAttr(pc.attrs, 'cacheId');
    const rId = getAttr(pc.attrs, 'r:id');
    const rel = rId ? wbRels.get(rId) : undefined;
    if (cacheId && rel && files[rel.target]) {
      const cacheXml = utf8(files[rel.target]);
      const defSpan = findFirstElement(cacheXml, 'pivotCacheDefinition');
      const refreshOnLoad = defSpan ? (getAttr(defSpan.attrs, 'refreshOnLoad') === '1' || getAttr(defSpan.attrs, 'refreshOnLoad') === 'true') : false;
      const wsSource = findFirstElement(cacheXml, 'worksheetSource');
      const sourceSheet = wsSource ? getAttr(wsSource.attrs, 'sheet') : undefined;
      const sourceRef = wsSource ? (getAttr(wsSource.attrs, 'ref') ?? getAttr(wsSource.attrs, 'name')) : undefined;
      pivotCacheById.set(cacheId, {
        file: rel.target,
        ...(sourceSheet ? { sourceSheet } : {}),
        ...(sourceRef ? { sourceRef } : {}),
        refreshOnLoad,
      });
    }
  }

  const sheetSummaries: Array<{
    name: string;
    state: 'visible' | 'hidden' | 'veryHidden';
    usedRange: string | null;
    cellCount: number;
    formulaCount: number;
    mergedRanges: string[];
    commentCount: number;
  }> = [];

  const tables: Array<{
    name: string;
    displayName: string;
    sheet: string;
    ref: string;
    totalsRowCount: number;
    columns: string[];
  }> = [];

  const charts: Array<{
    sheet: string;
    chartFile: string;
    title?: string | undefined;
    series: Array<{ name?: string | undefined; categoriesRef?: string | undefined; valuesRef?: string | undefined }>;
  }> = [];

  const pivotTables: Array<{
    name: string;
    sheet: string;
    locationRef: string;
    cacheId?: string | undefined;
    sourceSheet?: string | undefined;
    sourceRef?: string | undefined;
    refreshOnLoad?: boolean | undefined;
  }> = [];

  const dataValidations: Array<{
    sheet: string;
    sqref: string;
    type: string;
    operator?: string | undefined;
    formula1?: string | undefined;
    formula2?: string | undefined;
  }> = [];

  const conditionalFormats: Array<{
    sheet: string;
    sqref: string;
    rules: Array<{ type: string; operator?: string | undefined; formulas: string[] }>;
  }> = [];

  const seenCharts = new Set<string>();
  const seenTables = new Set<string>();
  const seenPivots = new Set<string>();

  for (const sheet of sheets) {
    const xml = utf8(files[sheet.file]);
    const parsed = await parseWorksheet(xml, sharedStrings, xfStyles, date1904);
    const comments = parseWorksheetComments(sheet.file, files);
    const formulaCount = parsed.cellsInOrder.filter((c) => c.formula !== undefined).length;

    sheetSummaries.push({
      name: sheet.name,
      state: sheet.state,
      usedRange: parsed.usedRange,
      cellCount: parsed.cellsInOrder.length,
      formulaCount,
      mergedRanges: parsed.merges,
      commentCount: comments.length,
    });

    // Data validations
    for (const dv of findElements(xml, 'dataValidation')) {
      const sqref = getAttr(dv.attrs, 'sqref') ?? '';
      const type = getAttr(dv.attrs, 'type') ?? 'any';
      const operator = getAttr(dv.attrs, 'operator');
      const f1Span = dv.selfClosing ? null : findFirstElement(xml, 'formula1', dv.innerStart, dv.innerEnd);
      const f2Span = dv.selfClosing ? null : findFirstElement(xml, 'formula2', dv.innerStart, dv.innerEnd);
      const formula1 = f1Span && !f1Span.selfClosing ? decodeXml(xml.slice(f1Span.innerStart, f1Span.innerEnd)).trim() : undefined;
      const formula2 = f2Span && !f2Span.selfClosing ? decodeXml(xml.slice(f2Span.innerStart, f2Span.innerEnd)).trim() : undefined;
      if (sqref) {
        dataValidations.push({
          sheet: sheet.name,
          sqref,
          type,
          ...(operator ? { operator } : {}),
          ...(formula1 ? { formula1 } : {}),
          ...(formula2 ? { formula2 } : {}),
        });
      }
    }

    // Conditional formatting
    for (const cf of findElements(xml, 'conditionalFormatting')) {
      const sqref = getAttr(cf.attrs, 'sqref') ?? '';
      if (!sqref || cf.selfClosing) continue;
      const rules: Array<{ type: string; operator?: string | undefined; formulas: string[] }> = [];
      for (const rule of findElements(xml, 'cfRule', cf.innerStart, cf.innerEnd)) {
        const type = getAttr(rule.attrs, 'type') ?? 'unknown';
        const operator = getAttr(rule.attrs, 'operator');
        const formulas: string[] = [];
        if (!rule.selfClosing) {
          for (const f of findElements(xml, 'formula', rule.innerStart, rule.innerEnd)) {
            if (!f.selfClosing) {
              formulas.push(decodeXml(xml.slice(f.innerStart, f.innerEnd)).trim());
            }
          }
        }
        rules.push({ type, ...(operator ? { operator } : {}), formulas });
      }
      if (rules.length > 0) {
        conditionalFormats.push({ sheet: sheet.name, sqref, rules });
      }
    }

    // Worksheet relationships: tables, drawings (charts), pivotTables
    const sheetBaseName = sheet.file.split('/').pop() ?? '';
    const sheetRelsPath = `xl/worksheets/_rels/${sheetBaseName}.rels`;
    const sheetRels = parseRelsMap(utf8(files[sheetRelsPath]), 'xl/worksheets');

    for (const rel of sheetRels.values()) {
      // Tables
      if (rel.target.startsWith('xl/tables/') && files[rel.target] && !seenTables.has(rel.target)) {
        seenTables.add(rel.target);
        const tXml = utf8(files[rel.target]);
        const tSpan = findFirstElement(tXml, 'table');
        if (tSpan) {
          const name = decodeXml(getAttr(tSpan.attrs, 'name') ?? '');
          const displayName = decodeXml(getAttr(tSpan.attrs, 'displayName') ?? name);
          const ref = getAttr(tSpan.attrs, 'ref') ?? '';
          const totalsRowCount = Number(getAttr(tSpan.attrs, 'totalsRowCount') ?? 0);
          const cols: string[] = [];
          for (const tc of findElements(tXml, 'tableColumn')) {
            const colName = decodeXml(getAttr(tc.attrs, 'name') ?? '');
            if (colName) cols.push(colName);
          }
          tables.push({ name, displayName, sheet: sheet.name, ref, totalsRowCount, columns: cols });
        }
      }

      // Drawings -> Charts
      if (rel.target.startsWith('xl/drawings/') && files[rel.target]) {
        const drawingBase = rel.target.split('/').pop() ?? '';
        const drawingRelsPath = `xl/drawings/_rels/${drawingBase}.rels`;
        const drawingRels = parseRelsMap(utf8(files[drawingRelsPath]), 'xl/drawings');
        for (const dRel of drawingRels.values()) {
          if (dRel.target.startsWith('xl/charts/') && files[dRel.target] && !seenCharts.has(dRel.target)) {
            seenCharts.add(dRel.target);
            charts.push(parseChartXml(utf8(files[dRel.target]), sheet.name, dRel.target, decodeXml, runs));
          }
        }
      }

      // PivotTables
      if (rel.target.startsWith('xl/pivotTables/') && files[rel.target] && !seenPivots.has(rel.target)) {
        seenPivots.add(rel.target);
        const ptXml = utf8(files[rel.target]);
        const ptSpan = findFirstElement(ptXml, 'pivotTableDefinition');
        if (ptSpan) {
          const name = decodeXml(getAttr(ptSpan.attrs, 'name') ?? rel.target);
          const cacheId = getAttr(ptSpan.attrs, 'cacheId');
          const locSpan = findFirstElement(ptXml, 'location');
          const locationRef = locSpan ? (getAttr(locSpan.attrs, 'ref') ?? '') : '';
          let cacheInfo = cacheId ? pivotCacheById.get(cacheId) : undefined;
          if (!cacheInfo) {
            const ptBase = rel.target.split('/').pop() ?? '';
            const ptRels = parseRelsMap(utf8(files[`xl/pivotTables/_rels/${ptBase}.rels`]), 'xl/pivotTables');
            for (const pRel of ptRels.values()) {
              if (pRel.target.startsWith('xl/pivotCache/') && files[pRel.target]) {
                const cacheXml = utf8(files[pRel.target]);
                const defSpan = findFirstElement(cacheXml, 'pivotCacheDefinition');
                const refreshOnLoad = defSpan ? (getAttr(defSpan.attrs, 'refreshOnLoad') === '1' || getAttr(defSpan.attrs, 'refreshOnLoad') === 'true') : false;
                const wsSource = findFirstElement(cacheXml, 'worksheetSource');
                const sourceSheet = wsSource ? getAttr(wsSource.attrs, 'sheet') : undefined;
                const sourceRef = wsSource ? (getAttr(wsSource.attrs, 'ref') ?? getAttr(wsSource.attrs, 'name')) : undefined;
                cacheInfo = {
                  file: pRel.target,
                  ...(sourceSheet ? { sourceSheet } : {}),
                  ...(sourceRef ? { sourceRef } : {}),
                  refreshOnLoad,
                };
                break;
              }
            }
          }
          pivotTables.push({
            name,
            sheet: sheet.name,
            locationRef,
            ...(cacheId ? { cacheId } : {}),
            ...(cacheInfo?.sourceSheet ? { sourceSheet: cacheInfo.sourceSheet } : {}),
            ...(cacheInfo?.sourceRef ? { sourceRef: cacheInfo.sourceRef } : {}),
            ...(cacheInfo?.refreshOnLoad !== undefined ? { refreshOnLoad: cacheInfo.refreshOnLoad } : {}),
          });
        }
      }
    }
  }

  // Fallback for any tables/charts/pivots not linked via worksheet .rels
  for (const k of Object.keys(files).filter((n) => /^xl\/tables\/table\d+\.xml$/.test(n))) {
    if (seenTables.has(k)) continue;
    const tXml = utf8(files[k]);
    const tSpan = findFirstElement(tXml, 'table');
    if (tSpan) {
      const name = decodeXml(getAttr(tSpan.attrs, 'name') ?? '');
      const displayName = decodeXml(getAttr(tSpan.attrs, 'displayName') ?? name);
      const ref = getAttr(tSpan.attrs, 'ref') ?? '';
      const totalsRowCount = Number(getAttr(tSpan.attrs, 'totalsRowCount') ?? 0);
      const cols = findElements(tXml, 'tableColumn').map((tc) => decodeXml(getAttr(tc.attrs, 'name') ?? '')).filter(Boolean);
      tables.push({ name, displayName, sheet: sheets[0]?.name ?? 'Sheet1', ref, totalsRowCount, columns: cols });
    }
  }
  for (const k of Object.keys(files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))) {
    if (seenCharts.has(k)) continue;
    charts.push(parseChartXml(utf8(files[k]), sheets[0]?.name ?? 'Sheet1', k, decodeXml, runs));
  }
  for (const k of Object.keys(files).filter((n) => /^xl\/pivotTables\/pivotTable\d+\.xml$/.test(n))) {
    if (seenPivots.has(k)) continue;
    const ptXml = utf8(files[k]);
    const ptSpan = findFirstElement(ptXml, 'pivotTableDefinition');
    if (ptSpan) {
      const name = decodeXml(getAttr(ptSpan.attrs, 'name') ?? k);
      const cacheId = getAttr(ptSpan.attrs, 'cacheId');
      const locSpan = findFirstElement(ptXml, 'location');
      const locationRef = locSpan ? (getAttr(locSpan.attrs, 'ref') ?? '') : '';
      const cacheInfo = cacheId ? pivotCacheById.get(cacheId) : undefined;
      pivotTables.push({
        name,
        sheet: sheets[0]?.name ?? 'Sheet1',
        locationRef,
        ...(cacheId ? { cacheId } : {}),
        ...(cacheInfo?.sourceSheet ? { sourceSheet: cacheInfo.sourceSheet } : {}),
        ...(cacheInfo?.sourceRef ? { sourceRef: cacheInfo.sourceRef } : {}),
        ...(cacheInfo?.refreshOnLoad !== undefined ? { refreshOnLoad: cacheInfo.refreshOnLoad } : {}),
      });
    }
  }

  // Format readable summary
  const lines: string[] = [];
  lines.push(`Workbook Summary:`);
  lines.push(`- Macros (vbaProject.bin): ${hasMacros ? 'present' : 'none'}`);
  if (hasSignatures) lines.push(`- Digital signatures (_xmlsignatures): present`);
  lines.push(`- External links: ${externalLinks.length > 0 ? externalLinks.join(', ') : 'none'}`);
  if (date1904) lines.push(`- Date system: 1904`);

  lines.push(`\nSheets (${sheetSummaries.length}):`);
  for (const s of sheetSummaries) {
    const stateTag = s.state !== 'visible' ? ` [${s.state}]` : '';
    const rangeInfo = s.usedRange ? `range ${s.usedRange}` : 'empty';
    const extras: string[] = [`${s.cellCount} cells`, `${s.formulaCount} formulas`];
    if (s.mergedRanges.length > 0) extras.push(`${s.mergedRanges.length} merges (${s.mergedRanges.slice(0, 8).join(', ')})`);
    if (s.commentCount > 0) extras.push(`${s.commentCount} comments`);
    lines.push(`- ${s.name}${stateTag}: ${rangeInfo} (${extras.join(', ')})`);
  }

  if (definedNames.length > 0) {
    lines.push(`\nDefined Names (${definedNames.length}):`);
    for (const dn of definedNames) {
      lines.push(`- ${dn.name}${dn.sheet ? ` (scope: ${dn.sheet})` : ''}${dn.hidden ? ' [hidden]' : ''}: ${dn.ref}`);
    }
  }

  if (tables.length > 0) {
    lines.push(`\nTables (${tables.length}):`);
    for (const t of tables) {
      const pr = parseRangeRef(t.ref);
      const rowsNote = pr ? ` (${pr.endRow - pr.startRow + 1} rows)` : '';
      lines.push(
        `- ${t.displayName}${t.name !== t.displayName ? ` (${t.name})` : ''} on ${t.sheet}!${t.ref}${rowsNote}: columns [${t.columns.join(', ')}]${t.totalsRowCount > 0 ? ' [has totals row]' : ''}`,
      );
    }
  }

  if (charts.length > 0) {
    lines.push(`\nCharts (${charts.length}):`);
    for (const c of charts) {
      const seriesDesc = c.series
        .map((ser, idx) => {
          const parts: string[] = [];
          if (ser.name) parts.push(`name=${ser.name}`);
          if (ser.categoriesRef) parts.push(`categories=${ser.categoriesRef}`);
          if (ser.valuesRef) parts.push(`values=${ser.valuesRef}`);
          return `series ${idx + 1} (${parts.join(', ') || 'unreferenced'})`;
        })
        .join('; ');
      lines.push(`- ${c.sheet}${c.title ? ` "${c.title}"` : ''} (${c.chartFile}): ${seriesDesc || 'no series'}`);
    }
  }

  if (pivotTables.length > 0) {
    lines.push(`\nPivot Tables (${pivotTables.length}):`);
    for (const pt of pivotTables) {
      const src = pt.sourceSheet
        ? `${pt.sourceSheet}!${pt.sourceRef ?? ''}`
        : pt.sourceRef ?? 'unknown source';
      lines.push(`- ${pt.name} on ${pt.sheet}!${pt.locationRef}: source ${src}${pt.refreshOnLoad ? ' [refreshOnLoad]' : ''}`);
    }
  }

  if (dataValidations.length > 0) {
    lines.push(`\nData Validations (${dataValidations.length}):`);
    for (const dv of dataValidations) {
      const f = [dv.formula1, dv.formula2].filter(Boolean).join(' .. ');
      lines.push(`- ${dv.sheet}!${dv.sqref}: type=${dv.type}${dv.operator ? ` (${dv.operator})` : ''}${f ? ` ${f}` : ''}`);
    }
  }

  if (conditionalFormats.length > 0) {
    lines.push(`\nConditional Formatting (${conditionalFormats.length}):`);
    for (const cf of conditionalFormats) {
      const ruleDesc = cf.rules
        .map((r) => `${r.type}${r.operator ? `(${r.operator})` : ''}${r.formulas.length > 0 ? `: ${r.formulas.join(', ')}` : ''}`)
        .join('; ');
      lines.push(`- ${cf.sheet}!${cf.sqref}: ${ruleDesc}`);
    }
  }

  return lines.join('\n');
}

function parseChartXml(
  chartXml: string,
  sheetName: string,
  chartFile: string,
  decodeXml: (s: string) => string,
  runs: (xml: string, tag: string) => string,
): {
  sheet: string;
  chartFile: string;
  title?: string | undefined;
  series: Array<{ name?: string | undefined; categoriesRef?: string | undefined; valuesRef?: string | undefined }>;
} {
  const titleSpan = findFirstElement(chartXml, 'title');
  const titleSlice = titleSpan && !titleSpan.selfClosing ? chartXml.slice(titleSpan.innerStart, titleSpan.innerEnd) : '';
  const titleText = titleSlice
    ? runs(titleSlice, 'a:t').trim() ||
      runs(titleSlice, 't').trim() ||
      runs(titleSlice, 'c:v').trim() ||
      runs(titleSlice, 'v').trim()
    : '';

  const series: Array<{ name?: string | undefined; categoriesRef?: string | undefined; valuesRef?: string | undefined }> = [];
  for (const ser of findElements(chartXml, 'ser')) {
    if (ser.selfClosing) continue;
    const txSpan = findFirstElement(chartXml, 'tx', ser.innerStart, ser.innerEnd);
    const catSpan =
      findFirstElement(chartXml, 'cat', ser.innerStart, ser.innerEnd) ??
      findFirstElement(chartXml, 'xVal', ser.innerStart, ser.innerEnd);
    const valSpan =
      findFirstElement(chartXml, 'val', ser.innerStart, ser.innerEnd) ??
      findFirstElement(chartXml, 'yVal', ser.innerStart, ser.innerEnd);

    const extractFormulaOrValue = (span: XmlElementSpan | null): string | undefined => {
      if (!span || span.selfClosing) return undefined;
      const f = findFirstElement(chartXml, 'f', span.innerStart, span.innerEnd);
      if (f && !f.selfClosing) return decodeXml(chartXml.slice(f.innerStart, f.innerEnd)).trim();
      const v = findFirstElement(chartXml, 'v', span.innerStart, span.innerEnd);
      if (v && !v.selfClosing) return decodeXml(chartXml.slice(v.innerStart, v.innerEnd)).trim();
      return undefined;
    };

    const name = extractFormulaOrValue(txSpan);
    const categoriesRef = extractFormulaOrValue(catSpan);
    const valuesRef = extractFormulaOrValue(valSpan);
    series.push({
      ...(name ? { name } : {}),
      ...(categoriesRef ? { categoriesRef } : {}),
      ...(valuesRef ? { valuesRef } : {}),
    });
  }

  return {
    sheet: sheetName,
    chartFile,
    ...(titleText ? { title: titleText } : {}),
    series,
  };
}

// ---- Tool 2: sheet_read ------------------------------------------------------

const DEFAULT_READ_MAX_LINES = 2_000;
const DEFAULT_READ_MAX_BYTES = 50 * 1024;

export async function runSheetRead(
  files: Record<string, Uint8Array>,
  sheetName: string,
  rangeStr?: string,
  include?: string[],
  maxLines = DEFAULT_READ_MAX_LINES,
  maxBytes = DEFAULT_READ_MAX_BYTES,
): Promise<string> {
  const {
    utf8,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
    parseWorksheetComments,
    parseRangeRef,
    columnLetters,
  } = await loadXlsxShared();

  const { sheets, date1904 } = parseWorkbookSheets(files);
  const sheet = findSheetByName(sheets, sheetName);
  if (!sheet) {
    throw new Error(
      `Sheet "${sheetName}" not found. Available sheets: ${sheets.map((s) => s.name).join(', ') || '(none)'}`,
    );
  }

  const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
  const { xfStyles } = parseXlsxStylesFull(utf8(files['xl/styles.xml']));
  const xml = utf8(files[sheet.file]);
  const parsed = await parseWorksheet(xml, sharedStrings, xfStyles, date1904);

  const effectiveRangeStr = rangeStr?.trim() || parsed.usedRange || 'A1:Z50';
  const bounds = parseRangeRef(effectiveRangeStr);
  if (!bounds) {
    throw new Error(`Invalid A1 range "${effectiveRangeStr}". Expected e.g. "A1:G50" or "B7".`);
  }

  const inc = new Set(
    include && include.length > 0
      ? include.map((s) => s.toLowerCase())
      : ['values', 'formulas', 'formats', 'merges', 'comments'],
  );
  const wantValues = inc.has('values') || inc.has('all');
  const wantFormulas = inc.has('formulas') || inc.has('all');
  const wantFormats = inc.has('formats') || inc.has('all');
  const wantMerges = inc.has('merges') || inc.has('all');
  const wantComments = inc.has('comments') || inc.has('all');

  const headerLines: string[] = [];
  headerLines.push(
    `Sheet: ${sheet.name}${sheet.state !== 'visible' ? ` [${sheet.state}]` : ''} | Range: ${bounds.startColStr}${bounds.startRow}:${bounds.endColStr}${bounds.endRow}${parsed.usedRange ? ` (used: ${parsed.usedRange})` : ''}`,
  );

  if (wantMerges && parsed.merges.length > 0) {
    const intersectingMerges = parsed.merges.filter((m) => {
      const mr = parseRangeRef(m);
      if (!mr) return false;
      return (
        mr.endCol >= bounds.startCol &&
        mr.startCol <= bounds.endCol &&
        mr.endRow >= bounds.startRow &&
        mr.startRow <= bounds.endRow
      );
    });
    if (intersectingMerges.length > 0) {
      headerLines.push(`Merged ranges: ${intersectingMerges.join(', ')}`);
    }
  }

  if (wantComments) {
    const comments = parseWorksheetComments(sheet.file, files).filter((c) => {
      const cr = parseRangeRef(c.ref);
      if (!cr) return false;
      return (
        cr.startCol >= bounds.startCol &&
        cr.endCol <= bounds.endCol &&
        cr.startRow >= bounds.startRow &&
        cr.endRow <= bounds.endRow
      );
    });
    for (const c of comments) {
      headerLines.push(`Comment ${c.ref}${c.author ? ` (${c.author})` : ''}: ${c.text}`);
    }
  }

  const matchingCells = parsed.cellsInOrder.filter(
    (c) =>
      c.row >= bounds.startRow &&
      c.row <= bounds.endRow &&
      c.col >= bounds.startCol &&
      c.col <= bounds.endCol,
  );

  if (matchingCells.length === 0) {
    headerLines.push(`(no non-empty cells in range ${bounds.startColStr}${bounds.startRow}:${bounds.endColStr}${bounds.endRow})`);
    return headerLines.join('\n');
  }

  const outLines: string[] = [...headerLines, ''];
  let byteCount = Buffer.byteLength(outLines.join('\n'), 'utf8');
  let truncatedAtRow: number | null = null;

  for (const cell of matchingCells) {
    const parts: string[] = [`${cell.ref}:`];
    if (wantValues) {
      const valRepr = cell.value === null ? '(empty)' : JSON.stringify(cell.value);
      parts.push(`value=${valRepr}`);
      if (cell.formatted && String(cell.value) !== cell.formatted) {
        parts.push(`formatted=${JSON.stringify(cell.formatted)}`);
      }
    }
    if (wantFormulas && cell.formula !== undefined) {
      const tag = cell.formulaType && cell.formulaType !== 'normal' ? ` (${cell.formulaType})` : '';
      parts.push(`formula="=${cell.formula}"${tag}`);
    }
    if (wantFormats && cell.style && cell.style.formatCode && cell.style.formatCode !== 'General') {
      parts.push(`numFmt=${JSON.stringify(cell.style.formatCode)}`);
    }

    const line = parts.join(' ');
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    if (outLines.length >= maxLines || byteCount + lineBytes > maxBytes) {
      truncatedAtRow = cell.row;
      break;
    }
    outLines.push(line);
    byteCount += lineBytes;
  }

  if (truncatedAtRow !== null) {
    outLines.push(
      `\n[Output capped at row ${truncatedAtRow}. Request the next range starting at ${columnLetters(bounds.startCol)}${truncatedAtRow}:${columnLetters(bounds.endCol)}${bounds.endRow}]`,
    );
  }

  return outLines.join('\n');
}

// ---- Tool 3: sheet_find ------------------------------------------------------

export async function runSheetFind(
  files: Record<string, Uint8Array>,
  query: string,
  scope: 'values' | 'formulas' | 'both' = 'both',
  sheetFilter?: string,
): Promise<string> {
  const {
    utf8,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
  } = await loadXlsxShared();

  const cleanQuery = query.trim();
  if (!cleanQuery) {
    throw new Error('sheet_find requires a non-empty query string.');
  }
  const needle = cleanQuery.toLowerCase();
  const formulaNeedle = needle.startsWith('=') ? needle.slice(1) : needle;

  const { sheets, date1904 } = parseWorkbookSheets(files);
  const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
  const { xfStyles } = parseXlsxStylesFull(utf8(files['xl/styles.xml']));

  const targetSheets = sheetFilter
    ? [findSheetByName(sheets, sheetFilter)].filter((s): s is ParsedSheetEntry => s !== null)
    : sheets;
  if (sheetFilter && targetSheets.length === 0) {
    throw new Error(
      `Sheet "${sheetFilter}" not found. Available sheets: ${sheets.map((s) => s.name).join(', ')}`,
    );
  }

  const matches: string[] = [];
  let totalMatches = 0;
  const MAX_MATCHES = 200;

  for (const sheet of targetSheets) {
    const xml = utf8(files[sheet.file]);
    const parsed = await parseWorksheet(xml, sharedStrings, xfStyles, date1904);
    for (const cell of parsed.cellsInOrder) {
      let matched = false;
      if (scope === 'values' || scope === 'both') {
        const rawStr = cell.value !== null ? String(cell.value).toLowerCase() : '';
        const fmtStr = cell.formatted.toLowerCase();
        if ((rawStr && rawStr.includes(needle)) || (fmtStr && fmtStr.includes(needle))) {
          matched = true;
        }
      }
      if (!matched && (scope === 'formulas' || scope === 'both') && cell.formula) {
        if (cell.formula.toLowerCase().includes(formulaNeedle)) {
          matched = true;
        }
      }
      if (matched) {
        totalMatches++;
        if (matches.length < MAX_MATCHES) {
          const valPart = cell.formatted || (cell.value !== null ? String(cell.value) : '(empty)');
          const fPart = cell.formula ? ` [formula: =${cell.formula}]` : '';
          matches.push(`- ${sheet.name}!${cell.ref}: ${valPart}${fPart}`);
        }
      }
    }
  }

  if (totalMatches === 0) {
    return `No cells matching "${query}" (scope: ${scope}) found.`;
  }

  const header = `Found ${totalMatches} cell(s) matching "${query}" (scope: ${scope}):`;
  const footer =
    totalMatches > MAX_MATCHES ? `\n[Showing first ${MAX_MATCHES} of ${totalMatches} matches]` : '';
  return `${header}\n${matches.join('\n')}${footer}`;
}

// ---- Tool 4: sheet_check -----------------------------------------------------

export async function runSheetCheck(
  origFiles: Record<string, Uint8Array>,
  recalcFiles: Record<string, Uint8Array> | null,
  libreOfficeAvailable: boolean,
): Promise<string> {
  const {
    utf8,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
  } = await loadXlsxShared();

  const { sheets: origSheets, date1904 } = parseWorkbookSheets(origFiles);
  const origShared = parseSharedStrings(utf8(origFiles['xl/sharedStrings.xml']));
  const { xfStyles: origStyles } = parseXlsxStylesFull(utf8(origFiles['xl/styles.xml']));

  const recalcParsedBySheet = new Map<string, ParsedWorksheet>();
  if (recalcFiles) {
    const { sheets: rSheets, date1904: rDate1904 } = parseWorkbookSheets(recalcFiles);
    const rShared = parseSharedStrings(utf8(recalcFiles['xl/sharedStrings.xml']));
    const { xfStyles: rStyles } = parseXlsxStylesFull(utf8(recalcFiles['xl/styles.xml']));
    for (const rs of rSheets) {
      const rXml = utf8(recalcFiles[rs.file]);
      recalcParsedBySheet.set(rs.name, await parseWorksheet(rXml, rShared, rStyles, rDate1904));
    }
  }

  const errorCells: Array<{ sheet: string; cell: string; error: string; formula?: string | undefined }> = [];
  const staleCells: Array<{
    sheet: string;
    cell: string;
    formula: string;
    cached: string;
    recalculated: string;
  }> = [];
  const uncachedFormulas: Array<{ sheet: string; cell: string; formula: string }> = [];
  let totalFormulaCells = 0;

  for (const sheet of origSheets) {
    const xml = utf8(origFiles[sheet.file]);
    const parsed = await parseWorksheet(xml, origShared, origStyles, date1904);
    const recalcSheet = recalcParsedBySheet.get(sheet.name);

    for (const cell of parsed.cellsInOrder) {
      if (cell.formula !== undefined) totalFormulaCells++;
      const rCell = recalcSheet?.cellsByRef.get(cell.ref);

      const origErr =
        cell.type === 'e' || (typeof cell.value === 'string' && isExcelError(cell.value))
          ? String(cell.value || cell.rawValue)
          : null;
      const recalcErr =
        rCell && (rCell.type === 'e' || (typeof rCell.value === 'string' && isExcelError(rCell.value)))
          ? String(rCell.value || rCell.rawValue)
          : null;

      if (origErr || recalcErr) {
        errorCells.push({
          sheet: sheet.name,
          cell: cell.ref,
          error: recalcErr ?? origErr!,
          ...(cell.formula ? { formula: `=${cell.formula}` } : {}),
        });
        continue;
      }

      if (cell.formula !== undefined) {
        if (rCell) {
          if (!valuesAgree(cell.value, rCell.value)) {
            staleCells.push({
              sheet: sheet.name,
              cell: cell.ref,
              formula: `=${cell.formula}`,
              cached: cell.value === null || cell.rawValue === '' ? '(blank/missing)' : String(cell.value),
              recalculated: rCell.value === null ? '(blank)' : String(rCell.value),
            });
          }
        } else if (cell.value === null || cell.rawValue === '') {
          uncachedFormulas.push({
            sheet: sheet.name,
            cell: cell.ref,
            formula: `=${cell.formula}`,
          });
        }
      }
    }
  }

  const lines: string[] = [];
  lines.push(
    `Workbook Check (${origSheets.length} sheet(s), ${totalFormulaCells} formula cell(s), recalculation: ${recalcFiles ? 'LibreOffice headless' : libreOfficeAvailable ? 'failed' : 'unavailable — static cached-value scan'}):`,
  );

  if (errorCells.length === 0) {
    lines.push(`- Error cells: 0`);
  } else {
    lines.push(`- Error cells (${errorCells.length}):`);
    for (const e of errorCells) {
      lines.push(`  • ${e.sheet}!${e.cell}: ${e.error}${e.formula ? ` (formula: ${e.formula})` : ''}`);
    }
  }

  if (recalcFiles) {
    if (staleCells.length === 0) {
      lines.push(`- Stale cached values: 0 (all formula caches agree with recalculated values)`);
    } else {
      lines.push(`- Stale cached values (${staleCells.length}):`);
      for (const s of staleCells) {
        lines.push(`  • ${s.sheet}!${s.cell} (${s.formula}): cached ${s.cached} != recalculated ${s.recalculated}`);
      }
    }
  } else if (uncachedFormulas.length > 0) {
    lines.push(`- Formulas missing cached <v> values (${uncachedFormulas.length}):`);
    for (const u of uncachedFormulas) {
      lines.push(`  • ${u.sheet}!${u.cell}: ${u.formula}`);
    }
  }

  return lines.join('\n');
}

function valuesAgree(
  a: string | number | boolean | null,
  b: string | number | boolean | null,
): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') {
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= 1e-9 * scale;
  }
  if (a !== null && b !== null && String(a).trim() === String(b).trim()) return true;
  return false;
}

// ---- Tool 5: sheet_edit (In-Place Patching + Diff Generation) ----------------

interface NormalizedCellEdit {
  sheet: string;
  cell: string;
  row: number;
  col: number;
  value?: string | number | boolean | null | undefined;
  formula?: string | undefined;
  clear?: boolean | undefined;
  numFmt?: string | undefined;
  preserveStyleIdx?: number | undefined;
}

interface PatchPlanResult {
  files: Record<string, Uint8Array>;
  diff: SheetDiffPayload;
  directlyEditedCells: string[];
  formulaChanged: boolean;
  warnings: string[];
}

function formatCellSideForDiff(cell: ParsedWorksheetCell | undefined): string {
  if (!cell) return '(empty)';
  if (cell.formula !== undefined) {
    return `=${cell.formula}`;
  }
  if (cell.value === null || cell.rawValue === '') return '(empty)';
  if (typeof cell.value === 'string') return JSON.stringify(cell.value);
  return String(cell.value);
}

function formatEditAfterForDiff(edit: NormalizedCellEdit): string {
  if (edit.clear) return '(empty)';
  if (edit.formula !== undefined) {
    const clean = edit.formula.startsWith('=') ? edit.formula.slice(1) : edit.formula;
    return `=${clean}`;
  }
  if (edit.value === undefined || edit.value === null) return '(empty)';
  if (typeof edit.value === 'string') return JSON.stringify(edit.value);
  return String(edit.value);
}

/**
 * Ensures `xl/styles.xml` has a `<cellXfs>` entry with `numFmt` and returns its
 * 0-based `s` index, patching `xl/styles.xml` in place via byte-offset splices.
 */
async function ensureStyleIndexForNumFmt(
  stylesXml: string,
  baseStyleIdx: number | undefined,
  numFmtCode: string,
): Promise<{ stylesXml: string; styleIdx: number }> {
  const { BUILTIN_NUMFMT_CODES, decodeXml, xmlEscape } = await loadXlsxShared();

  // Check if numFmtCode matches a standard built-in format code
  let targetNumFmtId: number | null = null;
  for (const [idStr, code] of Object.entries(BUILTIN_NUMFMT_CODES)) {
    if (code.toLowerCase() === numFmtCode.trim().toLowerCase()) {
      targetNumFmtId = Number(idStr);
      break;
    }
  }

  let currentXml = stylesXml;
  if (!currentXml) {
    currentXml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs>' +
      '</styleSheet>';
  }

  // Check existing custom `<numFmt>` entries
  let maxNumFmtId = 163;
  const numFmtsSpan = findFirstElement(currentXml, 'numFmts');
  const existingNumFmts = numFmtsSpan && !numFmtsSpan.selfClosing
    ? findElements(currentXml, 'numFmt', numFmtsSpan.innerStart, numFmtsSpan.innerEnd)
    : [];
  for (const nf of existingNumFmts) {
    const id = Number(getAttr(nf.attrs, 'numFmtId') ?? 0);
    const code = decodeXml(getAttr(nf.attrs, 'formatCode') ?? '');
    if (id > maxNumFmtId) maxNumFmtId = id;
    if (targetNumFmtId === null && code === numFmtCode) {
      targetNumFmtId = id;
    }
  }

  // Add custom `<numFmt>` if needed
  if (targetNumFmtId === null) {
    targetNumFmtId = maxNumFmtId + 1;
    const newNumFmtTag = `<numFmt numFmtId="${targetNumFmtId}" formatCode="${xmlEscape(numFmtCode)}"/>`;
    if (numFmtsSpan) {
      if (numFmtsSpan.selfClosing) {
        currentXml = applyXmlSplices(currentXml, [
          {
            start: numFmtsSpan.openStart,
            end: numFmtsSpan.closeEnd,
            replacement: `<${numFmtsSpan.name} count="1">${newNumFmtTag}</${numFmtsSpan.name}>`,
          },
        ]);
      } else {
        const newCount = existingNumFmts.length + 1;
        const countSplice = patchOpeningTagAttrs(currentXml, numFmtsSpan, { count: String(newCount) }, xmlEscape);
        const insertSplice: XmlSplice = {
          start: numFmtsSpan.innerEnd,
          end: numFmtsSpan.innerEnd,
          replacement: newNumFmtTag,
        };
        currentXml = applyXmlSplices(currentXml, [countSplice, insertSplice]);
      }
    } else {
      const styleSheetSpan = findFirstElement(currentXml, 'styleSheet');
      if (!styleSheetSpan || styleSheetSpan.selfClosing) {
        throw new Error('Malformed xl/styles.xml: missing <styleSheet> element.');
      }
      const fontsSpan = findFirstElement(currentXml, 'fonts', styleSheetSpan.innerStart, styleSheetSpan.innerEnd);
      const insertPos = fontsSpan ? fontsSpan.openStart : styleSheetSpan.innerStart;
      currentXml = applyXmlSplices(currentXml, [
        {
          start: insertPos,
          end: insertPos,
          replacement: `<numFmts count="1">${newNumFmtTag}</numFmts>`,
        },
      ]);
    }
  }

  // Locate `<cellXfs>` and append/reuse an `<xf>` with `numFmtId="${targetNumFmtId}"`
  const cellXfsSpan = findFirstElement(currentXml, 'cellXfs');
  if (!cellXfsSpan || cellXfsSpan.selfClosing) {
    throw new Error('Malformed xl/styles.xml: missing <cellXfs> element.');
  }
  const xfSpans = findElements(currentXml, 'xf', cellXfsSpan.innerStart, cellXfsSpan.innerEnd);
  const baseXf = baseStyleIdx !== undefined && xfSpans[baseStyleIdx] ? xfSpans[baseStyleIdx]! : xfSpans[0];
  const baseFontId = baseXf ? (getAttr(baseXf.attrs, 'fontId') ?? '0') : '0';
  const baseFillId = baseXf ? (getAttr(baseXf.attrs, 'fillId') ?? '0') : '0';
  const baseBorderId = baseXf ? (getAttr(baseXf.attrs, 'borderId') ?? '0') : '0';

  for (let i = 0; i < xfSpans.length; i++) {
    const xf = xfSpans[i]!;
    if (
      Number(getAttr(xf.attrs, 'numFmtId') ?? 0) === targetNumFmtId &&
      (getAttr(xf.attrs, 'fontId') ?? '0') === baseFontId &&
      (getAttr(xf.attrs, 'fillId') ?? '0') === baseFillId &&
      (getAttr(xf.attrs, 'borderId') ?? '0') === baseBorderId
    ) {
      return { stylesXml: currentXml, styleIdx: i };
    }
  }

  let newXfXml: string;
  if (baseXf) {
    const patchedOpen = patchOpeningTagAttrs(
      currentXml,
      baseXf,
      { numFmtId: String(targetNumFmtId), applyNumberFormat: '1' },
      xmlEscape,
    ).replacement;
    if (baseXf.selfClosing) {
      newXfXml = patchedOpen;
    } else {
      newXfXml = `${patchedOpen}${currentXml.slice(baseXf.innerStart, baseXf.closeEnd)}`;
    }
  } else {
    newXfXml = `<xf numFmtId="${targetNumFmtId}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`;
  }

  const newIdx = xfSpans.length;
  const countSplice = patchOpeningTagAttrs(currentXml, cellXfsSpan, { count: String(newIdx + 1) }, xmlEscape);
  const insertSplice: XmlSplice = {
    start: cellXfsSpan.innerEnd,
    end: cellXfsSpan.innerEnd,
    replacement: newXfXml,
  };
  currentXml = applyXmlSplices(currentXml, [countSplice, insertSplice]);
  return { stylesXml: currentXml, styleIdx: newIdx };
}

function buildCellElementXml(
  tagPrefix: string,
  cellRef: string,
  existingSpan: XmlElementSpan | undefined,
  existingXml: string,
  edit: NormalizedCellEdit,
  resolvedStyleIdx: number | undefined,
  xmlEscape: (s: string) => string,
): string {
  const cTag = tagPrefix ? `${tagPrefix}:c` : 'c';
  const fTag = tagPrefix ? `${tagPrefix}:f` : 'f';
  const vTag = tagPrefix ? `${tagPrefix}:v` : 'v';
  const isTag = tagPrefix ? `${tagPrefix}:is` : 'is';
  const tTag = tagPrefix ? `${tagPrefix}:t` : 't';

  // Preserve unknown attributes on `<c>` (like `vm`, `ph`), updating `r`, `s`, and `t`.
  const baseOpenTag = existingSpan
    ? existingXml.slice(existingSpan.openStart, existingSpan.openEnd)
    : `<${cTag} r="${cellRef}"/>`;

  const applyAttrs = (updates: Record<string, string | null>): string => {
    const dummySpan: XmlElementSpan = {
      name: cTag,
      localName: 'c',
      attrs: '',
      openStart: 0,
      openEnd: baseOpenTag.length,
      innerStart: baseOpenTag.length,
      innerEnd: baseOpenTag.length,
      closeStart: baseOpenTag.length,
      closeEnd: baseOpenTag.length,
      selfClosing: baseOpenTag.endsWith('/>'),
    };
    return patchOpeningTagAttrs(baseOpenTag, dummySpan, updates, xmlEscape).replacement;
  };

  const sVal = resolvedStyleIdx !== undefined ? String(resolvedStyleIdx) : null;

  if (edit.clear) {
    const tag = applyAttrs({ r: cellRef, s: sVal, t: null, cm: null });
    if (tag.endsWith('/>')) return tag;
    return `${tag.slice(0, -1)}/>`;
  }

  const toOpenOnly = (tag: string): string => (tag.endsWith('/>') ? `${tag.slice(0, -2)}>` : tag);

  if (edit.formula !== undefined) {
    const cleanFormula = edit.formula.startsWith('=') ? edit.formula.slice(1) : edit.formula;
    let tAttr: string | null = null;
    let vElement = '';
    if (edit.value !== undefined && edit.value !== null) {
      if (typeof edit.value === 'boolean') {
        tAttr = 'b';
        vElement = `<${vTag}>${edit.value ? '1' : '0'}</${vTag}>`;
      } else if (typeof edit.value === 'number') {
        tAttr = null;
        vElement = `<${vTag}>${String(edit.value)}</${vTag}>`;
      } else if (typeof edit.value === 'string') {
        tAttr = isExcelError(edit.value) ? 'e' : 'str';
        vElement = `<${vTag}>${xmlEscape(edit.value)}</${vTag}>`;
      }
    }
    const open = toOpenOnly(applyAttrs({ r: cellRef, s: sVal, t: tAttr }));
    return `${open}<${fTag}>${xmlEscape(cleanFormula)}</${fTag}>${vElement}</${cTag}>`;
  }

  const val = edit.value;
  if (val === undefined || val === null) {
    const tag = applyAttrs({ r: cellRef, s: sVal, t: null, cm: null });
    return tag.endsWith('/>') ? tag : `${tag.slice(0, -1)}/>`;
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val)) {
      throw new Error(`Invalid numeric value for ${edit.sheet}!${cellRef}: ${String(val)}`);
    }
    const open = toOpenOnly(applyAttrs({ r: cellRef, s: sVal, t: null }));
    return `${open}<${vTag}>${String(val)}</${vTag}></${cTag}>`;
  }

  if (typeof val === 'boolean') {
    const open = toOpenOnly(applyAttrs({ r: cellRef, s: sVal, t: 'b' }));
    return `${open}<${vTag}>${val ? '1' : '0'}</${vTag}></${cTag}>`;
  }

  const strVal = String(val);
  if (isExcelError(strVal)) {
    const open = toOpenOnly(applyAttrs({ r: cellRef, s: sVal, t: 'e' }));
    return `${open}<${vTag}>${xmlEscape(strVal.trim().toUpperCase())}</${vTag}></${cTag}>`;
  }

  const preserveSpace = /^\s|\s$|[\r\n\t]/.test(strVal) ? ' xml:space="preserve"' : '';
  const open = toOpenOnly(applyAttrs({ r: cellRef, s: sVal, t: 'inlineStr' }));
  return `${open}<${isTag}><${tTag}${preserveSpace}>${xmlEscape(strVal)}</${tTag}></${isTag}></${cTag}>`;
}

/**
 * Applies `edits` to `origFiles` in memory using byte-offset XML splicing and
 * returns the patched file map plus the human-readable cell-level diff.
 */
export async function buildSheetEditPatch(
  origFiles: Record<string, Uint8Array>,
  edits: SheetCellEditInput[],
): Promise<PatchPlanResult> {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new Error('sheet_edit requires a non-empty edits array.');
  }

  const {
    utf8,
    decodeXml,
    xmlEscape,
    columnLetters,
    parseCellRef,
    parseRangeRef,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
  } = await loadXlsxShared();

  // Copy shallow map of Uint8Array references; untouched entries remain the exact original Uint8Array.
  const files: Record<string, Uint8Array> = { ...origFiles };
  const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      assertNoXmlEntitiesOrDtd(utf8(bytes), name);
    }
  }

  const warnings: string[] = [];
  if (Object.keys(files).some((k) => k.startsWith('_xmlsignatures/'))) {
    warnings.push(
      'Workbook contains digital signatures (_xmlsignatures/); modifying cells invalidates existing signatures.',
    );
  }

  const parsedWb = parseWorkbookSheets(files);
  let sheets = parsedWb.sheets;
  const { date1904 } = parsedWb;
  const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
  let stylesXml = utf8(files['xl/styles.xml']);
  let stylesModified = false;

  const diffBeforeLines: string[] = [];
  const diffAfterLines: string[] = [];
  const diffSummaryLines: string[] = [];

  // Phase A: Handle `add_sheet` structural edits first so subsequent cell edits can target the new sheet.
  for (const rawEdit of edits) {
    const opName = rawEdit.op ?? (rawEdit.addSheet ? 'add_sheet' : rawEdit.table || rawEdit.appendRows ? 'append_table_rows' : 'set_cell');
    if (
      opName !== 'set_cell' &&
      opName !== 'append_table_rows' &&
      opName !== 'add_sheet'
    ) {
      throw new Error(
        `Unsupported sheet_edit operation "${String(opName)}". Only cell edits, append_table_rows, and add_sheet are supported in v1 (row/column insert/delete are refused because they require rewriting formula and chart references across the workbook).`,
      );
    }

    if (opName === 'add_sheet') {
      const newSheetName = (rawEdit.addSheet ?? rawEdit.sheet ?? rawEdit.name ?? '').trim();
      if (!newSheetName) {
        throw new Error('add_sheet requires a non-empty sheet name.');
      }
      if (newSheetName.length > 31 || /[:\\/?*[\]]/.test(newSheetName)) {
        throw new Error(
          `Invalid sheet name "${newSheetName}": Excel sheet names must be <= 31 characters and cannot contain : \\ / ? * [ ].`,
        );
      }
      if (findSheetByName(sheets, newSheetName)) {
        throw new Error(`Cannot add sheet "${newSheetName}": a sheet with that name already exists.`);
      }

      const wbXml = utf8(files['xl/workbook.xml']);
      const wbRelsXml = utf8(files['xl/_rels/workbook.xml.rels']);
      const contentTypesXml = utf8(files['[Content_Types].xml']);

      const existingNums = Object.keys(files)
        .map((k) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k)?.[1])
        .filter(Boolean)
        .map(Number);
      const nextFileNum = Math.max(0, ...existingNums) + 1;
      const newSheetFile = `xl/worksheets/sheet${nextFileNum}.xml`;

      const maxSheetId = sheets.reduce((m, s) => Math.max(m, s.sheetId), 0);
      const nextSheetId = maxSheetId + 1;

      const rIdNums = [
        ...Array.from(wbRelsXml.matchAll(/\bId="rId(\d+)"/g)).map((m) => Number(m[1])),
        ...sheets.map((s) => Number(/^rId(\d+)$/.exec(s.rId)?.[1] ?? 0)),
      ];
      const nextRId = `rId${Math.max(0, ...rIdNums) + 1}`;

      files[newSheetFile] = encodeUtf8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
          '<sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>',
      );

      // Patch xl/workbook.xml `<sheets>`
      const sheetsSpan = findFirstElement(wbXml, 'sheets');
      if (!sheetsSpan || sheetsSpan.selfClosing) {
        throw new Error('Malformed xl/workbook.xml: missing <sheets> container.');
      }
      const sheetTagPrefix = stripPrefix(sheetsSpan.name) === sheetsSpan.name ? '' : `${sheetsSpan.name.split(':')[0]}:`;
      const newSheetTag = `<${sheetTagPrefix}sheet name="${xmlEscape(newSheetName)}" sheetId="${nextSheetId}" r:id="${nextRId}"/>`;
      files['xl/workbook.xml'] = encodeUtf8(
        applyXmlSplices(wbXml, [
          { start: sheetsSpan.innerEnd, end: sheetsSpan.innerEnd, replacement: newSheetTag },
        ]),
      );

      // Patch xl/_rels/workbook.xml.rels
      const relsRoot = findFirstElement(wbRelsXml, 'Relationships');
      if (!relsRoot || relsRoot.selfClosing) {
        throw new Error('Malformed xl/_rels/workbook.xml.rels: missing <Relationships> root.');
      }
      const newRelTag = `<Relationship Id="${nextRId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${nextFileNum}.xml"/>`;
      files['xl/_rels/workbook.xml.rels'] = encodeUtf8(
        applyXmlSplices(wbRelsXml, [
          { start: relsRoot.innerEnd, end: relsRoot.innerEnd, replacement: newRelTag },
        ]),
      );

      // Patch [Content_Types].xml
      if (contentTypesXml) {
        const typesRoot = findFirstElement(contentTypesXml, 'Types');
        if (typesRoot && !typesRoot.selfClosing) {
          const overrideTag = `<Override PartName="/xl/worksheets/sheet${nextFileNum}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
          files['[Content_Types].xml'] = encodeUtf8(
            applyXmlSplices(contentTypesXml, [
              { start: typesRoot.innerEnd, end: typesRoot.innerEnd, replacement: overrideTag },
            ]),
          );
        }
      }

      sheets = parseWorkbookSheets(files).sheets;
      diffBeforeLines.push(`${newSheetName}: (absent)`);
      diffAfterLines.push(`${newSheetName}: (new worksheet)`);
      diffSummaryLines.push(`${newSheetName}: (absent) → (new worksheet)`);
    }
  }

  // Phase B: Expand `append_table_rows` and normal `set_cell` edits into per-sheet cell edits.
  const cellEditsBySheet = new Map<string, Map<string, NormalizedCellEdit>>();
  const touchedSheetNames = new Set<string>();
  const touchedTableNames = new Set<string>();
  let formulaChanged = false;

  const queueCellEdit = (edit: NormalizedCellEdit) => {
    let sheetMap = cellEditsBySheet.get(edit.sheet);
    if (!sheetMap) {
      sheetMap = new Map();
      cellEditsBySheet.set(edit.sheet, sheetMap);
    }
    sheetMap.set(edit.cell, edit);
    touchedSheetNames.add(edit.sheet);
    if (edit.formula !== undefined) formulaChanged = true;
  };

  // Pre-parse worksheets as needed
  const parsedWorksheets = new Map<string, ParsedWorksheet>();
  const getParsedWorksheet = async (sheetEntry: ParsedSheetEntry): Promise<ParsedWorksheet> => {
    let p = parsedWorksheets.get(sheetEntry.name);
    if (!p) {
      const { xfStyles } = parseXlsxStylesFull(stylesXml);
      p = await parseWorksheet(utf8(files[sheetEntry.file]), sharedStrings, xfStyles, date1904);
      parsedWorksheets.set(sheetEntry.name, p);
    }
    return p;
  };

  for (const rawEdit of edits) {
    const opName = rawEdit.op ?? (rawEdit.addSheet ? 'add_sheet' : rawEdit.table || rawEdit.appendRows ? 'append_table_rows' : 'set_cell');
    if (opName === 'add_sheet') continue;

    if (opName === 'append_table_rows') {
      const tableName = (rawEdit.table ?? '').trim();
      const rowsToAppend = rawEdit.rows ?? rawEdit.appendRows ?? [];
      if (!tableName) {
        throw new Error('append_table_rows requires a "table" name.');
      }
      if (!Array.isArray(rowsToAppend) || rowsToAppend.length === 0) {
        throw new Error(`append_table_rows for table "${tableName}" requires a non-empty "rows" array.`);
      }

      // Locate the table XML and its owning sheet
      let matchedTableFile: string | null = null;
      let matchedSheet: ParsedSheetEntry | null = null;

      for (const s of sheets) {
        const sheetBase = s.file.split('/').pop() ?? '';
        const sRels = parseRelsMap(utf8(files[`xl/worksheets/_rels/${sheetBase}.rels`]), 'xl/worksheets');
        for (const rel of sRels.values()) {
          if (rel.target.startsWith('xl/tables/') && files[rel.target]) {
            const tXml = utf8(files[rel.target]);
            const tSpan = findFirstElement(tXml, 'table');
            if (tSpan) {
              const name = decodeXml(getAttr(tSpan.attrs, 'name') ?? '');
              const disp = decodeXml(getAttr(tSpan.attrs, 'displayName') ?? name);
              if (
                name.toLowerCase() === tableName.toLowerCase() ||
                disp.toLowerCase() === tableName.toLowerCase()
              ) {
                matchedTableFile = rel.target;
                matchedSheet = s;
                break;
              }
            }
          }
        }
        if (matchedTableFile) break;
      }

      if (!matchedTableFile || !matchedSheet) {
        throw new Error(`Table "${tableName}" not found in workbook.`);
      }

      const tableXml = utf8(files[matchedTableFile]);
      const tableSpan = findFirstElement(tableXml, 'table');
      if (!tableSpan) throw new Error(`Malformed table XML in ${matchedTableFile}.`);
      const totalsRowCount = Number(getAttr(tableSpan.attrs, 'totalsRowCount') ?? 0);
      if (totalsRowCount > 0) {
        throw new Error(
          `Cannot append rows to table "${tableName}": table has a totals row (totalsRowCount=${totalsRowCount}), which would require inserting rows and shifting cells below.`,
        );
      }

      const tableRef = getAttr(tableSpan.attrs, 'ref') ?? '';
      const tableBounds = parseRangeRef(tableRef);
      if (!tableBounds) {
        throw new Error(`Table "${tableName}" has invalid ref="${tableRef}".`);
      }

      const colSpans = findElements(tableXml, 'tableColumn');
      const colNames = colSpans.map((tc) => decodeXml(getAttr(tc.attrs, 'name') ?? ''));
      const numCols = tableBounds.endCol - tableBounds.startCol + 1;

      const parsedWs = await getParsedWorksheet(matchedSheet);

      // Ensure target rows below the table are currently unoccupied
      const firstNewRow = tableBounds.endRow + 1;
      const lastNewRow = tableBounds.endRow + rowsToAppend.length;
      for (let r = firstNewRow; r <= lastNewRow; r++) {
        for (let c = tableBounds.startCol; c <= tableBounds.endCol; c++) {
          const ref = `${columnLetters(c)}${r}`;
          const existing = parsedWs.cellsByRef.get(ref);
          if (existing && (existing.value !== null || existing.formula !== undefined)) {
            throw new Error(
              `Cannot append rows to table "${tableName}": cell ${matchedSheet.name}!${ref} below the table is not empty.`,
            );
          }
        }
      }

      // Queue cell edits for each appended row, inheriting column styles & calculated formulas from `tableBounds.endRow`
      for (let rOffset = 0; rOffset < rowsToAppend.length; rOffset++) {
        const targetRow = firstNewRow + rOffset;
        const rowInput = rowsToAppend[rOffset]!;
        for (let cOffset = 0; cOffset < numCols; cOffset++) {
          const col = tableBounds.startCol + cOffset;
          const cellRef = `${columnLetters(col)}${targetRow}`;
          const templateCell = parsedWs.cellsByRef.get(`${columnLetters(col)}${tableBounds.endRow}`);
          const colName = colNames[cOffset] ?? '';

          let rawVal: string | number | boolean | null | undefined;
          if (Array.isArray(rowInput)) {
            rawVal = rowInput[cOffset];
          } else if (rowInput && typeof rowInput === 'object') {
            rawVal =
              rowInput[colName] ??
              Object.entries(rowInput).find(([k]) => k.toLowerCase() === colName.toLowerCase())?.[1];
          }

          if (rawVal === undefined && templateCell?.formula !== undefined) {
            const shifted = await shiftFormulaReferences(templateCell.formula, rOffset + 1, 0);
            queueCellEdit({
              sheet: matchedSheet.name,
              cell: cellRef,
              row: targetRow,
              col,
              formula: shifted,
              ...(templateCell.styleIdx !== undefined ? { preserveStyleIdx: templateCell.styleIdx } : {}),
            });
          } else if (typeof rawVal === 'string' && rawVal.startsWith('=')) {
            queueCellEdit({
              sheet: matchedSheet.name,
              cell: cellRef,
              row: targetRow,
              col,
              formula: rawVal.slice(1),
              ...(templateCell?.styleIdx !== undefined ? { preserveStyleIdx: templateCell.styleIdx } : {}),
            });
          } else if (rawVal !== undefined && rawVal !== null) {
            queueCellEdit({
              sheet: matchedSheet.name,
              cell: cellRef,
              row: targetRow,
              col,
              value: rawVal,
              ...(templateCell?.styleIdx !== undefined ? { preserveStyleIdx: templateCell.styleIdx } : {}),
            });
          }
        }
      }

      // Patch `ref` on `<table ...>` and `<autoFilter ...>` in `xl/tables/tableK.xml`
      const newTableRef = `${columnLetters(tableBounds.startCol)}${tableBounds.startRow}:${columnLetters(tableBounds.endCol)}${lastNewRow}`;
      const tableSplices: XmlSplice[] = [
        patchOpeningTagAttrs(tableXml, tableSpan, { ref: newTableRef }, xmlEscape),
      ];
      const autoFilterSpan = findFirstElement(tableXml, 'autoFilter', tableSpan.innerStart, tableSpan.innerEnd);
      if (autoFilterSpan) {
        tableSplices.push(patchOpeningTagAttrs(tableXml, autoFilterSpan, { ref: newTableRef }, xmlEscape));
      }
      files[matchedTableFile] = encodeUtf8(applyXmlSplices(tableXml, tableSplices));
      touchedTableNames.add(tableName.toLowerCase());
      diffBeforeLines.push(`Table ${tableName}: ${tableRef}`);
      diffAfterLines.push(`Table ${tableName}: ${newTableRef}`);
      diffSummaryLines.push(`Table ${tableName}: ${tableRef} → ${newTableRef}`);
      continue;
    }

    // Standard `set_cell` edit
    const sheetName = (rawEdit.sheet ?? '').trim();
    const cellStr = (rawEdit.cell ?? '').trim().toUpperCase();
    if (!sheetName || !cellStr) {
      throw new Error('Each cell edit must specify "sheet" and "cell" (e.g. { sheet: "Summary", cell: "B7", value: 1200 }).');
    }
    const sheetEntry = findSheetByName(sheets, sheetName);
    if (!sheetEntry) {
      throw new Error(
        `Sheet "${sheetName}" not found. Available sheets: ${sheets.map((s) => s.name).join(', ')}`,
      );
    }
    const coord = parseCellRef(cellStr);
    if (!coord) {
      throw new Error(`Invalid cell reference "${rawEdit.cell}". Expected A1 notation such as "B7" or "AA12".`);
    }
    if (
      rawEdit.value === undefined &&
      rawEdit.formula === undefined &&
      !rawEdit.clear &&
      rawEdit.numFmt === undefined
    ) {
      throw new Error(
        `Edit for ${sheetEntry.name}!${cellStr} must specify at least one of "value", "formula", "clear", or "numFmt".`,
      );
    }

    queueCellEdit({
      sheet: sheetEntry.name,
      cell: `${coord.colStr}${coord.row}`,
      row: coord.row,
      col: coord.col,
      ...(rawEdit.value !== undefined ? { value: rawEdit.value } : {}),
      ...(rawEdit.formula !== undefined ? { formula: rawEdit.formula } : {}),
      ...(rawEdit.clear !== undefined ? { clear: rawEdit.clear } : {}),
      ...(rawEdit.numFmt !== undefined ? { numFmt: rawEdit.numFmt } : {}),
    });
  }

  // Phase C: Apply cell edits per worksheet using byte-offset splicing
  const directlyEditedCells: string[] = [];

  for (const [sheetName, editMap] of cellEditsBySheet.entries()) {
    const sheetEntry = findSheetByName(sheets, sheetName)!;
    let xml = utf8(files[sheetEntry.file]);
    const parsedWs = await getParsedWorksheet(sheetEntry);

    // 1. Validate none of the edited cells touch an array formula or spill range
    for (const edit of editMap.values()) {
      const existing = parsedWs.cellsByRef.get(edit.cell);
      if (existing?.formulaType === 'array' || existing?.cm !== undefined) {
        throw new Error(
          `Cannot edit ${sheetName}!${edit.cell}: cell is part of an array formula or dynamic spill range${existing.formulaRef ? ` (${existing.formulaRef})` : ''}.`,
        );
      }
      for (const arr of parsedWs.arrayRanges) {
        if (
          edit.col >= arr.startCol &&
          edit.col <= arr.endCol &&
          edit.row >= arr.startRow &&
          edit.row <= arr.endRow
        ) {
          throw new Error(
            `Cannot edit ${sheetName}!${edit.cell}: cell falls inside array formula range ${sheetName}!${arr.ref}.`,
          );
        }
      }
    }

    // 2. Record diff lines and check if any existing formula cell was changed/cleared
    for (const edit of editMap.values()) {
      const existing = parsedWs.cellsByRef.get(edit.cell);
      const isNumFmtOnly =
        edit.value === undefined &&
        edit.formula === undefined &&
        !edit.clear &&
        edit.numFmt !== undefined;
      if (existing?.formula !== undefined && !isNumFmtOnly) {
        formulaChanged = true;
      }

      const beforeStr = formatCellSideForDiff(existing);
      const afterStr = isNumFmtOnly ? beforeStr : formatEditAfterForDiff(edit);
      const fmtSuffix = edit.numFmt ? ` [numFmt: ${edit.numFmt}]` : '';
      diffBeforeLines.push(`${sheetName}!${edit.cell}: ${beforeStr}`);
      diffAfterLines.push(`${sheetName}!${edit.cell}: ${afterStr}${fmtSuffix}`);
      diffSummaryLines.push(`${sheetName}!${edit.cell}: ${beforeStr} → ${afterStr}${fmtSuffix}`);
      directlyEditedCells.push(`${sheetName}!${edit.cell}`);
    }

    // 3. Identify shared formula groups (`si`) touched by any edit on this sheet
    const touchedSharedGroups = new Set<number>();
    for (const edit of editMap.values()) {
      const isNumFmtOnly =
        edit.value === undefined &&
        edit.formula === undefined &&
        !edit.clear &&
        edit.numFmt !== undefined;
      if (isNumFmtOnly) continue;
      const existing = parsedWs.cellsByRef.get(edit.cell);
      if (existing?.formulaType === 'shared' && existing.sharedIndex !== undefined) {
        touchedSharedGroups.add(existing.sharedIndex);
      }
      for (const [si, master] of parsedWs.sharedMasters.entries()) {
        const mr = parseRangeRef(master.refRange);
        if (
          mr &&
          edit.col >= mr.startCol &&
          edit.col <= mr.endCol &&
          edit.row >= mr.startRow &&
          edit.row <= mr.endRow
        ) {
          touchedSharedGroups.add(si);
        }
      }
    }

    // Expand unedited members of touched shared formula groups into standalone `<f>` elements
    const splices: XmlSplice[] = [];
    for (const si of touchedSharedGroups) {
      const members = parsedWs.sharedMembers.get(si) ?? [];
      for (const member of members) {
        const memberEdit = editMap.get(member.ref);
        const memberChangesValueOrFormula =
          memberEdit !== undefined &&
          (memberEdit.value !== undefined || memberEdit.formula !== undefined || Boolean(memberEdit.clear));
        if (memberChangesValueOrFormula) continue;
        const fSpan = findFirstElement(xml, 'f', member.span.innerStart, member.span.innerEnd);
        if (fSpan && member.formula !== undefined) {
          const fTagName = fSpan.name;
          splices.push({
            start: fSpan.openStart,
            end: fSpan.closeEnd,
            replacement: `<${fTagName}>${xmlEscape(member.formula)}</${fTagName}>`,
          });
          formulaChanged = true;
        }
      }
    }

    // 4. Resolve `numFmt` style indices for edits on this sheet
    const resolvedStyles = new Map<string, number | undefined>();
    for (const edit of editMap.values()) {
      const existing = parsedWs.cellsByRef.get(edit.cell);
      const baseStyleIdx = edit.preserveStyleIdx ?? existing?.styleIdx;
      if (edit.numFmt !== undefined) {
        const res = await ensureStyleIndexForNumFmt(stylesXml, baseStyleIdx, edit.numFmt);
        stylesXml = res.stylesXml;
        stylesModified = true;
        resolvedStyles.set(edit.cell, res.styleIdx);
      } else {
        resolvedStyles.set(edit.cell, baseStyleIdx);
      }
    }

    // 5. Group edits by row number to splice existing `<row>`s or insert new `<row>`s
    const editsByRow = new Map<number, NormalizedCellEdit[]>();
    for (const edit of editMap.values()) {
      const list = editsByRow.get(edit.row) ?? [];
      list.push(edit);
      editsByRow.set(edit.row, list);
    }
    for (const list of editsByRow.values()) {
      list.sort((a, b) => a.col - b.col);
    }

    const sheetDataSpan = findFirstElement(xml, 'sheetData');
    if (!sheetDataSpan) {
      throw new Error(`Malformed worksheet ${sheetEntry.file}: missing <sheetData>.`);
    }
    const tagPrefix = stripPrefix(sheetDataSpan.name) === sheetDataSpan.name
      ? ''
      : sheetDataSpan.name.split(':')[0]!;
    const rowTag = tagPrefix ? `${tagPrefix}:row` : 'row';

    if (sheetDataSpan.selfClosing) {
      const allNewRows = [...editsByRow.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([rNum, rowEdits]) => {
          const cellsXml = rowEdits
            .map((e) =>
              buildCellElementXml(tagPrefix, e.cell, undefined, xml, e, resolvedStyles.get(e.cell), xmlEscape),
            )
            .join('');
          return `<${rowTag} r="${rNum}">${cellsXml}</${rowTag}>`;
        })
        .join('');
      splices.push({
        start: sheetDataSpan.openStart,
        end: sheetDataSpan.closeEnd,
        replacement: `<${sheetDataSpan.name}>${allNewRows}</${sheetDataSpan.name}>`,
      });
    } else {
      const existingRowSpans = findElements(xml, 'row', sheetDataSpan.innerStart, sheetDataSpan.innerEnd);
      const rowSpanByNum = new Map<number, XmlElementSpan>();
      let runningRow = 0;
      for (const rs of existingRowSpans) {
        const declared = Number(getAttr(rs.attrs, 'r') ?? 0);
        const rNum = declared > 0 ? declared : runningRow + 1;
        runningRow = rNum;
        rowSpanByNum.set(rNum, rs);
      }

      const newRowsToInsert: Array<{ row: number; xml: string }> = [];

      for (const [rNum, rowEdits] of editsByRow.entries()) {
        const rowSpan = rowSpanByNum.get(rNum);
        if (!rowSpan) {
          const cellsXml = rowEdits
            .map((e) =>
              buildCellElementXml(tagPrefix, e.cell, undefined, xml, e, resolvedStyles.get(e.cell), xmlEscape),
            )
            .join('');
          newRowsToInsert.push({ row: rNum, xml: `<${rowTag} r="${rNum}">${cellsXml}</${rowTag}>` });
          continue;
        }

        if (rowSpan.selfClosing) {
          const cellsXml = rowEdits
            .map((e) =>
              buildCellElementXml(tagPrefix, e.cell, undefined, xml, e, resolvedStyles.get(e.cell), xmlEscape),
            )
            .join('');
          const openTag = `${xml.slice(rowSpan.openStart, rowSpan.openEnd - 2)}>`;
          splices.push({
            start: rowSpan.openStart,
            end: rowSpan.closeEnd,
            replacement: `${openTag}${cellsXml}</${rowSpan.name}>`,
          });
          continue;
        }

        // Row exists and has children: locate existing `<c>` spans in this row
        const cSpans = findElements(xml, 'c', rowSpan.innerStart, rowSpan.innerEnd);
        const cSpanByCol = new Map<number, XmlElementSpan>();
        const orderedCols: Array<{ col: number; span: XmlElementSpan }> = [];
        let nextCol = 0;
        for (const cs of cSpans) {
          const rAttr = getAttr(cs.attrs, 'r');
          const coord = rAttr ? parseCellRef(rAttr) : null;
          const cIdx = coord ? coord.col : nextCol;
          nextCol = cIdx + 1;
          cSpanByCol.set(cIdx, cs);
          orderedCols.push({ col: cIdx, span: cs });
        }

        // Group new cells by their insertion offset inside this row so multiple new cells at the same position stay in column order
        const insertionsByPos = new Map<number, string[]>();
        for (const edit of rowEdits) {
          const existingCSpan = cSpanByCol.get(edit.col);
          const isNumFmtOnly =
            edit.value === undefined &&
            edit.formula === undefined &&
            !edit.clear &&
            edit.numFmt !== undefined;
          if (existingCSpan && isNumFmtOnly) {
            const sIdx = resolvedStyles.get(edit.cell);
            splices.push(
              patchOpeningTagAttrs(
                xml,
                existingCSpan,
                { s: sIdx !== undefined ? String(sIdx) : null },
                xmlEscape,
              ),
            );
            continue;
          }
          const cellXml = buildCellElementXml(
            tagPrefix,
            edit.cell,
            existingCSpan,
            xml,
            edit,
            resolvedStyles.get(edit.cell),
            xmlEscape,
          );
          if (existingCSpan) {
            splices.push({
              start: existingCSpan.openStart,
              end: existingCSpan.closeEnd,
              replacement: cellXml,
            });
          } else {
            const nextExisting = orderedCols.find((oc) => oc.col > edit.col);
            const insertPos = nextExisting ? nextExisting.span.openStart : rowSpan.innerEnd;
            const list = insertionsByPos.get(insertPos) ?? [];
            list.push(cellXml);
            insertionsByPos.set(insertPos, list);
          }
        }
        for (const [pos, chunks] of insertionsByPos.entries()) {
          splices.push({ start: pos, end: pos, replacement: chunks.join('') });
        }
      }

      // Insert any brand-new rows in ascending row order
      if (newRowsToInsert.length > 0) {
        newRowsToInsert.sort((a, b) => a.row - b.row);
        const rowInsertsByPos = new Map<number, string[]>();
        const orderedRows = [...rowSpanByNum.entries()].sort((a, b) => a[0] - b[0]);
        for (const nr of newRowsToInsert) {
          const nextRow = orderedRows.find(([rNum]) => rNum > nr.row);
          const pos = nextRow ? nextRow[1].openStart : sheetDataSpan.innerEnd;
          const list = rowInsertsByPos.get(pos) ?? [];
          list.push(nr.xml);
          rowInsertsByPos.set(pos, list);
        }
        for (const [pos, chunks] of rowInsertsByPos.entries()) {
          splices.push({ start: pos, end: pos, replacement: chunks.join('') });
        }
      }
    }

    // 6. Update `<dimension ref="..."/>` if edited cells expand the sheet's used range
    const dimSpan = findFirstElement(xml, 'dimension');
    if (dimSpan) {
      const oldDim = getAttr(dimSpan.attrs, 'ref');
      const oldBounds = oldDim ? parseRangeRef(oldDim) : null;
      let minC = oldBounds ? oldBounds.startCol : Infinity;
      let maxC = oldBounds ? oldBounds.endCol : -1;
      let minR = oldBounds ? oldBounds.startRow : Infinity;
      let maxR = oldBounds ? oldBounds.endRow : 0;
      for (const edit of editMap.values()) {
        if (edit.clear) continue;
        if (edit.col < minC) minC = edit.col;
        if (edit.col > maxC) maxC = edit.col;
        if (edit.row < minR) minR = edit.row;
        if (edit.row > maxR) maxR = edit.row;
      }
      if (maxC >= 0 && maxR >= 1) {
        const newDim =
          minC === maxC && minR === maxR
            ? `${columnLetters(minC)}${minR}`
            : `${columnLetters(minC)}${minR}:${columnLetters(maxC)}${maxR}`;
        if (newDim !== oldDim) {
          splices.push(patchOpeningTagAttrs(xml, dimSpan, { ref: newDim }, xmlEscape));
        }
      }
    }

    xml = applyXmlSplices(xml, splices);
    files[sheetEntry.file] = encodeUtf8(xml);
  }

  if (stylesModified) {
    files['xl/styles.xml'] = encodeUtf8(stylesXml);
  }

  // Phase D: Formula calcChain cleanup & `<calcPr fullCalcOnLoad="1"/>`
  if (formulaChanged) {
    if (files['xl/calcChain.xml']) {
      delete files['xl/calcChain.xml'];
      const wbRelsXml = utf8(files['xl/_rels/workbook.xml.rels']);
      if (wbRelsXml) {
        const relSpans = findElements(wbRelsXml, 'Relationship').filter((r) =>
          /calcChain\.xml$/i.test(getAttr(r.attrs, 'Target') ?? ''),
        );
        if (relSpans.length > 0) {
          files['xl/_rels/workbook.xml.rels'] = encodeUtf8(
            applyXmlSplices(
              wbRelsXml,
              relSpans.map((r) => ({ start: r.openStart, end: r.closeEnd, replacement: '' })),
            ),
          );
        }
      }
      const ctXml = utf8(files['[Content_Types].xml']);
      if (ctXml) {
        const ovSpans = findElements(ctXml, 'Override').filter((o) =>
          /calcChain\.xml$/i.test(getAttr(o.attrs, 'PartName') ?? ''),
        );
        if (ovSpans.length > 0) {
          files['[Content_Types].xml'] = encodeUtf8(
            applyXmlSplices(
              ctXml,
              ovSpans.map((o) => ({ start: o.openStart, end: o.closeEnd, replacement: '' })),
            ),
          );
        }
      }
    }

    const wbXml = utf8(files['xl/workbook.xml']);
    if (wbXml) {
      const calcPrSpan = findFirstElement(wbXml, 'calcPr');
      if (calcPrSpan) {
        files['xl/workbook.xml'] = encodeUtf8(
          applyXmlSplices(wbXml, [
            patchOpeningTagAttrs(wbXml, calcPrSpan, { fullCalcOnLoad: '1' }, xmlEscape),
          ]),
        );
      } else {
        const wbRoot = findFirstElement(wbXml, 'workbook');
        if (wbRoot && !wbRoot.selfClosing) {
          const pfx = stripPrefix(wbRoot.name) === wbRoot.name ? '' : `${wbRoot.name.split(':')[0]}:`;
          files['xl/workbook.xml'] = encodeUtf8(
            applyXmlSplices(wbXml, [
              {
                start: wbRoot.innerEnd,
                end: wbRoot.innerEnd,
                replacement: `<${pfx}calcPr fullCalcOnLoad="1"/>`,
              },
            ]),
          );
        }
      }
    }
  }

  // Phase E: Mark affected pivot caches `refreshOnLoad="1"`
  for (const k of Object.keys(files).filter((n) => /^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/.test(n))) {
    const cacheXml = utf8(files[k]);
    const defSpan = findFirstElement(cacheXml, 'pivotCacheDefinition');
    const wsSource = findFirstElement(cacheXml, 'worksheetSource');
    if (!defSpan || !wsSource) continue;
    const srcSheet = getAttr(wsSource.attrs, 'sheet') ?? '';
    const srcName = getAttr(wsSource.attrs, 'name') ?? '';
    const isAffected =
      (srcSheet && Array.from(touchedSheetNames).some((s) => s.toLowerCase() === srcSheet.toLowerCase())) ||
      (srcName && touchedTableNames.has(srcName.toLowerCase()));
    if (isAffected) {
      files[k] = encodeUtf8(
        applyXmlSplices(cacheXml, [
          patchOpeningTagAttrs(cacheXml, defSpan, { refreshOnLoad: '1' }, xmlEscape),
        ]),
      );
    }
  }

  return {
    files,
    diff: {
      before: diffBeforeLines.join('\n'),
      after: diffAfterLines.join('\n'),
      lines: diffSummaryLines,
    },
    directlyEditedCells,
    formulaChanged,
    warnings,
  };
}

/**
 * Back-patches recalculated `<v>` elements from `recalcFiles` into formula
 * cells of `patchedFiles` using byte-offset splicing, and computes downstream
 * formula value changes and new error cells relative to `origFiles`.
 */
export async function backpatchRecalculatedValues(
  origFiles: Record<string, Uint8Array>,
  patchedFiles: Record<string, Uint8Array>,
  recalcFiles: Record<string, Uint8Array>,
  directlyEditedCells: string[],
): Promise<{
  files: Record<string, Uint8Array>;
  downstreamChanges: SheetDownstreamChange[];
  newErrors: SheetErrorCell[];
}> {
  const {
    utf8,
    xmlEscape,
    parseSharedStrings,
    parseXlsxStylesFull,
    parseWorkbookSheets,
  } = await loadXlsxShared();

  const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
  const outFiles: Record<string, Uint8Array> = { ...patchedFiles };
  const directSet = new Set(directlyEditedCells);

  const { sheets: origSheets, date1904: orig1904 } = parseWorkbookSheets(origFiles);
  const origShared = parseSharedStrings(utf8(origFiles['xl/sharedStrings.xml']));
  const { xfStyles: origStyles } = parseXlsxStylesFull(utf8(origFiles['xl/styles.xml']));

  const { sheets: patchedSheets, date1904: patched1904 } = parseWorkbookSheets(outFiles);
  const patchedShared = parseSharedStrings(utf8(outFiles['xl/sharedStrings.xml']));
  const { xfStyles: patchedStyles } = parseXlsxStylesFull(utf8(outFiles['xl/styles.xml']));

  const { sheets: recalcSheets, date1904: recalc1904 } = parseWorkbookSheets(recalcFiles);
  const recalcShared = parseSharedStrings(utf8(recalcFiles['xl/sharedStrings.xml']));
  const { xfStyles: recalcStyles } = parseXlsxStylesFull(utf8(recalcFiles['xl/styles.xml']));

  const origBySheet = new Map<string, ParsedWorksheet>();
  for (const s of origSheets) {
    origBySheet.set(s.name, await parseWorksheet(utf8(origFiles[s.file]), origShared, origStyles, orig1904));
  }
  const recalcBySheet = new Map<string, ParsedWorksheet>();
  for (const s of recalcSheets) {
    recalcBySheet.set(s.name, await parseWorksheet(utf8(recalcFiles[s.file]), recalcShared, recalcStyles, recalc1904));
  }

  const downstreamChanges: SheetDownstreamChange[] = [];
  const newErrors: SheetErrorCell[] = [];

  for (const sheet of patchedSheets) {
    const xml = utf8(outFiles[sheet.file]);
    const parsedPatched = await parseWorksheet(xml, patchedShared, patchedStyles, patched1904);
    const parsedOrig = origBySheet.get(sheet.name);
    const parsedRecalc = recalcBySheet.get(sheet.name);
    if (!parsedRecalc) continue;

    const splices: XmlSplice[] = [];

    for (const cell of parsedPatched.cellsInOrder) {
      if (cell.formula === undefined) continue;
      const rCell = parsedRecalc.cellsByRef.get(cell.ref);
      if (!rCell || (rCell.value === null && rCell.rawValue === '')) continue;

      const oCell = parsedOrig?.cellsByRef.get(cell.ref);
      const rIsError = rCell.type === 'e' || (typeof rCell.value === 'string' && isExcelError(rCell.value));
      const oIsError = oCell ? (oCell.type === 'e' || (typeof oCell.value === 'string' && isExcelError(oCell.value))) : false;

      if (rIsError && (!oIsError || oCell?.value !== rCell.value)) {
        newErrors.push({
          sheet: sheet.name,
          cell: cell.ref,
          error: String(rCell.value || rCell.rawValue),
          formula: `=${cell.formula}`,
        });
      }

      const fullKey = `${sheet.name}!${cell.ref}`;
      if (!directSet.has(fullKey) && oCell && !valuesAgree(oCell.value, rCell.value)) {
        downstreamChanges.push({
          sheet: sheet.name,
          cell: cell.ref,
          formula: `=${cell.formula}`,
          before: oCell.formatted || (oCell.value !== null ? String(oCell.value) : '(empty)'),
          after: rCell.formatted || (rCell.value !== null ? String(rCell.value) : '(empty)'),
        });
      }

      // Splice recalculated `<v>` and type `t` onto the formula `<c>` element in `patchedFiles`
      let newTAttr: string | null = null;
      let newVText = '';
      if (rIsError) {
        newTAttr = 'e';
        newVText = String(rCell.value || rCell.rawValue);
      } else if (typeof rCell.value === 'boolean') {
        newTAttr = 'b';
        newVText = rCell.value ? '1' : '0';
      } else if (typeof rCell.value === 'number') {
        newTAttr = null;
        newVText = String(rCell.value);
      } else if (typeof rCell.value === 'string') {
        newTAttr = 'str';
        newVText = rCell.value;
      }

      if (newTAttr !== (cell.type === 'n' ? null : cell.type)) {
        splices.push(patchOpeningTagAttrs(xml, cell.span, { t: newTAttr }, xmlEscape));
      }

      const vSpan = findFirstElement(xml, 'v', cell.span.innerStart, cell.span.innerEnd);
      const tagPfx = stripPrefix(cell.span.name) === cell.span.name ? '' : `${cell.span.name.split(':')[0]}:`;
      const vTag = `${tagPfx}v`;
      if (vSpan) {
        splices.push({
          start: vSpan.openStart,
          end: vSpan.closeEnd,
          replacement: `<${vTag}>${xmlEscape(newVText)}</${vTag}>`,
        });
      } else {
        const fSpan = findFirstElement(xml, 'f', cell.span.innerStart, cell.span.innerEnd);
        const insertAt = fSpan ? fSpan.closeEnd : cell.span.innerEnd;
        splices.push({
          start: insertAt,
          end: insertAt,
          replacement: `<${vTag}>${xmlEscape(newVText)}</${vTag}>`,
        });
      }
    }

    if (splices.length > 0) {
      outFiles[sheet.file] = encodeUtf8(applyXmlSplices(xml, splices));
    }
  }

  return { files: outFiles, downstreamChanges, newErrors };
}

export function formatSheetEditResult(
  outputPath: string,
  diff: SheetDiffPayload,
  downstreamChanges: SheetDownstreamChange[],
  newErrors: SheetErrorCell[],
  warnings: string[],
  recalculated: boolean,
): string {
  const lines: string[] = [];
  lines.push(`Wrote patched workbook to ${outputPath}`);
  lines.push(`\nApplied edits (${diff.lines.length}):`);
  for (const l of diff.lines) {
    lines.push(`  ${l}`);
  }
  if (recalculated) {
    if (downstreamChanges.length > 0) {
      lines.push(`\nDownstream formula changes (${downstreamChanges.length}):`);
      for (const d of downstreamChanges) {
        lines.push(`  ${d.sheet}!${d.cell} (${d.formula}): ${d.before} → ${d.after}`);
      }
    } else {
      lines.push(`\nDownstream formula changes: none`);
    }
    if (newErrors.length > 0) {
      lines.push(`\nNew error cells (${newErrors.length}):`);
      for (const e of newErrors) {
        lines.push(`  ${e.sheet}!${e.cell}: ${e.error}${e.formula ? ` (${e.formula})` : ''}`);
      }
    }
  }
  if (warnings.length > 0) {
    lines.push(`\nWarnings:`);
    for (const w of warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join('\n');
}

// ---- Child-Process Entrypoint ------------------------------------------------

async function handleRequest(req: SheetWorkerRequest): Promise<SheetWorkerResponse> {
  const { readZipSafe } = await loadXlsxShared();
  const { zipSync } = await import('fflate');

  switch (req.op) {
    case 'sheet_info': {
      const data = fs.readFileSync(req.filePath);
      const files = await readZipSafe(data, req.maxUnzippedBytes);
      const text = await runSheetInfo(files);
      return { ok: true, text };
    }
    case 'sheet_read': {
      const data = fs.readFileSync(req.filePath);
      const files = await readZipSafe(data, req.maxUnzippedBytes);
      const text = await runSheetRead(
        files,
        req.sheet,
        req.range,
        req.include,
        req.maxLines,
        req.maxBytes,
      );
      return { ok: true, text };
    }
    case 'sheet_find': {
      const data = fs.readFileSync(req.filePath);
      const files = await readZipSafe(data, req.maxUnzippedBytes);
      const text = await runSheetFind(files, req.query, req.scope ?? 'both', req.sheet);
      return { ok: true, text };
    }
    case 'sheet_check': {
      const origData = fs.readFileSync(req.filePath);
      const origFiles = await readZipSafe(origData, req.maxUnzippedBytes);
      const recalcFiles = req.recalculatedPath
        ? await readZipSafe(fs.readFileSync(req.recalculatedPath), req.maxUnzippedBytes)
        : null;
      const text = await runSheetCheck(origFiles, recalcFiles, req.libreOfficeAvailable);
      return { ok: true, text };
    }
    case 'sheet_edit_preview': {
      const origData = fs.readFileSync(req.filePath);
      const origFiles = await readZipSafe(origData, req.maxUnzippedBytes);
      const plan = await buildSheetEditPatch(origFiles, req.edits);
      return {
        ok: true,
        text: plan.diff.lines.join('\n'),
        diff: plan.diff,
        directlyEditedCells: plan.directlyEditedCells,
        formulaChanged: plan.formulaChanged,
        warnings: plan.warnings,
      };
    }
    case 'sheet_edit_apply': {
      const origData = fs.readFileSync(req.filePath);
      const origFiles = await readZipSafe(origData, req.maxUnzippedBytes);
      const plan = await buildSheetEditPatch(origFiles, req.edits);
      const zipped = zipSync(plan.files, { level: 6 });
      const fd = fs.openSync(
        req.outputPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
        0o644,
      );
      try {
        fs.writeFileSync(fd, zipped);
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        text: formatSheetEditResult(req.outputPath, plan.diff, [], [], plan.warnings, false),
        diff: plan.diff,
        directlyEditedCells: plan.directlyEditedCells,
        formulaChanged: plan.formulaChanged,
        warnings: plan.warnings,
      };
    }
    case 'sheet_edit_backpatch': {
      const origFiles = await readZipSafe(fs.readFileSync(req.originalPath), req.maxUnzippedBytes);
      const patchedFiles = await readZipSafe(fs.readFileSync(req.patchedPath), req.maxUnzippedBytes);
      const recalcFiles = await readZipSafe(fs.readFileSync(req.recalculatedPath), req.maxUnzippedBytes);
      const bp = await backpatchRecalculatedValues(
        origFiles,
        patchedFiles,
        recalcFiles,
        req.directlyEditedCells,
      );
      const zipped = zipSync(bp.files, { level: 6 });
      fs.writeFileSync(req.patchedPath, zipped);
      return {
        ok: true,
        text: '',
        downstreamChanges: bp.downstreamChanges,
        newErrors: bp.newErrors,
      };
    }
  }
}

const isWorkerEntry = Boolean(process.argv[1] && /sheet-worker\.[cm]?[jt]s$/.test(process.argv[1]));

if (typeof process.send === 'function' && isWorkerEntry) {
  (globalThis as { fetch?: unknown }).fetch = () =>
    Promise.reject(new Error('Network access is disabled inside the spreadsheet worker.'));

  process.once('message', (req: SheetWorkerRequest) => {
    const watchdog = setInterval(() => {
      if (process.memoryUsage.rss() > req.maxRssBytes) {
        process.exit(2);
      }
    }, 50);
    watchdog.unref();

    void handleRequest(req)
      .then((res) => {
        process.send!(res, () => process.exit(0));
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        const res: SheetWorkerResponse = { ok: false, error: msg };
        process.send!(res, () => process.exit(0));
      });
  });
  process.once('disconnect', () => process.exit(0));
}
