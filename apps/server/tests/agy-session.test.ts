import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { readAgySettingsAutoApprove } from '../src/agents/agy.js';
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
    skipPermissions: false,
    ...overrides,
  };
}

function collect(session: AgySession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.on('event', (_seq, event) => events.push(event));
  return events;
}

describe('AgySession (ACP)', () => {
  let session: AgySession | null = null;

  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('handshakes over ACP at start(), populating models, commands, session_started, and agentSessionId', async () => {
    session = new AgySession(makeSpec());
    const events = collect(session);
    await session.start();

    expect(session.status).toBe('running');
    expect(session.isAlive()).toBe(true);
    expect(session.busy).toBe(false);
    expect(session.agentSessionId).not.toBeNull();

    await waitFor(() => events.some((e) => e.kind === 'commands_available'));

    expect(events.find((e) => e.kind === 'models_available')).toEqual({
      kind: 'models_available',
      models: [
        { value: 'auto', displayName: 'Gemini Pro Next', description: '', supportsEffort: false, supportedEffortLevels: [] },
        { value: 'gemini-flash-next', displayName: 'Gemini Flash Next', description: '', supportsEffort: false, supportedEffortLevels: [] },
        { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', description: '', supportsEffort: false, supportedEffortLevels: [] },
      ],
    });

    expect(events.find((e) => e.kind === 'commands_available')).toMatchObject({
      commands: [
        { name: 'goal', description: 'Run until the specified goal is completely finished.' },
        { name: 'compact', description: 'Compact the conversation now.' },
        { name: 'plan', description: 'Plan carefully before executing a task.' },
      ],
    });

    expect(events.find((e) => e.kind === 'session_started')).toMatchObject({
      agentSessionId: session.agentSessionId,
      model: 'auto',
      permissionMode: 'default',
    });
  });

  it('passes --add-dir <cwd> and only passes --dangerously-skip-permissions when skipPermissions is true (never for bypassedBySettings)', async () => {
    const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-argv-')), 'argv.jsonl');
    const env = { ...(process.env as Record<string, string>), AGY_FIXTURE_ARGV_FILE: argvFile };

    session = new AgySession(makeSpec({ env, skipPermissions: false }));
    await session.start();
    session.terminate();

    session = new AgySession(makeSpec({ env, skipPermissions: false, bypassedBySettings: true }));
    await session.start();
    expect(session.bypassedBySettings).toBe(true);
    session.terminate();

    session = new AgySession(makeSpec({ env, skipPermissions: true }));
    await session.start();

    const lines = fs
      .readFileSync(argvFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as string[]);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual(['acp', '--add-dir', process.cwd()]);
    expect(lines[1]).toEqual(['acp', '--add-dir', process.cwd()]);
    expect(lines[2]).toEqual(['acp', '--add-dir', process.cwd(), '--dangerously-skip-permissions']);
  });

  it('resumes an existing conversation via ACP session/resume when resumeAgentSessionId is provided', async () => {
    const rpcLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rpc-')), 'rpc.jsonl');
    const env = { ...(process.env as Record<string, string>), AGY_FIXTURE_RPC_LOG: rpcLog };

    session = new AgySession(makeSpec({ env, resumeAgentSessionId: 'existing-conv-uuid' }));
    await session.start();

    expect(session.agentSessionId).toBe('existing-conv-uuid');
    const calls = fs
      .readFileSync(rpcLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; sessionId?: string });
    expect(calls[0]).toEqual({ method: 'session/resume', sessionId: 'existing-conv-uuid' });
  });

  it('switches model live via session/set_model without respawning', async () => {
    const argvFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-model-')), 'argv.jsonl');
    const env = { ...(process.env as Record<string, string>), AGY_FIXTURE_ARGV_FILE: argvFile };

    session = new AgySession(makeSpec({ env }));
    await session.start();
    const events = collect(session);

    await session.setModel('claude-sonnet-4-6');
    expect(events).toContainEqual({ kind: 'model_changed', model: 'claude-sonnet-4-6' });

    session.prompt('hello');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const text = events.find((e) => e.kind === 'text');
    expect(text).toMatchObject({ text: 'echo: hello model=claude-sonnet-4-6' });

    // Only one `agy acp` process was ever spawned — no respawn for setModel.
    const spawns = fs.readFileSync(argvFile, 'utf8').trim().split('\n');
    expect(spawns).toHaveLength(1);
  });

  it('applies initial model via session/set_model at start()', async () => {
    session = new AgySession(makeSpec({ model: 'gemini-flash-next' }));
    const events = collect(session);
    await session.start();

    expect(events.some((e) => e.kind === 'model_changed' && e.model === 'gemini-flash-next')).toBe(true);
    expect(events.find((e) => e.kind === 'session_started')).toMatchObject({ model: 'gemini-flash-next' });

    session.prompt('ping');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.find((e) => e.kind === 'text')).toMatchObject({
      text: 'echo: ping model=gemini-flash-next',
    });
  });

  it('runs a full turn end to end with per-turn usage and live session_info_update title', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);
    const titles: string[] = [];
    session.on('title', (t) => titles.push(t));

    expect(session.prompt('hello world')).toBe(true);
    expect(session.busy).toBe(true);

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    await waitFor(() => session?.busy === false);

    const kinds = events.filter((e) => e.kind !== 'commands_available').map((e) => e.kind);
    expect(kinds).toEqual([
      'user_prompt',
      'thinking_delta',
      'thinking',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);

    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({
      name: 'run_command',
      summary: 'Run echo hi',
    });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({
      content: 'hi\n',
      isError: false,
    });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      stopReason: 'end_turn',
      isError: false,
      inputTokens: 101,
      outputTokens: 25,
      cacheReadTokens: 40,
    });
    expect(session.derivedTitle).toBe('Title for hello world');
    expect(titles).toEqual(['Title for hello world']);

    // Second turn reports its own per-turn usage directly (not cumulative).
    session.prompt('second');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    const secondComplete = events.filter((e) => e.kind === 'turn_complete')[1];
    expect(secondComplete).toMatchObject({ inputTokens: 102, outputTokens: 25 });
  });

  it('parks session/request_permission indefinitely until resolved with allow or deny', async () => {
    session = new AgySession(makeSpec({ skipPermissions: false }));
    await session.start();
    const events = collect(session);
    const permSnapshots: number[] = [];
    session.on('permission', (pending) => permSnapshots.push(pending.length));

    session.prompt('NEED_APPROVAL');
    await waitFor(() => session!.pendingPermissions().length === 1);

    const pending = session.pendingPermissions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      kind: 'permission_request',
      toolName: 'run_command',
      title: 'Allow: echo approved?',
      canAllowForSession: false,
    });

    // Confirm it stays parked (no auto-approve timeout).
    await new Promise((r) => setTimeout(r, 150));
    expect(session.pendingPermissions()).toHaveLength(1);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);

    // Resolve with allow.
    expect(session.resolvePermission(pending[0]!.id, 'allow')).toBe(true);
    expect(session.resolvePermission('unknown', 'allow')).toBe(false);
    expect(session.pendingPermissions()).toEqual([]);

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.some((e) => e.kind === 'permission_resolved' && e.decision === 'allow')).toBe(true);
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'ran echo approved' });
    expect(permSnapshots).toEqual([1, 0]);

    // Second prompt: deny it.
    session.prompt('NEED_APPROVAL');
    await waitFor(() => session!.pendingPermissions().length === 1);
    const secondReq = session.pendingPermissions()[0]!;
    expect(session.resolvePermission(secondReq.id, 'deny', 'no thanks')).toBe(true);

    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    const texts = events.filter((e) => e.kind === 'text');
    expect(texts[1]).toMatchObject({ text: 'command denied' });
  });

  it('bypasses approval prompts when skipPermissions is true', async () => {
    session = new AgySession(makeSpec({ skipPermissions: true }));
    await session.start();
    const events = collect(session);

    session.prompt('NEED_APPROVAL');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'ran echo approved' });
  });

  it('keeps a background task alive after end_turn, stays busy until it completes, and forwards idle reactive updates', async () => {
    const taskFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-')), 'task.done');
    const env = {
      ...(process.env as Record<string, string>),
      AGY_FIXTURE_BACKGROUND_TASK_FILE: taskFile,
    };

    session = new AgySession(makeSpec({ env }));
    await session.start();
    const events = collect(session);
    let idleEmitted = 0;
    session.on('idle', () => idleEmitted++);

    session.prompt('BACKGROUND_TASK');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    // Turn resolved before background task finished (matching real agy acp v1.5.14),
    // and `busy` MUST stay true while the in-flight background tool call is still running
    // so RunQueue and restart drain do not treat the checkout as idle.
    expect(fs.existsSync(taskFile)).toBe(false);
    expect(session.busy).toBe(true);
    expect(idleEmitted).toBe(0);

    // Background task survives and completes while the ACP process stays up.
    await waitFor(() => fs.existsSync(taskFile), { timeout: 5_000 });
    expect(fs.readFileSync(taskFile, 'utf8')).toBe('FINISHED');

    // Reactive tool_result and follow-up text arrive while idle, and `busy` clears + emits 'idle'.
    await waitFor(() => events.some((e) => e.kind === 'tool_result'));
    await waitFor(() => events.some((e) => e.kind === 'text' && e.text === 'Background task finished.'), {
      timeout: 3_000,
    });
    await waitFor(() => session?.busy === false, { timeout: 3_000 });
    expect(idleEmitted).toBe(1);
  });

  it('clears in-flight tool calls on turn error and prunes non-execute calls at end_turn so busy never gets stuck', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    // 1. Execute tool call with no terminal update followed by an errored turn -> busy must be false.
    session.prompt('DANGLING_TOOL_ERROR');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    await waitFor(() => session?.busy === false);
    expect(session.busy).toBe(false);

    // 2. Non-execute tool call (kind: "read") with no terminal update followed by normal end_turn -> busy must be false.
    session.prompt('DANGLING_READ_END_TURN');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    await waitFor(() => session?.busy === false);
    expect(session.busy).toBe(false);
  });

  it('interrupt() cancels parked permissions with permission_resolved so transcript cards close cleanly', async () => {
    session = new AgySession(makeSpec({ skipPermissions: false }));
    await session.start();
    const events = collect(session);

    session.prompt('NEED_APPROVAL');
    await waitFor(() => session!.pendingPermissions().length === 1);
    const reqId = session.pendingPermissions()[0]!.id;

    await session.interrupt();
    expect(session.pendingPermissions()).toEqual([]);
    expect(events).toContainEqual({
      kind: 'permission_resolved',
      id: reqId,
      decision: 'deny',
      message: 'Interrupted.',
    });
  });

  it('bounds the startup handshake and kills the child on timeout or handshake failure', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hang-'));
    const hangPidFile = path.join(dir, 'hang.pid');
    const hung = new AgySession(
      makeSpec({
        handshakeTimeoutMs: 250,
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_HANG_INIT: '1',
          AGY_FIXTURE_PID_FILE: hangPidFile,
        },
      }),
    );
    await expect(hung.start()).rejects.toThrow(/Timed out waiting for agy ACP initialize/);
    const hangPid = Number(fs.readFileSync(hangPidFile, 'utf8').trim());
    await waitFor(() => {
      try {
        process.kill(hangPid, 0);
        return false;
      } catch {
        return true;
      }
    });

    const failPidFile = path.join(dir, 'fail.pid');
    const failed = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_FAIL_SESSION_NEW: '1',
          AGY_FIXTURE_PID_FILE: failPidFile,
        },
      }),
    );
    await expect(failed.start()).rejects.toThrow(/simulated session\/new failure/);
    const failPid = Number(fs.readFileSync(failPidFile, 'utf8').trim());
    await waitFor(() => {
      try {
        process.kill(failPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('emits settingsAutoApproveNotice at start() when provided', async () => {
    session = new AgySession(
      makeSpec({
        skipPermissions: true,
        settingsAutoApproveNotice: 'settings.json sets toolPermission: "always-proceed"',
      }),
    );
    const events = collect(session);
    await session.start();
    expect(events).toContainEqual({
      kind: 'notice',
      level: 'warn',
      text: 'settings.json sets toolPermission: "always-proceed"',
    });
  });

  it('maps interrupt() to ACP session/cancel', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('SLOW_CANCEL');
    await waitFor(() => session?.busy === true);
    await session.interrupt();

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.')).toBe(true);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      stopReason: 'cancelled',
      isError: false,
    });
  });

  it('emits rate_limit and error notice on quota exhaustion', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('QUOTA');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'rate_limit' && e.provider === 'agy')).toBe(true);
    expect(events.some((e) => e.kind === 'notice' && e.level === 'error')).toBe(true);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: true });
  });

  it('silently retries a transient timeout error on the same ACP session', async () => {
    const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-retry-')), 'once');
    const env = {
      ...(process.env as Record<string, string>),
      AGY_FIXTURE_TIMEOUT_ONCE_FILE: stateFile,
    };

    session = new AgySession(makeSpec({ env }));
    await session.start();
    const events = collect(session);

    session.prompt('TIMEOUT_ONCE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'), { timeout: 5_000 });

    expect(events.some((e) => e.kind === 'notice' && e.level === 'warn' && e.text.includes('retrying'))).toBe(true);
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: false });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'echo: TIMEOUT_ONCE model=auto' });
  });

  it('warns if the ACP child dies between turns and respawns via session/resume on the next prompt', async () => {
    const rpcLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-respawn-')), 'rpc.jsonl');
    const env = { ...(process.env as Record<string, string>), AGY_FIXTURE_RPC_LOG: rpcLog };

    session = new AgySession(makeSpec({ env }));
    await session.start();
    const firstId = session.agentSessionId;
    const events = collect(session);

    session.prompt('CRASH_BETWEEN_TURNS');
    await waitFor(() =>
      events.some((e) => e.kind === 'notice' && e.level === 'warn' && e.text.includes('stopped between turns')),
    );

    session.prompt('after crash');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);

    const calls = fs
      .readFileSync(rpcLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; sessionId?: string });
    expect(calls.map((c) => c.method)).toEqual(['session/new', 'session/resume']);
    expect(calls[1]?.sessionId).toBe(firstId);
  });

  it('sends session/close on terminate()', async () => {
    const rpcLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-close-')), 'rpc.jsonl');
    const env = { ...(process.env as Record<string, string>), AGY_FIXTURE_RPC_LOG: rpcLog };

    session = new AgySession(makeSpec({ env }));
    await session.start();
    session.terminate();
    expect(session.status).toBe('killed');

    await waitFor(() => {
      const text = fs.readFileSync(rpcLog, 'utf8');
      return text.includes('session/close');
    });
  });
});

describe('readAgySettingsAutoApprove', () => {
  it('fails closed on non-supervised toolPermission policies in settings.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-settings-'));
    const file = path.join(dir, 'settings.json');

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'always-proceed' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file })).toEqual({
      autoApproves: true,
      toolPermission: 'always-proceed',
      settingsPath: file,
    });

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'proceed-in-sandbox' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file }).autoApproves).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'custom' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file }).autoApproves).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'unknown-future-policy' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file }).autoApproves).toBe(true);

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'request-review' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file })).toEqual({
      autoApproves: false,
      toolPermission: 'request-review',
      settingsPath: file,
    });

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'strict' }));
    expect(readAgySettingsAutoApprove({ settingsPath: file }).autoApproves).toBe(false);

    fs.writeFileSync(file, JSON.stringify({}));
    expect(readAgySettingsAutoApprove({ settingsPath: file }).autoApproves).toBe(false);

    expect(readAgySettingsAutoApprove({ settingsPath: path.join(dir, 'missing.json') }).autoApproves).toBe(false);
  });
});
