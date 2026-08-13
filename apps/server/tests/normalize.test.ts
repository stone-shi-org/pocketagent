import { describe, expect, it } from 'vitest';
import {
  extractAgyPath,
  extractOpencodePath,
  extractPath,
  normalizeAgyMessage,
  normalizeCodexEvent,
  normalizeOpencodeEvent,
  normalizeSdkMessage,
  summarizeAgyTool,
  summarizeOpencodeTool,
  summarizeToolUse,
} from '../src/sessions/normalize.js';

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

/**
 * These payloads mirror `agy --output-format stream-json` (v1.1.12), captured
 * from a live headless run — same discipline as `normalizeSdkMessage` above:
 * tested without spawning the CLI.
 */
describe('normalizeAgyMessage: init', () => {
  it('maps init to session_started', () => {
    const events = normalizeAgyMessage({
      event: 'init',
      conversation_id: 'conv-1',
      init: {
        cwd: '/tmp/work',
        tools: ['run_command', 'view_file'],
        permission_mode: 'always-proceed',
      },
    });
    expect(events).toEqual([
      {
        kind: 'session_started',
        agentSessionId: 'conv-1',
        model: null,
        cwd: '/tmp/work',
        tools: ['run_command', 'view_file'],
        permissionMode: 'always-proceed',
      },
    ]);
  });
});

describe('normalizeAgyMessage: step_update', () => {
  it('maps an ACTIVE tool step to tool_use', () => {
    const events = normalizeAgyMessage({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 3,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' } },
      },
    });
    expect(events).toEqual([
      {
        kind: 'tool_use',
        id: 'agy_conv-1_3',
        name: 'run_command',
        input: { CommandLine: 'pwd' },
        summary: 'Run pwd',
        filePath: null,
      },
    ]);
  });

  it('maps a DONE tool step to tool_result', () => {
    const events = normalizeAgyMessage({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'pwd' }, output: '/tmp\n' },
      },
    });
    expect(events).toEqual([
      {
        kind: 'tool_result',
        id: 'agy_tr_conv-1_3',
        toolUseId: 'agy_conv-1_3',
        content: '/tmp\n',
        truncated: false,
        isError: false,
      },
    ]);
  });

  it('marks a DONE tool step with a TOOL_ERROR as an error result', () => {
    const events = normalizeAgyMessage({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 6,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: {},
          error: { type: 'TOOL_ERROR', message: 'context canceled' },
        },
      },
    });
    expect(events[0]).toMatchObject({ kind: 'tool_result', content: 'context canceled', isError: true });
  });

  it('maps an agent_response step with text_delta to text_delta', () => {
    const events = normalizeAgyMessage({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-1',
        step_index: 17,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'hello',
      },
    });
    expect(events).toEqual([{ kind: 'text_delta', id: 'agy_conv-1_17', text: 'hello' }]);
  });

  it('drops an agent_response step with no text_delta, a silent planning step', () => {
    expect(
      normalizeAgyMessage({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 2,
          state: 'DONE',
          step_type: 'agent_response',
          usage: { input_tokens: 100 },
        },
      }),
    ).toEqual([]);
  });

  it('ignores user_input and checkpoint steps, which are internal bookkeeping', () => {
    expect(
      normalizeAgyMessage({
        event: 'step_update',
        step_update: { conversation_id: 'c', step_index: 0, state: 'DONE', step_type: 'user_input' },
      }),
    ).toEqual([]);
    expect(
      normalizeAgyMessage({
        event: 'step_update',
        step_update: { conversation_id: 'c', step_index: 4, state: 'DONE', step_type: 'checkpoint' },
      }),
    ).toEqual([]);
  });
});

describe('normalizeAgyMessage: result', () => {
  it('carries status and token usage for the status chip', () => {
    const events = normalizeAgyMessage({
      event: 'result',
      result: {
        conversation_id: 'conv-1',
        status: 'SUCCESS',
        response: 'hello\n',
        duration_seconds: 13.696213968,
        num_turns: 1,
        usage: { input_tokens: 34619, output_tokens: 1710 },
      },
    });
    expect(events).toEqual([
      {
        kind: 'turn_complete',
        stopReason: 'SUCCESS',
        isError: false,
        numTurns: 1,
        durationMs: 13696,
        costUsd: null,
        inputTokens: 34619,
        outputTokens: 1710,
      },
    ]);
  });

  it('treats any non-SUCCESS status as an error', () => {
    const events = normalizeAgyMessage({
      event: 'result',
      result: { conversation_id: 'conv-1', status: 'FAILED', usage: {} },
    });
    expect(events[0]).toMatchObject({ isError: true, stopReason: 'FAILED' });
  });
});

