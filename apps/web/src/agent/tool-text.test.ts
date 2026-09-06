import { describe, expect, it } from 'vitest';
import type { ToolItem } from './transcript.js';
import { formatToolInput, stateLabel, toolCallText, toolState } from './tool-text.js';

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    type: 'tool',
    key: 'k',
    toolUseId: 'tu_1',
    name: 'Read',
    summary: 'Read(src/foo.ts)',
    filePath: 'src/foo.ts',
    input: { file_path: 'src/foo.ts' },
    result: 'hello',
    resultTruncated: false,
    isError: false,
    awaitingApproval: false,
    denied: false,
    ...overrides,
  };
}

describe('toolState', () => {
  it('prefers denied, then waiting, then error', () => {
    expect(toolState(tool({ denied: true, awaitingApproval: true, isError: true }))).toBe('denied');
    expect(toolState(tool({ awaitingApproval: true, isError: true }))).toBe('waiting');
    expect(toolState(tool({ isError: true }))).toBe('error');
  });

  it('is running until a result arrives, then ok', () => {
    expect(toolState(tool({ result: null }))).toBe('running');
    expect(toolState(tool())).toBe('ok');
  });

  it('treats an empty-string result as a result, not as still running', () => {
    expect(toolState(tool({ result: '' }))).toBe('ok');
  });
});

describe('formatToolInput', () => {
  it('lists arguments one per block, strings unquoted', () => {
    expect(formatToolInput({ command: 'ls -la', description: 'list' })).toBe(
      'command: ls -la\n\ndescription: list',
    );
  });

  it('pretty-prints non-strings and drops empty values', () => {
    expect(formatToolInput({ todos: [1, 2] })).toBe('todos: [\n  1,\n  2\n]');
    expect(formatToolInput({ a: undefined, b: null })).toBe('(no arguments)');
    expect(formatToolInput({})).toBe('(no arguments)');
  });
});

describe('toolCallText', () => {
  it('holds the summary, the input and the result', () => {
    expect(toolCallText(tool())).toBe(
      'Read(src/foo.ts)\n\nInput:\nfile_path: src/foo.ts\n\nResult:\nhello\n',
    );
  });

  it('copies the arguments in full, not the diff rendering', () => {
    // The card collapses unchanged context to `⋯`; a copy that did the same
    // could not be pasted back into an editor.
    const text = toolCallText(
      tool({
        name: 'Edit',
        summary: 'Edit(src/foo.ts)',
        input: { file_path: 'src/foo.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      }),
    );
    expect(text).toContain('old_string: a\nb\nc');
    expect(text).toContain('new_string: a\nB\nc');
    expect(text).not.toContain('⋯');
  });

  it('names a state worth naming, and stays quiet about success', () => {
    expect(toolCallText(tool({ isError: true, result: 'boom' }))).toContain(
      'Read(src/foo.ts) — failed',
    );
    expect(toolCallText(tool({ awaitingApproval: true, result: null }))).toContain(
      '— needs approval',
    );
    expect(toolCallText(tool())).toContain('Read(src/foo.ts)\n\nInput:');
    // "…" is a spinner, not a word: it would paste as noise.
    expect(toolCallText(tool({ result: null }))).not.toContain('…');
  });

  it('omits the result section while the call is still running', () => {
    const text = toolCallText(tool({ result: null }));
    expect(text).not.toContain('Result:');
    expect(text).toContain('Input:');
  });

  it('marks a truncated result as truncated, and an empty one as empty', () => {
    expect(toolCallText(tool({ result: 'abc', resultTruncated: true }))).toContain(
      'Result:\nabc\n… truncated',
    );
    expect(toolCallText(tool({ result: '' }))).toContain('Result:\n(empty)');
  });

  it('skips a quiet tool’s result, exactly as the card body does', () => {
    const text = toolCallText(
      tool({ name: 'TodoWrite', summary: 'TodoWrite', input: { todos: [] }, result: 'ok' }),
    );
    expect(text).not.toContain('Result:');
  });
});

describe('stateLabel', () => {
  it('is empty for a finished, successful call', () => {
    expect(stateLabel('ok')).toBe('');
    expect(stateLabel('denied')).toBe('denied');
  });
});
