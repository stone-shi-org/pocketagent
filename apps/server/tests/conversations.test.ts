import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ConversationStore,
  encodeProjectDir,
  readTranscriptMeta,
  transcriptRecordToEvents,
} from '../src/conversations/index.js';
import { parsePaneLine } from '../src/adopt/index.js';
import { WorkspaceRegistry } from '../src/workspaces/index.js';
import { makeWorkspace } from './helpers.js';

describe('encodeProjectDir', () => {
  it('encodes a path the way Claude Code names its project directory', () => {
    expect(encodeProjectDir('/home/me/src/app')).toBe('-home-me-src-app');
  });

  it('is deliberately forward-only, because the encoding is lossy', () => {
    // Regression: decoding by replacing every dash with a slash turns
    // `src/agents-remote-control` into a path that does not exist, which
    // silently hid every conversation in a hyphenated directory.
    expect(encodeProjectDir('/home/me/src/agents-remote-control')).toBe(
      encodeProjectDir('/home/me/src/agents/remote/control'),
    );
  });
});

describe('readTranscriptMeta', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync('/tmp/pa-meta-');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, records: unknown[]): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'));
    return file;
  };

  it('prefers the agent-generated title over the first user message', async () => {
    const file = write('a.jsonl', [
      { type: 'user', sessionId: 's1', cwd: '/w', message: { content: 'tooling preamble' } },
      { type: 'ai-title', aiTitle: 'Build the thing', sessionId: 's1' },
      { type: 'assistant', sessionId: 's1' },
    ]);
    const meta = await readTranscriptMeta(file);
    expect(meta.title).toBe('Build the thing');
    expect(meta.sessionId).toBe('s1');
    expect(meta.cwd).toBe('/w');
    expect(meta.messageCount).toBe(2);
  });

  it('falls back to the opening prompt when the agent never titled it', async () => {
    // Anything started headlessly has no `ai-title` record at all.
    const file = write('untitled.jsonl', [
      { type: 'user', sessionId: 's', cwd: '/w', message: { content: 'Fix the flaky login test' } },
      { type: 'assistant', sessionId: 's' },
    ]);
    expect((await readTranscriptMeta(file)).title).toBe('Fix the flaky login test');
  });

  it('reads the opening prompt out of content blocks, not just plain strings', async () => {
    const file = write('blocks.jsonl', [
      {
        type: 'user',
        sessionId: 's',
        cwd: '/w',
        message: { content: [{ type: 'text', text: 'Blocks work too' }] },
      },
    ]);
    expect((await readTranscriptMeta(file)).title).toBe('Blocks work too');
  });

  it('uses only the first line of a long opening prompt', async () => {
    const file = write('multiline.jsonl', [
      { type: 'user', sessionId: 's', cwd: '/w', message: { content: 'Do the thing\nand then more' } },
    ]);
    expect((await readTranscriptMeta(file)).title).toBe('Do the thing');
  });

  it('treats HEAD as no branch at all', async () => {
    // Claude Code writes `HEAD` outside a repo; showing it as a branch is a lie.
    const file = write('nobranch.jsonl', [
      { type: 'user', sessionId: 's', cwd: '/w', gitBranch: 'HEAD' },
    ]);
    expect((await readTranscriptMeta(file)).gitBranch).toBeNull();
  });

  it('takes the latest last-prompt and git branch', async () => {
    const file = write('b.jsonl', [
      { type: 'user', sessionId: 's', cwd: '/w', gitBranch: 'main' },
      { type: 'last-prompt', lastPrompt: 'first' },
      { type: 'last-prompt', lastPrompt: 'most recent' },
    ]);
    const meta = await readTranscriptMeta(file);
    expect(meta.lastPrompt).toBe('most recent');
    expect(meta.gitBranch).toBe('main');
  });

  it('survives malformed lines rather than failing the whole scan', async () => {
    const file = path.join(dir, 'c.jsonl');
    fs.writeFileSync(file, '{"type":"ai-title","aiTitle":"Good"}\nnot json at all\n{oops\n');
    expect((await readTranscriptMeta(file)).title).toBe('Good');
  });

  it('returns empty metadata for a missing file', async () => {
    expect((await readTranscriptMeta(path.join(dir, 'nope.jsonl'))).title).toBeNull();
  });

  it('reads the tail of a transcript too large to read whole', async () => {
    // The title is rewritten as a conversation grows, so the last one wins —
    // which only works if the tail is read.
    const filler = { type: 'assistant', text: 'x'.repeat(4096) };
    const records = [
      { type: 'user', sessionId: 'big', cwd: '/w' },
      { type: 'ai-title', aiTitle: 'Early title' },
      ...Array.from({ length: 200 }, () => filler),
      { type: 'ai-title', aiTitle: 'Final title' },
      { type: 'last-prompt', lastPrompt: 'the last thing I asked' },
    ];
    const file = write('big.jsonl', records);
    expect(fs.statSync(file).size).toBeGreaterThan(512 * 1024);

    const meta = await readTranscriptMeta(file);
    expect(meta.title).toBe('Final title');
    expect(meta.lastPrompt).toBe('the last thing I asked');
    expect(meta.sessionId).toBe('big');
  });
});

