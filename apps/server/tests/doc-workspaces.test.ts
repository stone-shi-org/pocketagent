import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_INTEGRATION_DISABLED,
  findPlannerTool,
  type PlannerToolDeps,
} from '../src/planner/tools.js';
import { PDF_PREVIEW_CSP } from '../src/security-headers.js';
import { TelegramBridge } from '../src/telegram/bridge.js';
import type { TelegramClient } from '../src/telegram/client.js';
import { interceptSlashCommand } from '../src/telegram/slash-commands.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { makeDocx, makePdf, makePptx, makeXlsx } from './helpers-documents.js';

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
    ...extra,
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

function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function fakeCompletionResponse(content: string): Response {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

function fakeToolCallResponse(name: string, args: Record<string, unknown>, callId = 'call_1'): Response {
  return sseResponse([
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
}

function parseSseEvents(res: { payload: string }): Array<{ kind: string; [key: string]: unknown }> {
  return res.payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}

describe('Document Workspaces Phase 2 (PA-143)', () => {
  let t: TestApp;
  let hostDir: string;

  beforeEach(async () => {
    t = await createTestApp();
    hostDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-doc-ws-p2-')));
  });

  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(hostDir, { recursive: true, force: true });
  });

  const get = (url: string, app: TestApp = t) =>
    app.app.inject({ method: 'GET', url, headers: authHeaders(app.cookie) });
  const post = (url: string, payload?: unknown, app: TestApp = t) =>
    app.app.inject({
      method: 'POST',
      url,
      headers: { ...authHeaders(app.cookie), 'content-type': 'application/json' },
      payload: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  const patch = (url: string, payload: unknown, app: TestApp = t) =>
    app.app.inject({
      method: 'PATCH',
      url,
      headers: { ...authHeaders(app.cookie), 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
  const del = (url: string, app: TestApp = t) =>
    app.app.inject({ method: 'DELETE', url, headers: authHeaders(app.cookie) });

  it('records exactly one automatic version per mutation across write_file, edit_file, sheet_edit, upload replacement, rename, delete, and external change detection', async () => {
    const wsPath = path.join(hostDir, 'versions-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(
      path.join(wsPath, 'budget.xlsx'),
      makeXlsx({ Summary: [['Item', 'Cost'], ['Hosting', 1000]] }),
    );
    fs.writeFileSync(path.join(wsPath, 'notes.txt'), 'Line one\nLine two\n');

    const createRes = await post('/api/doc-workspaces', { path: wsPath });
    expect(createRes.statusCode).toBe(201);
    const ws = createRes.json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    const chat = t.context.plannerChats.create({
      title: 'Version Actor Chat',
      docWorkspaceId: ws.id,
    });
    const deps = depsForDocWs(t, ws, {
      plannerChatId: chat.id,
      plannerTurnId: 'turn-alpha',
      plannerToolUseId: 'tool-1',
    });

    // 1. write_file creating a new file -> exactly 1 version row
    const writeNew = await runTool(
      'write_file',
      { path: 'memo.txt', content: 'Draft v1\nSecond line\n' },
      deps,
    );
    expect(writeNew.isError).toBe(false);
    let memoVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'memo.txt').versions;
    expect(memoVersions).toHaveLength(1);
    expect(memoVersions[0]).toMatchObject({
      relPath: 'memo.txt',
      prevSha256: null,
      actor: `agent:${chat.id}`,
      chatId: chat.id,
      turnId: 'turn-alpha',
      toolUseId: 'tool-1',
      tombstone: false,
    });
    expect(memoVersions[0]!.summary).toContain('Created');

    // 2. edit_file on memo.txt -> exactly 1 additional version row (total 2)
    const editRes = await runTool(
      'edit_file',
      {
        path: 'memo.txt',
        edits: [{ oldText: 'Draft v1', newText: 'Draft v2 updated' }],
      },
      { ...deps, plannerToolUseId: 'tool-2' },
    );
    expect(editRes.isError).toBe(false);
    memoVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'memo.txt').versions;
    expect(memoVersions).toHaveLength(2);
    expect(memoVersions[0]!.prevSha256).toBe(memoVersions[1]!.sha256);
    expect(memoVersions[0]!.summary).toMatch(/\+1 (?:\/ )?-1 line/);

    // 3. write_file overwriting memo.txt -> exactly 1 additional version row (total 3)
    const writeOverwrite = await runTool(
      'write_file',
      { path: 'memo.txt', content: 'Draft v3 complete replacement\n' },
      { ...deps, plannerToolUseId: 'tool-3' },
    );
    expect(writeOverwrite.isError).toBe(false);
    memoVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'memo.txt').versions;
    expect(memoVersions).toHaveLength(3);
    expect(memoVersions[0]!.prevSha256).toBe(memoVersions[1]!.sha256);

    // 4. sheet_edit in-place (omitting outputPath) on budget.xlsx -> reads first, then edits in place -> 1 version row with cell diff summary
    const sheetRead = await runTool('sheet_read', { path: 'budget.xlsx', sheet: 'Summary' }, deps);
    expect(sheetRead.isError).toBe(false);
    expect(sheetRead.output).toMatch(/version=[0-9a-f]{64}/);

    const sheetEdit = await runTool(
      'sheet_edit',
      {
        path: 'budget.xlsx',
        edits: [{ sheet: 'Summary', cell: 'B2', value: 2500 }],
      },
      { ...deps, plannerToolUseId: 'tool-4' },
    );
    expect(sheetEdit.isError).toBe(false);
    expect(sheetEdit.output).toContain('Version:');

    const xlsxVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'budget.xlsx').versions;
    expect(xlsxVersions).toHaveLength(1);
    expect(xlsxVersions[0]!.summary).toContain('Summary');
    expect(xlsxVersions[0]!.summary).toContain('B2');
    expect(xlsxVersions[0]!.summary).toContain('1000');
    expect(xlsxVersions[0]!.summary).toContain('2500');

    // 5. Upload replacing notes.txt -> 1 version row with actor 'user'
    const uploadReplace = await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?name=notes.txt`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'text/plain' },
      payload: 'Line one\nLine two\nLine three uploaded\n',
    });
    expect(uploadReplace.statusCode).toBe(201);
    let notesVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'notes.txt').versions;
    expect(notesVersions).toHaveLength(1);
    expect(notesVersions[0]!.actor).toBe('user');
    expect(notesVersions[0]!.prevSha256).toBeTruthy();
    expect(notesVersions[0]!.summary).toMatch(/\+1 (?:\/ )?-0 line/);

    // 6. External change on disk to notes.txt -> detected on access and recorded as 'external' version
    const notesDiskPath = path.join(wsPath, 'notes.txt');
    fs.writeFileSync(notesDiskPath, 'Line one\nExternally edited line two\n');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(notesDiskPath, future, future);

    const readAfterExternal = await runTool('read_file', { path: 'notes.txt' }, deps);
    expect(readAfterExternal.isError).toBe(false);
    expect(readAfterExternal.output).toContain('Externally edited line two');

    notesVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'notes.txt').versions;
    expect(notesVersions).toHaveLength(2);
    expect(notesVersions[0]!.actor).toBe('external');
    expect(notesVersions[0]!.prevSha256).toBe(notesVersions[1]!.sha256);

    // 7. Rename notes.txt -> archive/notes-renamed.txt via rename_file tool -> 1 version row recording fromRelPath
    const renameToolRes = await runTool(
      'rename_file',
      { path: 'notes.txt', newPath: 'archive/notes-renamed.txt' },
      { ...deps, plannerToolUseId: 'tool-5' },
    );
    expect(renameToolRes.isError).toBe(false);
    const renamedVersions = t.context.docWorkspaces.listFileVersions(ws.id, 'archive/notes-renamed.txt').versions;
    expect(renamedVersions.length).toBeGreaterThanOrEqual(3); // carries history from notes.txt + the move version
    expect(renamedVersions[0]!.fromRelPath).toBe('notes.txt');
    expect(renamedVersions[0]!.summary).toContain('Moved notes.txt → archive/notes-renamed.txt');

    // 8. Delete archive/notes-renamed.txt via delete_file tool -> moves to trash (tombstone=true) with blob preserved
    const deleteToolRes = await runTool(
      'delete_file',
      { path: 'archive/notes-renamed.txt' },
      { ...deps, plannerToolUseId: 'tool-6' },
    );
    expect(deleteToolRes.isError).toBe(false);
    expect(fs.existsSync(path.join(wsPath, 'archive', 'notes-renamed.txt'))).toBe(false);

    const afterDeleteVersions = t.context.docWorkspaces.listFileVersions(
      ws.id,
      'archive/notes-renamed.txt',
    ).versions;
    expect(afterDeleteVersions[0]!.tombstone).toBe(true);
    expect(afterDeleteVersions[0]!.sha256).toBe(afterDeleteVersions[0]!.prevSha256);
    const deletedBlob = t.context.docWorkspaces.readVersionBlob(ws.id, afterDeleteVersions[0]!.id);
    expect(fs.readFileSync(deletedBlob.blobPath, 'utf8')).toBe('Line one\nExternally edited line two\n');
  });

  it('isolates the version blob store outside the workspace so planner file tools cannot read, modify, or delete version history', async () => {
    const wsPath = path.join(hostDir, 'isolated-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'doc.txt'), 'Initial secret v1\n');

    const ws = (await post('/api/doc-workspaces', { path: wsPath })).json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    const deps = depsForDocWs(t, ws, { plannerChatId: 'chat-iso' });
    await runTool('read_file', { path: 'doc.txt' }, deps);
    await runTool('write_file', { path: 'doc.txt', content: 'Updated v2\n' }, deps);

    const versionsDir = path.join(t.workspaceRoot, 'doc-workspaces', ws.id, 'versions');
    expect(fs.existsSync(versionsDir)).toBe(true);
    const blobFiles = fs.readdirSync(versionsDir);
    expect(blobFiles.length).toBeGreaterThanOrEqual(2);
    const targetBlobPath = path.join(versionsDir, blobFiles[0]!);
    const relEscape = path.relative(wsPath, targetBlobPath);

    // Every planner file tool must refuse or exclude the version store path
    for (const candidatePath of [targetBlobPath, relEscape, versionsDir]) {
      const readAttempt = await runTool('read_file', { path: candidatePath }, deps);
      expect(readAttempt.isError).toBe(true);

      const writeAttempt = await runTool(
        'write_file',
        { path: candidatePath, content: 'corrupted' },
        deps,
      );
      expect(writeAttempt.isError).toBe(true);

      const editAttempt = await runTool(
        'edit_file',
        { path: candidatePath, edits: [{ oldText: 'Initial', newText: 'Hacked' }] },
        deps,
      );
      expect(editAttempt.isError).toBe(true);

      const deleteAttempt = await runTool('delete_file', { path: candidatePath }, deps);
      expect(deleteAttempt.isError).toBe(true);

      const listAttempt = await runTool('list_dir', { path: candidatePath }, deps);
      expect(listAttempt.isError).toBe(true);
    }

    // Verify the blob on disk is completely intact
    expect(fs.existsSync(targetBlobPath)).toBe(true);
  });

  it('supports History UI endpoints: list versions, download version, compare (xlsx cell diff, docx/pdf derived text diff, text line diff), restore version, and trash view + restore', async () => {
    const wsPath = path.join(hostDir, 'history-ui-ws');
    fs.mkdirSync(wsPath, { recursive: true });

    // Create initial files: xlsx, docx, pdf, txt
    fs.writeFileSync(
      path.join(wsPath, 'table.xlsx'),
      makeXlsx({ Main: [['Metric', 'Q1'], ['Revenue', 100]] }),
    );
    fs.writeFileSync(path.join(wsPath, 'agreement.docx'), makeDocx(['Clause 1: Original term']));
    fs.writeFileSync(path.join(wsPath, 'brief.pdf'), makePdf(['Page 1 Original PDF']));
    fs.writeFileSync(path.join(wsPath, 'notes.md'), 'Alpha\nBeta\n');

    const ws = (await post('/api/doc-workspaces', { path: wsPath })).json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    // Upload replacement for each file so we have 2 versions of each
    await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?name=table.xlsx`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/octet-stream' },
      payload: makeXlsx({ Main: [['Metric', 'Q1'], ['Revenue', 250]] }),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?name=agreement.docx`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/octet-stream' },
      payload: makeDocx(['Clause 1: Amended term']),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?name=brief.pdf`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'application/pdf' },
      payload: makePdf(['Page 1 Updated PDF']),
    });
    await t.app.inject({
      method: 'POST',
      url: `/api/doc-workspaces/${ws.id}/files/upload?name=notes.md`,
      headers: { ...authHeaders(t.cookie), 'content-type': 'text/markdown' },
      payload: 'Alpha\nBeta Modified\nGamma\n',
    });

    // Wait for background extraction of the uploaded replacements so compare can use derived text
    await t.context.docWorkspaces.scheduleScan(ws.id);

    // 1. Compare xlsx versions -> cellChanges
    const xlsxVerRes = await get(`/api/doc-workspaces/${ws.id}/files/versions?path=table.xlsx`);
    expect(xlsxVerRes.statusCode).toBe(200);
    const xlsxVersions = xlsxVerRes.json().versions;
    expect(xlsxVersions.length).toBeGreaterThanOrEqual(1);
    const latestXlsxVer = xlsxVersions[0]!;
    const xlsxCmpRes = await get(
      `/api/doc-workspaces/${ws.id}/versions/compare?to=${latestXlsxVer.id}`,
    );
    expect(xlsxCmpRes.statusCode).toBe(200);
    const xlsxCmp = xlsxCmpRes.json();
    expect(xlsxCmp.kind).toBe('xlsx');
    expect(xlsxCmp.cellChanges).toEqual([
      { sheet: 'Main', cell: 'B2', before: '100', after: '250' },
    ]);

    // 2. Compare docx versions -> derived text diffLines
    const docxVersions = (
      await get(`/api/doc-workspaces/${ws.id}/files/versions?path=agreement.docx`)
    ).json().versions;
    const docxCmpRes = await get(
      `/api/doc-workspaces/${ws.id}/versions/compare?to=${docxVersions[0].id}`,
    );
    expect(docxCmpRes.statusCode).toBe(200);
    const docxCmp = docxCmpRes.json();
    expect(docxCmp.kind).toBe('docx');
    expect(docxCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'del' && l.text.includes('Original term'))).toBe(true);
    expect(docxCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'add' && l.text.includes('Amended term'))).toBe(true);

    // 3. Compare pdf versions -> derived text diffLines
    const pdfVersions = (
      await get(`/api/doc-workspaces/${ws.id}/files/versions?path=brief.pdf`)
    ).json().versions;
    const pdfCmpRes = await get(
      `/api/doc-workspaces/${ws.id}/versions/compare?to=${pdfVersions[0].id}`,
    );
    expect(pdfCmpRes.statusCode).toBe(200);
    const pdfCmp = pdfCmpRes.json();
    expect(pdfCmp.kind).toBe('pdf');
    expect(pdfCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'del' && l.text.includes('Original PDF'))).toBe(true);
    expect(pdfCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'add' && l.text.includes('Updated PDF'))).toBe(true);

    // 4. Compare text versions -> line diff
    const mdVersions = (
      await get(`/api/doc-workspaces/${ws.id}/files/versions?path=notes.md`)
    ).json().versions;
    const mdCmpRes = await get(
      `/api/doc-workspaces/${ws.id}/versions/compare?to=${mdVersions[0].id}`,
    );
    expect(mdCmpRes.statusCode).toBe(200);
    const mdCmp = mdCmpRes.json();
    expect(mdCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'del' && l.text === 'Beta')).toBe(true);
    expect(mdCmp.diffLines.some((l: { type: string; text: string }) => l.type === 'add' && l.text === 'Beta Modified')).toBe(true);

    // 5. Download a specific version
    const dlRes = await get(`/api/doc-workspaces/${ws.id}/versions/${mdVersions[0].id}/download`);
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.payload).toBe('Alpha\nBeta Modified\nGamma\n');

    // 6. Restore previous version of notes.md -> creates a new version row and restores disk content
    const restoreRes = await post(
      `/api/doc-workspaces/${ws.id}/versions/${mdVersions[0].id}/restore`,
      { target: 'previous' },
    );
    expect(restoreRes.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(wsPath, 'notes.md'), 'utf8')).toBe('Alpha\nBeta\n');
    const mdVersionsAfterRestore = (
      await get(`/api/doc-workspaces/${ws.id}/files/versions?path=notes.md`)
    ).json().versions;
    expect(mdVersionsAfterRestore.length).toBe(mdVersions.length + 1);
    expect(mdVersionsAfterRestore[0].summary).toContain('Restored');

    // 7. Delete notes.md -> appears in Trash -> restore from Trash
    const delRes = await del(`/api/doc-workspaces/${ws.id}/files?path=notes.md`);
    expect(delRes.statusCode).toBe(200);
    expect(fs.existsSync(path.join(wsPath, 'notes.md'))).toBe(false);

    const trashRes = await get(`/api/doc-workspaces/${ws.id}/trash`);
    expect(trashRes.statusCode).toBe(200);
    const trashEntries = trashRes.json().entries;
    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0].relPath).toBe('notes.md');

    const trashRestoreRes = await post(`/api/doc-workspaces/${ws.id}/trash/restore`, {
      versionId: trashEntries[0].versionId,
    });
    expect(trashRestoreRes.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(wsPath, 'notes.md'), 'utf8')).toBe('Alpha\nBeta\n');

    const trashAfterRes = await get(`/api/doc-workspaces/${ws.id}/trash`);
    expect(trashAfterRes.json().entries).toHaveLength(0);
  });

  it('enforces optimistic concurrency baseVersion checks across mutating tools and tracks per-chat last-read versions', async () => {
    const wsPath = path.join(hostDir, 'concurrency-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    const xlsxPath = path.join(wsPath, 'budget.xlsx');
    fs.writeFileSync(xlsxPath, makeXlsx({ Summary: [['Dept', 'Amount'], ['R&D', 500]] }));
    const txtPath = path.join(wsPath, 'plan.txt');
    fs.writeFileSync(txtPath, 'Original line\n');

    const ws = (await post('/api/doc-workspaces', { path: wsPath })).json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    const chatA = t.context.plannerChats.create({ title: 'Chat A', docWorkspaceId: ws.id });
    const chatB = t.context.plannerChats.create({ title: 'Chat B', docWorkspaceId: ws.id });
    const depsA = depsForDocWs(t, ws, { plannerChatId: chatA.id, plannerTurnId: 't1' });
    const depsB = depsForDocWs(t, ws, { plannerChatId: chatB.id, plannerTurnId: 't2' });

    // Mutating an existing file without reading it first and without baseVersion is refused
    const unreadEdit = await runTool(
      'edit_file',
      { path: 'plan.txt', edits: [{ oldText: 'Original line', newText: 'Changed' }] },
      depsA,
    );
    expect(unreadEdit.isError).toBe(true);
    expect(unreadEdit.output).toContain('re-read it first');

    // Chat A reads plan.txt and budget.xlsx -> version hash is returned and tracked per chat
    const readPlanA = await runTool('read_file', { path: 'plan.txt' }, depsA);
    expect(readPlanA.isError).toBe(false);
    const planVersionMatch = readPlanA.output.match(/version=([0-9a-f]{64})/);
    expect(planVersionMatch).toBeTruthy();
    const initialPlanVersion = planVersionMatch![1]!;

    const readSheetA = await runTool('sheet_read', { path: 'budget.xlsx', sheet: 'Summary' }, depsA);
    expect(readSheetA.isError).toBe(false);
    const sheetVersionMatch = readSheetA.output.match(/version=([0-9a-f]{64})/);
    expect(sheetVersionMatch).toBeTruthy();
    const initialSheetVersion = sheetVersionMatch![1]!;

    // Missing baseVersion succeeds when file is unchanged since Chat A last read it
    const editPlanOk = await runTool(
      'edit_file',
      { path: 'plan.txt', edits: [{ oldText: 'Original line', newText: 'Updated by A' }] },
      depsA,
    );
    expect(editPlanOk.isError).toBe(false);

    // Now simulate an external edit on budget.xlsx on disk
    fs.writeFileSync(xlsxPath, makeXlsx({ Summary: [['Dept', 'Amount'], ['R&D', 999]] }));
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(xlsxPath, future, future);

    // Chat A tries to sheet_edit budget.xlsx with its stale baseVersion (or omitted baseVersion) -> refused with actor & time!
    const staleSheetEdit = await runTool(
      'sheet_edit',
      {
        path: 'budget.xlsx',
        baseVersion: initialSheetVersion,
        edits: [{ sheet: 'Summary', cell: 'B2', value: 777 }],
      },
      depsA,
    );
    expect(staleSheetEdit.isError).toBe(true);
    expect(staleSheetEdit.output).toMatch(
      /budget\.xlsx changed since you read it \(changed by: external, \d{2}:\d{2}\); re-read it first/,
    );

    // Chat B reads plan.txt, then Chat A modifies plan.txt -> Chat B's edit without re-reading is refused
    await runTool('read_file', { path: 'plan.txt' }, depsB);
    await runTool(
      'write_file',
      { path: 'plan.txt', content: 'Updated again by A\n' },
      depsA,
    );
    const staleEditB = await runTool(
      'write_file',
      { path: 'plan.txt', content: 'Overwrite from B\n' },
      depsB,
    );
    expect(staleEditB.isError).toBe(true);
    expect(staleEditB.output).toMatch(/plan\.txt changed since you read it \(changed by: .*\); re-read it first/);

    // Stale baseVersion on rename_file and delete_file is also refused
    const staleRename = await runTool(
      'rename_file',
      { path: 'plan.txt', newPath: 'plan-renamed.txt', baseVersion: initialPlanVersion },
      depsA,
    );
    expect(staleRename.isError).toBe(true);
    expect(staleRename.output).toContain('changed since you read it');

    const staleDelete = await runTool(
      'delete_file',
      { path: 'plan.txt', baseVersion: initialPlanVersion },
      depsA,
    );
    expect(staleDelete.isError).toBe(true);
    expect(staleDelete.output).toContain('changed since you read it');
  });

  it('undoes a turn across created, modified, deleted, and renamed files, skips post-turn conflicts unless confirmed, and supports Telegram /undo', async () => {
    const wsPath = path.join(hostDir, 'undo-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'modify-me.txt'), 'Before turn content\n');
    fs.writeFileSync(path.join(wsPath, 'delete-me.txt'), 'Keep me safe\n');
    fs.writeFileSync(path.join(wsPath, 'rename-me.txt'), 'Moving file body\n');
    fs.writeFileSync(path.join(wsPath, 'conflict.txt'), 'Conflict v0\n');

    const ws = (await post('/api/doc-workspaces', { path: wsPath })).json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    const chat = t.context.plannerChats.create({ title: 'Undo Chat', docWorkspaceId: ws.id });
    const turnId = 'turn-to-undo';
    const deps = depsForDocWs(t, ws, { plannerChatId: chat.id, plannerTurnId: turnId });

    // Read existing files first
    await runTool('read_file', { path: 'modify-me.txt' }, deps);
    await runTool('read_file', { path: 'delete-me.txt' }, deps);
    await runTool('read_file', { path: 'rename-me.txt' }, deps);
    await runTool('read_file', { path: 'conflict.txt' }, deps);

    // Execute turn mutations:
    // 1) modify existing file
    await runTool('write_file', { path: 'modify-me.txt', content: 'During turn content\n' }, deps);
    // 2) create brand-new file
    await runTool('write_file', { path: 'created-in-turn.txt', content: 'New file\n' }, deps);
    // 3) delete existing file
    await runTool('delete_file', { path: 'delete-me.txt' }, deps);
    // 4) rename existing file
    await runTool(
      'rename_file',
      { path: 'rename-me.txt', newPath: 'renamed/moved.txt' },
      deps,
    );
    // 5) modify conflict.txt during turn, and then modify it externally AFTER the turn
    await runTool('write_file', { path: 'conflict.txt', content: 'Conflict v1 (turn)\n' }, deps);

    expect(t.context.docWorkspaces.listTurnChangedFiles(turnId)).toHaveLength(5);

    // External modification to conflict.txt after the turn
    const conflictDiskPath = path.join(wsPath, 'conflict.txt');
    fs.writeFileSync(conflictDiskPath, 'Conflict v2 (external edit after turn)\n');
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(conflictDiskPath, future, future);

    // Call POST /api/planner/chats/:id/turns/:turnId/undo without confirm -> restores 4 files, skips conflict.txt
    const undoRes = await post(`/api/planner/chats/${chat.id}/turns/${turnId}/undo`, {
      confirm: false,
    });
    expect(undoRes.statusCode).toBe(200);
    const undoBody = undoRes.json();
    expect(undoBody.skippedConflicts).toHaveLength(1);
    expect(undoBody.skippedConflicts[0].relPath).toBe('conflict.txt');
    expect(undoBody.restoredPaths.sort()).toEqual([
      'created-in-turn.txt',
      'delete-me.txt',
      'modify-me.txt',
      'rename-me.txt',
    ]);

    // Verify disk state of the 4 restored files + the 1 skipped conflict file
    expect(fs.readFileSync(path.join(wsPath, 'modify-me.txt'), 'utf8')).toBe('Before turn content\n');
    expect(fs.existsSync(path.join(wsPath, 'created-in-turn.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(wsPath, 'delete-me.txt'), 'utf8')).toBe('Keep me safe\n');
    expect(fs.readFileSync(path.join(wsPath, 'rename-me.txt'), 'utf8')).toBe('Moving file body\n');
    expect(fs.existsSync(path.join(wsPath, 'renamed', 'moved.txt'))).toBe(false);
    expect(fs.readFileSync(conflictDiskPath, 'utf8')).toBe('Conflict v2 (external edit after turn)\n');

    // Now call undo with confirm: true -> restores conflict.txt to 'Conflict v0\n' as well
    const forceUndoRes = await post(`/api/planner/chats/${chat.id}/turns/${turnId}/undo`, {
      confirm: true,
    });
    expect(forceUndoRes.statusCode).toBe(200);
    expect(forceUndoRes.json().skippedConflicts).toHaveLength(0);
    expect(fs.readFileSync(conflictDiskPath, 'utf8')).toBe('Conflict v0\n');

    // Verify Telegram /undo slash command produces the confirmation prompt and inline keyboard, and confirming restores the file
    expect(interceptSlashCommand('/undo')).toBe('undo');
    await runTool(
      'write_file',
      { path: 'modify-me.txt', content: 'Turn 2 change for telegram undo\n' },
      depsForDocWs(t, ws, { plannerChatId: chat.id, plannerTurnId: 'turn-tg' }),
    );
    expect(fs.readFileSync(path.join(wsPath, 'modify-me.txt'), 'utf8')).toBe('Turn 2 change for telegram undo\n');

    const sentMessages: Array<{ chatId: string; text: string; opts?: unknown }> = [];
    const fakeTgClient = {
      sendMessage: async (chatId: string, text: string, opts?: unknown) => {
        sentMessages.push({ chatId, text, opts });
        return { message_id: sentMessages.length };
      },
      answerCallbackQuery: async () => {},
    } as unknown as TelegramClient;

    const bridge = new TelegramBridge({
      links: {
        get: () => ({
          botId: 'bot-1',
          telegramChatId: '12345',
          telegramUserLabel: 'Test',
          workspaceId: t.context.plannerWorkspaces.getDefault()!.id,
          workspaceName: 'Default',
          plannerChatId: chat.id,
          skipToolApprovals: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        touchLabel: () => {},
        setPlannerChatId: () => {},
      } as unknown as typeof t.context.telegramLinks,
      plannerChats: t.context.plannerChats,
      mcpRegistry: t.context.mcpRegistry,
    });

    await bridge.handleUpdate(
      'bot-1',
      {
        update_id: 1,
        message: { message_id: 10, chat: { id: 12345, type: 'private' }, text: '/undo' },
      },
      fakeTgClient,
    );
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toContain("Undo the last turn's changes");
    expect(sentMessages[0]!.text).toContain('modify-me.txt');
    const replyMarkup = (sentMessages[0]!.opts as { replyMarkup?: { inline_keyboard: Array<Array<{ callback_data: string }>> } })?.replyMarkup;
    expect(replyMarkup?.inline_keyboard[0]?.[0]?.callback_data).toBe('undo:turn-tg:confirm');

    await bridge.handleUpdate(
      'bot-1',
      {
        update_id: 2,
        callback_query: {
          id: 'cb-1',
          data: 'undo:turn-tg:confirm',
          message: { message_id: 11, chat: { id: 12345, type: 'private' } },
        },
      },
      fakeTgClient,
    );
    expect(fs.readFileSync(path.join(wsPath, 'modify-me.txt'), 'utf8')).toBe('Before turn content\n');
    expect(sentMessages.at(-1)?.text).toContain('Undone (1 file restored: modify-me.txt)');
  });

  it('prunes old versions according to retention rules while preserving open-undo versions and latest file versions', async () => {
    const wsPath = path.join(hostDir, 'retention-ws');
    fs.mkdirSync(wsPath, { recursive: true });
    fs.writeFileSync(path.join(wsPath, 'log.txt'), 'v0\n');

    const ws = (await post('/api/doc-workspaces', { path: wsPath })).json();
    await t.context.docWorkspaces.scheduleScan(ws.id);

    const deps = depsForDocWs(t, ws, { plannerChatId: 'chat-ret' });
    await runTool('read_file', { path: 'log.txt' }, deps);

    // Create 3 versions that we backdate to 45 days ago on the same UTC day (null turn_id = manual/external edits),
    // plus 1 version from an open undo turn (turn_id = 'protected-turn') on that same old day, plus 1 recent version.
    const FortyFiveDaysMs = 45 * 86_400_000;
    const sameOldDayBase = Math.floor((Date.now() - FortyFiveDaysMs) / 86_400_000) * 86_400_000 + 3600_000;

    await runTool('write_file', { path: 'log.txt', content: 'v1 old morning\n' }, deps);
    await runTool('write_file', { path: 'log.txt', content: 'v2 old noon\n' }, deps);
    await runTool('write_file', { path: 'log.txt', content: 'v3 old Protected Turn\n' }, { ...deps, plannerTurnId: 'protected-turn' });
    await runTool('write_file', { path: 'log.txt', content: 'v4 recent\n' }, deps);

    const allBefore = t.context.docWorkspaces.listFileVersions(ws.id, 'log.txt').versions;
    expect(allBefore).toHaveLength(4);
    // Versions are returned newest-first: [v4, v3, v2, v1]
    const v4 = allBefore[0]!;
    const v3 = allBefore[1]!;
    const v2 = allBefore[2]!;
    const v1 = allBefore[3]!;

    // Backdate v1, v2, v3 to the same UTC day 45 days ago; make v3 (protected by open undo) older than v2 (newest of day)
    t.context.db
      .prepare('UPDATE doc_file_versions SET created_at = ? WHERE id = ?')
      .run(sameOldDayBase + 500, v3.id);
    t.context.db
      .prepare('UPDATE doc_file_versions SET created_at = ? WHERE id = ?')
      .run(sameOldDayBase + 1000, v1.id);
    t.context.db
      .prepare('UPDATE doc_file_versions SET created_at = ? WHERE id = ?')
      .run(sameOldDayBase + 2000, v2.id);

    const pruneResult = t.context.docWorkspaces.pruneVersions(ws.id);
    expect(pruneResult.prunedVersions).toBe(1); // v1 is pruned; v2 (newest of day), v3 (open undo turn), and v4 (recent) survive!

    const remainingIds = new Set(
      t.context.docWorkspaces.listFileVersions(ws.id, 'log.txt').versions.map((v) => v.id),
    );
    expect(remainingIds.has(v1.id)).toBe(false);
    expect(remainingIds.has(v2.id)).toBe(true);
    expect(remainingIds.has(v3.id)).toBe(true);
    expect(remainingIds.has(v4.id)).toBe(true);
  });

  it('enforces the seventh approval override (per-workspace autoApproveEdits): only workspace-contained file mutations auto-approve, never writes remembered decisions, requires version store, and never covers bash or outside paths', async () => {
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let callCounter = 0;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      const next = toolCalls.shift();
      if (next) {
        callCounter += 1;
        return fakeToolCallResponse(next.name, next.args, `call_${callCounter}`);
      }
      return fakeCompletionResponse('Done.');
    });

    const appWithLlm = await createTestApp(
      {},
      undefined,
      undefined,
      undefined,
      fetchImpl as unknown as typeof fetch,
    );
    try {
      await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' }, appWithLlm);

      const wsPath = path.join(hostDir, 'auto-approve-ws');
      fs.mkdirSync(wsPath, { recursive: true });

      // Default is autoApproveEdits: false
      const createRes = await post('/api/doc-workspaces', { path: wsPath }, appWithLlm);
      expect(createRes.statusCode).toBe(201);
      const ws = createRes.json();
      expect(ws.autoApproveEdits).toBe(false);

      // Enable autoApproveEdits on workspace
      const enableRes = await patch(
        `/api/doc-workspaces/${ws.id}`,
        { autoApproveEdits: true },
        appWithLlm,
      );
      expect(enableRes.statusCode).toBe(200);
      expect(enableRes.json().autoApproveEdits).toBe(true);

      const chat = (
        await post(
          '/api/planner/chats',
          { title: 'Auto Approve Chat', docWorkspaceId: ws.id, modelId: 'gpt-4o' },
          appWithLlm,
        )
      ).json();
      expect(chat.docWorkspaceAutoApproveEdits).toBe(true);
      expect(chat.skipToolApprovalsEnabled).toBe(false);

      // 1. write_file inside workspace runs WITHOUT pausing for approval (`permission_request` is not emitted) and records a version + turn_complete changedFiles
      toolCalls.push({
        name: 'write_file',
        args: { path: 'inside.txt', content: 'Auto-approved content\n' },
      });
      const turn1Res = await post(
        `/api/planner/chats/${chat.id}/messages`,
        { content: 'Write inside.txt' },
        appWithLlm,
      );
      const turn1Events = parseSseEvents(turn1Res);
      expect(turn1Events.find((e) => e.kind === 'permission_request')).toBeUndefined();
      const toolResult1 = turn1Events.find((e) => e.kind === 'tool_result');
      expect(toolResult1?.isError).toBe(false);
      const turnEnd1 = turn1Events.find((e) => e.kind === 'turn_complete');
      expect(Array.isArray(turnEnd1?.changedFiles)).toBe(true);
      expect((turnEnd1?.changedFiles as unknown[]).length).toBe(1);
      expect(turnEnd1?.turnId).toBeTruthy();

      // Verify version was recorded with agent:<chat.id>
      const insideVersions = appWithLlm.context.docWorkspaces.listFileVersions(ws.id, 'inside.txt').versions;
      expect(insideVersions).toHaveLength(1);
      expect(insideVersions[0]!.actor).toBe(`agent:${chat.id}`);

      // Verify NO remembered decision was written to planner_tool_approvals
      const approvalsList = (await get('/api/planner/tool-approvals', appWithLlm)).json().approvals;
      expect(approvalsList).toEqual([]);

      // 2. bash / exec_command is NEVER covered by workspace auto-approve -> pauses on permission_request
      toolCalls.push({
        name: 'bash',
        args: { command: 'echo should-ask-approval' },
      });
      const bashTurnRes = await post(
        `/api/planner/chats/${chat.id}/messages`,
        { content: 'Run bash' },
        appWithLlm,
      );
      const bashEvents = parseSseEvents(bashTurnRes);
      const bashApproval = bashEvents.find((e) => e.kind === 'permission_request');
      expect(bashApproval).toBeDefined();
      expect(bashApproval?.toolName).toBe('bash');
      // Deny it to finish the turn cleanly
      await post(
        `/api/planner/chats/${chat.id}/approvals/${bashApproval!.id as string}`,
        { decision: 'deny' },
        appWithLlm,
      );

      // 3. write_file targeting a path OUTSIDE the workspace is NEVER covered -> pauses on permission_request
      const outsidePath = path.join(hostDir, 'outside-secret.txt');
      toolCalls.push({
        name: 'write_file',
        args: { path: outsidePath, content: 'Outside workspace' },
      });
      const outsideTurnRes = await post(
        `/api/planner/chats/${chat.id}/messages`,
        { content: 'Write outside' },
        appWithLlm,
      );
      const outsideEvents = parseSseEvents(outsideTurnRes);
      const outsideApproval = outsideEvents.find((e) => e.kind === 'permission_request');
      expect(outsideApproval).toBeDefined();
      await post(
        `/api/planner/chats/${chat.id}/approvals/${outsideApproval!.id as string}`,
        { decision: 'deny' },
        appWithLlm,
      );

      // 4. If version store becomes unavailable, auto-approve is refused at runtime AND cannot be enabled via PATCH
      appWithLlm.context.docWorkspaces.setVersionStoreAvailableForTest(ws.id, false);
      toolCalls.push({
        name: 'write_file',
        args: { path: 'inside-2.txt', content: 'Should pause when version store unavailable' },
      });
      const unavailableTurnRes = await post(
        `/api/planner/chats/${chat.id}/messages`,
        { content: 'Write inside-2' },
        appWithLlm,
      );
      const unavailableEvents = parseSseEvents(unavailableTurnRes);
      const unavailableApproval = unavailableEvents.find((e) => e.kind === 'permission_request');
      expect(unavailableApproval).toBeDefined();
      await post(
        `/api/planner/chats/${chat.id}/approvals/${unavailableApproval!.id as string}`,
        { decision: 'deny' },
        appWithLlm,
      );

      // Turning autoApproveEdits off and then trying to turn it back on while version store is unavailable returns 400
      await patch(`/api/doc-workspaces/${ws.id}`, { autoApproveEdits: false }, appWithLlm);
      const failEnableRes = await patch(
        `/api/doc-workspaces/${ws.id}`,
        { autoApproveEdits: true },
        appWithLlm,
      );
      expect(failEnableRes.statusCode).toBe(400);
      expect(failEnableRes.json().error.message).toContain('version store');

      // Restore version store availability, keep autoApproveEdits: false -> next inside write_file asks for approval immediately
      appWithLlm.context.docWorkspaces.setVersionStoreAvailableForTest(ws.id, true);
      toolCalls.push({
        name: 'write_file',
        args: { path: 'inside-3.txt', content: 'Should ask because toggle is now off' },
      });
      const toggleOffTurnRes = await post(
        `/api/planner/chats/${chat.id}/messages`,
        { content: 'Write inside-3' },
        appWithLlm,
      );
      const toggleOffEvents = parseSseEvents(toggleOffTurnRes);
      const toggleOffApproval = toggleOffEvents.find((e) => e.kind === 'permission_request');
      expect(toggleOffApproval).toBeDefined();
      await post(
        `/api/planner/chats/${chat.id}/approvals/${toggleOffApproval!.id as string}`,
        { decision: 'deny' },
        appWithLlm,
      );
    } finally {
      await appWithLlm.cleanup();
    }
  });
});

