import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import {
  applyXmlSplices,
  assertNoXmlEntitiesOrDtd,
  findElements,
  findFirstElement,
  parseAttr,
} from '../sheets/sheet-worker.js';
import {
  LIBREOFFICE_TIMEOUT_MS,
  resolveLibreOfficeExecutable,
  type SheetRunnerLimits,
} from '../sheets/runner.js';
import { readZipSafe, utf8, xmlEscape } from '../sheets/xlsx-shared.js';
import { DOCX_MAX_UNZIPPED_BYTES } from './docx-engine.js';

function lettersToColIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      n = n * 26 + (code - 64);
    } else if (code >= 97 && code <= 122) {
      n = n * 26 + (code - 96);
    }
  }
  return n;
}

function colIndexToLetters(col1Based: number): string {
  let n = Math.max(1, col1Based);
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || 'A';
}

function parseA1Cell(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(ref.trim());
  if (!m) return null;
  return {
    col: lettersToColIndex(m[1]!.toUpperCase()),
    row: Number(m[2]),
  };
}

function parseA1Range(range: string): { startCol: number; startRow: number; endCol: number; endRow: number } | null {
  const clean = range.trim().replace(/^.*!/, '');
  const parts = clean.split(':');
  if (parts.length === 1) {
    const single = parseA1Cell(parts[0]!);
    if (!single) return null;
    return { startCol: single.col, startRow: single.row, endCol: single.col, endRow: single.row };
  }
  if (parts.length !== 2) return null;
  const a = parseA1Cell(parts[0]!);
  const b = parseA1Cell(parts[1]!);
  if (!a || !b) return null;
  return {
    startCol: Math.min(a.col, b.col),
    startRow: Math.min(a.row, b.row),
    endCol: Math.max(a.col, b.col),
    endRow: Math.max(a.row, b.row),
  };
}

// ---- 1. create_doc: Markdown to .docx (with optional template) --------------

interface InlineToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  linkUrl?: string;
}

function tokenizeInlineMarkdown(input: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  // Match links [label](url), inline code `code`, bold-italic ***text***, bold **text** / __text__, italic *text* / _text_, strike ~~text~~
  const re =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|`([^`]+)`|\*\*\*([^*]+)\*\*\*|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let lastIdx = 0;
  for (const m of input.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > lastIdx) {
      tokens.push({ text: input.slice(lastIdx, idx) });
    }
    if (m[1] !== undefined && m[2] !== undefined) {
      tokens.push({ text: m[1], linkUrl: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ text: m[3], code: true });
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], bold: true, italic: true });
    } else if (m[5] !== undefined) {
      tokens.push({ text: m[5], bold: true });
    } else if (m[6] !== undefined) {
      tokens.push({ text: m[6], bold: true });
    } else if (m[7] !== undefined) {
      tokens.push({ text: m[7], strike: true });
    } else if (m[8] !== undefined) {
      tokens.push({ text: m[8], italic: true });
    } else if (m[9] !== undefined) {
      tokens.push({ text: m[9], italic: true });
    }
    lastIdx = idx + m[0].length;
  }
  if (lastIdx < input.length) {
    tokens.push({ text: input.slice(lastIdx) });
  }
  return tokens.length > 0 ? tokens : [{ text: input }];
}

function renderInlineRunsXml(
  input: string,
  allocLinkRel: (url: string) => string,
  extraRPr = '',
): string {
  const tokens = tokenizeInlineMarkdown(input);
  const parts: string[] = [];

  for (const tok of tokens) {
    if (!tok.text) continue;
    const rPrItems: string[] = [];
    if (extraRPr) rPrItems.push(extraRPr);
    if (tok.bold) rPrItems.push('<w:b/>');
    if (tok.italic) rPrItems.push('<w:i/>');
    if (tok.strike) rPrItems.push('<w:strike/>');
    if (tok.code) {
      rPrItems.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    }
    if (tok.linkUrl) {
      rPrItems.push('<w:rStyle w:val="Hyperlink"/><w:color w:val="0563C1"/><w:u w:val="single"/>');
    }
    const rPrXml = rPrItems.length > 0 ? `<w:rPr>${rPrItems.join('')}</w:rPr>` : '';
    const spaceAttr = /^\s|\s$|\s{2,}|\t/.test(tok.text) ? ' xml:space="preserve"' : ' xml:space="preserve"';
    const runXml = `<w:r>${rPrXml}<w:t${spaceAttr}>${xmlEscape(tok.text)}</w:t></w:r>`;

    if (tok.linkUrl) {
      const rId = allocLinkRel(tok.linkUrl);
      parts.push(`<w:hyperlink r:id="${xmlEscape(rId)}" w:history="1">${runXml}</w:hyperlink>`);
    } else {
      parts.push(runXml);
    }
  }

  return parts.join('');
}

function parsePipeTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map((c) => c.trim());
}

function isPipeTableDelimiterRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return false;
  const cells = parsePipeTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

const DEFAULT_STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:pPr><w:outlineLvl w:val="4"/></w:pPr><w:rPr><w:b/><w:sz w:val="20"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:pPr><w:outlineLvl w:val="5"/></w:pPr><w:rPr><w:b/><w:sz w:val="18"/></w:rPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
  `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
  `</w:styles>`;

