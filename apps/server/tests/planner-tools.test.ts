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
 * PA-6, phase 3: the planner's read-only tool catalog, tested directly
 * against a real `createTestApp()` context rather than through a mocked LLM
 * — the tool-calling *loop* itself (parsing `tool_calls`, feeding results
 * back) is covered in `planner-chats.test.ts` instead.
 */

function depsFor(t: TestApp): PlannerToolDeps {
  const { workspaces, plannerWorkspaces, sessions, conversations, agyTranscripts, piTranscripts } =
    t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
  };
}

describe('PLANNER_TOOLS catalog', () => {
  it('every tool is read-only in this phase', () => {
    expect(PLANNER_TOOLS.every((t) => t.readOnly)).toBe(true);
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
