import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_CSP, ARTIFACT_CSP } from '../src/security-headers.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

describe('planner artifacts (PA-128)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const del = (url: string) => t.app.inject({ method: 'DELETE', url, headers: authHeaders(t.cookie) });

  it('lists artifacts for default workspace and chat', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'plan.md'), '# Implementation Plan\n\nStep 1...');
    await fs.writeFile(path.join(artifactsDir, '.hidden.txt'), 'hidden content');

    // Create a subfolder with another artifact
    await fs.mkdir(path.join(artifactsDir, 'reports'), { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'reports', 'summary.html'), '<html><body>Summary</body></html>');

    // Workspace endpoint
    const wsRes = await get(`/api/planner/workspaces/${ws.id}/artifacts`);
    expect(wsRes.statusCode).toBe(200);
    const wsData = wsRes.json();
    expect(wsData.artifacts).toHaveLength(2);
    expect(wsData.artifacts.some((a: { name: string }) => a.name === 'plan.md')).toBe(true);
    expect(wsData.artifacts.some((a: { name: string }) => a.name === 'reports/summary.html')).toBe(true);
    expect(wsData.artifacts.some((a: { name: string }) => a.name.includes('.hidden'))).toBe(false);

    // Chat endpoint
    const chat = t.context.plannerChats.create({ workspaceId: ws.id, title: 'Test Chat' });
    const chatRes = await get(`/api/planner/chats/${chat.id}/artifacts`);
    expect(chatRes.statusCode).toBe(200);
    const chatData = chatRes.json();
    expect(chatData.artifacts).toHaveLength(2);
  });

  it('serves artifact contents inline for viewable files and attachment for download', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'plan.md'), '# Plan MD Content');

    // Inline view
    const viewRes = await get(`/api/planner/workspaces/${ws.id}/artifacts/file?name=plan.md`);
    expect(viewRes.statusCode).toBe(200);
    expect(viewRes.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(viewRes.headers['content-disposition']).toContain('inline');
    expect(viewRes.body).toBe('# Plan MD Content');

    // Download flag
    const dlRes = await get(`/api/planner/workspaces/${ws.id}/artifacts/file?name=plan.md&download=1`);
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers['content-disposition']).toContain('attachment');
    expect(dlRes.body).toBe('# Plan MD Content');
  });

  it('serves an artifact under a sandboxed CSP that lets inline script run on an opaque origin', async () => {
    // Self-contained animated HTML played from disk but sat still in the
    // panel: the app's CSP (script-src 'self') blocked its inline <script>.
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'anim.html'), '<script>requestAnimationFrame(() => {})</script>');

    const res = await get(`/api/planner/workspaces/${ws.id}/artifacts/file?name=anim.html`);
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toBe(ARTIFACT_CSP);
    expect(csp).toContain('sandbox allow-scripts');
    // Without this the script would run as the logged-in operator.
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("connect-src 'none'");

    // Everything else, including an artifact route's own error, keeps the app's policy.
    expect((await get('/api/planner/workspaces')).headers['content-security-policy']).toBe(APP_CSP);
    const missing = await get(`/api/planner/workspaces/${ws.id}/artifacts/file?name=nope.html`);
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-security-policy']).toBe(APP_CSP);
  });

  it('rejects path traversal attempts on artifact download and deletion', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });

    // File outside artifacts
    const secretFile = path.join(ws.path, 'secret.txt');
    await fs.writeFile(secretFile, 'sensitive data');

    // Attempt traversal via GET
    const getTraversal = await get(`/api/planner/workspaces/${ws.id}/artifacts/file?name=../secret.txt`);
    expect(getTraversal.statusCode).toBe(403);

    // Attempt traversal via DELETE
    const delTraversal = await del(`/api/planner/workspaces/${ws.id}/artifacts/file?name=../secret.txt`);
    expect(delTraversal.statusCode).toBe(403);

    // Verify secret file is intact
    const content = await fs.readFile(secretFile, 'utf8');
    expect(content).toBe('sensitive data');
  });

  it('deletes an artifact successfully', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    const filePath = path.join(artifactsDir, 'to-delete.txt');
    await fs.writeFile(filePath, 'delete me');

    const chat = t.context.plannerChats.create({ workspaceId: ws.id, title: 'Chat' });
    const delRes = await del(`/api/planner/chats/${chat.id}/artifacts/file?name=to-delete.txt`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json()).toEqual({ ok: true });

    // Verify file is gone on disk
    await expect(fs.stat(filePath)).rejects.toThrow();

    // Second delete returns 404
    const delAgain = await del(`/api/planner/chats/${chat.id}/artifacts/file?name=to-delete.txt`);
    expect(delAgain.statusCode).toBe(404);
  });

  it('auto-approves write_file and mkdir inside workspace artifacts/ directory', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const chat = t.context.plannerChats.create({ workspaceId: ws.id, title: 'Agent Chat' });

    // Use gateToolCall via PlannerChatService
    const chatsService = t.context.plannerChats as unknown as {
      gateToolCall: (
        chat: unknown,
        call: { id: string; type: 'function'; function: { name: string; arguments: string } },
      ) => { kind: string; tool?: unknown };
    };

    // 1. mkdir artifacts -> auto-approved
    const mkdirCall = {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'mkdir', arguments: JSON.stringify({ path: 'artifacts' }) },
    };
    const mkdirDecision = chatsService.gateToolCall(chat, mkdirCall);
    expect(mkdirDecision.kind).toBe('run');

    // 2. write_file in artifacts -> auto-approved
    const writeFileCall = {
      id: 'call_2',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: path.join(ws.path, 'artifacts', 'plan.md'), content: '# Plan' }),
      },
    };
    const writeDecision = chatsService.gateToolCall(chat, writeFileCall);
    expect(writeDecision.kind).toBe('run');

    // 3. write_file outside artifacts -> needs approval (standard invariant preserved!)
    const writeOutsideCall = {
      id: 'call_3',
      type: 'function' as const,
      function: {
        name: 'write_file',
        arguments: JSON.stringify({ path: path.join(ws.path, 'outside.md'), content: '# Outside' }),
      },
    };
    const outsideDecision = chatsService.gateToolCall(chat, writeOutsideCall);
    expect(outsideDecision.kind).toBe('needs_approval');
  });

  it('cleans all artifacts in workspace or chat', async () => {
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const artifactsDir = path.join(ws.path, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, 'file1.txt'), 'one');
    await fs.writeFile(path.join(artifactsDir, 'file2.txt'), 'two');

    const chat = t.context.plannerChats.create({
      workspaceId: ws.id,
      title: 'Chat With Multiple Artifacts',
    });

    const listRes1 = await get(`/api/planner/chats/${chat.id}/artifacts`);
    expect(listRes1.statusCode).toBe(200);
    const body1 = listRes1.json() as PlannerArtifactsResponse;
    expect(body1.artifacts.length).toBe(2);

    const cleanRes = await del(`/api/planner/chats/${chat.id}/artifacts`);
    expect(cleanRes.statusCode).toBe(200);
    const cleanBody = cleanRes.json() as DeletePlannerArtifactResponse;
    expect(cleanBody.ok).toBe(true);
    expect(cleanBody.count).toBe(2);

    const listRes2 = await get(`/api/planner/chats/${chat.id}/artifacts`);
    expect(listRes2.statusCode).toBe(200);
    const body2 = listRes2.json() as PlannerArtifactsResponse;
    expect(body2.artifacts.length).toBe(0);
  });
});
