import { strToU8, zipSync } from 'fflate';
import {
  applyXmlSplices,
  assertNoXmlEntitiesOrDtd,
  findElements,
  findFirstElement,
  parseAttr,
  scanXmlTags,
  type SheetDiffPayload,
  type XmlElementSpan,
  type XmlSplice,
} from '../sheets/sheet-worker.js';
import { decodeXml, readZipSafe, utf8, xmlEscape } from '../sheets/xlsx-shared.js';

export const DOCX_MAX_UNZIPPED_BYTES = 128 * 1024 * 1024;

export interface DocRedlineSegment {
  type: 'text' | 'ins' | 'del' | 'comment';
  text: string;
  author?: string;
  date?: string;
  id?: string;
}

export interface DocRedlineBlock {
  id: string;
  paragraphId?: string;
  location?: string;
  headingLevel?: number | null;
  hasChanges?: boolean;
  segments: DocRedlineSegment[];
}

export interface DocTrackedChangeInfo {
  id: string;
  type: 'ins' | 'del';
  author: string;
  date?: string;
  text: string;
  paragraphId: string;
}

export interface DocCommentInfo {
  id: string;
  author: string;
  date?: string;
  text: string;
  paragraphId?: string;
}

export interface DocParagraphInfo {
  id: string;
  headingLevel?: number;
  section?: string;
  text: string;
  segments: DocRedlineSegment[];
  trackedChanges: DocTrackedChangeInfo[];
  comments: DocCommentInfo[];
  links: Array<{ text: string; url: string }>;
}

export interface DocTableCellInfo {
  cellId: string;
  row: number;
  col: number;
  text: string;
  segments: DocRedlineSegment[];
}

export interface DocTableInfo {
  id: string;
  section?: string;
  rows: DocTableCellInfo[][];
}

export interface DocStructureResult {
  paragraphs: DocParagraphInfo[];
  headings: Array<{ id: string; level: number; text: string; section: string }>;
  tables: DocTableInfo[];
  comments: DocCommentInfo[];
  trackedChanges: DocTrackedChangeInfo[];
  headers: string[];
  footers: string[];
  footnotes: string[];
}

export type DocxEditMode = 'tracked' | 'direct';
export type DocxRedlineBlock = DocRedlineBlock;
export type DocxEditInput = DocEditInput;

export interface DocEditInput {
  /** Operation kind: 'replace' (default), 'insert', 'delete', 'set_cell', or 'comment'. */
  op?: 'replace' | 'insert' | 'insert_before' | 'insert_after' | 'delete' | 'set_cell' | 'table_cell' | 'comment' | 'add_comment';
  /** Target paragraph id from doc_read (e.g. 'p1', 'p2', or table cell 't1.r1.c1'). */
  paragraphId?: string;
  /** Alias for paragraphId. */
  paragraph?: string | number;
  /** Alias for paragraphId. */
  id?: string;
  /** Exact text anchor in the document or paragraph to replace, delete, insert around, or comment on. */
  oldText?: string;
  /** Alias for oldText. */
  anchor?: string;
  /** Alias for oldText. */
  find?: string;
  /** Alias for oldText. */
  target?: string;
  /** Replacement or inserted text. */
  newText?: string;
  /** Alias for newText. */
  replacement?: string;
  /** Alias for newText / cell text. */
  text?: string;
  /** Alias for newText / cell value. */
  value?: string | number | boolean;
  /** Text to insert before anchor or at start of paragraph. */
  insertBefore?: string;
  /** Text to insert after anchor or at end of paragraph. */
  insertAfter?: string;
  /** Insertion position when op='insert': 'before' | 'after' | 'start' | 'end'. */
  position?: 'before' | 'after' | 'start' | 'end';
  /** Set true to delete the anchored text or paragraph text. */
  delete?: boolean;
  /** Table id (e.g. 't1' or 1) for table cell edits. */
  table?: string | number;
  /** Alias for table. */
  tableId?: string | number;
  /** Alias for table. */
  tableIndex?: number;
  /** Row number (1-based; 0 also accepted for first row) for table cell edits. */
  row?: number;
  /** Column number (1-based; 0 also accepted for first column, or column letter 'A', 'B') for table cell edits. */
  col?: number | string;
  /** Alias for col. */
  column?: number | string;
  /** Cell coordinate (e.g. 'B2', 'r1c2', or 't1.r1.c2') for table cell edits. */
  cell?: string;
  /** Comment text to attach as a Word <w:comment> on the target paragraph or anchor. */
  comment?: string;
}

export interface DocEditPreviewResult {
  ok: true;
  diff: SheetDiffPayload;
  redline: DocRedlineBlock[];
  redlineBlocks: DocRedlineBlock[];
  appliedCount: number;
  summary: string;
  mode: 'tracked' | 'direct';
  author: string;
  patchedZip?: Uint8Array;
  patchedZipBytes?: Uint8Array;
}

export type DocEditOutcome =
  | DocEditPreviewResult
  | {
      ok: false;
      error: string;
    };

interface ParsedRunSegment {
  runSpan: XmlElementSpan;
  rPrRaw: string;
  text: string;
  textStart: number;
  textEnd: number;
  insideDel: boolean;
  insideIns: boolean;
}

interface IndexedParagraph {
  id: string;
  locationLabel: string;
  headingLevel?: number;
  section?: string;
  pSpan: XmlElementSpan;
  runs: ParsedRunSegment[];
  visibleText: string;
  segments: DocRedlineSegment[];
  trackedChanges: DocTrackedChangeInfo[];
  comments: DocCommentInfo[];
  links: Array<{ text: string; url: string }>;
}

interface IndexedTable {
  id: string;
  section?: string;
  tblSpan: XmlElementSpan;
  rows: Array<
    Array<{
      cellId: string;
      row: number;
      col: number;
      tcSpan: XmlElementSpan;
      firstPara: IndexedParagraph | null;
      allParas: IndexedParagraph[];
    }>
  >;
}

function needsSpacePreserveAttr(text: string): string {
  if (!text) return '';
  if (/^\s|\s$|\s{2,}|\t|\n/.test(text)) {
    return ' xml:space="preserve"';
  }
  return ' xml:space="preserve"';
}

function parseStyleHeadingLevels(stylesXml: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let lvl = 1; lvl <= 6; lvl++) {
    map.set(`Heading${lvl}`, lvl);
    map.set(`heading${lvl}`, lvl);
    map.set(`Heading ${lvl}`, lvl);
    map.set(`heading ${lvl}`, lvl);
  }
  if (!stylesXml) return map;
  assertNoXmlEntitiesOrDtd(stylesXml, 'word/styles.xml');
  for (const st of findElements(stylesXml, 'style')) {
    const styleId = parseAttr(st.attrs, 'w:styleId') ?? parseAttr(st.attrs, 'styleId');
    if (!styleId) continue;
    const nameEl = findFirstElement(stylesXml, 'name', st.innerStart, st.innerEnd);
    const nameVal = nameEl ? (parseAttr(nameEl.attrs, 'w:val') ?? parseAttr(nameEl.attrs, 'val') ?? '') : '';
    const headingMatch = /^heading\s*([1-6])$/i.exec(nameVal.trim()) ?? /^heading\s*([1-6])$/i.exec(styleId.trim());
    if (headingMatch) {
      map.set(styleId, Number(headingMatch[1]));
      continue;
    }
    const outlineEl = findFirstElement(stylesXml, 'outlineLvl', st.innerStart, st.innerEnd);
    const outlineVal = outlineEl ? Number(parseAttr(outlineEl.attrs, 'w:val') ?? parseAttr(outlineEl.attrs, 'val')) : NaN;
    if (Number.isInteger(outlineVal) && outlineVal >= 0 && outlineVal <= 5) {
      map.set(styleId, outlineVal + 1);
    }
  }
  return map;
}

function parseHyperlinkRels(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  assertNoXmlEntitiesOrDtd(relsXml, 'word/_rels/document.xml.rels');
  for (const rel of findElements(relsXml, 'Relationship')) {
    const id = parseAttr(rel.attrs, 'Id');
    const type = parseAttr(rel.attrs, 'Type') ?? '';
    const target = parseAttr(rel.attrs, 'Target');
    if (id && target && /\/hyperlink$/i.test(type)) {
      map.set(id, decodeXml(target));
    }
  }
  return map;
}

function parseCommentsPart(commentsXml: string): Map<string, DocCommentInfo> {
  const map = new Map<string, DocCommentInfo>();
  if (!commentsXml) return map;
  assertNoXmlEntitiesOrDtd(commentsXml, 'word/comments.xml');
  for (const c of findElements(commentsXml, 'comment')) {
    const id = parseAttr(c.attrs, 'w:id') ?? parseAttr(c.attrs, 'id');
    if (!id) continue;
    const author = decodeXml(parseAttr(c.attrs, 'w:author') ?? parseAttr(c.attrs, 'author') ?? 'Unknown');
    const date = parseAttr(c.attrs, 'w:date') ?? parseAttr(c.attrs, 'date') ?? undefined;
    const paraTexts: string[] = [];
    for (const p of findElements(commentsXml, 'p', c.innerStart, c.innerEnd)) {
      const tSpans = findElements(commentsXml, 't', p.innerStart, p.innerEnd);
      const line = tSpans.map((t) => decodeXml(commentsXml.slice(t.innerStart, t.innerEnd))).join('');
      if (line.trim()) paraTexts.push(line.trim());
    }
    map.set(id, {
      id,
      author,
      ...(date ? { date } : {}),
      text: paraTexts.join('\n'),
    });
  }
  return map;
}

