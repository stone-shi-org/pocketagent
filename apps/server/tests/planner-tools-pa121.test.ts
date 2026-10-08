import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyEdits, normalizeEditsArgument } from '../src/planner/edit-file.js';
import {
  MAX_COMMAND_OUTPUT_LINES,
  TOOL_INTEGRATION_DISABLED,
  findPlannerTool,
  readFileSlice,
  type PlannerToolDeps,
  type PlannerToolResult,
} from '../src/planner/tools.js';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-121: the planner tools reworked after pi's — `bash` (stdin, process
 * groups, settling on exit, tail truncation with the full output saved),
 * `read_file` paging, the new `edit_file` and `list_dir`, and running a batch
 * of reads in parallel.
 */

function depsFor(t: TestApp, overrides: Partial<PlannerToolDeps> = {}): PlannerToolDeps {
  const c = t.context;
  return {
    workspaces: c.workspaces,
    plannerWorkspaces: c.plannerWorkspaces,
    sessions: c.sessions,
    worktrees: c.worktrees,
    historyDeps: {
      sessions: c.sessions,
      conversations: c.conversations,
      agyTranscripts: c.agyTranscripts,
      piTranscripts: c.piTranscripts,
    },
    shell: c.config.shell,
    memory: c.plannerMemory,
    mcpRegistry: c.mcpRegistry,
    skills: c.skills,
    workspaceId: c.plannerWorkspaces.getDefault()?.id ?? null,
    workspacePath: t.projectDir,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
    agents: c.agents,
    subagents: {
      startPocketAgentChat: async () => {
        throw new Error('not in this test');
      },
      pocketAgentChatStatus: async () => ({ status: 'gone', summary: '' }),
      pocketAgentEnabledTools: () => [],
      findLiveCodingSubagent: () => null,
      recordCodingSubagent: () => {},
      spawnsThisTurn: () => 0,
      recordSpawn: () => {},
    },
    spawnDepth: 0,
    telegram: { links: [], send: async () => ({ ok: false, error: 'no' }) },
    db: c.db,
    config: c.config,
    customClaudeProviders: c.customClaudeProviders,
    telegramBots: c.telegramBots,
    webhooks: c.webhooks,
    cron: c.cron,
    ...overrides,
  };
}

