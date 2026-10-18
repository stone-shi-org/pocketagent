import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSystemdRun, scopedCommandOrPlain } from '../src/backends/systemd-scope.js';
import { tmuxSessionScopeSliceProblem } from '../src/config/index.js';

/**
 * A Linux host is not a systemd host. agent-02 runs in a container with no
 * `systemd-run`, and a slice that reached its database from a systemd host made
 * every tmux session fail with `spawn systemd-run ENOENT`.
 */
const dirs: string[] = [];
function tmpDir(withSystemdRun: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-scope-'));
  dirs.push(dir);
  if (withSystemdRun) {
    const bin = path.join(dir, 'systemd-run');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
  }
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('scopedCommandOrPlain', () => {
  it('wraps in systemd-run when it is on PATH', () => {
    const dir = tmpDir(true);
    expect(findSystemdRun(dir)).toBe(path.join(dir, 'systemd-run'));
    const cmd = scopedCommandOrPlain('app.slice', 'tmux', ['-L', 'x', 'start-server'], { pathEnv: dir });
    expect(cmd.file).toBe('systemd-run');
    expect(cmd.args).toEqual(['--user', '--scope', '--quiet', '--collect', '--slice=app.slice', '--', 'tmux', '-L', 'x', 'start-server']);
  });

  it('falls back to the plain command, with a warning, when systemd-run is missing', () => {
    const dir = tmpDir(false);
    const warn = vi.fn();
    const cmd = scopedCommandOrPlain('app.slice', 'tmux', ['start-server'], { pathEnv: dir, warn });
    expect(cmd).toEqual({ file: 'tmux', args: ['start-server'] });
    expect(warn).toHaveBeenCalledOnce();
  });

  it('is the plain command with no slice, and does not warn', () => {
    const warn = vi.fn();
    expect(scopedCommandOrPlain(null, 'tmux', ['a'], { pathEnv: tmpDir(false), warn })).toEqual({ file: 'tmux', args: ['a'] });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('tmuxSessionScopeSliceProblem', () => {
  it('refuses a slice on Linux without systemd-run when asked to check', () => {
    const missing = tmpDir(false);
    expect(tmuxSessionScopeSliceProblem('app.slice', 'linux', () => findSystemdRun(missing))).toMatch(/systemd-run/);
    const present = tmpDir(true);
    expect(tmuxSessionScopeSliceProblem('app.slice', 'linux', () => findSystemdRun(present))).toBeNull();
  });

  it('accepts clearing the slice regardless, and skips the binary check by default', () => {
    expect(tmuxSessionScopeSliceProblem('', 'linux', () => null)).toBeNull();
    expect(tmuxSessionScopeSliceProblem('app.slice', 'linux')).toBeNull();
  });
});
