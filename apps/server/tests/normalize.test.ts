import { describe, expect, it } from 'vitest';
import {
  codexHistoryEvents,
  createBackgroundTaskState,
  extractAgyPath,
  extractOpencodePath,
  extractPath,
  extractPiPath,
  normalizeAgyMessage,
  normalizeAgyModelList,
  normalizeCodexEvent,
  normalizeCodexModels,
  normalizeModels,
  normalizeOpencodeCommands,
  normalizeOpencodeEvent,
  normalizeOpencodeModels,
  normalizePiEvent,
  normalizePiModels,
  normalizePiModelValue,
  normalizeSdkMessage,
  normalizeSlashCommands,
  opencodeHistoryEvents,
  piHistoryEvents,
  reconcileBackgroundTasks,
  summarizeAgyTool,
  summarizeOpencodeTool,
  summarizePiTool,
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

  it('maps commands_changed to commands_available with REPLACE semantics', () => {
    const events = normalizeSdkMessage({
      type: 'system',
      subtype: 'commands_changed',
      commands: [
        { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
        { name: 'compact', description: 'Compact context', argumentHint: '<focus>' },
      ],
    });
    expect(events).toEqual([
      {
        kind: 'commands_available',
        commands: [
          { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
          { name: 'compact', description: 'Compact context', argumentHint: '<focus>', aliases: [] },
        ],
      },
    ]);
  });

  it('drops malformed entries in commands_changed rather than throwing', () => {
    const events = normalizeSdkMessage({
      type: 'system',
      subtype: 'commands_changed',
      commands: [{ description: 'no name field' }, 'not an object', { name: 'ok' }],
    });
    expect(events).toEqual([
      { kind: 'commands_available', commands: [{ name: 'ok', description: '', argumentHint: '', aliases: [] }] },
    ]);
  });

  it('ignores a non-array commands_changed payload', () => {
    expect(
      normalizeSdkMessage({ type: 'system', subtype: 'commands_changed', commands: 'nope' }),
    ).toEqual([{ kind: 'commands_available', commands: [] }]);
  });

  it('maps local_command_output to command_output', () => {
    const events = normalizeSdkMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: 'Usage: 12.3k tokens',
      uuid: 'u-1',
    });
    expect(events).toEqual([{ kind: 'command_output', id: 'u-1', text: 'Usage: 12.3k tokens' }]);
  });

  it('drops empty local_command_output rather than rendering a blank card', () => {
    expect(
      normalizeSdkMessage({ type: 'system', subtype: 'local_command_output', content: '   ', uuid: 'u-2' }),
    ).toEqual([]);
  });
});

describe('normalizeSdkMessage: conversation_reset', () => {
  it('maps conversation_reset to a conversation_reset event', () => {
    const events = normalizeSdkMessage({
      type: 'conversation_reset',
      new_conversation_id: 'conv-2',
      uuid: 'u-1',
      session_id: 'conv-1',
    });
    expect(events).toEqual([{ kind: 'conversation_reset', newConversationId: 'conv-2' }]);
  });

  it('falls back to an empty id rather than throwing on a malformed message', () => {
    expect(normalizeSdkMessage({ type: 'conversation_reset' })).toEqual([
      { kind: 'conversation_reset', newConversationId: '' },
    ]);
  });
});

describe('normalizeSlashCommands', () => {
  it('fills in missing optional fields', () => {
    expect(normalizeSlashCommands([{ name: 'help' }])).toEqual([
      { name: 'help', description: '', argumentHint: '', aliases: [] },
    ]);
  });

  it('drops entries with no name and filters non-string aliases', () => {
    expect(normalizeSlashCommands([{ description: 'no name' }, { name: 'ok', aliases: ['a', 2, 'b'] }])).toEqual([
      { name: 'ok', description: '', argumentHint: '', aliases: ['a', 'b'] },
    ]);
  });

  it('returns [] for a non-array input', () => {
    expect(normalizeSlashCommands(undefined)).toEqual([]);
    expect(normalizeSlashCommands('nope')).toEqual([]);
  });
});

