import type { DocVersionCellChange, DocVersionDiffLine } from '@pocketagent/protocol';
import {
  decodeXml,
  formatXlsxNumber,
  parseCellRef,
  parseSharedStrings,
  parseWorkbookSheets,
  parseXlsxStyles,
  readZipSafe,
  runs,
  utf8,
} from '../sheets/xlsx-shared.js';

const MAX_DIFF_LINES_RETURNED = 600;
const MAX_LCS_WINDOW = 600;
const CONTEXT_RADIUS = 3;
const MAX_XLSX_UNZIPPED_BYTES = 128 * 1024 * 1024;

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export interface LineDiffResult {
  added: number;
  removed: number;
  summary: string;
  diffLines: DocVersionDiffLine[];
}

/**
 * Computes a line-level diff and "+M -N lines" summary between two text snapshots.
 * Trims common prefix/suffix first and uses dynamic-programming LCS on bounded
 * middle windows so diffing remains fast even on large files.
 */
export function computeLineDiff(
  beforeText: string | null,
  afterText: string | null,
  labelSuffix = '',
): LineDiffResult {
  const suffix = labelSuffix ? ` (${labelSuffix})` : '';
  if (beforeText === null && afterText === null) {
    return { added: 0, removed: 0, summary: `No changes${suffix}`, diffLines: [] };
  }
  if (beforeText === null) {
    const afterLines = splitLines(afterText ?? '');
    const diffLines: DocVersionDiffLine[] = afterLines
      .slice(0, MAX_DIFF_LINES_RETURNED)
      .map((text, idx) => ({
        type: 'add' as const,
        text,
        oldLine: null,
        newLine: idx + 1,
      }));
    return {
      added: afterLines.length,
      removed: 0,
      summary: `Created (+${afterLines.length} line${afterLines.length === 1 ? '' : 's'})${suffix}`,
      diffLines,
    };
  }
  if (afterText === null) {
    const beforeLines = splitLines(beforeText);
    const diffLines: DocVersionDiffLine[] = beforeLines
      .slice(0, MAX_DIFF_LINES_RETURNED)
      .map((text, idx) => ({
        type: 'del' as const,
        text,
        oldLine: idx + 1,
        newLine: null,
      }));
    return {
      added: 0,
      removed: beforeLines.length,
      summary: `Deleted (-${beforeLines.length} line${beforeLines.length === 1 ? '' : 's'})${suffix}`,
      diffLines,
    };
  }

  const a = splitLines(beforeText);
  const b = splitLines(afterText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffixLen = 0;
  while (
    suffixLen < a.length - prefix &&
    suffixLen < b.length - prefix &&
    a[a.length - 1 - suffixLen] === b[b.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const aMid = a.slice(prefix, a.length - suffixLen);
  const bMid = b.slice(prefix, b.length - suffixLen);

  if (aMid.length === 0 && bMid.length === 0) {
    return {
      added: 0,
      removed: 0,
      summary: `0 line changes${suffix}`,
      diffLines: a.slice(0, Math.min(a.length, 20)).map((text, idx) => ({
        type: 'context' as const,
        text,
        oldLine: idx + 1,
        newLine: idx + 1,
      })),
    };
  }

  const rawOps: DocVersionDiffLine[] = [];
  for (let i = 0; i < prefix; i++) {
    rawOps.push({ type: 'context', text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  let added = 0;
  let removed = 0;

  if (aMid.length <= MAX_LCS_WINDOW && bMid.length <= MAX_LCS_WINDOW) {
    const m = aMid.length;
    const n = bMid.length;
    const dp = new Int32Array((m + 1) * (n + 1));
    const width = n + 1;
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (aMid[i] === bMid[j]) {
          dp[i * width + j] = (dp[(i + 1) * width + (j + 1)] ?? 0) + 1;
        } else {
          const down = dp[(i + 1) * width + j] ?? 0;
          const right = dp[i * width + (j + 1)] ?? 0;
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (aMid[i] === bMid[j]) {
        rawOps.push({
          type: 'context',
          text: aMid[i]!,
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
        });
        i++;
        j++;
      } else if ((dp[(i + 1) * width + j] ?? 0) >= (dp[i * width + (j + 1)] ?? 0)) {
        rawOps.push({
          type: 'del',
          text: aMid[i]!,
          oldLine: prefix + i + 1,
          newLine: null,
        });
        removed++;
        i++;
      } else {
        rawOps.push({
          type: 'add',
          text: bMid[j]!,
          oldLine: null,
          newLine: prefix + j + 1,
        });
        added++;
        j++;
      }
    }
    while (i < m) {
      rawOps.push({
        type: 'del',
        text: aMid[i]!,
        oldLine: prefix + i + 1,
        newLine: null,
      });
      removed++;
      i++;
    }
    while (j < n) {
      rawOps.push({
        type: 'add',
        text: bMid[j]!,
        oldLine: null,
        newLine: prefix + j + 1,
      });
      added++;
      j++;
    }
  } else {
    for (let i = 0; i < aMid.length; i++) {
      rawOps.push({
        type: 'del',
        text: aMid[i]!,
        oldLine: prefix + i + 1,
        newLine: null,
      });
      removed++;
    }
    for (let j = 0; j < bMid.length; j++) {
      rawOps.push({
        type: 'add',
        text: bMid[j]!,
        oldLine: null,
        newLine: prefix + j + 1,
      });
      added++;
    }
  }

  for (let k = 0; k < suffixLen; k++) {
    rawOps.push({
      type: 'context',
      text: a[a.length - suffixLen + k]!,
      oldLine: a.length - suffixLen + k + 1,
      newLine: b.length - suffixLen + k + 1,
    });
  }

  // Keep changed lines and up to CONTEXT_RADIUS context lines around each change.
  const keep = new Uint8Array(rawOps.length);
  for (let idx = 0; idx < rawOps.length; idx++) {
    if (rawOps[idx]!.type !== 'context') {
      const start = Math.max(0, idx - CONTEXT_RADIUS);
      const end = Math.min(rawOps.length - 1, idx + CONTEXT_RADIUS);
      for (let c = start; c <= end; c++) {
        keep[c] = 1;
      }
    }
  }

  const diffLines: DocVersionDiffLine[] = [];
  for (let idx = 0; idx < rawOps.length && diffLines.length < MAX_DIFF_LINES_RETURNED; idx++) {
    if (keep[idx]) {
      diffLines.push(rawOps[idx]!);
    }
  }

  return {
    added,
    removed,
    summary: `+${added} -${removed} lines${suffix}`,
    diffLines,
  };
}

interface ParsedWorkbookCells {
  sheetNames: string[];
  cellsBySheet: Map<string, Map<string, string>>;
}

async function parseWorkbookCells(bytes: Uint8Array): Promise<ParsedWorkbookCells> {
  const files = await readZipSafe(bytes, MAX_XLSX_UNZIPPED_BYTES);
  const { sheets, date1904 } = parseWorkbookSheets(files);
  const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
  const styles = parseXlsxStyles(utf8(files['xl/styles.xml']));

  const sheetNames: string[] = [];
  const cellsBySheet = new Map<string, Map<string, string>>();

  for (const sheet of sheets) {
    sheetNames.push(sheet.name);
    const cellMap = new Map<string, string>();
    const xml = utf8(files[sheet.file]);
    if (xml) {
      for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = m[1] ?? '';
        const body = m[2] ?? '';
        const ref = /\br="([A-Za-z]+\d+)"/.exec(attrs)?.[1]?.toUpperCase();
        if (!ref) continue;
        const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? '';
        const sIdx = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const fMatch = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const formula = fMatch ? decodeXml(fMatch[1] ?? '').trim() : '';
        const rawVal = vMatch ? decodeXml(vMatch[1] ?? '') : '';

        let displayVal = '';
        if (t === 's') {
          const idx = Number(rawVal);
          displayVal = Number.isInteger(idx) && idx >= 0 ? (sharedStrings[idx] ?? rawVal) : rawVal;
        } else if (t === 'inlineStr') {
          displayVal = runs(body, 't');
        } else if (t === 'b') {
          displayVal = rawVal === '1' || rawVal.toLowerCase() === 'true' ? 'TRUE' : 'FALSE';
        } else if (t === 'str' || t === 'e') {
          displayVal = rawVal;
        } else if (rawVal !== '') {
          const style = sIdx >= 0 ? styles[sIdx] : undefined;
          displayVal = formatXlsxNumber(rawVal, style, date1904);
        }

        const represented = formula
          ? displayVal !== ''
            ? `=${formula} (${displayVal})`
            : `=${formula}`
          : displayVal;

        if (represented !== '') {
          cellMap.set(ref, represented);
        }
      }
    }
    cellsBySheet.set(sheet.name, cellMap);
  }

  return { sheetNames, cellsBySheet };
}

function compareCellRefs(a: string, b: string): number {
  const pa = parseCellRef(a);
  const pb = parseCellRef(b);
  if (pa && pb) {
    if (pa.row !== pb.row) return pa.row - pb.row;
    return pa.col - pb.col;
  }
  return a.localeCompare(b);
}

export interface XlsxDiffResult {
  summary: string;
  cellChanges: DocVersionCellChange[];
  addedSheets: string[];
  removedSheets: string[];
}

/**
 * Computes a cell-level diff and human-readable summary between two `.xlsx` blobs.
 */
export async function computeXlsxDiff(
  beforeBytes: Uint8Array | null,
  afterBytes: Uint8Array | null,
): Promise<XlsxDiffResult> {
  if (!beforeBytes && !afterBytes) {
    return { summary: 'No changes', cellChanges: [], addedSheets: [], removedSheets: [] };
  }
  if (!beforeBytes && afterBytes) {
    try {
      const after = await parseWorkbookCells(afterBytes);
      const cellChanges: DocVersionCellChange[] = [];
      let totalCells = 0;
      for (const sheet of after.sheetNames) {
        const map = after.cellsBySheet.get(sheet);
        if (!map) continue;
        const refs = [...map.keys()].sort(compareCellRefs);
        totalCells += refs.length;
        for (const ref of refs) {
          if (cellChanges.length < 500) {
            cellChanges.push({ sheet, cell: ref, before: '', after: map.get(ref) ?? '' });
          }
        }
      }
      return {
        summary: `Created workbook (${after.sheetNames.length} sheet${after.sheetNames.length === 1 ? '' : 's'}, ${totalCells} cell${totalCells === 1 ? '' : 's'})`,
        cellChanges,
        addedSheets: after.sheetNames,
        removedSheets: [],
      };
    } catch {
      return { summary: 'Created workbook', cellChanges: [], addedSheets: [], removedSheets: [] };
    }
  }
  if (beforeBytes && !afterBytes) {
    return { summary: 'Deleted workbook', cellChanges: [], addedSheets: [], removedSheets: [] };
  }

  try {
    const before = await parseWorkbookCells(beforeBytes!);
    const after = await parseWorkbookCells(afterBytes!);

    const beforeSet = new Set(before.sheetNames);
    const afterSet = new Set(after.sheetNames);
    const addedSheets = after.sheetNames.filter((s) => !beforeSet.has(s));
    const removedSheets = before.sheetNames.filter((s) => !afterSet.has(s));

    const allSheets = [...new Set([...before.sheetNames, ...after.sheetNames])];
    const cellChanges: DocVersionCellChange[] = [];

    for (const sheet of allSheets) {
      const bMap = before.cellsBySheet.get(sheet) ?? new Map<string, string>();
      const aMap = after.cellsBySheet.get(sheet) ?? new Map<string, string>();
      const allRefs = [...new Set([...bMap.keys(), ...aMap.keys()])].sort(compareCellRefs);
      for (const ref of allRefs) {
        const bVal = bMap.get(ref) ?? '';
        const aVal = aMap.get(ref) ?? '';
        if (bVal !== aVal) {
          cellChanges.push({
            sheet,
            cell: ref,
            before: bVal,
            after: aVal,
          });
        }
      }
    }

    const parts: string[] = [];
    if (cellChanges.length > 0) {
      const preview = cellChanges
        .slice(0, 3)
        .map((c) => `${c.sheet}!${c.cell}: ${c.before || '∅'} → ${c.after || '∅'}`)
        .join(', ');
      const more =
        cellChanges.length > 3
          ? ` (+${cellChanges.length - 3} more cell${cellChanges.length - 3 === 1 ? '' : 's'})`
          : '';
      parts.push(`${preview}${more}`);
    }
    if (addedSheets.length > 0) {
      parts.push(`added sheet${addedSheets.length === 1 ? '' : 's'}: ${addedSheets.join(', ')}`);
    }
    if (removedSheets.length > 0) {
      parts.push(`removed sheet${removedSheets.length === 1 ? '' : 's'}: ${removedSheets.join(', ')}`);
    }

    return {
      summary: parts.length > 0 ? parts.join('; ') : 'Workbook updated',
      cellChanges: cellChanges.slice(0, 500),
      addedSheets,
      removedSheets,
    };
  } catch {
    return {
      summary: 'Workbook updated',
      cellChanges: [],
      addedSheets: [],
      removedSheets: [],
    };
  }
}
