import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { applyFleetEvent, applyFleetEvents, emptyFleetPreview } from './fleet-preview.js';

const taskToolUse = (id: string, description: string): AgentEvent => ({
  kind: 'tool_use',
  id,
  name: 'Task',
  input: { description },
  summary: `Subagent: ${description}`,
  filePath: null,
});

const toolResult = (toolUseId: string): AgentEvent => ({
  kind: 'tool_result',
  id: `r_${toolUseId}`,
  toolUseId,
  content: 'done',
  truncated: false,
  isError: false,
});

const permissionRequest = (id: string, title: string): AgentEvent => ({
  kind: 'permission_request',
  id,
  toolName: 'Write',
  input: {},
  title,
  displayName: null,
  filePath: null,
  reason: null,
  canAllowForSession: true,
  questions: null,
});

describe('fleet-preview: lines', () => {
  it('keeps only the last 5 lines, newest last', () => {
    const events: AgentEvent[] = Array.from({ length: 8 }, (_, i) => ({
      kind: 'notice' as const,
      level: 'info' as const,
      text: `line ${i}`,
    }));
    const state = applyFleetEvents(emptyFleetPreview(), events);
    expect(state.lines).toEqual(['line 3', 'line 4', 'line 5', 'line 6', 'line 7']);
  });

  it('does not push anything for a streaming text_delta, only the completed text', () => {
    const state = applyFleetEvents(emptyFleetPreview(), [
      { kind: 'text_delta', id: 's1', text: 'wor' },
      { kind: 'text_delta', id: 's1', text: 'king on it' },
      { kind: 'text', id: 't1', text: 'working on it' },
    ]);
    expect(state.lines).toEqual(['working on it']);
  });

  it('prefixes a user prompt so it reads distinctly from agent output', () => {
    const state = applyFleetEvent(emptyFleetPreview(), {
      kind: 'user_prompt',
      id: 'u1',
      text: 'fix the bug',
    });
    expect(state.lines).toEqual(['> fix the bug']);
  });
});

describe('fleet-preview: sub-agents', () => {
  it('adds a sub-agent chip on a Task tool_use and removes it on the matching tool_result', () => {
    let state = emptyFleetPreview();
    state = applyFleetEvent(state, taskToolUse('tu1', 'investigate the flaky test'));
    expect(state.subagents).toEqual([{ toolUseId: 'tu1', summary: 'Subagent: investigate the flaky test' }]);

    state = applyFleetEvent(state, toolResult('tu1'));
    expect(state.subagents).toEqual([]);
  });

  it('tracks multiple concurrent sub-agents independently', () => {
    let state = emptyFleetPreview();
    state = applyFleetEvent(state, taskToolUse('tu1', 'task one'));
    state = applyFleetEvent(state, taskToolUse('tu2', 'task two'));
    expect(state.subagents.map((s) => s.toolUseId)).toEqual(['tu1', 'tu2']);

    state = applyFleetEvent(state, toolResult('tu1'));
    expect(state.subagents.map((s) => s.toolUseId)).toEqual(['tu2']);
  });

  it('does not treat a non-Task tool_use as a sub-agent', () => {
    const state = applyFleetEvent(emptyFleetPreview(), {
      kind: 'tool_use',
      id: 'tu1',
      name: 'Read',
      input: {},
      summary: 'Read file.ts',
      filePath: '/a/file.ts',
    });
    expect(state.subagents).toEqual([]);
  });

  it('ignores a tool_result for an id that was never a tracked sub-agent', () => {
    const state = applyFleetEvent(emptyFleetPreview(), toolResult('unknown'));
    expect(state).toEqual(emptyFleetPreview());
  });
});

describe('fleet-preview: awaitingApproval', () => {
  it('goes true on permission_request and false again on permission_resolved', () => {
    let state = emptyFleetPreview();
    state = applyFleetEvent(state, permissionRequest('p1', 'Allow Write?'));
    expect(state.awaitingApproval).toBe(true);

    state = applyFleetEvent(state, {
      kind: 'permission_resolved',
      id: 'p1',
      decision: 'allow',
      message: null,
    });
    expect(state.awaitingApproval).toBe(false);
  });
});

describe('fleet-preview: turn_complete', () => {
  it('shows a distinct line for an error turn vs a clean one', () => {
    const clean = applyFleetEvent(emptyFleetPreview(), {
      kind: 'turn_complete',
      stopReason: 'end_turn',
      isError: false,
      numTurns: 1,
      durationMs: 10,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    });
    expect(clean.lines).toEqual(['Idle — waiting for a prompt']);

    const errored = applyFleetEvent(emptyFleetPreview(), {
      kind: 'turn_complete',
      stopReason: 'error',
      isError: true,
      numTurns: 1,
      durationMs: 10,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    });
    expect(errored.lines).toEqual(['Turn ended with an error']);
  });
});
