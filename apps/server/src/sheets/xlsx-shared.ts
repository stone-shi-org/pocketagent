/**
 * PA-139 / PA-140: shared OOXML zip, bomb-check, coordinate, comment, and
 * `xl/styles.xml` number-formatting helpers used by both the attachment
 * extractor (`attachments/extract-worker.ts`) and the spreadsheet tool worker
 * (`sheets/sheet-worker.ts`).
 *
 * Kept to erasable TypeScript (no enums, no parameter properties, no
 * namespaces) and zero repo imports so both child workers can load it under
 * Node's built-in type stripping in dev/tests and as compiled `.js` in `dist/`.
 */

export type XlsxNumberStyle =
  | { kind: 'general'; formatCode: string }
  | { kind: 'date'; formatCode: string }
  | { kind: 'datetime'; formatCode: string }
  | { kind: 'time'; formatCode: string }
  | { kind: 'percent'; decimals: number; formatCode: string }
  | { kind: 'currency'; symbol: string; decimals: number; formatCode: string }
  | { kind: 'number'; decimals: number; thousands: boolean; formatCode: string };

export interface XlsxXfStyle {
  numFmtId: number;
  formatCode: string;
  style: XlsxNumberStyle;
}

export interface ParsedSheetEntry {
  name: string;
  sheetId: number;
  rId: string;
  file: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  hidden: boolean;
}

export interface ParsedCellCoord {
  col: number;
  row: number;
  colStr: string;
  absCol: boolean;
  absRow: boolean;
}

export interface ParsedRangeCoord {
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
  startColStr: string;
  endColStr: string;
}

/**
 * Standard built-in Excel number format codes (`numFmtId` 0–49).
 */
export const BUILTIN_NUMFMT_CODES: Readonly<Record<number, string>> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '$#,##0_);($#,##0)',
  6: '$#,##0_);[Red]($#,##0)',
  7: '$#,##0.00_);($#,##0.00)',
  8: '$#,##0.00_);[Red]($#,##0.00)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'yyyy-mm-dd hh:mm:ss',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)',
  42: '_($* #,##0_);_($* (#,##0);_($* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
  44: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};

const BUILTIN_DATE_IDS = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_TIME_IDS = new Set([18, 19, 20, 21, 32, 33, 34, 35, 45, 46, 47]);
const BUILTIN_CURRENCY_IDS = new Set([5, 6, 7, 8, 37, 38, 39, 40, 41, 42, 43, 44]);

/**
 * Reads a zip's central directory and refuses it before inflating anything if
 * the declared sizes add up to more than `maxUnzippedBytes` — the cheap half of
 * the zip-bomb defence. The other half is the worker's RSS cap, because a
 * declared size is the uploader's own claim.
 */
export async function readZipSafe(
  data: Uint8Array,
  maxUnzippedBytes: number,
  want?: (name: string) => boolean,
): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  let declared = 0;
  unzipSync(data, {
    filter(file) {
      declared += file.originalSize;
      return false;
    },
  });
  if (declared > maxUnzippedBytes) {
    throw new Error(
      `The document unpacks to ${Math.round(declared / (1024 * 1024))} MB, over the ${Math.round(maxUnzippedBytes / (1024 * 1024))} MB limit.`,
    );
  }
  if (!want) return unzipSync(data);
  return unzipSync(data, { filter: (file) => want(file.name) });
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * XML/HTML text content → string. Numeric references and predefined entities
 * only; anything else stays as written, since there is no DTD.
 */
export function decodeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return safeCodePoint(Number.parseInt(ref.slice(2), 16)) ?? whole;
    if (ref.startsWith('#')) return safeCodePoint(Number.parseInt(ref.slice(1), 10)) ?? whole;
    return ENTITIES[ref] ?? whole;
  });
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null;
}

export function utf8(bytes: Uint8Array | undefined): string {
  return bytes ? new TextDecoder('utf-8').decode(bytes) : '';
}

/** Text of every `<tag>`-like run inside `xml`, in order. */
export function runs(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let text = '';
  for (const m of xml.matchAll(re)) text += decodeXml(m[1] ?? '');
  return text;
}

export function byNumber(a: string, b: string): number {
  return Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);
}

/** `B12` or `B` → 1 (zero-based column). */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code === 36) continue; // '$'
    if (code >= 97 && code <= 122) {
      n = n * 26 + (code - 96);
    } else if (code >= 65 && code <= 90) {
      n = n * 26 + (code - 64);
    } else {
      break;
    }
  }
  return n - 1;
}

