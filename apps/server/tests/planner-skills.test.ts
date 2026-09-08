import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findPlannerTool, TOOL_INTEGRATION_DISABLED, type PlannerToolDeps } from '../src/planner/tools.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-38: skills — discovery (global root, and each planner workspace's own
 * `.skills/`), the two-layer enable/disable tables, `list_skills`/
 * `use_skill`, and the registration/delete routes. Mirrors
 * `planner-tools-mcp.test.ts`'s posture (a real service, real files on disk,
 * no mocking of the thing under test) rather than `planner-tools.test.ts`'s
 * pure-function style, since discovery is inherently filesystem I/O.
 */

async function writeSkill(
  dir: string,
  slug: string,
  frontmatter: { name?: string; description?: string } | 'malformed' | 'no-frontmatter-name',
  body = 'Do the thing.',
): Promise<string> {
  const skillDir = path.join(dir, slug);
  await fs.mkdir(skillDir, { recursive: true });
  const content =
    frontmatter === 'malformed'
      ? 'This file has no frontmatter delimiters at all.\n'
      : frontmatter === 'no-frontmatter-name'
        ? `---\ndescription: Missing a name.\n---\n${body}\n`
        : `---\nname: ${frontmatter.name ?? 'Untitled'}\ndescription: ${frontmatter.description ?? 'No description.'}\n---\n${body}\n`;
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  return skillDir;
}

function depsFor(t: TestApp, workspaceId?: string | null): PlannerToolDeps {
  const { workspaces, plannerWorkspaces, sessions, worktrees, conversations, agyTranscripts, piTranscripts } =
    t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
    shell: t.context.config.shell,
    memory: t.context.plannerMemory,
    mcpRegistry: t.context.mcpRegistry,
    skills: t.context.skills,
    workspaceId: workspaceId === undefined ? (t.context.plannerWorkspaces.getDefault()?.id ?? null) : workspaceId,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
  };
}

describe('skill discovery', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('discovers a valid global SKILL.md', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const found = t.context.skills.listGlobalSkills();
    expect(found).toEqual([
      { id: 'global:greeter', slug: 'greeter', name: 'Greeter', description: 'Says hello.', source: 'global', sourceLabel: 'Global' },
    ]);
  });

  it('discovers a valid per-workspace SKILL.md, invisible to a different agent', async () => {
    t = await createTestApp();
    const ws = t.context.plannerWorkspaces.getDefault()!;
    const other = await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Other Agent');
    await writeSkill(path.join(ws.path, '.skills'), 'reviewer', { name: 'Reviewer', description: 'Reviews code.' });
    t.context.skills.refresh();

    const mine = t.context.skills.listVisibleTo(ws.id);
    expect(mine.map((s) => s.id)).toContain(`${ws.id}:reviewer`);

    // A different agent's own view sees only the global catalog (empty here)
    // plus its own `.skills/` (also empty) — never another agent's skill.
    const theirs = t.context.skills.listVisibleTo(other.id);
    expect(theirs.map((s) => s.id)).not.toContain(`${ws.id}:reviewer`);
  });

  it('skips a directory with no SKILL.md, and one with malformed frontmatter, without throwing', async () => {
    t = await createTestApp();
    await fs.mkdir(path.join(t.context.plannerSkillsRoot, 'empty-dir'), { recursive: true });
    await writeSkill(t.context.plannerSkillsRoot, 'bad-frontmatter', 'malformed');
    await writeSkill(t.context.plannerSkillsRoot, 'no-name', 'no-frontmatter-name');
    await writeSkill(t.context.plannerSkillsRoot, 'good', { name: 'Good', description: 'Works fine.' });

    expect(() => t.context.skills.refresh()).not.toThrow();
    expect(t.context.skills.listGlobalSkills().map((s) => s.slug)).toEqual(['good']);
  });

  it('rejects a directory name that is not a valid slug', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'Not_A_Slug', { name: 'X', description: 'Y' });
    t.context.skills.refresh();
    expect(t.context.skills.listGlobalSkills()).toEqual([]);
  });
});

