import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@pocketagent/protocol';
import { OpencodeServerManager } from '../src/sessions/opencode-server.js';
import { OpencodeSession, type OpencodeSessionSpec } from '../src/sessions/opencode-session.js';
import { waitFor } from './helpers.js';

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-opencode-server.mjs',
);

function makeServer(): OpencodeServerManager {
  return new OpencodeServerManager({
    executablePath: FIXTURE,
    env: process.env,
    cwd: process.cwd(),
  });
}

function makeSpec(overrides: Partial<OpencodeSessionSpec> = {}): OpencodeSessionSpec {
  return {
    id: 'sess_1',
    title: 'opencode · project',
    agent: 'opencode',
    agentDisplayName: 'opencode',
    cwd: process.cwd(),
    workspaceLabel: 'project',
    eventBufferBytes: 1024 * 1024,
    createdAt: Date.now(),
    ...overrides,
  };
}

function collect(session: OpencodeSession): AgentEvent[] {
  const events: AgentEvent[] = [];
  session.on('event', (_seq, event) => events.push(event));
  return events;
}

describe('OpencodeServerManager', () => {
  let server: OpencodeServerManager | null = null;
  afterEach(() => {
    server?.dispose();
    server = null;
  });

  it('spawns the fixture and learns its port from the listening line', async () => {
    server = makeServer();
    const baseUrl = await server.ensureStarted();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('reuses the same server across multiple ensureStarted calls', async () => {
    server = makeServer();
    const a = await server.ensureStarted();
    const b = await server.ensureStarted();
    expect(a).toBe(b);
  });

  it('request() round-trips JSON through the fixture', async () => {
    server = makeServer();
    const info = await server.request<{ id: string }>('/session', {
      method: 'POST',
      query: { directory: '/tmp' },
      body: { title: 'hi' },
    });
    expect(info.id).toMatch(/^ses_test/);
  });

  it('emits "crashed" when the process dies after startup, not during spawn', async () => {
    server = makeServer();
    await server.ensureStarted();
    const crashed = new Promise<void>((resolve) => server?.once('crashed', resolve));
    // Reach into the fixture and kill it out from under the manager.
    await server.request('/session', { method: 'POST', query: { directory: '/tmp' }, body: {} });
    process.kill(
      // @ts-expect-error -- reaching in for the test only; there is no public accessor for this.
      server['child'].pid,
      'SIGKILL',
    );
    await crashed;
  });
});

describe('OpencodeSession', () => {
  let server: OpencodeServerManager | null = null;
  let session: OpencodeSession | null = null;

  afterEach(() => {
    session?.terminate();
    server?.dispose();
    session = null;
    server = null;
  });

  it('creates the opencode-side session on start() and emits session_started immediately', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
    await session.start();
    expect(session.status).toBe('running');
    expect(session.agentSessionId).toMatch(/^ses_test/);
  });

  it('runs one turn end to end: user_prompt, tool_use/result, text, turn_complete with usage', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    expect(session.prompt('hello')).toBe(true);
    expect(session.busy).toBe(true);
    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'hello' });

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['user_prompt', 'tool_use', 'tool_result', 'text', 'turn_complete']),
    );
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ name: 'bash', summary: 'Run echo hi' });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ content: 'hi\n', isError: false });
    expect(events.find((e) => e.kind === 'text')).toMatchObject({ text: 'echo: hello' });
    // The turn_complete's usage is patched in from a separate message.updated
    // event by OpencodeSession itself — session.idle alone carries none.
    expect(events.find((e) => e.kind === 'turn_complete')).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    });
    await waitFor(() => session?.busy === false);
  });

  it('surfaces a real permission request and only completes after it is replied to', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'permission_request'));
    expect(session.pendingPermissions()).toHaveLength(1);

    // The fixture's turn is genuinely blocked on this — it only proceeds once
    // the reply lands, same contract as opencode's own documented API.
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);

    const request = events.find((e) => e.kind === 'permission_request');
    expect(session.resolvePermission(request!.id, 'allow')).toBe(true);
    expect(session.pendingPermissions()).toHaveLength(0);

    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));
    expect(events.some((e) => e.kind === 'tool_result')).toBe(true);
  });

  it('auto-bypasses permissions when skipPermissions is set, never surfacing them', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec({ skipPermissions: true }), server);
    await session.start();
    const events = collect(session);

    session.prompt('NEEDS_PERMISSION');
    await waitFor(() => events.some((e) => e.kind === 'turn_complete'));

    expect(events.some((e) => e.kind === 'permission_request')).toBe(false);
    expect(session.pendingPermissions()).toHaveLength(0);
  });

  it('drains pending permissions once the global bypass switch is turned on', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
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
    session = new OpencodeSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('SLOW');
    await waitFor(() => events.some((e) => e.kind === 'tool_use'));

    await session.interrupt();
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.text === 'Interrupted.'));

    expect(session.isAlive()).toBe(true);
    expect(events.some((e) => e.kind === 'turn_complete')).toBe(false);
  });

  it('surfaces session.error as a notice instead of crashing the session', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
    await session.start();
    const events = collect(session);

    session.prompt('FAIL');
    await waitFor(() => events.some((e) => e.kind === 'notice' && e.level === 'error'));

    expect(session.isAlive()).toBe(true);
    expect(events.find((e) => e.kind === 'notice')).toMatchObject({ text: 'simulated failure' });
    await waitFor(() => session?.busy === false);
  });

  it('terminate() marks the session killed and refuses further prompts', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
    await session.start();

    session.terminate();
    expect(session.status).toBe('killed');
    expect(session.isAlive()).toBe(false);
    expect(session.prompt('too late')).toBe(false);
  });

  it('markServerCrashed ends the session and clears pending permissions', async () => {
    server = makeServer();
    session = new OpencodeSession(makeSpec(), server);
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
