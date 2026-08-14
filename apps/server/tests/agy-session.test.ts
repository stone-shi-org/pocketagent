import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { AgySession, type AgySessionSpec } from '../src/sessions/agy-session.js';
import { waitFor } from './helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-agy.mjs',
);

function makeSpec(overrides: Partial<AgySessionSpec> = {}): AgySessionSpec {
  return {
    id: 'sess_1',
    title: 'Antigravity CLI · project',
    agent: 'agy',
    agentDisplayName: 'Antigravity CLI',
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
    workspaceLabel: 'project',
    eventBufferBytes: 1024 * 1024,
    createdAt: Date.now(),
    executablePath: FIXTURE,
    skipPermissions: true,
    ...overrides,
  };
}

/** Collects every event a session emits, in order, for assertions below. */
function collect(session: AgySession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.on('event', (_seq, event) => events.push(event));
  return events;
}

describe('AgySession', () => {
  let session: AgySession | null = null;

  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('starts running immediately with no process yet, since print mode is per-turn', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    expect(session.status).toBe('running');
    expect(session.isAlive()).toBe(true);
    expect(session.pid).toBeNull();
    expect(session.busy).toBe(false);
  });

  it('learns the command list at start via a silent /help, with no visible user_prompt', async () => {
    session = new AgySession(makeSpec());
    const events = collect(session);
    await session.start();

    await waitFor(() => events.some((e) => e.kind === 'commands_available'));

    // The probe must never look like a real turn: no echoed prompt for it.
    expect(events.some((e) => e.kind === 'user_prompt')).toBe(false);
    const commands = events.find((e) => e.kind === 'commands_available');
    expect(commands).toMatchObject({
      commands: [
        { name: 'agents', description: 'List available custom agents', argumentHint: '', aliases: [] },
        { name: 'model', description: 'Set a model', argumentHint: '', aliases: [] },
        { name: 'usage', description: 'View model quota usage', argumentHint: '', aliases: ['quota'] },
      ],
    });
  });

  it('learns the model catalog at start via the `models` subcommand', async () => {
    session = new AgySession(makeSpec());
    const events = collect(session);
    await session.start();

    await waitFor(() => events.some((e) => e.kind === 'models_available'));
    expect(events.find((e) => e.kind === 'models_available')).toEqual({
      kind: 'models_available',
      models: [
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
      ],
    });
  });

  it('switches model by respawning the next turn with --model, confirmed immediately with no round trip', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    await session.setModel('claude-sonnet-4-6');
    // No RPC/process to wait for — the switch is just recorded, so the
    // confirmation is synchronous with the call, unlike every other backend.
    expect(events).toEqual([{ kind: 'model_changed', model: 'claude-sonnet-4-6' }]);

    session.prompt('hello');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    const text = events.find((e) => e.kind === 'text');
    expect(text).toMatchObject({ text: 'echo: hello model=claude-sonnet-4-6' });
  });

  it('always reports skipPermissions, matching the always-bypassed contract', async () => {
    session = new AgySession(makeSpec());
    expect(session.spec.skipPermissions).toBe(true);
    expect(session.pendingPermissions()).toEqual([]);
    expect(session.resolvePermission('anything', 'allow')).toBe(false);
  });

  it('runs one turn end to end: user_prompt, session_started, tool_use/result, text_delta, text, turn_complete', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    expect(session.prompt('hello')).toBe(true);
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'hello' });

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    // `commands_available`/`models_available` come from two independent
    // startup probes (`fetchInitialCommands`/`fetchInitialModels`) racing
    // this turn with no ordering guarantee between them — see their own
    // dedicated tests above. Filtered out here since this test is only about
    // the turn's own event sequence.
    const kinds = events
      .filter((e) => e.kind !== 'commands_available' && e.kind !== 'models_available')
      .map((e) => e.kind);
    expect(kinds).toEqual([
      'user_prompt',
      'session_started',
      'tool_use',
      'tool_result',
      'text_delta',
      // The closing `text` event matters as much as its content: without it,
      // the client's `dropStreaming` on `turn_complete` deletes the whole
      // answer instead of finalizing it — the delta stream is never marked
      // complete otherwise. See the comment in `agy-session.ts`.
      'text',
      'turn_complete',
    ]);

    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'run_command', summary: 'Run echo hi' });
    const toolResult = events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toMatchObject({ content: 'hi\n', isError: false });
    const textDelta = events.find((e) => e.kind === 'text_delta');
    expect(textDelta).toMatchObject({ text: 'echo: hello' });
    const text = events.find((e) => e.kind === 'text');
    expect(text).toMatchObject({ text: 'echo: hello' });
    const turnComplete = events.find((e) => e.kind === 'turn_complete');
    expect(turnComplete).toMatchObject({ isError: false, inputTokens: 10, outputTokens: 5 });

    expect(session.agentSessionId).not.toBeNull();
    await waitFor(() => session?.busy === false);
  });

  /**
   * `invoke_subagent`'s own step marks itself DONE almost immediately —
   * confirmed live not to mean the sub-agent's real work is done (see
   * `normalizeAgyStepUpdate`'s doc comment) — so a fleet-view chip must stay
   * open past that point. The fixture's `SUBAGENT` prompt reproduces exactly
   * that shape, with the turn's own `result` line delayed so this test can
   * observe "still pending" in between.
   */
  it('keeps a sub-agent tool_use open past its own premature DONE, resolving only at the turn\'s result', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SUBAGENT');
    await waitFor(() => events.some((e) => e.kind === 'tool_use' && e.name === 'invoke_subagent'));

    // The premature DONE step_update has already fired by now too (the
    // fixture emits it right after ACTIVE, synchronously) — confirm it did
    // NOT produce a resolving tool_result.
    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'invoke_subagent', summary: 'Subagent: File Writer' });
    expect(events.some((e) => e.kind === 'tool_result')).toBe(false);

    await waitFor(() => events.some((e) => e.kind === 'tool_result'));
    const toolResult = events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toMatchObject({
      toolUseId: toolUse && toolUse.kind === 'tool_use' ? toolUse.id : undefined,
      isError: false,
    });

    // And it resolved before the turn ended, not after — the fleet-view chip
    // this drives should never coexist with an idle dot.
    const toolResultIndex = events.indexOf(toolResult);
    const turnCompleteIndex = events.findIndex((e) => e.kind === 'turn_complete');
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(turnCompleteIndex).toBeGreaterThan(toolResultIndex);
  });

  it('resolves a still-pending sub-agent if the turn is killed before it ever reports back', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SUBAGENT');
    await waitFor(() => events.some((e) => e.kind === 'tool_use' && e.name === 'invoke_subagent'));
    expect(events.some((e) => e.kind === 'tool_result')).toBe(false);

    session.terminate();
    await waitFor(() => events.some((e) => e.kind === 'tool_result'));
    const toolResult = events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toMatchObject({ isError: true });
  });

  it('carries the conversation id forward across turns via --conversation', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('first');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 1);
    const firstId = session.agentSessionId;
    expect(firstId).not.toBeNull();

    session.prompt('second');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    expect(session.agentSessionId).toBe(firstId);
  });

  it('queues a second prompt sent while the first is still running', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('first');
    session.prompt('second');

    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    // Two independent user_prompt echoes, two independent turns, run in order.
    expect(events.filter((e) => e.kind === 'user_prompt')).toHaveLength(2);
    await waitFor(() => session?.busy === false);
  });

  it('interrupt() kills the running turn without ending the session', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SLOW');
    await waitFor(() => events.some((e) => e.kind === 'tool_use'));

    await session.interrupt();

    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.'));
    expect(session.isAlive()).toBe(true);
    // The killed turn never reaches turn_complete or result text.
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
    await waitFor(() => session?.busy === false);
  });

  it('surfaces a non-zero exit as a notice instead of crashing the session', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('FAIL');
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.level === 'error'));

    expect(session.isAlive()).toBe(true);
    const notice = events.find((e) => e.kind === 'notice');
    expect(notice).toMatchObject({ level: 'error', text: 'simulated failure' });
    await waitFor(() => session?.busy === false);
  });

  it('terminate() kills an in-flight process and marks the session killed', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SLOW');
    await waitFor(() => events.some((e) => e.kind === 'tool_use'));

    session.terminate();
    expect(session.status).toBe('killed');
    expect(session.isAlive()).toBe(false);

    // A prompt after termination is refused rather than silently queued.
    expect(session.prompt('too late')).toBe(false);
  });
});
