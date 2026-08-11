import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTestApp, waitFor, sleep, type TestApp } from './helpers.js';
import { buildChildEnv } from '../src/sessions/env.js';

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

async function createShellSession(t: TestApp, overrides: object = {}): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(t),
    payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24, ...overrides },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

/** Wait until the PTY buffer contains `needle`. */
async function waitForOutput(t: TestApp, id: string, needle: string): Promise<string> {
  const session = t.context.sessions.getOrThrow(id);
  await waitFor(() => session.buffer.replayAfter(0).data.includes(needle));
  return session.buffer.replayAfter(0).data;
}

describe('environment sanitization', () => {
  it('strips the PocketAgent namespace so the master token cannot leak', () => {
    const env = buildChildEnv({
      cwd: '/tmp',
      base: {
        PATH: '/usr/bin',
        POCKETAGENT_AUTH_TOKEN: 'super-secret',
        POCKETAGENT_WORKSPACE_ROOTS: '/home/me',
        HOME: '/home/me',
      },
    });
    expect(env.POCKETAGENT_AUTH_TOKEN).toBeUndefined();
    expect(env.POCKETAGENT_WORKSPACE_ROOTS).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/me');
  });

  it('sets terminal variables an interactive CLI expects', () => {
    const env = buildChildEnv({ cwd: '/tmp/work', base: { PATH: '/usr/bin' } });
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLORTERM).toBe('truecolor');
    expect(env.PWD).toBe('/tmp/work');
  });
});

