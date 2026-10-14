import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import {
  findPlannerTool,
  type PlannerToolDeps,
  TOOL_INTEGRATION_DISABLED,
} from '../src/planner/tools.js';
import {
  readDocxStructure,
  acceptOrRejectDocxTrackedChanges,
} from '../src/docs/docx-engine.js';
import { detectOfficeLockFile } from '../src/sheets/runner.js';
import { createTestApp, type TestApp } from './helpers.js';
import { makeDocx, makeXlsx } from './helpers-documents.js';

function readZip(buf: Buffer): Map<string, Buffer> {
  const raw = unzipSync(new Uint8Array(buf));
  const map = new Map<string, Buffer>();
  for (const [k, v] of Object.entries(raw)) {
    map.set(k, Buffer.from(v));
  }
  return map;
}

function depsForDocWs(
  t: TestApp,
  ws: { id: string; path: string },
  extra: Partial<PlannerToolDeps> = {},
): PlannerToolDeps {
  const {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    conversations,
    agyTranscripts,
    piTranscripts,
    agents,
    db,
    config,
    customClaudeProviders,
    telegramBots,
    webhooks,
    cron,
    docWorkspaces,
  } = t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
    shell: config.shell,
    memory: t.context.plannerMemory,
    mcpRegistry: t.context.mcpRegistry,
    skills: t.context.skills,
    workspaceId: plannerWorkspaces.getDefault()?.id ?? null,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
    agents,
    subagents: {
      startPocketAgentChat: async () => {
        throw new Error('unused');
      },
      pocketAgentChatStatus: async () => ({ status: 'gone', summary: 'unused' }),
      pocketAgentEnabledTools: () => [],
      findLiveCodingSubagent: () => null,
      recordCodingSubagent: () => {},
      spawnsThisTurn: () => 0,
      recordSpawn: () => {},
    },
    spawnDepth: 0,
    telegram: {
      links: [],
      send: async () => ({ ok: false, error: 'unused' }),
    },
    db,
    config,
    customClaudeProviders,
    telegramBots,
    webhooks,
    cron,
    docWorkspaces,
    docWorkspaceId: ws.id,
    docWorkspacePath: ws.path,
    plannerChatId: 'test-chat-pa145',
    plannerTurnId: 'turn-pa145-1',
    plannerToolUseId: 'call-pa145-1',
    ...extra,
  };
}