describe('normalizeAgyMessage: robustness', () => {
  it('returns nothing for unknown event types instead of throwing', () => {
    expect(normalizeAgyMessage({ event: 'heartbeat' })).toEqual([]);
  });

  it('tolerates malformed input', () => {
    expect(normalizeAgyMessage(null)).toEqual([]);
    expect(normalizeAgyMessage('nonsense')).toEqual([]);
    expect(normalizeAgyMessage({ event: 'step_update' })).toEqual([]);
    expect(normalizeAgyMessage({ event: 'init' })).toEqual([
      { kind: 'session_started', agentSessionId: null, model: null, cwd: '', tools: [], permissionMode: null },
    ]);
  });
});

describe('summarizeAgyTool', () => {
  it('summarizes agy-specific tools readably', () => {
    expect(summarizeAgyTool('run_command', { CommandLine: 'ls -la' })).toBe('Run ls -la');
    expect(summarizeAgyTool('view_file', { AbsolutePath: '/a/b/c.ts' })).toBe('Read c.ts');
    expect(summarizeAgyTool('write_to_file', { AbsolutePath: '/a/b/c.ts' })).toBe('Write c.ts');
  });

  it('falls back to something useful for unknown tools', () => {
    expect(summarizeAgyTool('mystery_tool', {})).toBe('mystery_tool');
  });
});

describe('extractAgyPath', () => {
  it('finds the path under agy-specific key names', () => {
    expect(extractAgyPath({ AbsolutePath: '/a' })).toBe('/a');
    expect(extractAgyPath({ TargetFile: '/b' })).toBe('/b');
  });

  it('returns null when there is no path', () => {
    expect(extractAgyPath({ CommandLine: 'ls' })).toBeNull();
  });
});

/**
 * These payloads mirror opencode's `GET /event` SSE stream (v1.17.18),
 * cross-checked against the real, installed `@opencode-ai/sdk` generated
 * types — same discipline as `normalizeSdkMessage`/`normalizeAgyMessage`
 * above: tested without a live server or a working model provider.
 */
describe('normalizeOpencodeEvent: message.part.updated (text)', () => {
  it('emits text_delta while a part is still streaming', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        delta: 'hel',
        part: { id: 'prt_1', sessionID: 'ses_1', messageID: 'msg_1', type: 'text', text: 'hel' },
      },
    });
    expect(events).toEqual([{ kind: 'text_delta', id: 'prt_1', text: 'hel' }]);
  });

  it('emits a final text block once time.end is set', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_1',
          sessionID: 'ses_1',
          messageID: 'msg_1',
          type: 'text',
          text: 'hello world',
          time: { start: 0, end: 1 },
        },
      },
    });
    expect(events).toEqual([{ kind: 'text', id: 'prt_1', text: 'hello world' }]);
  });

  it('drops a plain user-submitted part — no delta, no time.end — without any role check', () => {
    // This is the exact shape captured live for the user's own echoed prompt:
    // no `time` field at all on the part.
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: { id: 'prt_u', sessionID: 'ses_1', messageID: 'msg_u', type: 'text', text: 'hi there' },
      },
    });
    expect(events).toEqual([]);
  });
});

describe('normalizeOpencodeEvent: message.part.updated (reasoning)', () => {
  it('emits thinking only once time.end is set', () => {
    expect(
      normalizeOpencodeEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { id: 'prt_r', sessionID: 'ses_1', messageID: 'msg_1', type: 'reasoning', text: 'thinking...', time: { start: 0 } },
        },
      }),
    ).toEqual([]);

    expect(
      normalizeOpencodeEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { id: 'prt_r', sessionID: 'ses_1', messageID: 'msg_1', type: 'reasoning', text: 'done thinking', time: { start: 0, end: 1 } },
        },
      }),
    ).toEqual([{ kind: 'thinking', id: 'prt_r', text: 'done thinking' }]);
  });
});

