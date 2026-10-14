import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shiftFormulaReferences } from '../src/sheets/sheet-worker.js';
import {
  executeSheetCheck,
  executeSheetEdit,
  executeSheetFind,
  executeSheetInfo,
  executeSheetRead,
  previewSheetEdit,
} from '../src/sheets/runner.js';
import {
  PARALLEL_SAFE_TOOLS,
  PLANNER_TOOLS,
  findPlannerTool,
  prepareSheetEditApproval,
} from '../src/planner/tools.js';
import { formatApprovalInput } from '../src/telegram/bridge.js';
import { buildHostCapabilities } from '../src/routes/capabilities.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

function readZip(buf: Buffer): Map<string, Buffer> {
  const raw = unzipSync(new Uint8Array(buf));
  const map = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(raw)) {
    map.set(k, Buffer.from(v));
  }
  return map;
}

// ---- Zip / OOXML Fixture Builder --------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZipBuffer(entries: Record<string, Buffer | string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const names = Object.keys(entries);

  for (const name of names) {
    const rawContent = entries[name]!;
    const uncompressed = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent, 'utf8');
    const compressed = zlib.deflateRawSync(uncompressed);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(uncompressed);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    localParts.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * Builds a rich `.xlsm` fixture containing:
 * - 3 sheets: `Summary` (visible), `Data` (visible), `Audit` (`veryHidden`)
 * - Shared strings, custom number formats (`$#,##0.00`, `0.0%`, `yyyy-mm-dd`)
 * - Shared formulas (`t="shared"` on `Data!C2:C4`), array formulas (`t="array"` on `Summary!E2:E3`),
 *   dynamic array cell (`cm="1"` on `Summary!F2`), error cell (`#DIV/0!` on `Summary!D2`),
 *   and stale cached formula (`Summary!B12` cached as `8400` for `=SUM(Data!C2:C4)`)
 * - Defined names (`TaxRate`, `_xlnm.Print_Area`)
 * - Table (`xl/tables/table1.xml`, `SalesTable` on `Data!A1:C4`)
 * - Chart (`xl/charts/chart1.xml` linked via `xl/drawings/drawing1.xml` on `Summary`)
 * - Pivot table (`xl/pivotTables/pivotTable1.xml` + `xl/pivotCache/pivotCacheDefinition1.xml`)
 * - Data validations, conditional formatting, merged cells, and cell comments
 * - Binary `xl/vbaProject.bin` and external link (`xl/externalLinks/externalLink1.xml`)
 * - `mc:Ignorable="x14ac xr"` and `xr:uid` attributes to verify byte-exact in-place patching
 */
