import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TOOL_INTEGRATION_DISABLED,
  findPlannerTool,
  type PlannerToolDeps,
} from '../src/planner/tools.js';
import { PDF_PREVIEW_CSP } from '../src/security-headers.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { makeDocx, makePdf, makePptx, makeXlsx } from './helpers-documents.js';

function depsForDocWs(t: TestApp, ws: { id: string; path: string }): PlannerToolDeps {
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
  };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  deps: PlannerToolDeps,
): Promise<{ output: string; isError: boolean }> {
  const tool = findPlannerTool(name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  const res = await tool.execute(deps, args);
  if (typeof res === 'string') return { output: res, isError: false };
  return { output: res.content, isError: Boolean(res.isError) };
}

describe('Document Workspaces Phase 1 (PA-142)', () => {
  let t: TestApp;
  let hostDir: string;

  beforeEach(async () => {
    t = await createTestApp();
    hostDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-doc-ws-')));
  });

  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const post = (url: string, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/json' },
      payload: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({
      method: 'PATCH',
      url,
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const del = (url: string) => t.app.inject({ method: 'DELETE', url, headers: authHeaders(t.cookie) });

  it('creates, updates, lists, and deletes document workspaces and enforces path containment rules', async () => {
    const folderA = path.join(hostDir, 'legal-matter');
    fs.mkdirSync(folderA, { recursive: true });

    // Create workspace pointing to existing folder
    const createRes = await post('/api/doc-workspaces', {
      name: 'Legal Matter',
      path: folderA,
      autoApproveEdits: true,
    });
    expect(createRes.statusCode).toBe(201);
    const ws = createRes.json();
    expect(ws.name).toBe('Legal Matter');
    expect(ws.path).toBe(folderA);
    expect(ws.autoApproveEdits).toBe(true);
    expect(ws.inboxDir).toBe('inbox');

    // Rejects duplicate workspace folder
    const dupRes = await post('/api/doc-workspaces', { path: folderA });
    expect(dupRes.statusCode).toBe(400);

    // Rejects filesystem root
    const rootRes = await post('/api/doc-workspaces', { path: '/' });
    expect(rootRes.statusCode).toBe(400);

    // Rejects dataDir or inside dataDir or parent of dataDir
    const dataDirRes = await post('/api/doc-workspaces', { path: t.context.config.dataDir });
    expect(dataDirRes.statusCode).toBe(400);
    const parentOfDataDirRes = await post('/api/doc-workspaces', {
      path: path.dirname(t.context.config.dataDir),
    });
    expect(parentOfDataDirRes.statusCode).toBe(400);

    // Supports createPath: true for a new subfolder
    const folderB = path.join(hostDir, 'new-research-folder');
    const createNewRes = await post('/api/doc-workspaces', {
      path: folderB,
      createPath: true,
    });
    expect(createNewRes.statusCode).toBe(201);
    expect(fs.existsSync(folderB)).toBe(true);

    // Lists workspaces
    const listRes = await get('/api/doc-workspaces');
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().workspaces).toHaveLength(2);

    // Updates name, autoApproveEdits, inboxDir
    const patchRes = await patch(`/api/doc-workspaces/${ws.id}`, {
      name: 'Renamed Matter',
      autoApproveEdits: false,
      inboxDir: 'uploads',
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json()).toMatchObject({
      name: 'Renamed Matter',
      autoApproveEdits: false,
      inboxDir: 'uploads',
    });

    // Attaches chat on creation and detaches with ON DELETE SET NULL when workspace is deleted
    const chatRes = await post('/api/planner/chats', {
      title: 'Contract review',
      docWorkspaceId: ws.id,
    });
    expect(chatRes.statusCode).toBe(201);
    const chat = chatRes.json();
    expect(chat.docWorkspaceId).toBe(ws.id);
    expect(chat.docWorkspaceName).toBe('Renamed Matter');

    // Switch workspace via PATCH /api/planner/chats/:id
    const wsB = createNewRes.json();
    const switchRes = await patch(`/api/planner/chats/${chat.id}`, { docWorkspaceId: wsB.id });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().docWorkspaceId).toBe(wsB.id);

    // Deleting wsB nulls out chat.docWorkspaceId (ON DELETE SET NULL)
    const delRes = await del(`/api/doc-workspaces/${wsB.id}`);
    expect(delRes.statusCode).toBe(204);
    const chatsAfterRes = await get('/api/planner/chats');
    const afterChat = chatsAfterRes.json().chats.find((c: { id: string }) => c.id === chat.id);
    expect(afterChat?.docWorkspaceId).toBeNull();
  });

  it('extracts PDF, DOCX, XLSX, and PPTX into <dataDir>/doc-workspaces/<id>/derived/ without writing sidecars into the user folder', async () => {
    const wsPath = path.join(hostDir, 'docs');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(
      path.join(wsPath, 'contract.pdf'),
      makePdf(['Indemnification Clause Alpha', 'Termination Notice Beta']),
    );
    fs.writeFileSync(
      path.join(wsPath, 'memo.docx'),
      makeDocx(['Confidential legal memorandum', 'Second paragraph details']),
    );
    fs.writeFileSync(
      path.join(wsPath, 'budget.xlsx'),
      makeXlsx({ Summary: [['Category', 'Amount'], ['Engineering', 45000]], Notes: [['Approved']] }),
    );
    fs.writeFileSync(
      path.join(wsPath, 'deck.pptx'),
      makePptx([['Q4 Strategy', 'Key Milestones'], ['Appendix Slide']]),
    );
    fs.writeFileSync(path.join(wsPath, 'readme.txt'), 'Plain text notes line 1\nLine 2');

    const createRes = await post('/api/doc-workspaces', { path: wsPath });
    expect(createRes.statusCode).toBe(201);
    const ws = createRes.json();

    // Run background scan & extraction to completion
    await t.context.docWorkspaces.scheduleScan(ws.id);

    // Verify zero sidecars written into the user's folder
    const hostFiles = fs.readdirSync(wsPath).sort();
    expect(hostFiles).toEqual(['budget.xlsx', 'contract.pdf', 'deck.pptx', 'memo.docx', 'readme.txt']);

    // Verify derived store exists under <docWorkspacesRoot>/<id>/derived/
    const derivedRoot = path.join(t.workspaceRoot, 'doc-workspaces', ws.id, 'derived');
    expect(fs.existsSync(derivedRoot)).toBe(true);
    expect(fs.readdirSync(derivedRoot).length).toBeGreaterThanOrEqual(4);

    // Verify GET /api/doc-workspaces/:id/files reports extracted status for all documents
    const filesRes = await get(`/api/doc-workspaces/${ws.id}/files`);
    expect(filesRes.statusCode).toBe(200);
    const filesBody = filesRes.json();
    const byName = new Map(filesBody.entries.map((e: { name: string; extractStatus: string }) => [e.name, e.extractStatus]));
    expect(byName.get('contract.pdf')).toBe('extracted');
    expect(byName.get('memo.docx')).toBe('extracted');
    expect(byName.get('budget.xlsx')).toBe('extracted');
    expect(byName.get('deck.pptx')).toBe('extracted');
    expect(byName.get('readme.txt')).toBe('none');

    // Test read_file and grep_files on attached workspace
    const toolDeps = depsForDocWs(t, ws);

    // read_file on contract.pdf returns paged derived text with page markers and untrusted fence
    const pdfRead = await runTool('read_file', { path: 'contract.pdf' }, toolDeps);
    expect(pdfRead.isError).toBe(false);
    expect(pdfRead.output).toContain('[Derived text of contract.pdf (PDF');
    expect(pdfRead.output).toContain('--- Page 1 ---');
    expect(pdfRead.output).toContain('Indemnification Clause Alpha');
    expect(pdfRead.output).toContain('--- Page 2 ---');
    expect(pdfRead.output).toContain('Termination Notice Beta');
    expect(pdfRead.output).toMatch(/<<<FILE contract\.pdf [0-9a-f]{16}>>>/);

    // read_file on budget.xlsx returns sheet overview and points to sheet_read
    const xlsxRead = await runTool('read_file', { path: 'budget.xlsx' }, toolDeps);
    expect(xlsxRead.isError).toBe(false);
    expect(xlsxRead.output).toContain('sheet_read');
    expect(xlsxRead.output).toContain('## Sheet: Summary');
    expect(xlsxRead.output).toContain('Engineering,45000');

    // grep_files searches derived text and reports page / sheet / slide location
    const grepPdf = await runTool('grep_files', { pattern: 'Termination Notice Beta' }, toolDeps);
    expect(grepPdf.isError).toBe(false);
    expect(grepPdf.output).toContain('contract.pdf p.2');

    const grepXlsx = await runTool('grep_files', { pattern: '45000' }, toolDeps);
    expect(grepXlsx.isError).toBe(false);
    expect(grepXlsx.output).toContain('budget.xlsx sheet Summary');

    const grepPptx = await runTool('grep_files', { pattern: 'Key Milestones' }, toolDeps);
    expect(grepPptx.isError).toBe(false);
    expect(grepPptx.output).toContain('deck.pptx slide 1');
  });

  it('detects file changes on access, reuses derived text on touch or rename, and respects ignore rules', async () => {
    const wsPath = path.join(hostDir, 'change-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const pdfPath = path.join(wsPath, 'report.pdf');
    fs.writeFileSync(pdfPath, makePdf(['Version One Content']));

    // Ignored files: Office lock files, swap files, node_modules, .gitignore
    fs.writeFileSync(path.join(wsPath, '~$report.docx'), 'lock');
    fs.writeFileSync(path.join(wsPath, '.~lock.report.pdf#'), 'lock');
    fs.writeFileSync(path.join(wsPath, 'notes.txt.swp'), 'swap');
    fs.mkdirSync(path.join(wsPath, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'node_modules', 'pkg', 'index.js'), 'ignored');
    fs.mkdirSync(path.join(wsPath, '.git'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, '.gitignore'), 'ignored-dir/\n*.secret.pdf\n');
    fs.mkdirSync(path.join(wsPath, 'ignored-dir'), { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'ignored-dir', 'skip.pdf'), makePdf(['Should be ignored']));
    fs.writeFileSync(path.join(wsPath, 'top.secret.pdf'), makePdf(['Also ignored']));

    const createRes = await post('/api/doc-workspaces', { path: wsPath });
    expect(createRes.statusCode).toBe(201);
    const ws = createRes.json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    // Ignore rules: only report.pdf and .gitignore should appear (no lock files, swap files, node_modules, or gitignored files)
    const listRes = await get(`/api/doc-workspaces/${ws.id}/files`);
    const entryPaths = listRes.json().entries.map((e: { path: string }) => e.path);
    expect(entryPaths).toContain('report.pdf');
    expect(entryPaths).not.toContain('~$report.docx');
    expect(entryPaths).not.toContain('.~lock.report.pdf#');
    expect(entryPaths).not.toContain('notes.txt.swp');
    expect(entryPaths.some((p: string) => p.startsWith('node_modules'))).toBe(false);
    expect(entryPaths.some((p: string) => p.startsWith('ignored-dir'))).toBe(false);
    expect(entryPaths).not.toContain('top.secret.pdf');

    const toolDeps = depsForDocWs(t, ws);

    const read1 = await runTool('read_file', { path: 'report.pdf' }, toolDeps);
    expect(read1.output).toContain('Version One Content');

    // Modify report.pdf in place on disk -> read_file immediately detects change on access and re-extracts
    const updatedBuf = makePdf(['Version Two Updated Content', 'Extra Second Page']);
    fs.writeFileSync(pdfPath, updatedBuf);
    const futureTime = new Date(Date.now() + 5000);
    fs.utimesSync(pdfPath, futureTime, futureTime);

    const read2 = await runTool('read_file', { path: 'report.pdf' }, toolDeps);
    expect(read2.output).toContain('Version Two Updated Content');
    expect(read2.output).toContain('Extra Second Page');
    expect(read2.output).not.toContain('Version One Content');

    // Rename report.pdf -> moved/report-v2.pdf via API and verify derived text is reused by sha256
    const renameRes = await post(`/api/doc-workspaces/${ws.id}/files/rename`, {
      fromPath: 'report.pdf',
      toPath: 'moved/report-v2.pdf',
    });
    expect(renameRes.statusCode).toBe(200);
    const readMoved = await runTool('read_file', { path: 'moved/report-v2.pdf' }, toolDeps);
    expect(readMoved.isError).toBe(false);
    expect(readMoved.output).toContain('Version Two Updated Content');
  });

  it('loads WORKSPACE.md brief into the attached chat system prompt before memories and supports panel file operations & previews', async () => {
    const wsPath = path.join(hostDir, 'panel-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'sample.docx'), makeDocx(['Hello from Mammoth HTML']));
    fs.writeFileSync(path.join(wsPath, 'grid.xlsx'), makeXlsx({ SheetA: [['Col1', 'Col2'], ['Val1', 42]] }));
    fs.writeFileSync(path.join(wsPath, 'doc.pdf'), makePdf(['PDF Preview Page']));

    const createRes = await post('/api/doc-workspaces', { path: wsPath });
    expect(createRes.statusCode).toBe(201);
    const ws = createRes.json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    // Create WORKSPACE.md brief via endpoint
    const briefRes = await post(`/api/doc-workspaces/${ws.id}/brief`, {
      content: '# Project Brief\nAlways cite page numbers when quoting contracts.',
    });
    expect(briefRes.statusCode).toBe(201);
    expect(fs.existsSync(path.join(wsPath, 'WORKSPACE.md'))).toBe(true);

    // Attach chat and inspect context preview
    const chat = t.context.plannerChats.create({
      title: 'Brief Test Chat',
      docWorkspaceId: ws.id,
    });
    const ctxRes = await get(`/api/planner/chats/${chat.id}/context-preview`);
    expect(ctxRes.statusCode).toBe(200);
    const ctxBody = ctxRes.json();
    const sectionIds = ctxBody.systemPrompt.map((s: { id: string }) => s.id);
    expect(sectionIds).toContain('workspaceBrief');
    const briefSection = ctxBody.systemPrompt.find((s: { id: string }) => s.id === 'workspaceBrief');
    expect(briefSection.text).toContain('Always cite page numbers when quoting contracts.');

    // Preview endpoints: docx_html, xlsx_grid, markdown, pdf
    const docxPreview = await get(`/api/doc-workspaces/${ws.id}/files/preview?path=sample.docx`);
    expect(docxPreview.statusCode).toBe(200);
    expect(docxPreview.json().previewKind).toBe('docx_html');
    expect(docxPreview.json().html).toContain('Hello from Mammoth HTML');

    const xlsxPreview = await get(`/api/doc-workspaces/${ws.id}/files/preview?path=grid.xlsx`);
    expect(xlsxPreview.statusCode).toBe(200);
    expect(xlsxPreview.json().previewKind).toBe('xlsx_grid');
    expect(xlsxPreview.json().sheets[0]).toMatchObject({
      name: 'SheetA',
      rows: [['Col1', 'Col2'], ['Val1', '42']],
    });

    const mdPreview = await get(`/api/doc-workspaces/${ws.id}/files/preview?path=WORKSPACE.md`);
    expect(mdPreview.statusCode).toBe(200);
    expect(mdPreview.json().previewKind).toBe('markdown');

    // Inline PDF download serves PDF_PREVIEW_CSP so browser iframe viewer works
    const pdfInline = await get(`/api/doc-workspaces/${ws.id}/files/download?path=doc.pdf&inline=1`);
    expect(pdfInline.statusCode).toBe(200);
    expect(pdfInline.headers['content-security-policy']).toBe(PDF_PREVIEW_CSP);
    expect(pdfInline.headers['content-disposition']).toContain('inline');

    // Mkdir, upload, zip download, delete
    const mkdirRes = await post(`/api/doc-workspaces/${ws.id}/files/mkdir`, { path: 'clauses/2026' });
    expect(mkdirRes.statusCode).toBe(201);
    expect(fs.statSync(path.join(wsPath, 'clauses', '2026')).isDirectory()).toBe(true);

    const uploadRes = await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?dir=clauses/2026&name=addendum.txt`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'text/plain' },
      payload: 'Addendum text body',
    });
    expect(uploadRes.statusCode).toBe(201);
    expect(fs.readFileSync(path.join(wsPath, 'clauses', '2026', 'addendum.txt'), 'utf8')).toBe('Addendum text body');

    const zipRes = await get(`/api/doc-workspaces/${ws.id}/files/zip?path=clauses`);
    expect(zipRes.statusCode).toBe(200);
    expect(zipRes.headers['content-type']).toBe('application/zip');
    expect(zipRes.rawPayload.length).toBeGreaterThan(20);

    const delFileRes = await del(`/api/doc-workspaces/${ws.id}/files?path=clauses/2026/addendum.txt`);
    expect(delFileRes.statusCode).toBe(200);
    expect(fs.existsSync(path.join(wsPath, 'clauses', '2026', 'addendum.txt'))).toBe(false);
  });
});