const DEFAULT_NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:abstractNum w:abstractNumId="0">` +
  `<w:multiLevelType w:val="hybridMultilevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="◦"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:abstractNum w:abstractNumId="1">` +
  `<w:multiLevelType w:val="hybridMultilevel"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
  `</w:numbering>`;

function resolveHeadingStyleIdsFromStylesXml(stylesXml: string): Map<number, string> {
  const map = new Map<number, string>();
  for (let i = 1; i <= 6; i++) map.set(i, `Heading${i}`);
  if (!stylesXml) return map;
  assertNoXmlEntitiesOrDtd(stylesXml, 'word/styles.xml');
  for (const st of findElements(stylesXml, 'style')) {
    const styleId = parseAttr(st.attrs, 'w:styleId') ?? parseAttr(st.attrs, 'styleId');
    if (!styleId) continue;
    const nameEl = findFirstElement(stylesXml, 'name', st.innerStart, st.innerEnd);
    const nameVal = nameEl ? (parseAttr(nameEl.attrs, 'w:val') ?? parseAttr(nameEl.attrs, 'val') ?? '') : '';
    const m = /^heading\s*([1-6])$/i.exec(nameVal.trim()) ?? /^heading\s*([1-6])$/i.exec(styleId.trim());
    if (m) {
      map.set(Number(m[1]), styleId);
    }
  }
  return map;
}

/**
 * Converts Markdown into a `.docx` zip archive (`Uint8Array`).
 * Supports headings (`#`–`######`), bullet and numbered lists, pipe tables,
 * blockquotes, fenced code blocks, inline formatting, and external links.
 * When `templateZip` is provided, reuses the template's `word/styles.xml`,
 * theme, fontTable, settings, headers/footers, and section properties (`w:sectPr`).
 */