function buildRichWorkbookEntries(): Record<string, Buffer | string> {
  const vbaBytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0xde, 0xad, 0xbe, 0xef]);

  return {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
      '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' +
      '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' +
      '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' +
      '<Override PartName="/xl/pivotTables/pivotTable1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml"/>' +
      '<Override PartName="/xl/pivotCache/pivotCacheDefinition1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml"/>' +
      '</Types>',

    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr defaultThemeVersion="166925"/>' +
      '<sheets>' +
      '<sheet name="Summary" sheetId="1" r:id="rId1"/>' +
      '<sheet name="Data" sheetId="2" r:id="rId2"/>' +
      '<sheet name="Audit" sheetId="3" state="veryHidden" r:id="rId3"/>' +
      '</sheets>' +
      '<definedNames>' +
      '<definedName name="TaxRate">Summary!$B$2</definedName>' +
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Summary!$A$1:$F$12</definedName>' +
      '</definedNames>' +
      '<calcPr calcId="191029"/>' +
      '</workbook>',

    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
      '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
      '<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' +
      '<Relationship Id="rId7" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/>' +
      '<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink" Target="externalLinks/externalLink1.xml"/>' +
      '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="pivotCache/pivotCacheDefinition1.xml"/>' +
      '</Relationships>',

    'xl/styles.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2">' +
      '<numFmt numFmtId="164" formatCode="$#,##0.00"/>' +
      '<numFmt numFmtId="165" formatCode="yyyy-mm-dd"/>' +
      '</numFmts>' +
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '</styleSheet>',

    'xl/sharedStrings.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6">' +
      '<si><t>Revenue Summary</t></si>' +
      '<si><t>Region</t></si>' +
      '<si><t>Base</t></si>' +
      '<si><t>Total</t></si>' +
      '<si><t>North</t></si>' +
      '<si><t>South</t></si>' +
      '</sst>',

    'xl/calcChain.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<c r="B7" i="1"/><c r="B12" i="1"/>' +
      '</calcChain>',

    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
      'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" ' +
      'xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" ' +
      'mc:Ignorable="x14ac xr">' +
      '<sheetPr codeName="Sheet1"/>' +
      '<dimension ref="A1:F12"/>' +
      '<sheetData>' +
      '<row r="1" xr:uid="{00000001-0001-0001-0001-000000000001}">' +
      '<c r="A1" t="s"><v>0</v></c>' +
      '</row>' +
      '<row r="2" xr:uid="{00000001-0001-0001-0001-000000000002}">' +
      '<c r="B2" s="2"><v>0.075</v></c>' +
      '<c r="D2" t="e"><f>1/0</f><v>#DIV/0!</v></c>' +
      '<c r="E2"><f t="array" ref="E2:E3">Data!B2:B3*2</f><v>200</v></c>' +
      '<c r="F2" cm="1"><f>UNIQUE(Data!A2:A4)</f><v>North</v></c>' +
      '</row>' +
      '<row r="3" xr:uid="{00000001-0001-0001-0001-000000000003}">' +
      '<c r="E3"><v>400</v></c>' +
      '</row>' +
      '<row r="7" xr:uid="{00000001-0001-0001-0001-000000000007}">' +
      '<c r="B7" s="1"><f>SUM(B2:B6)</f><v>1234.5</v></c>' +
      '</row>' +
      '<row r="12" xr:uid="{00000001-0001-0001-0001-000000000012}">' +
      '<c r="B12" s="1"><f>SUM(Data!C2:C4)</f><v>8400</v></c>' +
      '</row>' +
      '</sheetData>' +
      '<mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells>' +
      '<conditionalFormatting sqref="B7:B12"><cfRule type="cellIs" priority="1" operator="greaterThan"><formula>1000</formula></cfRule></conditionalFormatting>' +
      '<dataValidations count="1"><dataValidation type="list" sqref="B2"><formula1>"0.05,0.075,0.10"</formula1></dataValidation></dataValidations>' +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      '<drawing r:id="rId1"/>' +
      '</worksheet>',

    'xl/worksheets/_rels/sheet1.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/>' +
      '</Relationships>',

    'xl/worksheets/sheet2.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<dimension ref="A1:C4"/>' +
      '<sheetData>' +
      '<row r="1">' +
      '<c r="A1" t="s"><v>1</v></c>' +
      '<c r="B1" t="s"><v>2</v></c>' +
      '<c r="C1" t="s"><v>3</v></c>' +
      '</row>' +
      '<row r="2">' +
      '<c r="A2" t="s"><v>4</v></c>' +
      '<c r="B2"><v>1000</v></c>' +
      '<c r="C2" s="1"><f t="shared" ref="C2:C4" si="0">B2*2</f><v>2000</v></c>' +
      '</row>' +
      '<row r="3">' +
      '<c r="A3" t="s"><v>5</v></c>' +
      '<c r="B3"><v>2500</v></c>' +
      '<c r="C3" s="1"><f t="shared" si="0"/><v>5000</v></c>' +
      '</row>' +
      '<row r="4">' +
      '<c r="A4" t="s"><v>4</v></c>' +
      '<c r="B4"><v>700</v></c>' +
      '<c r="C4" s="1"><f t="shared" si="0"/><v>1200</v></c>' +
      '</row>' +
      '</sheetData>' +
      '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' +
      '</worksheet>',

    'xl/worksheets/_rels/sheet2.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/>' +
      '</Relationships>',

    'xl/worksheets/sheet3.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<dimension ref="A1:A1"/>' +
      '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>secret</t></is></c></row></sheetData>' +
      '</worksheet>',

    'xl/tables/table1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="SalesTable" displayName="SalesTable" ref="A1:C4" totalsRowCount="0">' +
      '<autoFilter ref="A1:C4"/>' +
      '<tableColumns count="3">' +
      '<tableColumn id="1" name="Region"/>' +
      '<tableColumn id="2" name="Base"/>' +
      '<tableColumn id="3" name="Total"/>' +
      '</tableColumns>' +
      '</table>',

    'xl/drawings/drawing1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<xdr:twoCellAnchor><xdr:graphicFrame><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:graphicData><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId1"/></a:graphicData>' +
      '</a:graphic></xdr:graphicFrame></xdr:twoCellAnchor>' +
      '</xdr:wsDr>',

    'xl/drawings/_rels/drawing1.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>' +
      '</Relationships>',

    'xl/charts/chart1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
      '<c:chart><c:title><c:tx><c:v>Regional Totals</c:v></c:tx></c:title>' +
      '<c:plotArea><c:barChart><c:ser>' +
      '<c:cat><c:strRef><c:f>Data!$A$2:$A$4</c:f></c:strRef></c:cat>' +
      '<c:val><c:numRef><c:f>Data!$C$2:$C$4</c:f></c:numRef></c:val>' +
      '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',

    'xl/pivotTables/pivotTable1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="RegionPivot" cacheId="10">' +
      '<location ref="H2:I6" firstHeaderRow="1" firstDataRow="2" firstDataCol="1"/>' +
      '</pivotTableDefinition>',

    'xl/pivotTables/_rels/pivotTable1.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/>' +
      '</Relationships>',

    'xl/pivotCache/pivotCacheDefinition1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<cacheSource type="worksheet"><worksheetSource ref="A1:C4" sheet="Data"/></cacheSource>' +
      '</pivotCacheDefinition>',

    'xl/comments1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<commentList><comment ref="B7" authorId="0"><text><t>Check Q4 adjustments</t></text></comment></commentList>' +
      '</comments>',

    'xl/vbaProject.bin': vbaBytes,

    'xl/externalLinks/externalLink1.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>',
  };
}

