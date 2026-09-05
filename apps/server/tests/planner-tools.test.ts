import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import {
  PLANNER_TOOLS,
  findPlannerTool,
  summarizeEvents,
  toOpenAiToolSpecs,
  type PlannerToolDeps,
} from '../src/planner/tools.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-6: the planner's tool catalog (read-only from phase 3, mutating from
 * phase 4), tested directly against a real `createTestApp()` context rather
 * than through a mocked LLM — the tool-calling *loop* itself (parsing
 * `tool_calls`, the approval pause/resume) is covered in
 * `planner-chats.test.ts` instead.
 */

function depsFor(t: TestApp): PlannerToolDeps {
  const { workspaces, plannerWorkspaces, sessions, worktrees, conversations, agyTranscripts, piTranscripts } =
    t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
  };
}

describe('PLANNER_TOOLS catalog', () => {
  it('marks exactly the read/write tools read-only or not, matching PA-6 phases 3 and 4', () => {
    const readOnlyNames = PLANNER_TOOLS.filter((t) => t.readOnly).map((t) => t.name).sort();
    const mutatingNames = PLANNER_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(readOnlyNames).toEqual(
      ['list_sessions', 'list_workspaces', 'read_file', 'read_session_output'].sort(),
    );
    expect(mutatingNames).toEqual(
      ['delete_worktree', 'mkdir', 'rmdir', 'send_instruction', 'write_file'].sort(),
    );
  });

  it('toOpenAiToolSpecs shapes each tool as an OpenAI function spec', () => {
    const specs = toOpenAiToolSpecs(PLANNER_TOOLS) as {
      type: string;
      function: { name: string };
    }[];
    expect(specs.length).toBe(PLANNER_TOOLS.length);
    expect(specs.every((s) => s.type === 'function')).toBe(true);
    expect(specs.map((s) => s.function.name)).toEqual(PLANNER_TOOLS.map((t) => t.name));
  });

  it('findPlannerTool finds by name and returns undefined for unknown names', () => {
    expect(findPlannerTool('list_workspaces')?.name).toBe('list_workspaces');
    expect(findPlannerTool('delete_everything')).toBeUndefined();
  });
});

describe('summarizeEvents', () => {
  it('renders each handled event kind and skips the rest', () => {
    const events: AgentEvent[] = [
      { kind: 'user_prompt', id: '1', text: 'plan my day' },
      { kind: 'text', id: '2', text: 'Sure, here is a plan.' },
      {
        kind: 'tool_use',
        id: '3',
        name: 'Read',
        input: {},
        summary: 'Read notes.txt',
        filePath: '/tmp/notes.txt',
      },
      { kind: 'tool_result', id: '4', toolUseId: '3', content: 'file contents', truncated: false, isError: false },
      { kind: 'tool_result', id: '5', toolUseId: '3', content: '', truncated: false, isError: false },
      { kind: 'notice', level: 'warn', text: 'heads up' },
      { kind: 'text_delta', id: '6', text: 'ignored partial' },
    ] as AgentEvent[];

    const summary = summarizeEvents(events);
    expect(summary).toContain('[user] plan my day');
    expect(summary).toContain('[assistant] Sure, here is a plan.');
    expect(summary).toContain('[tool call] Read notes.txt');
    expect(summary).toContain('[tool result] file contents');
    expect(summary).toContain('[warn] heads up');
    expect(summary).not.toContain('ignored partial');
    // The empty-content tool_result produced no line.
    expect(summary.match(/\[tool result\]/g)).toHaveLength(1);
  });

  it('says so when there is nothing renderable', () => {
    expect(summarizeEvents([])).toMatch(/no transcript content/);
  });
});

