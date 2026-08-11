import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  markStaleSessionsInterrupted,
  purgeExpiredAuthSessions,
  pruneOldSessions,
  type Db,
} from '../src/db/index.js';
import { createTestApp, sleep, waitFor, type TestApp } from './helpers.js';

function insertSession(db: Db, id: string, status: string, createdAt = Date.now()): void {
  db.prepare(
    `INSERT INTO sessions (id, title, agent, command, args_json, cwd, env_keys_json,
                           status, pid, cols, rows, created_at, started_at)
     VALUES (?, ?, 'shell', '/bin/bash', '[]', '/tmp', '[]', ?, 4242, 80, 24, ?, ?)`,
  ).run(id, `session ${id}`, status, createdAt, createdAt);
}

describe('database', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });
  afterEach(() => db.close());

  it('creates its schema and records a version', () => {
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBeGreaterThan(0);
  });

  it('marks running sessions interrupted, because no PTY survives a restart', () => {
    insertSession(db, 'a', 'running');
    insertSession(db, 'b', 'starting');
    insertSession(db, 'c', 'exited');

    const changed = markStaleSessionsInterrupted(db);
    expect(changed).toBe(2);

    const rows = db.prepare('SELECT id, status, pid, ended_at FROM sessions ORDER BY id').all() as {
      id: string;
      status: string;
      pid: number | null;
      ended_at: number | null;
    }[];

    expect(rows[0]).toMatchObject({ id: 'a', status: 'interrupted', pid: null });
    expect(rows[0]?.ended_at).toBeGreaterThan(0);
    expect(rows[1]).toMatchObject({ id: 'b', status: 'interrupted', pid: null });
    // A session that already finished is left exactly as it was.
    expect(rows[2]).toMatchObject({ id: 'c', status: 'exited', pid: 4242 });
  });

  it('purges expired auth sessions', () => {
    const now = Date.now();
    db.prepare(
      'INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('old', now - 1000, now - 500, now - 1000);
    db.prepare(
      'INSERT INTO auth_sessions (id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?)',
    ).run('fresh', now, now + 100_000, now);

    expect(purgeExpiredAuthSessions(db, now)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM auth_sessions').get()).toEqual({ c: 1 });
  });

  it('prunes old finished sessions but never live ones', () => {
    for (let i = 0; i < 10; i++) insertSession(db, `old-${i}`, 'exited', 1000 + i);
    insertSession(db, 'live', 'running', 500);

    pruneOldSessions(db, 3);

    const ids = (db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id);
    expect(ids).toContain('live');
    expect(ids.length).toBeLessThan(11);
  });
});

describe('restart behaviour', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('reports a session from a previous server run as interrupted, not running', async () => {
    // A database that outlives the "crash" — as a real on-disk one would.
    const db = openDatabase(':memory:');

    t = await createTestApp({}, db);
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const id = created.json().id as string;
    await sleep(200);

    const workspaceRoot = t.workspaceRoot;
    await t.app.close();

    // Simulate a hard crash rather than the graceful shutdown that just ran:
    // the row is left saying `running`, with a pid that no longer exists.
    db.prepare("UPDATE sessions SET status = 'running', pid = 999999, ended_at = NULL WHERE id = ?").run(id);
    const before = db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as {
      status: string;
    };
    expect(before.status).toBe('running');

    // Restart against the same database.
    t = await createTestApp({ POCKETAGENT_WORKSPACE_ROOTS: workspaceRoot }, db);

    const listed = await t.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
    });
    const found = listed.json().sessions.find((s: { id: string }) => s.id === id);

    expect(found.status).toBe('interrupted');
    expect(found.pid).toBeNull();

    // And it cannot be attached to — we do not pretend the process is there.
    expect(t.context.sessions.get(id)).toBeUndefined();
  });

  it('terminates running PTYs when the server shuts down', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const id = created.json().id as string;
    const session = t.context.sessions.getOrThrow(id);
    const pid = session.pid!;
    await sleep(200);

    await t.context.sessions.shutdown();
    await waitFor(() => !session.isAlive());

    // The OS agrees the process is gone.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