describe('ConversationStore', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let projectsDir: string;

  const writeTranscript = (cwd: string, id: string, extra: unknown[] = []): void => {
    const dir = path.join(projectsDir, encodeProjectDir(cwd));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      [
        { type: 'user', sessionId: id, cwd, message: { content: 'hi' } },
        { type: 'ai-title', aiTitle: `Title ${id}`, sessionId: id },
        ...extra,
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
  };

  beforeEach(() => {
    ws = makeWorkspace();
    projectsDir = fs.mkdtempSync('/tmp/pa-projects-');
  });
  afterEach(() => {
    ws.cleanup();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('lists conversations inside a workspace root', async () => {
    writeTranscript(ws.project, 'conv-1');
    const store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'conv-1', cwd: ws.project, title: 'Title conv-1' });
  });

  it('finds conversations in directories whose names contain dashes', async () => {
    const hyphenated = path.join(ws.root, 'agents-remote-control');
    fs.mkdirSync(hyphenated);
    writeTranscript(hyphenated, 'conv-dash');

    const store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });
    const list = await store.list();
    expect(list.map((c) => c.id)).toContain('conv-dash');
  });

  it('never lists a conversation outside the workspace roots', async () => {
    const outside = fs.mkdtempSync('/tmp/pa-outside-');
    try {
      writeTranscript(outside, 'secret-conv');
      writeTranscript(ws.project, 'allowed-conv');

      const store = new ConversationStore({
        projectsDir,
        workspaces: new WorkspaceRegistry([ws.root]),
        listRunningCwds: async () => [],
      });
      const ids = (await store.list()).map((c) => c.id);
      expect(ids).toContain('allowed-conv');
      expect(ids).not.toContain('secret-conv');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a transcript whose recorded cwd escapes the root', async () => {
    // The directory name says one thing; the transcript says another. The
    // transcript is authoritative, so containment must be decided on it.
    const dir = path.join(projectsDir, encodeProjectDir(ws.project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'liar.jsonl'),
      JSON.stringify({ type: 'user', sessionId: 'liar', cwd: '/etc' }),
    );

    const store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });
    expect(await store.list()).toHaveLength(0);
  });

  it('marks the newest transcript in a busy directory as probably live', async () => {
    writeTranscript(ws.project, 'older');
    await new Promise((r) => setTimeout(r, 12));
    writeTranscript(ws.project, 'newer');

    const store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [ws.project],
    });

    const list = await store.list();
    const newer = list.find((c) => c.id === 'newer');
    const older = list.find((c) => c.id === 'older');
    expect(newer?.probablyLive).toBe(true);
    expect(older?.probablyLive).toBe(false);
    // Both are in a busy directory, which is reported separately.
    expect(older?.directoryBusy).toBe(true);
  });

  it('reports nothing as live when no agent is running', async () => {
    writeTranscript(ws.project, 'idle-conv');
    const store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });
    const [conv] = await store.list();
    expect(conv?.directoryBusy).toBe(false);
    expect(conv?.probablyLive).toBe(false);
  });

  it('returns an empty list when there is no history at all', async () => {
    const store = new ConversationStore({
      projectsDir: '/tmp/definitely-not-here',
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });
    expect(await store.list()).toEqual([]);
  });
});

describe('parsePaneLine', () => {
  const line = (sessionName: string) =>
    `${sessionName}|0|0|claude|/home/me/src/app|192|57|1|0|win`;

  it('parses a pane', () => {
    expect(parsePaneLine(line('work'))).toEqual({
      sessionName: 'work',
      windowIndex: 0,
      paneIndex: 0,
      command: 'claude',
      cwd: '/home/me/src/app',
      cols: 192,
      rows: 57,
      attached: 1,
      dead: false,
      windowName: 'win',
    });
  });

  it('tolerates a separator inside the user\'s session name', () => {
    // We do not control the user's tmux session names.
    expect(parsePaneLine(line('my|weird|name'))?.sessionName).toBe('my|weird|name');
  });

  it('rejects malformed lines', () => {
    expect(parsePaneLine('')).toBeNull();
    expect(parsePaneLine('too|few|fields')).toBeNull();
  });
});

