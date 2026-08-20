import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTestApp, waitFor, sleep, type TestApp } from './helpers.js';

const execFileAsync = promisify(execFile);

/**
 * These tests stand up a tmux server on a private socket and treat it as if it
 * were the user's own. That is the only honest way to test adoption: the whole
 * feature is about joining a process PocketAgent did not start and must not
 * damage.
 */
const USER_SOCKET = `pa-user-vitest-${process.pid}`;
/** PocketAgent's own socket, for the one test that runs the tmux backend. */
const OWN_SOCKET = `pa-own-vitest-${process.pid}`;

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

async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['-L', USER_SOCKET, ...args]);
  return stdout;
}

async function killServers(): Promise<void> {
  for (const socket of [USER_SOCKET, OWN_SOCKET]) {
    try {
      await execFileAsync('tmux', ['-L', socket, 'kill-server']);
    } catch {
      /* no server running */
    }
  }
}

/**
 * Start a session on the "user's" tmux server, as if they had typed it.
 *
 * `new-session -d` returns before the pane has finished exec'ing, and until it
 * does tmux reports the pre-exec cwd — which is outside the workspace root and
 * would make the pane invisible to adoption. Wait for the real one.
 */
async function startUserSession(name: string, cwd: string, cmd: string[]): Promise<void> {
  await tmux(
    '-f', '/dev/null',
    'new-session', '-d', '-s', name, '-c', cwd, '-x', '100', '-y', '30',
    '--', ...cmd,
  );
  await waitFor(async () => (await panePath(name)) === cwd, { timeout: 5000 });
}

/** Query one field per session/pane. `display-message -t` does not resolve these. */
async function paneField(name: string, format: string): Promise<string | null> {
  const out = await tmux('list-panes', '-a', '-F', `#{session_name}|${format}`);
  for (const line of out.split('\n')) {
    const [session, value] = line.split('|');
    if (session === name) return value ?? null;
  }
  return null;
}

const panePath = (name: string): Promise<string | null> =>
  paneField(name, '#{pane_current_path}');

async function attachedClients(name: string): Promise<number> {
  const out = await tmux('list-sessions', '-F', '#{session_name}|#{session_attached}');
  for (const line of out.split('\n')) {
    const [session, value] = line.split('|');
    if (session === name) return Number(value);
  }
  return -1;
}

async function userSessionExists(name: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', `=${name}`);
    return true;
  } catch {
    return false;
  }
}

describe('adoption is off unless configured', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('reports itself disabled and offers nothing', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/adoptable',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, targets: [] });
  });

  it('refuses an adopt request outright', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: {
        agent: 'shell',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        adoptTargetId: 'anything-at-all',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('adoption_disabled');
  });

  it('requires authentication to enumerate panes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/adoptable' });
    expect(res.statusCode).toBe(401);
  });
});