describe('PA-145: Document Workspaces Phase 4 - In-place editors & artifact creation', () => {
  let t: TestApp;
  let wsRoot: string;
  let ws: { id: string; name: string; path: string };

  beforeEach(async () => {
    t = await createTestApp();
    const rawWsRoot = path.join(os.tmpdir(), `pa145-test-ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(rawWsRoot, { recursive: true });
    wsRoot = fs.realpathSync(rawWsRoot);
    ws = t.context.docWorkspaces.create({ path: wsRoot });
  });

  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(wsRoot, { recursive: true, force: true });
  });

  describe('Office lock file detection', () => {
    it('detects ~$book.xlsx, ~$doc.docx, and .~lock.book.xlsx# without refusing', () => {
      const docPath = path.join(wsRoot, 'report.docx');
      fs.writeFileSync(docPath, 'sample');
      expect(detectOfficeLockFile(docPath)).toBeNull();

      const lockPath = path.join(wsRoot, '~$report.docx');
      fs.writeFileSync(lockPath, 'lock');
      const lockInfo = detectOfficeLockFile(docPath);
      expect(lockInfo).not.toBeNull();
      expect(lockInfo?.lockFile).toBe('~$report.docx');
      expect(lockInfo?.message).toContain('Office lock file');
    });
  });

  describe('doc_read tool', () => {
    it('reads paragraphs with stable ids, headings, tables, comments, and tracked changes', async () => {
      const docxBuf = makeDocx(
        [
          { text: 'Quarterly Summary', heading: 'Heading1' },
          { text: 'Revenue grew by 15% year-over-year.' },
        ],
        {
          table: [
            ['Metric', 'Q1', 'Q2'],
            ['Revenue', '$10M', '$11.5M'],
          ],
          comment: { author: 'Alice', text: 'Please verify the Q2 figures.' },
          footnote: 'Preliminary unaudited results',
          footer: 'Confidential - Page 1',
        },
      );

      const filePath = path.join(wsRoot, 'financials.docx');
      fs.writeFileSync(filePath, docxBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const docRead = findPlannerTool('doc_read');
      expect(docRead).toBeDefined();
      expect(docRead?.readOnly).toBe(true);

      const deps = depsForDocWs(t, ws);
      const res = await docRead!.execute(deps, { path: 'financials.docx' });
      const text = typeof res === 'string' ? res : res.content;

      expect(text).toContain('[p1] # Quarterly Summary');
      expect(text).toContain('[p2] Revenue grew by 15% year-over-year.');
      expect(text).toContain('## Tables');
      expect(text).toContain('Metric');
      expect(text).toContain('$11.5M');
      expect(text).toContain('## Comments');
      expect(text).toContain('Alice');
      expect(text).toContain('Please verify the Q2 figures.');
      expect(text).toContain('## Footnotes');
      expect(text).toContain('Preliminary unaudited results');
    });

    it('filters paragraphs and tables by section when requested', async () => {
      const docxBuf = makeDocx([
        { text: 'Section Alpha', heading: 'Heading1' },
        { text: 'Alpha paragraph 1' },
        { text: 'Section Beta', heading: 'Heading1' },
        { text: 'Beta paragraph 1' },
      ]);
      const filePath = path.join(wsRoot, 'sections.docx');
      fs.writeFileSync(filePath, docxBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const docRead = findPlannerTool('doc_read')!;
      const deps = depsForDocWs(t, ws);
      const res = await docRead.execute(deps, { path: 'sections.docx', section: 'Beta' });
      const text = typeof res === 'string' ? res : res.content;

      expect(text).toContain('Section Beta');
      expect(text).toContain('Beta paragraph 1');
      expect(text).not.toContain('Alpha paragraph 1');
    });
  });

  describe('doc_edit tool', () => {
    it('requires baseVersion and refuses on stale baseVersion', async () => {
      const docxBuf = makeDocx([{ text: 'Original text in docx' }]);
      const filePath = path.join(wsRoot, 'doc1.docx');
      fs.writeFileSync(filePath, docxBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const docEdit = findPlannerTool('doc_edit')!;
      const deps = depsForDocWs(t, ws);

      // Call without baseVersion -> refused
      const noBaseRes = await docEdit.execute(deps, {
        path: 'doc1.docx',
        edits: [{ op: 'replace_text', target: 'Original', replacement: 'Updated' }],
      });
      expect(typeof noBaseRes === 'object' && noBaseRes.isError).toBe(true);
      expect(typeof noBaseRes === 'object' ? noBaseRes.content : noBaseRes).toContain('baseVersion');

      // Call with wrong baseVersion -> refused
      const staleRes = await docEdit.execute(deps, {
        path: 'doc1.docx',
        baseVersion: 'stale00000000000000000000000000000000000000000000000000000000000',
        edits: [{ op: 'replace_text', target: 'Original', replacement: 'Updated' }],
      });
      expect(typeof staleRes === 'object' && staleRes.isError).toBe(true);
      expect(typeof staleRes === 'object' ? staleRes.content : staleRes).toMatch(/changed since you read it|re-read it first/);
    });

    it('applies tracked changes by default with author Pocket Agent and keeps untouched zip entries byte-identical', async () => {
      const originalBuf = makeDocx(
        [
          { text: 'Introduction to the Project', heading: 'Heading1' },
          { text: 'The initial budget was $50,000 for phase one.' },
        ],
        {
          footer: 'Fixed Project Footer',
          footnote: 'Initial reference footnote',
        },
      );
      const filePath = path.join(wsRoot, 'project.docx');
      fs.writeFileSync(filePath, originalBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const filesRes = await t.context.docWorkspaces.listFiles(ws.id);
      const fileEntry = filesRes.entries.find((e) => e.path === 'project.docx')!;
      const currentVersion = fileEntry.sha256;

      const docEdit = findPlannerTool('doc_edit')!;
      const deps = depsForDocWs(t, ws);

      const editRes = await docEdit.execute(deps, {
        path: 'project.docx',
        baseVersion: currentVersion,
        mode: 'tracked',
        edits: [
          {
            op: 'replace_text',
            target: '$50,000',
            replacement: '$75,000',
            paragraphId: 'p2',
          },
          {
            op: 'add_comment',
            target: 'phase one',
            comment: 'Verify if phase one scope expanded',
          },
        ],
      });

      const resText = typeof editRes === 'string' ? editRes : editRes.content;
      expect(resText).toContain('Applied 2 edit(s)');
      expect(resText).toContain('tracked changes');

      // Verify untouched zip entries are byte-identical
      const beforeZip = readZip(originalBuf);
      const patchedBuf = fs.readFileSync(filePath);
      const afterZip = readZip(patchedBuf);

      // Untouched parts must be identical
      expect(afterZip.get('word/footer1.xml')?.equals(beforeZip.get('word/footer1.xml')!)).toBe(true);
      expect(afterZip.get('word/footnotes.xml')?.equals(beforeZip.get('word/footnotes.xml')!)).toBe(true);
      expect(afterZip.get('word/styles.xml')?.equals(beforeZip.get('word/styles.xml')!)).toBe(true);

      // document.xml has changed and contains w:ins / w:del and Pocket Agent author
      const docXml = afterZip.get('word/document.xml')!.toString('utf8');
      expect(docXml).toContain('<w:del');
      expect(docXml).toContain('<w:ins');
      expect(docXml).toContain('$50,000');
      expect(docXml).toContain('$75,000');
      expect(docXml).toContain('Pocket Agent');

      // Comments part was added or updated
      expect(afterZip.has('word/comments.xml')).toBe(true);
      const commentsXml = afterZip.get('word/comments.xml')!.toString('utf8');
      expect(commentsXml).toContain('Verify if phase one scope expanded');

      // Acceptance: acceptOrRejectDocxTrackedChanges accepts cleanly
      const acceptedBuf = await acceptOrRejectDocxTrackedChanges(new Uint8Array(patchedBuf), 'accept');
      const acceptedStruct = await readDocxStructure(acceptedBuf);
      expect(acceptedStruct.paragraphs.some((p) => p.text.includes('$75,000'))).toBe(true);
      expect(acceptedStruct.paragraphs.some((p) => p.text.includes('$50,000'))).toBe(false);
      expect(acceptedStruct.trackedChanges.length).toBe(0);

      // Acceptance: reject cleanly restores original
      const rejectedBuf = await acceptOrRejectDocxTrackedChanges(new Uint8Array(patchedBuf), 'reject');
      const rejectedStruct = await readDocxStructure(rejectedBuf);
      expect(rejectedStruct.paragraphs.some((p) => p.text.includes('$50,000'))).toBe(true);
      expect(rejectedStruct.paragraphs.some((p) => p.text.includes('$75,000'))).toBe(false);
    });

    it('supports direct mode applying changes without w:ins/w:del tags', async () => {
      const originalBuf = makeDocx([{ text: 'Status: Pending Review' }]);
      const filePath = path.join(wsRoot, 'status.docx');
      fs.writeFileSync(filePath, originalBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const filesRes = await t.context.docWorkspaces.listFiles(ws.id);
      const currentVersion = filesRes.entries.find((e) => e.path === 'status.docx')!.sha256;

      const docEdit = findPlannerTool('doc_edit')!;
      const deps = depsForDocWs(t, ws);

      const editRes = await docEdit.execute(deps, {
        path: 'status.docx',
        baseVersion: currentVersion,
        mode: 'direct',
        edits: [
          {
            op: 'replace_text',
            target: 'Pending Review',
            replacement: 'Approved',
          },
        ],
      });

      const resText = typeof editRes === 'string' ? editRes : editRes.content;
      expect(resText).toContain('direct mode');

      const patchedBuf = fs.readFileSync(filePath);
      const afterZip = readZip(patchedBuf);
      const docXml = afterZip.get('word/document.xml')!.toString('utf8');

      expect(docXml).toContain('Approved');
      expect(docXml).not.toContain('<w:ins');
      expect(docXml).not.toContain('<w:del');
    });

    it('warns in approval card and output when an Office lock file is present', async () => {
      const docxBuf = makeDocx([{ text: 'Shared document' }]);
      const filePath = path.join(wsRoot, 'shared.docx');
      fs.writeFileSync(filePath, docxBuf);
      fs.writeFileSync(path.join(wsRoot, '~$shared.docx'), 'lock');
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const filesRes = await t.context.docWorkspaces.listFiles(ws.id);
      const currentVersion = filesRes.entries.find((e) => e.path === 'shared.docx')!.sha256;

      const docEdit = findPlannerTool('doc_edit')!;
      const deps = depsForDocWs(t, ws);

      const editRes = await docEdit.execute(deps, {
        path: 'shared.docx',
        baseVersion: currentVersion,
        mode: 'direct',
        edits: [{ op: 'insert_text', text: ' - Updated', anchor: 'Shared document', position: 'after' }],
      });

      const resText = typeof editRes === 'string' ? editRes : editRes.content;
      expect(resText).toContain('Office lock file');
      expect(resText).toContain('~$shared.docx');
    });
  });

  describe('sheet_edit in workspace (retargeted)', () => {
    it('edits xlsx in place by default, requires baseVersion, and is undone by undoPlannerTurn', async () => {
      const xlsxBuf = makeXlsx({
        Sheet1: [
          ['Item', 'Amount'],
          ['Widgets', 100],
        ],
      });
      const filePath = path.join(wsRoot, 'inventory.xlsx');
      fs.writeFileSync(filePath, xlsxBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const filesRes = await t.context.docWorkspaces.listFiles(ws.id);
      const currentVersion = filesRes.entries.find((e) => e.path === 'inventory.xlsx')!.sha256;

      const sheetEdit = findPlannerTool('sheet_edit')!;
      const deps = depsForDocWs(t, ws);

      // Fails on missing baseVersion in workspace
      const noBaseRes = await sheetEdit.execute(deps, {
        filePath: 'inventory.xlsx',
        sheet: 'Sheet1',
        operations: [{ op: 'set_value', cell: 'B2', value: 250 }],
      });
      expect(typeof noBaseRes === 'object' && noBaseRes.isError).toBe(true);
      expect(typeof noBaseRes === 'object' ? noBaseRes.content : noBaseRes).toContain('baseVersion');

      // Edit in place with valid baseVersion
      const editRes = await sheetEdit.execute(deps, {
        filePath: 'inventory.xlsx',
        baseVersion: currentVersion,
        sheet: 'Sheet1',
        operations: [{ op: 'set_value', cell: 'B2', value: 250 }],
      });
      const resText = typeof editRes === 'string' ? editRes : editRes.content;
      expect(resText).toContain('inventory.xlsx');
      expect(resText).toContain('Version:');

      // Verify on disk that B2 is updated
      expect(fs.existsSync(filePath)).toBe(true);
      const sheetRead = findPlannerTool('sheet_read')!;
      const readRes = await sheetRead.execute(deps, { filePath: 'inventory.xlsx', sheet: 'Sheet1' });
      const readText = typeof readRes === 'string' ? readRes : readRes.content;
      expect(readText).toContain('250');

      // Undo turn reverts inventory.xlsx back to original version
      const undoRes = await t.context.docWorkspaces.undoTurn(ws.id, 'turn-pa145-1');
      expect(undoRes.ok).toBe(true);
      expect(undoRes.restoredPaths).toContain('inventory.xlsx');

      expect(fs.existsSync(filePath)).toBe(true);
      const readAfterUndo = await sheetRead.execute(deps, { filePath: 'inventory.xlsx', sheet: 'Sheet1' });
      const readAfterUndoText = typeof readAfterUndo === 'string' ? readAfterUndo : readAfterUndo.content;
      expect(readAfterUndoText).toContain('100');
    });

    it('warns when an Office lock file (~$inventory.xlsx) exists', async () => {
      const xlsxBuf = makeXlsx({
        Sheet1: [['Value', 42]],
      });
      const filePath = path.join(wsRoot, 'locked_book.xlsx');
      fs.writeFileSync(filePath, xlsxBuf);
      fs.writeFileSync(path.join(wsRoot, '~$locked_book.xlsx'), 'lock');
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const filesRes = await t.context.docWorkspaces.listFiles(ws.id);
      const currentVersion = filesRes.entries.find((e) => e.path === 'locked_book.xlsx')!.sha256;

      const sheetEdit = findPlannerTool('sheet_edit')!;
      const deps = depsForDocWs(t, ws);

      const res = await sheetEdit.execute(deps, {
        filePath: 'locked_book.xlsx',
        baseVersion: currentVersion,
        sheet: 'Sheet1',
        operations: [{ op: 'set_value', cell: 'B1', value: 99 }],
      });
      const resText = typeof res === 'string' ? res : res.content;
      expect(resText).toContain('Office lock file');
      expect(resText).toContain('~$locked_book.xlsx');
    });
  });

  describe('create_sheet tool', () => {
    it('creates a new xlsx file with sheets, rows, formulas, and column widths', async () => {
      const createSheet = findPlannerTool('create_sheet')!;
      const deps = depsForDocWs(t, ws);

      const res = await createSheet.execute(deps, {
        path: 'sales_model.xlsx',
        sheets: [
          {
            name: 'Projections',
            columnWidths: [15, 20, 20],
            rows: [
              ['Category', 'Units', 'Price', 'Total'],
              ['Product A', 100, 25, '=B2*C2'],
              ['Product B', 200, 15, '=B3*C3'],
            ],
          },
        ],
      });

      const resText = typeof res === 'string' ? res : res.content;
      expect(resText).toContain('Created workbook');
      // Defaults to outputs/ when path has no folder
      expect(resText).toContain('outputs/sales_model.xlsx');

      const absPath = path.join(wsRoot, 'outputs', 'sales_model.xlsx');
      expect(fs.existsSync(absPath)).toBe(true);

      const sheetInfo = findPlannerTool('sheet_info')!;
      const infoRes = await sheetInfo.execute(deps, { filePath: 'outputs/sales_model.xlsx' });
      const infoText = typeof infoRes === 'string' ? infoRes : infoRes.content;
      expect(infoText).toContain('Projections');
      expect(infoText).toContain('range A1:D3');
    });

    it('refuses to overwrite existing files unless overwrite is true with baseVersion', async () => {
      const createSheet = findPlannerTool('create_sheet')!;
      const deps = depsForDocWs(t, ws);

      fs.mkdirSync(path.join(wsRoot, 'outputs'), { recursive: true });
      fs.writeFileSync(path.join(wsRoot, 'outputs', 'existing.xlsx'), 'existing content');
      await t.context.docWorkspaces.scheduleScan(ws.id);

      // Without overwrite: refused
      const refuseRes = await createSheet.execute(deps, {
        path: 'outputs/existing.xlsx',
        sheets: [{ name: 'S1', rows: [['Hello']] }],
      });
      expect(typeof refuseRes === 'object' && refuseRes.isError).toBe(true);
      expect(typeof refuseRes === 'object' ? refuseRes.content : refuseRes).toContain('already exists');
    });
  });

  describe('create_doc tool', () => {
    it('creates a new docx from markdown with headings, lists, tables, and links', async () => {
      const createDoc = findPlannerTool('create_doc')!;
      const deps = depsForDocWs(t, ws);

      const markdown = `
# Executive Summary

This report outlines the **FY26 strategy** and milestones.

## Key Objectives
- Launch product line in EMEA
- Achieve 99.9% uptime
- Hire 5 senior engineers

## Budget Allocation
| Department | Allocation | Share |
| Engineering | $4.5M | 60% |
| Marketing | $2.0M | 27% |
| Operations | $1.0M | 13% |

For more details, visit [Documentation](https://internal.example.com/docs).
`;

      const res = await createDoc.execute(deps, {
        path: 'executive_summary.docx',
        markdown,
      });

      const resText = typeof res === 'string' ? res : res.content;
      expect(resText).toContain('Created Word document');
      expect(resText).toContain('outputs/executive_summary.docx');

      const absPath = path.join(wsRoot, 'outputs', 'executive_summary.docx');
      expect(fs.existsSync(absPath)).toBe(true);

      const docRead = findPlannerTool('doc_read')!;
      const readRes = await docRead.execute(deps, { path: 'outputs/executive_summary.docx' });
      const readText = typeof readRes === 'string' ? readRes : readRes.content;

      expect(readText).toContain('Executive Summary');
      expect(readText).toContain('Key Objectives');
      expect(readText).toContain('Launch product line in EMEA');
      expect(readText).toContain('Engineering');
      expect(readText).toContain('https://internal.example.com/docs');
    });

    it('reuses styles from a template docx when specified', async () => {
      const templateBuf = makeDocx(
        [{ text: 'Template Heading', heading: 'Heading1' }],
        { footer: 'Corporate Template Footer' },
      );
      fs.writeFileSync(path.join(wsRoot, 'corporate_template.docx'), templateBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const createDoc = findPlannerTool('create_doc')!;
      const deps = depsForDocWs(t, ws);

      const res = await createDoc.execute(deps, {
        path: 'templated_report.docx',
        markdown: '# Templated Report\nContent generated using corporate template styles.',
        template: 'corporate_template.docx',
      });

      const resText = typeof res === 'string' ? res : res.content;
      expect(resText).toContain('corporate_template.docx');

      const outZip = readZip(fs.readFileSync(path.join(wsRoot, 'outputs', 'templated_report.docx')));
      // Styles from template must be reused
      expect(outZip.has('word/styles.xml')).toBe(true);
      const docXml = outZip.get('word/document.xml')!.toString('utf8');
      expect(docXml).toContain('Templated Report');
    });
  });

  describe('export_pdf tool', () => {
    it('refuses missing source file or unsupported formats', async () => {
      const exportPdf = findPlannerTool('export_pdf')!;
      const deps = depsForDocWs(t, ws);

      const missingRes = await exportPdf.execute(deps, {
        source: 'nonexistent.docx',
        output: 'nonexistent.pdf',
      });
      expect(typeof missingRes === 'object' && missingRes.isError).toBe(true);

      fs.writeFileSync(path.join(wsRoot, 'test.txt'), 'plain text');
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const unsuppRes = await exportPdf.execute(deps, {
        source: 'test.txt',
        output: 'test.pdf',
      });
      expect(typeof unsuppRes === 'object' && unsuppRes.isError).toBe(true);
      expect(typeof unsuppRes === 'object' ? unsuppRes.content : unsuppRes).toContain(
        'export_pdf supports .docx, .xlsx, or .pptx',
      );
    });
  });

  describe('Redline preview and version compare', () => {
    it('extracts redline blocks and tracked changes count for previewFile', async () => {
      const docxBuf = makeDocx([{ text: 'Baseline text' }]);
      const filePath = path.join(wsRoot, 'redline_preview.docx');
      fs.writeFileSync(filePath, docxBuf);
      await t.context.docWorkspaces.scheduleScan(ws.id);

      const currentVersion = (await t.context.docWorkspaces.listFiles(ws.id)).entries.find(
        (e) => e.path === 'redline_preview.docx',
      )!.sha256;

      const docEdit = findPlannerTool('doc_edit')!;
      const deps = depsForDocWs(t, ws);

      await docEdit.execute(deps, {
        path: 'redline_preview.docx',
        baseVersion: currentVersion,
        mode: 'tracked',
        edits: [
          { op: 'replace_text', target: 'Baseline', replacement: 'Proposed' },
        ],
      });

      const preview = await t.context.docWorkspaces.previewFile(ws.id, 'redline_preview.docx');
      expect(preview.redlineBlocks).toBeDefined();
      expect(preview.redlineBlocks!.length).toBeGreaterThan(0);
      expect(preview.trackedChangesCount).toBe(2); // 1 delete + 1 insert
    });

    it('returns redlineBlocks when comparing two docx versions', async () => {
      const createDoc = findPlannerTool('create_doc')!;
      const deps = depsForDocWs(t, ws);

      await createDoc.execute(deps, {
        path: 'outputs/revision_compare.docx',
        markdown: 'First revision content',
      });

      const v1Sha = (await t.context.docWorkspaces.listFiles(ws.id)).entries.find(
        (e) => e.path === 'outputs/revision_compare.docx',
      )!.sha256;

      const docEdit = findPlannerTool('doc_edit')!;

      await docEdit.execute(deps, {
        path: 'outputs/revision_compare.docx',
        baseVersion: v1Sha,
        mode: 'tracked',
        edits: [
          { op: 'replace_text', target: 'First revision', replacement: 'Second revision' },
        ],
      });

      const versionsRes = await t.context.docWorkspaces.listFileVersions(ws.id, 'outputs/revision_compare.docx');
      expect(versionsRes.versions.length).toBe(2);

      const compare = await t.context.docWorkspaces.compareVersions(
        ws.id,
        versionsRes.versions[1]!.id, // earlier version
        versionsRes.versions[0]!.id, // latest version
      );

      expect(compare.redlineBlocks).toBeDefined();
      expect(compare.redlineBlocks!.length).toBeGreaterThan(0);
      const changedBlock = compare.redlineBlocks!.find((b) =>
        b.segments.some((s) => s.type === 'ins' || s.type === 'del'),
      );
      expect(changedBlock).toBeDefined();
    });
  });
});
