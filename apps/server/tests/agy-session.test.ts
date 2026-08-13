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

  it('always reports skipPermissions, matching the always-bypassed contract', async () => {
    session = new AgySession(makeSpec());
    expect(session.spec.skipPermissions).toBe(true);
    expect(session.pendingPermissions()).toEqual([]);
    expect(session.resolvePermission('anything', 'allow')).toBe(false);
  });

  it('runs one turn end to end: user_prompt, session_started, tool_use/result, text, turn_complete', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    expect(session.prompt('hello')).toBe(true);
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'hello' });

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'user_prompt',
      'session_started',
      'tool_use',
      'tool_result',
      'text_delta',
      'turn_complete',
    ]);

    const toolUse = events.find((e) => e.kind === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'run_command', summary: 'Run echo hi' });
    const toolResult = events.find((e) => e.kind === 'tool_result');
    expect(toolResult).toMatchObject({ content: 'hi\n', isError: false });
    const textDelta = events.find((e) => e.kind === 'text_delta');
    expect(textDelta).toMatchObject({ text: 'echo: hello' });
    const turnComplete = events.find((e) => e.kind === 'turn_complete');
    expect(turnComplete).toMatchObject({ isError: false, inputTokens: 10, outputTokens: 5 });

    expect(session.agentSessionId).not.toBeNull();
    await waitFor(() => session?.busy === false);
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
