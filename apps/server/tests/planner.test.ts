import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PlannerWorkspaceError,
  PlannerWorkspaceRegistry,
  type PlannerWorkspaceRow,
  type PlannerWorkspaceStore,
} from '../src/planner/workspaces.js';
import { makeWorkspace, authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-6, phase 1 (foundation): the planner's own app-owned workspaces, the
 * model catalog for the single configured LLM provider, and that provider's
 * settings. No chat, no tools, no approval gate yet — see PA-6 for the later
 * phases these tests do not cover.
 */

// ---- PlannerWorkspaceRegistry, unit-level against an in-memory store -------

function makeStore(): PlannerWorkspaceStore {
  const rows: PlannerWorkspaceRow[] = [];
  let seeded = false;
  return {
    list: () => [...rows],
    insert: (row) => rows.push(row),
    delete: (id) => {
      const before = rows.length;
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return rows.length < before;
    },
    rename: (id, name) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.name = name;
    },
    isSeeded: () => seeded,
    markSeeded: () => {
      seeded = true;
    },
  };
}

describe('PlannerWorkspaceRegistry', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let root: string;

  beforeEach(() => {
    ws = makeWorkspace();
    root = path.join(ws.root, 'planner-workspaces');
  });

  afterEach(() => ws.cleanup());

  it('seeds exactly one default workspace on disk', async () => {
    const store = makeStore();
    const registry = new PlannerWorkspaceRegistry(store);
    await registry.ensureDefaultWorkspace(root);

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.isDefault).toBe(true);
    expect(list[0]?.name).toBe('Pocket Agent');
    expect(fs.statSync(list[0]!.path).isDirectory()).toBe(true);
  });

  it('does not reseed after the default workspace is removed from the store', async () => {
    // Simulates a restart against a database that already recorded the seed
    // but no longer has the row (the user deliberately removed it) — the
    // same "seeded flag wins over an empty table" discipline `workspaces_seeded`
    // uses for project folders.
    const store = makeStore();
    store.markSeeded();
    const registry = new PlannerWorkspaceRegistry(store);
    await registry.ensureDefaultWorkspace(root);

    expect(registry.list()).toHaveLength(0);
  });

  it('is idempotent across repeated calls', async () => {
    const store = makeStore();
    const registry = new PlannerWorkspaceRegistry(store);
    await registry.ensureDefaultWorkspace(root);
    await registry.ensureDefaultWorkspace(root);
    expect(registry.list()).toHaveLength(1);
  });

  it('creates a new workspace as a fresh directory under root', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Research Notes');
    expect(row.name).toBe('Research Notes');
    expect(path.dirname(row.path)).toBe(await fs.promises.realpath(root));
    expect(fs.statSync(row.path).isDirectory()).toBe(true);
  });

  it('de-duplicates directory names derived from the same slug', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const a = await registry.create(root, 'Skills');
    const b = await registry.create(root, 'Skills');
    expect(path.basename(a.path)).toBe('skills');
    expect(path.basename(b.path)).toBe('skills-2');
  });

  it('rejects a name with no letters or digits', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    await expect(registry.create(root, '   ')).rejects.toThrow(PlannerWorkspaceError);
    await expect(registry.create(root, '***')).rejects.toMatchObject({ code: 'invalid' });
  });

  // ---- PA-6 round 4: pointing an agent at an existing directory --------------

  it('points a workspace at an existing directory when opts.path is given, instead of creating one under root', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Pointed', { path: ws.project });
    expect(row.path).toBe(await fs.promises.realpath(ws.project));
    // A directory anywhere on the host, not nested under `root` at all.
    expect(row.path.startsWith(root)).toBe(false);
  });

  it('rejects opts.path pointing at a directory that does not exist, unless opts.create is set', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const missing = path.join(ws.root, 'does-not-exist-yet');
    await expect(registry.create(root, 'Pointed', { path: missing })).rejects.toMatchObject({ code: 'invalid' });

    const row = await registry.create(root, 'Pointed', { path: missing, create: true });
    expect(fs.statSync(row.path).isDirectory()).toBe(true);
  });

  it('rejects opts.path pointing at a file rather than a directory', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const filePath = path.join(ws.root, 'a-file.txt');
    fs.writeFileSync(filePath, 'hi');
    await expect(registry.create(root, 'Pointed', { path: filePath })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('rejects opts.path when another agent already uses that exact directory', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    await registry.create(root, 'First', { path: ws.project });
    await expect(registry.create(root, 'Second', { path: ws.project })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to remove the default workspace', async () => {
    const store = makeStore();
    const registry = new PlannerWorkspaceRegistry(store);
    await registry.ensureDefaultWorkspace(root);
    const [defaultRow] = registry.list();
    expect(() => registry.remove(defaultRow!.id)).toThrow(PlannerWorkspaceError);
    expect(() => registry.remove(defaultRow!.id)).toThrow(/cannot be removed/);
  });

  it('removes a non-default workspace', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Scratch');
    expect(registry.remove(row.id)).toBe(true);
    expect(registry.get(row.id)).toBeUndefined();
  });

  it('renames a workspace without touching its on-disk directory', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Old Name');
    const renamed = registry.rename(row.id, 'New Name');
    expect(renamed.name).toBe('New Name');
    expect(renamed.path).toBe(row.path);
    expect(registry.get(row.id)?.name).toBe('New Name');
    expect(fs.statSync(row.path).isDirectory()).toBe(true);
  });

  it('renaming the default workspace is allowed (unlike removing it)', async () => {
    const store = makeStore();
    const registry = new PlannerWorkspaceRegistry(store);
    await registry.ensureDefaultWorkspace(root);
    const [defaultRow] = registry.list();
    const renamed = registry.rename(defaultRow!.id, 'My Assistant');
    expect(renamed.isDefault).toBe(true);
    expect(renamed.name).toBe('My Assistant');
  });

  it('rejects renaming to an empty name', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Scratch');
    expect(() => registry.rename(row.id, '   ')).toThrow(PlannerWorkspaceError);
  });

  it('rejects renaming an unknown workspace', () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    expect(() => registry.rename('does-not-exist', 'X')).toThrow(PlannerWorkspaceError);
  });

  it('reuses the containment primitive: contains() only matches inside a root', async () => {
    const registry = new PlannerWorkspaceRegistry(makeStore());
    const row = await registry.create(root, 'Sandbox');
    expect(registry.contains(row.path)).toBe(true);
    expect(registry.contains(path.join(row.path, 'nested', 'file.txt'))).toBe(true);
    expect(registry.contains('/etc/passwd')).toBe(false);
  });
});