describe('normalizeModels', () => {
  it('maps supportedModels() results to ModelInfo entries', () => {
    expect(
      normalizeModels([
        { value: 'claude-opus-4-8', displayName: 'Opus', description: 'Most capable' },
        { value: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Balanced' },
      ]),
    ).toEqual([
      {
        value: 'claude-opus-4-8',
        displayName: 'Opus',
        description: 'Most capable',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
      {
        value: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: 'Balanced',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('falls back to the model id when displayName/description are missing', () => {
    expect(normalizeModels([{ value: 'claude-haiku-5' }])).toEqual([
      {
        value: 'claude-haiku-5',
        displayName: 'claude-haiku-5',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('drops malformed entries rather than throwing', () => {
    expect(normalizeModels([{ displayName: 'no value field' }, 'not an object', { value: 'ok' }])).toEqual([
      { value: 'ok', displayName: 'ok', description: '', supportsEffort: false, supportedEffortLevels: [] },
    ]);
  });

  it('returns [] for a non-array input', () => {
    expect(normalizeModels(undefined)).toEqual([]);
    expect(normalizeModels('nope')).toEqual([]);
  });

  it('carries resolvedModel through when present', () => {
    expect(
      normalizeModels([{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: '' }]),
    ).toEqual([
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5',
        displayName: 'Sonnet',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('carries supportsEffort/supportedEffortLevels through, accepting any non-empty string', () => {
    // EffortLevel is deliberately not a fixed enum — codex/pi report levels
    // Claude's own SDK never uses (see the protocol type's doc comment) — so
    // this only drops non-strings and empty ones, never an "unrecognized" one.
    expect(
      normalizeModels([
        {
          value: 'claude-opus-4-8',
          displayName: 'Opus',
          description: '',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'ultra', '', 3],
        },
      ]),
    ).toEqual([
      {
        value: 'claude-opus-4-8',
        displayName: 'Opus',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'ultra'],
      },
    ]);
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

  // "Agent" is the real sub-agent-launching tool name — confirmed by probing
  // the live SDK query stream, where "Task" turned out to be an unrelated
  // task-tracking tool. "Task" is kept as a second case for older CLI builds
  // that may still use that name; both must produce the same summary.
  it('summarizes a sub-agent launch under either tool name', () => {
    expect(summarizeToolUse('Agent', { description: 'investigate the flaky test' })).toBe(
      'Subagent: investigate the flaky test',
    );
    expect(summarizeToolUse('Task', { description: 'investigate the flaky test' })).toBe(
      'Subagent: investigate the flaky test',
    );
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

/**
 * These payloads mirror the real SDK's background-task lifecycle for a
 * sub-agent launched via the `Agent` tool — captured live, the same way as
 * the rest of this file's fixtures. The sequence that matters: the tool's own
 * `tool_result` arrives almost immediately ("Async agent launched
 * successfully"), well before `task_started`'s sibling `task_notification`
 * reports the sub-agent actually finishing, sometimes minutes later.
 */
describe('reconcileBackgroundTasks', () => {
  const toolUse = {
    kind: 'tool_use' as const,
    id: 'tu1',
    name: 'Agent',
    input: { description: 'Sleep 30 seconds task' },
    summary: 'Subagent: Sleep 30 seconds task',
    filePath: null,
  };
  const prematureResult = {
    kind: 'tool_result' as const,
    id: 'tr1',
    toolUseId: 'tu1',
    content: 'Async agent launched successfully.',
    truncated: false,
    isError: false,
  };
  const taskStarted = {
    type: 'system',
    subtype: 'task_started',
    task_id: 'task1',
    tool_use_id: 'tu1',
    description: 'Sleep 30 seconds task',
  };
  const taskNotification = (status = 'completed') => ({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task1',
    tool_use_id: 'tu1',
    status,
    summary: 'Done.',
  });

  it('passes through events for messages unrelated to any background task', () => {
    const state = createBackgroundTaskState();
    expect(reconcileBackgroundTasks({ type: 'assistant' }, [toolUse], state)).toEqual([toolUse]);
  });

  it('suppresses the premature tool_result once task_started has marked it pending', () => {
    const state = createBackgroundTaskState();
    reconcileBackgroundTasks(taskStarted, [], state);
    expect(reconcileBackgroundTasks({ type: 'user' }, [prematureResult], state)).toEqual([]);
  });

  it('does not touch a tool_result for a tool_use_id that is not a pending background task', () => {
    const state = createBackgroundTaskState();
    expect(reconcileBackgroundTasks({ type: 'user' }, [prematureResult], state)).toEqual([prematureResult]);
  });

  it('appends the real tool_result once task_notification reports completion, and stops pending', () => {
    const state = createBackgroundTaskState();
    reconcileBackgroundTasks(taskStarted, [], state);
    reconcileBackgroundTasks({ type: 'user' }, [prematureResult], state); // suppressed, as above

    const events = reconcileBackgroundTasks(taskNotification(), [], state);
    expect(events).toEqual([
      { kind: 'tool_result', id: 'bgtask_task1', toolUseId: 'tu1', content: 'Done.', truncated: false, isError: false },
    ]);
    expect(state.pending.size).toBe(0);
  });

  it('marks the synthesized result as an error for a failed status', () => {
    const state = createBackgroundTaskState();
    reconcileBackgroundTasks(taskStarted, [], state);
    const events = reconcileBackgroundTasks(taskNotification('failed'), [], state);
    expect(events[0]).toMatchObject({ isError: true });
  });

  it('ignores task_notification for a tool_use_id it never saw task_started for', () => {
    const state = createBackgroundTaskState();
    expect(reconcileBackgroundTasks(taskNotification(), [], state)).toEqual([]);
  });

  it('is a no-op for the redundant lifecycle messages in between', () => {
    const state = createBackgroundTaskState();
    reconcileBackgroundTasks(taskStarted, [], state);
    expect(
      reconcileBackgroundTasks({ type: 'system', subtype: 'task_progress', tool_use_id: 'tu1' }, [], state),
    ).toEqual([]);
    expect(
      reconcileBackgroundTasks({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }, [], state),
    ).toEqual([]);
    // Still pending after both — neither is the real completion signal.
    expect(state.pending.has('tu1')).toBe(true);
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

  /**
   * `invoke_subagent` — captured by running `agy --output-format stream-json`
   * directly (bypassing normalization) and checking the file it was asked to
   * write actually existed: a real sub-agent ran, but nothing in the event
   * stream said so at all before this. It is not a `step_type: 'tool'` like
   * every other tool call; it gets its own step type with a payload shaped
   * nothing like `tool_info`.
   */
  describe('subagent steps (invoke_subagent)', () => {
    it('maps an ACTIVE subagent step to tool_use', () => {
      const events = normalizeAgyMessage({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 3,
          state: 'ACTIVE',
          step_type: 'subagent',
          tool_name: 'invoke_subagent',
          subagent_info: {
            subagents: [
              {
                type_name: 'self',
                role: 'File Writer',
                initial_prompt: 'Write 1, 2, 3 to out.txt',
                conversation_id: 'sub-1',
                log_uri: 'file:///tmp/sub-1/transcript.jsonl',
              },
            ],
          },
        },
      });
      expect(events).toEqual([
        {
          kind: 'tool_use',
          id: 'agy_sub_sub-1',
          name: 'invoke_subagent',
          input: { role: 'File Writer', prompt: 'Write 1, 2, 3 to out.txt' },
          summary: 'Subagent: File Writer',
          filePath: null,
        },
      ]);
    });

    it('ignores a DONE subagent step — it is a premature dispatch acknowledgment, not real completion', () => {
      // Confirmed live against a real ~15s background sub-agent: this step's
      // own DONE fires within about a second of ACTIVE, long before the
      // sub-agent's actual work finished. `AgySession.pendingSubagents`
      // resolves the fleet-view chip against the turn's own `result` line
      // instead — see its doc comment — so this normalizer must not
      // synthesize a (misleadingly early) tool_result here.
      const events = normalizeAgyMessage({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 3,
          state: 'DONE',
          step_type: 'subagent',
          tool_name: 'invoke_subagent',
          subagent_info: {
            subagents: [
              {
                type_name: 'self',
                role: 'File Writer',
                initial_prompt: 'Write 1, 2, 3 to out.txt',
                conversation_id: 'sub-1',
                log_uri: 'file:///tmp/sub-1/transcript.jsonl',
              },
            ],
          },
        },
      });
      expect(events).toEqual([]);
    });

    it('emits one event per subagent when a call dispatches more than one', () => {
      const events = normalizeAgyMessage({
        event: 'step_update',
        step_update: {
          conversation_id: 'conv-1',
          step_index: 5,
          state: 'ACTIVE',
          step_type: 'subagent',
          tool_name: 'invoke_subagent',
          subagent_info: {
            subagents: [
              { role: 'Worker A', initial_prompt: 'do A', conversation_id: 'sub-a' },
              { role: 'Worker B', initial_prompt: 'do B', conversation_id: 'sub-b' },
            ],
          },
        },
      });
      expect(events.map((e) => (e.kind === 'tool_use' ? e.id : null))).toEqual([
        'agy_sub_sub-a',
        'agy_sub_sub-b',
      ]);
    });

    it('is robust to a missing or empty subagents array', () => {
      expect(
        normalizeAgyMessage({
          event: 'step_update',
          step_update: { conversation_id: 'c', step_index: 1, state: 'ACTIVE', step_type: 'subagent' },
        }),
      ).toEqual([]);
    });
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

  it('surfaces result.error as a notice ahead of the turn_complete, instead of dropping it', () => {
    const events = normalizeAgyMessage({
      event: 'result',
      result: {
        conversation_id: 'conv-1',
        status: 'ERROR',
        response: '',
        error: 'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
        usage: {},
      },
    });
    expect(events).toEqual([
      {
        kind: 'notice',
        level: 'error',
        text: 'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
      },
      expect.objectContaining({ kind: 'turn_complete', isError: true, stopReason: 'ERROR' }),
    ]);
  });

  it('does not add a notice for a non-SUCCESS status with no error text', () => {
    const events = normalizeAgyMessage({
      event: 'result',
      result: { conversation_id: 'conv-1', status: 'FAILED', usage: {} },
    });
    expect(events).toHaveLength(1);
  });
});

describe('normalizeAgyMessage: command_result', () => {
  it('maps /help to commands_available', () => {
    const events = normalizeAgyMessage({
      event: 'command_result',
      command: {
        name: 'help',
        data: {
          commands: [
            { name: 'agents', description: 'List available custom agents' },
            { name: 'usage', aliases: ['quota'], description: 'View model quota usage' },
          ],
        },
      },
    });
    expect(events).toEqual([
      {
        kind: 'commands_available',
        commands: [
          { name: 'agents', description: 'List available custom agents', argumentHint: '', aliases: [] },
          { name: 'usage', description: 'View model quota usage', argumentHint: '', aliases: ['quota'] },
        ],
      },
    ]);
  });

  it('ignores every other command name, since its data means something else entirely', () => {
    // e.g. /agents lists subagents, /model lists models — neither is a
    // SlashCommandInfo[] and must not be misread as one.
    expect(
      normalizeAgyMessage({ event: 'command_result', command: { name: 'agents', data: { agents: [] } } }),
    ).toEqual([]);
  });

  it('tolerates a missing command or data', () => {
    expect(normalizeAgyMessage({ event: 'command_result' })).toEqual([]);
    expect(normalizeAgyMessage({ event: 'command_result', command: { name: 'help' } })).toEqual([]);
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

  it('summarizes a sub-agent launch by role, falling back to the prompt', () => {
    expect(summarizeAgyTool('invoke_subagent', { role: 'File Writer', prompt: 'write stuff' })).toBe(
      'Subagent: File Writer',
    );
    expect(summarizeAgyTool('invoke_subagent', { prompt: 'investigate the flaky test' })).toBe(
      'Subagent: investigate the flaky test',
    );
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

describe('normalizeAgyModelList', () => {
  it('parses the plain-text "id\\tlabel" lines the real models subcommand prints', () => {
    const stdout = 'Fetching available models...\ngemini-3.6-flash-high\tGemini 3.6 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';
    expect(normalizeAgyModelList(stdout)).toEqual([
      {
        value: 'gemini-3.6-flash-high',
        displayName: 'Gemini 3.6 Flash (High)',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
      {
        value: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6 (Thinking)',
        description: '',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('skips lines with no tab, blank lines, and an empty id/label on either side', () => {
    expect(normalizeAgyModelList('Fetching available models...\n\nno-tab-here\n\tno-id\nno-label\t\n')).toEqual([]);
  });

  it('returns [] for empty output', () => {
    expect(normalizeAgyModelList('')).toEqual([]);
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

describe('normalizeOpencodeCommands', () => {
  it('maps the real GET /command shape, dropping template and hints', () => {
    const commands = normalizeOpencodeCommands([
      { name: 'init', description: 'guided AGENTS.md setup', source: 'command', template: 'very long...', hints: ['$ARGUMENTS'] },
      { name: 'review', description: 'review changes', source: 'command', template: 'also long...', hints: ['$ARGUMENTS'] },
    ]);
    expect(commands).toEqual([
      { name: 'init', description: 'guided AGENTS.md setup', argumentHint: '', aliases: [] },
      { name: 'review', description: 'review changes', argumentHint: '', aliases: [] },
    ]);
  });

  it('drops entries with no name and returns [] for a non-array input', () => {
    expect(normalizeOpencodeCommands([{ description: 'no name' }])).toEqual([]);
    expect(normalizeOpencodeCommands(undefined)).toEqual([]);
    expect(normalizeOpencodeCommands('nope')).toEqual([]);
  });
});

describe('normalizeOpencodeModels', () => {
  it('maps the real GET /api/model shape to a composite providerID/id value', () => {
    const models = normalizeOpencodeModels([
      { id: 'deepseek-v4-flash', providerID: 'omniroute', family: 'deepseek', name: 'Deepseek v4 Flash' },
      { id: 'deepseek-v4-pro', providerID: 'omniroute', family: 'deepseek', name: 'Deepseek v4 Pro' },
    ]);
    expect(models).toEqual([
      {
        value: 'omniroute/deepseek-v4-flash',
        displayName: 'Deepseek v4 Flash',
        description: 'deepseek',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
      {
        value: 'omniroute/deepseek-v4-pro',
        displayName: 'Deepseek v4 Pro',
        description: 'deepseek',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('drops entries missing id or providerID, and returns [] for a non-array input', () => {
    expect(normalizeOpencodeModels([{ id: 'no-provider' }, { providerID: 'no-id' }])).toEqual([]);
    expect(normalizeOpencodeModels(undefined)).toEqual([]);
    expect(normalizeOpencodeModels('nope')).toEqual([]);
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

  // opencode's own sub-agent launcher — confirmed live: `{description,
  // prompt, subagent_type}`, blocking until the sub-agent actually finishes
  // (unlike Claude's `Agent` tool, whose own tool_result is a premature
  // "launched" acknowledgment — see `reconcileBackgroundTasks`).
  it('summarizes the task tool as a sub-agent launch', () => {
    expect(summarizeOpencodeTool('task', { description: 'investigate the flaky test' })).toBe(
      'Subagent: investigate the flaky test',
    );
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

describe('normalizeCodexModels', () => {
  it('maps the real model/list shape, deriving supportsEffort from supportedReasoningEfforts', () => {
    const models = normalizeCodexModels([
      {
        id: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        description: 'General purpose',
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses' },
          { reasoningEffort: 'high', description: 'Deeper reasoning' },
        ],
      },
      { id: 'gpt-5.6-fast', displayName: 'GPT-5.6 Fast', description: 'Faster, less thorough' },
    ]);
    expect(models).toEqual([
      {
        value: 'gpt-5.6-terra',
        displayName: 'GPT-5.6 Terra',
        description: 'General purpose',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
      },
      {
        value: 'gpt-5.6-fast',
        displayName: 'GPT-5.6 Fast',
        description: 'Faster, less thorough',
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('falls back to the id when displayName/description are missing', () => {
    expect(normalizeCodexModels([{ id: 'gpt-5.5' }])).toEqual([
      { value: 'gpt-5.5', displayName: 'gpt-5.5', description: '', supportsEffort: false, supportedEffortLevels: [] },
    ]);
  });

  it('drops entries with no id, and returns [] for a non-array input', () => {
    expect(normalizeCodexModels([{ displayName: 'no id field' }])).toEqual([]);
    expect(normalizeCodexModels(undefined)).toEqual([]);
    expect(normalizeCodexModels('nope')).toEqual([]);
  });
});

/**
 * These payloads mirror `pi --mode rpc`'s JSON event stream, built from the
 * installed CLI's own shipped TypeScript declarations
 * (`AssistantMessageEvent`, `Usage` in `@earendil-works/pi-ai`) and its
 * `docs/rpc.md` — no provider in this environment had working credentials
 * for `pi` to run a real session against, so unlike the other three
 * normalizers these were never observed live.
 */
describe('normalizePiEvent: message_update', () => {
  it('emits text_delta, then a final text on text_end', () => {
    expect(
      normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' } }, 3),
    ).toEqual([{ kind: 'text_delta', id: 'pi_3_0', text: 'hel' }]);

    expect(
      normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'hello' } }, 3),
    ).toEqual([{ kind: 'text', id: 'pi_3_0', text: 'hello' }]);
  });

  it('disambiguates content index 0 across two different messages via messageSeq', () => {
    const first = normalizePiEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'first' } },
      1,
    );
    const second = normalizePiEvent(
      { type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'second' } },
      2,
    );
    expect(first[0]).toMatchObject({ id: 'pi_1_0' });
    expect(second[0]).toMatchObject({ id: 'pi_2_0' });
  });

  it('emits thinking only on thinking_end', () => {
    expect(
      normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thin' } }, 1),
    ).toEqual([]);
    expect(
      normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'done thinking' } }, 1),
    ).toEqual([{ kind: 'thinking', id: 'pi_1_0', text: 'done thinking' }]);
  });

  it('ignores toolcall_* deltas — tool_execution_* carries the real lifecycle', () => {
    expect(
      normalizePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"comm' } }, 1),
    ).toEqual([]);
  });
});

describe('normalizePiEvent: tool execution', () => {
  it('maps tool_execution_start to tool_use', () => {
    const events = normalizePiEvent({ type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls -la' } });
    expect(events).toEqual([
      { kind: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'ls -la' }, summary: 'Run ls -la', filePath: null },
    ]);
  });

  it('maps tool_execution_end to a non-error tool_result', () => {
    const events = normalizePiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'hi\n' }] },
      isError: false,
    });
    expect(events).toEqual([
      { kind: 'tool_result', id: 'pi_tr_call_1', toolUseId: 'call_1', content: 'hi\n', truncated: false, isError: false },
    ]);
  });

  it('marks an errored tool_execution_end as an error result', () => {
    const events = normalizePiEvent({
      type: 'tool_execution_end',
      toolCallId: 'call_1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'command not found' }] },
      isError: true,
    });
    expect(events[0]).toMatchObject({ kind: 'tool_result', isError: true, content: 'command not found' });
  });
});

describe('normalizePiEvent: turn lifecycle', () => {
  it('maps agent_settled to a turn_complete with no usage of its own', () => {
    expect(normalizePiEvent({ type: 'agent_settled' })).toEqual([
      { kind: 'turn_complete', stopReason: null, isError: false, numTurns: null, durationMs: null, costUsd: null, inputTokens: null, outputTokens: null },
    ]);
  });

  it('maps a failed auto_retry_end to an error notice', () => {
    expect(normalizePiEvent({ type: 'auto_retry_end', success: false, attempt: 3, finalError: '529 overloaded' })).toEqual([
      { kind: 'notice', level: 'error', text: '529 overloaded' },
    ]);
  });

  it('ignores a successful auto_retry_end', () => {
    expect(normalizePiEvent({ type: 'auto_retry_end', success: true, attempt: 2 })).toEqual([]);
  });

  it('maps extension_error to a warning notice', () => {
    expect(normalizePiEvent({ type: 'extension_error', extensionPath: '/x.ts', event: 'tool_call', error: 'boom' })).toEqual([
      { kind: 'notice', level: 'warn', text: 'Extension error: boom' },
    ]);
  });
});

describe('normalizePiEvent: robustness', () => {
  it('returns nothing for unknown or lifecycle-only event types', () => {
    expect(normalizePiEvent({ type: 'agent_start' })).toEqual([]);
    expect(normalizePiEvent({ type: 'turn_start' })).toEqual([]);
    expect(normalizePiEvent({ type: 'queue_update', steering: [], followUp: [] })).toEqual([]);
  });

  it('tolerates malformed input', () => {
    expect(normalizePiEvent(null)).toEqual([]);
    expect(normalizePiEvent('nonsense')).toEqual([]);
    expect(normalizePiEvent({ type: 'message_update' })).toEqual([]);
    expect(normalizePiEvent({ type: 'tool_execution_start' })).toEqual([]);
  });
});

describe('summarizePiTool', () => {
  it('summarizes well-known tools readably', () => {
    expect(summarizePiTool('bash', { command: 'npm test' })).toBe('Run npm test');
    expect(summarizePiTool('read', { path: '/a/b/c.ts' })).toBe('Read c.ts');
    expect(summarizePiTool('write', { path: '/a/b/c.ts' })).toBe('Write c.ts');
  });

  it('falls back to something useful for unknown tools', () => {
    expect(summarizePiTool('mystery_tool', {})).toBe('mystery_tool');
  });
});

describe('extractPiPath', () => {
  it('finds the path under common key names', () => {
    expect(extractPiPath({ path: '/a' })).toBe('/a');
    expect(extractPiPath({ file_path: '/b' })).toBe('/b');
  });

  it('returns null when there is no path', () => {
    expect(extractPiPath({ command: 'ls' })).toBeNull();
  });
});

const DEEPSEEK_MODEL = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'deepseek',
  reasoning: true,
  compat: { thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' } },
};

describe('normalizePiModels', () => {
  it('builds a composite provider/id value and derives effort levels from thinkingLevelMap', () => {
    expect(normalizePiModels([DEEPSEEK_MODEL])).toEqual([
      {
        value: 'deepseek/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'max'],
      },
    ]);
  });

  it('reports no effort levels for a model with no thinkingLevelMap, even if it reasons', () => {
    expect(normalizePiModels([{ id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', reasoning: true }])).toEqual([
      {
        value: 'anthropic/claude-sonnet-4',
        displayName: 'Claude Sonnet 4',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: [],
      },
    ]);
  });

  it('drops entries missing id or provider, and returns [] for a non-array input', () => {
    expect(normalizePiModels([{ id: 'no-provider' }, { provider: 'no-id' }])).toEqual([]);
    expect(normalizePiModels(undefined)).toEqual([]);
    expect(normalizePiModels('nope')).toEqual([]);
  });
});

describe('normalizePiModelValue', () => {
  it('returns the same composite value a list entry for the same model would get', () => {
    expect(normalizePiModelValue(DEEPSEEK_MODEL)).toBe('deepseek/deepseek-v4-flash');
  });

  it('returns null for a model with no id/provider, or a non-object', () => {
    expect(normalizePiModelValue({})).toBeNull();
    expect(normalizePiModelValue(null)).toBeNull();
    expect(normalizePiModelValue('nope')).toBeNull();
  });
});

describe('opencodeHistoryEvents', () => {
  it('reconstructs a user prompt, a completed tool call, and a final answer, closed by one turn_complete', () => {
    const events = opencodeHistoryEvents([
      {
        info: { id: 'msg_u', role: 'user' },
        parts: [{ id: 'prt_u', type: 'text', text: 'what is in this dir?' }],
      },
      {
        info: { id: 'msg_a', role: 'assistant' },
        parts: [
          {
            id: 'prt_tool',
            type: 'tool',
            callID: 'prt_tool',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt\n' },
          },
          { id: 'prt_text', type: 'text', text: 'Just file.txt.' },
        ],
      },
    ]);

    expect(events).toEqual([
      { kind: 'user_prompt', id: 'msg_u', text: 'what is in this dir?' },
      {
        kind: 'tool_use',
        id: 'prt_tool',
        name: 'bash',
        input: { command: 'ls' },
        summary: 'Run ls',
        filePath: null,
      },
      {
        kind: 'tool_result',
        id: 'oc_hist_tr_prt_tool',
        toolUseId: 'prt_tool',
        content: 'file.txt\n',
        truncated: false,
        isError: false,
      },
      { kind: 'text', id: 'prt_text', text: 'Just file.txt.' },
      {
        kind: 'turn_complete',
        stopReason: null,
        isError: false,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it('closes out one turn before opening the next when there is more than one', () => {
    const events = opencodeHistoryEvents([
      { info: { id: 'msg_u1', role: 'user' }, parts: [{ type: 'text', text: 'first' }] },
      { info: { id: 'msg_a1', role: 'assistant' }, parts: [{ id: 'p1', type: 'text', text: 'one' }] },
      { info: { id: 'msg_u2', role: 'user' }, parts: [{ type: 'text', text: 'second' }] },
      { info: { id: 'msg_a2', role: 'assistant' }, parts: [{ id: 'p2', type: 'text', text: 'two' }] },
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'text',
      'turn_complete',
      'user_prompt',
      'text',
      'turn_complete',
    ]);
  });

  it('drops an in-progress tool call and unknown part types, and tolerates malformed input', () => {
    expect(
      opencodeHistoryEvents([
        {
          info: { id: 'msg_a', role: 'assistant' },
          parts: [
            { id: 'p1', type: 'tool', callID: 'p1', tool: 'bash', state: { status: 'running', input: {} } },
            { id: 'p2', type: 'stepStart' },
          ],
        },
      ]),
    ).toEqual([]);
    expect(opencodeHistoryEvents(null)).toEqual([]);
    expect(opencodeHistoryEvents('nope')).toEqual([]);
    expect(opencodeHistoryEvents([{ info: null, parts: [] }])).toEqual([]);
  });
});

describe('codexHistoryEvents', () => {
  it('reconstructs a userMessage and reuses normalizeCodexItem for agentMessage/commandExecution, closed by turn_complete', () => {
    const events = codexHistoryEvents([
      {
        id: 'turn_1',
        status: 'completed',
        items: [
          { id: 'item_1', type: 'userMessage', content: [{ type: 'text', text: 'what does this do?' }] },
          { id: 'item_2', type: 'agentMessage', text: 'It runs tests.' },
        ],
      },
    ]);
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'item_1', text: 'what does this do?' },
      { kind: 'text', id: 'item_2', text: 'It runs tests.' },
      {
        kind: 'turn_complete',
        stopReason: null,
        isError: false,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it('flattens items across multiple turns and only synthesizes turn_complete once per turn', () => {
    const events = codexHistoryEvents([
      { id: 't1', status: 'completed', items: [{ id: 'i1', type: 'userMessage', content: [{ type: 'text', text: 'first' }] }, { id: 'i2', type: 'agentMessage', text: 'one' }] },
      { id: 't2', status: 'completed', items: [{ id: 'i3', type: 'userMessage', content: [{ type: 'text', text: 'second' }] }, { id: 'i4', type: 'agentMessage', text: 'two' }] },
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'text',
      'turn_complete',
      'user_prompt',
      'text',
      'turn_complete',
    ]);
  });

  it('drops non-text userMessage content and tolerates malformed input', () => {
    expect(codexHistoryEvents(null)).toEqual([]);
    expect(codexHistoryEvents('nope')).toEqual([]);
    expect(codexHistoryEvents([{ items: [{ id: 'i1', type: 'userMessage', content: [{ type: 'image', url: 'x' }] }] }])).toEqual([]);
    expect(codexHistoryEvents([null, { items: null }])).toEqual([]);
  });
});

describe('piHistoryEvents', () => {
  it('reconstructs a user message, a tool call/result pair, and a final answer, closed by turn_complete', () => {
    const events = piHistoryEvents([
      { role: 'user', content: 'what is in this dir?' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } }] },
      { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'file.txt\n' }], isError: false },
      { role: 'assistant', content: [{ type: 'text', text: 'Just file.txt.' }] },
    ]);

    expect(events).toEqual([
      { kind: 'user_prompt', id: 'pi_hist_0', text: 'what is in this dir?' },
      {
        kind: 'tool_use',
        id: 'call_1',
        name: 'bash',
        input: { command: 'ls' },
        summary: 'Run ls',
        filePath: null,
      },
      {
        kind: 'tool_result',
        id: 'pi_hist_tr_call_1',
        toolUseId: 'call_1',
        content: 'file.txt\n',
        truncated: false,
        isError: false,
      },
      { kind: 'text', id: 'pi_hist_3_0', text: 'Just file.txt.' },
      {
        kind: 'turn_complete',
        stopReason: null,
        isError: false,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it('reconstructs a bashExecution record as a synthetic tool_use/tool_result pair', () => {
    const events = piHistoryEvents([
      { role: 'user', content: 'run ls' },
      { role: 'bashExecution', command: 'ls', output: 'file.txt\n', exitCode: 0 },
    ]);
    expect(events).toEqual([
      { kind: 'user_prompt', id: 'pi_hist_0', text: 'run ls' },
      {
        kind: 'tool_use',
        id: 'pi_hist_bash_1',
        name: 'bash',
        input: { command: 'ls' },
        summary: 'Run ls',
        filePath: null,
      },
      {
        kind: 'tool_result',
        id: 'pi_hist_tr_pi_hist_bash_1',
        toolUseId: 'pi_hist_bash_1',
        content: 'file.txt\n',
        truncated: false,
        isError: false,
      },
      {
        kind: 'turn_complete',
        stopReason: null,
        isError: false,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
      },
    ]);
  });

  it('closes out one turn before opening the next when there is more than one', () => {
    const events = piHistoryEvents([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [{ type: 'text', text: 'one' }] },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    ]);
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt',
      'text',
      'turn_complete',
      'user_prompt',
      'text',
      'turn_complete',
    ]);
  });

  it('tolerates malformed input', () => {
    expect(piHistoryEvents(null)).toEqual([]);
    expect(piHistoryEvents('nope')).toEqual([]);
    expect(piHistoryEvents([null, 'nope', { role: 'user', content: '' }])).toEqual([]);
  });
});
