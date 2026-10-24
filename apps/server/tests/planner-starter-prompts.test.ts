import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLANNER_STARTER_PROMPTS, effectivePlannerStarterPrompts } from '@pocketagent/protocol';
import { PLANNER_STARTER_PROMPTS_KEY, parseStarterPrompts } from '../src/planner/store.js';
import { writeSetting } from '../src/db/index.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * Starter chips: a short label plus the prompt it sends, configured globally
 * (`settings`) and optionally per agent (`planner_workspaces.starter_prompts_json`).
 */
describe('planner starter prompts', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  const custom = [{ label: 'Triage', prompt: 'Look at every open Jira issue assigned to me and rank them by urgency.' }];

  it('reads the defaults until a global list is saved, and resets to them on null', async () => {
    t = await createTestApp();
    expect((await get('/api/planner/settings')).json().starterPrompts).toEqual(DEFAULT_PLANNER_STARTER_PROMPTS);

    const saved = await patch('/api/planner/settings', { starterPrompts: custom });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().starterPrompts).toEqual(custom);
    expect((await get('/api/planner/settings')).json().starterPrompts).toEqual(custom);

    // An empty list is a real value: no chips.
    expect((await patch('/api/planner/settings', { starterPrompts: [] })).json().starterPrompts).toEqual([]);

    const reset = await patch('/api/planner/settings', { starterPrompts: null });
    expect(reset.json().starterPrompts).toEqual(DEFAULT_PLANNER_STARTER_PROMPTS);
  });

  it('refuses a label that is too long or a chip with no prompt', async () => {
    t = await createTestApp();
    const longLabel = await patch('/api/planner/settings', {
      starterPrompts: [{ label: 'x'.repeat(41), prompt: 'ok' }],
    });
    expect(longLabel.statusCode).toBe(400);
    const noPrompt = await patch('/api/planner/settings', { starterPrompts: [{ label: 'ok', prompt: '   ' }] });
    expect(noPrompt.statusCode).toBe(400);
    const tooMany = await patch('/api/planner/settings', {
      starterPrompts: Array.from({ length: 9 }, (_, i) => ({ label: `c${i}`, prompt: `p${i}` })),
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('lets an agent override the global list, and null hands it back', async () => {
    t = await createTestApp();
    const { workspaces } = (await get('/api/planner/workspaces')).json();
    const id = workspaces[0].id as string;
    expect(workspaces[0].starterPrompts).toBeNull();

    const updated = await patch(`/api/planner/workspaces/${id}`, { starterPrompts: custom });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().starterPrompts).toEqual(custom);
    // Survives a re-read from the database, not only the registry's cache.
    const reread = (await get('/api/planner/workspaces')).json().workspaces[0];
    expect(reread.starterPrompts).toEqual(custom);

    const cleared = await patch(`/api/planner/workspaces/${id}`, { starterPrompts: null });
    expect(cleared.json().starterPrompts).toBeNull();
  });

  it('reads an unparsable stored list as the defaults rather than failing the page', async () => {
    t = await createTestApp();
    writeSetting(t.app.pocket.db, PLANNER_STARTER_PROMPTS_KEY, '{not json');
    const res = await get('/api/planner/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json().starterPrompts).toEqual(DEFAULT_PLANNER_STARTER_PROMPTS);
    expect(parseStarterPrompts('[{"label":"","prompt":"x"}]')).toBeNull();
  });

  it('resolves agent override, then global, then defaults', () => {
    expect(effectivePlannerStarterPrompts(custom, [])).toEqual(custom);
    expect(effectivePlannerStarterPrompts([], custom)).toEqual([]);
    expect(effectivePlannerStarterPrompts(null, custom)).toEqual(custom);
    expect(effectivePlannerStarterPrompts(undefined, undefined)).toEqual(DEFAULT_PLANNER_STARTER_PROMPTS);
  });
});