// ---- HTTP surface -----------------------------------------------------------

describe('planner routes over HTTP', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const post = (url: string, payload?: unknown) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: authHeaders(t.cookie),
      ...(payload !== undefined ? { payload } : {}),
    });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });
  const del = (url: string) => t.app.inject({ method: 'DELETE', url, headers: authHeaders(t.cookie) });

  it('boots with exactly one default workspace already present', async () => {
    const res = await get('/api/planner/workspaces');
    expect(res.statusCode).toBe(200);
    const { workspaces } = res.json();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].isDefault).toBe(true);
    expect(workspaces[0].name).toBe('Pocket Agent');
  });

  it('requires authentication', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/planner/workspaces' });
    expect(res.statusCode).toBe(401);
  });

  it('creates and removes a planner workspace', async () => {
    const created = await post('/api/planner/workspaces', { name: 'Skills' });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect(row.name).toBe('Skills');
    expect(row.isDefault).toBe(false);

    const removed = await del(`/api/planner/workspaces/${row.id}`);
    expect(removed.statusCode).toBe(204);

    const list = (await get('/api/planner/workspaces')).json().workspaces;
    expect(list.find((w: { id: string }) => w.id === row.id)).toBeUndefined();
  });

  it('creates a workspace pointed at an existing directory when path is given', async () => {
    const created = await post('/api/planner/workspaces', { name: 'Pointed', path: t.workspaceRoot });
    expect(created.statusCode).toBe(201);
    const row = created.json();
    expect(row.path).toBe(fs.realpathSync(t.workspaceRoot));
  });

  it('400s creating a workspace pointed at a directory that does not exist without createPath', async () => {
    const res = await post('/api/planner/workspaces', {
      name: 'Pointed',
      path: path.join(t.workspaceRoot, 'not-there-yet'),
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a not-yet-existing directory when createPath is set', async () => {
    const target = path.join(t.workspaceRoot, 'brand-new-agent-dir');
    const created = await post('/api/planner/workspaces', { name: 'Pointed', path: target, createPath: true });
    expect(created.statusCode).toBe(201);
    expect(fs.statSync(created.json().path).isDirectory()).toBe(true);
  });

  it('400s a second agent pointed at the same exact directory', async () => {
    await post('/api/planner/workspaces', { name: 'First', path: t.workspaceRoot });
    const res = await post('/api/planner/workspaces', { name: 'Second', path: t.workspaceRoot });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to remove the default workspace over HTTP', async () => {
    const list = (await get('/api/planner/workspaces')).json().workspaces;
    const defaultWorkspace = list.find((w: { isDefault: boolean }) => w.isDefault);
    const res = await del(`/api/planner/workspaces/${defaultWorkspace.id}`);
    expect(res.statusCode).toBe(403);
  });

  it('404s removing an unknown workspace', async () => {
    const res = await del('/api/planner/workspaces/does-not-exist');
    expect(res.statusCode).toBe(404);
  });

  it('renames a workspace over HTTP, including the default one', async () => {
    const created = await post('/api/planner/workspaces', { name: 'Old' });
    const row = created.json();
    const renamed = await patch(`/api/planner/workspaces/${row.id}`, { name: 'New' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('New');

    const list = (await get('/api/planner/workspaces')).json().workspaces;
    const defaultWorkspace = list.find((w: { isDefault: boolean }) => w.isDefault);
    const renamedDefault = await patch(`/api/planner/workspaces/${defaultWorkspace.id}`, {
      name: 'My Assistant',
    });
    expect(renamedDefault.statusCode).toBe(200);
    expect(renamedDefault.json().name).toBe('My Assistant');
  });

  it('404s renaming an unknown workspace', async () => {
    const res = await patch('/api/planner/workspaces/does-not-exist', { name: 'X' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects renaming to an empty name over HTTP', async () => {
    const created = await post('/api/planner/workspaces', { name: 'Old' });
    const res = await patch(`/api/planner/workspaces/${created.json().id}`, { name: '' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty workspace name', async () => {
    const res = await post('/api/planner/workspaces', { name: '' });
    expect(res.statusCode).toBe(400);
  });

  it('lists no models by default, then CRUDs them in sort order', async () => {
    expect((await get('/api/planner/models')).json().models).toEqual([]);

    const first = await post('/api/planner/models', { modelId: 'gpt-4o-mini', label: 'Fast' });
    expect(first.statusCode).toBe(201);
    const second = await post('/api/planner/models', { modelId: 'gpt-4o', label: 'Capable' });
    expect(second.statusCode).toBe(201);

    const list = (await get('/api/planner/models')).json().models;
    expect(list.map((m: { label: string }) => m.label)).toEqual(['Fast', 'Capable']);

    const removed = await del(`/api/planner/models/${first.json().id}`);
    expect(removed.statusCode).toBe(204);
    expect((await get('/api/planner/models')).json().models).toHaveLength(1);
  });

  it('settings default to unconfigured, off, and no remembered model', async () => {
    const res = await get('/api/planner/settings');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      baseUrl: null,
      hasApiKey: false,
      yoloEnabled: false,
      lastModelId: null,
    });
  });

  it('PATCH updates settings without ever echoing the API key back', async () => {
    const res = await patch('/api/planner/settings', {
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-super-secret',
      yoloEnabled: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.baseUrl).toBe('https://api.example.com/v1');
    expect(body.hasApiKey).toBe(true);
    expect(body.yoloEnabled).toBe(true);
    expect(body).not.toHaveProperty('apiKey');
    expect(JSON.stringify(body)).not.toContain('sk-super-secret');
  });

  it('an omitted apiKey on PATCH leaves the stored key untouched', async () => {
    await patch('/api/planner/settings', { apiKey: 'sk-first' });
    await patch('/api/planner/settings', { yoloEnabled: true });
    const revealed = await post('/api/planner/settings/api-key/reveal');
    expect(revealed.json().apiKey).toBe('sk-first');
  });

  it('an empty-string apiKey on PATCH clears it', async () => {
    await patch('/api/planner/settings', { apiKey: 'sk-first' });
    await patch('/api/planner/settings', { apiKey: '' });
    expect((await get('/api/planner/settings')).json().hasApiKey).toBe(false);
    const revealed = await post('/api/planner/settings/api-key/reveal');
    expect(revealed.statusCode).toBe(404);
  });

  it('reveals the exact configured API key', async () => {
    await patch('/api/planner/settings', { apiKey: 'sk-reveal-me' });
    const res = await post('/api/planner/settings/api-key/reveal');
    expect(res.statusCode).toBe(200);
    expect(res.json().apiKey).toBe('sk-reveal-me');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('404s revealing when no key is configured', async () => {
    const res = await post('/api/planner/settings/api-key/reveal');
    expect(res.statusCode).toBe(404);
  });

  // ---- PA-6 phase 5: the tool catalog and remembered-decision management ----

  it('lists the tool catalog with its read-only flags', async () => {
    const res = await get('/api/planner/tools');
    expect(res.statusCode).toBe(200);
    const { tools } = res.json();
    const byName = Object.fromEntries(tools.map((t: { name: string; readOnly: boolean }) => [t.name, t.readOnly]));
    expect(byName.list_workspaces).toBe(true);
    expect(byName.exec_command).toBe(false);
  });

  it('has no remembered decisions by default', async () => {
    const res = await get('/api/planner/tool-approvals');
    expect(res.json().approvals).toEqual([]);
  });

  it('creates, lists, and deletes a global remembered decision', async () => {
    const created = await post('/api/planner/tool-approvals', {
      scope: 'global',
      toolName: 'exec_command',
      decision: 'deny',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      scope: 'global',
      workspaceId: null,
      toolName: 'exec_command',
      decision: 'deny',
    });

    const list = (await get('/api/planner/tool-approvals')).json().approvals;
    expect(list).toHaveLength(1);

    const removed = await del(`/api/planner/tool-approvals/${created.json().id}`);
    expect(removed.statusCode).toBe(204);
    expect((await get('/api/planner/tool-approvals')).json().approvals).toEqual([]);
  });

  it('creates a workspace-scoped decision only for a real workspace', async () => {
    const ws = (await post('/api/planner/workspaces', { name: 'Scoped' })).json();
    const created = await post('/api/planner/tool-approvals', {
      scope: 'workspace',
      workspaceId: ws.id,
      toolName: 'mkdir',
      decision: 'allow',
    });
    expect(created.statusCode).toBe(201);

    const missingWorkspace = await post('/api/planner/tool-approvals', {
      scope: 'workspace',
      toolName: 'mkdir',
      decision: 'allow',
    });
    expect(missingWorkspace.statusCode).toBe(400);

    const unknownWorkspace = await post('/api/planner/tool-approvals', {
      scope: 'workspace',
      workspaceId: 'does-not-exist',
      toolName: 'mkdir',
      decision: 'allow',
    });
    expect(unknownWorkspace.statusCode).toBe(404);
  });

  it('setting a decision twice for the same scope/tool replaces it, not duplicates it', async () => {
    await post('/api/planner/tool-approvals', { scope: 'global', toolName: 'rmdir', decision: 'allow' });
    await post('/api/planner/tool-approvals', { scope: 'global', toolName: 'rmdir', decision: 'deny' });
    const list = (await get('/api/planner/tool-approvals')).json().approvals;
    expect(list).toHaveLength(1);
    expect(list[0].decision).toBe('deny');
  });

  it('404s deleting an unknown remembered decision', async () => {
    const res = await del('/api/planner/tool-approvals/does-not-exist');
    expect(res.statusCode).toBe(404);
  });
});