export async function createDocxFromMarkdown(
  markdownOrOpts:
    | string
    | {
        markdown: string;
        templateBytes?: Uint8Array | undefined;
        title?: string | undefined;
        author?: string | undefined;
      },
  templateZipArg?: Uint8Array,
): Promise<{
  zipBytes: Uint8Array;
  paragraphCount: number;
  headingCount: number;
  tableCount: number;
  reusedTemplateStyles: boolean;
  stats: { paragraphs: number; headings: number; tables: number; listItems: number; links: number; usedTemplate: boolean };
}> {
  const markdown = typeof markdownOrOpts === 'string' ? markdownOrOpts : markdownOrOpts.markdown;
  const templateZip = typeof markdownOrOpts === 'string' ? templateZipArg : markdownOrOpts.templateBytes;
  let templateFiles: Record<string, Uint8Array> | null = null;
  if (templateZip) {
    templateFiles = await readZipSafe(templateZip, DOCX_MAX_UNZIPPED_BYTES);
  }

  const stylesXml = templateFiles?.['word/styles.xml'] ? utf8(templateFiles['word/styles.xml']) : DEFAULT_STYLES_XML;
  const headingStyleIds = resolveHeadingStyleIdsFromStylesXml(stylesXml);

  const linkRels: Array<{ id: string; url: string }> = [];
  let linkCounter = 0;
  const allocLinkRel = (url: string): string => {
    const existing = linkRels.find((l) => l.url === url);
    if (existing) return existing.id;
    linkCounter++;
    const id = `rIdMdLink${linkCounter}`;
    linkRels.push({ id, url });
    return id;
  };

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const bodyElements: string[] = [];
  let paragraphsCount = 0;
  let headingsCount = 0;
  let tablesCount = 0;
  let listItemsCount = 0;
  let hasLists = false;

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i]!;
    const trimmed = rawLine.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // 1. Fenced code block ```
    if (trimmed.startsWith('```')) {
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      for (const cl of codeLines) {
        paragraphsCount++;
        bodyElements.push(
          `<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/></w:rPr>` +
            `<w:t xml:space="preserve">${xmlEscape(cl)}</w:t></w:r></w:p>`,
        );
      }
      continue;
    }

    // 2. Heading (# .. ######)
    const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      const styleId = headingStyleIds.get(level) ?? `Heading${level}`;
      headingsCount++;
      paragraphsCount++;
      bodyElements.push(
        `<w:p><w:pPr><w:pStyle w:val="${xmlEscape(styleId)}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
          `${renderInlineRunsXml(text, allocLinkRel)}</w:p>`,
      );
      i++;
      continue;
    }

    // 3. Pipe table
    if (trimmed.includes('|') && i + 1 < lines.length && isPipeTableDelimiterRow(lines[i + 1]!)) {
      const headerCells = parsePipeTableRow(trimmed);
      i += 2; // skip header + delimiter row
      const dataRows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().includes('|') && lines[i]!.trim() !== '') {
        if (isPipeTableDelimiterRow(lines[i]!)) {
          i++;
          continue;
        }
        dataRows.push(parsePipeTableRow(lines[i]!));
        i++;
      }
      const colCount = Math.max(headerCells.length, ...dataRows.map((r) => r.length), 1);
      const gridCols = Array.from({ length: colCount }, () => '<w:gridCol w:w="2400"/>').join('');
      const buildRowXml = (cells: string[], isHeader: boolean): string => {
        const padded = Array.from({ length: colCount }, (_, idx) => cells[idx] ?? '');
        const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
        const tcs = padded
          .map(
            (cellText) =>
              `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>` +
              `<w:p>${renderInlineRunsXml(cellText, allocLinkRel, isHeader ? '<w:b/>' : '')}</w:p></w:tc>`,
          )
          .join('');
        return `<w:tr>${trPr}${tcs}</w:tr>`;
      };

      const tblBorders =
        `<w:tblBorders>` +
        `<w:top w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `<w:left w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `<w:right w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="CCCCCC"/>` +
        `</w:tblBorders>`;
      const tblXml =
        `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${tblBorders}</w:tblPr>` +
        `<w:tblGrid>${gridCols}</w:tblGrid>` +
        `${buildRowXml(headerCells, true)}` +
        `${dataRows.map((r) => buildRowXml(r, false)).join('')}` +
        `</w:tbl>`;
      bodyElements.push(tblXml);
      tablesCount++;
      continue;
    }

    // 4. Bullet list item (-, *, +)
    const bulletMatch = /^(\s*)([-*+])\s+(.+)$/.exec(rawLine);
    if (bulletMatch) {
      const indentSpaces = bulletMatch[1]!.replace(/\t/g, '  ').length;
      const ilvl = Math.min(8, Math.floor(indentSpaces / 2));
      const itemText = bulletMatch[3]!.trim();
      hasLists = true;
      listItemsCount++;
      paragraphsCount++;
      bodyElements.push(
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr>` +
          `${renderInlineRunsXml(itemText, allocLinkRel)}</w:p>`,
      );
      i++;
      continue;
    }

    // 5. Ordered / numbered list item (1. , 2. )
    const orderedMatch = /^(\s*)\d+[.)]\s+(.+)$/.exec(rawLine);
    if (orderedMatch) {
      const indentSpaces = orderedMatch[1]!.replace(/\t/g, '  ').length;
      const ilvl = Math.min(8, Math.floor(indentSpaces / 2));
      const itemText = orderedMatch[2]!.trim();
      hasLists = true;
      listItemsCount++;
      paragraphsCount++;
      bodyElements.push(
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="2"/></w:numPr></w:pPr>` +
          `${renderInlineRunsXml(itemText, allocLinkRel)}</w:p>`,
      );
      i++;
      continue;
    }

    // 6. Blockquote (> text)
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        quoteLines.push(lines[i]!.trim().replace(/^>\s?/, ''));
        i++;
      }
      const quoteText = quoteLines.join(' ').trim();
      paragraphsCount++;
      bodyElements.push(
        `<w:p><w:pPr><w:ind w:left="720"/></w:pPr>${renderInlineRunsXml(quoteText, allocLinkRel, '<w:i/>')}</w:p>`,
      );
      continue;
    }

    // 7. Standard paragraph (join consecutive non-blank, non-special lines)
    const paraLines: string[] = [trimmed];
    i++;
    while (i < lines.length) {
      const nextRaw = lines[i]!;
      const nextTrim = nextRaw.trim();
      if (
        !nextTrim ||
        nextTrim.startsWith('#') ||
        nextTrim.startsWith('```') ||
        nextTrim.startsWith('>') ||
        /^(\s*)([-*+]|\d+[.)])\s+/.test(nextRaw) ||
        (nextTrim.includes('|') && i + 1 < lines.length && isPipeTableDelimiterRow(lines[i + 1]!))
      ) {
        break;
      }
      paraLines.push(nextTrim);
      i++;
    }
    const paraText = paraLines.join(' ');
    paragraphsCount++;
    bodyElements.push(`<w:p>${renderInlineRunsXml(paraText, allocLinkRel)}</w:p>`);
  }

  if (bodyElements.length === 0) {
    bodyElements.push('<w:p/>');
  }

  // Assemble the output .docx archive
  const outFiles: Record<string, Uint8Array> = {};

  if (templateFiles) {
    for (const [k, v] of Object.entries(templateFiles)) {
      outFiles[k] = v;
    }
  }

  if (!outFiles['word/styles.xml']) {
    outFiles['word/styles.xml'] = strToU8(DEFAULT_STYLES_XML);
  }

  // Preserve <w:sectPr> from template's word/document.xml if present
  let sectPrXml = '';
  if (templateFiles?.['word/document.xml']) {
    const tplDocXml = utf8(templateFiles['word/document.xml']);
    const sectPrSpan = findFirstElement(tplDocXml, 'sectPr');
    if (sectPrSpan) {
      sectPrXml = tplDocXml.slice(sectPrSpan.openStart, sectPrSpan.closeEnd);
    }
  }

  outFiles['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<w:body>${bodyElements.join('')}${sectPrXml}</w:body></w:document>`,
  );

  // Numbering part if lists were used
  if (hasLists && !outFiles['word/numbering.xml']) {
    outFiles['word/numbering.xml'] = strToU8(DEFAULT_NUMBERING_XML);
  }

  // Update or create word/_rels/document.xml.rels
  const existingDocRels = utf8(outFiles['word/_rels/document.xml.rels']);
  if (existingDocRels) {
    const newRelNodes: string[] = [];
    if (!/Target="styles\.xml"/i.test(existingDocRels)) {
      newRelNodes.push(
        `<Relationship Id="rIdMdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
      );
    }
    if (hasLists && !/Target="numbering\.xml"/i.test(existingDocRels)) {
      newRelNodes.push(
        `<Relationship Id="rIdMdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
      );
    }
    for (const lr of linkRels) {
      newRelNodes.push(
        `<Relationship Id="${xmlEscape(lr.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(lr.url)}" TargetMode="External"/>`,
      );
    }
    if (newRelNodes.length > 0) {
      const relsRoot = findFirstElement(existingDocRels, 'Relationships');
      if (relsRoot && !relsRoot.selfClosing) {
        outFiles['word/_rels/document.xml.rels'] = strToU8(
          applyXmlSplices(existingDocRels, [
            {
              start: relsRoot.innerEnd,
              end: relsRoot.innerEnd,
              replacement: newRelNodes.join(''),
            },
          ]),
        );
      }
    }
  } else {
    const rels: string[] = [
      `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    ];
    if (hasLists) {
      rels.push(
        `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
      );
    }
    for (const lr of linkRels) {
      rels.push(
        `<Relationship Id="${xmlEscape(lr.id)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(lr.url)}" TargetMode="External"/>`,
      );
    }
    outFiles['word/_rels/document.xml.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`,
    );
  }

  // Ensure _rels/.rels exists
  if (!outFiles['_rels/.rels']) {
    outFiles['_rels/.rels'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    );
  }

  // Ensure [Content_Types].xml exists and covers document.xml, styles.xml, and numbering.xml
  const existingCt = utf8(outFiles['[Content_Types].xml']);
  if (existingCt) {
    const extraOverrides: string[] = [];
    if (!/PartName="\/word\/document\.xml"/i.test(existingCt)) {
      extraOverrides.push(
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
      );
    }
    if (!/PartName="\/word\/styles\.xml"/i.test(existingCt)) {
      extraOverrides.push(
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
      );
    }
    if (hasLists && !/PartName="\/word\/numbering\.xml"/i.test(existingCt)) {
      extraOverrides.push(
        `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
      );
    }
    if (extraOverrides.length > 0) {
      const typesRoot = findFirstElement(existingCt, 'Types');
      if (typesRoot && !typesRoot.selfClosing) {
        outFiles['[Content_Types].xml'] = strToU8(
          applyXmlSplices(existingCt, [
            {
              start: typesRoot.innerEnd,
              end: typesRoot.innerEnd,
              replacement: extraOverrides.join(''),
            },
          ]),
        );
      }
    }
  } else {
    const overrides = [
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
      `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
      ...(hasLists
        ? [
            `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`,
          ]
        : []),
    ];
    outFiles['[Content_Types].xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `${overrides.join('')}</Types>`,
    );
  }

  return {
    zipBytes: zipSync(outFiles, { level: 6 }),
    paragraphCount: paragraphsCount,
    headingCount: headingsCount,
    tableCount: tablesCount,
    reusedTemplateStyles: Boolean(templateFiles),
    stats: {
      paragraphs: paragraphsCount,
      headings: headingsCount,
      tables: tablesCount,
      listItems: listItemsCount,
      links: linkRels.length,
      usedTemplate: Boolean(templateFiles),
    },
  };
}

