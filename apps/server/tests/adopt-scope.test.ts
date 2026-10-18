import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdoptionService } from '../src/adopt/index.js';
import type { WorkspaceRegistry } from '../src/workspaces/index.js';

const execFileAsync = promisify(execFile);

/**
 * A session created on an adopted socket with no server yet starts that
 * server, and a server forked from the PocketAgent process lives in its cgroup
 * and dies with `systemctl restart`. `TmuxBackend` already wrapped its own
 * server start in `systemd-run --user --scope`; `AdoptionService.create` did
 * not, which is how a session made from the phone vanished on the next restart.
 *
 * Needs a real tmux and a real `systemd --user` manager, like the backend's own
 * scope test, so it skips where either is missing.
 */
const SOCKET = `pa-scope-vitest-${process.pid}`;

async function can(cmd: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(cmd, args);
    return true;
  } catch {
    return false;
  }
}

const CAN_RUN =
  (await can('tmux', ['-V'])) && (await can('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true']));
const itScoped = CAN_RUN ? it : it.skip;

const cgroupOf = (pid: number | string) => fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();

const workspaces = {
  canonicalDirectory: async (p: string) => p,
  resolveWorkspacePath: async (p: string) => p,
  labelFor: () => 'tmp',
} as unknown as WorkspaceRegistry;

function service(sessionScopeSlice?: string): AdoptionService {
  return new AdoptionService({
    socket: SOCKET,
    bin: 'tmux',
    workspaces,
    env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    ...(sessionScopeSlice ? { sessionScopeSlice } : {}),
  });
}

async function serverPid(): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', SOCKET, 'display-message', '-p', '#{pid}']);
  return stdout.trim();
}

afterEach(async () => {
  await execFileAsync('tmux', ['-L', SOCKET, 'kill-server']).catch(() => {});
});

describe('creating a session on an adopted socket', () => {
  itScoped('starts the tmux server in its own scope, outside this process\'s cgroup', async () => {
    await service('app.slice').create('scoped', os.tmpdir());

    const server = cgroupOf(await serverPid());
    expect(server).toMatch(/\/run-[^/]+\.scope$/);
    expect(server).not.toBe(cgroupOf(process.pid));
  });

  itScoped('without a slice the server stays in the creating process\'s cgroup', async () => {
    await service().create('unscoped', os.tmpdir());

    // The behaviour the slice exists to avoid, pinned so the test above cannot
    // pass merely because every server lands somewhere else.
    expect(cgroupOf(await serverPid())).toBe(cgroupOf(process.pid));
  });

  itScoped('does not wrap a session joining a server that is already running', async () => {
    await execFileAsync('tmux', ['-L', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'first', '-c', os.tmpdir()]);
    const before = cgroupOf(await serverPid());

    await service('app.slice').create('second', os.tmpdir());

    expect(cgroupOf(await serverPid())).toBe(before);
    const { stdout } = await execFileAsync('tmux', ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}']);
    expect(stdout.trim().split('\n').sort()).toEqual(['first', 'second']);
  });
});
