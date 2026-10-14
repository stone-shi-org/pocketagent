import zlib from 'node:zlib';
import { strToU8, zipSync } from 'fflate';

/**
 * PA-137 / PA-139: tiny but real documents, built in memory, so the extraction
 * suites need no binary fixtures in the repo.
 */

export interface RichPdfOptions {
  title?: string;
  author?: string;
  /** Pages whose strings are raw content-stream commands instead of plain `(text) Tj`. */
  rawStreams?: boolean;
  /** Optional form widget `/T` + `/V` and text `/Contents` annotation on page 1. */
  formField?: { name: string; value: string };
  annotation?: string;
}

/** A valid PDF with one page per string, each drawn with the base-14 Helvetica. */
export function makePdf(pages: string[], opts: RichPdfOptions = {}): Buffer {
  const pageIds: number[] = [];
  // 1: catalog, 2: pages, 3: font, then a page + content stream (+ optional annotations) per page.
  const fontId = 3;
  let next = 4;
  const bodies: Record<number, string> = {};
  const fieldRefs: string[] = [];

  pages.forEach((text, idx) => {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    let stream: string;
    if (opts.rawStreams) {
      stream = text;
    } else if (text.length === 0) {
      stream = '';
    } else {
      const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
      stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    }

    const annotIds: number[] = [];
    if (idx === 0 && opts.formField) {
      const widgetId = next++;
      annotIds.push(widgetId);
      fieldRefs.push(`${widgetId} 0 R`);
      bodies[widgetId] =
        `<< /Type /Annot /Subtype /Widget /FT /Tx /Rect [72 680 200 700] ` +
        `/T (${pdfEscape(opts.formField.name)}) /V (${pdfEscape(opts.formField.value)}) >>`;
    }
    if (idx === 0 && opts.annotation) {
      const annId = next++;
      annotIds.push(annId);
      bodies[annId] =
        `<< /Type /Annot /Subtype /Text /Rect [72 650 90 670] /Contents (${pdfEscape(opts.annotation)}) >>`;
    }
    const annotsEntry = annotIds.length > 0 ? ` /Annots [${annotIds.map((id) => `${id} 0 R`).join(' ')}]` : '';
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R${annotsEntry} >>`;
    bodies[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  });

  const acroForm =
    fieldRefs.length > 0 ? ` /AcroForm << /Fields [${fieldRefs.join(' ')}] >>` : '';
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R${acroForm} >>`;
  bodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let infoRef = '';
  if (opts.title || opts.author) {
    const infoId = next++;
    const entries: string[] = [];
    if (opts.title) entries.push(`/Title (${pdfEscape(opts.title)})`);
    if (opts.author) entries.push(`/Author (${pdfEscape(opts.author)})`);
    bodies[infoId] = `<< ${entries.join(' ')} >>`;
    infoRef = ` /Info ${infoId} 0 R`;
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < next; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function pdfEscape(s: string): string {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * A one-page PDF whose content stream is `inflatedBytes` of spaces, deflated
 * to a few hundred KB: a decompression bomb in the shape pdf.js actually
 * decodes (a `FlateDecode` page stream).
 */
export function makeFlateBombPdf(inflatedBytes: number): Buffer {
  const stream = zlib.deflateSync(Buffer.alloc(inflatedBytes, 0x20), { level: 9 });
  const head = (id: number, body: string) => `${id} 0 obj\n${body}\nendobj\n`;
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  const push = (buf: Buffer, id?: number): void => {
    if (id !== undefined) offsets[id] = length;
    parts.push(buf);
    length += buf.length;
  };
  push(Buffer.from(head(1, '<< /Type /Catalog /Pages 2 0 R >>'), 'latin1'), 1);
  push(Buffer.from(head(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'), 'latin1'), 2);
  push(Buffer.from(head(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>'), 'latin1'), 3);
  push(Buffer.from(`4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), 4);
  push(stream);
  push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  const xref = length;
  let tail = 'xref\n0 5\n0000000000 65535 f \n';
  for (let id = 1; id <= 4; id++) tail += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  tail += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(Buffer.from(tail, 'latin1'));
  return Buffer.concat(parts);
}

const CONTENT_TYPES = (overrides: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;

export interface RichDocxOptions {
  heading?: string;
  table?: string[][];
  footnote?: string;
  header?: string;
  footer?: string;
  comment?: { author: string; text: string };
  inserted?: { author: string; text: string };
  deleted?: { author: string; text: string };
  link?: { text: string; url: string };
}

export function makeDocx(
  paragraphs: Array<string | { text: string; heading?: string }>,
  opts: RichDocxOptions = {},
): Buffer {
  const parts: string[] = [];
  if (opts.heading) {
    parts.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(opts.heading)}</w:t></w:r></w:p>`,
    );
  }
  for (const p of paragraphs) {
    if (typeof p === 'string') {
      parts.push(`<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`);
    } else {
      const pPr = p.heading ? `<w:pPr><w:pStyle w:val="${xmlEscape(p.heading)}"/></w:pPr>` : '';
      parts.push(`<w:p>${pPr}<w:r><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r></w:p>`);
    }
  }
  if (opts.link) {
    parts.push(
      `<w:p><w:hyperlink r:id="rIdLink1"><w:r><w:t>${xmlEscape(opts.link.text)}</w:t></w:r></w:hyperlink></w:p>`,
    );
  }
  if (opts.footnote) {
    parts.push(
      `<w:p><w:r><w:t xml:space="preserve">Main claim</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>`,
    );
  }
  if (opts.table && opts.table.length > 0) {
    const trs = opts.table
      .map(
        (row) =>
          `<w:tr>${row
            .map((cell) => `<w:tc><w:p><w:r><w:t>${xmlEscape(cell)}</w:t></w:r></w:p></w:tc>`)
            .join('')}</w:tr>`,
      )
      .join('');
    parts.push(`<w:tbl>${trs}</w:tbl>`);
  }
  if (opts.inserted || opts.deleted) {
    const ins = opts.inserted
      ? `<w:ins w:id="10" w:author="${xmlEscape(opts.inserted.author)}"><w:r><w:t>${xmlEscape(opts.inserted.text)}</w:t></w:r></w:ins>`
      : '';
    const del = opts.deleted
      ? `<w:del w:id="11" w:author="${xmlEscape(opts.deleted.author)}"><w:r><w:delText>${xmlEscape(opts.deleted.text)}</w:delText></w:r></w:del>`
      : '';
    parts.push(`<w:p>${ins}${del}</w:p>`);
  }

  const docRels: string[] = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  ];
  const overrides: string[] = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
  ];
  const files: Record<string, Uint8Array> = {
    'word/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
    ),
  };

  if (opts.link) {
    docRels.push(
      `<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(opts.link.url)}" TargetMode="External"/>`,
    );
  }
  if (opts.footnote) {
    docRels.push(
      `<Relationship Id="rIdFootnotes" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>`,
    );
    overrides.push(
      '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>',
    );
    files['word/footnotes.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:footnote w:id="1"><w:p><w:r><w:t>${xmlEscape(opts.footnote)}</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    );
  }
  if (opts.header) {
    files['word/header1.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:p><w:r><w:t>${xmlEscape(opts.header)}</w:t></w:r></w:p></w:hdr>`,
    );
  }
  if (opts.footer) {
    files['word/footer1.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:p><w:r><w:t>${xmlEscape(opts.footer)}</w:t></w:r></w:p></w:ftr>`,
    );
  }
  if (opts.comment) {
    files['word/comments.xml'] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
        `<w:comment w:id="0" w:author="${xmlEscape(opts.comment.author)}"><w:p><w:r><w:t>${xmlEscape(opts.comment.text)}</w:t></w:r></w:p></w:comment></w:comments>`,
    );
  }

  files['[Content_Types].xml'] = strToU8(CONTENT_TYPES(overrides.join('')));
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  files['word/_rels/document.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${docRels.join('')}</Relationships>`,
  );
  files['word/document.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${parts.join('')}</w:body></w:document>`,
  );
  return Buffer.from(zipSync(files));
}

/** PA-139: a docx with headings, a table, a footnote, header/footer, comments, and tracked changes. */
export function makeRichDocx(opts: RichDocxOptions): Buffer {
  return makeDocx([], opts);
}

function excelColLetters(colZeroBased: number): string {
  let n = colZeroBased + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `sheets` maps a sheet name to rows; a string cell goes through sharedStrings, a number stays inline. */
export function makeXlsx(sheets: Record<string, Array<Array<string | number>>>): Buffer {
  const shared: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const names = Object.keys(sheets);
  names.forEach((name, i) => {
    const rows = sheets[name]!.map((row, r) => {
      const cells = row
        .map((value, c) => {
          const ref = `${excelColLetters(c)}${r + 1}`;
          if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
          shared.push(value);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    });
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join('')}</sheetData></worksheet>`,
    );
  });
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('') +
      '</Relationships>',
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      shared.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('') +
      '</sst>',
  );
  files['[Content_Types].xml'] = strToU8(CONTENT_TYPES(''));
  return Buffer.from(zipSync(files));
}

export interface RichXlsxCell {
  ref: string;
  value?: string | number;
  formula?: string;
  /** Style index in `cellXfs`: `1` = built-in date (14), `2` = custom ISO date (164), `3` = percent (10), `4` = currency ($#,##0.00). */
  style?: number;
}

export interface RichXlsxSheet {
  name: string;
  hidden?: boolean;
  rows: Array<{ r: number; cells: RichXlsxCell[] }>;
  merges?: string[];
  comments?: Array<{ ref: string; author: string; text: string }>;
}

/** PA-139: builds an xlsx with styles (dates/percent/currency), formulas (with or without cached `<v>`), sparse rows, hidden sheets, merges, and comments. */
export function makeRichXlsx(sheets: RichXlsxSheet[]): Buffer {
  const shared: string[] = [];
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES('')),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="2">` +
        `<numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>` +
        `<numFmt numFmtId="165" formatCode="$#,##0.00"/>` +
        `</numFmts>` +
        `<cellXfs count="5">` +
        `<xf numFmtId="0"/>` +
        `<xf numFmtId="14" applyNumberFormat="1"/>` +
        `<xf numFmtId="164" applyNumberFormat="1"/>` +
        `<xf numFmtId="10" applyNumberFormat="1"/>` +
        `<xf numFmtId="165" applyNumberFormat="1"/>` +
        `</cellXfs></styleSheet>`,
    ),
  };

  sheets.forEach((sheet, idx) => {
    const rowXml = sheet.rows
      .map((row) => {
        const cellXml = row.cells
          .map((c) => {
            const sAttr = c.style !== undefined ? ` s="${c.style}"` : '';
            const fXml = c.formula ? `<f>${xmlEscape(c.formula)}</f>` : '';
            if (typeof c.value === 'string') {
              shared.push(c.value);
              return `<c r="${c.ref}" t="s"${sAttr}>${fXml}<v>${shared.length - 1}</v></c>`;
            }
            if (typeof c.value === 'number') {
              return `<c r="${c.ref}"${sAttr}>${fXml}<v>${c.value}</v></c>`;
            }
            return `<c r="${c.ref}"${sAttr}>${fXml}</c>`;
          })
          .join('');
        return `<row r="${row.r}">${cellXml}</row>`;
      })
      .join('');
    const mergeXml =
      sheet.merges && sheet.merges.length > 0
        ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
        : '';
    files[`xl/worksheets/sheet${idx + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData>${mergeXml}</worksheet>`,
    );
    if (sheet.comments && sheet.comments.length > 0) {
      const authors = [...new Set(sheet.comments.map((c) => c.author))];
      files[`xl/worksheets/_rels/sheet${idx + 1}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments${idx + 1}.xml"/></Relationships>`,
      );
      files[`xl/comments${idx + 1}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<authors>${authors.map((a) => `<author>${xmlEscape(a)}</author>`).join('')}</authors>` +
          `<commentList>${sheet.comments
            .map(
              (c) =>
                `<comment ref="${c.ref}" authorId="${authors.indexOf(c.author)}"><text><r><t>${xmlEscape(c.text)}</t></r></text></comment>`,
            )
            .join('')}</commentList></comments>`,
      );
    }
  });

  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      sheets
        .map(
          (s, i) =>
            `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`,
        )
        .join('') +
      '</sheets></workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
      shared.map((s) => `<si><t>${xmlEscape(s)}</t></si>`).join('') +
      '</sst>',
  );
  return Buffer.from(zipSync(files));
}

export function makePptx(slides: string[][]): Buffer {
  const files: Record<string, Uint8Array> = { '[Content_Types].xml': strToU8(CONTENT_TYPES('')) };
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>` +
        paras.map((t) => `<a:p><a:r><a:t>${xmlEscape(t)}</a:t></w:r></a:p>`.replace('</w:r>', '</a:r>')).join('') +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
  });
  return Buffer.from(zipSync(files));
}

export interface RichPptxSlide {
  paragraphs?: string[];
  /** Use `<a:p algn="l">` with attributes on paragraphs. */
  paraAttrs?: boolean;
  table?: string[][];
  notes?: string;
  hidden?: boolean;
  chart?: { title: string; series: string[] };
}

/** PA-139: builds a pptx with explicit `sldIdLst` ordering, hidden slides, `<a:p ...>` attributes, tables, speaker notes, and charts. */
export function makeRichPptx(slides: RichPptxSlide[], order?: number[]): Buffer {
  const files: Record<string, Uint8Array> = { '[Content_Types].xml': strToU8(CONTENT_TYPES('')) };
  slides.forEach((slide, idx) => {
    const num = idx + 1;
    const pOpen = slide.paraAttrs ? '<a:p algn="l">' : '<a:p>';
    const textXml = (slide.paragraphs ?? [])
      .map((t) => `${pOpen}<a:r><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`)
      .join('');
    const tblXml =
      slide.table && slide.table.length > 0
        ? `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
          slide.table
            .map(
              (row) =>
                `<a:tr>${row
                  .map((cell) => `<a:tc><a:txBody>${pOpen}<a:r><a:t>${xmlEscape(cell)}</a:t></a:r></a:p></a:txBody></a:tc>`)
                  .join('')}</a:tr>`,
            )
            .join('') +
          `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
        : '';
    files[`ppt/slides/slide${num}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld${slide.hidden ? ' show="0"' : ''} xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${textXml}</p:txBody></p:sp>${tblXml}</p:spTree></p:cSld></p:sld>`,
    );

    const slideRels: string[] = [];
    if (slide.notes) {
      slideRels.push(
        `<Relationship Id="rIdNotes1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${num}.xml"/>`,
      );
      files[`ppt/notesSlides/notesSlide${num}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p algn="l"><a:r><a:t>${xmlEscape(slide.notes)}</a:t></a:r></a:p></p:txBody></p:sp>` +
          `<p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${num}</a:t></a:r></a:p></p:txBody></p:sp>` +
          `</p:spTree></p:cSld></p:notes>`,
      );
    }
    if (slide.chart) {
      slideRels.push(
        `<Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${num}.xml"/>`,
      );
      files[`ppt/charts/chart${num}.xml`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>` +
          `<c:title><c:tx><c:rich><a:p><a:r><a:t>${xmlEscape(slide.chart.title)}</a:t></a:r></a:p></c:rich></c:tx></c:title>` +
          `<c:plotArea><c:barChart>${slide.chart.series
            .map((s) => `<c:ser><c:tx><c:v>${xmlEscape(s)}</c:v></c:tx></c:ser>`)
            .join('')}</c:barChart></c:plotArea></c:chart></c:chartSpace>`,
      );
    }
    if (slideRels.length > 0) {
      files[`ppt/slides/_rels/slide${num}.xml.rels`] = strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels.join('')}</Relationships>`,
      );
    }
  });

  const slideOrder = order ?? slides.map((_, i) => i + 1);
  files['ppt/presentation.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>` +
      slideOrder.map((slideNum, i) => `<p:sldId id="${256 + i}" r:id="rId${slideNum}"/>`).join('') +
      `</p:sldIdLst></p:presentation>`,
  );
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      slides
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
        )
        .join('') +
      `</Relationships>`,
  );
  return Buffer.from(zipSync(files));
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
