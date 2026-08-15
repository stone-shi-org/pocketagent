import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeService } from '../src/git/worktree.js';
import { WorkspaceRegistry } from '../src/workspaces/index.js';
import { createTestApp, type TestApp } from './helpers.js';

/** A real repo with one commit, matching this codebase's existing preference
 *  (see `codex-session.test.ts`) for spawning real git over mocking it. */
function initRepo(): string {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-wt-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
  return repo;
}

function currentBranch(cwd: string): string {
  return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd }).toString().trim();
}

describe('WorktreeService', () => {
  let repo: string;
  let registry: WorkspaceRegistry;
  let service: WorktreeService;
  let initialBranch: string;

  beforeEach(() => {
    repo = initRepo();
    registry = new WorkspaceRegistry([repo]);
    service = new WorktreeService({ workspaces: registry });
    initialBranch = currentBranch(repo);
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('creates a worktree on a new, named branch', async () => {
    const result = await service.create({
      projectCwd: repo,
      branchMode: 'new',
      branchName: 'feature/x',
    });
    expect(result.branch).toBe('feature/x');
    expect(result.cwd).toBe(fs.realpathSync(path.join(repo, '.worktrees', 'feature-x')));
    expect(currentBranch(result.cwd)).toBe('feature/x');
  });

  it('auto-names a new branch off the current tip for "current" mode, never reusing it', async () => {
    const result = await service.create({ projectCwd: repo, branchMode: 'current' });
    expect(result.branch).not.toBe(initialBranch);
    expect(result.branch.startsWith(`wt/${initialBranch}-`)).toBe(true);
    // The main worktree's own branch must be untouched by creating another one.
    expect(currentBranch(repo)).toBe(initialBranch);
  });

  it('rejects an invalid branch name', async () => {
    await expect(
      service.create({ projectCwd: repo, branchMode: 'new', branchName: '..bad..' }),
    ).rejects.toMatchObject({ code: 'invalid_branch' });
  });

  it('rejects a branch name that already exists', async () => {
    execFileSync('git', ['branch', 'taken'], { cwd: repo });
    await expect(
      service.create({ projectCwd: repo, branchMode: 'new', branchName: 'taken' }),
    ).rejects.toMatchObject({ code: 'branch_exists' });
  });

  it('rejects a directory that is not a git repository', async () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-wt-notgit-'));
    try {
      await expect(
        service.create({ projectCwd: notGit, branchMode: 'new', branchName: 'x' }),
      ).rejects.toMatchObject({ code: 'not_a_repo' });
    } finally {
      fs.rmSync(notGit, { recursive: true, force: true });
    }
  });

  it('always returns a path that passes workspace containment', async () => {
    const result = await service.create({
      projectCwd: repo,
      branchMode: 'new',
      branchName: 'contained',
    });
    await expect(registry.resolveWorkspacePath(result.cwd)).resolves.toBe(result.cwd);
  });

  it('keeps .worktrees/ out of git status without touching a tracked .gitignore', async () => {
    await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'exclude-test' });
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.worktrees/');
    expect(fs.existsSync(path.join(repo, '.gitignore'))).toBe(false);
  });
});

describe('POST /api/projects/worktree', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
    execFileSync('git', ['init', '-q'], { cwd: t.projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: t.projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: t.projectDir });
    fs.writeFileSync(path.join(t.projectDir, 'file.txt'), 'one\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: t.projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: t.projectDir });
  });
  afterEach(() => t.cleanup());

  const headers = () => ({ cookie: t.cookie });

  it('requires authentication', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      payload: { cwd: t.projectDir, branchMode: 'new', branchName: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a worktree that a session can then start in', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: t.projectDir, branchMode: 'new', branchName: 'feature/http' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.branch).toBe('feature/http');

    const session = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { agent: 'shell', cwd: body.cwd, cols: 80, rows: 24 },
    });
    expect(session.statusCode).toBe(201);
    expect(session.json().cwd).toBe(body.cwd);
  });

  it('refuses a cwd outside the workspace roots', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: '/etc', branchMode: 'new', branchName: 'x' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('refuses a symlink escape from inside a root', async () => {
    const link = path.join(t.workspaceRoot, 'escape');
    fs.symlinkSync('/etc', link);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: link, branchMode: 'new', branchName: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects "new" branch mode without a branch name', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: t.projectDir, branchMode: 'new' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reports a conflict for a branch that already exists', async () => {
    execFileSync('git', ['branch', 'taken'], { cwd: t.projectDir });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: t.projectDir, branchMode: 'new', branchName: 'taken' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('branch_exists');
  });
});
