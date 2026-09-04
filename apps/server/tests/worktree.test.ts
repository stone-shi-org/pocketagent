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

function branchRefExists(cwd: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd });
    return true;
  } catch {
    return false;
  }
}

/** Whether `branch` still exists on a remote, queried without needing a working copy of it. */
function remoteBranchExists(remotePath: string, branch: string): boolean {
  const out = execFileSync('git', ['ls-remote', remotePath, `refs/heads/${branch}`], {
    cwd: remotePath,
  }).toString();
  return out.trim().length > 0;
}

/** A bare repo standing in for "origin", suitable as a local `git remote add` / `git push` target. */
function initBareRemote(): string {
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-wt-remote-')));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
  return remote;
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

describe('WorktreeService.remove', () => {
  let repo: string;
  let service: WorktreeService;

  beforeEach(() => {
    repo = initRepo();
    service = new WorktreeService({ workspaces: new WorkspaceRegistry([repo]) });
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('removes a clean, merged worktree and its branch', async () => {
    const created = await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'feature/remove-me' });

    const result = await service.remove({ worktreeCwd: created.cwd });

    expect(result).toEqual({ branch: 'feature/remove-me', mainCwd: repo, remote: null });
    expect(fs.existsSync(created.cwd)).toBe(false);
    expect(branchRefExists(repo, 'feature/remove-me')).toBe(false);
  });

  it('refuses a dirty worktree, touching neither the worktree nor the branch', async () => {
    const created = await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'feature/dirty' });
    fs.writeFileSync(path.join(created.cwd, 'file.txt'), 'uncommitted change\n');

    await expect(service.remove({ worktreeCwd: created.cwd })).rejects.toMatchObject({ code: 'dirty' });
    expect(fs.existsSync(created.cwd)).toBe(true);
    expect(branchRefExists(repo, 'feature/dirty')).toBe(true);
  });

  it('refuses an unmerged worktree branch, touching neither the worktree nor the branch', async () => {
    const created = await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'feature/unmerged' });
    fs.writeFileSync(path.join(created.cwd, 'new-file.txt'), 'not merged anywhere\n');
    execFileSync('git', ['add', 'new-file.txt'], { cwd: created.cwd });
    execFileSync('git', ['commit', '-q', '-m', 'unmerged work'], { cwd: created.cwd });

    // This is the key regression this test guards: the old ordering removed
    // the worktree first and only then discovered `git branch -d` refuses an
    // unmerged branch, leaving the worktree gone and the branch orphaned.
    await expect(service.remove({ worktreeCwd: created.cwd })).rejects.toMatchObject({ code: 'unmerged' });
    expect(fs.existsSync(created.cwd)).toBe(true);
    expect(branchRefExists(repo, 'feature/unmerged')).toBe(true);
  });

  it('refuses the main checkout itself', async () => {
    await expect(service.remove({ worktreeCwd: repo })).rejects.toMatchObject({ code: 'not_a_worktree' });
  });

  it('reports a remote when the branch has an upstream, without touching the remote', async () => {
    const created = await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'feature/remote' });
    const remote = initBareRemote();
    try {
      execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: created.cwd });
      execFileSync('git', ['push', '-u', 'origin', 'feature/remote'], { cwd: created.cwd });

      const result = await service.remove({ worktreeCwd: created.cwd });

      expect(result.remote).toEqual({ remoteName: 'origin', remoteBranch: 'feature/remote' });
      expect(fs.existsSync(created.cwd)).toBe(false);
      expect(branchRefExists(repo, 'feature/remote')).toBe(false);
      // Only local state was touched — the remote branch is a separate, opt-in step.
      expect(remoteBranchExists(remote, 'feature/remote')).toBe(true);
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
  });

  it('deleteRemoteBranch removes the ref from the remote, and reports a failure rather than a silent no-op on a second call', async () => {
    const created = await service.create({ projectCwd: repo, branchMode: 'new', branchName: 'feature/remote-del' });
    const remote = initBareRemote();
    try {
      execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: created.cwd });
      execFileSync('git', ['push', '-u', 'origin', 'feature/remote-del'], { cwd: created.cwd });
      await service.remove({ worktreeCwd: created.cwd });

      await service.deleteRemoteBranch({ mainCwd: repo, remoteName: 'origin', remoteBranch: 'feature/remote-del' });
      expect(remoteBranchExists(remote, 'feature/remote-del')).toBe(false);

      await expect(
        service.deleteRemoteBranch({ mainCwd: repo, remoteName: 'origin', remoteBranch: 'feature/remote-del' }),
      ).rejects.toMatchObject({ code: 'git_failed' });
    } finally {
      fs.rmSync(remote, { recursive: true, force: true });
    }
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

