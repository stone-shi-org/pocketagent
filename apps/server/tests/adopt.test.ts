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

/**
 * Total attached clients across a whole tmux "session group" — the real
 * session plus any `pocketagent-view-*` sibling `attachCommand` created for
 * it (see that method's doc comment). PocketAgent's own client is attached
 * to a view session, not the real one, so the real session's own
 * `#{session_attached}` alone reads 0 even while genuinely attached; this is
 * the check that actually answers "is a client connected to this session
 * (group) right now". `session_group` is the empty string for an ungrouped
 * session, which would incorrectly match every other ungrouped session — a
 * session's own name is used as its group key in that case, same as tmux
 * does internally.
 */
async function totalAttachedInGroup(name: string): Promise<number> {
  const out = await tmux('list-sessions', '-F', '#{session_name}|#{session_group}|#{session_attached}');
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session, group, attached] = line.split('|');
      return { session: session ?? '', group: group || session || '', attached: Number(attached ?? 0) };
    });
  const target = rows.find((r) => r.session === name);
  if (!target) return 0;
  return rows.filter((r) => r.group === target.group).reduce((sum, r) => sum + r.attached, 0);
}

async function userSessionExists(name: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', `=${name}`);
    return true;
  } catch {
    return false;
  }
}

/** `pocketagent-view-*` siblings currently grouped with the named session. */
async function viewSessionsFor(name: string): Promise<{ name: string; activeWindow: number }[]> {
  const out = await tmux(
    'list-sessions', '-F',
    '#{session_name}|#{session_group}|#{session_windows}',
  );
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session, group] = line.split('|');
      return { session: session ?? '', group: group || session || '' };
    });
  const target = rows.find((r) => r.session === name);
  if (!target) return [];
  const viewNames = rows
    .filter((r) => r.group === target.group && r.session.startsWith('pocketagent-view-'))
    .map((r) => r.session);

  const result: { name: string; activeWindow: number }[] = [];
  for (const viewName of viewNames) {
    // `cleanupView` can remove this exact session between the listing above
    // and this per-session query — e.g. a detach that raced this call — in
    // which case tmux's own "can't find session" is the correct, expected
    // outcome, not a bug to surface: treat it the same as never having been
    // listed, rather than letting the whole poll fail on a real teardown.
    let windows: string;
    try {
      windows = await tmux('list-windows', '-t', `=${viewName}`, '-F', '#{window_index}|#{window_active}');
    } catch {
      continue;
    }
    const active = windows
      .split('\n')
      .filter(Boolean)
      .find((line) => line.endsWith('|1'));
    result.push({ name: viewName, activeWindow: active ? Number(active.split('|')[0]) : -1 });
  }
  return result;
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

    // And tmux now sees a client, which is what makes this a shared view —
    // attached to a `pocketagent-view-*` sibling of 'shared', not 'shared'
    // itself (see `attachCommand`'s doc comment), hence the group-wide check.
    expect(await totalAttachedInGroup('shared')).toBeGreaterThanOrEqual(1);
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
    await waitFor(async () => (await totalAttachedInGroup('splitroom')) === 0, { timeout: 10_000 });

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
    await waitFor(async () => (await totalAttachedInGroup('splitroom')) >= 1, { timeout: 10_000 });
    expect(await paneField('splitroom', '#{window_zoomed_flag}')).toBe('1');
  });

  it('switches the zoom to a different pane when attaching to it, instead of leaving an unrelated pane zoomed', async () => {
    // Regression: the zoom flag used to reflect only "is the window zoomed
    // at all" (`#{window_zoomed_flag}`), which reads identically for every
    // pane in a split window no matter which one is actually zoomed.
    // Attaching to pane 1 while pane 0 was the zoomed one read as "already
    // zoomed, nothing to do" and left the view stuck on pane 0 — reported as
    // "can't reliably attach to a selected pane, panes mixed together".
    await startUserSession('multipane', t.projectDir, ['sleep', '120']);
    await tmux('split-window', '-t', 'multipane', '-c', t.projectDir, '--', 'sleep', '120');

    let panes: any[] = [];
    await waitFor(async () => {
      panes = (await listTargets()).targets.filter((x) => x.sessionName === 'multipane');
      return panes.length === 2;
    }, { timeout: 5000 });

    const paneZero = panes.find((x) => x.paneIndex === 0);
    const paneOne = panes.find((x) => x.paneIndex === 1);
    expect(paneZero).toBeDefined();
    expect(paneOne).toBeDefined();

    // Attach to (and zoom) pane 0, then detach. Detaching does not un-zoom —
    // the window stays zoomed on pane 0.
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: paneZero.id },
    });
    expect(first.statusCode).toBe(201);
    await waitFor(async () => (await paneField('multipane', '#{window_zoomed_flag}')) === '1', {
      timeout: 10_000,
    });
    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${first.json().id}`,
      headers: { cookie: t.cookie },
    });
    await waitFor(async () => (await totalAttachedInGroup('multipane')) === 0, { timeout: 10_000 });

    // The window is still zoomed, but specifically on pane 0 — the listing
    // must say so per pane, not just per window.
    const relisted = (await listTargets()).targets.filter((x) => x.sessionName === 'multipane');
    expect(relisted.find((x) => x.paneIndex === 0)?.zoomed).toBe(true);
    expect(relisted.find((x) => x.paneIndex === 1)?.zoomed).toBe(false);

    // Attaching to pane 1 now must actually re-zoom onto pane 1, not
    // silently skip it because "the window was already zoomed" (on 0).
    const paneOneTarget = relisted.find((x) => x.paneIndex === 1)!;
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: paneOneTarget.id },
    });
    expect(second.statusCode).toBe(201);
    await waitFor(async () => (await totalAttachedInGroup('multipane')) >= 1, { timeout: 10_000 });

    const final = (await listTargets()).targets.filter((x) => x.sessionName === 'multipane');
    expect(final.find((x) => x.paneIndex === 1)?.zoomed).toBe(true);
    expect(final.find((x) => x.paneIndex === 0)?.zoomed).toBe(false);
  });

  it('attaches to different windows of the same session independently, without dragging other clients along', async () => {
    // Regression: tmux's "current window" belongs to the session, shared by
    // every client attached to that session object — verified against a
    // real tmux server that a second `attach-session -t session:window`
    // forces *every* client of that session (including the user's own real
    // terminal) to jump to the newly requested window, rather than each
    // client independently viewing what it asked for. Reported as windows
    // "sticking to one" or "mixing together" when adopting more than one
    // window of the same multi-window session. `attachCommand` fixes this
    // by attaching each request to its own tmux "session group" member
    // instead of the shared session directly.
    await startUserSession('multiwindow', t.projectDir, ['sleep', '120']);
    // `-d` keeps window 0 active — `new-window` without it activates the
    // window it just created, which would make the "untouched" baseline
    // below 1 instead of a legible 0.
    await tmux('new-window', '-d', '-t', 'multiwindow', '-c', t.projectDir, '--', 'sleep', '120');

    const originalActiveWindow = async (): Promise<number> => {
      const windows = await tmux('list-windows', '-t', 'multiwindow', '-F', '#{window_index}|#{window_active}');
      const active = windows.split('\n').filter(Boolean).find((l) => l.endsWith('|1'));
      return active ? Number(active.split('|')[0]) : -1;
    };

    let targets: any[] = [];
    await waitFor(async () => {
      targets = (await listTargets()).targets.filter((x) => x.sessionName === 'multiwindow');
      return targets.some((x) => x.windowIndex === 0) && targets.some((x) => x.windowIndex === 1);
    }, { timeout: 5000 });
    // The real session's own current window before PocketAgent touches anything.
    expect(await originalActiveWindow()).toBe(0);

    const windowZero = targets.find((x) => x.windowIndex === 0);
    const windowOne = targets.find((x) => x.windowIndex === 1);

    // Attach to window 0 first, and leave it attached...
    const first = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: windowZero.id },
    });
    expect(first.statusCode).toBe(201);
    await waitFor(async () => (await totalAttachedInGroup('multiwindow')) >= 1, { timeout: 10_000 });

    // ...then, while it is still attached, attach to window 1.
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: windowOne.id },
    });
    expect(second.statusCode).toBe(201);
    await waitFor(async () => (await totalAttachedInGroup('multiwindow')) >= 2, { timeout: 10_000 });

    // The real session's own current window must be completely untouched —
    // this is what a real terminal (iTerm2 over ssh) attached to
    // 'multiwindow' itself would see, and it must not have been yanked to
    // either window PocketAgent asked for.
    expect(await originalActiveWindow()).toBe(0);

    // Each PocketAgent client independently shows the window it was
    // actually given, not whichever was attached most recently.
    const views = await viewSessionsFor('multiwindow');
    expect(views).toHaveLength(2);
    const activeWindows = new Set(views.map((v) => v.activeWindow));
    expect(activeWindows.has(0)).toBe(true);
    expect(activeWindows.has(1)).toBe(true);

    // Detaching both cleans up their view sessions rather than leaking them.
    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${first.json().id}`,
      headers: { cookie: t.cookie },
    });
    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${second.json().id}`,
      headers: { cookie: t.cookie },
    });
    await waitFor(async () => (await viewSessionsFor('multiwindow')).length === 0, { timeout: 10_000 });

    // The real session, both its windows, and their processes are untouched.
    expect(await userSessionExists('multiwindow')).toBe(true);
    const windowsAfter = await tmux('list-windows', '-t', 'multiwindow', '-F', '#{window_index}');
    expect(windowsAfter.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('never lists its own ephemeral view sessions as adoptable targets', async () => {
    await startUserSession('noleak', t.projectDir, ['sleep', '120']);
    const target = (await listTargets()).targets.find((x) => x.sessionName === 'noleak');

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    expect(created.statusCode).toBe(201);
    await waitFor(async () => (await totalAttachedInGroup('noleak')) >= 1, { timeout: 10_000 });

    // The view session it just created is real, in tmux's own listing...
    expect(await viewSessionsFor('noleak')).toHaveLength(1);
    // ...but must never itself show up as something the Shell dialog could
    // offer to attach to — it would just duplicate 'noleak's own pane.
    const allTargets = (await listTargets()).targets;
    expect(allTargets.some((x) => x.sessionName.startsWith('pocketagent-view-'))).toBe(false);

    await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${created.json().id}`,
      headers: { cookie: t.cookie },
    });
  });

  it('never zooms a single-pane window, so attaching again does not disturb an already-attached viewer', async () => {
    // Regression: `resize-pane -Z` on a single-pane window never actually
    // enters a zoomed state — verified against a real tmux server that
    // `window_zoomed_flag` stays 0 regardless — so `zoomed`/`windowZoomed`
    // read false forever for such a window. The old code's `if
    // (!target.zoomed)` guard therefore fired the zoom toggle on every
    // single attach. Also verified against a real tmux server: that toggle
    // still broadcasts a full redraw (ending in a fresh copy of the
    // shell's own prompt) to every OTHER client already attached to that
    // window, even though nothing visually changes for the attaching one.
    // Reported as the same prompt line duplicated dozens of times in an
    // already-open browser tab, on a window with only one pane.
    await startUserSession('singlepane', t.projectDir, ['sleep', '120']);

    const target = (await listTargets()).targets.find((x) => x.sessionName === 'singlepane');
    expect(target).toBeDefined();
    expect(target.zoomed).toBe(false);

    const first = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: target.id },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id as string;
    await waitFor(async () => (await totalAttachedInGroup('singlepane')) >= 1, { timeout: 10_000 });

    // A single-pane window must never actually become zoomed.
    expect(await paneField('singlepane', '#{window_zoomed_flag}')).toBe('0');

    const firstSession = t.context.sessions.getOrThrow(firstId);
    await waitFor(() => firstSession.buffer.replayAfter(0).data.length > 0, { timeout: 10_000 });
    const bytesBeforeSecondAttach = firstSession.buffer.replayAfter(0).data.length;

    // Attach a second, independent viewer of the SAME window while the
    // first is still attached — exactly what a second browser tab, or a
    // detach-then-reattach cycle observed from an already-open tab, does.
    const targetAgain = (await listTargets()).targets.find((x) => x.sessionName === 'singlepane');
    const second = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, adoptTargetId: targetAgain.id },
    });
    expect(second.statusCode).toBe(201);
    await waitFor(async () => (await totalAttachedInGroup('singlepane')) >= 2, { timeout: 10_000 });

    // Give any (unwanted) redraw broadcast time to arrive, then confirm the
    // FIRST client's own output buffer received nothing new as a result of
    // the second one attaching.
    await sleep(500);
    expect(firstSession.buffer.replayAfter(0).data.length).toBe(bytesBeforeSecondAttach);
    expect(await paneField('singlepane', '#{window_zoomed_flag}')).toBe('0');
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

    await waitFor(async () => (await totalAttachedInGroup('survivor')) >= 1, { timeout: 10_000 });

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

    // ...but the user's session is untouched, with the client simply gone —
    // including PocketAgent's own view-session sibling, which `cleanupView`
    // (wired to this session's own `exit` event) tears down right along with it.
    expect(await userSessionExists('survivor')).toBe(true);
    await waitFor(async () => (await totalAttachedInGroup('survivor')) === 0, { timeout: 10_000 });

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
    await waitFor(async () => (await totalAttachedInGroup('outlives-us')) >= 1, { timeout: 10_000 });

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
