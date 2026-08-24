import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitStatusTracker, parsePorcelainV2 } from '../src/git/status.js';

describe('parsePorcelainV2', () => {
  it('reports dirty for an unstaged change', () => {
    const output = ['# branch.oid abc123', '# branch.head main', '1 .M N... 100644 100644 100644 abc abc file.txt'].join(
      '\n',
    );
    expect(parsePorcelainV2(output)).toBe('dirty');
  });

  it('reports dirty for an untracked file even with a clean index', () => {
    const output = ['# branch.oid abc123', '# branch.head main', '? new-file.txt'].join('\n');
    expect(parsePorcelainV2(output)).toBe('dirty');
  });

  it('reports unpushed when there is no upstream at all', () => {
    const output = ['# branch.oid abc123', '# branch.head main'].join('\n');
    expect(parsePorcelainV2(output)).toBe('unpushed');
  });

  it('reports unpushed when ahead of the upstream', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -0',
    ].join('\n');
    expect(parsePorcelainV2(output)).toBe('unpushed');
  });

  it('reports clean when only behind the upstream — nothing local is unpushed', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -3',
    ].join('\n');
    expect(parsePorcelainV2(output)).toBe('clean');
  });

  it('reports clean when the upstream is fully in sync', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');
    expect(parsePorcelainV2(output)).toBe('clean');
  });

  it('prefers dirty over unpushed when both apply', () => {
    const output = [
      '# branch.oid abc123',
      '# branch.head main',
      '1 .M N... 100644 100644 100644 abc abc file.txt',
    ].join('\n');
    expect(parsePorcelainV2(output)).toBe('dirty');
  });
});

/** A real repo with one commit and a bare "remote" it can actually push to,
 *  matching this codebase's existing preference (see `worktree.test.ts`) for
 *  spawning real git over mocking it. */
function initRepoWithRemote(): { repo: string; remote: string } {
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-git-remote-')));
  execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });

  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-git-repo-')));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n');
  execFileSync('git', ['add', 'file.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo });
  execFileSync('git', ['push', '-q', '-u', 'origin', 'main'], { cwd: repo });
  return { repo, remote };
}

describe('GitStatusTracker', () => {
  let repo: string;
  let remote: string;
  let tracker: GitStatusTracker;

  beforeEach(() => {
    ({ repo, remote } = initRepoWithRemote());
    // ttlMs: 0 so each test's edits are picked up by the very next `get()`.
    tracker = new GitStatusTracker(0);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  });

  it('reports clean for a repo pushed and in sync', async () => {
    expect(await tracker.get(repo)).toBe('clean');
  });

  it('reports dirty for an uncommitted edit', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'two\n');
    expect(await tracker.get(repo)).toBe('dirty');
  });

  it('reports dirty for a new untracked file', async () => {
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    expect(await tracker.get(repo)).toBe('dirty');
  });

  it('reports unpushed for a local commit not yet pushed', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'two\n');
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: repo });
    expect(await tracker.get(repo)).toBe('unpushed');
  });

  it('goes back to clean once the commit is pushed', async () => {
    fs.writeFileSync(path.join(repo, 'file.txt'), 'two\n');
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: repo });
    expect(await tracker.get(repo)).toBe('unpushed');
    execFileSync('git', ['push', '-q'], { cwd: repo });
    expect(await tracker.get(repo)).toBe('clean');
  });

  it('reports unpushed for a fresh repo with no remote configured', async () => {
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-git-noremote-')));
    execFileSync('git', ['init', '-q'], { cwd: bare });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: bare });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: bare });
    fs.writeFileSync(path.join(bare, 'file.txt'), 'one\n');
    execFileSync('git', ['add', 'file.txt'], { cwd: bare });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: bare });
    try {
      expect(await tracker.get(bare)).toBe('unpushed');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('returns null for a directory that is not a git repository', async () => {
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-git-notgit-'));
    try {
      expect(await tracker.get(notGit)).toBeNull();
    } finally {
      fs.rmSync(notGit, { recursive: true, force: true });
    }
  });

  it('serves a cached status without re-spawning git within the TTL window', async () => {
    const cached = new GitStatusTracker(60_000);
    expect(await cached.get(repo)).toBe('clean');
    // Committing without the tracker ever re-checking should not flip the
    // cached answer — this is the staleness trade the TTL comment documents.
    fs.writeFileSync(path.join(repo, 'file.txt'), 'two\n');
    execFileSync('git', ['commit', '-qam', 'second'], { cwd: repo });
    expect(await cached.get(repo)).toBe('clean');
  });
});
