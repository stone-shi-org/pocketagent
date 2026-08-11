import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
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

  it('lists roots and immediate children but omits escaping symlinks', async () => {
    fs.mkdirSync(path.join(ws.root, 'second'));
    fs.mkdirSync(path.join(ws.root, '.hidden'));
    fs.symlinkSync('/etc', path.join(ws.root, 'escape-hatch'));

    const entries = await registry.list();
    const names = entries.map((e) => e.name);

    expect(entries[0]?.isRoot).toBe(true);
    expect(names).toContain('project');
    expect(names).toContain('second');
    expect(names).not.toContain('.hidden');
    expect(names).not.toContain('escape-hatch');
  });

  it('flags git repositories', async () => {
    fs.mkdirSync(path.join(ws.project, '.git'));
    const entries = await registry.list();
    expect(entries.find((e) => e.name === 'project')?.isGitRepo).toBe(true);
  });

  it('produces a readable label', () => {
    expect(registry.labelFor(ws.project)).toBe(`${path.basename(ws.root)}/project`);
    expect(registry.labelFor(ws.root)).toBe(path.basename(ws.root));
  });
});
