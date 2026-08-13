import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { CodexServerManager } from '../src/sessions/codex-server.js';
import { CodexSession, type CodexSessionSpec } from '../src/sessions/codex-session.js';
import { waitFor } from './helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-codex-app-server.mjs',
);

function makeServer(): CodexServerManager {
  return new CodexServerManager({ executablePath: FIXTURE, env: process.env, cwd: process.cwd() });
}

function makeSpec(overrides: Partial<CodexSessionSpec> = {}): CodexSessionSpec {
  return {
    id: 'sess_1',
    title: 'Codex · project',
    agent: 'codex',
    agentDisplayName: 'Codex',
    cwd: process.cwd(),
    workspaceLabel: 'project',
    eventBufferBytes: 1024 * 1024,
    createdAt: Date.now(),
    ...overrides,
  };
}

function collect(session: CodexSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.on('event', (_seq, event) => events.push(event));
  return events;
}

describe('CodexServerManager', () => {
  let server: CodexServerManager | null = null;
  afterEach(() => {
    server?.dispose();
    server = null;
  });

  it('spawns the fixture and completes the initialize handshake', async () => {
    server = makeServer();
    await expect(server.ensureStarted()).resolves.toBeUndefined();
  });

  it('reuses the same process across multiple ensureStarted calls', async () => {
    server = makeServer();
    await server.ensureStarted();
    const first = await server.sendRequest('thread/start', { cwd: '/tmp' });
    await server.ensureStarted();
    const second = await server.sendRequest('thread/start', { cwd: '/tmp' });
    expect(first).not.toEqual(second); // Two independent threads, same process.
  });

  it('emits "crashed" when the process dies after startup', async () => {
    server = makeServer();
    await server.ensureStarted();
    const crashed = new Promise<void>((resolve) => server?.once('crashed', resolve));
    // @ts-expect-error -- reaching in for the test only; there is no public accessor for this.
    const pid = server['child']?.pid;
    expect(pid).toBeTypeOf('number');
    process.kill(pid, 'SIGKILL');
    await crashed;
  });
});