/** Zero-based column index → Excel column letters (`0` → `A`, `26` → `AA`). */
export function columnLetters(col: number): string {
  let n = col + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

/** Parses an A1 cell coordinate like `B12` or `$B$12` into zero-based `col` and 1-based `row`. */
export function parseCellRef(ref: string): ParsedCellCoord | null {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)$/.exec(ref.trim());
  if (!m) return null;
  const colStr = m[2]!.toUpperCase();
  const col = columnIndex(colStr);
  const row = Number(m[4]);
  if (col < 0 || col >= 16_384 || !Number.isInteger(row) || row < 1 || row > 1_048_576) return null;
  return {
    col,
    row,
    colStr,
    absCol: m[1] === '$',
    absRow: m[3] === '$',
  };
}

/** Parses an A1 range like `A1:G50` or a single cell `B7` into normalized start/end bounds. */
export function parseRangeRef(range: string): ParsedRangeCoord | null {
  const clean = range.trim().replace(/^.*!/, '');
  const parts = clean.split(':');
  if (parts.length === 1) {
    const single = parseCellRef(parts[0]!);
    if (!single) return null;
    return {
      startCol: single.col,
      startRow: single.row,
      endCol: single.col,
      endRow: single.row,
      startColStr: single.colStr,
      endColStr: single.colStr,
    };
  }
  if (parts.length !== 2) return null;
  const a = parseCellRef(parts[0]!);
  const b = parseCellRef(parts[1]!);
  if (a && b) {
    const startCol = Math.min(a.col, b.col);
    const endCol = Math.max(a.col, b.col);
    const startRow = Math.min(a.row, b.row);
    const endRow = Math.max(a.row, b.row);
    return {
      startCol,
      startRow,
      endCol,
      endRow,
      startColStr: columnLetters(startCol),
      endColStr: columnLetters(endCol),
    };
  }
  // Whole-row range `1:50`
  if (/^\$?[1-9]\d*$/.test(parts[0]!.trim()) && /^\$?[1-9]\d*$/.test(parts[1]!.trim())) {
    const r1 = Number(parts[0]!.replace('$', ''));
    const r2 = Number(parts[1]!.replace('$', ''));
    return {
      startCol: 0,
      startRow: Math.min(r1, r2),
      endCol: 16_383,
      endRow: Math.max(r1, r2),
      startColStr: 'A',
      endColStr: 'XFD',
    };
  }
  // Whole-column range `A:G`
  if (/^\$?[A-Za-z]{1,3}$/.test(parts[0]!.trim()) && /^\$?[A-Za-z]{1,3}$/.test(parts[1]!.trim())) {
    const c1 = columnIndex(parts[0]!.trim());
    const c2 = columnIndex(parts[1]!.trim());
    const startCol = Math.min(c1, c2);
    const endCol = Math.max(c1, c2);
    return {
      startCol,
      startRow: 1,
      endCol,
      endRow: 1_048_576,
      startColStr: columnLetters(startCol),
      endColStr: columnLetters(endCol),
    };
  }
  return null;
}