describe('transcriptRecordToEvents', () => {
  it('turns a typed prompt into a user message', () => {
    const events = transcriptRecordToEvents({
      type: 'user',
      uuid: 'u1',
      message: { role: 'user', content: 'what does this do?' },
    });
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'hist_u1', text: 'what does this do?' },
    ]);
  });

  it('reads assistant text through the same normalizer the live stream uses', () => {
    const events = transcriptRecordToEvents({
      type: 'assistant',
      message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'It sorts.' }] },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'text', text: 'It sorts.' });
  });

  it('keeps tool calls and their results', () => {
    const call = transcriptRecordToEvents({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/w/a.ts' } }],
      },
    });
    expect(call[0]).toMatchObject({ kind: 'tool_use', name: 'Read', filePath: '/w/a.ts' });

    const result = transcriptRecordToEvents({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'export const a = 1;' }],
      },
    });
    expect(result[0]).toMatchObject({ kind: 'tool_result', toolUseId: 'tu1' });
  });

  it("skips a subagent's private conversation", () => {
    // Sidechain records belong to a Task subagent; showing them inline would
    // interleave two conversations.
    expect(
      transcriptRecordToEvents({
        type: 'assistant',
        isSidechain: true,
        message: { role: 'assistant', content: [{ type: 'text', text: 'inner' }] },
      }),
    ).toEqual([]);
  });

  it('skips tool plumbing echoed as a user message', () => {
    expect(
      transcriptRecordToEvents({
        type: 'user',
        message: { role: 'user', content: '<command-name>/clear</command-name>' },
      }),
    ).toEqual([]);
  });

  it('ignores bookkeeping records', () => {
    for (const type of ['queue-operation', 'attachment', 'last-prompt', 'ai-title', 'system']) {
      expect(transcriptRecordToEvents({ type })).toEqual([]);
    }
  });

  it('never throws on rubbish', () => {
    expect(transcriptRecordToEvents(null)).toEqual([]);
    expect(transcriptRecordToEvents(42)).toEqual([]);
    expect(transcriptRecordToEvents({ type: 'user' })).toEqual([]);
  });
});

describe('ConversationStore.history', () => {
  let ws: ReturnType<typeof makeWorkspace>;
  let projectsDir: string;
  let store: ConversationStore;

  const write = (id: string, records: unknown[], cwd?: string): void => {
    const dir = path.join(projectsDir, encodeProjectDir(cwd ?? ws.project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${id}.jsonl`),
      records.map((r) => JSON.stringify(r)).join('\n'),
    );
  };

  const turn = (prompt: string, answer: string, n: number): unknown[] => [
    { type: 'user', uuid: `u${n}`, sessionId: 'c1', cwd: ws.project, message: { content: prompt } },
    {
      type: 'assistant',
      sessionId: 'c1',
      message: { role: 'assistant', id: `m${n}`, content: [{ type: 'text', text: answer }] },
    },
  ];

  beforeEach(() => {
    ws = makeWorkspace();
    projectsDir = fs.mkdtempSync('/tmp/pa-hist-');
    store = new ConversationStore({
      projectsDir,
      workspaces: new WorkspaceRegistry([ws.root]),
      listRunningCwds: async () => [],
    });
  });
  afterEach(() => {
    ws.cleanup();
    fs.rmSync(projectsDir, { recursive: true, force: true });
  });

  it('returns the conversation in order', async () => {
    write('c1', [...turn('first question', 'first answer', 1), ...turn('second', 'second answer', 2)]);
    const events = await store.history('c1');
    expect(events?.map((e) => e.kind)).toEqual([
      'user_prompt',
      'text',
      'user_prompt',
      'text',
    ]);
    expect(events?.[0]).toMatchObject({ text: 'first question' });
    expect(events?.[3]).toMatchObject({ text: 'second answer' });
  });

  it('keeps the tail when a conversation is longer than the cap', async () => {
    const records = [];
    for (let i = 0; i < 50; i++) records.push(...turn(`q${i}`, `a${i}`, i));
    write('c1', records);

    const events = await store.history('c1', 4);
    expect(events).toHaveLength(4);
    // The end is what you are resuming from.
    expect(events?.[3]).toMatchObject({ kind: 'text', text: 'a49' });
  });

  it('refuses a conversation outside the workspace roots', async () => {
    const outside = fs.mkdtempSync('/tmp/pa-hist-out-');
    try {
      const dir = path.join(projectsDir, encodeProjectDir(outside));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'secret.jsonl'),
        JSON.stringify({ type: 'user', sessionId: 'secret', cwd: outside, message: { content: 'hi' } }),
      );
      expect(await store.history('secret')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns null for a conversation that does not exist', async () => {
    expect(await store.history('nope')).toBeNull();
  });

  it('survives a truncated final line', async () => {
    const dir = path.join(projectsDir, encodeProjectDir(ws.project));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'c1.jsonl'),
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'c1', cwd: ws.project, message: { content: 'ok' } }) +
        '\n{"type":"assistant","mess',
    );
    const events = await store.history('c1');
    expect(events).toHaveLength(1);
  });
});