describe('skill enablement (two layers)', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('a global disable removes a skill for every agent regardless of per-agent setting', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'shared', { name: 'Shared', description: 'For everyone.' });
    t.context.skills.refresh();
    const id = 'global:shared';
    const wsA = t.context.plannerWorkspaces.getDefault()!.id;
    const wsB = (await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Second Agent')).id;

    expect(t.context.skills.listKnownSkills(wsA).map((s) => s.id)).toContain(id);
    expect(t.context.skills.listKnownSkills(wsB).map((s) => s.id)).toContain(id);

    const { setSkillEnabledGlobally } = await import('../src/planner/store.js');
    setSkillEnabledGlobally(t.db, id, false);

    expect(t.context.skills.listKnownSkills(wsA).map((s) => s.id)).not.toContain(id);
    expect(t.context.skills.listKnownSkills(wsB).map((s) => s.id)).not.toContain(id);
    // Re-enabling globally restores it for both, same idempotent either-way
    // contract `setToolEnabledGlobally` already has.
    setSkillEnabledGlobally(t.db, id, true);
    expect(t.context.skills.listKnownSkills(wsA).map((s) => s.id)).toContain(id);
  });

  it('a per-agent disable removes a skill only for that agent', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'shared', { name: 'Shared', description: 'For everyone.' });
    t.context.skills.refresh();
    const id = 'global:shared';
    const wsA = t.context.plannerWorkspaces.getDefault()!.id;
    const wsB = (await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Second Agent')).id;

    const { setSkillEnabledForWorkspace } = await import('../src/planner/store.js');
    setSkillEnabledForWorkspace(t.db, wsA, id, false);

    expect(t.context.skills.listKnownSkills(wsA).map((s) => s.id)).not.toContain(id);
    expect(t.context.skills.listKnownSkills(wsB).map((s) => s.id)).toContain(id);
  });
});

describe('list_skills / use_skill tools', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('list_skills reports "(no skills available)" when none are configured', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('list_skills')!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toBe('(no skills available)');
  });

  it('list_skills lists an enabled skill by name and description', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const tool = findPlannerTool('list_skills')!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toBe('Greeter — Says hello.');
  });

  it('use_skill returns the full body (frontmatter stripped) for an enabled skill', async () => {
    t = await createTestApp();
    await writeSkill(
      t.context.plannerSkillsRoot,
      'greeter',
      { name: 'Greeter', description: 'Says hello.' },
      'Step 1: say hello.\nStep 2: ask how they are.',
    );
    t.context.skills.refresh();
    const tool = findPlannerTool('use_skill')!;
    const result = await tool.execute(depsFor(t), { name: 'Greeter' });
    expect(result).toBe('Step 1: say hello.\nStep 2: ask how they are.');
    expect(result).not.toContain('---');
    expect(result).not.toContain('description:');
  });

  it('use_skill refuses an unknown name', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('use_skill')!;
    const result = await tool.execute(depsFor(t), { name: 'Nope' });
    expect(result).toMatch(/^Unknown skill: Nope\./);
  });

  it('use_skill refuses a globally disabled skill, distinguishing it from "unknown"', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const { setSkillEnabledGlobally } = await import('../src/planner/store.js');
    setSkillEnabledGlobally(t.db, 'global:greeter', false);

    const tool = findPlannerTool('use_skill')!;
    const result = await tool.execute(depsFor(t), { name: 'Greeter' });
    expect(result).toBe('Skill "Greeter" is disabled globally.');
  });

  it('use_skill refuses a skill disabled for this agent only', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const wsId = t.context.plannerWorkspaces.getDefault()!.id;
    const { setSkillEnabledForWorkspace } = await import('../src/planner/store.js');
    setSkillEnabledForWorkspace(t.db, wsId, 'global:greeter', false);

    const tool = findPlannerTool('use_skill')!;
    const result = await tool.execute(depsFor(t, wsId), { name: 'Greeter' });
    expect(result).toBe('Skill "Greeter" is disabled for this agent.');
  });
});