function extractSimplePartLines(xml: string, entryName: string): string[] {
  if (!xml) return [];
  assertNoXmlEntitiesOrDtd(xml, entryName);
  const lines: string[] = [];
  for (const p of findElements(xml, 'p')) {
    const tSpans = findElements(xml, 't', p.innerStart, p.innerEnd);
    const text = tSpans.map((t) => decodeXml(xml.slice(t.innerStart, t.innerEnd))).join('').trim();
    if (text) lines.push(text);
  }
  return lines;
}

function extractRunTextAndLinks(
  docXml: string,
  rSpan: XmlElementSpan,
  insideDel: boolean,
): string {
  if (rSpan.selfClosing) return '';
  let out = '';
  for (const tok of scanXmlTags(docXml, rSpan.innerStart, rSpan.innerEnd)) {
    if (tok.kind === 'open' && !insideDel && tok.localName === 't') {
      const closeIdx = docXml.indexOf(`</${tok.name}>`, tok.end);
      if (closeIdx !== -1 && closeIdx <= rSpan.innerEnd) {
        out += decodeXml(docXml.slice(tok.end, closeIdx));
      }
    } else if (tok.kind === 'open' && insideDel && tok.localName === 'delText') {
      const closeIdx = docXml.indexOf(`</${tok.name}>`, tok.end);
      if (closeIdx !== -1 && closeIdx <= rSpan.innerEnd) {
        out += decodeXml(docXml.slice(tok.end, closeIdx));
      }
    } else if ((tok.kind === 'self' || tok.kind === 'open') && tok.localName === 'tab') {
      out += '\t';
    } else if ((tok.kind === 'self' || tok.kind === 'open') && (tok.localName === 'br' || tok.localName === 'cr')) {
      out += '\n';
    }
  }
  return out;
}

function parseParagraphAtSpan(
  docXml: string,
  pSpan: XmlElementSpan,
  id: string,
  locationLabel: string,
  styleHeadingMap: Map<string, number>,
  hyperlinkMap: Map<string, string>,
  commentsMap: Map<string, DocCommentInfo>,
  currentSection: string | undefined,
): IndexedParagraph {
  let headingLevel: number | undefined;
  if (!pSpan.selfClosing) {
    const pPr = findFirstElement(docXml, 'pPr', pSpan.innerStart, pSpan.innerEnd);
    if (pPr && !pPr.selfClosing) {
      const pStyle = findFirstElement(docXml, 'pStyle', pPr.innerStart, pPr.innerEnd);
      if (pStyle) {
        const val = parseAttr(pStyle.attrs, 'w:val') ?? parseAttr(pStyle.attrs, 'val') ?? '';
        const mapped = styleHeadingMap.get(val);
        if (mapped !== undefined) headingLevel = mapped;
      }
      if (headingLevel === undefined) {
        const outline = findFirstElement(docXml, 'outlineLvl', pPr.innerStart, pPr.innerEnd);
        if (outline) {
          const v = Number(parseAttr(outline.attrs, 'w:val') ?? parseAttr(outline.attrs, 'val'));
          if (Number.isInteger(v) && v >= 0 && v <= 5) headingLevel = v + 1;
        }
      }
    }
  }

  const runs: ParsedRunSegment[] = [];
  const segments: DocRedlineSegment[] = [];
  const trackedChanges: DocTrackedChangeInfo[] = [];
  const comments: DocCommentInfo[] = [];
  const seenCommentIds = new Set<string>();
  const links: Array<{ text: string; url: string }> = [];

  if (!pSpan.selfClosing) {
    // Walk tokens inside the paragraph to track <w:ins>, <w:del>, <w:hyperlink>, <w:commentRangeStart/End/Reference>, and <w:r>.
    let activeIns: { id: string; author: string; date?: string; textParts: string[] } | null = null;
    let activeDel: { id: string; author: string; date?: string; textParts: string[] } | null = null;
    let activeLink: { rId: string; url: string; textParts: string[] } | null = null;
    let openRunToken: { name: string; attrs: string; start: number; end: number } | null = null;
    let pPrDepth = 0;
    let visibleCursor = 0;

    const pushSegment = (seg: DocRedlineSegment): void => {
      if (!seg.text && seg.type !== 'comment') return;
      const prev = segments[segments.length - 1];
      if (
        prev &&
        prev.type === seg.type &&
        prev.author === seg.author &&
        prev.id === seg.id &&
        seg.type !== 'comment'
      ) {
        prev.text += seg.text;
      } else {
        segments.push({ ...seg });
      }
    };

    const attachCommentById = (commentId: string): void => {
      if (seenCommentIds.has(commentId)) return;
      const cInfo = commentsMap.get(commentId);
      if (!cInfo) return;
      seenCommentIds.add(commentId);
      const withPara: DocCommentInfo = { ...cInfo, paragraphId: id };
      comments.push(withPara);
      cInfo.paragraphId = cInfo.paragraphId ?? id;
      pushSegment({
        type: 'comment',
        id: cInfo.id,
        author: cInfo.author,
        ...(cInfo.date ? { date: cInfo.date } : {}),
        text: cInfo.text,
      });
    };

    for (const tok of scanXmlTags(docXml, pSpan.innerStart, pSpan.innerEnd)) {
      if (tok.localName === 'pPr') {
        if (tok.kind === 'open') pPrDepth++;
        else if (tok.kind === 'close' && pPrDepth > 0) pPrDepth--;
        continue;
      }
      if (pPrDepth > 0) continue;

      if (tok.localName === 'ins') {
        if (tok.kind === 'open') {
          const revId = parseAttr(tok.attrs, 'w:id') ?? parseAttr(tok.attrs, 'id') ?? '';
          const author = decodeXml(parseAttr(tok.attrs, 'w:author') ?? parseAttr(tok.attrs, 'author') ?? 'Unknown');
          const date = parseAttr(tok.attrs, 'w:date') ?? parseAttr(tok.attrs, 'date') ?? undefined;
          activeIns = { id: revId, author, ...(date ? { date } : {}), textParts: [] };
        } else if (tok.kind === 'close' && activeIns) {
          const joined = activeIns.textParts.join('');
          if (joined) {
            trackedChanges.push({
              id: activeIns.id,
              type: 'ins',
              author: activeIns.author,
              ...(activeIns.date ? { date: activeIns.date } : {}),
              text: joined,
              paragraphId: id,
            });
          }
          activeIns = null;
        }
        continue;
      }

      if (tok.localName === 'del') {
        if (tok.kind === 'open') {
          const revId = parseAttr(tok.attrs, 'w:id') ?? parseAttr(tok.attrs, 'id') ?? '';
          const author = decodeXml(parseAttr(tok.attrs, 'w:author') ?? parseAttr(tok.attrs, 'author') ?? 'Unknown');
          const date = parseAttr(tok.attrs, 'w:date') ?? parseAttr(tok.attrs, 'date') ?? undefined;
          activeDel = { id: revId, author, ...(date ? { date } : {}), textParts: [] };
        } else if (tok.kind === 'close' && activeDel) {
          const joined = activeDel.textParts.join('');
          if (joined) {
            trackedChanges.push({
              id: activeDel.id,
              type: 'del',
              author: activeDel.author,
              ...(activeDel.date ? { date: activeDel.date } : {}),
              text: joined,
              paragraphId: id,
            });
          }
          activeDel = null;
        }
        continue;
      }

      if (tok.localName === 'hyperlink') {
        if (tok.kind === 'open') {
          const rId = parseAttr(tok.attrs, 'r:id') ?? parseAttr(tok.attrs, 'id') ?? '';
          const url = hyperlinkMap.get(rId) ?? '';
          activeLink = url ? { rId, url, textParts: [] } : null;
        } else if (tok.kind === 'close' && activeLink) {
          const text = activeLink.textParts.join('').trim();
          if (text && activeLink.url) {
            links.push({ text, url: activeLink.url });
          }
          activeLink = null;
        }
        continue;
      }

      if (
        tok.localName === 'commentRangeEnd' ||
        tok.localName === 'commentReference' ||
        tok.localName === 'commentRangeStart'
      ) {
        const cId = parseAttr(tok.attrs, 'w:id') ?? parseAttr(tok.attrs, 'id');
        if (cId && (tok.localName === 'commentRangeEnd' || tok.localName === 'commentReference')) {
          attachCommentById(cId);
        }
        continue;
      }

      if (tok.localName === 'r') {
        if (tok.kind === 'open' && !openRunToken) {
          openRunToken = { name: tok.name, attrs: tok.attrs, start: tok.start, end: tok.end };
        } else if (tok.kind === 'close' && openRunToken) {
          const rSpan: XmlElementSpan = {
            name: openRunToken.name,
            localName: 'r',
            attrs: openRunToken.attrs,
            openStart: openRunToken.start,
            openEnd: openRunToken.end,
            innerStart: openRunToken.end,
            innerEnd: tok.start,
            closeStart: tok.start,
            closeEnd: tok.end,
            selfClosing: false,
          };
          openRunToken = null;

          const rPrEl = findFirstElement(docXml, 'rPr', rSpan.innerStart, rSpan.innerEnd);
          const rPrRaw = rPrEl ? docXml.slice(rPrEl.openStart, rPrEl.closeEnd) : '';
          const insideDel = activeDel !== null;
          const insideIns = activeIns !== null;
          const runText = extractRunTextAndLinks(docXml, rSpan, insideDel);

          if (insideDel && activeDel) {
            if (runText) {
              activeDel.textParts.push(runText);
              pushSegment({
                type: 'del',
                text: runText,
                id: activeDel.id,
                author: activeDel.author,
                ...(activeDel.date ? { date: activeDel.date } : {}),
              });
            }
          } else {
            const textStart = visibleCursor;
            const textEnd = visibleCursor + runText.length;
            visibleCursor = textEnd;
            runs.push({
              runSpan: rSpan,
              rPrRaw,
              text: runText,
              textStart,
              textEnd,
              insideDel: false,
              insideIns,
            });
            if (runText) {
              if (activeLink) activeLink.textParts.push(runText);
              if (insideIns && activeIns) {
                activeIns.textParts.push(runText);
                pushSegment({
                  type: 'ins',
                  text: runText,
                  id: activeIns.id,
                  author: activeIns.author,
                  ...(activeIns.date ? { date: activeIns.date } : {}),
                });
              } else {
                pushSegment({
                  type: 'text',
                  text: runText,
                });
              }
            }
          }
        }
      }
    }

    // Also check if any commentRangeStart was present without commentRangeEnd/commentReference in the same paragraph
    for (const tok of scanXmlTags(docXml, pSpan.innerStart, pSpan.innerEnd)) {
      if (tok.localName === 'commentRangeStart') {
        const cId = parseAttr(tok.attrs, 'w:id') ?? parseAttr(tok.attrs, 'id');
        if (cId) attachCommentById(cId);
      }
    }
  }

  const visibleText = runs.map((r) => r.text).join('');
  return {
    id,
    locationLabel,
    ...(headingLevel !== undefined ? { headingLevel } : {}),
    ...(currentSection ? { section: currentSection } : {}),
    pSpan,
    runs,
    visibleText,
    segments,
    trackedChanges,
    comments,
    links,
  };
}

