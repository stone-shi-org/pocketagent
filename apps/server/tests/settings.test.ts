import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { createTestApp, type TestApp } from './helpers.js';
import type { AgentAdapter } from '../src/agents/types.js';
import type { PtySession } from '../src/sessions/pty-session.js';

/**
 * The operator's global "skip all approvals" switch (`PATCH /api/settings`).
 *
 * This is the one deliberate override of PocketAgent's core invariant —
 * "never answer a prompt for the user, unless they explicitly said so" — see
 * CLAUDE.md. It exists because a specific operator asked for it with full
 * knowledge of what it removes, not as a pattern to extend casually.
 */

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

describe('global skip-permissions switch over HTTP', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('is off by default', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t) });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.skipPermissionsEnabled).toBe(false);
  });

  it('requires authentication', async () => {
    t = await createTestApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(401);
  });

  it('flips on and back off, reflected immediately on the next read', async () => {
    t = await createTestApp();

    const on = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: true },
    });
    expect(on.json().settings.skipPermissionsEnabled).toBe(true);

    const get = await t.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t) });
    expect(get.json().settings.skipPermissionsEnabled).toBe(true);

    const off = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: false },
    });
    expect(off.json().settings.skipPermissionsEnabled).toBe(false);
  });

  it('rejects a malformed body rather than guessing', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('global skip-permissions switch, persisted across a restart', () => {
  it('survives a restart even though POCKETAGENT_GLOBAL_SKIP_PERMISSIONS was never set', async () => {
    // A database that outlives the "crash" — as a real on-disk one would.
    const db = openDatabase(':memory:');

    let t = await createTestApp({}, db);
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: true },
    });
    await t.cleanup();

    // Restart against the same database, with no env var set at all: the
    // persisted value must win, the same rule `workspaces` already follows.
    t = await createTestApp({}, db);
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t) });
    expect(res.json().settings.skipPermissionsEnabled).toBe(true);
    await t.cleanup();
    db.close();
  });

  it('seeds from POCKETAGENT_GLOBAL_SKIP_PERMISSIONS only on a fresh database', async () => {
    const t = await createTestApp({ POCKETAGENT_GLOBAL_SKIP_PERMISSIONS: 'true' });
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t) });
    expect(res.json().settings.skipPermissionsEnabled).toBe(true);
    await t.cleanup();
  });
});

describe('global skip-permissions switch gates new session creation', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('does not grant it to an agent with no auto-approve flag to opt into', async () => {
    t = await createTestApp();
    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: true },
    });

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().skipPermissionsEnabled).toBe(false);
  });

  it('applies to a new session of an agent that supports it, with no per-session opt-in requested', async () => {
    t = await createTestApp();

    // A minimal test-only adapter with an auto-approve flag, so this test does
    // not depend on a real `claude` binary being on PATH.
    const fakeAdapter: AgentAdapter = {
      id: 'fake-skippable',
      displayName: 'Fake',
      description: 'test-only adapter with an auto-approve flag',
      transports: ['terminal'],
      defaultTransport: 'terminal',
      supportsSkipPermissions: true,
      buildCommand: (options) => ({
        command: '/bin/bash',
        args: options.skipPermissions ? ['-i', '-l'] : ['-i'],
      }),
    };
    t.context.agents.register(fakeAdapter);

    await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { skipPermissionsEnabled: true },
    });

    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'fake-skippable', cwd: t.projectDir },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json();
    expect(body.skipPermissionsEnabled).toBe(true);

    const session = t.context.sessions.get(body.id) as PtySession;
    expect(session.spec.args).toEqual(['-i', '-l']);
  });
});
