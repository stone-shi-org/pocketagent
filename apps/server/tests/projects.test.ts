import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '@pocketagent/protocol';
import { ProjectService, readGitBranch } from '../src/projects/index.js';
import { ConversationStore, encodeProjectDir } from '../src/conversations/index.js';
import { hideChat, openDatabase } from '../src/db/index.js';
import { WorkspaceRegistry } from '../src/workspaces/index.js';
import { createTestApp, makeWorkspace, waitFor, type TestApp } from './helpers.js';

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
    skipPermissionsEnabled: false,
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

  it('follows a worktree .git file to find the branch', async () => {
    // A real `git worktree add` leaves `.git` as a *file* containing
    // `gitdir: <path>`, pointing at a directory under the main repo's
    // `.git/worktrees/<name>` that holds this worktree's own HEAD.
    const gitDir = fs.mkdtempSync('/tmp/pa-git-wt-');
    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/wt\n');
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    try {
      expect(await readGitBranch(dir)).toBe('feature/wt');
    } finally {
      fs.rmSync(gitDir, { recursive: true, force: true });
    }
  });
});

describe('ProjectService', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let projectsDir: string;
  let service: ProjectService;
  let db: ReturnType<typeof openDatabase>;

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
    db = openDatabase(':memory:');
    service = new ProjectService({
      workspaces,
      conversations: new ConversationStore({
        projectsDir,
        workspaces,
        listRunningCwds: async () => [],
      }),
      db,
      version: '9.9.9',
      hostname: 'workbench-01.internal.example.com',
    });
  });
  afterEach(() => {
    db.close();
    ws.cleanup();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('identifies the host by its short name', () => {
    const host = service.host();
    expect(host.name).toBe('workbench-01');
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

    expect(projects.find((p) => p.name === 'project')?.chats.map((c) => c.id)).toEqual(['a']);
    expect(projects.find((p) => p.name === 'other')?.chats.map((c) => c.id)).toEqual(['b']);
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

  it('collapses repeated resumes of the same chat into one row', async () => {
    // A non-forked resume keeps writing to the same transcript, but each
    // resume still mints a brand-new session row (finished ones are kept,
    // not reused) — so the same agentSessionId can be shared by several rows.
    // Only the live one should ever render as a chat.
    writeTranscript(ws.project, 'conv-1', 'Original');
    const [project] = await service.list([
      makeSession({
        id: 'first-resume',
        cwd: ws.project,
        agentSessionId: 'conv-1',
        status: 'exited',
        lastActivityAt: 1000,
      }),
      makeSession({
        id: 'second-resume',
        cwd: ws.project,
        agentSessionId: 'conv-1',
        status: 'running',
        lastActivityAt: 2000,
      }),
    ]);

    expect(project?.chats).toHaveLength(1);
    expect(project?.chats[0]).toMatchObject({ sessionId: 'second-resume', live: true });
  });

  it('picks the most recently touched row when none of the duplicates are live', async () => {
    writeTranscript(ws.project, 'conv-1', 'Original');
    const [project] = await service.list([
      makeSession({
        id: 'older-resume',
        cwd: ws.project,
        agentSessionId: 'conv-1',
        status: 'exited',
        lastActivityAt: 1000,
      }),
      makeSession({
        id: 'newer-resume',
        cwd: ws.project,
        agentSessionId: 'conv-1',
        status: 'exited',
        lastActivityAt: 2000,
      }),
    ]);

    expect(project?.chats).toHaveLength(1);
    expect(project?.chats[0]).toMatchObject({ sessionId: 'newer-resume', live: false });
  });

  it('shows the transcript-derived title for a live session, not its fixed creation-time name', async () => {
    // A session's own title is set once at creation and never updated
    // (`Claude Code · <folder>` for every fresh chat); Claude Code writes a
    // real, content-derived title into the transcript almost immediately.
    // Without picking that up, every live chat in one folder reads identically.
    writeTranscript(ws.project, 'conv-1', 'Fix the login bug');
    const [project] = await service.list([
      makeSession({
        id: 'live',
        cwd: ws.project,
        agentSessionId: 'conv-1',
        title: 'Claude Code · project',
      }),
    ]);

    expect(project?.chats).toHaveLength(1);
    expect(project?.chats[0]?.title).toBe('Fix the login bug');
  });

  it('falls back to the session\'s own title when no transcript matches yet', async () => {
    // A session with no agentSessionId (not yet started, or a non-Claude
    // agent), or one whose transcript has not appeared on disk yet, has
    // nothing to look up — it must keep its own title rather than showing
    // nothing or a lookup failure.
    const [project] = await service.list([
      makeSession({ id: 'live', cwd: ws.project, agentSessionId: null, title: 'Claude Code · project' }),
    ]);

    expect(project?.chats[0]?.title).toBe('Claude Code · project');
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
    // Directories with work come first, newest first; empty ones follow.
    expect(projects.slice(0, 2).map((p) => p.name)).toEqual(['project', 'older']);
    expect(projects.slice(2).every((p) => p.chats.length === 0)).toBe(true);
  });

  it('lists an added folder that has no chats yet', async () => {
    // A repo you have not started work in is still somewhere you can start it.
    // Hiding it made the home screen a history rather than a launcher.
    const projects = await service.list([]);
    const found = projects.find((p) => p.cwd === ws.root);
    expect(found).toBeDefined();
    expect(found?.chats).toEqual([]);
  });

  it('sorts empty folders stably, so the list does not shuffle', async () => {
    const registry = new WorkspaceRegistry([ws.root]);
    for (const name of ['zebra', 'alpha', 'mango']) {
      const dir = path.join(ws.root, name);
      fs.mkdirSync(dir);
      await registry.add(dir);
    }
    const svc = new ProjectService({
      workspaces: registry,
      conversations: new ConversationStore({
        projectsDir,
        workspaces: registry,
        listRunningCwds: async () => [],
      }),
      db,
      version: '1',
    });
    const first = (await svc.list([])).map((p) => p.name);
    const second = (await svc.list([])).map((p) => p.name);
    expect(first).toEqual(second);
    expect(first.indexOf('alpha')).toBeLessThan(first.indexOf('mango'));
  });

  it('hides build output by default without being told to', async () => {
    const junk = path.join(ws.root, '__pycache__');
    fs.mkdirSync(junk);
    const projects = await service.list([
      makeSession({ id: 'junk', cwd: junk }),
      makeSession({ id: 'real', cwd: ws.project }),
    ]);
    expect(projects.map((p) => p.name)).not.toContain('__pycache__');
    expect(projects.map((p) => p.name)).toContain('project');
  });

  it('shows a hidden project when explicitly asked, flagged as hidden', async () => {
    const junk = path.join(ws.root, 'node_modules');
    fs.mkdirSync(junk);
    const projects = await service.list([makeSession({ cwd: junk })], true);
    expect(projects[0]).toMatchObject({ name: 'node_modules', hidden: true });
  });

  it('lets an explicit unhide beat the default patterns', async () => {
    // Someone who unhides `dist` means it; the defaults must not re-hide it.
    const dist = path.join(ws.root, 'dist');
    fs.mkdirSync(dist);
    service.setHidden(dist, false);
    const projects = await service.list([makeSession({ cwd: dist })]);
    expect(projects.map((p) => p.name)).toContain('dist');
  });

  it('hides a project the user hid, and unhides it again', async () => {
    service.setHidden(ws.project, true);
    const names = async () => (await service.list([makeSession({ cwd: ws.project })])).map((p) => p.name);
    expect(await names()).not.toContain('project');

    service.setHidden(ws.project, false);
    expect(await names()).toContain('project');
  });

  it('drops a conversation the user removed, and keeps the transcript', async () => {
    writeTranscript(ws.project, 'gone', 'Old question');
    writeTranscript(ws.project, 'kept', 'Still wanted');

    hideChat(db, 'gone');
    const [project] = await service.list([]);
    expect(project?.chats.map((c) => c.id)).toEqual(['kept']);

    // Removal is a list decision, not a deletion.
    const dir = path.join(projectsDir, encodeProjectDir(ws.project));
    expect(fs.existsSync(path.join(dir, 'gone.jsonl'))).toBe(true);
  });

  it('reports the git branch for a project that has one', async () => {
    fs.mkdirSync(path.join(ws.project, '.git'));
    fs.writeFileSync(path.join(ws.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const [project] = await service.list([makeSession({ cwd: ws.project })]);
    expect(project).toMatchObject({ isGitRepo: true, gitBranch: 'main' });
  });

  it('drops a directory once its folder is no longer a project', async () => {
    // "Remove this folder" has to actually remove it. A folder with history is
    // exactly where doing nothing would look broken. Nothing is deleted: the
    // chats come back if the folder is added again.
    const registry = new WorkspaceRegistry([ws.root]);
    const svc = new ProjectService({
      workspaces: registry,
      conversations: new ConversationStore({
        projectsDir,
        workspaces: registry,
        listRunningCwds: async () => [],
      }),
      db,
      version: '1',
    });
    const session = makeSession({ cwd: ws.project });
    expect((await svc.list([session])).map((p) => p.cwd)).toContain(ws.project);

    registry.remove(ws.root);
    expect(await svc.list([session])).toEqual([]);

    await registry.add(ws.root);
    expect((await svc.list([session])).map((p) => p.cwd)).toContain(ws.project);
  });

  it('marks which projects are folders the user added', async () => {
    const sub = path.join(ws.project, 'subdir');
    fs.mkdirSync(sub);
    const projects = await service.list([makeSession({ cwd: sub })]);
    // The root was added; a directory a session merely ran in was not.
    expect(projects.find((p) => p.cwd === ws.root)?.isWorkspace).toBe(true);
    expect(projects.find((p) => p.cwd === sub)?.isWorkspace).toBe(false);
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

describe('removing and hiding over HTTP', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  const headers = () => ({ cookie: t.cookie });

  const startSession = async (): Promise<string> => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };

  const chatsIn = async (cwd: string) => {
    const res = await t.app.inject({ method: 'GET', url: '/api/projects', headers: headers() });
    const project = res.json().projects.find((p: { cwd: string }) => p.cwd === cwd);
    return (project?.chats ?? []) as { id: string; live: boolean }[];
  };

  it('refuses to remove a running session rather than orphaning it', async () => {
    const id = await startSession();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chats/remove',
      headers: headers(),
      payload: { sessionId: id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('session_running');
    expect((await chatsIn(t.projectDir)).map((c) => c.id)).toContain(id);
  });

  it('removes a finished session from the list', async () => {
    const id = await startSession();
    await t.app.inject({ method: 'DELETE', url: `/api/sessions/${id}`, headers: headers() });
    await waitFor(async () => !(await chatsIn(t.projectDir)).some((c) => c.live));

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chats/remove',
      headers: headers(),
      payload: { sessionId: id },
    });
    expect(res.statusCode).toBe(200);
    expect((await chatsIn(t.projectDir)).map((c) => c.id)).not.toContain(id);
  });

  it('treats removing something already gone as success', async () => {
    // The desired end state is "not in the list", which is already true.
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chats/remove',
      headers: headers(),
      payload: { sessionId: 'never-existed' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a remove that names nothing', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/chats/remove',
      headers: headers(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('clears finished chats but leaves running ones', async () => {
    const finished = await startSession();
    const running = await startSession();
    await t.app.inject({ method: 'DELETE', url: `/api/sessions/${finished}`, headers: headers() });
    await waitFor(async () => (await chatsIn(t.projectDir)).some((c) => !c.live));

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/clear-finished',
      headers: headers(),
      payload: { cwd: t.projectDir },
    });
    expect(res.statusCode).toBe(200);

    const ids = (await chatsIn(t.projectDir)).map((c) => c.id);
    expect(ids).toContain(running);
    expect(ids).not.toContain(finished);
  });

  it('hides and unhides a project', async () => {
    await startSession();
    expect(await chatsIn(t.projectDir)).not.toHaveLength(0);

    await t.app.inject({
      method: 'POST',
      url: '/api/projects/hide',
      headers: headers(),
      payload: { cwd: t.projectDir },
    });
    expect(await chatsIn(t.projectDir)).toHaveLength(0);

    // Still there, just not listed.
    const withHidden = await t.app.inject({
      method: 'GET',
      url: '/api/projects?includeHidden=1',
      headers: headers(),
    });
    expect(
      withHidden.json().projects.find((p: { cwd: string }) => p.cwd === t.projectDir).hidden,
    ).toBe(true);

    await t.app.inject({
      method: 'POST',
      url: '/api/projects/unhide',
      headers: headers(),
      payload: { cwd: t.projectDir },
    });
    expect(await chatsIn(t.projectDir)).not.toHaveLength(0);
  });

  it('will not hide a directory outside the workspace roots', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/hide',
      headers: headers(),
      payload: { cwd: '/etc' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication for every one of them', async () => {
    for (const url of [
      '/api/chats/remove',
      '/api/projects/clear-finished',
      '/api/projects/hide',
      '/api/projects/unhide',
    ]) {
      const res = await t.app.inject({ method: 'POST', url, payload: { cwd: '/tmp' } });
      expect(res.statusCode, url).toBe(401);
    }
  });
});