function indexDocumentBody(
  docXml: string,
  styleHeadingMap: Map<string, number>,
  hyperlinkMap: Map<string, string>,
  commentsMap: Map<string, DocCommentInfo>,
): {
  bodyParagraphs: IndexedParagraph[];
  tables: IndexedTable[];
  paragraphById: Map<string, IndexedParagraph>;
  headings: Array<{ id: string; level: number; text: string; section: string }>;
} {
  assertNoXmlEntitiesOrDtd(docXml, 'word/document.xml');
  const bodySpan = findFirstElement(docXml, 'body') ?? findFirstElement(docXml, 'document');
  if (!bodySpan || bodySpan.selfClosing) {
    return {
      bodyParagraphs: [],
      tables: [],
      paragraphById: new Map(),
      headings: [],
    };
  }

  // Find top-level <w:p> and <w:tbl> inside <w:body>
  const topBlocks: Array<{ kind: 'p' | 'tbl'; span: XmlElementSpan }> = [];
  const stack: Array<{ name: string; localName: string; attrs: string; start: number; end: number }> = [];
  let tblDepth = 0;
  let pDepth = 0;

  for (const tok of scanXmlTags(docXml, bodySpan.innerStart, bodySpan.innerEnd)) {
    if (tok.localName === 'tbl') {
      if (tok.kind === 'self') {
        if (tblDepth === 0 && pDepth === 0) {
          topBlocks.push({
            kind: 'tbl',
            span: {
              name: tok.name,
              localName: 'tbl',
              attrs: tok.attrs,
              openStart: tok.start,
              openEnd: tok.end,
              innerStart: tok.end,
              innerEnd: tok.end,
              closeStart: tok.end,
              closeEnd: tok.end,
              selfClosing: true,
            },
          });
        }
      } else if (tok.kind === 'open') {
        if (tblDepth === 0 && pDepth === 0) {
          stack.push({ name: tok.name, localName: 'tbl', attrs: tok.attrs, start: tok.start, end: tok.end });
        }
        tblDepth++;
      } else if (tok.kind === 'close') {
        tblDepth = Math.max(0, tblDepth - 1);
        if (tblDepth === 0 && pDepth === 0 && stack.length > 0 && stack[stack.length - 1]!.localName === 'tbl') {
          const open = stack.pop()!;
          topBlocks.push({
            kind: 'tbl',
            span: {
              name: open.name,
              localName: 'tbl',
              attrs: open.attrs,
              openStart: open.start,
              openEnd: open.end,
              innerStart: open.end,
              innerEnd: tok.start,
              closeStart: tok.start,
              closeEnd: tok.end,
              selfClosing: false,
            },
          });
        }
      }
    } else if (tok.localName === 'p' && tblDepth === 0) {
      if (tok.kind === 'self') {
        if (pDepth === 0) {
          topBlocks.push({
            kind: 'p',
            span: {
              name: tok.name,
              localName: 'p',
              attrs: tok.attrs,
              openStart: tok.start,
              openEnd: tok.end,
              innerStart: tok.end,
              innerEnd: tok.end,
              closeStart: tok.end,
              closeEnd: tok.end,
              selfClosing: true,
            },
          });
        }
      } else if (tok.kind === 'open') {
        if (pDepth === 0) {
          stack.push({ name: tok.name, localName: 'p', attrs: tok.attrs, start: tok.start, end: tok.end });
        }
        pDepth++;
      } else if (tok.kind === 'close') {
        pDepth = Math.max(0, pDepth - 1);
        if (pDepth === 0 && stack.length > 0 && stack[stack.length - 1]!.localName === 'p') {
          const open = stack.pop()!;
          topBlocks.push({
            kind: 'p',
            span: {
              name: open.name,
              localName: 'p',
              attrs: open.attrs,
              openStart: open.start,
              openEnd: open.end,
              innerStart: open.end,
              innerEnd: tok.start,
              closeStart: tok.start,
              closeEnd: tok.end,
              selfClosing: false,
            },
          });
        }
      }
    }
  }

  const bodyParagraphs: IndexedParagraph[] = [];
  const tables: IndexedTable[] = [];
  const paragraphById = new Map<string, IndexedParagraph>();
  const headings: Array<{ id: string; level: number; text: string; section: string }> = [];

  let pCounter = 0;
  let tblCounter = 0;
  let currentSection: string | undefined;

  for (const block of topBlocks) {
    if (block.kind === 'p') {
      pCounter++;
      const pId = `p${pCounter}`;
      const parsed = parseParagraphAtSpan(
        docXml,
        block.span,
        pId,
        pId,
        styleHeadingMap,
        hyperlinkMap,
        commentsMap,
        currentSection,
      );
      if (parsed.headingLevel !== undefined && parsed.visibleText.trim()) {
        const cleanTitle = parsed.visibleText.trim();
        currentSection = cleanTitle.startsWith('§') ? cleanTitle : `§${cleanTitle}`;
        parsed.section = currentSection;
        headings.push({
          id: pId,
          level: parsed.headingLevel,
          text: cleanTitle,
          section: currentSection,
        });
      }
      bodyParagraphs.push(parsed);
      paragraphById.set(pId, parsed);
    } else {
      tblCounter++;
      const tId = `t${tblCounter}`;
      const trSpans = findElements(docXml, 'tr', block.span.innerStart, block.span.innerEnd);
      const tableRows: IndexedTable['rows'] = [];
      trSpans.forEach((trSpan, rIdx) => {
        const rowNum = rIdx + 1;
        const tcSpans = findElements(docXml, 'tc', trSpan.innerStart, trSpan.innerEnd);
        const rowCells: IndexedTable['rows'][number] = [];
        tcSpans.forEach((tcSpan, cIdx) => {
          const colNum = cIdx + 1;
          const cellId = `${tId}.r${rowNum}.c${colNum}`;
          const cellPSpans = findElements(docXml, 'p', tcSpan.innerStart, tcSpan.innerEnd);
          const allParas = cellPSpans.map((cpSpan, pIdx) =>
            parseParagraphAtSpan(
              docXml,
              cpSpan,
              pIdx === 0 ? cellId : `${cellId}.p${pIdx + 1}`,
              cellId,
              styleHeadingMap,
              hyperlinkMap,
              commentsMap,
              currentSection,
            ),
          );
          for (const cp of allParas) {
            paragraphById.set(cp.id, cp);
          }
          rowCells.push({
            cellId,
            row: rowNum,
            col: colNum,
            tcSpan,
            firstPara: allParas[0] ?? null,
            allParas,
          });
        });
        tableRows.push(rowCells);
      });
      tables.push({
        id: tId,
        ...(currentSection ? { section: currentSection } : {}),
        tblSpan: block.span,
        rows: tableRows,
      });
    }
  }

  return { bodyParagraphs, tables, paragraphById, headings };
}

