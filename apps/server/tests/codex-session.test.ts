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
});
