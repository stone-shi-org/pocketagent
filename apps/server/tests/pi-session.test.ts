import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { PiSession, type PiSessionSpec } from '../src/sessions/pi-session.js';
import { waitFor } from './helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-pi-rpc.mjs',
);

function makeSpec(overrides: Partial<PiSessionSpec> = {}): PiSessionSpec {
  return {
    id: 'sess_1',
    title: 'pi · project',
    agent: 'pi',
    agentDisplayName: 'pi',
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

function collect(session: PiSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.on('event', (_seq, event) => events.push(event));
  return events;
}

/**
 * `start()` fires three independent, fire-and-forget RPC round trips
 * (`fetchInitialCommands`/`fetchInitialModels`/`reportCurrentModelAndEffort`)
 * that can resolve at any point after it returns. A test asserting exactly
 * what one specific `setModel`/`setEffort` call emits has to wait for all
 * three to land and clear them first, or risks a stray `models_available`/
 * `model_changed`/`effort_changed` from *startup* interleaving into the
 * array it is asserting on.
 */
async function waitForStartupNoise(events: AgentEvent[]): Promise<void> {
  await waitFor(() => events.some((e) => e.kind === 'commands_available'));
  await waitFor(() => events.some((e) => e.kind === 'models_available'));
  await waitFor(() => events.some((e) => e.kind === 'model_changed'));
  await waitFor(() => events.some((e) => e.kind === 'effort_changed'));
  events.length = 0;
}

describe('PiSession', () => {
  let session: PiSession | null = null;

  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('starts a real, persistent process and emits session_started immediately', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    expect(session.status).toBe('running');
    expect(session.agentSessionId).toBeTruthy();
    // Unlike agy/opencode/codex, pi owns one real, persistent process, so
    // this reports a genuine pid instead of a fixed null.
    expect(session.pid).toBeGreaterThan(0);
  });

  it('learns the command list at start via get_commands, a side channel with no visible user_prompt', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();

    await waitFor(() => events.some((e) => e.kind === 'commands_available'));

    expect(events.some((e) => e.kind === 'user_prompt')).toBe(false);
    const commands = events.find((e) => e.kind === 'commands_available');
    expect(commands).toMatchObject({
      commands: [
        { name: 'session-name', description: 'Set or clear session name', argumentHint: '', aliases: [] },
        { name: 'skill:brave-search', description: 'Web search via Brave API', argumentHint: '', aliases: [] },
      ],
    });
  });

  it('learns the model catalog at start via get_available_models', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();

    await waitFor(() => events.some((e) => e.kind === 'models_available'));
    expect(events.find((e) => e.kind === 'models_available')).toEqual({
      kind: 'models_available',
      models: [
        {
          value: 'deepseek/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          description: '',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high', 'max'],
        },
        {
          value: 'anthropic/claude-sonnet-4',
          displayName: 'Claude Sonnet 4',
          description: '',
          supportsEffort: true,
          supportedEffortLevels: [],
        },
      ],
    });
  });

  it('reports the real starting model and effort via get_state, not session_started', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();

    // session_started itself still reports null — see PiSession.start().
    expect(events.find((e) => e.kind === 'session_started')).toMatchObject({ model: null });

    await waitFor(() => events.some((e) => e.kind === 'model_changed'));
    expect(events.find((e) => e.kind === 'model_changed')).toEqual({
      kind: 'model_changed',
      model: 'deepseek/deepseek-v4-flash',
    });
    expect(events.find((e) => e.kind === 'effort_changed')).toEqual({ kind: 'effort_changed', effort: 'high' });
  });

  it('switches model via set_model and confirms with model_changed', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setModel('anthropic/claude-sonnet-4');

    expect(events).toEqual([{ kind: 'model_changed', model: 'anthropic/claude-sonnet-4' }]);
  });

  it('rejects a model value with no "provider/id" separator instead of guessing', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setModel('not-composite');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warn' });
    expect((events[0] as { text: string }).text).toContain('provider/id');
  });

  it('reports a notice instead of throwing when set_model fails', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setModel('FAIL/whatever');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warn' });
    expect((events[0] as { text: string }).text).toContain('Model not found');
  });

  it('switches effort via set_thinking_level and confirms with effort_changed', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setEffort('low');

    expect(events).toEqual([{ kind: 'effort_changed', effort: 'low' }]);
  });

  it('reports a notice instead of throwing when set_thinking_level fails', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setEffort('FAIL');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warn' });
    expect((events[0] as { text: string }).text).toContain('Unsupported thinking level');
  });

  it('reports there is no "reset to default" instead of guessing a level', async () => {
    session = new PiSession(makeSpec());
    const events = collect(session);
    await session.start();
    await waitForStartupNoise(events);

    await session.setEffort(null);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'notice', level: 'warn' });
    expect((events[0] as { text: string }).text).toContain('no "reset to default"');
  });

  it('always reports skipPermissions, matching the always-bypassed contract', () => {
    session = new PiSession(makeSpec());
    expect(session.spec.skipPermissions).toBe(true);
    expect(session.pendingPermissions()).toEqual([]);
    expect(session.resolvePermission()).toBe(false);
  });

  it('reuses the resumeAgentSessionId as its own agentSessionId', async () => {
    session = new PiSession(makeSpec({ resumeAgentSessionId: 'existing-session-id' }));
    await session.start();
    expect(session.agentSessionId).toBe('existing-session-id');
  });

  it('runs one turn end to end: user_prompt, tool_use/result, text, turn_complete with usage', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    const events = collect(session);

    expect(session.prompt('hello')).toBe(true);
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'hello' });

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'bash', summary: 'Run echo hi' });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ content: 'hi\n', isError: false });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'echo: hello' });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      isError: false,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.002,
    });
    await waitFor(() => session?.busy === false);
  });

  it('never surfaces a permission_request — pi has no approval concept to trigger one', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('hello');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
  });

  it('marks a failed turn as an error via the cached stopReason', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('FAIL');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: true, stopReason: 'error' });
    await waitFor(() => session?.busy === false);
  });

  it('interrupt() aborts an in-flight turn without ending the session', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SLOW');
    await waitFor(() => events.some((e) => e.kind === 'tool_use'));

    await session.interrupt();
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.'));

    expect(session.isAlive()).toBe(true);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
  });

  it('terminate() kills the process and marks the session killed', async () => {
    session = new PiSession(makeSpec());
    await session.start();
    const pid = session.pid;
    expect(pid).toBeGreaterThan(0);

    session.terminate();
    expect(session.status).toBe('killed');
    expect(session.isAlive()).toBe(false);
    expect(session.prompt('too late')).toBe(false);

    await waitFor(() => {
      try {
        process.kill(pid!, 0);
        return false; // still alive
      } catch {
        return true; // ESRCH: process is gone
      }
    });
  });

  it('reports a spawn failure through start() rather than hanging', async () => {
    session = new PiSession(makeSpec({ executablePath: '/no/such/pi-binary' }));
    await expect(session.start()).rejects.toThrow();
    expect(session.status).toBe('error');
  });
});