export async function readDocxStructure(
  rawZip: Uint8Array,
  opts?: { section?: string; maxUnzippedBytes?: number },
): Promise<DocStructureResult> {
  const maxBytes = opts?.maxUnzippedBytes ?? DOCX_MAX_UNZIPPED_BYTES;
  const files = await readZipSafe(rawZip, maxBytes);
  const docXml = utf8(files['word/document.xml']);
  if (!docXml) {
    throw new Error('Invalid .docx file: missing word/document.xml.');
  }

  const styleHeadingMap = parseStyleHeadingLevels(utf8(files['word/styles.xml']));
  const hyperlinkMap = parseHyperlinkRels(utf8(files['word/_rels/document.xml.rels']));
  const commentsMap = parseCommentsPart(utf8(files['word/comments.xml']));

  const indexed = indexDocumentBody(docXml, styleHeadingMap, hyperlinkMap, commentsMap);

  // Filter by section if requested
  const sectionQuery = opts?.section?.trim();
  let filteredParagraphs = indexed.bodyParagraphs;
  let filteredTables = indexed.tables;

  if (sectionQuery) {
    const qLower = sectionQuery.toLowerCase().replace(/^§\s*/, '');
    // Check if sectionQuery is a paragraph id ("p3") or range ("p2-p5") or table ("t1")
    const rangeMatch = /^p?(\d+)\s*(?:-|\.\.|to)\s*p?(\d+)$/i.exec(sectionQuery);
    const singleParaMatch = /^p(\d+)$/i.exec(sectionQuery);
    const singleTableMatch = /^t(\d+)$/i.exec(sectionQuery);

    if (rangeMatch) {
      const startNum = Number(rangeMatch[1]);
      const endNum = Number(rangeMatch[2]);
      filteredParagraphs = indexed.bodyParagraphs.filter((p) => {
        const n = Number(p.id.slice(1));
        return n >= Math.min(startNum, endNum) && n <= Math.max(startNum, endNum);
      });
      filteredTables = [];
    } else if (singleParaMatch) {
      const targetId = `p${singleParaMatch[1]}`;
      filteredParagraphs = indexed.bodyParagraphs.filter((p) => p.id === targetId);
      filteredTables = [];
    } else if (singleTableMatch) {
      const targetTableId = `t${singleTableMatch[1]}`;
      filteredParagraphs = [];
      filteredTables = indexed.tables.filter((t) => t.id === targetTableId);
    } else {
      // Match heading text / section title, and include all paragraphs & tables until the next heading of <= level
      const matchHeadingIdx = indexed.bodyParagraphs.findIndex(
        (p) =>
          p.headingLevel !== undefined &&
          (p.visibleText.toLowerCase().includes(qLower) ||
            (p.section && p.section.toLowerCase().replace(/^§\s*/, '').includes(qLower))),
      );
      if (matchHeadingIdx !== -1) {
        const startHeading = indexed.bodyParagraphs[matchHeadingIdx]!;
        const targetLevel = startHeading.headingLevel ?? 1;
        const startOffset = startHeading.pSpan.openStart;
        let endOffset = docXml.length;
        for (let i = matchHeadingIdx + 1; i < indexed.bodyParagraphs.length; i++) {
          const p = indexed.bodyParagraphs[i]!;
          if (p.headingLevel !== undefined && p.headingLevel <= targetLevel) {
            endOffset = p.pSpan.openStart;
            break;
          }
        }
        filteredParagraphs = indexed.bodyParagraphs.filter(
          (p) => p.pSpan.openStart >= startOffset && p.pSpan.openStart < endOffset,
        );
        filteredTables = indexed.tables.filter(
          (t) => t.tblSpan.openStart >= startOffset && t.tblSpan.openStart < endOffset,
        );
      } else {
        // Fallback: substring match on paragraph section or text
        filteredParagraphs = indexed.bodyParagraphs.filter(
          (p) =>
            (p.section && p.section.toLowerCase().includes(qLower)) ||
            p.visibleText.toLowerCase().includes(qLower),
        );
        filteredTables = indexed.tables.filter(
          (t) =>
            (t.section && t.section.toLowerCase().includes(qLower)) ||
            t.rows.some((r) => r.some((c) => c.allParas.some((cp) => cp.visibleText.toLowerCase().includes(qLower)))),
        );
      }
    }
  }

  const allTrackedChanges: DocTrackedChangeInfo[] = [];
  for (const p of filteredParagraphs) {
    allTrackedChanges.push(...p.trackedChanges);
  }
  for (const t of filteredTables) {
    for (const row of t.rows) {
      for (const cell of row) {
        for (const cp of cell.allParas) {
          allTrackedChanges.push(...cp.trackedChanges);
        }
      }
    }
  }

  const allComments = [...commentsMap.values()].filter((c) => {
    if (!sectionQuery) return true;
    return filteredParagraphs.some((p) => p.id === c.paragraphId);
  });

  const headers: string[] = [];
  for (const key of Object.keys(files).filter((k) => /^word\/header\d*\.xml$/.test(k)).sort()) {
    headers.push(...extractSimplePartLines(utf8(files[key]), key));
  }
  const footers: string[] = [];
  for (const key of Object.keys(files).filter((k) => /^word\/footer\d*\.xml$/.test(k)).sort()) {
    footers.push(...extractSimplePartLines(utf8(files[key]), key));
  }
  const footnotes = extractSimplePartLines(utf8(files['word/footnotes.xml']), 'word/footnotes.xml');

  return {
    paragraphs: filteredParagraphs.map((p) => ({
      id: p.id,
      ...(p.headingLevel !== undefined ? { headingLevel: p.headingLevel } : {}),
      ...(p.section ? { section: p.section } : {}),
      text: p.visibleText,
      segments: p.segments,
      trackedChanges: p.trackedChanges,
      comments: p.comments,
      links: p.links,
    })),
    headings: indexed.headings,
    tables: filteredTables.map((t) => ({
      id: t.id,
      ...(t.section ? { section: t.section } : {}),
      rows: t.rows.map((row) =>
        row.map((cell) => ({
          cellId: cell.cellId,
          row: cell.row,
          col: cell.col,
          text: cell.allParas.map((cp) => cp.visibleText).join('\n'),
          segments: cell.allParas.flatMap((cp) => cp.segments),
        })),
      ),
    })),
    comments: allComments,
    trackedChanges: allTrackedChanges,
    headers,
    footers,
    footnotes,
  };
}

export function formatDocReadText(struct: DocStructureResult, sectionFilter?: string): string {
  const lines: string[] = [];
  lines.push(
    `Paragraphs: ${struct.paragraphs.length} | Headings: ${struct.headings.length} | Tables: ${struct.tables.length} | Comments: ${struct.comments.length} | Tracked changes: ${struct.trackedChanges.length}`,
  );
  if (sectionFilter) {
    lines.push(`Section filter: "${sectionFilter}"`);
  }

  if (struct.headings.length > 0) {
    lines.push('\n## Headings Outline');
    for (const h of struct.headings) {
      lines.push(`- [${h.id}] ${'#'.repeat(h.level)} ${h.text}`);
    }
  }

  if (struct.headers.length > 0) {
    lines.push(`\n## Headers\n${struct.headers.join('\n')}`);
  }

  lines.push('\n## Paragraphs');
  if (struct.paragraphs.length === 0) {
    lines.push('(no matching paragraphs)');
  } else {
    for (const p of struct.paragraphs) {
      const headingPrefix = p.headingLevel ? `${'#'.repeat(p.headingLevel)} ` : '';
      const hasMarkup = p.segments.some((s) => s.type !== 'text');
      let rendered = '';
      if (hasMarkup) {
        rendered = p.segments
          .map((s) => {
            if (s.type === 'ins') return `{+${s.text}+}`;
            if (s.type === 'del') return `{-${s.text}-}`;
            if (s.type === 'comment') return `[Comment #${s.id ?? ''} by ${s.author ?? 'Unknown'}: "${s.text}"]`;
            return s.text;
          })
          .join('');
      } else {
        rendered = p.text;
      }
      const linkSuffix =
        p.links.length > 0 ? ` (links: ${p.links.map((l) => `[${l.text}](${l.url})`).join(', ')})` : '';
      lines.push(`[${p.id}] ${headingPrefix}${rendered || '(empty)'}${linkSuffix}`);
    }
  }

  if (struct.tables.length > 0) {
    lines.push('\n## Tables');
    for (const t of struct.tables) {
      const rowCount = t.rows.length;
      const colCount = t.rows[0]?.length ?? 0;
      lines.push(`[${t.id}] (${rowCount} row${rowCount === 1 ? '' : 's'} × ${colCount} col${colCount === 1 ? '' : 's'}${t.section ? `, ${t.section}` : ''}):`);
      for (const row of t.rows) {
        const cellStrs = row.map((c) => `[${c.cellId}] ${c.text.replace(/\n/g, ' ')}`);
        lines.push(`  | ${cellStrs.join(' | ')} |`);
      }
    }
  }

  if (struct.trackedChanges.length > 0) {
    lines.push('\n## Tracked Changes');
    for (const tc of struct.trackedChanges) {
      const kindLabel = tc.type === 'ins' ? 'Inserted' : 'Deleted';
      const dateSuffix = tc.date ? ` (${tc.date})` : '';
      lines.push(`- [${tc.paragraphId}] ${kindLabel} by ${tc.author}${dateSuffix}: "${tc.text}"`);
    }
  }

  if (struct.comments.length > 0) {
    lines.push('\n## Comments');
    for (const c of struct.comments) {
      const locPrefix = c.paragraphId ? `[${c.paragraphId}] ` : '';
      const dateSuffix = c.date ? ` (${c.date})` : '';
      lines.push(`- ${locPrefix}Comment #${c.id} by ${c.author}${dateSuffix}: "${c.text}"`);
    }
  }

  if (struct.footnotes.length > 0) {
    lines.push(`\n## Footnotes\n${struct.footnotes.map((f, i) => `[${i + 1}] ${f}`).join('\n')}`);
  }

  if (struct.footers.length > 0) {
    lines.push(`\n## Footers\n${struct.footers.join('\n')}`);
  }

  return lines.join('\n');
}

/**
 * Extracts redline blocks from a `.docx` buffer for previewing tracked changes
 * (`w:ins`, `w:del`, `w:comment`) in the Workspace panel.
 */
export async function extractDocxRedline(
  rawZip: Uint8Array,
  opts?: { includeUnchanged?: boolean; maxUnzippedBytes?: number },
): Promise<{ blocks: DocRedlineBlock[]; trackedChangesCount: number; commentsCount: number }> {
  const struct = await readDocxStructure(rawZip, { maxUnzippedBytes: opts?.maxUnzippedBytes });
  const includeAll = opts?.includeUnchanged ?? true;
  const blocks: DocRedlineBlock[] = [];

  for (const p of struct.paragraphs) {
    const hasChanges = p.segments.some((s) => s.type === 'ins' || s.type === 'del' || s.type === 'comment');
    if (!includeAll && !hasChanges) continue;
    if (p.segments.length === 0 && !p.text) continue;
    blocks.push({
      id: p.id,
      paragraphId: p.id,
      ...(p.section ? { location: p.section } : {}),
      ...(p.headingLevel !== undefined ? { headingLevel: p.headingLevel } : {}),
      hasChanges,
      segments: p.segments.length > 0 ? p.segments : [{ type: 'text', text: p.text }],
    });
  }

  for (const t of struct.tables) {
    for (const row of t.rows) {
      for (const cell of row) {
        const hasChanges = cell.segments.some((s) => s.type === 'ins' || s.type === 'del' || s.type === 'comment');
        if (!includeAll && !hasChanges) continue;
        if (!hasChanges && !cell.text) continue;
        blocks.push({
          id: cell.cellId,
          paragraphId: cell.cellId,
          location: t.section ? `${t.section} (${cell.cellId})` : cell.cellId,
          hasChanges,
          segments: cell.segments.length > 0 ? cell.segments : [{ type: 'text', text: cell.text }],
        });
      }
    }
  }

  return {
    blocks,
    trackedChangesCount: struct.trackedChanges.length,
    commentsCount: struct.comments.length,
  };
}