export function classifyNumberFormat(numFmtId: number, formatCode: string | undefined): XlsxNumberStyle {
  const resolvedCode = formatCode || BUILTIN_NUMFMT_CODES[numFmtId] || 'General';
  if (BUILTIN_DATE_IDS.has(numFmtId)) return { kind: 'date', formatCode: resolvedCode };
  if (numFmtId === 22) return { kind: 'datetime', formatCode: resolvedCode };
  if (BUILTIN_TIME_IDS.has(numFmtId)) return { kind: 'time', formatCode: resolvedCode };
  if (numFmtId === 9) return { kind: 'percent', decimals: 0, formatCode: resolvedCode };
  if (numFmtId === 10) return { kind: 'percent', decimals: 2, formatCode: resolvedCode };
  if (BUILTIN_CURRENCY_IDS.has(numFmtId)) {
    return {
      kind: 'currency',
      symbol: '$',
      decimals: numFmtId === 5 || numFmtId === 6 || numFmtId === 37 || numFmtId === 38 ? 0 : 2,
      formatCode: resolvedCode,
    };
  }
  if (!formatCode) return { kind: 'general', formatCode: resolvedCode };

  // Inspect first format section, stripping quoted literals and escapes.
  let bracketCurrency: string | null = null;
  const cleaned = (formatCode.split(';')[0] ?? '')
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
      if (inner.startsWith('$') && inner.length > 1) {
        const sym = inner.slice(1).split('-')[0] ?? '';
        if (sym) bracketCurrency = sym;
      }
      return '';
    });

  if (cleaned.includes('%')) {
    const decMatch = /\.(0+)/.exec(cleaned);
    return { kind: 'percent', decimals: decMatch ? decMatch[1]!.length : 0, formatCode: resolvedCode };
  }

  const hasDate = /[yYdD]/.test(cleaned) || (/m+/i.test(cleaned) && !/[#0]/.test(cleaned));
  const hasTime = /[hHsS]/.test(cleaned);
  if ((hasDate || hasTime) && !/[#]/.test(cleaned)) {
    if (hasDate && hasTime) return { kind: 'datetime', formatCode: resolvedCode };
    if (hasTime) return { kind: 'time', formatCode: resolvedCode };
    return { kind: 'date', formatCode: resolvedCode };
  }

  const currencySymbol = bracketCurrency ?? (/([$€£¥])/.exec(cleaned)?.[1] ?? null);
  if (currencySymbol) {
    const decMatch = /\.(0+)/.exec(cleaned);
    return {
      kind: 'currency',
      symbol: currencySymbol,
      decimals: decMatch ? decMatch[1]!.length : 0,
      formatCode: resolvedCode,
    };
  }

  if (/[#0]/.test(cleaned) && (cleaned.includes(',') || /\.(0+)/.test(cleaned))) {
    const decMatch = /\.(0+)/.exec(cleaned);
    return {
      kind: 'number',
      decimals: decMatch ? decMatch[1]!.length : 0,
      thousands: cleaned.includes(','),
      formatCode: resolvedCode,
    };
  }

  return { kind: 'general', formatCode: resolvedCode };
}

export function parseXlsxStylesFull(stylesXml: string): {
  xfStyles: XlsxXfStyle[];
  customFormats: Map<number, string>;
} {
  const customFormats = new Map<number, string>();
  if (!stylesXml) return { xfStyles: [], customFormats };
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    const code = decodeXml(/\bformatCode="([^"]*)"/.exec(attrs)?.[1] ?? '');
    if (Number.isFinite(id) && code) customFormats.set(id, code);
  }
  const cellXfsBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const xfStyles: XlsxXfStyle[] = [];
  for (const m of cellXfsBlock.matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
    const attrs = m[1] ?? '';
    const numFmtId = Number(/\bnumFmtId="(\d+)"/.exec(attrs)?.[1] ?? 0);
    const custom = customFormats.get(numFmtId);
    const formatCode = custom ?? BUILTIN_NUMFMT_CODES[numFmtId] ?? 'General';
    xfStyles.push({
      numFmtId,
      formatCode,
      style: classifyNumberFormat(numFmtId, custom),
    });
  }
  return { xfStyles, customFormats };
}

export function parseXlsxStyles(stylesXml: string): XlsxNumberStyle[] {
  return parseXlsxStylesFull(stylesXml).xfStyles.map((x) => x.style);
}

export function formatExcelDate(serial: number, kind: 'date' | 'datetime' | 'time', date1904: boolean): string | null {
  if (!Number.isFinite(serial)) return null;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  if (kind === 'time') {
    const frac = ((serial % 1) + 1) % 1;
    const totalSec = Math.round(frac * 86_400) % 86_400;
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }
  // Excel 1900 epoch has the Lotus 1-2-3 leap-year bug at serial 60 (1900-02-29).
  const epochOffset = date1904 ? 24_107 : serial >= 60 ? 25_569 : 25_568;
  const totalSeconds = Math.round((serial - epochOffset) * 86_400);
  const d = new Date(totalSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const datePart = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const daySec = ((totalSeconds % 86_400) + 86_400) % 86_400;
  if (kind === 'datetime' || daySec !== 0) {
    const hh = Math.floor(daySec / 3600);
    const mm = Math.floor((daySec % 3600) / 60);
    const ss = daySec % 60;
    return `${datePart}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  }
  return datePart;
}

function addThousandsCommas(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatXlsxNumber(
  raw: string,
  style: XlsxNumberStyle | undefined,
  date1904: boolean,
  options?: { thousands?: boolean },
): string {
  if (!style || style.kind === 'general' || raw === '') return raw;
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  if (style.kind === 'date' || style.kind === 'datetime' || style.kind === 'time') {
    return formatExcelDate(num, style.kind, date1904) ?? raw;
  }
  if (style.kind === 'percent') {
    const scaled = num * 100;
    const formatted = style.decimals > 0 ? scaled.toFixed(style.decimals) : String(Math.round(scaled * 1e6) / 1e6);
    return `${formatted}%`;
  }
  if (style.kind === 'currency') {
    const sign = num < 0 ? '-' : '';
    const abs = Math.abs(num);
    const fixed = style.decimals > 0 ? abs.toFixed(style.decimals) : String(Math.round(abs));
    if (options?.thousands && style.formatCode.includes(',')) {
      const [intPart, decPart] = fixed.split('.');
      const withCommas = addThousandsCommas(intPart!);
      return `${sign}${style.symbol}${decPart !== undefined ? `${withCommas}.${decPart}` : withCommas}`;
    }
    return `${sign}${style.symbol}${fixed}`;
  }
  if (style.kind === 'number') {
    const sign = num < 0 ? '-' : '';
    const abs = Math.abs(num);
    const fixed = style.decimals > 0 ? abs.toFixed(style.decimals) : String(Math.round(abs));
    if (options?.thousands && style.thousands) {
      const [intPart, decPart] = fixed.split('.');
      const formattedInt = addThousandsCommas(intPart!);
      return `${sign}${decPart !== undefined ? `${formattedInt}.${decPart}` : formattedInt}`;
    }
    return `${sign}${fixed}`;
  }
  return raw;
}

export function parseSharedStrings(sharedXml: string): string[] {
  const shared: string[] = [];
  if (!sharedXml) return shared;
  for (const m of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    // Phonetic guides (`rPh`) repeat the text in another script; skip them.
    shared.push(runs((m[1] ?? '').replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't'));
  }
  return shared;
}

export function parseWorkbookSheets(
  files: Record<string, Uint8Array>,
): { sheets: ParsedSheetEntry[]; date1904: boolean } {
  const workbookXml = utf8(files['xl/workbook.xml']);
  const workbookRelsXml = utf8(files['xl/_rels/workbook.xml.rels']);
  const date1904 = /<workbookPr\b[^>]*?\bdate1904="(?:1|true)"/i.test(workbookXml);
  const rels = new Map<string, string>();
  for (const m of workbookRelsXml.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const id = /\bId="([^"]*)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]*)"/.exec(attrs)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }
  const sheets: ParsedSheetEntry[] = [];
  for (const m of workbookXml.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? '';
    const name = decodeXml(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? `Sheet${sheets.length + 1}`);
    const sheetId = Number(/\bsheetId="(\d+)"/.exec(attrs)?.[1] ?? sheets.length + 1);
    const rId = /\br:id="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const rawState = /\bstate="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const state: 'visible' | 'hidden' | 'veryHidden' =
      rawState === 'veryHidden' ? 'veryHidden' : rawState === 'hidden' ? 'hidden' : 'visible';
    const file = rels.get(rId) ?? `xl/worksheets/sheet${sheets.length + 1}.xml`;
    sheets.push({ name, sheetId, rId, file, state, hidden: state !== 'visible' });
  }
  if (sheets.length === 0) {
    const found = Object.keys(files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
    found.forEach((name, idx) => {
      sheets.push({
        name: name.replace(/^.*\/|\.xml$/g, ''),
        sheetId: idx + 1,
        rId: `rId${idx + 1}`,
        file: name,
        state: 'visible',
        hidden: false,
      });
    });
  }
  return { sheets, date1904 };
}

export function parseWorksheetComments(
  sheetFile: string,
  files: Record<string, Uint8Array>,
): Array<{ ref: string; author?: string | undefined; text: string }> {
  const m = /^xl\/worksheets\/(sheet\d+\.xml)$/.exec(sheetFile);
  if (!m) return [];
  const relsXml = utf8(files[`xl/worksheets/_rels/${m[1]}.rels`]);
  const commentTargets: string[] = [];
  for (const rel of relsXml.matchAll(/<Relationship\s([^>]*?)\/?>/g)) {
    const target = /\bTarget="([^"]*)"/.exec(rel[1] ?? '')?.[1] ?? '';
    if (/comments\d*\.xml$|threadedComment\d*\.xml$/i.test(target)) {
      const normalized = target.replace(/^(?:\.\.\/)+/, 'xl/').replace(/^\/?(xl\/)?/, 'xl/');
      commentTargets.push(normalized);
    }
  }
  if (commentTargets.length === 0) {
    const num = /sheet(\d+)\.xml$/.exec(sheetFile)?.[1];
    if (num && files[`xl/comments${num}.xml`]) commentTargets.push(`xl/comments${num}.xml`);
  }

  const out: Array<{ ref: string; author?: string | undefined; text: string }> = [];
  for (const target of commentTargets) {
    const xml = utf8(files[target]);
    if (!xml) continue;
    const authors: string[] = [];
    for (const a of xml.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)) {
      authors.push(decodeXml(a[1] ?? '').trim());
    }
    for (const c of xml.matchAll(/<(?:comment|threadedComment)\b([^>]*)>([\s\S]*?)<\/(?:comment|threadedComment)>/g)) {
      const attrs = c[1] ?? '';
      const body = c[2] ?? '';
      const ref = /\bref="([^"]+)"/.exec(attrs)?.[1] ?? '';
      const authorId = /\bauthorId="(\d+)"/.exec(attrs)?.[1];
      const author = authorId !== undefined ? authors[Number(authorId)] : undefined;
      const text = runs(body.replace(/<rPh[\s\S]*?<\/rPh>/g, ''), 't').trim();
      if (ref && text) out.push({ ref, ...(author ? { author } : {}), text });
    }
  }
  return out;
}