describe('planner tools against a real app context', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('list_workspaces returns the added project workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('list_workspaces')!;
    const result = JSON.parse(await tool.execute(depsFor(t), {}));
    // `createTestApp` registers `t.workspaceRoot` itself as the workspace
    // root; `t.projectDir` is a plain subdirectory inside it, not a second
    // registered workspace — see `WorkspaceRegistry.list()`.
    expect(result).toEqual([
      { path: t.workspaceRoot, name: path.basename(t.workspaceRoot), isGitRepo: false },
    ]);
  });

  it('list_sessions lists a real running session', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;

    const tool = findPlannerTool('list_sessions')!;
    const result = JSON.parse(await tool.execute(depsFor(t), {}));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: sessionId, agent: 'shell', cwd: t.projectDir });
  });

  it('read_session_output reports an unknown id plainly rather than throwing', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId: 'does-not-exist' });
    expect(result).toMatch(/No session found/);
  });

  it('read_session_output reports no transcript for a terminal session (never resumes a conversation)', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;

    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId });
    expect(result).toMatch(/no readable transcript/);
  });

  it('read_file reads a file inside an added project workspace', async () => {
    t = await createTestApp();
    const filePath = path.join(t.projectDir, 'notes.txt');
    await fs.writeFile(filePath, 'hello from the project');

    const tool = findPlannerTool('read_file')!;
    const result = await tool.execute(depsFor(t), { path: filePath });
    expect(result).toBe('hello from the project');
  });

  it('read_file reads a file inside the default planner workspace', async () => {
    t = await createTestApp();
    const defaultWorkspace = t.context.plannerWorkspaces.getDefault()!;
    const filePath = path.join(defaultWorkspace.path, 'skill.md');
    await fs.writeFile(filePath, '# a planner skill');

    const tool = findPlannerTool('read_file')!;
    const result = await tool.execute(depsFor(t), { path: filePath });
    expect(result).toBe('# a planner skill');
  });

  it('read_file refuses a path outside every project and planner workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('read_file')!;
    await expect(tool.execute(depsFor(t), { path: '/etc/hosts' })).rejects.toThrow(
      /outside every project workspace/,
    );
  });

  it('read_file reports (without throwing) a directory is not a file', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('read_file')!;
    const result = await tool.execute(depsFor(t), { path: t.projectDir });
    expect(result).toMatch(/is not a file/);
  });
});

// ---- PA-6, phase 4: mutating tools ------------------------------------------

describe('write_file', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('writes a new file inside an added project workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('write_file')!;
    const target = path.join(t.projectDir, 'plan.md');
    const result = await tool.execute(depsFor(t), { path: target, content: '# Plan' });
    expect(result).toMatch(/Wrote 6 characters/);
    expect(await fs.readFile(target, 'utf8')).toBe('# Plan');
  });

  it('writes into the default planner workspace', async () => {
    t = await createTestApp();
    const defaultWorkspace = t.context.plannerWorkspaces.getDefault()!;
    const target = path.join(defaultWorkspace.path, 'skill.md');
    const tool = findPlannerTool('write_file')!;
    await tool.execute(depsFor(t), { path: target, content: 'notes' });
    expect(await fs.readFile(target, 'utf8')).toBe('notes');
  });

  it('overwrites an existing file', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'existing.txt');
    await fs.writeFile(target, 'old');
    const tool = findPlannerTool('write_file')!;
    await tool.execute(depsFor(t), { path: target, content: 'new' });
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });

  it('refuses when the parent directory does not exist', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('write_file')!;
    const target = path.join(t.projectDir, 'missing-parent', 'file.txt');
    const result = await tool.execute(depsFor(t), { path: target, content: 'x' });
    expect(result).toMatch(/parent directory does not exist/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('refuses a path outside every workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('write_file')!;
    const result = await tool.execute(depsFor(t), { path: '/tmp/pa-outside-write.txt', content: 'x' });
    expect(result).toMatch(/outside every project workspace/);
  });

  it('refuses to overwrite a directory', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('write_file')!;
    const result = await tool.execute(depsFor(t), { path: t.projectDir, content: 'x' });
    expect(result).toMatch(/is a directory/);
  });
});

describe('mkdir', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('creates a directory inside a project workspace', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'sub');
    const tool = findPlannerTool('mkdir')!;
    const result = await tool.execute(depsFor(t), { path: target });
    expect(result).toMatch(/Created/);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('creates missing intermediate directories', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'a', 'b', 'c');
    const tool = findPlannerTool('mkdir')!;
    await tool.execute(depsFor(t), { path: target });
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('refuses a target outside every workspace, without creating anything', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('mkdir')!;
    const result = await tool.execute(depsFor(t), { path: '/tmp/pa-outside-mkdir/nested' });
    expect(result).toMatch(/outside every project workspace/);
  });
});

