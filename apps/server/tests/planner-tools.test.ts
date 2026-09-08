import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import {
  PLANNER_TOOLS,
  TOOL_INTEGRATION_DISABLED,
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

function depsFor(
  t: TestApp,
  workspaceId?: string | null,
  overrides?: Partial<Pick<PlannerToolDeps, 'webSearch' | 'urlFetch' | 'fetchImpl' | 'now'>>,
): PlannerToolDeps {
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
    // Defaults to the seeded default planner workspace, like every other
    // tool call in this file implicitly runs "as" that agent — a caller
    // that cares about a different (or no) workspace passes it explicitly.
    workspaceId: workspaceId === undefined ? (t.context.plannerWorkspaces.getDefault()?.id ?? null) : workspaceId,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
    ...overrides,
  };
}

describe('PLANNER_TOOLS catalog', () => {
  it('marks exactly the read/write tools read-only or not, matching PA-6 phases 3-5', () => {
    const readOnlyNames = PLANNER_TOOLS.filter((t) => t.readOnly).map((t) => t.name).sort();
    const mutatingNames = PLANNER_TOOLS.filter((t) => !t.readOnly).map((t) => t.name).sort();
    expect(readOnlyNames).toEqual(
      [
        'get_current_time',
        'list_sessions',
        'list_workspaces',
        'memory_search',
        'read_file',
        'read_session_output',
        'url_fetch',
        'web_search',
      ].sort(),
    );
    expect(mutatingNames).toEqual(
      [
        'delete_worktree',
        'exec_command',
        'memory_save',
        'mkdir',
        'rmdir',
        'send_instruction',
        'write_file',
      ].sort(),
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

  it('get_current_time reports the injected clock, host timezone, and a matching offset/local string', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('get_current_time')!;
    const fixedNow = new Date('2026-09-07T12:34:56.000Z');
    const result = JSON.parse(
      await tool.execute(depsFor(t, undefined, { now: () => fixedNow }), {}),
    ) as { iso: string; epochMs: number; timeZone: string; utcOffset: string; local: string };

    expect(result.iso).toBe(fixedNow.toISOString());
    expect(result.epochMs).toBe(fixedNow.getTime());
    // The host's real configured zone, not a fixed value — asserted against
    // Intl directly so this test passes under any TZ the CI host happens to
    // run with.
    expect(result.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(result.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(typeof result.local).toBe('string');
    expect(result.local.length).toBeGreaterThan(0);
  });

  it('get_current_time defaults to the real wall clock when no now() is injected', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('get_current_time')!;
    const before = Date.now();
    const result = JSON.parse(await tool.execute(depsFor(t), {})) as { epochMs: number };
    const after = Date.now();
    expect(result.epochMs).toBeGreaterThanOrEqual(before);
    expect(result.epochMs).toBeLessThanOrEqual(after);
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

  it('read_session_output reads live terminal session output and strips ANSI', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;
    const session = t.context.sessions.get(sessionId)!;
    session.buffer.clear();
    session.buffer.append('running \x1b[32mtests\x1b[0m\nall passed');

    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId });
    expect(result).toBe('running tests\nall passed');
  });

  it('read_session_output reports (no terminal output yet) when a live terminal buffer is empty', async () => {
    t = await createTestApp();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(t.cookie),
      payload: { agent: 'shell', cwd: t.projectDir },
    });
    const sessionId = created.json().id as string;
    const session = t.context.sessions.get(sessionId)!;
    session.buffer.clear();

    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId });
    expect(result).toBe('(no terminal output yet)');
  });

  it('read_session_output reads live structured session events from memory buffer', async () => {
    t = await createTestApp();
    // Insert a dummy session record in db and create a structured session in live map
    const sessionId = 'live-structured-session';
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Test Chat', 'agy', 'agy', ?, 'running', 'structured', ?, 80, 24)`,
      )
      .run(sessionId, t.projectDir, Date.now());

    // Create a mock structured session and register it in live map
    const { EventBuffer } = await import('../src/terminal/event-buffer.js');
    const buffer = new EventBuffer(1024 * 1024);
    buffer.append({ kind: 'user_prompt', id: '1', text: 'help me refactor this code' });
    buffer.append({ kind: 'text', id: '2', text: 'I am refactoring the function now.' });

    (t.context.sessions as unknown as { live: Map<string, unknown> }).live.set(sessionId, {
      id: sessionId,
      status: 'running',
      pid: null,
      cols: 80,
      rows: 24,
      exitCode: null,
      exitSignal: null,
      startedAt: Date.now(),
      endedAt: null,
      lastActivityAt: Date.now(),
      externalId: null,
      agentSessionId: null,
      transport: 'structured',
      spec: { agent: 'agy', cwd: t.projectDir, createdAt: Date.now(), title: 'Test Chat' },
      buffer,
      isAlive: () => false,
      terminate: () => {},
      dispose: () => {},
    });

    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId });
    expect(result).toContain('[user] help me refactor this code');
    expect(result).toContain('[assistant] I am refactoring the function now.');
  });

  it('read_session_output combines prior transcript and live buffered events for a resumed structured session', async () => {
    const brainDir = path.join(t?.workspaceRoot ?? '/tmp', 'fake-brain');
    await fs.mkdir(path.join(brainDir, 'convo-prior', '.system_generated', 'logs'), { recursive: true });
    await fs.writeFile(
      path.join(brainDir, 'convo-prior', '.system_generated', 'logs', 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-08-22T18:26:34Z',
        content: '<USER_REQUEST>\ninitial request\n</USER_REQUEST>',
      }) + '\n',
    );

    const { AgyTranscriptStore } = await import('../src/conversations/agy.js');
    t = await createTestApp({}, undefined, new AgyTranscriptStore({ brainDir }));

    const sessionId = 'resumed-structured-session';
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Resumed Chat', 'agy', 'agy', ?, 'running', 'structured', ?, 80, 24)`,
      )
      .run(sessionId, t.projectDir, Date.now());

    const { EventBuffer } = await import('../src/terminal/event-buffer.js');
    const buffer = new EventBuffer(1024 * 1024);
    buffer.append({ kind: 'user_prompt', id: 'live-1', text: 'follow up question' });
    buffer.append({ kind: 'text', id: 'live-2', text: 'follow up answer' });

    (t.context.sessions as unknown as { live: Map<string, unknown> }).live.set(sessionId, {
      id: sessionId,
      status: 'running',
      pid: null,
      cols: 80,
      rows: 24,
      exitCode: null,
      exitSignal: null,
      startedAt: Date.now(),
      endedAt: null,
      lastActivityAt: Date.now(),
      externalId: null,
      agentSessionId: null,
      transport: 'structured',
      spec: {
        agent: 'agy',
        cwd: t.projectDir,
        createdAt: Date.now(),
        title: 'Resumed Chat',
        resumeAgentSessionId: 'convo-prior',
      },
      buffer,
      isAlive: () => false,
      terminate: () => {},
      dispose: () => {},
    });

    const tool = findPlannerTool('read_session_output')!;
    const result = await tool.execute(depsFor(t), { sessionId });
    expect(result).toContain('[user] initial request');
    expect(result).toContain('[user] follow up question');
    expect(result).toContain('[assistant] follow up answer');
  });

  it('read_session_output reports no transcript for a finished terminal session', async () => {
    t = await createTestApp();
    const sessionId = 'finished-terminal-session';
    t.db
      .prepare(
        `INSERT INTO sessions (id, title, agent, command, cwd, status, transport, created_at, cols, rows)
         VALUES (?, 'Terminal Chat', 'shell', 'bash', ?, 'stopped', 'terminal', ?, 80, 24)`,
      )
      .run(sessionId, t.projectDir, Date.now());

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

describe('exec_command', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('captures stdout and reports the exit code', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), { cwd: t.projectDir, command: 'echo hello' });
    expect(result).toContain('exit code 0');
    expect(result).toContain('hello');
  });

  it('captures stderr and a non-zero exit code', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), {
      cwd: t.projectDir,
      command: 'echo oops >&2; exit 3',
    });
    expect(result).toContain('exit code 3');
    expect(result).toContain('oops');
  });

  it('runs with the cwd it was given, not the server process cwd', async () => {
    t = await createTestApp();
    await fs.writeFile(path.join(t.projectDir, 'marker.txt'), 'x');
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), { cwd: t.projectDir, command: 'ls' });
    expect(result).toContain('marker.txt');
  });

  it('strips POCKETAGENT_ environment variables from the child', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), {
      cwd: t.projectDir,
      command: 'env | grep -c POCKETAGENT_ || true',
    });
    expect(result).toContain('exit code 0');
    expect(result).toMatch(/(^|\n)0\n/);
  });

  it('reports empty command without running anything', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), { cwd: t.projectDir, command: '   ' });
    expect(result).toMatch(/No command provided/);
  });

  it('refuses a cwd outside every workspace', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), { cwd: '/etc', command: 'echo hi' });
    expect(result).toMatch(/outside every project workspace/);
  });

  it('refuses a cwd that is not a directory', async () => {
    t = await createTestApp();
    const target = path.join(t.projectDir, 'file.txt');
    await fs.writeFile(target, 'x');
    const tool = findPlannerTool('exec_command')!;
    const result = await tool.execute(depsFor(t), { cwd: target, command: 'echo hi' });
    expect(result).toMatch(/is not a directory/);
  });
});