describe('session HTTP routes', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('lists the built-in agents without exposing any command line', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/agents', headers: headers(t) });
    const ids = res.json().agents.map((a: { id: string }) => a.id);
    expect(ids).toContain('shell');
    expect(ids).toContain('claude');
    expect(res.body).not.toContain('/bin/bash');
  });

  it('creates a running session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 100, rows: 30 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe('running');
    expect(body.agent).toBe('shell');
    expect(body.cwd).toBe(t.projectDir);
    expect(body.cols).toBe(100);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('refuses a cwd outside the workspace roots', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: '/etc' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
  });

  it('refuses a symlink escape from inside a root', async () => {
    const link = path.join(t.workspaceRoot, 'escape');
    fs.symlinkSync('/etc', link);
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: link },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unknown agent', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'rm-rf', cwd: t.projectDir },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('unknown_agent');
  });

  it('offers no way to specify a command, argv, or env', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: {
        agent: 'shell',
        cwd: t.projectDir,
        command: '/usr/bin/curl',
        args: ['evil.example'],
        env: { LD_PRELOAD: '/tmp/evil.so' },
      },
    });
    expect(res.statusCode).toBe(201);

    const session = t.context.sessions.getOrThrow(res.json().id);
    expect(session.spec.command).toBe('/bin/bash');
    expect(session.spec.args).toEqual(['-i']);
    expect(session.spec.env.LD_PRELOAD).toBeUndefined();
  });

  it('rejects an out-of-range terminal size', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 100000, rows: 30 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforces the session limit', async () => {
    await t.cleanup();
    t = await createTestApp({ MAX_SESSIONS: '2' });

    await createShellSession(t);
    await createShellSession(t);

    const third = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('too_many_sessions');
  });

  it('returns 404 for an unknown session', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/sessions/does-not-exist',
      headers: headers(t),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('PTY lifecycle', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('runs a command and returns its output', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);

    await sleep(300);
    session.write('echo hello-from-pty\n');

    const output = await waitForOutput(t, id, 'hello-from-pty');
    // Echoed once by the tty and once as the command's own output.
    expect(output.match(/hello-from-pty/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('presents itself as a real terminal to the child process', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);

    await sleep(300);
    session.write('test -t 0 && echo IS_A_TTY\n');
    await waitForOutput(t, id, 'IS_A_TTY');

    session.write('echo TERM_IS=$TERM\n');
    const output = await waitForOutput(t, id, 'TERM_IS=xterm-256color');
    expect(output).toContain('TERM_IS=xterm-256color');
  });

  it('starts the process in the requested directory', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('pwd\n');
    const output = await waitForOutput(t, id, t.projectDir);
    expect(output).toContain(t.projectDir);
  });

  it('does not leak the master token into the child environment', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('echo "TOKENCOUNT=$(env | grep -c POCKETAGENT || true)"\n');
    const output = await waitForOutput(t, id, 'TOKENCOUNT=');
    expect(output).toContain('TOKENCOUNT=0');
  });

  it('propagates a resize to the child process', async () => {
    const id = await createShellSession(t, { cols: 80, rows: 24 });
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    expect(session.resize(132, 43)).toBe(true);
    expect(session.cols).toBe(132);

    session.write('echo "SIZE=$(tput cols)x$(tput lines)"\n');
    const output = await waitForOutput(t, id, 'SIZE=132x43');
    expect(output).toContain('SIZE=132x43');
  });

  it('ignores a resize to the same dimensions', async () => {
    const id = await createShellSession(t, { cols: 80, rows: 24 });
    const session = t.context.sessions.getOrThrow(id);
    expect(session.resize(80, 24)).toBe(false);
  });

  it('delivers Ctrl+C to the foreground job without killing the shell', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    session.write('sleep 30\n');
    await sleep(400);
    session.signal('SIGINT');

    // The shell survives and accepts the next command.
    await sleep(300);
    session.write('echo STILL_ALIVE\n');
    await waitForOutput(t, id, 'STILL_ALIVE');
    expect(session.status).toBe('running');
  });

  it('detects process exit and records the exit code', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    session.write('exit 7\n');
    await waitFor(() => !session.isAlive());

    expect(session.status).toBe('exited');
    expect(session.exitCode).toBe(7);
    expect(session.endedAt).toBeGreaterThan(0);
  });

  it('persists the exit to SQLite', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('exit 3\n');
    await waitFor(() => !session.isAlive());

    const row = t.db.prepare('SELECT status, exit_code FROM sessions WHERE id = ?').get(id) as {
      status: string;
      exit_code: number;
    };
    expect(row.status).toBe('exited');
    expect(row.exit_code).toBe(3);
  });

  it('terminates a session through the API', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    const res = await t.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${id}`,
      headers: headers(t),
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => !session.isAlive());
    expect(session.status).toBe('killed');
  });

  it('keeps the output buffer readable after the process dies', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('echo LAST_WORDS\n');
    await waitForOutput(t, id, 'LAST_WORDS');

    session.write('exit\n');
    await waitFor(() => !session.isAlive());

    expect(session.buffer.replayAfter(0).data).toContain('LAST_WORDS');
  });

  it('reports a finished session in the list with its final status', async () => {
    const id = await createShellSession(t);
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('exit 0\n');
    await waitFor(() => !session.isAlive());

    const res = await t.app.inject({ method: 'GET', url: '/api/sessions', headers: headers(t) });
    const found = res.json().sessions.find((s: { id: string }) => s.id === id);
    expect(found.status).toBe('exited');
  });

  it('keeps sessions independent of each other', async () => {
    const a = await createShellSession(t);
    const b = await createShellSession(t);
    const sessionA = t.context.sessions.getOrThrow(a);
    const sessionB = t.context.sessions.getOrThrow(b);

    await sleep(300);
    sessionA.write('echo FROM_A\n');
    sessionB.write('echo FROM_B\n');

    await waitForOutput(t, a, 'FROM_A');
    await waitForOutput(t, b, 'FROM_B');

    expect(sessionA.buffer.replayAfter(0).data).not.toContain('FROM_B');

    // Killing one leaves the other running.
    sessionA.terminate();
    await waitFor(() => !sessionA.isAlive());
    expect(sessionB.isAlive()).toBe(true);
  });
});