describe('normalizeOpencodeEvent: message.part.updated (tool)', () => {
  it('maps a running tool call to tool_use', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_t', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'bash',
          state: { status: 'running', input: { command: 'ls -la' } },
        },
      },
    });
    expect(events).toEqual([
      { kind: 'tool_use', id: 'prt_t', name: 'bash', input: { command: 'ls -la' }, summary: 'Run ls -la', filePath: null },
    ]);
  });

  it('maps a completed tool call to a non-error tool_result', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_t', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'bash',
          state: { status: 'completed', input: {}, output: 'hi\n', title: 'ls', metadata: {}, time: { start: 0, end: 1 } },
        },
      },
    });
    expect(events).toEqual([
      { kind: 'tool_result', id: 'oc_tr_prt_t', toolUseId: 'prt_t', content: 'hi\n', truncated: false, isError: false },
    ]);
  });

  it('maps an errored tool call to an error tool_result', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.part.updated',
      properties: {
        sessionID: 'ses_1',
        part: {
          id: 'prt_t', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'bash',
          state: { status: 'error', input: {}, error: 'command not found', time: { start: 0, end: 1 } },
        },
      },
    });
    expect(events[0]).toMatchObject({ kind: 'tool_result', content: 'command not found', isError: true });
  });

  it('ignores a pending tool call — arguments are still streaming in', () => {
    expect(
      normalizeOpencodeEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_1',
          part: { id: 'prt_t', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'pending', input: {}, raw: '' } },
        },
      }),
    ).toEqual([]);
  });
});

describe('normalizeOpencodeEvent: session lifecycle', () => {
  it('maps session.idle to a turn_complete with no usage of its own', () => {
    const events = normalizeOpencodeEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(events).toEqual([
      { kind: 'turn_complete', stopReason: null, isError: false, numTurns: null, durationMs: null, costUsd: null, inputTokens: null, outputTokens: null },
    ]);
  });

  it('maps session.error to an error notice, extracting the nested message', () => {
    const events = normalizeOpencodeEvent({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'UnknownError', data: { message: 'boom' } } },
    });
    expect(events).toEqual([{ kind: 'notice', level: 'error', text: 'boom' }]);
  });

  it('falls back to the error name when there is no message', () => {
    const events = normalizeOpencodeEvent({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'ProviderAuthError', data: {} } },
    });
    expect(events).toEqual([{ kind: 'notice', level: 'error', text: 'ProviderAuthError.' }]);
  });

  it('drops the assistant message.updated shell — it carries no renderable content of its own', () => {
    expect(
      normalizeOpencodeEvent({
        type: 'message.updated',
        properties: { sessionID: 'ses_1', info: { id: 'msg_a', sessionID: 'ses_1', role: 'assistant', cost: 0.01, tokens: {} } },
      }),
    ).toEqual([]);
  });

  it('surfaces an error embedded in message.updated as a notice', () => {
    const events = normalizeOpencodeEvent({
      type: 'message.updated',
      properties: {
        sessionID: 'ses_1',
        info: { id: 'msg_a', sessionID: 'ses_1', role: 'assistant', error: { name: 'UnknownError', data: { message: 'output too long' } } },
      },
    });
    expect(events).toEqual([{ kind: 'notice', level: 'error', text: 'output too long' }]);
  });

  it('ignores a user message.updated entirely', () => {
    expect(
      normalizeOpencodeEvent({
        type: 'message.updated',
        properties: { sessionID: 'ses_1', info: { id: 'msg_u', sessionID: 'ses_1', role: 'user' } },
      }),
    ).toEqual([]);
  });
});

describe('normalizeOpencodeEvent: permissions', () => {
  it('maps permission.updated to a generic permission_request', () => {
    const events = normalizeOpencodeEvent({
      type: 'permission.updated',
      properties: {
        id: 'per_1', type: 'bash', sessionID: 'ses_1', messageID: 'msg_1',
        title: 'Allow running rm -rf?', metadata: { command: 'rm -rf /tmp/x' },
        time: { created: 0 },
      },
    });
    expect(events).toEqual([
      {
        kind: 'permission_request', id: 'per_1', toolName: 'bash',
        input: { command: 'rm -rf /tmp/x' }, title: 'Allow running rm -rf?',
        displayName: null, filePath: null, reason: null, canAllowForSession: true, questions: null,
      },
    ]);
  });

  it('maps permission.replied to permission_resolved with the decision inferred from the reply', () => {
    expect(
      normalizeOpencodeEvent({ type: 'permission.replied', properties: { sessionID: 's', permissionID: 'per_1', response: 'always' } }),
    ).toEqual([{ kind: 'permission_resolved', id: 'per_1', decision: 'allow_session', message: null }]);

    expect(
      normalizeOpencodeEvent({ type: 'permission.replied', properties: { sessionID: 's', permissionID: 'per_2', response: 'reject' } }),
    ).toEqual([{ kind: 'permission_resolved', id: 'per_2', decision: 'deny', message: null }]);

    expect(
      normalizeOpencodeEvent({ type: 'permission.replied', properties: { sessionID: 's', permissionID: 'per_3', response: 'once' } }),
    ).toEqual([{ kind: 'permission_resolved', id: 'per_3', decision: 'allow', message: null }]);
  });
});

