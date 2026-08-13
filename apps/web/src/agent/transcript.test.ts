import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { applyEvent, applyEvents, emptyTranscript, type ToolItem } from './transcript.js';

const toolUse = (id: string, name = 'Read', filePath: string | null = '/a/b.ts'): AgentEvent => ({
  kind: 'tool_use',
  id,
  name,
  input: { file_path: filePath ?? undefined },
  summary: `${name} b.ts`,
  filePath,
});

const permission = (id: string, toolName = 'Write'): AgentEvent => ({
  kind: 'permission_request',
  id,
  toolName,
  input: {},
  title: `Allow ${toolName}?`,
  displayName: null,
  filePath: null,
  reason: null,
  canAllowForSession: true,
  questions: null,
});

describe('transcript: text', () => {
  it('appends assistant and user turns in order', () => {
    const state = applyEvents(emptyTranscript(), [
      { kind: 'user_prompt', id: 'u1', text: 'hello' },
      { kind: 'text', id: 't1', text: 'hi there' },
    ]);
    expect(state.items.map((i) => i.type)).toEqual(['text', 'text']);
    expect(state.items[0]).toMatchObject({ role: 'user', text: 'hello' });
    expect(state.items[1]).toMatchObject({ role: 'assistant', text: 'hi there' });
  });

  it('accumulates deltas into one block', () => {
    const state = applyEvents(emptyTranscript(), [
      { kind: 'text_delta', id: 'd1', text: 'Hel' },
      { kind: 'text_delta', id: 'd1', text: 'lo' },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Hello', streaming: true });
  });

  it('replaces the streaming placeholder when the complete block lands', () => {
    // Otherwise the partial and the final would both render.
    const state = applyEvents(emptyTranscript(), [
      { kind: 'text_delta', id: '0', text: 'Par' },
      { kind: 'text', id: 'msg_1_0', text: 'Partial then complete' },
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: 'Partial then complete', streaming: false });
  });

  it('does not merge deltas from consecutive messages into one block', () => {
    // Regression: delta ids are content-block indices, which restart at 0 for
    // every assistant message. Keying on them alone concatenated one message's
    // preview onto the next and left a duplicate alongside the real blocks.
    const state = applyEvents(emptyTranscript(), [
      { kind: 'text_delta', id: '0', text: "I'll read that file." },
      { kind: 'text', id: 'msg_1_0', text: "I'll read that file." },
      { kind: 'tool_use', id: 't1', name: 'Read', input: {}, summary: 'Read x', filePath: null },
      { kind: 'text_delta', id: '0', text: 'The answer is 42.' },
      { kind: 'text', id: 'msg_2_0', text: 'The answer is 42.' },
    ]);

    const texts = state.items.filter((i) => i.type === 'text');
    expect(texts).toHaveLength(2);
    expect(texts.map((t) => (t as { text: string }).text)).toEqual([
      "I'll read that file.",
      'The answer is 42.',
    ]);
    expect(texts.every((t) => (t as { streaming: boolean }).streaming === false)).toBe(true);
  });

  it('drops a half-written preview when a turn ends without completing it', () => {
    const state = applyEvents(emptyTranscript(), [
      { kind: 'text_delta', id: '0', text: 'interrupted mid-' },
      {
        kind: 'turn_complete',
        stopReason: 'end_turn',
        isError: false,
        numTurns: 1,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
    expect(state.items.filter((i) => i.type === 'text')).toHaveLength(0);
  });
});

describe('transcript: tools', () => {
  it('joins a result onto its tool call', () => {
    const state = applyEvents(emptyTranscript(), [
      toolUse('t1'),
      { kind: 'tool_result', id: 'r1', toolUseId: 't1', content: 'contents', truncated: false, isError: false },
    ]);
    const tool = state.items[0] as ToolItem;
    expect(tool.type).toBe('tool');
    expect(tool.result).toBe('contents');
    expect(tool.isError).toBe(false);
  });

  it('ignores a result with no matching call rather than inventing a card', () => {
    const state = applyEvent(emptyTranscript(), {
      kind: 'tool_result',
      id: 'r',
      toolUseId: 'nope',
      content: 'x',
      truncated: false,
      isError: false,
    });
    expect(state.items).toEqual([]);
  });

  it('collects touched files in first-seen order, without duplicates', () => {
    const state = applyEvents(emptyTranscript(), [
      toolUse('t1', 'Read', '/a/one.ts'),
      toolUse('t2', 'Edit', '/a/two.ts'),
      toolUse('t3', 'Read', '/a/one.ts'),
      toolUse('t4', 'Bash', null),
    ]);
    expect(state.files).toEqual(['/a/one.ts', '/a/two.ts']);
  });
});

describe('transcript: approvals', () => {
  it('queues a request and marks the blocked tool card', () => {
    const state = applyEvents(emptyTranscript(), [
      toolUse('t1', 'Write', '/a/x.ts'),
      permission('p1', 'Write'),
    ]);
    expect(state.pending.map((p) => p.id)).toEqual(['p1']);
    expect((state.items[0] as ToolItem).awaitingApproval).toBe(true);
  });

  it('clears the request and marks denial when resolved', () => {
    const state = applyEvents(emptyTranscript(), [
      toolUse('t1', 'Write', '/a/x.ts'),
      permission('p1', 'Write'),
      { kind: 'permission_resolved', id: 'p1', decision: 'deny', message: 'no' },
    ]);
    expect(state.pending).toEqual([]);
    const tool = state.items[0] as ToolItem;
    expect(tool.awaitingApproval).toBe(false);
    expect(tool.denied).toBe(true);
  });

  it('keeps multiple approvals queued in arrival order', () => {
    const state = applyEvents(emptyTranscript(), [permission('p1'), permission('p2')]);
    expect(state.pending.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('does not mark a tool denied when the approval was allowed', () => {
    const state = applyEvents(emptyTranscript(), [
      toolUse('t1', 'Write'),
      permission('p1', 'Write'),
      { kind: 'permission_resolved', id: 'p1', decision: 'allow', message: null },
    ]);
    expect((state.items[0] as ToolItem).denied).toBe(false);
  });
});

describe('transcript: turns', () => {
  it('tracks busy state between prompt and completion', () => {
    let state = applyEvent(emptyTranscript(), { kind: 'user_prompt', id: 'u', text: 'go' });
    expect(state.busy).toBe(true);

    state = applyEvent(state, {
      kind: 'turn_complete',
      stopReason: 'end_turn',
      isError: false,
      numTurns: 1,
      durationMs: 100,
      costUsd: 0.01,
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(state.busy).toBe(false);
    expect(state.totalCostUsd).toBeCloseTo(0.01);
  });

  it('accumulates cost across turns', () => {
    const turn = (cost: number): AgentEvent => ({
      kind: 'turn_complete',
      stopReason: 'end_turn',
      isError: false,
      numTurns: 1,
      durationMs: null,
      costUsd: cost,
      inputTokens: null,
      outputTokens: null,
    });
    const state = applyEvents(emptyTranscript(), [turn(0.1), turn(0.25)]);
    expect(state.totalCostUsd).toBeCloseTo(0.35);
  });
});

describe('transcript: slash commands', () => {
  it('starts with no commands', () => {
    expect(emptyTranscript().commands).toEqual([]);
  });

  it('sets the command list from commands_available', () => {
    const state = applyEvent(emptyTranscript(), {
      kind: 'commands_available',
      commands: [{ name: 'usage', description: 'Show usage', argumentHint: '', aliases: [] }],
    });
    expect(state.commands).toEqual([{ name: 'usage', description: 'Show usage', argumentHint: '', aliases: [] }]);
  });

  it('replaces rather than merges on a later commands_available', () => {
    // Mirrors the SDK's own `commands_changed` semantics: a skill can be
    // discovered *and* retracted mid-session, so this must not accumulate.
    const state = applyEvents(emptyTranscript(), [
      { kind: 'commands_available', commands: [{ name: 'a', description: '', argumentHint: '', aliases: [] }] },
      { kind: 'commands_available', commands: [{ name: 'b', description: '', argumentHint: '', aliases: [] }] },
    ]);
    expect(state.commands).toEqual([{ name: 'b', description: '', argumentHint: '', aliases: [] }]);
  });

  it('renders command_output as its own transcript item', () => {
    const state = applyEvent(emptyTranscript(), {
      kind: 'command_output',
      id: 'u-1',
      text: 'Usage: 12.3k tokens',
    });
    expect(state.items).toEqual([{ type: 'command_output', key: 'co_u-1', text: 'Usage: 12.3k tokens' }]);
  });
});

describe('transcript: replay equivalence', () => {
  it('produces the same view whether applied live or replayed at once', () => {
    const events: AgentEvent[] = [
      { kind: 'session_started', agentSessionId: 's1', model: 'm', cwd: '/w', tools: [], permissionMode: null },
      { kind: 'user_prompt', id: 'u', text: 'do it' },
      toolUse('t1', 'Edit', '/a/x.ts'),
      permission('p1', 'Edit'),
      { kind: 'permission_resolved', id: 'p1', decision: 'allow', message: null },
      { kind: 'tool_result', id: 'r', toolUseId: 't1', content: 'ok', truncated: false, isError: false },
      { kind: 'text', id: 'a', text: 'done' },
    ];

    const live = events.reduce(applyEvent, emptyTranscript());
    const replayed = applyEvents(emptyTranscript(), events);
    expect(replayed).toEqual(live);
    expect(replayed.model).toBe('m');
    expect(replayed.agentSessionId).toBe('s1');
  });
});