// ---- 2. create_sheet: Build new .xlsx from structured specification ---------

export type CreateSheetWorksheetInput = CreateSheetSpec;

export interface CreateSheetSpec {
  name?: string;
  rows?: Array<
    Array<
      | string
      | number
      | boolean
      | null
      | undefined
      | { value?: string | number | boolean | null; formula?: string; numFmt?: string }
    >
  >;
  formulas?: Record<string, string> | Array<{ cell: string; formula: string }>;
  numFmts?: Record<string, string> | Array<{ cell?: string; range?: string; col?: string; numFmt: string }>;
  columnWidths?: Record<string, number> | number[];
}

const BUILTIN_NUM_FMTS: Record<string, number> = {
  General: 0,
  '0': 1,
  '0.00': 2,
  '#,##0': 3,
  '#,##0.00': 4,
  '0%': 9,
  '0.00%': 10,
  'mm-dd-yy': 14,
  'd-mmm-yy': 15,
  'd-mmm': 16,
  'mmm-yy': 17,
  'h:mm': 20,
  'h:mm:ss': 21,
  'm/d/yy h:mm': 22,
  '@': 49,
};

export function buildXlsxFromSheetsSpec(sheetsInput: CreateSheetSpec[]): {
  zipBytes: Uint8Array;
  buffer: Uint8Array;
  sheetNames: string[];
  sheetCount: number;
  totalCells: number;
  cellCount: number;
  formulaCount: number;
} {
  if (!Array.isArray(sheetsInput) || sheetsInput.length === 0) {
    throw new Error('create_sheet requires a non-empty "sheets" array.');
  }

  const sharedStrings: string[] = [];
  const sharedStringIndex = new Map<string, number>();
  const allocSharedString = (s: string): number => {
    const existing = sharedStringIndex.get(s);
    if (existing !== undefined) return existing;
    const idx = sharedStrings.length;
    sharedStrings.push(s);
    sharedStringIndex.set(s, idx);
    return idx;
  };

  // Style table: xfIndex 0 is default General
  const customNumFmts = new Map<string, number>(); // formatCode -> numFmtId (>= 164)
  let nextCustomNumFmtId = 164;
  const xfByFormatCode = new Map<string, number>(); // formatCode -> xfIndex
  const cellXfs: Array<{ numFmtId: number; applyNumberFormat: boolean }> = [
    { numFmtId: 0, applyNumberFormat: false },
  ];

  const allocStyleForNumFmt = (formatCode: string): number => {
    const trimmed = formatCode.trim();
    if (!trimmed || trimmed === 'General') return 0;
    const existingXf = xfByFormatCode.get(trimmed);
    if (existingXf !== undefined) return existingXf;

    let numFmtId = BUILTIN_NUM_FMTS[trimmed];
    if (numFmtId === undefined) {
      const existingCustom = customNumFmts.get(trimmed);
      if (existingCustom !== undefined) {
        numFmtId = existingCustom;
      } else {
        numFmtId = nextCustomNumFmtId++;
        customNumFmts.set(trimmed, numFmtId);
      }
    }
    const xfIndex = cellXfs.length;
    cellXfs.push({ numFmtId, applyNumberFormat: true });
    xfByFormatCode.set(trimmed, xfIndex);
    return xfIndex;
  };

  const files: Record<string, Uint8Array> = {};
  const sheetNames: string[] = [];
  const usedNamesLower = new Set<string>();
  let totalCells = 0;
  let formulaCount = 0;

  sheetsInput.forEach((spec, sIdx) => {
    let sheetName = (spec.name ?? `Sheet${sIdx + 1}`).trim() || `Sheet${sIdx + 1}`;
    sheetName = sheetName.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
    if (usedNamesLower.has(sheetName.toLowerCase())) {
      sheetName = `${sheetName.slice(0, 27)}_${sIdx + 1}`;
    }
    usedNamesLower.add(sheetName.toLowerCase());
    sheetNames.push(sheetName);

    interface CellDraft {
      row: number;
      col: number;
      value?: string | number | boolean | null;
      formula?: string;
      numFmt?: string;
    }

    const cellMap = new Map<string, CellDraft>(); // "row:col" -> CellDraft
    const getOrInitCell = (row: number, col: number): CellDraft => {
      const key = `${row}:${col}`;
      let c = cellMap.get(key);
      if (!c) {
        c = { row, col };
        cellMap.set(key, c);
      }
      return c;
    };

    // 1. Populate from rows
    const rows = Array.isArray(spec.rows) ? spec.rows : [];
    rows.forEach((rowArr, rIdx) => {
      if (!Array.isArray(rowArr)) return;
      const rowNum = rIdx + 1;
      rowArr.forEach((rawCell, cIdx) => {
        const colNum = cIdx + 1;
        if (rawCell === null || rawCell === undefined) return;
        const draft = getOrInitCell(rowNum, colNum);
        if (typeof rawCell === 'object') {
          if (rawCell.value !== undefined) draft.value = rawCell.value;
          if (typeof rawCell.formula === 'string' && rawCell.formula.trim()) {
            draft.formula = rawCell.formula.trim().replace(/^=/, '');
          }
          if (typeof rawCell.numFmt === 'string' && rawCell.numFmt.trim()) {
            draft.numFmt = rawCell.numFmt.trim();
          }
        } else if (typeof rawCell === 'string' && rawCell.startsWith('=') && rawCell.length > 1) {
          draft.formula = rawCell.slice(1).trim();
        } else {
          draft.value = rawCell;
        }
      });
    });

    // 2. Apply explicit formulas map or list
    if (spec.formulas) {
      const entries: Array<[string, string]> = Array.isArray(spec.formulas)
        ? spec.formulas.map((f) => [f.cell, f.formula])
        : Object.entries(spec.formulas);
      for (const [ref, rawFormula] of entries) {
        if (!ref || typeof rawFormula !== 'string' || !rawFormula.trim()) continue;
        const coord = parseA1Cell(ref);
        if (!coord) throw new Error(`Invalid cell reference "${ref}" in formulas for sheet "${sheetName}".`);
        const draft = getOrInitCell(coord.row, coord.col);
        draft.formula = rawFormula.trim().replace(/^=/, '');
      }
    }

    // 3. Apply numFmts map or list (supports single cell "B2", range "B2:B10", or column "B" / "B:C")
    const colDefaultNumFmt = new Map<number, string>();
    const applyNumFmtTarget = (target: string, fmt: string): void => {
      const t = target.trim();
      if (!t || !fmt.trim()) return;
      if (/^[A-Za-z]{1,3}$/.test(t)) {
        colDefaultNumFmt.set(lettersToColIndex(t.toUpperCase()), fmt.trim());
        return;
      }
      const colRangeMatch = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(t);
      if (colRangeMatch) {
        const c1 = lettersToColIndex(colRangeMatch[1]!.toUpperCase());
        const c2 = lettersToColIndex(colRangeMatch[2]!.toUpperCase());
        for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
          colDefaultNumFmt.set(c, fmt.trim());
        }
        return;
      }
      const range = parseA1Range(t);
      if (range) {
        for (let r = range.startRow; r <= range.endRow; r++) {
          for (let c = range.startCol; c <= range.endCol; c++) {
            const draft = getOrInitCell(r, c);
            draft.numFmt = fmt.trim();
          }
        }
      }
    };

    if (spec.numFmts) {
      if (Array.isArray(spec.numFmts)) {
        for (const item of spec.numFmts) {
          const target = item.cell ?? item.range ?? item.col ?? '';
          if (target && item.numFmt) applyNumFmtTarget(target, item.numFmt);
        }
      } else {
        for (const [target, fmt] of Object.entries(spec.numFmts)) {
          if (typeof fmt === 'string') applyNumFmtTarget(target, fmt);
        }
      }
    }

    // 4. Column widths (<cols>)
    const colWidths: Array<{ min: number; max: number; width: number }> = [];
    if (Array.isArray(spec.columnWidths)) {
      spec.columnWidths.forEach((w, idx) => {
        if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
          colWidths.push({ min: idx + 1, max: idx + 1, width: w });
        }
      });
    } else if (spec.columnWidths && typeof spec.columnWidths === 'object') {
      for (const [colKey, w] of Object.entries(spec.columnWidths)) {
        if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) continue;
        const trimmedKey = colKey.trim();
        if (/^[A-Za-z]{1,3}$/.test(trimmedKey)) {
          const colIdx = lettersToColIndex(trimmedKey.toUpperCase());
          colWidths.push({ min: colIdx, max: colIdx, width: w });
        } else {
          const rangeMatch = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(trimmedKey);
          if (rangeMatch) {
            const c1 = lettersToColIndex(rangeMatch[1]!.toUpperCase());
            const c2 = lettersToColIndex(rangeMatch[2]!.toUpperCase());
            colWidths.push({ min: Math.min(c1, c2), max: Math.max(c1, c2), width: w });
          } else if (/^\d+$/.test(trimmedKey)) {
            const colIdx = Math.max(1, Number(trimmedKey));
            colWidths.push({ min: colIdx, max: colIdx, width: w });
          }
        }
      }
    }
    const colsXml =
      colWidths.length > 0
        ? `<cols>${colWidths
            .map((cw) => `<col min="${cw.min}" max="${cw.max}" width="${cw.width}" customWidth="1"/>`)
            .join('')}</cols>`
        : '';

    // Group cells by row and sort
    const rowsByNum = new Map<number, CellDraft[]>();
    for (const draft of cellMap.values()) {
      if (!draft.numFmt && colDefaultNumFmt.has(draft.col)) {
        draft.numFmt = colDefaultNumFmt.get(draft.col);
      }
      if (draft.value === undefined && !draft.formula && !draft.numFmt) continue;
      const list = rowsByNum.get(draft.row) ?? [];
      list.push(draft);
      rowsByNum.set(draft.row, list);
    }

    const sortedRowNums = [...rowsByNum.keys()].sort((a, b) => a - b);
    const rowXmlParts: string[] = [];

    for (const rNum of sortedRowNums) {
      const rowCells = rowsByNum.get(rNum)!.sort((a, b) => a.col - b.col);
      const cellXmlParts: string[] = [];
      for (const cell of rowCells) {
        totalCells++;
        const ref = `${colIndexToLetters(cell.col)}${cell.row}`;
        const styleIdx = cell.numFmt ? allocStyleForNumFmt(cell.numFmt) : 0;
        const sAttr = styleIdx > 0 ? ` s="${styleIdx}"` : '';

        if (cell.formula) {
          formulaCount++;
          const fXml = `<f>${xmlEscape(cell.formula)}</f>`;
          if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
            cellXmlParts.push(`<c r="${ref}"${sAttr}>${fXml}<v>${cell.value}</v></c>`);
          } else if (typeof cell.value === 'boolean') {
            cellXmlParts.push(`<c r="${ref}" t="b"${sAttr}>${fXml}<v>${cell.value ? 1 : 0}</v></c>`);
          } else if (typeof cell.value === 'string') {
            cellXmlParts.push(`<c r="${ref}" t="str"${sAttr}>${fXml}<v>${xmlEscape(cell.value)}</v></c>`);
          } else {
            cellXmlParts.push(`<c r="${ref}"${sAttr}>${fXml}</c>`);
          }
          continue;
        }

        if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
          cellXmlParts.push(`<c r="${ref}"${sAttr}><v>${cell.value}</v></c>`);
        } else if (typeof cell.value === 'boolean') {
          cellXmlParts.push(`<c r="${ref}" t="b"${sAttr}><v>${cell.value ? 1 : 0}</v></c>`);
        } else if (typeof cell.value === 'string') {
          const ssIdx = allocSharedString(cell.value);
          cellXmlParts.push(`<c r="${ref}" t="s"${sAttr}><v>${ssIdx}</v></c>`);
        } else if (styleIdx > 0) {
          cellXmlParts.push(`<c r="${ref}"${sAttr}/>`);
        }
      }
      if (cellXmlParts.length > 0) {
        rowXmlParts.push(`<row r="${rNum}">${cellXmlParts.join('')}</row>`);
      }
    }

    files[`xl/worksheets/sheet${sIdx + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `${colsXml}<sheetData>${rowXmlParts.join('')}</sheetData></worksheet>`,
    );
  });

  // xl/styles.xml
  const numFmtsXml =
    customNumFmts.size > 0
      ? `<numFmts count="${customNumFmts.size}">` +
        [...customNumFmts.entries()]
          .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xmlEscape(code)}"/>`)
          .join('') +
        `</numFmts>`
      : '';
  const cellXfsXml =
    `<cellXfs count="${cellXfs.length}">` +
    cellXfs
      .map(
        (xf) =>
          `<xf numFmtId="${xf.numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0"${
            xf.applyNumberFormat ? ' applyNumberFormat="1"' : ''
          }/>`,
      )
      .join('') +
    `</cellXfs>`;
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      `${numFmtsXml}` +
      `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `${cellXfsXml}</styleSheet>`,
  );

  // xl/sharedStrings.xml
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
      sharedStrings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join('') +
      `</sst>`,
  );

  // xl/workbook.xml
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets>` +
      sheetNames.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      `</sheets>` +
      `<calcPr fullCalcOnLoad="1"/>` +
      `</workbook>`,
  );

  // xl/_rels/workbook.xml.rels
  const wbRels = [
    ...sheetNames.map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    ),
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdSharedStrings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
  ];
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`,
  );

  // _rels/.rels
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );

  // [Content_Types].xml
  const ctOverrides = [
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`,
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`,
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>`,
    ...sheetNames.map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    ),
  ];
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `${ctOverrides.join('')}</Types>`,
  );

  const zipBytes = zipSync(files, { level: 6 });
  return {
    zipBytes,
    buffer: zipBytes,
    sheetNames,
    sheetCount: sheetNames.length,
    totalCells,
    cellCount: totalCells,
    formulaCount,
  };
}