/**
 * Computes redline blocks comparing two `.docx` versions (`beforeZip` and `afterZip`).
 * Preserves native `<w:ins>` / `<w:del>` / `<w:comment>` markup on `afterZip` and
 * also computes inline word-level diffs for any `direct` (untracked) edits between
 * `beforeZip` and `afterZip`.
 */
export async function computeDocxVersionRedline(
  beforeZip: Uint8Array | null,
  afterZip: Uint8Array,
): Promise<DocRedlineBlock[]> {
  const afterStruct = await readDocxStructure(afterZip).catch(() => null);
  if (!afterStruct) return [];
  const beforeStruct = beforeZip ? await readDocxStructure(beforeZip).catch(() => null) : null;

  const beforeMap = new Map<string, string>();
  if (beforeStruct) {
    for (const p of beforeStruct.paragraphs) beforeMap.set(p.id, p.text);
    for (const t of beforeStruct.tables) {
      for (const row of t.rows) {
        for (const c of row) beforeMap.set(c.cellId, c.text);
      }
    }
  }

  const blocks: DocRedlineBlock[] = [];

  const processItem = (
    id: string,
    afterText: string,
    afterSegments: DocRedlineSegment[],
    headingLevel?: number,
    location?: string,
  ): void => {
    const hasTracked = afterSegments.some((s) => s.type === 'ins' || s.type === 'del' || s.type === 'comment');
    if (hasTracked) {
      blocks.push({
        id,
        paragraphId: id,
        ...(location ? { location } : {}),
        ...(headingLevel !== undefined ? { headingLevel } : {}),
        hasChanges: true,
        segments: afterSegments,
      });
      return;
    }
    const beforeText = beforeMap.get(id);
    if (beforeStruct && beforeText !== undefined && beforeText !== afterText) {
      blocks.push({
        id,
        paragraphId: id,
        ...(location ? { location } : {}),
        ...(headingLevel !== undefined ? { headingLevel } : {}),
        hasChanges: true,
        segments: buildInlineDiffSegments(beforeText, afterText),
      });
    } else if (!beforeStruct && afterText) {
      blocks.push({
        id,
        paragraphId: id,
        ...(location ? { location } : {}),
        ...(headingLevel !== undefined ? { headingLevel } : {}),
        hasChanges: true,
        segments: [{ type: 'ins', text: afterText }],
      });
    }
  };

  for (const p of afterStruct.paragraphs) {
    processItem(p.id, p.text, p.segments, p.headingLevel, p.section);
  }
  for (const t of afterStruct.tables) {
    for (const row of t.rows) {
      for (const c of row) {
        processItem(c.cellId, c.text, c.segments, undefined, t.section ? `${t.section} (${c.cellId})` : c.cellId);
      }
    }
  }

  return blocks;
}

function buildInlineDiffSegments(before: string, after: string, author?: string): DocRedlineSegment[] {
  if (before === after) {
    return before ? [{ type: 'text', text: before }] : [];
  }
  let prefixLen = 0;
  const minLen = Math.min(before.length, after.length);
  while (prefixLen < minLen && before.charCodeAt(prefixLen) === after.charCodeAt(prefixLen)) {
    prefixLen++;
  }
  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    before.charCodeAt(before.length - 1 - suffixLen) === after.charCodeAt(after.length - 1 - suffixLen)
  ) {
    suffixLen++;
  }

  const prefix = before.slice(0, prefixLen);
  const removed = before.slice(prefixLen, before.length - suffixLen);
  const added = after.slice(prefixLen, after.length - suffixLen);
  const suffix = before.slice(before.length - suffixLen);

  const segments: DocRedlineSegment[] = [];
  if (prefix) segments.push({ type: 'text', text: prefix });
  if (removed) segments.push({ type: 'del', text: removed, ...(author ? { author } : {}) });
  if (added) segments.push({ type: 'ins', text: added, ...(author ? { author } : {}) });
  if (suffix) segments.push({ type: 'text', text: suffix });
  return segments;
}

