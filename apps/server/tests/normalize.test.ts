import { describe, expect, it } from 'vitest';
import { extractPath, normalizeSdkMessage, summarizeToolUse } from '../src/sessions/normalize.js';

/**
 * These payloads mirror what the Agent SDK actually emits — captured from a
 * live session — so the mapping is tested without spawning an agent.
 */

describe('normalizeSdkMessage: system', () => {
  it('maps init to session_started', () => {
    const events = normalizeSdkMessage({
      type: 'system',
      subtype: 'init',
      session_id: 'abc-123',
      model: 'claude-opus-5',
      cwd: '/tmp/work',
      tools: ['Read', 'Write'],
      permissionMode: 'default',
    });
    expect(events).toEqual([
      {
        kind: 'session_started',
        agentSessionId: 'abc-123',
        model: 'claude-opus-5',
        cwd: '/tmp/work',
        tools: ['Read', 'Write'],
        permissionMode: 'default',
      },
    ]);
  });

  it('ignores other system subtypes', () => {
    expect(normalizeSdkMessage({ type: 'system', subtype: 'hook_started' })).toEqual([]);
  });
});

describe('normalizeSdkMessage: assistant', () => {
  it('maps text and tool_use blocks', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: "I'll read the file." },
          { type: 'tool_use', id: 'toolu_9', name: 'Read', input: { file_path: '/tmp/a/hello.txt' } },
        ],
      },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: 'text', text: "I'll read the file." });
    expect(events[1]).toMatchObject({
      kind: 'tool_use',
      id: 'toolu_9',
      name: 'Read',
      summary: 'Read hello.txt',
      filePath: '/tmp/a/hello.txt',
    });
  });

  it('drops whitespace-only text rather than rendering an empty bubble', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'text', text: '   \n ' }] },
    });
    expect(events).toEqual([]);
  });

  it('drops empty thinking blocks, which are progress signals not content', () => {
    // The API omits reasoning by default: the block arrives with empty text.
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'thinking', thinking: '' }] },
    });
    expect(events).toEqual([]);
  });

  it('keeps thinking blocks that actually carry text', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { id: 'm', content: [{ type: 'thinking', thinking: 'Consider the edge case.' }] },
    });
    expect(events[0]).toMatchObject({ kind: 'thinking', text: 'Consider the edge case.' });
  });
});

describe('normalizeSdkMessage: tool results', () => {
  it('flattens content blocks into text', () => {
    const events = normalizeSdkMessage({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_9',
            content: [{ type: 'text', text: 'file contents' }],
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({
      kind: 'tool_result',
      toolUseId: 'toolu_9',
      content: 'file contents',
      isError: false,
      truncated: false,
    });
  });

  it('marks errors', () => {
    const events = normalizeSdkMessage({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }],
      },
    });
    expect(events[0]).toMatchObject({ isError: true });
  });

  it('truncates enormous results and says so', () => {
    const huge = 'x'.repeat(50_000);
    const events = normalizeSdkMessage({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't', content: huge }] },
    });
    const event = events[0] as { content: string; truncated: boolean };
    expect(event.truncated).toBe(true);
    expect(event.content.length).toBeLessThan(huge.length);
  });
});

describe('normalizeSdkMessage: result', () => {
  it('carries cost and token usage for the status chip', () => {
    const events = normalizeSdkMessage({
      type: 'result',
      stop_reason: 'end_turn',
      is_error: false,
      num_turns: 2,
      duration_ms: 5300,
      total_cost_usd: 0.2579,
      usage: { input_tokens: 5, output_tokens: 174 },
    });
    expect(events[0]).toEqual({
      kind: 'turn_complete',
      stopReason: 'end_turn',
      isError: false,
      numTurns: 2,
      durationMs: 5300,
      costUsd: 0.2579,
      inputTokens: 5,
      outputTokens: 174,
    });
  });
});

describe('normalizeSdkMessage: robustness', () => {
  it('returns nothing for unknown message types instead of throwing', () => {
    // The SDK adds message types regularly; an unknown one must not kill a session.
    expect(normalizeSdkMessage({ type: 'task_started', id: 'x' })).toEqual([]);
    expect(normalizeSdkMessage({ type: 'rate_limit_event' })).toEqual([]);
  });

  it('tolerates malformed input', () => {
    expect(normalizeSdkMessage(null)).toEqual([]);
    expect(normalizeSdkMessage('nonsense')).toEqual([]);
    expect(normalizeSdkMessage({ type: 'assistant' })).toEqual([]);
    expect(normalizeSdkMessage({ type: 'assistant', message: { content: 'not an array' } })).toEqual([]);
  });
});

describe('summarizeToolUse', () => {
  it('summarizes the common tools readably', () => {
    expect(summarizeToolUse('Read', { file_path: '/a/b/c.ts' })).toBe('Read c.ts');
    expect(summarizeToolUse('Edit', { file_path: '/a/b/c.ts' })).toBe('Edit c.ts');
    expect(summarizeToolUse('Bash', { command: 'npm test' })).toBe('Run npm test');
    expect(summarizeToolUse('Grep', { pattern: 'TODO' })).toBe('Search TODO');
  });

  it('uses only the first line of a multi-line command', () => {
    expect(summarizeToolUse('Bash', { command: 'cd /tmp\nls -la' })).toBe('Run cd /tmp');
  });

  it('falls back to something useful for unknown tools', () => {
    expect(summarizeToolUse('MysteryTool', { path: '/x/y.txt' })).toBe('MysteryTool y.txt');
    expect(summarizeToolUse('MysteryTool', { q: 'hello' })).toBe('MysteryTool hello');
    expect(summarizeToolUse('MysteryTool', {})).toBe('MysteryTool');
  });

  // AskUserQuestion's only top-level field is an array (`questions`), which the
  // generic default case cannot summarize (it looks for a string value) — this
  // used to collapse to the bare tool name, which is where the "big JSON dump"
  // bug started: a title with no useful information at all.
  it('renders the question text for AskUserQuestion instead of the bare tool name', () => {
    expect(
      summarizeToolUse('AskUserQuestion', {
        questions: [{ question: 'Which approach should I take?', header: 'Approach', options: [], multiSelect: false }],
      }),
    ).toBe('Which approach should I take?');
  });

  it('summarizes multiple AskUserQuestion questions by count', () => {
    expect(
      summarizeToolUse('AskUserQuestion', {
        questions: [
          { question: 'A?', header: 'A', options: [], multiSelect: false },
          { question: 'B?', header: 'B', options: [], multiSelect: false },
        ],
      }),
    ).toBe('Asking 2 questions');
  });

  it('falls back gracefully when AskUserQuestion input is malformed', () => {
    expect(summarizeToolUse('AskUserQuestion', {})).toBe('Asking a question');
  });
});

describe('extractPath', () => {
  it('finds the path under any of the known keys', () => {
    expect(extractPath({ file_path: '/a' })).toBe('/a');
    expect(extractPath({ notebook_path: '/b' })).toBe('/b');
    expect(extractPath({ path: '/c' })).toBe('/c');
  });

  it('returns null when there is no path', () => {
    expect(extractPath({ command: 'ls' })).toBeNull();
    expect(extractPath({ file_path: '' })).toBeNull();
  });
});