describe('POST /api/projects/worktree/delete', () => {
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

  async function createWorktree(branchName: string): Promise<{ cwd: string; branch: string }> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree',
      headers: headers(),
      payload: { cwd: t.projectDir, branchMode: 'new', branchName },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  it('requires authentication', async () => {
    const created = await createWorktree('feature/auth');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      payload: { cwd: created.cwd },
    });
    expect(res.statusCode).toBe(401);
  });

  it('deletes a clean, merged worktree and its branch', async () => {
    const created = await createWorktree('feature/http-delete');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: created.cwd },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ ok: true, branch: 'feature/http-delete', mainCwd: t.projectDir, remote: null });
    expect(fs.existsSync(created.cwd)).toBe(false);
  });

  it('refuses a dirty worktree', async () => {
    const created = await createWorktree('feature/http-dirty');
    fs.writeFileSync(path.join(created.cwd, 'file.txt'), 'uncommitted\n');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: created.cwd },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('dirty');
    expect(fs.existsSync(created.cwd)).toBe(true);
  });

  it('refuses an unmerged worktree branch', async () => {
    const created = await createWorktree('feature/http-unmerged');
    fs.writeFileSync(path.join(created.cwd, 'new-file.txt'), 'unmerged\n');
    execFileSync('git', ['add', 'new-file.txt'], { cwd: created.cwd });
    execFileSync('git', ['commit', '-q', '-m', 'unmerged work'], { cwd: created.cwd });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: created.cwd },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('unmerged');
    expect(fs.existsSync(created.cwd)).toBe(true);
  });

  it('refuses the main checkout itself', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: t.projectDir },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('not_a_worktree');
  });

  it('refuses a cwd outside the workspace roots', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: '/etc' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to delete a worktree with a live session in it', async () => {
    const created = await createWorktree('feature/http-busy');
    const session = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(),
      payload: { agent: 'shell', cwd: created.cwd, cols: 80, rows: 24 },
    });
    expect(session.statusCode).toBe(201);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete',
      headers: headers(),
      payload: { cwd: created.cwd },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('worktree_busy');
    expect(fs.existsSync(created.cwd)).toBe(true);
  });
});

describe('POST /api/projects/worktree/delete-remote', () => {
  let t: TestApp;
  let remote: string;
  beforeEach(async () => {
    t = await createTestApp();
    execFileSync('git', ['init', '-q'], { cwd: t.projectDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: t.projectDir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: t.projectDir });
    fs.writeFileSync(path.join(t.projectDir, 'file.txt'), 'one\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: t.projectDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: t.projectDir });
    remote = initBareRemote();
  });
  afterEach(async () => {
    await t.cleanup();
    fs.rmSync(remote, { recursive: true, force: true });
  });

  const headers = () => ({ cookie: t.cookie });

  it('deletes a branch on the remote after its worktree is gone', async () => {
    const created = await t.app
      .inject({
        method: 'POST',
        url: '/api/projects/worktree',
        headers: headers(),
        payload: { cwd: t.projectDir, branchMode: 'new', branchName: 'feature/remote-http' },
      })
      .then((r) => r.json());
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: created.cwd });
    execFileSync('git', ['push', '-u', 'origin', 'feature/remote-http'], { cwd: created.cwd });

    const deleted = await t.app
      .inject({
        method: 'POST',
        url: '/api/projects/worktree/delete',
        headers: headers(),
        payload: { cwd: created.cwd },
      })
      .then((r) => r.json());
    expect(deleted.remote).toEqual({ remoteName: 'origin', remoteBranch: 'feature/remote-http' });
    expect(remoteBranchExists(remote, 'feature/remote-http')).toBe(true);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete-remote',
      headers: headers(),
      payload: { cwd: deleted.mainCwd, remoteName: deleted.remote.remoteName, remoteBranch: deleted.remote.remoteBranch },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(remoteBranchExists(remote, 'feature/remote-http')).toBe(false);
  });

  it('reports a failure for a remote/branch pair that does not exist', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/projects/worktree/delete-remote',
      headers: headers(),
      payload: { cwd: t.projectDir, remoteName: 'origin', remoteBranch: 'no-such-branch' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('git_failed');
  });
});