function findMaxRevisionId(docXml: string, commentsXml: string): number {
  let maxId = 0;
  const scan = (xml: string): void => {
    for (const m of xml.matchAll(/\bw:id="(\d+)"/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
  };
  scan(docXml);
  scan(commentsXml);
  return maxId;
}

function splitReplacementAcrossRuns(
  overlapped: Array<{ text: string; rPrRaw: string }>,
  newText: string,
): Array<{ text: string; rPrRaw: string }> {
  if (!newText) return [];
  if (overlapped.length === 0) return [{ text: newText, rPrRaw: '' }];

  // Merge adjacent runs with identical rPrRaw
  const groups: Array<{ text: string; rPrRaw: string }> = [];
  for (const r of overlapped) {
    const prev = groups[groups.length - 1];
    if (prev && prev.rPrRaw === r.rPrRaw) {
      prev.text += r.text;
    } else {
      groups.push({ text: r.text, rPrRaw: r.rPrRaw });
    }
  }

  if (groups.length === 1) {
    return [{ text: newText, rPrRaw: groups[0]!.rPrRaw }];
  }

  // Peel common exact prefix group or suffix group if present
  const prefixResult: Array<{ text: string; rPrRaw: string }> = [];
  const suffixResult: Array<{ text: string; rPrRaw: string }> = [];
  let remainingText = newText;
  let startIdx = 0;
  let endIdx = groups.length - 1;

  while (startIdx < endIdx && groups[startIdx]!.text && remainingText.startsWith(groups[startIdx]!.text)) {
    const g = groups[startIdx]!;
    prefixResult.push({ text: g.text, rPrRaw: g.rPrRaw });
    remainingText = remainingText.slice(g.text.length);
    startIdx++;
  }
  while (endIdx > startIdx && groups[endIdx]!.text && remainingText.endsWith(groups[endIdx]!.text)) {
    const g = groups[endIdx]!;
    suffixResult.unshift({ text: g.text, rPrRaw: g.rPrRaw });
    remainingText = remainingText.slice(0, remainingText.length - g.text.length);
    endIdx--;
  }

  const activeGroups = groups.slice(startIdx, endIdx + 1);
  if (activeGroups.length === 1) {
    return [
      ...prefixResult,
      ...(remainingText ? [{ text: remainingText, rPrRaw: activeGroups[0]!.rPrRaw }] : []),
      ...suffixResult,
    ];
  }

  // Distribute remainingText across activeGroups preserving each run's rPrRaw.
  // First try splitting along whitespace tokens if token count matches activeGroups.length;
  // otherwise split proportionally by the original run lengths (snapping to nearby spaces).
  const totalOrigLen = activeGroups.reduce((acc, g) => acc + Math.max(1, g.text.length), 0);
  const middleResult: Array<{ text: string; rPrRaw: string }> = [];
  let cursor = 0;

  for (let i = 0; i < activeGroups.length; i++) {
    const g = activeGroups[i]!;
    if (i === activeGroups.length - 1) {
      const rest = remainingText.slice(cursor);
      if (rest) middleResult.push({ text: rest, rPrRaw: g.rPrRaw });
      break;
    }
    const weight = Math.max(1, g.text.length) / totalOrigLen;
    let targetCut = cursor + Math.max(1, Math.round(remainingText.length * weight));
    targetCut = Math.min(remainingText.length, targetCut);

    // If original group ended with whitespace, try snapping cut right after a space near targetCut
    if (/\s$/.test(g.text)) {
      const spaceAfter = remainingText.indexOf(' ', cursor);
      if (spaceAfter !== -1 && spaceAfter + 1 < remainingText.length) {
        targetCut = spaceAfter + 1;
      }
    }
    const chunk = remainingText.slice(cursor, targetCut);
    if (chunk) {
      middleResult.push({ text: chunk, rPrRaw: g.rPrRaw });
    }
    cursor = targetCut;
  }

  return [...prefixResult, ...middleResult, ...suffixResult];
}

function parseCellCoordString(cellRaw: string): { tableId?: string; row: number; col: number } | null {
  const s = cellRaw.trim();
  const fullMatch = /^(?:(t\d+)\.)?r(\d+)\.?c(\d+)$/i.exec(s);
  if (fullMatch) {
    return {
      ...(fullMatch[1] ? { tableId: fullMatch[1].toLowerCase() } : {}),
      row: Number(fullMatch[2]),
      col: Number(fullMatch[3]),
    };
  }
  const a1Match = /^(?:(t\d+)!)?([A-Za-z]+)(\d+)$/.exec(s);
  if (a1Match) {
    const letters = a1Match[2]!.toUpperCase();
    let col = 0;
    for (let i = 0; i < letters.length; i++) {
      col = col * 26 + (letters.charCodeAt(i) - 64);
    }
    return {
      ...(a1Match[1] ? { tableId: a1Match[1].toLowerCase() } : {}),
      row: Number(a1Match[3]),
      col,
    };
  }
  return null;
}

function normalizeParagraphIdRef(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) {
    return `p${raw}`;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    if (/^\d+$/.test(t)) return `p${t}`;
    return t;
  }
  return undefined;
}

export async function previewAndApplyDocxEdits(
  rawZip: Uint8Array,
  edits: DocEditInput[],
  opts: {
    mode?: 'tracked' | 'direct';
    author?: string;
    dateIso?: string;
    maxUnzippedBytes?: number;
    apply?: boolean;
  } = {},
): Promise<DocEditOutcome> {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: 'doc_edit requires a non-empty edits array.' };
  }

  const mode: 'tracked' | 'direct' = opts.mode === 'direct' ? 'direct' : 'tracked';
  const author = (opts.author ?? 'Pocket Agent (Default)').trim() || 'Pocket Agent (Default)';
  const dateIso = opts.dateIso ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const maxBytes = opts.maxUnzippedBytes ?? DOCX_MAX_UNZIPPED_BYTES;
  const shouldApply = opts.apply !== false;

  let files: Record<string, Uint8Array>;
  try {
    files = await readZipSafe(rawZip, maxBytes);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const docXml = utf8(files['word/document.xml']);
  if (!docXml) {
    return { ok: false, error: 'Invalid .docx file: missing word/document.xml.' };
  }

  const styleHeadingMap = parseStyleHeadingLevels(utf8(files['word/styles.xml']));
  const hyperlinkMap = parseHyperlinkRels(utf8(files['word/_rels/document.xml.rels']));
  const existingCommentsXml = utf8(files['word/comments.xml']);
  const commentsMap = parseCommentsPart(existingCommentsXml);

  const indexed = indexDocumentBody(docXml, styleHeadingMap, hyperlinkMap, commentsMap);
  let nextRevId = findMaxRevisionId(docXml, existingCommentsXml) + 1;

  // Group planned edits by target IndexedParagraph so multiple non-overlapping edits can be applied cleanly
  interface PlannedParaEdit {
    para: IndexedParagraph;
    matchStart: number;
    matchEnd: number;
    oldSlice: string;
    newText: string | null; // null when comment-only
    commentText?: string;
  }

  const planned: PlannedParaEdit[] = [];

  for (let idx = 0; idx < edits.length; idx++) {
    const edit = edits[idx]!;
    const rawOp = edit.op;
    const paraIdArg =
      normalizeParagraphIdRef(edit.paragraphId) ??
      normalizeParagraphIdRef(edit.paragraph) ??
      normalizeParagraphIdRef(edit.id);
    const anchorArg =
      typeof edit.oldText === 'string'
        ? edit.oldText
        : typeof edit.anchor === 'string'
          ? edit.anchor
          : typeof edit.find === 'string'
            ? edit.find
            : typeof edit.target === 'string'
              ? edit.target
              : undefined;
    const commentArg = typeof edit.comment === 'string' && edit.comment.trim() ? edit.comment.trim() : undefined;

    // Check if this is a table cell edit
    const isTableEdit =
      rawOp === 'set_cell' ||
      rawOp === 'table_cell' ||
      edit.table !== undefined ||
      edit.tableId !== undefined ||
      edit.tableIndex !== undefined ||
      edit.row !== undefined ||
      edit.col !== undefined ||
      edit.column !== undefined ||
      edit.cell !== undefined ||
      (paraIdArg !== undefined && /^t\d+\.r\d+\.c\d+$/i.test(paraIdArg));

    if (isTableEdit) {
      let targetCellPara: IndexedParagraph | undefined;
      if (paraIdArg && /^t\d+\.r\d+\.c\d+$/i.test(paraIdArg)) {
        targetCellPara = indexed.paragraphById.get(paraIdArg.toLowerCase());
      } else if (typeof edit.cell === 'string' && edit.cell.trim()) {
        const parsedCoord = parseCellCoordString(edit.cell);
        if (!parsedCoord) {
          return { ok: false, error: `Invalid table cell coordinate "${edit.cell}" in edit #${idx + 1}.` };
        }
        const tblId =
          parsedCoord.tableId ??
          (typeof edit.table === 'string' && edit.table.trim()
            ? edit.table.trim().toLowerCase()
            : typeof edit.table === 'number'
              ? `t${edit.table >= 1 ? edit.table : edit.table + 1}`
              : 't1');
        const cellKey = `${tblId.startsWith('t') ? tblId : `t${tblId}`}.r${parsedCoord.row}.c${parsedCoord.col}`;
        targetCellPara = indexed.paragraphById.get(cellKey);
      } else {
        const rawTbl = edit.table ?? edit.tableId ?? edit.tableIndex ?? 1;
        let tblIndexZero = 0;
        if (typeof rawTbl === 'string') {
          const m = /^t?(\d+)$/i.exec(rawTbl.trim());
          tblIndexZero = m ? Math.max(0, Number(m[1]) - 1) : 0;
        } else if (typeof rawTbl === 'number') {
          tblIndexZero = rawTbl >= 1 && rawTbl <= indexed.tables.length ? rawTbl - 1 : Math.max(0, rawTbl);
        }
        const tbl = indexed.tables[tblIndexZero];
        if (!tbl) {
          return {
            ok: false,
            error: `Table "${String(rawTbl)}" not found in edit #${idx + 1} (document has ${indexed.tables.length} table(s)).`,
          };
        }
        const rawRow = edit.row ?? 1;
        const rawCol = edit.col ?? edit.column ?? 1;
        let colNum = 1;
        if (typeof rawCol === 'string') {
          if (/^[A-Za-z]+$/.test(rawCol.trim())) {
            const up = rawCol.trim().toUpperCase();
            colNum = 0;
            for (let c = 0; c < up.length; c++) colNum = colNum * 26 + (up.charCodeAt(c) - 64);
          } else {
            colNum = Number(rawCol);
          }
        } else {
          colNum = rawCol;
        }
        // Support both 1-based (default, matching doc_read) and 0-based when 0 is explicitly passed
        const rowZero = rawRow === 0 ? 0 : rawRow - 1;
        const colZero = colNum === 0 ? 0 : colNum - 1;
        const cellObj = tbl.rows[rowZero]?.[colZero];
        if (!cellObj || !cellObj.firstPara) {
          return {
            ok: false,
            error: `Cell (row=${rawRow}, col=${String(rawCol)}) not found in table ${tbl.id} (${tbl.rows.length} rows).`,
          };
        }
        targetCellPara = cellObj.firstPara;
      }

      if (!targetCellPara) {
        return { ok: false, error: `Target table cell not found in edit #${idx + 1}.` };
      }

      const cellValue =
        edit.newText !== undefined
          ? String(edit.newText)
          : edit.text !== undefined
            ? String(edit.text)
            : edit.value !== undefined
              ? String(edit.value)
              : '';

      if (anchorArg !== undefined) {
        const pos = targetCellPara.visibleText.indexOf(anchorArg);
        if (pos === -1) {
          return {
            ok: false,
            error: `Text "${anchorArg}" not found in cell ${targetCellPara.id} (current text: "${targetCellPara.visibleText}").`,
          };
        }
        planned.push({
          para: targetCellPara,
          matchStart: pos,
          matchEnd: pos + anchorArg.length,
          oldSlice: anchorArg,
          newText: cellValue,
          ...(commentArg ? { commentText: commentArg } : {}),
        });
      } else {
        planned.push({
          para: targetCellPara,
          matchStart: 0,
          matchEnd: targetCellPara.visibleText.length,
          oldSlice: targetCellPara.visibleText,
          newText: cellValue,
          ...(commentArg ? { commentText: commentArg } : {}),
        });
      }
      continue;
    }

    // Resolve target paragraph for paragraphId / anchor edits
    let targetPara: IndexedParagraph | undefined;
    if (paraIdArg) {
      targetPara = indexed.paragraphById.get(paraIdArg) ?? indexed.paragraphById.get(paraIdArg.toLowerCase());
      if (!targetPara) {
        const available = indexed.bodyParagraphs.slice(0, 20).map((p) => p.id).join(', ');
        return {
          ok: false,
          error: `Paragraph "${paraIdArg}" not found (available paragraphs: ${available || 'none'}). Call doc_read first.`,
        };
      }
    } else if (anchorArg) {
      const matchingParas: IndexedParagraph[] = [];
      for (const p of indexed.bodyParagraphs) {
        if (p.visibleText.includes(anchorArg)) matchingParas.push(p);
      }
      if (matchingParas.length === 0) {
        for (const t of indexed.tables) {
          for (const r of t.rows) {
            for (const c of r) {
              for (const cp of c.allParas) {
                if (cp.visibleText.includes(anchorArg)) matchingParas.push(cp);
              }
            }
          }
        }
      }
      if (matchingParas.length === 0) {
        return {
          ok: false,
          error: `Anchor text "${anchorArg}" was not found in any paragraph. Call doc_read to inspect the current text.`,
        };
      }
      if (matchingParas.length > 1) {
        return {
          ok: false,
          error: `Anchor text "${anchorArg}" appears in multiple paragraphs (${matchingParas.map((p) => p.id).join(', ')}). Specify paragraphId to disambiguate.`,
        };
      }
      targetPara = matchingParas[0]!;
    } else {
      return {
        ok: false,
        error: `Edit #${idx + 1} must specify a "paragraphId", "anchor" ("oldText"), or "table"/"row"/"col".`,
      };
    }

    // Determine the character range [matchStart, matchEnd] and replacement inside targetPara
    const isDelete = rawOp === 'delete' || edit.delete === true;
    const isInsert =
      rawOp === 'insert' ||
      rawOp === 'insert_before' ||
      rawOp === 'insert_after' ||
      edit.insertBefore !== undefined ||
      edit.insertAfter !== undefined;
    const isCommentOnly =
      (rawOp === 'comment' || rawOp === 'add_comment') ||
      (commentArg !== undefined &&
        !isDelete &&
        !isInsert &&
        edit.newText === undefined &&
        edit.text === undefined &&
        edit.value === undefined);

    if (isCommentOnly) {
      if (!commentArg) {
        return { ok: false, error: `Comment edit #${idx + 1} requires non-empty "comment" text.` };
      }
      let mStart = 0;
      let mEnd = targetPara.visibleText.length;
      if (anchorArg) {
        const pos = targetPara.visibleText.indexOf(anchorArg);
        if (pos === -1) {
          return {
            ok: false,
            error: `Anchor text "${anchorArg}" not found in paragraph ${targetPara.id}.`,
          };
        }
        mStart = pos;
        mEnd = pos + anchorArg.length;
      }
      planned.push({
        para: targetPara,
        matchStart: mStart,
        matchEnd: mEnd,
        oldSlice: targetPara.visibleText.slice(mStart, mEnd),
        newText: null,
        commentText: commentArg,
      });
      continue;
    }

    if (isInsert) {
      const insertText =
        edit.insertBefore !== undefined
          ? edit.insertBefore
          : edit.insertAfter !== undefined
            ? edit.insertAfter
            : edit.newText !== undefined
              ? edit.newText
              : edit.text !== undefined
                ? edit.text
                : edit.value !== undefined
                  ? String(edit.value)
                  : '';
      const beforeMode =
        rawOp === 'insert_before' ||
        edit.insertBefore !== undefined ||
        edit.position === 'before' ||
        edit.position === 'start';

      let insertPos = beforeMode ? 0 : targetPara.visibleText.length;
      if (anchorArg) {
        const pos = targetPara.visibleText.indexOf(anchorArg);
        if (pos === -1) {
          return {
            ok: false,
            error: `Anchor text "${anchorArg}" not found in paragraph ${targetPara.id}.`,
          };
        }
        insertPos = beforeMode ? pos : pos + anchorArg.length;
      }
      planned.push({
        para: targetPara,
        matchStart: insertPos,
        matchEnd: insertPos,
        oldSlice: '',
        newText: insertText,
        ...(commentArg ? { commentText: commentArg } : {}),
      });
      continue;
    }

    if (isDelete) {
      let mStart = 0;
      let mEnd = targetPara.visibleText.length;
      if (anchorArg) {
        const pos = targetPara.visibleText.indexOf(anchorArg);
        if (pos === -1) {
          return {
            ok: false,
            error: `Text "${anchorArg}" not found in paragraph ${targetPara.id}.`,
          };
        }
        const secondPos = targetPara.visibleText.indexOf(anchorArg, pos + 1);
        if (secondPos !== -1) {
          return {
            ok: false,
            error: `Text "${anchorArg}" occurs multiple times in paragraph ${targetPara.id}; include more context in oldText.`,
          };
        }
        mStart = pos;
        mEnd = pos + anchorArg.length;
      }
      planned.push({
        para: targetPara,
        matchStart: mStart,
        matchEnd: mEnd,
        oldSlice: targetPara.visibleText.slice(mStart, mEnd),
        newText: '',
        ...(commentArg ? { commentText: commentArg } : {}),
      });
      continue;
    }

    // Default: replace
    const replacementText =
      edit.newText !== undefined
        ? edit.newText
        : edit.replacement !== undefined
          ? String(edit.replacement)
          : edit.text !== undefined
            ? edit.text
            : edit.value !== undefined
              ? String(edit.value)
              : undefined;
    if (replacementText === undefined) {
      return {
        ok: false,
        error: `Edit #${idx + 1} on ${targetPara.id} requires "newText" (or "text", "delete: true", or "comment").`,
      };
    }

    let mStart = 0;
    let mEnd = targetPara.visibleText.length;
    if (anchorArg !== undefined && anchorArg !== '') {
      const pos = targetPara.visibleText.indexOf(anchorArg);
      if (pos === -1) {
        return {
          ok: false,
          error: `Text "${anchorArg}" not found in paragraph ${targetPara.id} (current text: "${targetPara.visibleText}").`,
        };
      }
      const secondPos = targetPara.visibleText.indexOf(anchorArg, pos + 1);
      if (secondPos !== -1) {
        return {
          ok: false,
          error: `Text "${anchorArg}" occurs multiple times in paragraph ${targetPara.id}; include more surrounding text in oldText.`,
        };
      }
      mStart = pos;
      mEnd = pos + anchorArg.length;
    }
    planned.push({
      para: targetPara,
      matchStart: mStart,
      matchEnd: mEnd,
      oldSlice: targetPara.visibleText.slice(mStart, mEnd),
      newText: replacementText,
      ...(commentArg ? { commentText: commentArg } : {}),
    });
  }

  // Group planned edits by paragraph and verify no two edits overlap in the same paragraph
  const editsByPara = new Map<string, PlannedParaEdit[]>();
  for (const pe of planned) {
    const list = editsByPara.get(pe.para.id) ?? [];
    list.push(pe);
    editsByPara.set(pe.para.id, list);
  }

  const docSplices: XmlSplice[] = [];
  const newCommentEntries: Array<{ id: string; author: string; date: string; text: string }> = [];
  const beforeLines: string[] = [];
  const afterLines: string[] = [];
  const diffLines: string[] = [];
  const redlineBlocks: DocRedlineBlock[] = [];

  for (const [, paraEdits] of editsByPara) {
    paraEdits.sort((a, b) => a.matchStart - b.matchStart || a.matchEnd - b.matchEnd);
    for (let i = 1; i < paraEdits.length; i++) {
      if (paraEdits[i]!.matchStart < paraEdits[i - 1]!.matchEnd) {
        return {
          ok: false,
          error: `Overlapping edits in paragraph ${paraEdits[i]!.para.id} are not allowed.`,
        };
      }
    }

    const para = paraEdits[0]!.para;
    const beforeParaText = para.visibleText;
    let afterParaText = '';
    const blockSegments: DocRedlineSegment[] = [];
    let textCursor = 0;

    for (const pe of paraEdits) {
      if (pe.matchStart > textCursor) {
        const unchanged = beforeParaText.slice(textCursor, pe.matchStart);
        afterParaText += unchanged;
        blockSegments.push({ type: 'text', text: unchanged });
      }
      if (pe.newText === null) {
        // Comment-only edit keeps the anchored text intact
        const anchored = beforeParaText.slice(pe.matchStart, pe.matchEnd);
        afterParaText += anchored;
        if (anchored) blockSegments.push({ type: 'text', text: anchored });
      } else {
        if (pe.oldSlice) {
          blockSegments.push({ type: 'del', text: pe.oldSlice, author, date: dateIso });
        }
        if (pe.newText) {
          afterParaText += pe.newText;
          blockSegments.push({ type: 'ins', text: pe.newText, author, date: dateIso });
        }
      }
      if (pe.commentText) {
        blockSegments.push({ type: 'comment', text: pe.commentText, author, date: dateIso });
      }
      textCursor = pe.matchEnd;
    }
    if (textCursor < beforeParaText.length) {
      const tail = beforeParaText.slice(textCursor);
      afterParaText += tail;
      blockSegments.push({ type: 'text', text: tail });
    }

    const commentNote = paraEdits
      .filter((pe) => pe.commentText)
      .map((pe) => ` [comment: "${pe.commentText}"]`)
      .join('');
    beforeLines.push(`[${para.id}] ${beforeParaText}`);
    afterLines.push(`[${para.id}] ${afterParaText}${commentNote}`);
    diffLines.push(`- [${para.id}] ${beforeParaText}`);
    diffLines.push(`+ [${para.id}] ${afterParaText}${commentNote}`);

    redlineBlocks.push({
      id: para.id,
      paragraphId: para.id,
      ...(para.section ? { location: para.section } : {}),
      ...(para.headingLevel !== undefined ? { headingLevel: para.headingLevel } : {}),
      hasChanges: true,
      segments: blockSegments,
    });

    // Now build the byte/character-offset XML splices for this paragraph in word/document.xml
    if (para.runs.length === 0) {
      const parts: string[] = [];
      for (const pe of paraEdits) {
        let commentId: string | undefined;
        if (pe.commentText) {
          commentId = String(nextRevId++);
          newCommentEntries.push({ id: commentId, author, date: dateIso, text: pe.commentText });
        }
        const commentStartXml = commentId ? `<w:commentRangeStart w:id="${commentId}"/>` : '';
        const commentEndXml = commentId
          ? `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:commentReference w:id="${commentId}"/></w:r>`
          : '';
        let innerNewXml = '';
        if (pe.newText && pe.newText.length > 0) {
          const runXml = `<w:r><w:t${needsSpacePreserveAttr(pe.newText)}>${xmlEscape(pe.newText)}</w:t></w:r>`;
          innerNewXml =
            mode === 'tracked'
              ? `<w:ins w:id="${nextRevId++}" w:author="${xmlEscape(author)}" w:date="${xmlEscape(dateIso)}">${runXml}</w:ins>`
              : runXml;
        }
        parts.push(`${commentStartXml}${innerNewXml}${commentEndXml}`);
      }
      const fullInsert = parts.join('');
      if (para.pSpan.selfClosing) {
        docSplices.push({
          start: para.pSpan.openStart,
          end: para.pSpan.closeEnd,
          replacement: `<${para.pSpan.name}${para.pSpan.attrs}>${fullInsert}</${para.pSpan.name}>`,
        });
      } else {
        docSplices.push({
          start: para.pSpan.innerEnd,
          end: para.pSpan.innerEnd,
          replacement: fullInsert,
        });
      }
      continue;
    }

    const renderUnchangedSubslice = (cStart: number, cEnd: number): string => {
      if (cStart >= cEnd) return '';
      const parts: string[] = [];
      for (const r of para.runs) {
        if (r.textEnd <= cStart || r.textStart >= cEnd) continue;
        const s1 = Math.max(0, cStart - r.textStart);
        const s2 = Math.min(r.text.length, cEnd - r.textStart);
        const sub = r.text.slice(s1, s2);
        if (sub.length > 0) {
          parts.push(`<w:r>${r.rPrRaw}<w:t${needsSpacePreserveAttr(sub)}>${xmlEscape(sub)}</w:t></w:r>`);
        }
      }
      return parts.join('');
    };

    let cursor = 0;
    const outRunParts: string[] = [];

    for (const pe of paraEdits) {
      if (pe.matchStart > cursor) {
        outRunParts.push(renderUnchangedSubslice(cursor, pe.matchStart));
      }

      let commentId: string | undefined;
      if (pe.commentText) {
        commentId = String(nextRevId++);
        newCommentEntries.push({ id: commentId, author, date: dateIso, text: pe.commentText });
      }
      const commentStartXml = commentId ? `<w:commentRangeStart w:id="${commentId}"/>` : '';
      const commentEndXml = commentId
        ? `<w:commentRangeEnd w:id="${commentId}"/><w:r><w:commentReference w:id="${commentId}"/></w:r>`
        : '';

      const overlappedSlices: Array<{ text: string; rPrRaw: string }> = [];
      for (const r of para.runs) {
        if (pe.matchStart === pe.matchEnd) {
          if (r.textStart <= pe.matchStart && pe.matchStart <= r.textEnd) {
            overlappedSlices.push({ text: '', rPrRaw: r.rPrRaw });
          }
        } else if (r.textEnd > pe.matchStart && r.textStart < pe.matchEnd) {
          const sliceStart = Math.max(0, pe.matchStart - r.textStart);
          const sliceEnd = Math.min(r.text.length, pe.matchEnd - r.textStart);
          overlappedSlices.push({ text: r.text.slice(sliceStart, sliceEnd), rPrRaw: r.rPrRaw });
        }
      }
      if (overlappedSlices.length === 0 && para.runs.length > 0) {
        overlappedSlices.push({ text: '', rPrRaw: para.runs[0]!.rPrRaw });
      }

      let middleXml = '';
      if (pe.newText === null) {
        middleXml = overlappedSlices
          .filter((s) => s.text.length > 0)
          .map((s) => `<w:r>${s.rPrRaw}<w:t${needsSpacePreserveAttr(s.text)}>${xmlEscape(s.text)}</w:t></w:r>`)
          .join('');
      } else {
        let delXml = '';
        if (mode === 'tracked' && pe.oldSlice.length > 0) {
          const delId = String(nextRevId++);
          const delRunsXml = overlappedSlices
            .filter((s) => s.text.length > 0)
            .map(
              (s) => `<w:r>${s.rPrRaw}<w:delText${needsSpacePreserveAttr(s.text)}>${xmlEscape(s.text)}</w:delText></w:r>`,
            )
            .join('');
          delXml = `<w:del w:id="${delId}" w:author="${xmlEscape(author)}" w:date="${xmlEscape(dateIso)}">${delRunsXml}</w:del>`;
        }
        let insXml = '';
        if (pe.newText.length > 0) {
          const splitNew = splitReplacementAcrossRuns(overlappedSlices, pe.newText);
          const newRunsXml = splitNew
            .map((s) => `<w:r>${s.rPrRaw}<w:t${needsSpacePreserveAttr(s.text)}>${xmlEscape(s.text)}</w:t></w:r>`)
            .join('');
          insXml =
            mode === 'tracked'
              ? `<w:ins w:id="${nextRevId++}" w:author="${xmlEscape(author)}" w:date="${xmlEscape(dateIso)}">${newRunsXml}</w:ins>`
              : newRunsXml;
        }
        middleXml = `${delXml}${insXml}`;
      }

      outRunParts.push(`${commentStartXml}${middleXml}${commentEndXml}`);
      cursor = pe.matchEnd;
    }

    if (cursor < beforeParaText.length) {
      outRunParts.push(renderUnchangedSubslice(cursor, beforeParaText.length));
    }

    const firstRun = para.runs[0]!;
    const lastRun = para.runs[para.runs.length - 1]!;
    docSplices.push({
      start: firstRun.runSpan.openStart,
      end: lastRun.runSpan.closeEnd,
      replacement: outRunParts.join(''),
    });
  }

  let patchedZip: Uint8Array | undefined;
  if (shouldApply) {
    const outFiles: Record<string, Uint8Array> = { ...files };
    const patchedDocXml = applyXmlSplices(docXml, docSplices);
    outFiles['word/document.xml'] = strToU8(patchedDocXml);

    if (newCommentEntries.length > 0) {
      const commentNodesXml = newCommentEntries
        .map(
          (c) =>
            `<w:comment w:id="${xmlEscape(c.id)}" w:author="${xmlEscape(c.author)}" w:date="${xmlEscape(c.date)}" w:initials="PA">` +
            `<w:p><w:r><w:t${needsSpacePreserveAttr(c.text)}>${xmlEscape(c.text)}</w:t></w:r></w:p>` +
            `</w:comment>`,
        )
        .join('');

      if (existingCommentsXml) {
        const commentsRoot = findFirstElement(existingCommentsXml, 'comments');
        if (commentsRoot && !commentsRoot.selfClosing) {
          outFiles['word/comments.xml'] = strToU8(
            applyXmlSplices(existingCommentsXml, [
              {
                start: commentsRoot.innerEnd,
                end: commentsRoot.innerEnd,
                replacement: commentNodesXml,
              },
            ]),
          );
        }
      } else {
        outFiles['word/comments.xml'] = strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `${commentNodesXml}</w:comments>`,
        );
      }

      // Ensure word/_rels/document.xml.rels has the comments.xml relationship
      const docRelsXml = utf8(outFiles['word/_rels/document.xml.rels']);
      if (docRelsXml) {
        if (!/\/relationships\/comments\b/i.test(docRelsXml)) {
          const relsRoot = findFirstElement(docRelsXml, 'Relationships');
          if (relsRoot && !relsRoot.selfClosing) {
            const relId = `rIdComments${nextRevId++}`;
            outFiles['word/_rels/document.xml.rels'] = strToU8(
              applyXmlSplices(docRelsXml, [
                {
                  start: relsRoot.innerEnd,
                  end: relsRoot.innerEnd,
                  replacement: `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`,
                },
              ]),
            );
          }
        }
      } else {
        outFiles['word/_rels/document.xml.rels'] = strToU8(
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rIdComments1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>` +
            `</Relationships>`,
        );
      }

      // Ensure [Content_Types].xml has the /word/comments.xml Override
      const contentTypesXml = utf8(outFiles['[Content_Types].xml']);
      if (contentTypesXml && !/PartName="\/word\/comments\.xml"/i.test(contentTypesXml)) {
        const typesRoot = findFirstElement(contentTypesXml, 'Types');
        if (typesRoot && !typesRoot.selfClosing) {
          outFiles['[Content_Types].xml'] = strToU8(
            applyXmlSplices(contentTypesXml, [
              {
                start: typesRoot.innerEnd,
                end: typesRoot.innerEnd,
                replacement: `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
              },
            ]),
          );
        }
      }
    }

    patchedZip = zipSync(outFiles, { level: 6 });
  }

  return {
    ok: true,
    diff: {
      before: beforeLines.join('\n'),
      after: afterLines.join('\n'),
      lines: diffLines,
    },
    redline: redlineBlocks,
    redlineBlocks,
    appliedCount: planned.length,
    summary: `${planned.length} edit(s) in ${mode} mode`,
    mode,
    author,
    ...(patchedZip ? { patchedZip, patchedZipBytes: patchedZip } : {}),
  };
}