describe('normalizeOpencodeEvent: robustness', () => {
  it('returns nothing for unknown or session-less event types', () => {
    expect(normalizeOpencodeEvent({ type: 'plugin.added', properties: { id: 'x' } })).toEqual([]);
    expect(normalizeOpencodeEvent({ type: 'catalog.updated', properties: {} })).toEqual([]);
  });

  it('tolerates malformed input', () => {
    expect(normalizeOpencodeEvent(null)).toEqual([]);
    expect(normalizeOpencodeEvent('nonsense')).toEqual([]);
    expect(normalizeOpencodeEvent({ type: 'message.part.updated' })).toEqual([]);
    expect(normalizeOpencodeEvent({ type: 'permission.replied', properties: {} })).toEqual([]);
  });
});

describe('summarizeOpencodeTool', () => {
  it('summarizes well-known tools readably', () => {
    expect(summarizeOpencodeTool('bash', { command: 'npm test' })).toBe('Run npm test');
    expect(summarizeOpencodeTool('read', { filePath: '/a/b/c.ts' })).toBe('Read c.ts');
    expect(summarizeOpencodeTool('grep', { pattern: 'TODO' })).toBe('Search TODO');
  });

  it('falls back to something useful for unknown tools', () => {
    expect(summarizeOpencodeTool('mystery_tool', {})).toBe('mystery_tool');
  });
});

describe('extractOpencodePath', () => {
  it('finds the path under common key names', () => {
    expect(extractOpencodePath({ filePath: '/a' })).toBe('/a');
    expect(extractOpencodePath({ path: '/b' })).toBe('/b');
  });

  it('returns null when there is no path', () => {
    expect(extractOpencodePath({ command: 'ls' })).toBeNull();
  });
});

/**
 * These payloads mirror `codex app-server`'s JSON-RPC protocol (v0.147.0),
 * captured live against the real, installed CLI with a working ChatGPT login
 * — including a genuine approval round trip that blocked a command until
 * replied to. Two spots are best-effort rather than observed (called out
 * inline): a *successful* command's output field name, and `fileChange`/
 * `reasoning` item shapes.
 */
describe('normalizeCodexEvent: items', () => {
  it('ignores the user_message echo — user_prompt is emitted locally instead', () => {
    expect(
      normalizeCodexEvent({
        method: 'item/started',
        params: { threadId: 't', item: { type: 'userMessage', id: 'msg_u', content: [{ type: 'text', text: 'hi' }] } },
      }),
    ).toEqual([]);
  });

  it('emits text_delta for agentMessage streaming, and a final text on completion', () => {
    expect(
      normalizeCodexEvent({
        method: 'item/agentMessage/delta',
        params: { threadId: 't', turnId: 'tu', itemId: 'msg_a', delta: 'hel' },
      }),
    ).toEqual([{ kind: 'text_delta', id: 'msg_a', text: 'hel' }]);

    expect(
      normalizeCodexEvent({
        method: 'item/started',
        params: { threadId: 't', item: { type: 'agentMessage', id: 'msg_a', text: '', phase: 'commentary' } },
      }),
    ).toEqual([]);

    expect(
      normalizeCodexEvent({
        method: 'item/completed',
        params: { threadId: 't', item: { type: 'agentMessage', id: 'msg_a', text: 'hello', phase: 'final_answer' } },
      }),
    ).toEqual([{ kind: 'text', id: 'msg_a', text: 'hello' }]);
  });

  it('maps a started commandExecution to tool_use', () => {
    const events = normalizeCodexEvent({
      method: 'item/started',
      params: {
        threadId: 't',
        item: { type: 'commandExecution', id: 'exec-1', command: 'ls -la', cwd: '/tmp', status: 'inProgress' },
      },
    });
    expect(events).toEqual([
      { kind: 'tool_use', id: 'exec-1', name: 'commandExecution', input: { command: 'ls -la', cwd: '/tmp' }, summary: 'Run ls -la', filePath: null },
    ]);
  });

  it('maps a completed commandExecution to a non-error tool_result', () => {
    const events = normalizeCodexEvent({
      method: 'item/completed',
      params: {
        threadId: 't',
        item: { type: 'commandExecution', id: 'exec-1', command: 'echo hi', status: 'completed', aggregatedOutput: 'hi\n' },
      },
    });
    expect(events).toEqual([
      { kind: 'tool_result', id: 'cx_tr_exec-1', toolUseId: 'exec-1', content: 'hi\n', truncated: false, isError: false },
    ]);
  });

  it('maps a failed commandExecution to an error tool_result — the shape this was actually verified live against', () => {
    const events = normalizeCodexEvent({
      method: 'item/completed',
      params: {
        threadId: 't',
        item: { type: 'commandExecution', id: 'exec-1', command: 'rm x', status: 'failed', error: 'approval request failed' },
      },
    });
    expect(events[0]).toMatchObject({ kind: 'tool_result', isError: true, content: 'approval request failed' });
  });

  it('ignores unknown item types', () => {
    expect(
      normalizeCodexEvent({ method: 'item/started', params: { threadId: 't', item: { type: 'webSearch', id: 'x' } } }),
    ).toEqual([]);
  });
});

