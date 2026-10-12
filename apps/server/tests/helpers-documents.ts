import zlib from 'node:zlib';
import { strToU8, zipSync } from 'fflate';

/**
 * PA-137: tiny but real documents, built in memory, so the extraction suites
 * need no binary fixtures in the repo.
 */

/** A valid PDF with one page per string, each drawn with the base-14 Helvetica. */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1: catalog, 2: pages, 3: font, then a page + content stream per page.
  const fontId = 3;
  let next = 4;
  const bodies: Record<number, string> = {};
  for (const text of pages) {
    const pageId = next++;
    const contentId = next++;
    pageIds.push(pageId);
    const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`;
    bodies[contentId] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  }
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  bodies[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < next; id++) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${bodies[id]}\nendobj\n`;
    objects.push(String(id));
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
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

export function makeDocx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(p)}</w:t></w:r></w:p>`).join('');
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        CONTENT_TYPES(
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
        ),
      ),
      '_rels/.rels': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      'word/document.xml': strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    }),
  );
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
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
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

export function makePptx(slides: string[][]): Buffer {
  const files: Record<string, Uint8Array> = { '[Content_Types].xml': strToU8(CONTENT_TYPES('')) };
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>` +
        paras.map((t) => `<a:p><a:r><a:t>${xmlEscape(t)}</a:t></a:r></a:p>`).join('') +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    );
  });
  return Buffer.from(zipSync(files));
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
