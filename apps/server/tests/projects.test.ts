import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionInfo } from '@pocketagent/protocol';
import { ProjectService, findMainRepoCwd, readGitBranch } from '../src/projects/index.js';
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
    busy: false,
    busySince: null,
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

describe('findMainRepoCwd', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/pa-git-');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports no main checkout for an ordinary repo', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    expect(await findMainRepoCwd(dir)).toBeNull();
  });

  it('reports no main checkout outside a repository', async () => {
    expect(await findMainRepoCwd('/tmp')).toBeNull();
  });

  it('resolves a linked worktree back to its main checkout', async () => {
    // Shape a real `git worktree add` leaves behind: `<main>/.git/worktrees/<name>`.
    const main = fs.mkdtempSync('/tmp/pa-git-main-');
    const gitDir = path.join(main, '.git', 'worktrees', 'feature-x');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    try {
      expect(await findMainRepoCwd(dir)).toBe(main);
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it('does not mistake a submodule for a worktree', async () => {
    // A submodule uses the same `gitdir:` indirection, but its target lives
    // under `.git/modules/<name>` rather than `.git/worktrees/<name>` — that
    // segment is what tells the two apart.
    const superproject = fs.mkdtempSync('/tmp/pa-git-super-');
    const gitDir = path.join(superproject, '.git', 'modules', 'lib');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
    try {
      expect(await findMainRepoCwd(dir)).toBeNull();
    } finally {
      fs.rmSync(superproject, { recursive: true, force: true });
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

  it('keeps a busy project on top of an idle one even with an older busySince than the idle one\'s lastActivityAt', async () => {
    // Regression for the reorder-churn bug: a session mid-turn ticks
    // `lastActivityAt` on every streamed chunk, so sorting on that directly
    // made the list flip constantly whenever two agents were both producing
    // output. Sorting a busy chat by `busySince` (stamped once, at turn
    // start) instead means it stays on top for the whole turn regardless of
    // how recently the *idle* project below it finished.
    const older = path.join(ws.root, 'older');
    fs.mkdirSync(older);
    const projects = await service.list([
      makeSession({ id: 'busy', cwd: older, busy: true, busySince: 1000, lastActivityAt: 1500 }),
      makeSession({ id: 'idle', cwd: ws.project, busy: false, busySince: null, lastActivityAt: 9000 }),
    ]);
    expect(projects.slice(0, 2).map((p) => p.name)).toEqual(['older', 'project']);
  });

  it('keeps two concurrently-busy projects in a stable relative order regardless of their latest lastActivityAt', async () => {
    const a = path.join(ws.root, 'a-project');
    const b = path.join(ws.root, 'b-project');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    // 'a' became busy first, so it should stay on top even though 'b' has
    // since emitted a later chunk (a higher lastActivityAt).
    const projects = await service.list([
      makeSession({ id: 'a', cwd: a, busy: true, busySince: 1000, lastActivityAt: 5000 }),
      makeSession({ id: 'b', cwd: b, busy: true, busySince: 2000, lastActivityAt: 4000 }),
    ]);
    expect(projects.slice(0, 2).map((p) => p.name)).toEqual(['b-project', 'a-project']);
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

  describe('folding worktrees into their main checkout', () => {
    // Lays down `.git` (main) + `.git/worktrees/<name>` + a worktree
    // directory whose own `.git` file points at it — the shape a real
    // `git worktree add` produces, without spawning git.
    function addWorktree(worktreePath: string, branch: string): void {
      fs.mkdirSync(worktreePath, { recursive: true });
      const gitDir = path.join(ws.project, '.git', 'worktrees', branch);
      fs.mkdirSync(gitDir, { recursive: true });
      fs.writeFileSync(path.join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
      fs.writeFileSync(path.join(worktreePath, '.git'), `gitdir: ${gitDir}\n`);
    }

    beforeEach(() => {
      fs.mkdirSync(path.join(ws.project, '.git'));
      fs.writeFileSync(path.join(ws.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    });

    it('folds a worktree nested under the project into its card instead of listing it separately', async () => {
      const worktreePath = path.join(ws.project, '.worktrees', 'feature-x');
      addWorktree(worktreePath, 'feature-x');

      const projects = await service.list([
        makeSession({ id: 'main-sess', cwd: ws.project }),
        makeSession({ id: 'wt-sess', cwd: worktreePath, title: 'Worktree chat' }),
      ]);

      // `ws.root` itself is always present too — an added folder gets a place
      // even when empty — so this asserts the worktree isn't *also* its own
      // top-level row, not that the whole list has exactly one entry.
      expect(projects.some((p) => p.cwd === worktreePath)).toBe(false);
      const main = projects.find((p) => p.cwd === ws.project);
      expect(main?.worktrees).toHaveLength(1);
      expect(main?.worktrees[0]).toMatchObject({
        cwd: worktreePath,
        gitBranch: 'feature-x',
        isWorkspace: false,
        worktrees: [],
      });
      expect(main?.worktrees[0]?.chats.map((c) => c.title)).toEqual(['Worktree chat']);
    });

    it('folds a worktree even when it lives under a completely different workspace root', async () => {
      // The scenario a manually-created worktree hits: it was never nested
      // under the main checkout at all, just added (or already contained) as
      // its own directory elsewhere. Grouping is decided by the `.git`
      // indirection, not by directory containment.
      const otherRoot = fs.mkdtempSync('/tmp/pa-other-root-');
      const otherWorktree = path.join(otherRoot, 'test-1');
      addWorktree(otherWorktree, 'test-1');

      const registry = new WorkspaceRegistry([ws.root, otherRoot]);
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

      try {
        const projects = await svc.list([
          makeSession({ id: 'main-sess', cwd: ws.project }),
          makeSession({ id: 'other-sess', cwd: otherWorktree, title: 'Elsewhere chat' }),
        ]);
        // Neither the worktree itself, nor the bare root it happens to sit
        // under, shows up as an unrelated top-level project.
        expect(projects.some((p) => p.cwd === otherWorktree)).toBe(false);
        const main = projects.find((p) => p.cwd === ws.project);
        expect(main?.worktrees[0]).toMatchObject({ cwd: otherWorktree, gitBranch: 'test-1' });
      } finally {
        fs.rmSync(otherRoot, { recursive: true, force: true });
      }
    });

    it('leaves a worktree as its own top-level project when its main checkout is hidden', async () => {
      service.setHidden(ws.project, true);
      const worktreePath = path.join(ws.project, '.worktrees', 'orphan');
      addWorktree(worktreePath, 'orphan');

      // Default `includeHidden = false`, so the main checkout never becomes a
      // draft to fold into — the worktree has nowhere to nest and stays a
      // standalone row instead of silently disappearing.
      const projects = await service.list([makeSession({ cwd: worktreePath })]);
      expect(projects.some((p) => p.cwd === ws.project)).toBe(false);
      const orphan = projects.find((p) => p.cwd === worktreePath);
      expect(orphan).toMatchObject({ cwd: worktreePath, gitBranch: 'orphan', worktrees: [] });
    });

    it('sorts a project above idle ones while a folded worktree is mid-turn', async () => {
      const worktreePath = path.join(ws.project, '.worktrees', 'busy-branch');
      addWorktree(worktreePath, 'busy-branch');
      // Just needs to be its own visible project under the same root — not
      // itself a workspace root — for the sort comparison below.
      const other = path.join(ws.root, 'other-project');
      fs.mkdirSync(other);

      const projects = await service.list([
        makeSession({ id: 'main-sess', cwd: ws.project, lastActivityAt: 5000 }),
        makeSession({
          id: 'wt-sess',
          cwd: worktreePath,
          busy: true,
          busySince: 9000,
          lastActivityAt: 9000,
        }),
        makeSession({ id: 'other-sess', cwd: other, lastActivityAt: 8000 }),
      ]);

      // `other` was touched more recently than the main checkout's own chat,
      // but the worktree folded into the main checkout is busy right now —
      // that has to outrank a merely-idle-but-recent chat elsewhere. Compared
      // by relative position rather than the exact array, since the always-
      // present (empty) `ws.root` entry sorts in too.
      const indexOf = (cwd: string) => projects.findIndex((p) => p.cwd === cwd);
      expect(indexOf(ws.project)).toBeLessThan(indexOf(other));
    });
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
