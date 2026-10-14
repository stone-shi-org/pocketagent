import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { DocFileKind } from '@pocketagent/protocol';
import {
  columnIndex,
  columnLetters,
  decodeXml,
  formatXlsxNumber,
  parseRangeRef,
  parseSharedStrings,
  parseWorkbookSheets,
  parseXlsxStyles,
  readZipSafe,
  runs,
  utf8,
} from '../sheets/xlsx-shared.js';

/**
 * PA-144: ~800 tokens per chunk, using the repository's 4-chars-per-token
 * convention (`CHARS_PER_TOKEN = 4` in `attachments/extract-worker.ts`).
 */
export const DEFAULT_CHUNK_MAX_CHARS = 3_200;

const XLSX_MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const XLSX_SAMPLE_ROW_LIMIT = 12;
const XLSX_MAX_COLS_IN_SAMPLE = 24;

export interface DocChunkDraft {
  ordinal: number;
  location: string;
  content: string;
}

/**
 * Sanitizes a structural location label so it never contains control characters,
 * newlines, or untrusted fence markers (`<<<` / `>>>`), and stays short.
 */
export function sanitizeLocationLabel(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/<{2,}|>{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function stripMarkdownHeadingFormatting(heading: string): string {
  return heading
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~`]+/g, '')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1')
    .trim();
}

export function formatSectionLocation(rawHeading: string, fallbackIndex = 1): string {
  const plain = stripMarkdownHeadingFormatting(rawHeading);
  const withoutSectionSign = plain.replace(/^§+\s*/, '').trim();
  if (!withoutSectionSign) return `§${fallbackIndex}`;
  return sanitizeLocationLabel(`§${withoutSectionSign}`, `§${fallbackIndex}`);
}

/**
 * Splits a block of text into chunks of at most `maxChars` (~800 tokens),
 * preferring paragraph breaks (`\n\n`), then line breaks (`\n`), then spaces.
 */
export function splitTextByTokenBudget(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const minBreak = Math.floor(maxChars * 0.4);

    let splitAt = window.lastIndexOf('\n\n');
    if (splitAt < minBreak) {
      splitAt = window.lastIndexOf('\n');
    }
    if (splitAt < minBreak) {
      splitAt = window.lastIndexOf(' ');
    }
    if (splitAt < minBreak) {
      splitAt = maxChars;
    }

    const piece = remaining.slice(0, splitAt).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * PDF chunker: splits derived text on `--- Page N ---` markers, and splits
 * long pages (> ~800 tokens) while keeping the `p.N` location.
 */
export function chunkPdfText(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): DocChunkDraft[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const pageRegex = /^--- Page (\d+) ---[ \t]*$/gm;
  const matches = [...normalized.matchAll(pageRegex)];

  if (matches.length === 0) {
    const parts = splitTextByTokenBudget(normalized, maxChars);
    return parts.map((content, ordinal) => ({
      ordinal,
      location: 'p.1',
      content,
    }));
  }

  const drafts: DocChunkDraft[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const pageNum = Number(match[1] ?? i + 1);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1]!.index ?? normalized.length) : normalized.length;
    const pageBody = normalized.slice(bodyStart, bodyEnd).trim();
    if (!pageBody) continue;

    const location = `p.${pageNum}`;
    const parts = splitTextByTokenBudget(pageBody, maxChars);
    for (const content of parts) {
      drafts.push({
        ordinal: drafts.length,
        location,
        content,
      });
    }
  }

  return drafts;
}

/**
 * PPTX chunker: splits derived text on `--- Slide N ---` markers (including
 * `[Speaker notes]` per PA-139), and splits long slides while keeping `slide N`.
 */
export function chunkPptxText(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): DocChunkDraft[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const slideRegex = /^--- Slide (\d+) ---[ \t]*$/gm;
  const matches = [...normalized.matchAll(slideRegex)];

  if (matches.length === 0) {
    const parts = splitTextByTokenBudget(normalized, maxChars);
    return parts.map((content, ordinal) => ({
      ordinal,
      location: 'slide 1',
      content,
    }));
  }

  const drafts: DocChunkDraft[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const slideNum = Number(match[1] ?? i + 1);
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = i + 1 < matches.length ? (matches[i + 1]!.index ?? normalized.length) : normalized.length;
    const slideBody = normalized.slice(bodyStart, bodyEnd).trim();
    if (!slideBody) continue;

    const location = `slide ${slideNum}`;
    const parts = splitTextByTokenBudget(slideBody, maxChars);
    for (const content of parts) {
      drafts.push({
        ordinal: drafts.length,
        location,
        content,
      });
    }
  }

  return drafts;
}

interface HeadingSection {
  heading: string | null;
  startLine: number;
  endLine: number;
  text: string;
}

function splitMarkdownSections(text: string): HeadingSection[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections: HeadingSection[] = [];

  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  let startLine = 1;

  const flush = (endLine: number) => {
    const body = currentLines.join('\n').trim();
    if (body) {
      sections.push({
        heading: currentHeading,
        startLine,
        endLine: Math.max(startLine, endLine),
        text: body,
      });
    }
    currentLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1;

    // ATX heading: `# Heading` .. `###### Heading`
    const atx = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (atx) {
      flush(lineNum - 1);
      currentHeading = atx[2]!;
      startLine = lineNum;
      currentLines.push(line);
      continue;
    }

    // Setext heading: `Heading\n===` or `Heading\n---`
    const nextLine = i + 1 < lines.length ? lines[i + 1]! : '';
    if (
      line.trim().length > 0 &&
      !/^[-*+>|`]/.test(line.trim()) &&
      (/^\s*={3,}\s*$/.test(nextLine) || /^\s*-{3,}\s*$/.test(nextLine))
    ) {
      flush(lineNum - 1);
      currentHeading = line.trim();
      startLine = lineNum;
      currentLines.push(line, nextLine);
      i++; // consume underline
      continue;
    }

    // Numbered section heading in plain/derived docx text (e.g. `§3.2 Pricing` or `3.2 Pricing` on its own short line)
    const sectionLine = /^(?:§\s*)?(\d+(?:\.\d+)+\s+[A-Z][^\n]{1,70})$/.exec(line.trim());
    if (sectionLine && (i === 0 || lines[i - 1]!.trim() === '') && (i + 1 === lines.length || lines[i + 1]!.trim() === '')) {
      flush(lineNum - 1);
      currentHeading = sectionLine[1]!;
      startLine = lineNum;
      currentLines.push(line);
      continue;
    }

    currentLines.push(line);
  }

  flush(lines.length);
  return sections;
}

/**
 * DOCX chunker: splits derived Markdown by heading section (`§3.2 Pricing`),
 * splitting long sections at ~800 tokens.
 */
export function chunkDocxText(
  text: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): DocChunkDraft[] {
  const sections = splitMarkdownSections(text);
  if (sections.length === 0) return [];

  const drafts: DocChunkDraft[] = [];
  let sectionIdx = 0;
  for (const section of sections) {
    sectionIdx++;
    const location = section.heading
      ? formatSectionLocation(section.heading, sectionIdx)
      : `§${sectionIdx}`;
    const parts = splitTextByTokenBudget(section.text, maxChars);
    for (const content of parts) {
      drafts.push({
        ordinal: drafts.length,
        location,
        content,
      });
    }
  }
  return drafts;
}

/**
 * Text and Markdown chunker: splits by Markdown heading (`§...`) when headings
 * are present, or by ~800-token line windows (`lines A-B`).
 */
export function chunkTextOrMarkdown(
  text: string,
  relPath: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): DocChunkDraft[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.trim()) return [];

  const ext = path.extname(relPath).toLowerCase();
  const isMarkdown = ext === '.md' || ext === '.markdown' || ext === '.mdx';
  const sections = splitMarkdownSections(normalized);
  const hasHeadings = sections.some((s) => s.heading !== null);

  if (hasHeadings) {
    const drafts: DocChunkDraft[] = [];
    let sectionIdx = 0;
    for (const section of sections) {
      sectionIdx++;
      const location = section.heading
        ? formatSectionLocation(section.heading, sectionIdx)
        : isMarkdown
          ? `§${sectionIdx}`
          : `lines ${section.startLine}-${section.endLine}`;
      const parts = splitTextByTokenBudget(section.text, maxChars);
      for (const content of parts) {
        drafts.push({
          ordinal: drafts.length,
          location,
          content,
        });
      }
    }
    return drafts;
  }

  if (isMarkdown && normalized.trim().length <= maxChars) {
    return [
      {
        ordinal: 0,
        location: '§1',
        content: normalized.trim(),
      },
    ];
  }

  // Plain text or headingless long Markdown: chunk by lines up to ~800 tokens (`maxChars`)
  const lines = normalized.split('\n');
  const drafts: DocChunkDraft[] = [];
  let currentLines: string[] = [];
  let currentChars = 0;
  let chunkStartLine = 1;

  const flushLines = (endLine: number) => {
    const joined = currentLines.join('\n').trim();
    if (joined) {
      const location = `lines ${chunkStartLine}-${Math.max(chunkStartLine, endLine)}`;
      for (const part of splitTextByTokenBudget(joined, maxChars)) {
        drafts.push({
          ordinal: drafts.length,
          location,
          content: part,
        });
      }
    }
    currentLines = [];
    currentChars = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineLen = line.length + 1;
    if (currentLines.length > 0 && currentChars + lineLen > maxChars) {
      flushLines(i);
      chunkStartLine = i + 1;
    }
    if (currentLines.length === 0) {
      chunkStartLine = i + 1;
    }
    currentLines.push(line);
    currentChars += lineLen;
  }

  flushLines(lines.length);
  return drafts;
}

function parseXmlAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

function resolveSheetRelTarget(baseDir: string, target: string): string {
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

/**
 * Spreadsheet chunker (`.xlsx`): produces one chunk per sheet holding the sheet
 * name, used range (`Summary!A1:F40`), header row, a sample of rows, defined
 * names, and table names/columns. Exact cell value and formula lookups remain
 * `sheet_find` (PA-140).
 */
export async function chunkXlsxFile(
  absPath: string,
  fallbackText?: string,
  maxChars: number = DEFAULT_CHUNK_MAX_CHARS,
): Promise<DocChunkDraft[]> {
  try {
    const rawBytes = await fsPromises.readFile(absPath);
    const files = await readZipSafe(
      new Uint8Array(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength),
      XLSX_MAX_UNZIPPED_BYTES,
      (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        name === 'xl/sharedStrings.xml' ||
        name === 'xl/styles.xml' ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(name) ||
        /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name) ||
        /^xl\/tables\/table\d+\.xml$/.test(name),
    );

    const workbookXml = utf8(files['xl/workbook.xml']);
    const sharedStrings = parseSharedStrings(utf8(files['xl/sharedStrings.xml']));
    const styles = parseXlsxStyles(utf8(files['xl/styles.xml']));
    const { sheets, date1904 } = parseWorkbookSheets(files);

    // Parse defined names from xl/workbook.xml
    const definedNames: Array<{ name: string; ref: string; localSheetId?: number }> = [];
    for (const m of workbookXml.matchAll(/<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g)) {
      const attrs = m[1] ?? '';
      const name = decodeXml(parseXmlAttr(attrs, 'name') ?? '').trim();
      const hidden = parseXmlAttr(attrs, 'hidden');
      if (!name || hidden === '1' || hidden === 'true' || name.startsWith('_xlnm.')) continue;
      const localSheetAttr = parseXmlAttr(attrs, 'localSheetId');
      const localSheetId = localSheetAttr !== undefined ? Number(localSheetAttr) : undefined;
      const ref = decodeXml(m[2] ?? '').trim();
      definedNames.push({
        name,
        ref,
        ...(localSheetId !== undefined && Number.isFinite(localSheetId) ? { localSheetId } : {}),
      });
    }

    const drafts: DocChunkDraft[] = [];

    for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
      const sheet = sheets[sheetIdx]!;
      const xml = utf8(files[sheet.file]);
      if (!xml) continue;

      const dimAttr = /<dimension\b[^>]*?\bref="([^"]+)"/.exec(xml)?.[1];
      let minCol = Infinity;
      let maxCol = -1;
      let minRow = Infinity;
      let maxRow = 0;

      const parsedRows: Array<{ rowNum: number; cells: Map<number, string> }> = [];
      let nextRowNum = 0;

      for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
        const rowAttrs = rowMatch[1] ?? '';
        const rowBody = rowMatch[2] ?? '';
        const rAttr = Number(parseXmlAttr(rowAttrs, 'r') ?? 0);
        const rowNum = rAttr > 0 ? rAttr : nextRowNum + 1;
        nextRowNum = rowNum;

        const rowCells = new Map<number, string>();
        let nextCol = 0;

        for (const cellMatch of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const cAttrs = cellMatch[1] ?? '';
          const cBody = cellMatch[2] ?? '';
          const ref = parseXmlAttr(cAttrs, 'r');
          const col = ref ? columnIndex(ref) : nextCol;
          nextCol = col + 1;

          const type = parseXmlAttr(cAttrs, 't') ?? '';
          const styleIdxAttr = parseXmlAttr(cAttrs, 's');
          const style = styleIdxAttr !== undefined ? styles[Number(styleIdxAttr)] : undefined;

          let val = '';
          if (type === 's') {
            const rawIdx = runs(cBody, 'v');
            val = sharedStrings[Number(rawIdx)] ?? '';
          } else if (type === 'inlineStr') {
            val = runs(cBody, 't');
          } else if (type === 'b') {
            val = runs(cBody, 'v') === '1' ? 'TRUE' : 'FALSE';
          } else {
            const rawVal = runs(cBody, 'v');
            val = type === '' || type === 'n' ? formatXlsxNumber(rawVal, style, date1904, { thousands: true }) : rawVal;
          }

          const formula = runs(cBody, 'f').trim();
          const hasContent = val.trim() !== '' || formula !== '';
          if (hasContent && col >= 0) {
            if (col < minCol) minCol = col;
            if (col > maxCol) maxCol = col;
            if (rowNum < minRow) minRow = rowNum;
            if (rowNum > maxRow) maxRow = rowNum;
            if (val.trim() !== '') {
              rowCells.set(col, val.replace(/\s+/g, ' ').trim());
            } else if (formula) {
              rowCells.set(col, `=${formula}`);
            }
          }
        }

        if (rowCells.size > 0) {
          parsedRows.push({ rowNum, cells: rowCells });
        }
      }

      let usedRange = 'A1';
      if (maxCol >= 0 && maxRow >= 1) {
        let sCol = minCol;
        let sRow = minRow;
        let eCol = maxCol;
        let eRow = maxRow;
        if (dimAttr) {
          const pr = parseRangeRef(dimAttr);
          if (pr) {
            sCol = Math.min(sCol, pr.startCol);
            sRow = Math.min(sRow, pr.startRow);
            eCol = Math.max(eCol, pr.endCol);
            eRow = Math.max(eRow, pr.endRow);
          }
        }
        usedRange = `${columnLetters(sCol)}${sRow}:${columnLetters(eCol)}${eRow}`;
      } else if (dimAttr) {
        const pr = parseRangeRef(dimAttr);
        usedRange = pr
          ? `${pr.startColStr}${pr.startRow}:${pr.endColStr}${pr.endRow}`
          : dimAttr;
      }

      // Parse tables linked to this sheet via xl/worksheets/_rels/sheetN.xml.rels
      const sheetBase = sheet.file.split('/').pop() ?? '';
      const sheetRelsXml = utf8(files[`xl/worksheets/_rels/${sheetBase}.rels`]);
      const sheetTables: Array<{ name: string; ref: string; columns: string[] }> = [];
      for (const relMatch of sheetRelsXml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
        const relAttrs = relMatch[1] ?? '';
        const rawTarget = parseXmlAttr(relAttrs, 'Target') ?? '';
        if (!rawTarget) continue;
        const target = resolveSheetRelTarget('xl/worksheets', rawTarget);
        if (target.startsWith('xl/tables/') && files[target]) {
          const tableXml = utf8(files[target]);
          const tableOpen = /<table\b([^>]*)>/.exec(tableXml)?.[1] ?? '';
          const name = decodeXml(parseXmlAttr(tableOpen, 'displayName') ?? parseXmlAttr(tableOpen, 'name') ?? '').trim();
          const ref = parseXmlAttr(tableOpen, 'ref') ?? '';
          const cols: string[] = [];
          for (const tc of tableXml.matchAll(/<tableColumn\b([^>]*?)\/?>/g)) {
            const colName = decodeXml(parseXmlAttr(tc[1] ?? '', 'name') ?? '').trim();
            if (colName) cols.push(colName);
          }
          if (name) {
            sheetTables.push({ name, ref, columns: cols });
          }
        }
      }

      // Filter defined names belonging to or referencing this sheet
      const escapedSheetName = sheet.name.replace(/'/g, "''");
      const sheetDefinedNames = definedNames.filter((dn) => {
        if (dn.localSheetId !== undefined) return dn.localSheetId === sheetIdx;
        return (
          dn.ref.startsWith(`${sheet.name}!`) ||
          dn.ref.startsWith(`'${escapedSheetName}'!`) ||
          !dn.ref.includes('!')
        );
      });

      const startCol = minCol === Infinity ? 0 : minCol;
      const endCol = maxCol < 0 ? 0 : Math.min(maxCol, startCol + XLSX_MAX_COLS_IN_SAMPLE - 1);
      const formatRowValues = (cells: Map<number, string>): string => {
        const vals: string[] = [];
        for (let c = startCol; c <= endCol; c++) {
          vals.push(cells.get(c) ?? '');
        }
        while (vals.length > 0 && vals[vals.length - 1] === '') vals.pop();
        return vals.join(' | ');
      };

      const headerRow = parsedRows[0] ? formatRowValues(parsedRows[0].cells) : '';
      const sampleRows = parsedRows
        .slice(1, 1 + XLSX_SAMPLE_ROW_LIMIT)
        .map((r) => `Row ${r.rowNum}: ${formatRowValues(r.cells)}`);

      const lines: string[] = [
        `Sheet: ${sheet.name}`,
        `Used range: ${usedRange}`,
      ];
      if (sheetDefinedNames.length > 0) {
        lines.push(
          `Defined names: ${sheetDefinedNames.map((d) => `${d.name} (${d.ref})`).join(', ')}`,
        );
      }
      if (sheetTables.length > 0) {
        lines.push(
          `Tables: ${sheetTables
            .map((t) => `${t.name}${t.ref ? ` [${t.ref}]` : ''}${t.columns.length > 0 ? ` (${t.columns.join(', ')})` : ''}`)
            .join('; ')}`,
        );
      }
      if (headerRow) {
        lines.push(`Header row: ${headerRow}`);
      }
      if (sampleRows.length > 0) {
        lines.push(`Sample rows:\n${sampleRows.join('\n')}`);
      }

      const rawContent = lines.join('\n');
      const content =
        rawContent.length > maxChars ? `${rawContent.slice(0, maxChars - 3).trimEnd()}...` : rawContent;
      const cleanSheetName = sanitizeLocationLabel(sheet.name, `Sheet${sheetIdx + 1}`);
      const location = `${cleanSheetName}!${usedRange}`;

      drafts.push({
        ordinal: drafts.length,
        location,
        content,
      });
    }

    if (drafts.length > 0) return drafts;
  } catch {
    // Fall back to derived text below if zip parsing fails.
  }

  if (!fallbackText?.trim()) return [];
  const normalized = fallbackText.replace(/\r\n/g, '\n');
  const sheetRegex = /^--- Sheet: (.+?) ---[ \t]*$/gm;
  const matches = [...normalized.matchAll(sheetRegex)];
  if (matches.length === 0) {
    return [
      {
        ordinal: 0,
        location: 'Sheet1!A1',
        content: normalized.trim().slice(0, maxChars),
      },
    ];
  }
  const drafts: DocChunkDraft[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const sheetName = sanitizeLocationLabel(m[1] ?? `Sheet${i + 1}`, `Sheet${i + 1}`);
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? normalized.length) : normalized.length;
    const body = normalized.slice(start, end).trim();
    if (!body) continue;
    drafts.push({
      ordinal: drafts.length,
      location: `${sheetName}!A1`,
      content: body.slice(0, maxChars),
    });
  }
  return drafts;
}

/**
 * Dispatcher that chunks a workspace file according to its structural `kind`.
 */
export async function buildDocumentChunks(opts: {
  kind: DocFileKind;
  relPath: string;
  absPath: string;
  derivedText: string;
  maxChars?: number;
}): Promise<DocChunkDraft[]> {
  const maxChars = opts.maxChars ?? DEFAULT_CHUNK_MAX_CHARS;
  switch (opts.kind) {
    case 'pdf':
      return chunkPdfText(opts.derivedText, maxChars);
    case 'docx':
      return chunkDocxText(opts.derivedText, maxChars);
    case 'pptx':
      return chunkPptxText(opts.derivedText, maxChars);
    case 'xlsx':
      return chunkXlsxFile(opts.absPath, opts.derivedText, maxChars);
    case 'text':
      return chunkTextOrMarkdown(opts.derivedText, opts.relPath, maxChars);
    default:
      return [];
  }
}