describe('rmdir', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('removes an empty directory', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'empty');
    await fs.mkdir(target);
    const tool = findPlannerTool('rmdir')!;
    const result = await tool.execute(depsFor(t), { path: target });
    expect(result).toMatch(/Removed/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('refuses a non-empty directory without recursive: true', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'full');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'file.txt'), 'x');
    const tool = findPlannerTool('rmdir')!;
    const result = await tool.execute(depsFor(t), { path: target });
    expect(result).toMatch(/not empty/);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it('removes a non-empty directory when recursive: true', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'full');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'file.txt'), 'x');
    const tool = findPlannerTool('rmdir')!;
    const result = await tool.execute(depsFor(t), { path: target, recursive: true });
    expect(result).toMatch(/Removed/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it('reports (without throwing) that a file is not a directory', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'file.txt');
    await fs.writeFile(target, 'x');
    const tool = findPlannerTool('rmdir')!;
    const result = await tool.execute(depsFor(t), { path: target });
    expect(result).toMatch(/is not a directory/);
  });

  it('refuses a path outside every workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('rmdir')!;
    const result = await tool.execute(depsFor(t), { path: '/tmp' });
    expect(result).toMatch(/outside every project workspace/);
  });
});

describe('send_instruction', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('reports an unknown session id plainly', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('send_instruction')!;
    const result = await tool.execute(depsFor(t), { sessionId: 'does-not-exist', prompt: 'hi' });
    expect(result).toMatch(/No session found/);
  });

  it('refuses to instruct a terminal (non-structured) session', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;
    const tool = findPlannerTool('send_instruction')!;
    const result = await tool.execute(depsFor(t), { sessionId, prompt: 'do something' });
    expect(result).toMatch(/terminal session/);
  });

  it('reports empty instruction text without touching the session', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;
    const tool = findPlannerTool('send_instruction')!;
    const result = await tool.execute(depsFor(t), { sessionId, prompt: '   ' });
    expect(result).toMatch(/No instruction text/);
  });
});

describe('delete_worktree', () => {
  let t: TestApp;

  afterEach(async () => {
    if (t) await t.cleanup();
  });

  /** A real repo with one commit — matching this codebase's existing
      preference (see `worktree.test.ts`) for spawning real git over mocking it.
      `WorktreeService.create()` bases the new worktree off `HEAD`, which needs
      at least one commit to exist. */
  function initRepo(cwd: string): void {
    execFileSync('git', ['init', '-q'], { cwd });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'initial'], { cwd });
  }

  it('removes a worktree and its branch', async () => {
    t = await createTestApp();
    initRepo(t.projectDir);
    const created = await t.context.worktrees.create({
      projectCwd: t.projectDir,
      branchMode: 'new',
      branchName: 'planner-wt',
    });

    const tool = findPlannerTool('delete_worktree')!;
    const result = await tool.execute(depsFor(t), { path: created.cwd });
    expect(result).toMatch(/Removed worktree/);
    await expect(fs.stat(created.cwd)).rejects.toThrow();
  });

  it('refuses when a session is still running in the worktree', async () => {
    t = await createTestApp();
    initRepo(t.projectDir);
    const created = await t.context.worktrees.create({
      projectCwd: t.projectDir,
      branchMode: 'new',
      branchName: 'planner-wt-busy',
    });
    await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: created.cwd },
    });

    const tool = findPlannerTool('delete_worktree')!;
    const result = await tool.execute(depsFor(t), { path: created.cwd });
    expect(result).toMatch(/session is still running/);
    expect((await fs.stat(created.cwd)).isDirectory()).toBe(true);
  });

  it('reports a path that is not a worktree, rather than throwing', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('delete_worktree')!;
    const result = await tool.execute(depsFor(t), { path: t.projectDir });
    expect(result).toMatch(/Could not remove worktree/);
  });
});