// ---- PA-31: web_search and url_fetch ----------------------------------------

describe('web_search', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('refuses without throwing when not configured', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('web_search')!;
    const result = await tool.execute(depsFor(t), { query: 'pocketagent' });
    expect(result).toMatch(/not configured/);
  });

  it('reports empty query without calling out', async () => {
    t = await createTestApp();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const tool = findPlannerTool('web_search')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        webSearch: { enabled: true, baseUrl: 'https://omniroute.example', apiKey: 'sk-test' },
        fetchImpl,
      }),
      { query: '   ' },
    );
    expect(result).toMatch(/No search query/);
    expect(called).toBe(false);
  });

  it('POSTs to <baseUrl>/v1/search with a bearer token and returns the JSON body', async () => {
    t = await createTestApp();
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ results: [{ title: 'PocketAgent' }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = findPlannerTool('web_search')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        webSearch: { enabled: true, baseUrl: 'https://omniroute.example/', apiKey: 'sk-test' },
        fetchImpl,
      }),
      { query: 'pocketagent', limit: 3 },
    );

    expect(requestUrl).toBe('https://omniroute.example/v1/search');
    expect((requestInit?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    expect(JSON.parse(String(requestInit?.body))).toEqual({ query: 'pocketagent', limit: 3 });
    expect(result).toBe(JSON.stringify({ results: [{ title: 'PocketAgent' }] }));
  });

  it('omits the Authorization header when no API key is configured', async () => {
    t = await createTestApp();
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      requestInit = init;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const tool = findPlannerTool('web_search')!;
    await tool.execute(
      depsFor(t, undefined, {
        webSearch: { enabled: true, baseUrl: 'https://omniroute.example', apiKey: null },
        fetchImpl,
      }),
      { query: 'pocketagent' },
    );
    expect((requestInit?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('reports a non-2xx response as a tool result rather than throwing', async () => {
    t = await createTestApp();
    const fetchImpl = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    const tool = findPlannerTool('web_search')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        webSearch: { enabled: true, baseUrl: 'https://omniroute.example', apiKey: null },
        fetchImpl,
      }),
      { query: 'pocketagent' },
    );
    expect(result).toMatch(/Web search failed: HTTP 502/);
  });
});

