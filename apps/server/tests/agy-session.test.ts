import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SPOKEN_SUMMARY_INSTRUCTION, type AgentEvent } from '@pocketagent/protocol';
import {
  formatAgySettingsAutoApproveNotice,
  readAgySettingsAutoApprove,
  resolveAgyApprovalDisclosure,
} from '../src/agents/agy.js';
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
      'context_usage',
      'thinking',
      'tool_use',
      'tool_result',
      'text_delta',
      'text',
      'turn_complete',
    ]);
    expect(events.find((e) => e.kind === 'context_usage')).toMatchObject({
      usedTokens: 50_000,
      contextWindow: 1_048_576,
    });

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

  it('keeps a background task alive after end_turn, defers turn_complete, stays busy until reactive wakeup settles, and forwards idle updates', async () => {
    const taskFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-')), 'task.done');
    const env = {
      ...(process.env as Record<string, string>),
      AGY_FIXTURE_BACKGROUND_TASK_FILE: taskFile,
    };

    session = new AgySession(makeSpec({ env, reactiveSettleMs: 120 }));
    await session.start();
    const events = collect(session);
    let idleEmitted = 0;
    session.on('idle', () => idleEmitted++);

    session.prompt('BACKGROUND_TASK');
    await waitFor(() => session!.backgroundCommands.length > 0);

    // `session/prompt` resolved before the background task finished (matching real
    // agy acp v1.5.14). `turn_complete` MUST be deferred and `busy` MUST stay true
    // so RunExecutor does not settle early and RunQueue does not release the tree.
    expect(fs.existsSync(taskFile)).toBe(false);
    expect(session.busy).toBe(true);
    expect(session.backgroundCommands).toEqual(['sleep 1 && echo bg']);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
    expect(idleEmitted).toBe(0);

    // Background task survives and completes while the ACP process stays up.
    await waitFor(() => fs.existsSync(taskFile), { timeout: 5_000 });
    expect(fs.readFileSync(taskFile, 'utf8')).toBe('FINISHED');

    // Reactive tool_result and follow-up text arrive, then turn_complete fires once and `busy` clears.
    await waitFor(() => events.some((e) => e.kind === 'tool_result'));
    await waitFor(() => events.some((e) => e.kind === 'text' && e.text === 'Background task finished.'), {
      timeout: 3_000,
    });
    await waitFor(() => session?.busy === false, { timeout: 3_000 });
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(1);
    expect(session.backgroundCommands).toEqual([]);
    expect(idleEmitted).toBe(1);
  });

  it('stays continuously busy across multi-step reactive wakeups with >500ms LLM gaps (no premature turn_complete or idle flap)', async () => {
    const env = {
      ...(process.env as Record<string, string>),
      AGY_FIXTURE_REACTIVE_GAP_MS: '650',
    };

    session = new AgySession(makeSpec({ env, reactiveSettleMs: 150 }));
    await session.start();
    const events = collect(session);
    let idleEmitted = 0;
    let sawIdleBeforeFinalText = false;
    session.on('idle', () => {
      idleEmitted++;
      if (!events.some((e) => e.kind === 'text' && e.text === 'All reactive steps done.')) {
        sawIdleBeforeFinalText = true;
      }
    });

    session.prompt('BACKGROUND_TASK_MULTI_STEP');
    await waitFor(() => session!.backgroundCommands.includes('pnpm test'));
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);

    await waitFor(() => events.some((e) => e.kind === 'text' && e.text === 'All reactive steps done.'), {
      timeout: 6_000,
    });
    await waitFor(() => session?.busy === false, { timeout: 3_000 });

    expect(sawIdleBeforeFinalText).toBe(false);
    expect(idleEmitted).toBe(1);
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'tool_use' && e.summary === 'Run git commit')).toBe(true);
  });

  it('retains non-execute background-capable tools (schedule) across end_turn and supports legacy fallback without usage_update', async () => {
    session = new AgySession(makeSpec({ reactiveSettleMs: 100, reactiveFallbackFlushMs: 180 }));
    await session.start();
    const events = collect(session);
    let idleEmitted = 0;
    session.on('idle', () => idleEmitted++);

    // 1. `schedule` (kind: "other") must not be pruned at end_turn.
    session.prompt('BACKGROUND_SCHEDULE');
    await waitFor(() => session!.backgroundCommands.includes('Run schedule'));
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
    await waitFor(() => session?.busy === false, { timeout: 3_000 });
    expect(events.some((e) => e.kind === 'text' && e.text === 'Timer completed.')).toBe(true);
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(1);
    expect(idleEmitted).toBe(1);

    // 2. Older agy build emitting reactive text without usage_update settles via reactiveFallbackFlushMs.
    session.prompt('BACKGROUND_TASK_LEGACY');
    await waitFor(() => events.some((e) => e.kind === 'text' && e.text === 'Legacy reactive reply.'), {
      timeout: 3_000,
    });
    await waitFor(() => session?.busy === false, { timeout: 3_000 });
    expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(2);
    expect(idleEmitted).toBe(2);
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

  it('advertises modes, switches mode live with no respawn, latches auto-approval, and streams context_usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mode-live-'));
    const pidFile = path.join(dir, 'pid');
    const rpcLog = path.join(dir, 'rpc.log');
    const env = { ...process.env, AGY_FIXTURE_PID_FILE: pidFile, AGY_FIXTURE_RPC_LOG: rpcLog } as Record<
      string,
      string
    >;

    session = new AgySession(makeSpec({ env }));
    const events: AgentEvent[] = [];
    session.on('event', (_seq, ev) => events.push(ev));
    const statusChanges: string[] = [];
    session.on('status', (st) => statusChanges.push(st));

    await session.start();
    const initialPid = fs.readFileSync(pidFile, 'utf8').trim();

    expect(session.currentMode).toBe('default');
    expect(session.autoApprovedByMode).toBe(false);
    expect(session.everAutoApprovedByMode).toBe(false);

    const modesAvail = events.find((e) => e.kind === 'modes_available');
    expect(modesAvail).toBeDefined();
    if (modesAvail?.kind === 'modes_available') {
      expect(modesAvail.modes.map((m) => m.id)).toEqual(['default', 'accept-edits', 'auto', 'plan']);
    }

    // Switch live to `plan` (safe direction — never latches auto-approval).
    await session.setMode('plan');
    expect(session.currentMode).toBe('plan');
    expect(session.autoApprovedByMode).toBe(false);
    expect(session.everAutoApprovedByMode).toBe(false);
    // No respawn occurred.
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(initialPid);
    // No duplicate mode_changed when both RPC and `current_mode_update` fire.
    expect(events.filter((e) => e.kind === 'mode_changed' && e.mode === 'plan')).toHaveLength(1);

    // Confirm fake-agy observed `plan` and emits live `context_usage`.
    session.prompt('REPORT_MODE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.some((e) => e.kind === 'text' && e.text === 'mode=plan')).toBe(true);
    expect(
      events.some(
        (e) => e.kind === 'context_usage' && e.usedTokens === 650117 && e.contextWindow === 1048576,
      ),
    ).toBe(true);

    // Switch live to `auto` -> latches `autoApprovedByMode` and sticky `everAutoApprovedByMode`.
    statusChanges.length = 0;
    await session.setMode('auto');
    expect(session.currentMode).toBe('auto');
    expect(session.autoApprovedByMode).toBe(true);
    expect(session.everAutoApprovedByMode).toBe(true);
    expect(statusChanges).toContain('running');

    // Switching back to `default` clears live `autoApprovedByMode` but keeps sticky `everAutoApprovedByMode`.
    await session.setMode('default');
    expect(session.currentMode).toBe('default');
    expect(session.autoApprovedByMode).toBe(false);
    expect(session.everAutoApprovedByMode).toBe(true);
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(initialPid);
  });

  it('applies initial spec.mode on handshake and preserves mode across between-turn respawn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mode-respawn-'));
    const pidFile = path.join(dir, 'pid');
    const env = { ...process.env, AGY_FIXTURE_PID_FILE: pidFile } as Record<string, string>;

    session = new AgySession(makeSpec({ env, mode: 'plan' }));
    const events: AgentEvent[] = [];
    session.on('event', (_seq, ev) => events.push(ev));

    await session.start();
    const firstPid = fs.readFileSync(pidFile, 'utf8').trim();
    expect(session.currentMode).toBe('plan');

    session.prompt('CRASH_BETWEEN_TURNS');
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text.includes('stopped between turns')));

    session.prompt('REPORT_MODE');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    const secondPid = fs.readFileSync(pidFile, 'utf8').trim();
    expect(secondPid).not.toBe(firstPid);
    expect(events.some((e) => e.kind === 'text' && e.text === 'mode=plan')).toBe(true);
  });

  it('handles server-initiated current_mode_update and latches auto-approval', async () => {
    session = new AgySession(makeSpec());
    const events: AgentEvent[] = [];
    session.on('event', (_seq, ev) => events.push(ev));

    await session.start();
    expect(session.currentMode).toBe('default');
    expect(session.everAutoApprovedByMode).toBe(false);

    session.prompt('SERVER_MODE_CHANGE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(session.currentMode).toBe('accept-edits');
    expect(session.autoApprovedByMode).toBe(true);
    expect(session.everAutoApprovedByMode).toBe(true);
    expect(events.some((e) => e.kind === 'mode_changed' && e.mode === 'accept-edits')).toBe(true);
  });

  it('sends SPOKEN_SUMMARY_INSTRUCTION via ACP systemPrompt.append when voice is on and nothing when off (PA-185)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sysprompt-init-'));
    const rpcLogOn = path.join(dir, 'rpc-on.jsonl');
    const promptLogOn = path.join(dir, 'prompt-on.jsonl');

    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_RPC_LOG: rpcLogOn,
          AGY_FIXTURE_PROMPT_LOG: promptLogOn,
        },
        shouldAppendSpokenSummary: () => true,
      }),
    );
    await session.start();
    expect(session.supportsSystemPromptAppend).toBe(true);

    const eventsOn = collect(session);
    session.prompt('explain tcp');
    await waitFor(() => eventsOn.some((e) => e.kind === 'turn_complete'));

    const rpcsOn = fs
      .readFileSync(rpcLogOn, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcsOn).toHaveLength(1);
    expect(rpcsOn[0]).toMatchObject({
      method: 'session/new',
      systemPromptAppend: SPOKEN_SUMMARY_INSTRUCTION,
    });

    const promptsOn = fs
      .readFileSync(promptLogOn, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(promptsOn).toEqual([
      {
        sessionId: session.agentSessionId,
        text: 'explain tcp',
        systemPromptAppend: SPOKEN_SUMMARY_INSTRUCTION,
      },
    ]);
    session.terminate();

    // Voice OFF: no `_meta.antigravity.systemPrompt.append` on session/new and no instruction in prompt text.
    const rpcLogOff = path.join(dir, 'rpc-off.jsonl');
    const promptLogOff = path.join(dir, 'prompt-off.jsonl');
    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_RPC_LOG: rpcLogOff,
          AGY_FIXTURE_PROMPT_LOG: promptLogOff,
        },
        shouldAppendSpokenSummary: () => false,
      }),
    );
    await session.start();
    const eventsOff = collect(session);
    session.prompt('plain turn');
    await waitFor(() => eventsOff.some((e) => e.kind === 'turn_complete'));

    const rpcsOff = fs
      .readFileSync(rpcLogOff, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcsOff).toHaveLength(1);
    expect(rpcsOff[0]?.systemPromptAppend).toBeUndefined();

    const promptsOff = fs
      .readFileSync(promptLogOff, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(promptsOff).toEqual([
      {
        sessionId: session.agentSessionId,
        text: 'plain turn',
        systemPromptAppend: null,
      },
    ]);
  });

  it('toggles systemPrompt.append mid-session without respawning and preserves model and mode (PA-185)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sysprompt-toggle-'));
    const pidFile = path.join(dir, 'pid');
    const rpcLog = path.join(dir, 'rpc.jsonl');
    const promptLog = path.join(dir, 'prompt.jsonl');
    let voiceOn = false;

    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_PID_FILE: pidFile,
          AGY_FIXTURE_RPC_LOG: rpcLog,
          AGY_FIXTURE_PROMPT_LOG: promptLog,
        },
        shouldAppendSpokenSummary: () => voiceOn,
      }),
    );
    await session.start();
    const initialPid = fs.readFileSync(pidFile, 'utf8').trim();
    const events = collect(session);

    await session.setModel('claude-sonnet-4-6');
    await session.setMode('plan');

    // Turn 1: voice OFF.
    session.prompt('turn one');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 1);

    // Turn 2: toggle voice ON -> same-process `session/resume` with `_meta` (no `session/close`).
    voiceOn = true;
    session.prompt('turn two');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);

    // Turn 3: toggle voice OFF -> same-process `session/close` + `session/resume` omitting `_meta`.
    voiceOn = false;
    session.prompt('REPORT_MODE');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 3);

    // Single process throughout; no duplicate session_started emitted by voice toggles.
    expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(initialPid);
    expect(events.filter((e) => e.kind === 'session_started')).toHaveLength(0);

    const rpcs = fs
      .readFileSync(rpcLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcs.map((r) => r.method)).toEqual([
      'session/new',
      'session/set_model',
      'session/set_mode',
      'session/resume',
      'session/close',
      'session/resume',
    ]);
    expect(rpcs[0]?.systemPromptAppend).toBeUndefined();
    expect(rpcs[3]?.systemPromptAppend).toBe(SPOKEN_SUMMARY_INSTRUCTION);
    expect(rpcs[5]?.systemPromptAppend).toBeUndefined();

    const prompts = fs
      .readFileSync(promptLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(prompts.map((p) => ({ text: p.text, hasAppend: p.systemPromptAppend === SPOKEN_SUMMARY_INSTRUCTION }))).toEqual([
      { text: 'turn one', hasAppend: false },
      { text: 'turn two', hasAppend: true },
      { text: 'REPORT_MODE', hasAppend: false },
    ]);
    expect(events.some((e) => e.kind === 'text' && e.text === 'echo: turn two model=claude-sonnet-4-6')).toBe(true);
    expect(events.some((e) => e.kind === 'text' && e.text === 'mode=plan')).toBe(true);
  });

  it('never kills a running background task on voice toggle, deferring session/close until idle (PA-185)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sysprompt-bg-'));
    const taskFileOff = path.join(dir, 'task-off.done');
    const rpcLogOff = path.join(dir, 'rpc-off.jsonl');
    const promptLogOff = path.join(dir, 'prompt-off.jsonl');
    let voiceOn = true;

    // 1. ON -> OFF while a background command is running: must NOT send session/close until idle.
    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_BACKGROUND_TASK_FILE: taskFileOff,
          AGY_FIXTURE_RPC_LOG: rpcLogOff,
          AGY_FIXTURE_PROMPT_LOG: promptLogOff,
        },
        shouldAppendSpokenSummary: () => voiceOn,
        reactiveSettleMs: 120,
      }),
    );
    await session.start();
    const eventsOff = collect(session);

    session.prompt('BACKGROUND_TASK');
    await waitFor(() => session!.backgroundCommands.length > 0);
    expect(session.busy).toBe(true);
    expect(eventsOff.some((e) => e.kind === 'turn_complete')).toBe(false);
    expect(fs.existsSync(taskFileOff)).toBe(false);

    // Toggle voice OFF and send another turn while the background task is still running.
    voiceOn = false;
    session.prompt('during bg');
    await waitFor(() => eventsOff.filter((e) => e.kind === 'turn_complete').length === 2);

    // Background task must survive and complete (fake-agy cancels it if session/close ran).
    await waitFor(() => fs.existsSync(taskFileOff), { timeout: 5_000 });
    expect(fs.readFileSync(taskFileOff, 'utf8')).toBe('FINISHED');
    await waitFor(() => session?.busy === false, { timeout: 3_000 });

    // Once idle, the next turn clears systemPrompt.append via session/close + session/resume.
    session.prompt('after bg idle');
    await waitFor(() => eventsOff.filter((e) => e.kind === 'turn_complete').length === 3);

    const rpcsOff = fs
      .readFileSync(rpcLogOff, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcsOff.map((r) => r.method)).toEqual(['session/new', 'session/close', 'session/resume']);

    const promptsOff = fs
      .readFileSync(promptLogOff, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(promptsOff[2]).toMatchObject({ text: 'after bg idle', systemPromptAppend: null });
    session.terminate();

    // 2. OFF -> ON while a background command is running: same-process session/resume (no close)
    // activates systemPrompt.append AND preserves the running background task.
    const taskFileOn = path.join(dir, 'task-on.done');
    const rpcLogOn = path.join(dir, 'rpc-on.jsonl');
    const promptLogOn = path.join(dir, 'prompt-on.jsonl');
    voiceOn = false;

    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_BACKGROUND_TASK_FILE: taskFileOn,
          AGY_FIXTURE_RPC_LOG: rpcLogOn,
          AGY_FIXTURE_PROMPT_LOG: promptLogOn,
        },
        shouldAppendSpokenSummary: () => voiceOn,
        reactiveSettleMs: 120,
      }),
    );
    await session.start();
    const eventsOn = collect(session);

    session.prompt('BACKGROUND_TASK');
    await waitFor(() => session!.backgroundCommands.length > 0);
    expect(session.busy).toBe(true);
    expect(eventsOn.some((e) => e.kind === 'turn_complete')).toBe(false);
    expect(fs.existsSync(taskFileOn)).toBe(false);

    voiceOn = true;
    session.prompt('turn on during bg');
    await waitFor(() => eventsOn.filter((e) => e.kind === 'turn_complete').length === 2);

    await waitFor(() => fs.existsSync(taskFileOn), { timeout: 5_000 });
    expect(fs.readFileSync(taskFileOn, 'utf8')).toBe('FINISHED');

    const rpcsOn = fs
      .readFileSync(rpcLogOn, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcsOn.map((r) => r.method)).toEqual(['session/new', 'session/resume']);
    expect(rpcsOn[1]?.systemPromptAppend).toBe(SPOKEN_SUMMARY_INSTRUCTION);

    const promptsOn = fs
      .readFileSync(promptLogOn, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(promptsOn[1]).toMatchObject({
      text: 'turn on during bg',
      systemPromptAppend: SPOKEN_SUMMARY_INSTRUCTION,
    });
  });

  it('reports supportsSystemPromptAppend=false and skips _meta when agy does not advertise it (PA-185)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sysprompt-unsupported-'));
    const rpcLog = path.join(dir, 'rpc.jsonl');
    const promptLog = path.join(dir, 'prompt.jsonl');

    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_NO_SYSTEM_PROMPT_APPEND: '1',
          AGY_FIXTURE_RPC_LOG: rpcLog,
          AGY_FIXTURE_PROMPT_LOG: promptLog,
        },
        shouldAppendSpokenSummary: () => true,
      }),
    );
    await session.start();
    expect(session.supportsSystemPromptAppend).toBe(false);

    const events = collect(session);
    session.prompt('hello');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const rpcs = fs
      .readFileSync(rpcLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { method: string; systemPromptAppend?: string });
    expect(rpcs).toHaveLength(1);
    expect(rpcs[0]?.systemPromptAppend).toBeUndefined();

    const prompts = fs
      .readFileSync(promptLog, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { text: string; systemPromptAppend: string | null });
    expect(prompts[0]?.systemPromptAppend).toBeNull();
    expect(prompts[0]?.text).toContain(SPOKEN_SUMMARY_INSTRUCTION);
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

  it('computes approvalDisclosure dynamically based on toolPermission (null only under strict)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-disclosure-'));
    const file = path.join(dir, 'settings.json');

    expect(resolveAgyApprovalDisclosure({ settingsPath: path.join(dir, 'missing.json') })).toContain(
      'auto-approves file edits',
    );

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'request-review' }));
    expect(resolveAgyApprovalDisclosure({ settingsPath: file })).toContain('auto-approves file edits');

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'always-proceed' }));
    expect(resolveAgyApprovalDisclosure({ settingsPath: file })).toContain('auto-approves file edits');

    fs.writeFileSync(file, JSON.stringify({ toolPermission: 'strict' }));
    expect(resolveAgyApprovalDisclosure({ settingsPath: file })).toBeNull();

    const notice = formatAgySettingsAutoApproveNotice({
      autoApproves: true,
      toolPermission: 'always-proceed',
      settingsPath: file,
    });
    expect(notice).toContain('"request-review"');
    expect(notice).toContain('"strict"');
  });
});
