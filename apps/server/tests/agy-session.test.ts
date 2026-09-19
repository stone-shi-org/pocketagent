import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('starts running immediately with no process yet, since the child is spawned by the first prompt', async () => {
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

  it('emits model_changed at start and populates session_started when initial model is specified', async () => {
    session = new AgySession(makeSpec({ model: 'claude-sonnet-4-6' }));
    const events = collect(session);
    await session.start();

    expect(events.some((e) => e.kind === 'model_changed' && e.model === 'claude-sonnet-4-6')).toBe(true);

    session.prompt('hello');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const sessionStarted = events.find((e) => e.kind === 'session_started');
    expect(sessionStarted).toMatchObject({
      kind: 'session_started',
      model: 'claude-sonnet-4-6',
    });

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

  /**
   * The regression this whole process model exists for.
   *
   * agy's `run_command` converts any command still running past
   * `WaitMsBeforeAsync` into a background task, and the model will happily
   * end its turn while one is still `RUNNING` ("waiting for the tests to
   * finish"). Under the per-turn `agy -p` process this replaced, the turn
   * ending exited agy, which cancelled the task — "Cancelling steps [614] /
   * CLI store manager shutting down" in agy's own log, a 2-minute `pnpm test`
   * killed 71s in, and a session left idle insisting it was still waiting.
   *
   * The fixture's stand-in is a timer that can only fire if the process is
   * still alive after the turn, so this fails the moment anything goes back
   * to ending the process per turn.
   */
  it('keeps a background task running after the turn that started it completes', async () => {
    const taskFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bg-')), 'task.done');
    session = new AgySession(
      makeSpec({
        env: {
          ...(process.env as Record<string, string>),
          AGY_FIXTURE_BACKGROUND_TASK_FILE: taskFile,
        },
      }),
    );
    await session.start();
    const events = collect(session);

    session.prompt('BACKGROUND_TASK');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    await waitFor(() => session?.busy === false);
    // The turn is genuinely over and the session genuinely idle before the
    // task has finished — this is exactly the window that used to kill it.
    expect(fs.existsSync(taskFile)).toBe(false);

    await waitFor(() => fs.existsSync(taskFile), { timeout: 5_000 });
    expect(fs.readFileSync(taskFile, 'utf8')).toBe('FINISHED');

    // And the conversation is still there to be asked about the result.
    session.prompt('and?');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);
    expect(session.isAlive()).toBe(true);
  }, 15_000);

  /**
   * agy reports its `result` figures cumulatively over the conversation once
   * one process serves several turns (see `AgySession.cumulative`), so each
   * turn's footer has to be handed its own share — otherwise duration, token
   * counts and tok/s all grow without bound from the second turn on.
   */
  it('reports per-turn stats, not the conversation totals agy actually sends', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('first');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    session.prompt('second');
    await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);

    const [first, second] = events.filter((e) => e.kind === 'turn_complete');
    // The fixture adds 10/5/1 per turn and reports the running total, so the
    // second turn arrives as 20/10/2 on the wire and must still read as its
    // own 10/5/1 here.
    expect(first).toMatchObject({ inputTokens: 10, outputTokens: 5, numTurns: 1 });
    expect(second).toMatchObject({ inputTokens: 10, outputTokens: 5, numTurns: 1 });

    // Likewise the duration: the fixture claims a total 30s then 60s, and
    // both turns really took milliseconds.
    for (const turn of [first, second]) {
      expect(turn).toMatchObject({ isError: false });
      const durationMs = (turn as { durationMs: number | null }).durationMs;
      expect(durationMs).not.toBeNull();
      expect(durationMs as number).toBeLessThan(30_000);
    }
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

  it('surfaces agy\'s own result.error (e.g. a quota failure) instead of the generic exit-code notice', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('QUOTA');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const notices = events.filter((e) => e.kind === 'notice' && e.level === 'error');
    // Exactly one notice: the real reason from `result.error`, not a second
    // generic "agy exited with code 1" piled on top of it.
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      text: 'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).',
    });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: true, stopReason: 'ERROR' });
    await waitFor(() => session?.busy === false);
  });

  /**
   * The regression test for the bug that made agy effectively unusable:
   * spawning it with `{ cwd }` does not make it *work* in that directory.
   * agy resolves its workspace from its own project registry, independently
   * of the process cwd, and with no `--add-dir` it silently operates in the
   * default project's scratch directory
   * (`~/.gemini/antigravity-cli/scratch`) — reproduced against v1.1.22
   * outside PocketAgent entirely. See `AgySession.baseArgs`.
   *
   * Asserted on argv rather than behaviour because there is nothing in
   * agy's event stream that reports the workspace it chose: its `init` line
   * carries only `cwd`/`tools`/`permission_mode`, and its `cwd` echoes the
   * OS cwd faithfully even when the workspace is wrong.
   */
  describe('--add-dir (binds agy to the session directory, not its own scratch project)', () => {
    /** Reads back every invocation's argv recorded by the fixture. */
    function argvLog(file: string): string[][] {
      if (!fs.existsSync(file)) return [];
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as string[]);
    }

    function specWithArgvLog(file: string, overrides: Partial<AgySessionSpec> = {}) {
      return makeSpec({
        env: { ...(process.env as Record<string, string>), AGY_FIXTURE_ARGV_FILE: file },
        ...overrides,
      });
    }

    let argvFile: string;
    beforeEach(() => {
      argvFile = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'agy-argv-')),
        'argv.jsonl',
      );
    });

    /** Every `--add-dir` value present in one invocation's argv. */
    function addDirs(argv: string[]): string[] {
      return argv.filter((_a, i) => argv[i - 1] === '--add-dir');
    }

    /**
     * Just the session's own long-lived children — not the startup `/help`
     * probe or the `models` subcommand, which are separate one-shot
     * invocations and have no `--input-format`.
     */
    function streamChildren(file: string): string[][] {
      return argvLog(file).filter((argv) => argv.includes('--input-format'));
    }

    it('passes --add-dir <spec.cwd> when it spawns the session child', async () => {
      session = new AgySession(specWithArgvLog(argvFile));
      await session.start();
      const events = collect(session);

      session.prompt('hello');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

      const [child] = streamChildren(argvFile);
      expect(child).toBeDefined();
      expect(addDirs(child as string[])).toEqual([session.spec.cwd]);
      // The prompt travels on stdin, never in argv — `--input-format
      // stream-json` rejects a prompt given on the command line outright.
      expect(child).not.toContain('hello');
    });

    /**
     * The core guarantee of the long-lived process, asserted on argv because
     * that is the only place a second spawn would show up: two turns must be
     * served by *one* child. A per-turn respawn is what cancelled agy's
     * background tasks between turns (see `AgySession`'s class doc comment),
     * so a regression here is that bug returning.
     */
    it('serves consecutive turns from one child rather than respawning per turn', async () => {
      session = new AgySession(specWithArgvLog(argvFile));
      await session.start();
      const events = collect(session);

      session.prompt('first');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
      session.prompt('second');
      await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);

      expect(streamChildren(argvFile)).toHaveLength(1);
    });

    /**
     * A resumed session's child has to carry both flags: `--conversation` to
     * continue the transcript, and `--add-dir` so it does so in the session's
     * own directory rather than agy's scratch project.
     */
    it('passes --add-dir alongside --conversation when resuming a conversation', async () => {
      session = new AgySession(
        specWithArgvLog(argvFile, { resumeAgentSessionId: 'prior-conversation-id' }),
      );
      await session.start();
      const events = collect(session);

      session.prompt('hello');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

      const [child] = streamChildren(argvFile);
      expect(child).toBeDefined();
      expect(addDirs(child as string[])).toEqual([session.spec.cwd]);
      expect(child).toContain('--conversation');
      expect(child).toContain('prior-conversation-id');
    });

    /**
     * Workspace-local slash commands and skills live under the workspace, so
     * the startup `/help` probe has to ask about the session's own directory
     * — otherwise the picker lists the scratch project's commands.
     */
    it('passes --add-dir on the startup /help probe too', async () => {
      session = new AgySession(specWithArgvLog(argvFile));
      const events = collect(session);
      await session.start();

      await waitFor(() => events.some((e) => e.kind === 'commands_available'));

      const help = argvLog(argvFile).find((argv) => argv.includes('/help'));
      expect(help).toBeDefined();
      expect(addDirs(help as string[])).toEqual([session.spec.cwd]);
    });

    it('points --add-dir at the session\'s configured cwd, not the server\'s process cwd', async () => {
      const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-'));
      session = new AgySession(specWithArgvLog(argvFile, { cwd: projectDir }));
      await session.start();
      const events = collect(session);

      session.prompt('hello');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

      const [child] = streamChildren(argvFile);
      expect(addDirs(child as string[])).toEqual([projectDir]);
      expect(projectDir).not.toBe(process.cwd());
    });

    /**
     * agy answers its own slash commands inside the CLI and refuses them on
     * the stream-json input, so they have to go out as their own `--print`
     * invocation — carrying the session's conversation so `/model` and
     * friends act on the right one.
     */
    it('routes a slash command to a one-shot --print invocation, not the live child', async () => {
      session = new AgySession(specWithArgvLog(argvFile));
      await session.start();
      const events = collect(session);

      session.prompt('hello');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
      session.prompt('/model gemini-3.6-flash-high');
      await waitFor(() => events.filter((e) => e.kind === 'turn_complete').length === 2);

      const slash = argvLog(argvFile).find((argv) => argv.includes('/model gemini-3.6-flash-high'));
      expect(slash).toBeDefined();
      expect(slash).not.toContain('--input-format');
      expect(slash).toContain('--conversation');
      // The live child is untouched by it — still one, still the same one.
      expect(streamChildren(argvFile)).toHaveLength(1);
      expect(session.isAlive()).toBe(true);
    });

    /**
     * A prompt that merely *starts* with a path must not be mistaken for a
     * slash command: routing it to a one-shot process would quietly lose the
     * background-task guarantee, which is the same class of bug as the one
     * the long-lived child exists to fix.
     */
    it('treats a leading absolute path as an ordinary prompt, not a slash command', async () => {
      session = new AgySession(specWithArgvLog(argvFile));
      await session.start();
      const events = collect(session);

      session.prompt('/data/homes/x please review');
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

      expect(streamChildren(argvFile)).toHaveLength(1);
      expect(argvLog(argvFile).some((argv) => argv.includes('/data/homes/x please review'))).toBe(false);
    });
  });

  it('silently retries a transient error (e.g. a backend timeout) and succeeds without surfacing it as a failure', async () => {
    const stateFile = path.join(os.tmpdir(), `agy-timeout-once-${crypto.randomUUID()}.state`);
    session = new AgySession(
      makeSpec({ env: { ...process.env, AGY_FIXTURE_TIMEOUT_ONCE_FILE: stateFile } as Record<string, string> }),
    );
    await session.start();
    const events = collect(session);

    session.prompt('TIMEOUT_ONCE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    // A warning about the retry, never an error notice — the retry papered
    // over the failure before the user ever saw it as one.
    expect(events.some((e) => e.kind === 'notice' && e.level === 'error')).toBe(false);
    const warnings = events.filter((e) => e.kind === 'notice' && e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ text: expect.stringContaining('timeout waiting for response') });

    const turnComplete = events.find((e) => e.kind === 'turn_complete');
    expect(turnComplete).toMatchObject({ isError: false });
    const text = events.find((e) => e.kind === 'text');
    expect(text).toMatchObject({ text: 'echo: TIMEOUT_ONCE' });

    fs.rmSync(stateFile, { force: true });
    await waitFor(() => session?.busy === false);
  });

  it('silently retries a context canceled error and succeeds without surfacing it as a failure', async () => {
    const stateFile = path.join(os.tmpdir(), `agy-canceled-once-${crypto.randomUUID()}.state`);
    session = new AgySession(
      makeSpec({ env: { ...process.env, AGY_FIXTURE_TIMEOUT_ONCE_FILE: stateFile } as Record<string, string> }),
    );
    await session.start();
    const events = collect(session);

    session.prompt('CONTEXT_CANCELED_ONCE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'notice' && e.level === 'error')).toBe(false);
    const warnings = events.filter((e) => e.kind === 'notice' && e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ text: expect.stringContaining('context canceled') });

    const turnComplete = events.find((e) => e.kind === 'turn_complete');
    expect(turnComplete).toMatchObject({ isError: false });

    fs.rmSync(stateFile, { force: true });
    await waitFor(() => session?.busy === false);
  });

  it('silently retries a stream interrupted error and succeeds without surfacing it as a failure', async () => {
    const stateFile = path.join(os.tmpdir(), `agy-interrupted-once-${crypto.randomUUID()}.state`);
    session = new AgySession(
      makeSpec({ env: { ...process.env, AGY_FIXTURE_TIMEOUT_ONCE_FILE: stateFile } as Record<string, string> }),
    );
    await session.start();
    const events = collect(session);

    session.prompt('STREAM_INTERRUPTED_ONCE');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'notice' && e.level === 'error')).toBe(false);
    const warnings = events.filter((e) => e.kind === 'notice' && e.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ text: expect.stringContaining('stream was interrupted') });

    const turnComplete = events.find((e) => e.kind === 'turn_complete');
    expect(turnComplete).toMatchObject({ isError: false });

    fs.rmSync(stateFile, { force: true });
    await waitFor(() => session?.busy === false);
  });

  it('drops a permanently wedged conversation and retries fresh once the normal retry budget is spent', async () => {
    session = new AgySession(makeSpec({ resumeAgentSessionId: 'stuck-conversation-id' }));
    await session.start();
    const events = collect(session);

    session.prompt('WEDGED_CONVERSATION');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'), { timeout: 15_000 });

    // Never shown as a failure: the two normal retries against the stuck
    // conversation, then the one conversation-reset retry against a fresh
    // one, all stay warnings.
    expect(events.some((e) => e.kind === 'notice' && e.level === 'error')).toBe(false);
    const warnings = events.filter((e) => e.kind === 'notice' && e.level === 'warn');
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatchObject({ text: expect.stringContaining('context canceled') });
    expect(warnings[1]).toMatchObject({ text: expect.stringContaining('context canceled') });
    expect(warnings[2]).toMatchObject({ text: expect.stringContaining('new conversation') });

    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: false });
    const text = events.find((e) => e.kind === 'text');
    expect(text).toMatchObject({ text: 'echo: WEDGED_CONVERSATION' });

    // The wedged id was actually replaced, not just papered over for this
    // one turn — later turns must not keep hitting the same dead end.
    expect(session.agentSessionId).not.toBe('stuck-conversation-id');
    await waitFor(() => session?.busy === false);
  }, 20_000);

  it('gives up after exhausting retry budget on a persistent transient-looking error', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('TIMEOUT_ALWAYS');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'), { timeout: 15_000 });

    const warnings = events.filter((e) => e.kind === 'notice' && e.level === 'warn');
    // Two retries attempted (the class's `MAX_TURN_RETRIES`), each warned
    // about, before the final attempt's failure is shown for real.
    expect(warnings).toHaveLength(2);

    const errors = events.filter((e) => e.kind === 'notice' && e.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ text: 'timeout waiting for response' });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: true });
    await waitFor(() => session?.busy === false);
  }, 20_000);

  it('interrupt() during a retry backoff cancels the pending retry instead of silently doing nothing', async () => {
    session = new AgySession(makeSpec());
    await session.start();
    const events = collect(session);

    session.prompt('TIMEOUT_ALWAYS');
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.level === 'warn'));

    await session.interrupt();
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.'));

    // Cancelled before a second attempt could spawn: only the one warning
    // from the first failed attempt, no eventual turn_complete/error.
    expect(events.filter((e) => e.kind === 'notice' && e.level === 'warn')).toHaveLength(1);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
    expect(session.isAlive()).toBe(true);
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