describe('PA-140: Pocket Agent spreadsheet tools', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-140-sheets-'));
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('shiftFormulaReferences', () => {
    it('shifts relative cell references while preserving absolute markers, sheet names, strings, and function names', () => {
      expect(shiftFormulaReferences('A2+$B$1+$C2+D$2', 2, 1)).toBe('B4+$B$1+$C4+E$2');
      expect(shiftFormulaReferences('SUM(Q1!A2:B3, \'Q2 Data\'!$C$1:C2)', 1, 0)).toBe(
        'SUM(Q1!A3:B4, \'Q2 Data\'!$C$1:C3)',
      );
      expect(shiftFormulaReferences('IF(A2="B2", LOG10(C2), SalesTable[Total])', 3, 2)).toBe(
        'IF(C5="B2", LOG10(E5), SalesTable[Total])',
      );
    });
  });

  describe('sheet_info', () => {
    it('maps sheets (including hidden/veryHidden), defined names, tables, charts, pivots, validations, conditional formatting, macros, and external links', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const res = await executeSheetInfo(wbPath);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('Macros (vbaProject.bin): present');
      expect(res.text).toContain('External links: xl/externalLinks/externalLink1.xml');
      expect(res.text).toContain('- Summary: range A1:F12');
      expect(res.text).toContain('- Data: range A1:C4');
      expect(res.text).toContain('- Audit [veryHidden]: range A1:A1');
      expect(res.text).toContain('TaxRate: Summary!$B$2');
      expect(res.text).toContain('_xlnm.Print_Area (scope: Summary): Summary!$A$1:$F$12');
      expect(res.text).toContain('SalesTable on Data!A1:C4 (4 rows): columns [Region, Base, Total]');
      expect(res.text).toContain('Summary "Regional Totals" (xl/charts/chart1.xml)');
      expect(res.text).toContain('values=Data!$C$2:$C$4');
      expect(res.text).toContain('RegionPivot on Summary!H2:I6: source Data!A1:C4');
      expect(res.text).toContain('Summary!B2: type=list');
      expect(res.text).toContain('Summary!B7:B12: cellIs(greaterThan): 1000');
    });
  });

  describe('sheet_read', () => {
    it('reads cached values, expanded shared formulas, number formats, formatted values, merges, and comments', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const summaryRes = await executeSheetRead(wbPath, 'Summary', 'A1:F12');
      expect(summaryRes.ok).toBe(true);
      if (!summaryRes.ok) return;
      expect(summaryRes.text).toContain('A1: value="Revenue Summary"');
      expect(summaryRes.text).toContain('B2: value=0.075 formatted="7.50%" numFmt="0.00%"');
      expect(summaryRes.text).toContain('B7: value=1234.5 formatted="$1,234.50" formula="=SUM(B2:B6)" numFmt="$#,##0.00"');
      expect(summaryRes.text).toContain('D2: value="#DIV/0!" formula="=1/0"');
      expect(summaryRes.text).toContain('E2: value=200 formula="=Data!B2:B3*2" (array)');
      expect(summaryRes.text).toContain('Merged ranges: A1:C1');
      expect(summaryRes.text).toContain('Comment B7: Check Q4 adjustments');

      // Verify shared formulas on Data!C2:C4 are expanded to per-cell formulas
      const dataRes = await executeSheetRead(wbPath, 'Data', 'A1:C4');
      expect(dataRes.ok).toBe(true);
      if (!dataRes.ok) return;
      expect(dataRes.text).toContain('C2: value=2000 formatted="$2,000.00" formula="=B2*2" (shared) numFmt="$#,##0.00"');
      expect(dataRes.text).toContain('C3: value=5000 formatted="$5,000.00" formula="=B3*2" (shared) numFmt="$#,##0.00"');
      expect(dataRes.text).toContain('C4: value=1200 formatted="$1,200.00" formula="=B4*2" (shared) numFmt="$#,##0.00"');
    });

    it('supports paging and the include filter', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const formulasOnly = await executeSheetRead(wbPath, 'Data', 'C2:C3', ['formulas']);
      expect(formulasOnly.ok).toBe(true);
      if (!formulasOnly.ok) return;
      expect(formulasOnly.text).toContain('C2: formula="=B2*2" (shared)');
      expect(formulasOnly.text).toContain('C3: formula="=B3*2" (shared)');
      expect(formulasOnly.text).not.toContain('$2,000.00');
    });
  });

  describe('sheet_find', () => {
    it('finds matching substrings across sheets in values and expanded formulas', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const formulaHits = await executeSheetFind(wbPath, 'B4*2', 'formulas');
      expect(formulaHits.ok).toBe(true);
      if (!formulaHits.ok) return;
      // Matches Data!C4 whose shared formula follower expands to `=B4*2`
      expect(formulaHits.text).toContain('Data!C4');
      expect(formulaHits.text).toContain('[formula: =B4*2]');

      const valueHits = await executeSheetFind(wbPath, 'South', 'values');
      expect(valueHits.ok).toBe(true);
      if (!valueHits.ok) return;
      expect(valueHits.text).toContain('Data!A3');
    });
  });

  describe('sheet_check', () => {
    it('reports formula errors statically when LibreOffice is absent and never modifies the workbook', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      const originalBytes = buildZipBuffer(buildRichWorkbookEntries());
      fs.writeFileSync(wbPath, originalBytes);

      const res = await executeSheetCheck(wbPath, { libreOfficeBin: null });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('Summary!D2: #DIV/0! (formula: =1/0)');
      expect(res.text).toContain('unavailable — static cached-value scan');
      expect(Buffer.compare(fs.readFileSync(wbPath), originalBytes)).toBe(0);
    });

    it('recalculates a copy via headless LibreOffice and reports both error cells and stale cached values without touching the original file', async () => {
      const wbPath = path.join(tmpDir, 'model.xlsm');
      const originalBytes = buildZipBuffer(buildRichWorkbookEntries());
      fs.writeFileSync(wbPath, originalBytes);

      // Create a fake `soffice` executable that simulates LibreOffice recalculating
      // Data!C4 (700*2 = 1400 instead of stale 1200)
      const recalcedEntries = buildRichWorkbookEntries();
      recalcedEntries['xl/worksheets/sheet2.xml'] = String(recalcedEntries['xl/worksheets/sheet2.xml']).replace(
        '<c r="C4" s="1"><f t="shared" si="0"/><v>1200</v></c>',
        '<c r="C4" s="1"><f>B4*2</f><v>1400</v></c>',
      );
      const recalcedBytes = buildZipBuffer(recalcedEntries);
      const recalcedTemplatePath = path.join(tmpDir, 'recalced-template.xlsx');
      fs.writeFileSync(recalcedTemplatePath, recalcedBytes);

      const fakeSoffice = path.join(tmpDir, 'fake-soffice.sh');
      fs.writeFileSync(
        fakeSoffice,
        `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
cp "${recalcedTemplatePath}" "$outdir/workbook.xlsx"
`,
        { mode: 0o755 },
      );

      const res = await executeSheetCheck(wbPath, { libreOfficeBin: fakeSoffice });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('recalculation: LibreOffice headless');
      expect(res.text).toContain('Summary!D2: #DIV/0! (formula: =1/0)');
      expect(res.text).toContain('Stale cached values (1):');
      expect(res.text).toContain('Data!C4 (=B4*2): cached 1200 != recalculated 1400');
      // Original file on disk must be untouched byte-for-byte
      expect(Buffer.compare(fs.readFileSync(wbPath), originalBytes)).toBe(0);
    });
  });

  describe('sheet_edit (in-place patching, fidelity, and safety rules)', () => {
    it('patches cells in place while keeping untouched zip entries and untouched XML spans byte-for-byte identical', async () => {
      const wbPath = path.join(tmpDir, 'input.xlsm');
      const outPath = path.join(tmpDir, 'output.xlsm');
      const originalEntries = buildRichWorkbookEntries();
      const originalBytes = buildZipBuffer(originalEntries);
      fs.writeFileSync(wbPath, originalBytes);

      const edits = [
        { sheet: 'Summary', cell: 'B7', formula: '=SUM(B2:B8)' },
        { sheet: 'Summary', cell: 'A2', value: 'Adjusted Label' },
      ];

      const preview = await previewSheetEdit(wbPath, outPath, edits);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.diff?.before).toBe('Summary!B7: =SUM(B2:B6)\nSummary!A2: (empty)');
      expect(preview.diff?.after).toBe('Summary!B7: =SUM(B2:B8)\nSummary!A2: "Adjusted Label"');

      const res = await executeSheetEdit(wbPath, outPath, 'output.xlsm', edits, { libreOfficeBin: null });
      expect(res.ok).toBe(true);
      expect(fs.existsSync(outPath)).toBe(true);
      // Input file is untouched
      expect(Buffer.compare(fs.readFileSync(wbPath), originalBytes)).toBe(0);

      const inZip = readZip(originalBytes);
      const outZip = readZip(fs.readFileSync(outPath));

      // Every untouched zip entry must be byte-for-byte identical
      for (const untouchedName of [
        'xl/vbaProject.bin',
        'xl/charts/chart1.xml',
        'xl/drawings/drawing1.xml',
        'xl/pivotTables/pivotTable1.xml',
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'xl/worksheets/sheet2.xml',
        'xl/worksheets/sheet3.xml',
      ]) {
        const beforeEntry = inZip.get(untouchedName)!;
        const afterEntry = outZip.get(untouchedName)!;
        expect(afterEntry, `entry ${untouchedName} missing`).toBeDefined();
        expect(Buffer.compare(beforeEntry, afterEntry), `entry ${untouchedName} bytes changed`).toBe(0);
      }

      // calcChain.xml is removed because a formula changed, and workbook.xml has fullCalcOnLoad="1"
      expect(outZip.has('xl/calcChain.xml')).toBe(false);
      expect(outZip.get('xl/workbook.xml')!.toString('utf8')).toContain('fullCalcOnLoad="1"');

      // Inspect sheet1.xml to verify mc:Ignorable, xr:uid, and untouched elements are preserved verbatim
      const sheet1Xml = outZip.get('xl/worksheets/sheet1.xml')!.toString('utf8');
      expect(sheet1Xml).toContain('mc:Ignorable="x14ac xr"');
      expect(sheet1Xml).toContain('xr:uid="{00000001-0001-0001-0001-000000000007}"');
      expect(sheet1Xml).toContain('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
      // String edit written as inlineStr so sharedStrings.xml is untouched
      expect(sheet1Xml).toContain('<c r="A2" t="inlineStr"><is><t>Adjusted Label</t></is></c>');
      // Formula edit without LibreOffice omits <v> so Excel recalculates on open
      expect(sheet1Xml).toContain('<c r="B7" s="1"><f>SUM(B2:B8)</f></c>');
    });

    it('expands a touched shared-formula group so editing one cell in the group never corrupts followers', async () => {
      const wbPath = path.join(tmpDir, 'shared.xlsm');
      const outPath = path.join(tmpDir, 'shared-edited.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      // Data!C2 is the master of shared formula group si="0" (C2:C4), with C3 and C4 as followers.
      // Editing C2 to a constant 9999 must expand C3 (`=B3*2`) and C4 (`=B4*2`) to standalone formulas.
      const res = await executeSheetEdit(
        wbPath,
        outPath,
        'shared-edited.xlsm',
        [{ sheet: 'Data', cell: 'C2', value: 9999 }],
        { libreOfficeBin: null },
      );
      expect(res.ok).toBe(true);

      const readAfter = await executeSheetRead(outPath, 'Data', 'C2:C4');
      expect(readAfter.ok).toBe(true);
      if (!readAfter.ok) return;
      expect(readAfter.text).toContain('C2: value=9999 formatted="$9,999.00" numFmt="$#,##0.00"');
      expect(readAfter.text).toContain('C3: value=5000 formatted="$5,000.00" formula="=B3*2" numFmt="$#,##0.00"');
      expect(readAfter.text).toContain('C4: value=1200 formatted="$1,200.00" formula="=B4*2" numFmt="$#,##0.00"');

      const outSheet2 = readZip(fs.readFileSync(outPath)).get('xl/worksheets/sheet2.xml')!.toString('utf8');
      expect(outSheet2).not.toContain('t="shared"');
    });

    it('back-patches recalculated formula values and reports downstream changes when LibreOffice is available', async () => {
      const wbPath = path.join(tmpDir, 'recalc-in.xlsm');
      const outPath = path.join(tmpDir, 'recalc-out.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      // Simulate LibreOffice recalculating Data!C4 = 1350 and downstream Summary!B12 = 8550
      const recalcedEntries = buildRichWorkbookEntries();
      recalcedEntries['xl/worksheets/sheet2.xml'] = String(recalcedEntries['xl/worksheets/sheet2.xml']).replace(
        '<c r="B4"><v>700</v></c><c r="C4" s="1"><f t="shared" si="0"/><v>1200</v></c>',
        '<c r="B4"><v>675</v></c><c r="C4" s="1"><f>B4*2</f><v>1350</v></c>',
      );
      recalcedEntries['xl/worksheets/sheet1.xml'] = String(recalcedEntries['xl/worksheets/sheet1.xml']).replace(
        '<c r="B12" s="1"><f>SUM(Data!C2:C4)</f><v>8400</v></c>',
        '<c r="B12" s="1"><f>SUM(Data!C2:C4)</f><v>8550</v></c>',
      );
      const recalcedTemplatePath = path.join(tmpDir, 'recalced-edit.xlsx');
      fs.writeFileSync(recalcedTemplatePath, buildZipBuffer(recalcedEntries));

      const fakeSoffice = path.join(tmpDir, 'fake-soffice-edit.sh');
      fs.writeFileSync(
        fakeSoffice,
        `#!/bin/sh
outdir=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--outdir" ]; then
    shift
    outdir="$1"
  fi
  shift
done
cp "${recalcedTemplatePath}" "$outdir/workbook.xlsx"
`,
        { mode: 0o755 },
      );

      const res = await executeSheetEdit(
        wbPath,
        outPath,
        'recalc-out.xlsm',
        [{ sheet: 'Data', cell: 'B4', value: 675 }],
        { libreOfficeBin: fakeSoffice },
      );
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('Downstream formula changes');
      expect(res.text).toContain('Summary!B12 (=SUM(Data!C2:C4)): $8,400.00 → $8,550.00');
      expect(res.text).toContain('Data!C4 (=B4*2): $1,200.00 → $1,350.00');

      // And vbaProject.bin + chart1.xml in outPath are still byte-for-byte identical to input!
      const inZip = readZip(fs.readFileSync(wbPath));
      const outZip = readZip(fs.readFileSync(outPath));
      expect(Buffer.compare(inZip.get('xl/vbaProject.bin')!, outZip.get('xl/vbaProject.bin')!)).toBe(0);
      expect(Buffer.compare(inZip.get('xl/charts/chart1.xml')!, outZip.get('xl/charts/chart1.xml')!)).toBe(0);
    });

    it('supports append_table_rows and add_sheet structural operations', async () => {
      const wbPath = path.join(tmpDir, 'struct.xlsm');
      const outPath = path.join(tmpDir, 'struct-out.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const res = await executeSheetEdit(
        wbPath,
        outPath,
        'struct-out.xlsm',
        [
          {
            op: 'append_table_rows',
            table: 'SalesTable',
            rows: [
              ['West', 1500, '=B5*2'],
              { Region: 'East', Base: 900, Total: '=B6*2' },
            ],
          },
          {
            op: 'add_sheet',
            name: 'Notes',
          },
          {
            sheet: 'Notes',
            cell: 'A1',
            value: 'Created by Pocket Agent',
          },
        ],
        { libreOfficeBin: null },
      );
      expect(res.ok).toBe(true);

      const infoRes = await executeSheetInfo(outPath);
      expect(infoRes.ok).toBe(true);
      if (!infoRes.ok) return;
      expect(infoRes.text).toContain('SalesTable on Data!A1:C6 (6 rows)');
      expect(infoRes.text).toContain('- Notes:');

      const dataRes = await executeSheetRead(outPath, 'Data', 'A5:C6');
      expect(dataRes.ok).toBe(true);
      if (!dataRes.ok) return;
      expect(dataRes.text).toContain('A5: value="West"');
      expect(dataRes.text).toContain('B5: value=1500');
      expect(dataRes.text).toContain('C5: value=(empty) formula="=B5*2"');
      expect(dataRes.text).toContain('A6: value="East"');

      const notesRes = await executeSheetRead(outPath, 'Notes', 'A1:A1');
      expect(notesRes.ok).toBe(true);
      if (!notesRes.ok) return;
      expect(notesRes.text).toContain('A1: value="Created by Pocket Agent"');
    });

    it('refuses array formulas, dynamic arrays, row/column insertions, and overwriting an existing outputPath', async () => {
      const wbPath = path.join(tmpDir, 'refuse.xlsm');
      const existingOut = path.join(tmpDir, 'existing.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));
      fs.writeFileSync(existingOut, 'already here');

      // 1. Existing outputPath
      const existingRes = await executeSheetEdit(
        wbPath,
        existingOut,
        'existing.xlsm',
        [{ sheet: 'Summary', cell: 'B7', value: 1 }],
      );
      expect(existingRes.ok).toBe(false);
      if (!existingRes.ok) expect(existingRes.error).toMatch(/Refusing to overwrite/i);

      // 2. Array formula range (Summary!E2:E3)
      const arrayRes = await previewSheetEdit(wbPath, path.join(tmpDir, 'out1.xlsm'), [
        { sheet: 'Summary', cell: 'E3', value: 10 },
      ]);
      expect(arrayRes.ok).toBe(false);
      if (!arrayRes.ok) expect(arrayRes.error).toMatch(/array formula/i);

      // 3. Dynamic array cell (Summary!F2 has cm="1")
      const dynRes = await previewSheetEdit(wbPath, path.join(tmpDir, 'out2.xlsm'), [
        { sheet: 'Summary', cell: 'F2', value: 'x' },
      ]);
      expect(dynRes.ok).toBe(false);
      if (!dynRes.ok) expect(dynRes.error).toMatch(/dynamic/i);

      // 4. Row insertion op
      const insertRes = await previewSheetEdit(wbPath, path.join(tmpDir, 'out3.xlsm'), [
        { op: 'insert_rows' as never, sheet: 'Data', row: 2 } as never,
      ]);
      expect(insertRes.ok).toBe(false);
      if (!insertRes.ok) expect(insertRes.error).toMatch(/insert_rows/);
    });
  });

  describe('Security & Sandbox Posture', () => {
    it('refuses XML containing DOCTYPE or ENTITY declarations', async () => {
      const entries = buildRichWorkbookEntries();
      entries['xl/workbook.xml'] =
        '<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY xxe "boom">]>' + String(entries['xl/workbook.xml']);
      const wbPath = path.join(tmpDir, 'xxe.xlsx');
      fs.writeFileSync(wbPath, buildZipBuffer(entries));

      const res = await executeSheetInfo(wbPath);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toMatch(/DOCTYPE|ENTITY/i);
      }
    });
  });

  describe('Planner tool integration, approval diffs, and host capabilities', () => {
    let t: TestApp | null = null;

    afterEach(async () => {
      if (t) {
        await t.cleanup();
        t = null;
      }
    });

    it('registers sheet_info, sheet_read, sheet_find, sheet_check as parallel-safe read-only tools and sheet_edit as gated', () => {
      for (const name of ['sheet_info', 'sheet_read', 'sheet_find', 'sheet_check']) {
        const tool = findPlannerTool(name);
        expect(tool, `${name} should be registered`).toBeDefined();
        expect(tool!.readOnly).toBe(true);
        expect(PARALLEL_SAFE_TOOLS.has(name)).toBe(true);
      }
      const editTool = findPlannerTool('sheet_edit');
      expect(editTool).toBeDefined();
      expect(editTool!.readOnly).toBe(false);
      expect(PARALLEL_SAFE_TOOLS.has('sheet_edit')).toBe(false);
      expect(PLANNER_TOOLS.some((p) => p.name === 'sheet_edit')).toBe(true);
    });

    it('computes cell-level approval diffs and formats them for Telegram <pre>', async () => {
      t = await createTestApp({ POCKETAGENT_WORKSPACE_ROOTS: tmpDir });
      const wbPath = path.join(tmpDir, 'budget.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      const deps = {
        workspaces: t.context.workspaces,
        plannerWorkspaces: t.context.plannerWorkspaces,
        sessions: t.context.sessions,
        worktrees: t.context.worktrees,
        historyDeps: t.context.historyDeps,
        shell: '/bin/sh',
        memory: t.context.plannerMemory,
        mcpRegistry: t.context.mcpRegistry,
        skills: t.context.skills,
        workspaceId: null,
        workspacePath: tmpDir,
        commandTimeoutSeconds: 30,
        webSearch: { enabled: false, baseUrl: '', apiKey: null },
        urlFetch: { enabled: false, baseUrl: '', apiKey: null },
        agents: t.context.agents,
        db: t.db,
        config: t.context.config,
        customClaudeProviders: t.context.customClaudeProviders,
        telegramBots: null,
        webhooks: null,
        cron: null,
        subagents: {} as never,
        spawnDepth: 0,
        maxSubagentSpawnsPerTurn: 3,
        plannerChatId: 'chat-1',
        telegram: { links: [], send: async () => ({ ok: true }) },
      };

      const prep = await prepareSheetEditApproval(deps, {
        path: 'budget.xlsm',
        outputPath: 'budget-next.xlsm',
        edits: [
          { sheet: 'Summary', cell: 'B7', formula: '=SUM(B2:B8)' },
          { sheet: 'Data', cell: 'B2', value: 1350 },
        ],
      });
      expect(prep.ok).toBe(true);
      if (!prep.ok) return;

      const tgText = formatApprovalInput({
        toolName: 'sheet_edit',
        filePath: 'budget.xlsm → budget-next.xlsm',
        input: {
          path: 'budget.xlsm',
          outputPath: 'budget-next.xlsm',
          edits: [],
          _diff: prep.diff,
        },
      });
      expect(tgText).toBe(
        [
          'budget.xlsm → budget-next.xlsm',
          'Summary!B7: =SUM(B2:B6) → =SUM(B2:B8)',
          'Data!B2: 1000 → 1350',
        ].join('\n'),
      );

      // Refuses when outputPath already exists before prompting for approval
      const badPrep = await prepareSheetEditApproval(deps, {
        path: 'budget.xlsm',
        outputPath: 'budget.xlsm',
        edits: [{ sheet: 'Summary', cell: 'B7', value: 1 }],
      });
      expect(badPrep.ok).toBe(false);
    });

    it('reports libreoffice in HostCapabilities.executables when soffice or libreoffice is on PATH', async () => {
      t = await createTestApp();
      const binDir = path.join(tmpDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, 'soffice'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const card = await buildHostCapabilities(t.context, {
        platform: 'linux',
        arch: 'x64',
        osVersion: '6.8.0',
        searchDirs: [binDir],
      });
      expect(card.executables).toContain('libreoffice');
    });

    it('gates sheet_edit in a PlannerChatService turn: fails invalid edits before approval, emits _diff and path → outputPath on valid edits, writes outputPath on allow_once, and strips _diff from subsequent LLM history', async () => {
      const sseResponse = (dataLines: string[]): Response =>
        new Response(dataLines.map((l) => `data: ${l}\n\n`).join('') + 'data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      const fakeToolCallResponse = (name: string, args: Record<string, unknown>, callId = 'call_1'): Response =>
        sseResponse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } }],
                },
              },
            ],
          }),
        ]);
      const fakeCompletionResponse = (content: string): Response =>
        sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);

      const parseEvents = (res: { payload: string }): Array<{ kind: string; [key: string]: unknown }> =>
        res.payload
          .split('\n\n')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .map((c) => JSON.parse(c.replace(/^data: /, '')));

      const fetchImpl = vi.fn();
      t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);

      const wbPath = path.join(t.workspaceRoot, 'budget.xlsm');
      const outPath = path.join(t.workspaceRoot, 'budget-next.xlsm');
      fs.writeFileSync(wbPath, buildZipBuffer(buildRichWorkbookEntries()));

      fetchImpl
        // Round 1: invalid sheet_edit (outputPath already exists == budget.xlsm) -> fails pre-approval without permission_request
        .mockResolvedValueOnce(
          fakeToolCallResponse(
            'sheet_edit',
            {
              path: wbPath,
              outputPath: wbPath,
              edits: [{ sheet: 'Summary', cell: 'B7', formula: '=SUM(B2:B8)' }],
            },
            'call_bad',
          ),
        )
        // Round 2: model corrects outputPath to budget-next.xlsm -> pauses for approval with _diff
        .mockResolvedValueOnce(
          fakeToolCallResponse(
            'sheet_edit',
            {
              path: wbPath,
              outputPath: outPath,
              edits: [
                { sheet: 'Summary', cell: 'B7', formula: '=SUM(B2:B8)' },
                { sheet: 'Data', cell: 'B2', value: 1350 },
              ],
            },
            'call_good',
          ),
        )
        // Round 3: after allow_once, model completes turn
        .mockResolvedValueOnce(fakeCompletionResponse('Updated workbook saved to budget-next.xlsm.'))
        // Turn 2: follow-up message to verify _diff was stripped from tool_calls in LLM history
        .mockResolvedValueOnce(fakeCompletionResponse('All set.'));

      await t.app.inject({
        method: 'PATCH',
        url: '/api/planner/settings',
        headers: authHeaders(t.cookie),
        payload: { baseUrl: 'https://api.example.com' },
      });
      const chat = (
        await t.app.inject({
          method: 'POST',
          url: '/api/planner/chats',
          headers: authHeaders(t.cookie),
          payload: { modelId: 'gpt-4o' },
        })
      ).json();

      const turnRes = await t.app.inject({
        method: 'POST',
        url: `/api/planner/chats/${chat.id}/messages`,
        headers: authHeaders(t.cookie),
        payload: { content: 'update budget' },
      });
      expect(turnRes.statusCode).toBe(200);
      const turnEvents = parseEvents(turnRes);

      // First tool call failed pre-approval (tool_result with isError: true) and second paused on permission_request
      expect(turnEvents.map((e) => e.kind)).toEqual([
        'user_prompt',
        'tool_use',
        'tool_result',
        'tool_use',
        'permission_request',
      ]);
      expect(turnEvents[2]).toMatchObject({ isError: true });
      expect(String(turnEvents[2]?.content)).toMatch(/never overwrites the original workbook|already exists/);

      const permReq = turnEvents[4] as {
        id: string;
        toolName: string;
        filePath?: string;
        input: Record<string, unknown>;
      };
      expect(permReq.toolName).toBe('sheet_edit');
      expect(permReq.filePath).toBe(`${wbPath} → ${outPath}`);
      expect(permReq.input._diff).toEqual({
        before: 'Summary!B7: =SUM(B2:B6)\nData!B2: 1000',
        after: 'Summary!B7: =SUM(B2:B8)\nData!B2: 1350',
        lines: [
          'Summary!B7: =SUM(B2:B6) → =SUM(B2:B8)',
          'Data!B2: 1000 → 1350',
        ],
      });
      expect(fs.existsSync(outPath)).toBe(false);

      // Approve with allow_once
      const approveRes = await t.app.inject({
        method: 'POST',
        url: `/api/planner/chats/${chat.id}/approvals/${permReq.id}`,
        headers: authHeaders(t.cookie),
        payload: { decision: 'allow_once' },
      });
      expect(approveRes.statusCode).toBe(200);
      const resumedEvents = parseEvents(approveRes);
      expect(resumedEvents.map((e) => e.kind)).toEqual([
        'permission_resolved',
        'tool_result',
        'text_delta',
        'text',
        'turn_complete',
      ]);
      expect(fs.existsSync(outPath)).toBe(true);

      // Send a follow-up turn and verify `_diff` was stripped from the assistant's tool_calls in LLM messages
      const turn2Res = await t.app.inject({
        method: 'POST',
        url: `/api/planner/chats/${chat.id}/messages`,
        headers: authHeaders(t.cookie),
        payload: { content: 'thanks' },
      });
      expect(turn2Res.statusCode).toBe(200);
      const fourthCallBody = JSON.parse(fetchImpl.mock.calls[3]![1].body as string);
      expect(JSON.stringify(fourthCallBody.messages)).not.toContain('_diff');
    });
  });
});
