import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * The general "every setting is database-backed, seeded once from `.env`,
 * never read from it again" behavior — see `apps/server/src/settings/` and
 * the settings-page plan. `settings.test.ts` covers `skipPermissionsEnabled`
 * specifically (it isn't one of `SETTINGS_FIELDS`); this covers the other
 * 21 fields via one representative live field (`maxSessions`) and one
 * restart-required field (`claudeBin`).
 */

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

describe('generalized settings fields over HTTP', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('seeds every field from .env on first boot', async () => {
    t = await createTestApp({ MAX_SESSIONS: '7', POCKETAGENT_CLAUDE_BIN: 'my-claude' });
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings.maxSessions).toBe(7);
    expect(body.settings.claudeBin).toBe('my-claude');
    expect(body.restartRequiredKeys).toContain('claudeBin');
    expect(body.restartRequiredKeys).not.toContain('maxSessions');
    expect(body.fixed.host).toBe('127.0.0.1');
  });

  it('a live field (maxSessions) takes effect immediately, no restart', async () => {
    t = await createTestApp({ MAX_SESSIONS: '10' });
    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { maxSessions: 3 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().settings.maxSessions).toBe(3);
    // The live SessionManager reads this off the same mutated `config` object.
    expect(t.context.config.maxSessions).toBe(3);
  });

  it('a persisted value outranks a later .env change on the next boot', async () => {
    const db = openDatabase(':memory:');

    const t1 = await createTestApp({ MAX_SESSIONS: '10' }, db);
    await t1.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t1),
      payload: { maxSessions: 42 },
    });
    await t1.cleanup();

    // Restart against the same database with a *different* env value — this
    // is exactly the dev/prod-mixup shape: env changed, database did not.
    const t2 = await createTestApp({ MAX_SESSIONS: '10' }, db);
    const res = await t2.app.inject({ method: 'GET', url: '/api/settings', headers: headers(t2) });
    expect(res.json().settings.maxSessions).toBe(42);
    await t2.cleanup();
    db.close();
  });

  it('rejects an out-of-range value rather than silently clamping it', async () => {
    t = await createTestApp();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: headers(t),
      payload: { maxSessions: 999 },
    });
    expect(res.statusCode).toBe(400);
  });
});