/**
 * Accepts or rejects tracked changes (`<w:ins>` and `<w:del>`) in a `.docx` archive
 * by byte-offset XML splicing, keeping every untouched zip entry byte-identical.
 * Used by round-trip tests and LibreOffice verification.
 */
export async function acceptOrRejectDocxTrackedChanges(
  rawZip: Uint8Array,
  decision: 'accept' | 'reject',
): Promise<Uint8Array> {
  const files = await readZipSafe(rawZip, DOCX_MAX_UNZIPPED_BYTES);
  const docXml = utf8(files['word/document.xml']);
  if (!docXml) throw new Error('Missing word/document.xml');

  const splices: XmlSplice[] = [];
  for (const insSpan of findElements(docXml, 'ins')) {
    if (decision === 'accept') {
      // Unwrap <w:ins ...>...</w:ins>, keeping its inner <w:r> runs
      const inner = insSpan.selfClosing ? '' : docXml.slice(insSpan.innerStart, insSpan.innerEnd);
      splices.push({ start: insSpan.openStart, end: insSpan.closeEnd, replacement: inner });
    } else {
      // Rejecting an insertion removes it
      splices.push({ start: insSpan.openStart, end: insSpan.closeEnd, replacement: '' });
    }
  }

  for (const delSpan of findElements(docXml, 'del')) {
    if (decision === 'accept') {
      // Accepting a deletion removes it
      splices.push({ start: delSpan.openStart, end: delSpan.closeEnd, replacement: '' });
    } else {
      // Rejecting a deletion unwraps <w:del> and converts <w:delText> back to <w:t>
      const inner = delSpan.selfClosing ? '' : docXml.slice(delSpan.innerStart, delSpan.innerEnd);
      const restored = inner
        .replace(/<w:delText\b/g, '<w:t')
        .replace(/<\/w:delText>/g, '</w:t>');
      splices.push({ start: delSpan.openStart, end: delSpan.closeEnd, replacement: restored });
    }
  }

  const outFiles: Record<string, Uint8Array> = {
    ...files,
    'word/document.xml': strToU8(applyXmlSplices(docXml, splices)),
  };
  return zipSync(outFiles, { level: 6 });
}