describe('CodexSession', () => {
  let server: CodexServerManager | null = null;
  let session: CodexSession | null = null;

  afterEach(() => {
    session?.terminate();
    server?.dispose();
    session = null;
    server = null;
  });

  it('starts a thread on start() and emits session_started immediately', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    expect(session.status).toBe('running');
    expect(session.agentSessionId).toMatch(/^thread_test/);
  });

  it('runs one turn end to end: user_prompt, tool_use/result, text, turn_complete with usage', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    expect(session.prompt('hello')).toBe(true);
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'hello' });

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'commandExecution', summary: 'Run echo hi' });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ content: 'hi\n', isError: false });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'echo: hello' });
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    await waitFor(() => session?.busy === false);
  });

  it('surfaces a real approval request and only completes after it is replied to', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'permission_request'));
    expect(session.pendingPermissions()).toHaveLength(1);

    // Genuinely blocked on this, same contract as opencode's permission gate.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);

    const request = events.find((e) => e.kind === 'permission_request');
    expect(session.resolvePermission(request!.id, 'allow')).toBe(true);
    expect(session.pendingPermissions()).toHaveLength(0);

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.some((e) => e.kind === 'tool_result' && !e.isError)).toBe(true);
  });

  it('surfaces a decline as an error tool_result instead of completing the command', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'permission_request'));
    const request = events.find((e) => e.kind === 'permission_request');
    session.resolvePermission(request!.id, 'deny');

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: true, content: 'declined' });
  });

  it('auto-bypasses approvals when skipPermissions is set, never surfacing them', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec({ skipPermissions: true }), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ isError: false });
  });

  it('drains pending approvals once the global bypass switch is turned on', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'permission_request'));

    await session.applyGlobalSkipPermissions(true);
    expect(session.pendingPermissions()).toHaveLength(0);
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
  });

  it('interrupt() aborts an in-flight turn without ending the session', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('SLOW');
    await waitFor(() => events.some((e) => e.kind === 'tool_use'));

    await session.interrupt();
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.'));

    expect(session.isAlive()).toBe(true);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
  });

  it('surfaces a thread error as a notice instead of crashing the session', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('FAIL');
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.level === 'error'));

    expect(session.isAlive()).toBe(true);
    expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: 'simulated failure' });
  });

  it('terminate() marks the session killed and refuses further prompts', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();

    session.terminate();
    expect(session.status).toBe('killed');
    expect(session.isAlive()).toBe(false);
    expect(session.prompt('too late')).toBe(false);
  });

  it('markServerCrashed ends the session and clears pending approvals', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'permission_request'));

    let exited = false;
    session.on('exit', () => (exited = true));
    session.markServerCrashed();

    expect(session.status).toBe('error');
    expect(session.isAlive()).toBe(false);
    expect(session.pendingPermissions()).toHaveLength(0);
    expect(exited).toBe(true);
  });

  it('emits commands_available with the hand-mapped slash-command table right after session_started', async () => {
    server = makeServer();
    session = new CodexSession(makeSpec(), server);
    const events = collect(session);
    await session.start();

    const commandsEvent = events.find((e) => e.kind === 'commands_available');
    expect(commandsEvent?.kind).toBe('commands_available');
    const names = commandsEvent && commandsEvent.kind === 'commands_available' ? commandsEvent.commands.map((c) => c.name) : [];
    expect(names).toEqual(
      expect.arrayContaining(['status', 'model', 'skills', 'hooks', 'mcp', 'permissions', 'ps', 'usage', 'plugins', 'compact', 'rename', 'review', 'goal', 'memories', 'archive', 'delete', 'logout']),
    );
    // Deliberately excluded: pure TUI/composer settings and multi-session
    // navigation commands — see `dispatchSlashCommand`'s doc comment.
    expect(names).not.toEqual(expect.arrayContaining(['vim', 'theme', 'exit', 'new', 'resume']));
  });

  describe('slash commands', () => {
    it('/status resolves via thread/read without touching turn/start, as a command_output', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      expect(session.prompt('/status')).toBe(true);
      expect(events[0]).toMatchObject({ kind: 'user_prompt', text: '/status' });
      await waitFor(() => events.some((e) => e.kind === 'command_output'));

      const output = events.find((e) => e.kind === 'command_output');
      expect(output).toMatchObject({ text: expect.stringContaining('Test thread') });
      const text = output && output.kind === 'command_output' ? output.text : '';
      expect(text).toContain('git branch: main');
      // `status` is a tagged object (`{ type: 'active', ... }`) in the real
      // protocol, not a plain string — regression coverage for a live bug
      // where this silently printed "unknown" instead of "active".
      expect(text).toContain('status:     active');
      // No real turn ran (never touched `turn/start`), but a synthetic,
      // all-null `turn_complete` still follows — that is what clears the
      // browser's "three dots" busy indicator, which is armed by
      // `user_prompt` and disarmed only by `turn_complete`. Without it, a
      // live `/status` left the indicator spinning forever.
      expect(session.busy).toBe(false);
      expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ isError: false, durationMs: null, inputTokens: null });
    });

    it('/model lists models formatted with id, default marker, and description', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/model');
      await waitFor(() => events.some((e) => e.kind === 'command_output'));
      const output = events.find((e) => e.kind === 'command_output');
      const text = output && output.kind === 'command_output' ? output.text : '';
      expect(text).toContain('gpt-5.6-terra (default)');
      expect(text).toContain('gpt-5.6-fast');
      expect(text).not.toContain('gpt-5.6-fast (default)');
    });

    it('/mcp, /skills, /hooks, /permissions, /ps, /usage, /plugins each resolve to a command_output', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();

      for (const [command, expectedSubstring] of [
        ['/mcp', 'filesystem'],
        ['/skills', 'commit-helper'],
        ['/hooks', 'pre-commit'],
        ['/permissions', 'default'],
        ['/ps', 'npm run dev'],
        ['/usage', '123456'],
        ['/plugins', 'official'],
      ] as const) {
        const events = collect(session);
        session.prompt(command);
        await waitFor(() => events.some((e) => e.kind === 'command_output'));
        const output = events.find((e) => e.kind === 'command_output');
        expect(output && output.kind === 'command_output' ? output.text : '').toContain(expectedSubstring);
      }
    });

    it('/compact and /rename resolve to a success notice, not a command_output, each still followed by a synthetic turn_complete', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/compact');
      await waitFor(() => events.some((e) => e.kind === 'notice' && e.text.includes('Compacting')));

      session.prompt('/rename my thread');
      await waitFor(() => events.some((e) => e.kind === 'notice' && e.text.includes('Renamed thread to "my thread"')));

      // One synthetic turn_complete per slash command, not zero and not one
      // shared — each dismisses its own `user_prompt`'s busy indicator.
      expect(events.filter((e) => e.kind === 'turn_complete')).toHaveLength(2);
      expect(events.some((e) => e.kind === 'command_output')).toBe(false);
    });

    it('/rename with no argument reports usage instead of calling the RPC', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/rename');
      await waitFor(() => events.some((e) => e.kind === 'notice'));
      expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: 'Usage: /rename <name>' });
    });

    it('/goal with no argument reports "no goal set" when the fixture has none', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/goal');
      await waitFor(() => events.some((e) => e.kind === 'command_output'));
      expect(events.find((e) => e.kind === 'command_output')).toMatchObject({ text: expect.stringContaining('No goal set') });
    });

    it('/memories with an invalid mode reports usage instead of guessing', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/memories sideways');
      await waitFor(() => events.some((e) => e.kind === 'notice'));
      expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: 'Usage: /memories enabled|disabled|reset' });
    });

    it('/review runs as a real turn on the same thread (busy until the real turn_complete), unlike the other commands\' synthetic one', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/review');
      // Busy synchronously, before any RPC round-trip even resolves — unlike
      // `runSlashCommand`'s commands, which only go busy for the duration of
      // one await.
      expect(session.busy).toBe(true);
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

      expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'Looks fine.' });
      expect(events.some((e) => e.kind === 'command_output')).toBe(false);
      // The real turn's own `turn/completed` carries a duration; the
      // synthetic one `runSlashCommand` emits for every other command never
      // does — this is what tells the two apart.
      expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({ durationMs: 5 });
      await waitFor(() => session?.busy === false);
    });

    it('/archive ends the session after a successful thread/archive', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/archive');
      await waitFor(() => session?.status === 'killed');
      expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: expect.stringContaining('archived') });
      expect(session.isAlive()).toBe(false);
    });

    it('an unrecognized slash command still falls through to a real turn, unchanged from before this feature', async () => {
      server = makeServer();
      session = new CodexSession(makeSpec(), server);
      await session.start();
      const events = collect(session);

      session.prompt('/vim');
      expect(session.busy).toBe(true);
      await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
      expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'echo: /vim' });
    });

    it('/diff shells out to git directly (no app-server RPC) and reports tracked and untracked changes', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-codex-diff-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\n');
        fs.writeFileSync(path.join(repo, 'new-file.txt'), 'brand new\n');

        server = makeServer();
        session = new CodexSession(makeSpec({ cwd: repo }), server);
        await session.start();
        const events = collect(session);

        session.prompt('/diff');
        await waitFor(() => events.some((e) => e.kind === 'command_output'));
        const text = events.find((e) => e.kind === 'command_output');
        const diff = text && text.kind === 'command_output' ? text.text : '';
        expect(diff).toContain('tracked.txt');
        expect(diff).toContain('+two');
        expect(diff).toContain('new-file.txt');
        expect(diff).toContain('+brand new');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('/diff reports "No changes." for a clean working tree', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-codex-diff-clean-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: repo });
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
        fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
        execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repo });

        server = makeServer();
        session = new CodexSession(makeSpec({ cwd: repo }), server);
        await session.start();
        const events = collect(session);

        session.prompt('/diff');
        await waitFor(() => events.some((e) => e.kind === 'command_output'));
        expect(events.find((e) => e.kind === 'command_output')).toMatchObject({ text: 'No changes.' });
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('a slash-command RPC failure surfaces as an error notice instead of crashing the session', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-codex-diff-notgit-'));
      try {
        // No `git init` — `/diff` should fail cleanly, not throw uncaught.
        server = makeServer();
        session = new CodexSession(makeSpec({ cwd: repo }), server);
        await session.start();
        const events = collect(session);

        session.prompt('/diff');
        await waitFor(() => events.some((e) => e.kind === 'notice' && e.level === 'error'));
        expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: expect.stringContaining('/diff failed') });
        expect(session.isAlive()).toBe(true);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