async function run(t: TestApp, tool: string, args: Record<string, unknown>, overrides: Partial<PlannerToolDeps> = {}) {
  const result = await findPlannerTool(tool)!.execute(depsFor(t, overrides), args);
  return typeof result === 'string' ? { content: result, isError: false } : (result as Required<PlannerToolResult>);
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- bash -------------------------------------------------------------------

describe('bash (PA-121)', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('gives the command an empty stdin, so a command that reads it does not hang', async () => {
    t = await createTestApp();
    const started = Date.now();
    const result = await run(t, 'bash', { command: 'cat; echo after-cat' }, { commandTimeoutSeconds: 20 });
    expect(result.content).toContain('after-cat');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('returns when the command exits, even if it left a background process holding stdout', async () => {
    t = await createTestApp();
    const pidFile = path.join(t.projectDir, 'bg.pid');
    const started = Date.now();
    const result = await run(
      t,
      'bash',
      { command: `sleep 30 & echo $! > ${pidFile}; echo started` },
      { commandTimeoutSeconds: 20 },
    );
    expect(result.content).toContain('started');
    expect(result.content).toContain('exit code 0');
    expect(Date.now() - started).toBeLessThan(5_000);
    // A deliberately backgrounded process is left alone — that was the point.
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    expect(pidAlive(pid)).toBe(true);
    process.kill(pid, 'SIGKILL');
  });

  it('kills the whole process group on timeout, not just the shell', async () => {
    t = await createTestApp();
    const pidFile = path.join(t.projectDir, 'child.pid');
    const result = await run(
      t,
      'bash',
      { command: `sleep 30 & echo $! > ${pidFile}; wait` },
      { commandTimeoutSeconds: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('timed out after 1s and was killed');
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    await vi.waitFor(() => expect(pidAlive(pid)).toBe(false), { timeout: 2_000 });
  });

  it('stops the command when the turn is interrupted', async () => {
    t = await createTestApp();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const result = await run(t, 'bash', { command: 'sleep 30' }, { commandTimeoutSeconds: 60, signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('interrupted');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('marks a non-zero exit as an error', async () => {
    t = await createTestApp();
    const result = await run(t, 'bash', { command: 'echo nope >&2; exit 4' });
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('exit code 4');
    expect(result.content).toContain('nope');
  });

  it('keeps the tail of long output and saves the whole of it where read_file can open it', async () => {
    t = await createTestApp();
    const result = await run(t, 'bash', { command: 'seq 1 100000' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[Showing lines 98001-100000 of 100000. Full output: ');
    expect(result.content.trimEnd().endsWith('100000')).toBe(true);
    expect(result.content).not.toMatch(/^1$/m);
    const file = /Full output: (\S+)\]/.exec(result.content)![1]!;
    expect(file.startsWith(path.join(t.projectDir, '.tool-output'))).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const head = await run(t, 'read_file', { path: file, limit: 3 });
    expect(head.content.startsWith('1\n2\n3')).toBe(true);
  });

  it('says so when a command printed nothing', async () => {
    t = await createTestApp();
    expect((await run(t, 'bash', { command: 'true' })).content).toContain('(no output)');
  });
});

// ---- read_file ----------------------------------------------------------------

describe('read_file paging (PA-121)', () => {
  const text = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

  it('shows the first page and says how to continue', () => {
    const page = readFileSlice(text, {});
    expect(page.content.split('\n')[0]).toBe('line 1');
    expect(page.content).toContain(`[Showing lines 1-${MAX_COMMAND_OUTPUT_LINES} of 5000. Use offset=${MAX_COMMAND_OUTPUT_LINES + 1} to continue.]`);
  });

  it('honours offset and limit', () => {
    const page = readFileSlice(text, { offset: 10, limit: 3 });
    expect(page.content).toBe('line 10\nline 11\nline 12\n\n[4988 more lines in the file. Use offset=13 to continue.]');
    expect(readFileSlice(text, { offset: 4999 }).content).toBe('line 4999\nline 5000');
  });

  it('refuses an offset past the end', () => {
    expect(readFileSlice('a\nb\n', { offset: 9 })).toMatchObject({ isError: true });
  });

  it('refuses a binary file through the tool', async () => {
    const t = await createTestApp();
    try {
      const file = path.join(t.projectDir, 'blob.bin');
      await fs.writeFile(file, Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02]));
      expect(await run(t, 'read_file', { path: file })).toMatchObject({ isError: true });
    } finally {
      await t.cleanup();
    }
  });
});

// ---- edit_file -----------------------------------------------------------------

describe('applyEdits (PA-121)', () => {
  const file = 'function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n';

  it('replaces a unique match and reports the first changed line', () => {
    const out = applyEdits(file, [{ oldText: '  return 2;', newText: '  return 3;' }], 'f.ts');
    expect(out).toMatchObject({ ok: true, replaced: 1, firstChangedLine: 6 });
    if (out.ok) expect(out.content).toBe(file.replace('return 2', 'return 3'));
  });

  it('applies several edits, all matched against the original', () => {
    const out = applyEdits(
      file,
      [
        { oldText: 'return 2;', newText: 'return 20;' },
        { oldText: 'return 1;', newText: 'return 10;' },
      ],
      'f.ts',
    );
    expect(out.ok && out.content).toBe(file.replace('return 1', 'return 10').replace('return 2', 'return 20'));
  });

  it('refuses a missing, a duplicated, an empty and an overlapping oldText — saying which', () => {
    expect(applyEdits(file, [{ oldText: 'return 9;', newText: 'x' }], 'f.ts')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Could not find oldText in f\.ts/),
    });
    expect(applyEdits(file, [{ oldText: 'function', newText: 'fn' }], 'f.ts')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/occurs 2 times/),
    });
    expect(applyEdits(file, [{ oldText: '', newText: 'x' }], 'f.ts')).toMatchObject({ ok: false });
    expect(
      applyEdits(
        file,
        [
          { oldText: 'function a() {\n  return 1;', newText: 'x' },
          { oldText: 'return 1;\n}', newText: 'y' },
        ],
        'f.ts',
      ),
    ).toMatchObject({ ok: false, message: expect.stringMatching(/overlap/) });
    expect(applyEdits(file, [{ oldText: 'return 1;', newText: 'return 1;' }], 'f.ts')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/No changes made/),
    });
  });

  it('matches through trailing whitespace and typographic quotes, changing only the lines it touches', () => {
    const source = 'const a = "x";   \nconst msg = “hello”;\nconst z = 1;\n';
    const out = applyEdits(source, [{ oldText: 'const msg = "hello";', newText: 'const msg = "bye";' }], 'f.ts');
    expect(out.ok && out.content).toBe('const a = "x";   \nconst msg = "bye";\nconst z = 1;\n');
    const multi = applyEdits(source, [{ oldText: 'const a = "x";\nconst msg', newText: 'const a = 1;\nconst m' }], 'f.ts');
    expect(multi.ok && multi.content).toBe('const a = 1;\nconst m = “hello”;\nconst z = 1;\n');
  });

  it('keeps CRLF line endings and a BOM', () => {
    const source = '\uFEFFone\r\ntwo\r\nthree\r\n';
    const out = applyEdits(source, [{ oldText: 'two\nthree', newText: 'TWO\nTHREE' }], 'f.txt');
    expect(out.ok && out.content).toBe('\uFEFFone\r\nTWO\r\nTHREE\r\n');
  });

  it('accepts the argument shapes models actually send', () => {
    const want = [{ oldText: 'a', newText: 'b' }];
    expect(normalizeEditsArgument({ edits: want })).toEqual(want);
    expect(normalizeEditsArgument({ edits: JSON.stringify(want) })).toEqual(want);
    expect(normalizeEditsArgument({ edits: { oldText: 'a', newText: 'b' } })).toEqual(want);
    expect(normalizeEditsArgument({ oldText: 'a', newText: 'b' })).toEqual(want);
    expect(normalizeEditsArgument({ edits: [{ oldText: 'a' }] })).toBeNull();
  });
});

describe('edit_file and list_dir tools (PA-121)', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('edits a file in place and refuses outside every workspace', async () => {
    t = await createTestApp();
    const file = path.join(t.projectDir, 'cfg.yaml');
    await fs.writeFile(file, 'port: 8080\nhost: localhost\n');
    const ok = await run(t, 'edit_file', { path: file, edits: [{ oldText: 'port: 8080', newText: 'port: 9090' }] });
    expect(ok.content).toMatch(/Replaced 1 block in .*cfg\.yaml \(first change at line 1\)/);
    expect(await fs.readFile(file, 'utf8')).toBe('port: 9090\nhost: localhost\n');

    const miss = await run(t, 'edit_file', { path: file, edits: [{ oldText: 'port: 8080', newText: 'x' }] });
    expect(miss.isError).toBe(true);
    expect(await run(t, 'edit_file', { path: '/etc/hosts', edits: [{ oldText: 'a', newText: 'b' }] })).toMatchObject({
      isError: true,
    });
  });

  it('lists a directory sorted, with / on subdirectories', async () => {
    t = await createTestApp();
    await fs.mkdir(path.join(t.projectDir, 'Beta'));
    await fs.writeFile(path.join(t.projectDir, 'alpha.txt'), '');
    await fs.writeFile(path.join(t.projectDir, 'gamma.md'), '');
    const result = await run(t, 'list_dir', { path: t.projectDir });
    const names = result.content.split('\n');
    expect(names.indexOf('alpha.txt')).toBeLessThan(names.indexOf('Beta/'));
    expect(names.indexOf('Beta/')).toBeLessThan(names.indexOf('gamma.md'));
    const limited = await run(t, 'list_dir', { path: t.projectDir, limit: 1 });
    expect(limited.content).toMatch(/more entries/);
  });

  it('grep_files shows context lines and supports literal patterns', async () => {
    t = await createTestApp();
    await fs.writeFile(path.join(t.projectDir, 'code.ts'), 'before\nconst x = a.b(c);\nafter\n');
    const literal = await run(t, 'grep_files', { path: t.projectDir, pattern: 'a.b(c)', literal: true, context: 1 });
    expect(literal.content).toContain('a.b(c)');
    expect(literal.content).toContain('before');
    expect(literal.content).toContain('after');
  });
});

// ---- parallel reads, through the loop -------------------------------------------

describe('parallel read-only batches (PA-121)', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('runs a batch of reads and records their results in the order the model asked', async () => {
    const sse = (chunks: unknown[]) =>
      new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 });
    let fileA = '';
    let fileB = '';
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () =>
        sse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'ra', function: { name: 'read_file', arguments: JSON.stringify({ path: fileA }) } },
                    { index: 1, id: 'rb', function: { name: 'read_file', arguments: JSON.stringify({ path: fileB }) } },
                    { index: 2, id: 'lt', function: { name: 'get_current_time', arguments: '{}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          },
        ]),
      )
      .mockImplementation(async () => sse([{ choices: [{ delta: { content: 'read both' }, finish_reason: 'stop' }] }]));
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    fileA = path.join(t.projectDir, 'a.txt');
    fileB = path.join(t.projectDir, 'b.txt');
    await fs.writeFile(fileA, 'AAA');
    await fs.writeFile(fileB, 'BBB');
    const headers = authHeaders(t.cookie);
    await t.app.inject({ method: 'PATCH', url: '/api/planner/settings', headers, payload: { baseUrl: 'https://llm.example.com' } });
    const chat = (await t.app.inject({ method: 'POST', url: '/api/planner/chats', headers, payload: { modelId: 'm' } })).json();
    await t.app.inject({ method: 'POST', url: `/api/planner/chats/${chat.id}/messages`, headers, payload: { content: 'read' } });

    const events = (await t.app.inject({ method: 'GET', url: `/api/planner/chats/${chat.id}/history`, headers })).json()
      .events as Array<{ kind: string; toolUseId?: string; content?: string }>;
    const results = events.filter((e) => e.kind === 'tool_result');
    expect(results.map((r) => r.toolUseId)).toEqual(['ra', 'rb', 'lt']);
    expect(results[0]!.content).toBe('AAA');
    expect(results[1]!.content).toBe('BBB');
    expect(events.at(-1)).toMatchObject({ kind: 'turn_complete', isError: false });
  });
});