describe('url_fetch', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('refuses without throwing when not configured', async () => {
    t = await createTestApp();
    const tool = findPlannerTool('url_fetch')!;
    const result = await tool.execute(depsFor(t), { url: 'https://example.com' });
    expect(result).toMatch(/not configured/);
  });

  it('refuses an invalid URL without calling out', async () => {
    t = await createTestApp();
    const fetchImpl = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const tool = findPlannerTool('url_fetch')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        urlFetch: { enabled: true, baseUrl: 'https://firecrawl.example', apiKey: null },
        fetchImpl,
      }),
      { url: 'not a url' },
    );
    expect(result).toMatch(/not a valid URL/);
  });

  it('refuses a non-http(s) URL scheme without calling out', async () => {
    t = await createTestApp();
    const fetchImpl = (async () => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch;
    const tool = findPlannerTool('url_fetch')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        urlFetch: { enabled: true, baseUrl: 'https://firecrawl.example', apiKey: null },
        fetchImpl,
      }),
      { url: 'file:///etc/hosts' },
    );
    expect(result).toMatch(/Refusing to fetch/);
  });

  it('POSTs to <baseUrl>/v1/scrape with no Authorization header when no key is configured', async () => {
    t = await createTestApp();
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ markdown: '# Example' }), { status: 200 });
    }) as unknown as typeof fetch;

    const tool = findPlannerTool('url_fetch')!;
    const result = await tool.execute(
      depsFor(t, undefined, {
        urlFetch: { enabled: true, baseUrl: 'https://firecrawl.example/', apiKey: null },
        fetchImpl,
      }),
      { url: 'https://example.com/page' },
    );

    expect(requestUrl).toBe('https://firecrawl.example/v1/scrape');
    expect((requestInit?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(requestInit?.body))).toEqual({ url: 'https://example.com/page' });
    expect(result).toBe(JSON.stringify({ markdown: '# Example' }));
  });

  it('reports a timeout as a tool result rather than hanging the turn', async () => {
    // `createTestApp()` itself relies on real timers (real I/O, a real
    // tmux/sqlite boot) — fake timers only wrap the tool call below, so this
    // doesn't burn `TOOL_HTTP_TIMEOUT_MS` of wall-clock time on every run:
    // the abort fires the moment the timer is advanced, not after a real wait.
    t = await createTestApp();
    vi.useFakeTimers();
    try {
      const fetchImpl = ((_url: string | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }) as unknown as typeof fetch;

      const tool = findPlannerTool('url_fetch')!;
      const resultPromise = tool.execute(
        depsFor(t, undefined, {
          urlFetch: { enabled: true, baseUrl: 'https://firecrawl.example', apiKey: null },
          fetchImpl,
        }),
        { url: 'https://example.com' },
      );
      await vi.runAllTimersAsync();
      expect(await resultPromise).toMatch(/URL fetch failed: Request timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