describe('skill registration containment', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('rejects a registration path outside every workspace/planner root', async () => {
    t = await createTestApp();
    const outside = await fs.mkdtemp('/tmp/pa-skill-outside-');
    await writeSkill(outside, '.', { name: 'X', description: 'Y' });
    await expect(t.context.skills.registerGlobalSkill(outside)).rejects.toThrow(/outside/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('registers a skill from inside a project workspace directory, copying it into the skills root', async () => {
    t = await createTestApp();
    const source = await writeSkill(t.projectDir, 'my-skill', { name: 'My Skill', description: 'From a project.' });
    const summary = await t.context.skills.registerGlobalSkill(source);
    expect(summary.id).toBe('global:my-skill');
    expect(t.context.skills.listGlobalSkills().map((s) => s.id)).toContain('global:my-skill');
  });

  it('rejects a directory with no readable SKILL.md', async () => {
    t = await createTestApp();
    const dir = path.join(t.projectDir, 'no-skill-here');
    await fs.mkdir(dir, { recursive: true });
    await expect(t.context.skills.registerGlobalSkill(dir)).rejects.toThrow(/SKILL\.md/);
  });
});

describe('skill routes', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });
  const del = (url: string) => t.app.inject({ method: 'DELETE', url, headers: authHeaders(t.cookie) });

  it('GET /api/planner/skills lists the global catalog with its enabled flag', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const res = await get('/api/planner/skills');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { skills: { id: string; enabled: boolean }[] };
    expect(body.skills).toEqual([
      expect.objectContaining({ id: 'global:greeter', enabled: true }),
    ]);
  });

  it('POST /api/planner/skills registers from a trusted path, and refuses one outside every root', async () => {
    t = await createTestApp();
    const source = await writeSkill(t.projectDir, 'registered', { name: 'Registered', description: 'Via the route.' });
    const created = await post('/api/planner/skills', { path: source });
    expect(created.statusCode).toBe(201);
    expect(created.json().id).toBe('global:registered');

    const outside = await fs.mkdtemp('/tmp/pa-skill-outside-');
    await writeSkill(outside, '.', { name: 'X', description: 'Y' });
    const rejected = await post('/api/planner/skills', { path: outside });
    expect(rejected.statusCode).toBe(400);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('PATCH /api/planner/skills/:id/global-enabled toggles the global switch', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const res = await patch('/api/planner/skills/global:greeter/global-enabled', { enabled: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().skills[0].enabled).toBe(false);
  });

  it('DELETE /api/planner/skills/:id removes a global skill and its directory', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const res = await del('/api/planner/skills/global:greeter');
    expect(res.statusCode).toBe(204);
    expect(t.context.skills.listGlobalSkills()).toEqual([]);
    await expect(fs.stat(path.join(t.context.plannerSkillsRoot, 'greeter'))).rejects.toThrow();
  });

  it('DELETE /api/planner/skills/:id refuses a per-workspace skill', async () => {
    t = await createTestApp();
    const ws = t.context.plannerWorkspaces.getDefault()!;
    await writeSkill(path.join(ws.path, '.skills'), 'mine', { name: 'Mine', description: 'Agent-owned.' });
    t.context.skills.refresh();
    const res = await del(`/api/planner/skills/${ws.id}:mine`);
    expect(res.statusCode).toBe(403);
  });

  it('GET/POST /api/planner/workspaces/:id/skills reflect the per-agent view, greying out a globally disabled one', async () => {
    t = await createTestApp();
    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();
    const wsId = t.context.plannerWorkspaces.getDefault()!.id;

    await patch('/api/planner/skills/global:greeter/global-enabled', { enabled: false });
    const before = (await get(`/api/planner/workspaces/${wsId}/skills`)).json();
    expect(before.skills).toEqual([
      expect.objectContaining({ id: 'global:greeter', enabled: false, disabledGlobally: true }),
    ]);

    await patch('/api/planner/skills/global:greeter/global-enabled', { enabled: true });
    const setDisabled = await post(`/api/planner/workspaces/${wsId}/skills`, { skillId: 'global:greeter', enabled: false });
    expect(setDisabled.json().skills).toEqual([
      expect.objectContaining({ id: 'global:greeter', enabled: false, disabledGlobally: false }),
    ]);
  });
});

describe('toolsFor omission when zero skills are enabled', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  function sseResponse(dataLines: string[]): Response {
    const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  function fakeCompletionResponse(content: string): Response {
    return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
  }

  it('omits list_skills/use_skill from the tools sent upstream until at least one skill is enabled', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeCompletionResponse('ok'));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://api.example.com' },
    });
    const chat = (
      await t.app.inject({
        method: 'POST',
        url: '/api/planner/chats',
        headers: authHeaders(t.cookie),
        payload: { modelId: 'gpt-4o' },
      })
    ).json();

    await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat.id}/messages`,
      headers: authHeaders(t.cookie),
      payload: { content: 'hi' },
    });
    const firstCallNames = (JSON.parse(fetchImpl.mock.calls[0]![1].body as string).tools as { function: { name: string } }[]).map(
      (spec) => spec.function.name,
    );
    expect(firstCallNames).not.toContain('list_skills');
    expect(firstCallNames).not.toContain('use_skill');

    await writeSkill(t.context.plannerSkillsRoot, 'greeter', { name: 'Greeter', description: 'Says hello.' });
    t.context.skills.refresh();

    const chat2 = (
      await t.app.inject({
        method: 'POST',
        url: '/api/planner/chats',
        headers: authHeaders(t.cookie),
        payload: { modelId: 'gpt-4o' },
      })
    ).json();
    await t.app.inject({
      method: 'POST',
      url: `/api/planner/chats/${chat2.id}/messages`,
      headers: authHeaders(t.cookie),
      payload: { content: 'hi again' },
    });
    const secondCallNames = (
      JSON.parse(fetchImpl.mock.calls[1]![1].body as string).tools as { function: { name: string } }[]
    ).map((spec) => spec.function.name);
    expect(secondCallNames).toContain('list_skills');
    expect(secondCallNames).toContain('use_skill');
  });
});