describeTmux('adopting a pane on a foreign tmux server', () => {
  let t: TestApp;

  beforeAll(() => killServers());
  afterAll(() => killServers());

  beforeEach(async () => {
    t = await createTestApp({ POCKETAGENT_ADOPT_TMUX_SOCKET: USER_SOCKET });
  });

  afterEach(async () => {
    await t.cleanup();
    await killServers();
  });

  async function listTargets(): Promise<{ enabled: boolean; targets: any[] }> {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/adoptable',
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  it('lists a pane whose working directory is inside a workspace root', async () => {
    await startUserSession('mywork', t.projectDir, ['sleep', '120']);

    const body = await listTargets();
    expect(body.enabled).toBe(true);
    const target = body.targets.find((x) => x.sessionName === 'mywork');
    expect(target).toBeDefined();
    expect(target.cwd).toBe(t.projectDir);
    expect(target.cols).toBe(100);
    expect(target.rows).toBe(30);
    // Nobody is looking at it yet.
    expect(target.attachedClients).toBe(0);
    // The browser gets an opaque handle, never a tmux target string.
    expect(target.id).not.toContain('mywork');
  });

  it('never lists a pane outside the workspace roots', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-outside-')));
    try {
      await startUserSession('elsewhere', outside, ['sleep', '120']);
      await startUserSession('allowed', t.projectDir, ['sleep', '120']);

      const names = (await listTargets()).targets.map((x) => x.sessionName);
      expect(names).toContain('allowed');
      expect(names).not.toContain('elsewhere');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects an id that does not resolve to a live, contained pane', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: {
        agent: 'shell',
        cwd: t.projectDir,
        cols: 80,
        rows: 24,
        adoptTargetId: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('attaches to the pane and drives the same shell the user has open', async () => {
    await startUserSession('shared', t.projectDir, [
      '/bin/bash', '--norc', '--noprofile', '-i',
    ]);
    await sleep(500);

    const target = (await listTargets()).targets.find((x) => x.sessionName === 'shared');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    expect(created.statusCode).toBe(201);
    const info = created.json();

    expect(info.adopted).toBe(true);
    // The pane's size wins over whatever the browser asked for; adopting must
    // not resize a terminal the user is sitting at.
    expect(info.cols).toBe(100);
    expect(info.rows).toBe(30);

    const session = t.context.sessions.getOrThrow(info.id);
    await waitFor(() => session.buffer.replayAfter(0).data.length > 0, { timeout: 10_000 });

    // Typing from the browser reaches the user's shell.
    session.write('echo ADOPTED_MARKER\n');
    await waitFor(
      () => session.buffer.replayAfter(0).data.includes('ADOPTED_MARKER'),
      { timeout: 10_000 },
    );

    // And tmux now sees a client, which is what makes this a shared view.
    expect(await attachedClients('shared')).toBeGreaterThanOrEqual(1);
  });

  it('zooms the chosen pane instead of handing over the whole split window', async () => {
    await startUserSession('splitroom', t.projectDir, ['sleep', '120']);
    // Give the new pane its own cwd and long-lived command explicitly rather
    // than relying on inherited state, for the same reason `startUserSession`
    // waits for the real cwd: tmux reports the pre-exec state briefly.
    await tmux('split-window', '-t', 'splitroom', '-c', t.projectDir, '--', 'sleep', '120');

    let panes: any[] = [];
    await waitFor(async () => {
      panes = (await listTargets()).targets.filter((x) => x.sessionName === 'splitroom');
      return panes.length === 2;
    }, { timeout: 5000 });

    const paneZero = panes.find((x) => x.paneIndex === 0);
    expect(paneZero).toBeDefined();
    // Nobody has zoomed this window yet.
    expect(paneZero.zoomed).toBe(false);

    const first = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: paneZero.id },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id as string;

    // Attaching to one pane zoomed the window, so only that pane is visible —
    // picking pane 0 no longer hands over the whole split.
    await waitFor(async () => (await paneField('splitroom', '#{window_zoomed_flag}')) === '1', {
      timeout: 10_000,
    });

    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${firstId}`,
      headers: { cookie: t.cookie },
    });
    await waitFor(async () => (await attachedClients('splitroom')) === 0, { timeout: 10_000 });

    // The dialog would now offer this pane as already zoomed...
    const relisted = (await listTargets()).targets.find(
      (x) => x.sessionName === 'splitroom' && x.paneIndex === 0,
    );
    expect(relisted?.zoomed).toBe(true);

    // ...and attaching again must not toggle zoom back off (`-Z` toggles; a
    // naive re-send would un-zoom the window and bring the other pane back).
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: relisted!.id },
    });
    expect(second.statusCode).toBe(201);
    await waitFor(async () => (await attachedClients('splitroom')) >= 1, { timeout: 10_000 });
    expect(await paneField('splitroom', '#{window_zoomed_flag}')).toBe('1');
  });

  it('runs the attach client as a direct child, not inside our own tmux', async () => {
    // Whatever the configured backend is, an adopted session must spawn the
    // tmux *client* directly — otherwise killing it would kill a pane we own
    // rather than simply detaching from the user's.
    await t.cleanup();
    t = await createTestApp({
      POCKETAGENT_ADOPT_TMUX_SOCKET: USER_SOCKET,
      POCKETAGENT_BACKEND: 'tmux',
      POCKETAGENT_TMUX_SOCKET: OWN_SOCKET,
    });
    await startUserSession('direct-child', t.projectDir, ['sleep', '120']);
    await sleep(400);

    const target = (await listTargets()).targets.find((x) => x.sessionName === 'direct-child');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().backend).toBe('direct');
  });

  it('terminating an adopted session detaches — it does not kill the user\'s work', async () => {
    await startUserSession('survivor', t.projectDir, ['sleep', '120']);
    await sleep(400);

    const target = (await listTargets()).targets.find((x) => x.sessionName === 'survivor');
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    const id = created.json().id as string;

    await waitFor(async () => (await attachedClients('survivor')) >= 1, { timeout: 10_000 });

    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: { cookie: t.cookie },
    });
    expect(deleted.statusCode).toBe(200);

    // The PocketAgent session ends...
    await waitFor(() => {
      const info = t.context.sessions.find(id);
      return info !== null && info.status !== 'running' && info.status !== 'starting';
    }, { timeout: 10_000 });

    // ...but the user's session is untouched, with the client simply gone.
    expect(await userSessionExists('survivor')).toBe(true);
    await waitFor(async () => (await attachedClients('survivor')) === 0, { timeout: 10_000 });

    // The process the user started is still running.
    const panePid = Number(await paneField('survivor', '#{pane_pid}'));
    expect(() => process.kill(panePid, 0)).not.toThrow();
  });

  it('shutting the server down leaves the adopted session alive', async () => {
    await startUserSession('outlives-us', t.projectDir, ['sleep', '120']);
    await sleep(400);

    const target = (await listTargets()).targets.find((x) => x.sessionName === 'outlives-us');
    await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    await waitFor(async () => (await attachedClients('outlives-us')) >= 1, { timeout: 10_000 });

    await t.app.close();

    expect(await userSessionExists('outlives-us')).toBe(true);
  });

  it('reports the adopted pane\'s stable id, and keeps it filed under Shell after a restart', async () => {
    // Regression for: detaching a shell chat and reopening the Shell dialog
    // used to always create an unrelated new "Shell" entry, because nothing
    // tied a session row back to the tmux pane it came from once the row
    // stopped being live. `adoptTargetId` is that missing link — it must
    // survive on the row (not just live in memory) so a session read back
    // from disk after a restart is still recognized as the same pane, and
    // still filed under the "Shell" virtual project rather than leaking into
    // whatever real directory the pane happened to be in.
    const workspaceRoot = t.workspaceRoot;
    const db = t.db;

    await startUserSession('reattach-me', t.projectDir, ['sleep', '120']);
    const target = (await listTargets()).targets.find((x) => x.sessionName === 'reattach-me');

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    expect(created.statusCode).toBe(201);
    const info = created.json();
    expect(info.adopted).toBe(true);
    // Persisted, not just used to resolve the request — this is the field
    // that lets a later attach recognize it is the same pane.
    expect(info.adoptTargetId).toBe(target.id);
    const id = info.id as string;

    // Detach, the way the "Detach" button in the Shell dialog does.
    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: { cookie: t.cookie },
    });
    await waitFor(() => {
      const found = t.context.sessions.find(id);
      return found !== null && found.status !== 'running' && found.status !== 'starting';
    });

    // ---- restart, same database ---------------------------------------
    // Forces `sessions.find(id)` to read the row back from SQLite
    // (`rowToInfo`) instead of the live in-memory object (`toInfo`) — the
    // code path that used to hardcode `adopted: false` unconditionally.
    await t.app.close();
    t = await createTestApp(
      { POCKETAGENT_ADOPT_TMUX_SOCKET: USER_SOCKET, POCKETAGENT_WORKSPACE_ROOTS: workspaceRoot },
      db,
    );

    const revived = t.context.sessions.find(id);
    expect(revived).not.toBeNull();
    expect(revived!.adopted).toBe(true);
    expect(revived!.adoptTargetId).toBe(target.id);

    // And the home screen still files it under "Shell", not under the real
    // project directory the pane happened to be in.
    const listed = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: t.cookie },
    });
    const shell = listed.json().projects.find((p: { cwd: string }) => p.cwd === 'virtual:shell');
    expect(shell?.chats.map((c: { sessionId: string | null }) => c.sessionId)).toContain(id);
  });
});
