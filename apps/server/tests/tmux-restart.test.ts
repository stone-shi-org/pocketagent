import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDatabase, type Db } from '../src/db/index.js';
import { createTestApp, waitFor, sleep, type TestApp } from './helpers.js';

const execFileAsync = promisify(execFile);
const TEST_SOCKET = `pa-restart-${process.pid}`;

async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}

const HAS_TMUX = await tmuxAvailable();
const describeTmux = HAS_TMUX ? describe : describe.skip;

async function killTestServer(): Promise<void> {
  await execFileAsync('tmux', ['-L', TEST_SOCKET, 'kill-server']).catch(() => {});
}

async function tmuxSessionNames(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      '-L', TEST_SOCKET, '-f', '/dev/null',
      'list-sessions', '-F', '#{session_name}',
    ]);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const TMUX_ENV = {
  POCKETAGENT_BACKEND: 'tmux',
  POCKETAGENT_TMUX_SOCKET: TEST_SOCKET,
};

describeTmux('tmux backend: surviving a server restart', () => {
  let app: TestApp | null = null;
  let db: Db | null = null;

  afterEach(async () => {
    if (app) {
      // Terminate for real so tmux sessions do not leak between tests.
      await app.context.sessions.terminateAll();
      await app.cleanup();
      app = null;
    }
    db?.close();
    db = null;
    await killTestServer();
  });

  it('keeps the agent running across a full server restart and re-adopts it', async () => {
    // A database that outlives the "restart", as a real on-disk one would.
    db = openDatabase(':memory:');
    app = await createTestApp(TMUX_ENV, db);
    const workspaceRoot = app.workspaceRoot;
    const projectDir = app.projectDir;

    const created = await app.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: app.cookie },
      payload: { agent: 'shell', cwd: projectDir, cols: 90, rows: 26 },
    });
    expect(created.statusCode).toBe(201);

    const id = created.json().id as string;
    expect(created.json().backend).toBe('tmux');
    expect(created.json().durable).toBe(true);

    const session = app.context.sessions.getOrThrow(id);
    const panePid = session.pid!;
    const firstEpoch = session.epoch;
    const externalId = session.externalId;
    expect(externalId).toBe(`pocketagent-${id}`);

    // Leave a marker in the terminal we can look for after the restart.
    await sleep(700);
    session.write('echo SURVIVED_THE_RESTART\n');
    await waitFor(() => session.buffer.replayAfter(0).data.includes('SURVIVED_THE_RESTART'));

    // ---- restart ----------------------------------------------------------
    await app.app.close();
    app = null;

    // The agent is still running, owned by tmux rather than by us.
    expect(await tmuxSessionNames()).toContain(externalId);
    expect(() => process.kill(panePid, 0)).not.toThrow();

    // The row still says running, with the handle needed to find it again.
    const row = db.prepare('SELECT status, external_id, backend FROM sessions WHERE id = ?').get(id) as {
      status: string;
      external_id: string;
      backend: string;
    };
    expect(row).toMatchObject({ status: 'running', external_id: externalId, backend: 'tmux' });

    // ---- new server, same database ---------------------------------------
    app = await createTestApp(
      { ...TMUX_ENV, POCKETAGENT_WORKSPACE_ROOTS: workspaceRoot },
      db,
    );

    const revived = app.context.sessions.get(id);
    expect(revived, 'session should have been re-adopted').toBeDefined();
    expect(revived!.status).toBe('running');
    // Same process — not a fresh one.
    expect(revived!.pid).toBe(panePid);

    // A new stream, so a client holding an old sequence number must resync.
    expect(revived!.epoch).not.toBe(firstEpoch);

    // Scrollback was seeded from tmux, so a reconnecting browser sees history.
    await waitFor(() => revived!.buffer.replayAfter(0).data.includes('SURVIVED_THE_RESTART'), {
      timeout: 10_000,
    });

    // And it is still genuinely interactive.
    revived!.write('echo STILL_INTERACTIVE\n');
    await waitFor(() => revived!.buffer.replayAfter(0).data.includes('STILL_INTERACTIVE'), {
      timeout: 10_000,
    });

    const listed = await app.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: app.cookie },
    });
    const found = listed.json().sessions.find((s: { id: string }) => s.id === id);
    expect(found.status).toBe('running');
    expect(found.durable).toBe(true);
  });

  it('marks a session interrupted when its tmux session is really gone', async () => {
    db = openDatabase(':memory:');
    app = await createTestApp(TMUX_ENV, db);
    const workspaceRoot = app.workspaceRoot;

    const created = await app.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: app.cookie },
      payload: { agent: 'shell', cwd: app.projectDir },
    });
    const id = created.json().id as string;
    await sleep(500);

    await app.app.close();
    app = null;

    // Something outside PocketAgent destroyed the tmux server.
    await killTestServer();

    app = await createTestApp({ ...TMUX_ENV, POCKETAGENT_WORKSPACE_ROOTS: workspaceRoot }, db);

    expect(app.context.sessions.get(id)).toBeUndefined();
    const info = app.context.sessions.find(id);
    expect(info?.status).toBe('interrupted');
  });

  it('terminating still works and removes the tmux session', async () => {
    db = openDatabase(':memory:');
    app = await createTestApp(TMUX_ENV, db);

    const created = await app.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: app.cookie },
      payload: { agent: 'shell', cwd: app.projectDir },
    });
    const id = created.json().id as string;
    const session = app.context.sessions.getOrThrow(id);
    const externalId = session.externalId!;
    await sleep(600);

    await app.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: { cookie: app.cookie },
    });

    await waitFor(() => !session.isAlive(), { timeout: 15_000 });
    expect(session.status).toBe('killed');
    await waitFor(async () => !(await tmuxSessionNames()).includes(externalId), { timeout: 10_000 });
  });

  it('does not touch tmux sessions it does not own', async () => {
    db = openDatabase(':memory:');
    app = await createTestApp(TMUX_ENV, db);

    // Create a session on our socket that PocketAgent did not start.
    await execFileAsync('tmux', [
      '-L', TEST_SOCKET, '-f', '/dev/null',
      'new-session', '-d', '-s', 'user-own-work', '--', 'sleep', '60',
    ]);

    const workspaceRoot = app.workspaceRoot;
    await app.app.close();
    app = null;

    app = await createTestApp({ ...TMUX_ENV, POCKETAGENT_WORKSPACE_ROOTS: workspaceRoot }, db);

    // Still there, untouched, and not adopted as a PocketAgent session.
    expect(await tmuxSessionNames()).toContain('user-own-work');
    expect(app.context.sessions.list().some((s) => s.id === 'user-own-work')).toBe(false);
  });
});
