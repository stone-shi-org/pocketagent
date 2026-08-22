import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceRegistry, WorkspaceError, isContained } from '../src/workspaces/index.js';
import { makeWorkspace } from './helpers.js';

describe('isContained', () => {
  it('accepts the root itself and descendants', () => {
    expect(isContained('/home/me/src', '/home/me/src')).toBe(true);
    expect(isContained('/home/me/src', '/home/me/src/app')).toBe(true);
    expect(isContained('/home/me/src', '/home/me/src/a/b/c')).toBe(true);
  });

  it('is not fooled by a shared string prefix', () => {
    expect(isContained('/home/me/src', '/home/me/srcEVIL')).toBe(false);
    expect(isContained('/home/me/src', '/home/me/src-other')).toBe(false);
  });

  it('rejects ancestors and siblings', () => {
    expect(isContained('/home/me/src', '/home/me')).toBe(false);
    expect(isContained('/home/me/src', '/etc')).toBe(false);
  });
});

describe('WorkspaceRegistry', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let registry: WorkspaceRegistry;

  beforeEach(() => {
    ws = makeWorkspace();
    registry = new WorkspaceRegistry([ws.root]);
  });

  afterEach(() => ws.cleanup());

  it('resolves a directory inside a root', async () => {
    await expect(registry.resolveWorkspacePath(ws.project)).resolves.toBe(ws.project);
  });

  it('resolves the root itself', async () => {
    await expect(registry.resolveWorkspacePath(ws.root)).resolves.toBe(ws.root);
  });

  it('rejects a path outside every root', async () => {
    await expect(registry.resolveWorkspacePath('/etc')).rejects.toThrow(WorkspaceError);
    await expect(registry.resolveWorkspacePath('/etc')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects ../ traversal even when it lands on a real directory', async () => {
    const escape = path.join(ws.project, '..', '..');
    await expect(registry.resolveWorkspacePath(escape)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a symlink that points outside the root', async () => {
    const link = path.join(ws.root, 'escape-hatch');
    fs.symlinkSync('/etc', link);
    // The string looks contained; only realpath reveals the escape.
    expect(link.startsWith(ws.root)).toBe(true);
    await expect(registry.resolveWorkspacePath(link)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('follows a symlink that stays inside the root', async () => {
    const link = path.join(ws.root, 'alias');
    fs.symlinkSync(ws.project, link);
    await expect(registry.resolveWorkspacePath(link)).resolves.toBe(ws.project);
  });

  it('rejects a NUL byte', async () => {
    await expect(registry.resolveWorkspacePath(`${ws.project}\0/etc`)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('rejects an empty path', async () => {
    await expect(registry.resolveWorkspacePath('   ')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects a file', async () => {
    const file = path.join(ws.project, 'notes.txt');
    fs.writeFileSync(file, 'hi');
    await expect(registry.resolveWorkspacePath(file)).rejects.toMatchObject({
      code: 'not_a_directory',
    });
  });

  it('reports a missing directory as not_found, not forbidden', async () => {
    await expect(registry.resolveWorkspacePath(path.join(ws.root, 'nope'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('lists the folders themselves, not their children', async () => {
    // Listing every subdirectory turned `venv` and `__pycache__` into projects.
    // A folder is a project because someone added it.
    fs.mkdirSync(path.join(ws.root, 'second'));
    const names = (await registry.list()).map((e) => e.name);
    expect(names).toEqual([path.basename(ws.root)]);
    expect(names).not.toContain('second');
    expect(names).not.toContain('project');
  });

  it('adds any directory on the host, and forgets it again', async () => {
    const other = fs.realpathSync(fs.mkdtempSync('/tmp/pa-add-'));
    try {
      const added = await registry.add(other);
      expect(added).toBe(other);
      expect((await registry.list()).map((e) => e.path)).toContain(other);
      // Which is the point: it can now be used as a working directory.
      await expect(registry.resolveWorkspacePath(other)).resolves.toBe(other);

      expect(registry.remove(other)).toBe(true);
      await expect(registry.resolveWorkspacePath(other)).rejects.toThrow(WorkspaceError);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('refuses "/" — every file on the machine is not a project', async () => {
    await expect(registry.add('/')).rejects.toThrow(WorkspaceError);
  });

  it('refuses a folder that does not exist or is not a directory', async () => {
    await expect(registry.add('/tmp/definitely-not-here-xyz')).rejects.toThrow(WorkspaceError);
    const file = path.join(ws.root, 'a-file');
    fs.writeFileSync(file, 'x');
    await expect(registry.add(file)).rejects.toThrow(WorkspaceError);
  });

  it('creates a missing folder and adds it when create is true', async () => {
    const fresh = path.join(ws.root, 'brand-new', 'nested');
    await expect(registry.add(fresh, { create: true })).resolves.toBe(fresh);
    expect(fs.statSync(fresh).isDirectory()).toBe(true);
    expect((await registry.list()).map((e) => e.path)).toContain(fresh);
  });

  it('still refuses a missing folder when create is not set', async () => {
    const fresh = path.join(ws.root, 'not-created');
    await expect(registry.add(fresh)).rejects.toMatchObject({ code: 'not_found' });
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('create does not paper over a path that exists but is a file', async () => {
    const file = path.join(ws.root, 'already-a-file');
    fs.writeFileSync(file, 'x');
    await expect(registry.add(file, { create: true })).rejects.toMatchObject({
      code: 'not_a_directory',
    });
  });

  it('adding the same folder twice is not an error and does not duplicate it', async () => {
    await registry.add(ws.root);
    expect((await registry.list()).filter((e) => e.path === ws.root)).toHaveLength(1);
  });

  it('flags git repositories', async () => {
    fs.mkdirSync(path.join(ws.root, '.git'));
    const entries = await registry.list();
    expect(entries[0]?.isGitRepo).toBe(true);
  });

  it('labels a path relative to home, since folders can now be anywhere', () => {
    // Two added folders can share a basename, so the label carries the path.
    expect(registry.labelFor('/tmp/x/y')).toBe('/tmp/x/y');
    expect(registry.labelFor(os.homedir())).toBe('~');
    expect(registry.labelFor(path.join(os.homedir(), 'src/app'))).toBe('~/src/app');
  });
});
