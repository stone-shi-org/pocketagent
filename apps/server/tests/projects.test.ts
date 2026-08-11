import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '@pocketagent/protocol';
import { ProjectService, readGitBranch } from '../src/projects/index.js';
import { ConversationStore, encodeProjectDir } from '../src/conversations/index.js';
import { WorkspaceRegistry } from '../src/workspaces/index.js';
import { createTestApp, makeWorkspace, type TestApp } from './helpers.js';

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    title: 'A session',
    agent: 'shell',
    agentDisplayName: 'Shell',
    cwd: '/w',
    workspaceLabel: 'w',
    status: 'running',
    cols: 80,
    rows: 24,
    pid: 1,
    exitCode: null,
    exitSignal: null,
    createdAt: 1000,
    startedAt: 1000,
    endedAt: null,
    lastActivityAt: null,
    attachedClients: 0,
    epoch: 'e',
    backend: 'direct',
    transport: 'terminal',
    agentSessionId: null,
    durable: false,
    adopted: false,
    ...overrides,
  };
}

describe('readGitBranch', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/pa-git-');
    fs.mkdirSync(path.join(dir, '.git'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the branch from .git/HEAD without running git', async () => {
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/thing\n');
    expect(await readGitBranch(dir)).toBe('feature/thing');
  });

  it('reports no branch on a detached HEAD rather than a commit hash', async () => {
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), '9f3c1a2b3c4d5e6f\n');
    expect(await readGitBranch(dir)).toBeNull();
  });

  it('reports no branch outside a repository', async () => {
    expect(await readGitBranch('/tmp')).toBeNull();
  });
});

describe('ProjectService', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let projectsDir: string;
  let service: ProjectService;

  const writeTranscript = (cwd: string, id: string, title: string): void => {
    const dir = path.join(projectsDir, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      [
        { type: 'user', sessionId: id, cwd, message: { content: title } },
        { type: 'assistant', sessionId: id },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
  };

  beforeEach(() => {
    ws = makeWorkspace();
    projectsDir = fs.mkdtempSync('/tmp/pa-proj-');
    const workspaces = new WorkspaceRegistry([ws.root]);
    service = new ProjectService({
      workspaces,
      conversations: new ConversationStore({
        projectsDir,
        workspaces,
        listRunningCwds: async () => [],
      }),
      version: '9.9.9',
      hostname: 'stone-dev01.internal.example.com',
    });
  });
  afterEach(() => {
    ws.cleanup();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('identifies the host by its short name', () => {
    const host = service.host();
    expect(host.name).toBe('stone-dev01');
    expect(host.version).toBe('9.9.9');
    expect(host.online).toBe(true);
  });

  it('gives the host an id that survives a restart', () => {
    expect(service.host().id).toBe(service.host().id);
    expect(service.host().id).not.toBe('');
  });

  it('groups chats under the directory they happened in', async () => {
    const other = path.join(ws.root, 'other');
    fs.mkdirSync(other);
    const projects = await service.list([
      makeSession({ id: 'a', cwd: ws.project }),
      makeSession({ id: 'b', cwd: other }),
    ]);

    expect(projects).toHaveLength(2);
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(['other', 'project']);
    expect(projects.find((p) => p.name === 'project')?.chats.map((c) => c.id)).toEqual(['a']);
  });

  it('shows a live session and a past conversation side by side', async () => {
    writeTranscript(ws.project, 'conv-old', 'An older question');
    const [project] = await service.list([
      makeSession({ id: 'live', cwd: ws.project, lastActivityAt: 9_000_000_000_000 }),
    ]);

    expect(project?.chats.map((c) => c.id)).toEqual(['live', 'conv-old']);
    expect(project?.chats[0]).toMatchObject({ live: true, sessionId: 'live', status: 'running' });
    expect(project?.chats[1]).toMatchObject({
      live: false,
      sessionId: null,
      conversationId: 'conv-old',
      status: null,
    });
  });

  it('shows a resumed conversation once, as the live session', async () => {
    // The transcript and the session driving it are one chat. Listing both
    // would show a stale duplicate of the thing you are looking at.
    writeTranscript(ws.project, 'conv-1', 'Original');
    const [project] = await service.list([
      makeSession({ id: 'live', cwd: ws.project, agentSessionId: 'conv-1' }),
    ]);

    expect(project?.chats).toHaveLength(1);
    expect(project?.chats[0]).toMatchObject({
      sessionId: 'live',
      conversationId: 'conv-1',
      live: true,
    });
  });

  it('marks a finished session as not live but keeps it listed', async () => {
    const [project] = await service.list([
      makeSession({ id: 'done', cwd: ws.project, status: 'exited' }),
    ]);
    expect(project?.chats[0]).toMatchObject({ live: false, status: 'exited' });
  });

  it('falls back to creation time so a brand new chat is not sorted last', async () => {
    const [project] = await service.list([
      makeSession({ id: 'fresh', cwd: ws.project, createdAt: 5000, startedAt: null, lastActivityAt: null }),
    ]);
    expect(project?.chats[0]?.updatedAt).toBe(5000);
  });

  it('puts the most recently touched project first', async () => {
    const older = path.join(ws.root, 'older');
    fs.mkdirSync(older);
    const projects = await service.list([
      makeSession({ id: 'old', cwd: older, lastActivityAt: 1000 }),
      makeSession({ id: 'new', cwd: ws.project, lastActivityAt: 2000 }),
    ]);
    expect(projects.map((p) => p.name)).toEqual(['project', 'older']);
  });

  it('omits directories with nothing in them', async () => {
    expect(await service.list([])).toEqual([]);
  });

  it('reports the git branch for a project that has one', async () => {
    fs.mkdirSync(path.join(ws.project, '.git'));
    fs.writeFileSync(path.join(ws.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const [project] = await service.list([makeSession({ cwd: ws.project })]);
    expect(project).toMatchObject({ isGitRepo: true, gitBranch: 'main' });
  });
});

describe('GET /api/projects', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the host alongside the projects', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.host.name).toBeTruthy();
    expect(Array.isArray(body.projects)).toBe(true);
  });

  it('lists a session it just started, under its own directory', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(201);

    const res = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: t.cookie },
    });
    const project = res.json().projects.find((p: { cwd: string }) => p.cwd === t.projectDir);
    expect(project).toBeDefined();
    expect(project.chats.map((c: { sessionId: string }) => c.sessionId)).toContain(
      created.json().id,
    );
  });

  it('exposes one host today', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/hosts',
      headers: { cookie: t.cookie },
    });
    expect(res.json().hosts).toHaveLength(1);
  });
});

describe('GET /api/sessions/:id/history', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/sessions/whatever/history' });
    expect(res.statusCode).toBe(401);
  });

  it('is empty for a session that is not resuming anything', async () => {
    // A fresh session streams its own events; replaying them from disk as
    // "history" would render every message twice.
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/sessions/${created.json().id}/history`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });

  it('is empty rather than an error for an unknown session', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist/history',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toEqual([]);
  });
});