// ---- 3. export_pdf: LibreOffice headless conversion (.docx/.xlsx/.pptx -> .pdf) ----

const EXPORTABLE_PDF_EXTENSIONS = new Set(['.docx', '.xlsx', '.xlsm', '.pptx']);

export async function exportDocumentToPdf(
  sourceAbsPath: string,
  outputAbsPath: string,
  limits: SheetRunnerLimits = {},
): Promise<{ ok: true; size: number } | { ok: false; error: string }> {
  const ext = path.extname(sourceAbsPath).toLowerCase();
  if (!EXPORTABLE_PDF_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: `export_pdf only supports .docx, .xlsx, .xlsm, and .pptx sources (got "${ext || 'no extension'}").`,
    };
  }
  if (path.extname(outputAbsPath).toLowerCase() !== '.pdf') {
    return {
      ok: false,
      error: `export_pdf output path must end with .pdf (got "${path.basename(outputAbsPath)}").`,
    };
  }

  const binOverride = limits.sofficeBin !== undefined ? limits.sofficeBin : limits.libreOfficeBin;
  const soffice = resolveLibreOfficeExecutable(binOverride);
  if (!soffice) {
    return {
      ok: false,
      error:
        'LibreOffice (soffice) is not installed on this host, so export_pdf cannot convert Office documents to PDF.',
    };
  }

  const timeoutMs = limits.libreOfficeTimeoutMs ?? LIBREOFFICE_TIMEOUT_MS;
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-export-pdf-'));

  try {
    const profileDir = path.join(tmpRoot, 'profile');
    const inDir = path.join(tmpRoot, 'in');
    const outDir = path.join(tmpRoot, 'out');
    await fsp.mkdir(profileDir, { recursive: true });
    await fsp.mkdir(inDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    const scratchInPath = path.join(inDir, `document${ext}`);
    await fsp.copyFile(sourceAbsPath, scratchInPath);

    const profileUrl = `file://${profileDir}`;
    const args = [
      '--headless',
      '--norestore',
      '--nodefault',
      '--nofirststartwizard',
      `-env:UserInstallation=${profileUrl}`,
      '--convert-to',
      'pdf',
      '--outdir',
      outDir,
      scratchInPath,
    ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(soffice, args, {
        cwd: tmpRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: profileDir,
          TMPDIR: tmpRoot,
          LANG: 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8');
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`LibreOffice PDF export timed out after ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      timer.unref();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`LibreOffice exited with code ${code}: ${stderr.trim()}`));
          return;
        }
        resolve();
      });
    });

    const outEntries = await fsp.readdir(outDir);
    const pdfName = outEntries.find((e) => e.toLowerCase().endsWith('.pdf'));
    if (!pdfName) {
      return { ok: false, error: 'LibreOffice completed without producing a PDF file.' };
    }

    const producedPdfPath = path.join(outDir, pdfName);
    const stat = await fsp.stat(producedPdfPath);
    if (stat.size < 8) {
      return { ok: false, error: 'LibreOffice produced an empty or invalid PDF file.' };
    }

    await fsp.mkdir(path.dirname(outputAbsPath), { recursive: true });
    const stagePath = `${outputAbsPath}.stage.${process.pid}.${Date.now()}`;
    await fsp.copyFile(producedPdfPath, stagePath);
    await fsp.rename(stagePath, outputAbsPath);

    return { ok: true, size: stat.size };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export function assertDocxZipMagic(absPath: string): void {
  let fd: number;
  try {
    fd = fs.openSync(absPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`Document not found: ${absPath}`);
    if (code === 'ELOOP') throw new Error(`Refusing symlinked document path: ${absPath}`);
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Path is not a regular file: ${absPath}`);
    }
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    if (n < 4 || head.readUInt32BE(0) !== 0x504b0304) {
      throw new Error(`File is not a valid OOXML (.docx) zip archive.`);
    }
  } finally {
    fs.closeSync(fd);
  }
}