describe('normalizeCodexEvent: turn lifecycle', () => {
  it('maps turn/completed to a turn_complete with no usage of its own', () => {
    expect(
      normalizeCodexEvent({
        method: 'turn/completed',
        params: { threadId: 't', turn: { id: 'tu', items: [], status: 'completed', error: null, durationMs: 42 } },
      }),
    ).toEqual([
      { kind: 'turn_complete', stopReason: null, isError: false, numTurns: null, durationMs: 42, costUsd: null, inputTokens: null, outputTokens: null },
    ]);
  });

  it('treats a non-null turn.error as an error', () => {
    expect(
      normalizeCodexEvent({
        method: 'turn/completed',
        params: { threadId: 't', turn: { id: 'tu', items: [], status: 'failed', error: { message: 'boom' }, durationMs: 1 } },
      }),
    ).toMatchObject([{ isError: true, stopReason: 'error' }]);
  });

  it('maps a thread-level error notification to a notice', () => {
    expect(
      normalizeCodexEvent({ method: 'error', params: { threadId: 't', error: { message: 'boom' } } }),
    ).toEqual([{ kind: 'notice', level: 'error', text: 'boom' }]);
  });
});

describe('normalizeCodexEvent: approvals', () => {
  it('maps a commandExecution approval request to a generic permission_request', () => {
    const events = normalizeCodexEvent({
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't', turnId: 'tu', itemId: 'exec-1', reason: 'Allow running rm -rf?', command: 'rm -rf /tmp/x', cwd: '/tmp' },
      id: 7,
    });
    expect(events).toEqual([
      {
        kind: 'permission_request', id: '7', toolName: 'commandExecution',
        input: { command: 'rm -rf /tmp/x', cwd: '/tmp' }, title: 'Allow running rm -rf?',
        displayName: null, filePath: null, reason: null, canAllowForSession: true, questions: null,
      },
    ]);
  });

  it('maps a fileChange approval request generically, falling back to itemId with no reason', () => {
    const events = normalizeCodexEvent({
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't', turnId: 'tu', itemId: 'file-1' },
      id: 3,
    });
    expect(events).toEqual([
      {
        kind: 'permission_request', id: '3', toolName: 'fileChange',
        input: { itemId: 'file-1' }, title: 'Allow: fileChange?',
        displayName: null, filePath: null, reason: null, canAllowForSession: true, questions: null,
      },
    ]);
  });

  it('drops an approval request with no id — nothing this codebase could ever reply to', () => {
    expect(
      normalizeCodexEvent({ method: 'item/commandExecution/requestApproval', params: { threadId: 't' } }),
    ).toEqual([]);
  });
});

describe('normalizeCodexEvent: robustness', () => {
  it('returns nothing for unknown methods', () => {
    expect(normalizeCodexEvent({ method: 'account/rateLimits/updated', params: {} })).toEqual([]);
    expect(normalizeCodexEvent({ method: 'mcpServer/startupStatus/updated', params: {} })).toEqual([]);
  });
});
