import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage, SessionInfo } from '@pocketagent/protocol';
import {
  TerminalConnection,
  type ConnectionState,
  type TerminalConnectionHandlers,
} from './ws-client.js';

/** Minimal scriptable WebSocket stand-in. */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  // --- test helpers ---
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  parsedSent(): unknown[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

const SESSION: SessionInfo = {
  id: 'abc',
  title: 'Shell · demo',
  agent: 'shell',
  agentDisplayName: 'Shell',
  cwd: '/home/me/src/demo',
  workspaceLabel: 'src/demo',
  status: 'running',
  cols: 80,
  rows: 24,
  pid: 123,
  exitCode: null,
  exitSignal: null,
  createdAt: 1,
  startedAt: 1,
  endedAt: null,
  lastActivityAt: 1,
  attachedClients: 1,
  epoch: 'epoch-1',
  backend: 'direct',
  transport: 'terminal',
  agentSessionId: null,
  durable: false,
  adopted: false,
  skipPermissionsEnabled: false,
};

function setup(handlers: TerminalConnectionHandlers = {}) {
  FakeSocket.instances = [];
  const connection = new TerminalConnection({
    handlers,
    createSocket: (url) => new FakeSocket(url) as unknown as WebSocket,
    baseDelayMs: 100,
    maxDelayMs: 1000,
    random: () => 0.5,
  });
  return {
    connection,
    socket: (index = 0): FakeSocket => FakeSocket.instances[index]!,
    socketCount: (): number => FakeSocket.instances.length,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  // The client builds its URL from window.location.
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost:8787' } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TerminalConnection: connection state', () => {
  it('reports connecting then connected', () => {
    const states: ConnectionState[] = [];
    const { connection, socket } = setup({ onConnectionState: (s) => states.push(s) });

    connection.open('abc');
    expect(states).toEqual(['connecting']);

    socket().open();
    expect(states).toEqual(['connecting', 'connected']);
    expect(connection.getState()).toBe('connected');
  });

  it('sends an attach frame carrying the last sequence number on open', () => {
    const { connection, socket } = setup();
    connection.open('abc', { cols: 100, rows: 30 });
    socket().open();

    expect(socket().parsedSent()[0]).toEqual({
      type: 'attach',
      sessionId: 'abc',
      afterSeq: 0,
      cols: 100,
      rows: 30,
    });
  });

  it('goes to reconnecting on an unexpected drop and retries', () => {
    const states: ConnectionState[] = [];
    const { connection, socket, socketCount } = setup({ onConnectionState: (s) => states.push(s) });

    connection.open('abc');
    socket().open();
    socket().drop();

    expect(connection.getState()).toBe('reconnecting');
    expect(socketCount()).toBe(1);

    vi.advanceTimersByTime(200);
    expect(socketCount()).toBe(2);
  });

  it('backs off exponentially across consecutive failures, up to the cap', () => {
    const { connection, socket, socketCount } = setup();
    connection.open('abc');

    const delays: number[] = [];
    // Never open these sockets: an attempt that never succeeds is what makes
    // the backoff grow. A successful open deliberately resets it.
    for (let i = 0; i < 8; i++) {
      socket(socketCount() - 1).drop();

      let waited = 0;
      const before = socketCount();
      while (socketCount() === before && waited < 5000) {
        vi.advanceTimersByTime(5);
        waited += 5;
      }
      delays.push(waited);
    }

    expect(delays[0]!).toBeLessThan(delays[3]!);
    expect(delays[3]!).toBeLessThanOrEqual(delays[7]!);
    // Bounded: never waits longer than maxDelayMs (plus one poll step).
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(1005);
  });

  it('resets the backoff after a successful connection', () => {
    const { connection, socket, socketCount } = setup();
    connection.open('abc');

    // Fail several times so the delay grows.
    for (let i = 0; i < 4; i++) {
      socket(socketCount() - 1).drop();
      vi.advanceTimersByTime(2000);
    }
    const afterFailures = socketCount();

    // A good connection, then a drop, should retry quickly again.
    socket(afterFailures - 1).open();
    socket(afterFailures - 1).drop();
    vi.advanceTimersByTime(100);

    expect(socketCount()).toBe(afterFailures + 1);
  });

  it('stops reconnecting once closed by the user', () => {
    const { connection, socket, socketCount } = setup();
    connection.open('abc');
    socket().open();

    connection.close();
    expect(connection.getState()).toBe('disconnected');

    vi.advanceTimersByTime(10_000);
    expect(socketCount()).toBe(1);
  });

  it('sends detach before closing so the server frees the reference promptly', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    connection.close();

    expect(socket().parsedSent()).toContainEqual({ type: 'detach', sessionId: 'abc' });
  });
});

describe('TerminalConnection: sequence tracking', () => {
  it('advances lastSeq as output arrives', () => {
    const received: string[] = [];
    const { connection, socket } = setup({ onOutput: (d) => received.push(d) });
    connection.open('abc');
    socket().open();

    socket().emit({ type: 'output', sessionId: 'abc', seq: 1, data: 'a' });
    socket().emit({ type: 'output', sessionId: 'abc', seq: 2, data: 'b' });

    expect(received).toEqual(['a', 'b']);
    expect(connection.getLastSeq()).toBe(2);
  });

  it('drops duplicates from the attach/subscribe overlap', () => {
    const received: string[] = [];
    const { connection, socket } = setup({ onOutput: (d) => received.push(d) });
    connection.open('abc');
    socket().open();

    socket().emit({ type: 'output', sessionId: 'abc', seq: 5, data: 'five' });
    // The server re-sends 3, 4 and 5 — all already rendered.
    socket().emit({ type: 'output', sessionId: 'abc', seq: 3, data: 'three' });
    socket().emit({ type: 'output', sessionId: 'abc', seq: 5, data: 'five again' });
    socket().emit({ type: 'output', sessionId: 'abc', seq: 6, data: 'six' });

    expect(received).toEqual(['five', 'six']);
    expect(connection.getLastSeq()).toBe(6);
  });

  it('resumes from the last rendered sequence after a reconnect', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    socket().emit({ type: 'output', sessionId: 'abc', seq: 42, data: 'x' });

    socket().drop();
    vi.advanceTimersByTime(200);
    socket(1).open();

    expect(socket(1).parsedSent()[0]).toMatchObject({ type: 'attach', afterSeq: 42 });
  });

  it('advances lastSeq from the replay payload', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: 'history', fromSeq: 0, toSeq: 9, truncated: false },
    });

    expect(connection.getLastSeq()).toBe(9);
  });

  it('sends the epoch back so the server can detect a stale resume', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: 'x', fromSeq: 0, toSeq: 4, truncated: false },
    });

    socket().drop();
    vi.advanceTimersByTime(200);
    socket(1).open();

    expect(socket(1).parsedSent()[0]).toMatchObject({
      type: 'attach',
      afterSeq: 4,
      epoch: 'epoch-1',
    });
  });

  it('resets the sequence number when the server reports a new epoch', () => {
    const replays: { data: string; truncated: boolean }[] = [];
    const { connection, socket } = setup({
      onReplay: (data, truncated) => replays.push({ data, truncated }),
    });
    connection.open('abc');
    socket().open();
    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: 'first stream', fromSeq: 0, toSeq: 40, truncated: false },
    });
    expect(connection.getLastSeq()).toBe(40);

    // The server restarted and re-adopted the session: new epoch, seq from 1.
    socket().drop();
    vi.advanceTimersByTime(200);
    socket(1).open();
    socket(1).emit({
      type: 'attached',
      session: { ...SESSION, epoch: 'epoch-2' },
      replay: { data: 'recovered screen', fromSeq: 0, toSeq: 3, truncated: true },
    });

    // Must adopt the new stream's numbering, not keep the stale 40.
    expect(connection.getLastSeq()).toBe(3);
    expect(replays.at(-1)).toEqual({ data: 'recovered screen', truncated: true });

    // Output in the new stream is rendered rather than dropped as "old".
    const received: string[] = [];
    connection['handlers'].onOutput = (d: string) => received.push(d);
    socket(1).emit({ type: 'output', sessionId: 'abc', seq: 4, data: 'live again' });
    expect(connection.getLastSeq()).toBe(4);
  });

  it('starts from zero when switching to a different session', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    socket().emit({ type: 'output', sessionId: 'abc', seq: 10, data: 'x' });
    expect(connection.getLastSeq()).toBe(10);

    connection.close();
    connection.open('other');
    expect(connection.getLastSeq()).toBe(0);
  });
});

describe('TerminalConnection: replay handling', () => {
  it('reports a contiguous replay without asking for a clear', () => {
    const replays: { data: string; truncated: boolean }[] = [];
    const { connection, socket } = setup({
      onReplay: (data, truncated) => replays.push({ data, truncated }),
    });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: 'missed output', fromSeq: 3, toSeq: 7, truncated: false },
    });

    expect(replays).toEqual([{ data: 'missed output', truncated: false }]);
  });

  it('flags a truncated replay so the caller can clear the screen', () => {
    const replays: { data: string; truncated: boolean }[] = [];
    const { connection, socket } = setup({
      onReplay: (data, truncated) => replays.push({ data, truncated }),
    });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: 'partial', fromSeq: 90, toSeq: 99, truncated: true },
    });

    expect(replays[0]?.truncated).toBe(true);
  });

  it('does not fire onReplay for an empty, non-truncated replay', () => {
    const onReplay = vi.fn();
    const { connection, socket } = setup({ onReplay });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: '', fromSeq: 5, toSeq: 5, truncated: false },
    });

    expect(onReplay).not.toHaveBeenCalled();
  });
});

describe('TerminalConnection: message handling', () => {
  it('forwards status, exit, hint and error frames', () => {
    const events: string[] = [];
    const { connection, socket } = setup({
      onStatus: (s) => events.push(`status:${s}`),
      onExit: (code, signal) => events.push(`exit:${code}:${signal}`),
      onHint: (hints) => events.push(`hint:${hints.join(',')}`),
      onError: (code) => events.push(`error:${code}`),
      onAttached: (s) => events.push(`attached:${s.id}`),
    });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: SESSION,
      replay: { data: '', fromSeq: 0, toSeq: 0, truncated: false },
    });
    socket().emit({ type: 'status', sessionId: 'abc', status: 'running' });
    socket().emit({ type: 'hint', sessionId: 'abc', hints: ['possible_approval_prompt'] });
    socket().emit({ type: 'exit', sessionId: 'abc', exitCode: 0, exitSignal: null });
    socket().emit({ type: 'error', code: 'not_found', message: 'gone' });

    expect(events).toEqual([
      'attached:abc',
      'status:running',
      'hint:possible_approval_prompt',
      'exit:0:null',
      'error:not_found',
    ]);
  });

  it('ignores malformed frames instead of crashing the terminal', () => {
    const onOutput = vi.fn();
    const { connection, socket } = setup({ onOutput });
    connection.open('abc');
    socket().open();

    socket().emitRaw('not json at all');
    socket().emitRaw(JSON.stringify({ type: 'wat' }));
    socket().emitRaw(JSON.stringify({ type: 'output', sessionId: 'abc' })); // no seq/data
    socket().emitRaw(new ArrayBuffer(4));

    expect(onOutput).not.toHaveBeenCalled();
    expect(connection.getState()).toBe('connected');
  });
});

describe('TerminalConnection: sending', () => {
  it('sends input, resize and signal frames', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();

    expect(connection.sendInput('ls\r')).toBe(true);
    expect(connection.sendResize(120, 40)).toBe(true);
    expect(connection.sendSignal('SIGINT')).toBe(true);

    expect(socket().parsedSent().slice(1)).toEqual([
      { type: 'input', sessionId: 'abc', data: 'ls\r' },
      { type: 'resize', sessionId: 'abc', cols: 120, rows: 40 },
      { type: 'signal', sessionId: 'abc', signal: 'SIGINT' },
    ]);
  });

  it('drops keystrokes while offline rather than replaying them later', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    socket().drop();

    expect(connection.sendInput('rm -rf important\r')).toBe(false);

    vi.advanceTimersByTime(200);
    socket(1).open();

    // Only the attach frame — the stale keystroke is gone for good.
    expect(socket(1).parsedSent()).toEqual([
      { type: 'attach', sessionId: 'abc', afterSeq: 0 },
    ]);
  });

  it('remembers the latest size and re-sends it on reattach', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();
    connection.sendResize(150, 50);

    socket().drop();
    vi.advanceTimersByTime(200);
    socket(1).open();

    expect(socket(1).parsedSent()[0]).toMatchObject({ cols: 150, rows: 50 });
  });
});

describe('TerminalConnection: structured sessions', () => {
  const STRUCTURED: SessionInfo = {
    ...SESSION,
    transport: 'structured',
    // A structured session has no character grid.
    cols: 0,
    rows: 0,
    agentSessionId: 'agent-1',
  };

  it('accepts an attached frame for a session with no terminal grid', () => {
    // Regression: SessionInfo required a positive cols/rows, so the whole
    // frame failed validation and was dropped — the transcript came back
    // empty on every reload with no error anywhere.
    const replays: { events: unknown[]; truncated: boolean }[] = [];
    const { connection, socket } = setup({
      onAgentReplay: (events, truncated) => replays.push({ events, truncated }),
    });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: STRUCTURED,
      replay: { data: '', fromSeq: 0, toSeq: 0, truncated: false },
      agentReplay: {
        events: [{ seq: 1, event: { kind: 'text', id: 't1', text: 'hello' } }],
        fromSeq: 0,
        toSeq: 1,
        truncated: false,
      },
    });

    expect(replays).toHaveLength(1);
    expect(replays[0]?.events).toEqual([{ kind: 'text', id: 't1', text: 'hello' }]);
    expect(connection.getLastSeq()).toBe(1);
  });

  it('surfaces approvals that were still pending at attach time', () => {
    const pending: unknown[] = [];
    const { connection, socket } = setup({
      onPendingPermissions: (requests) => pending.push(...requests),
    });
    connection.open('abc');
    socket().open();

    socket().emit({
      type: 'attached',
      session: STRUCTURED,
      replay: { data: '', fromSeq: 0, toSeq: 0, truncated: false },
      agentReplay: { events: [], fromSeq: 0, toSeq: 0, truncated: false },
      pendingPermissions: [
        {
          kind: 'permission_request',
          id: 'p1',
          toolName: 'Write',
          input: {},
          title: 'Allow Write?',
          displayName: null,
          filePath: null,
          reason: null,
          canAllowForSession: true,
        },
      ],
    });

    expect(pending).toHaveLength(1);
  });

  it('delivers live agent events with de-duplication', () => {
    const seen: string[] = [];
    const { connection, socket } = setup({
      onAgentEvent: (event) => seen.push(event.kind),
    });
    connection.open('abc');
    socket().open();

    socket().emit({ type: 'agent_event', sessionId: 'abc', seq: 2, event: { kind: 'text', id: 'a', text: 'x' } });
    // Replayed duplicate from the attach overlap.
    socket().emit({ type: 'agent_event', sessionId: 'abc', seq: 1, event: { kind: 'text', id: 'b', text: 'y' } });
    socket().emit({ type: 'agent_event', sessionId: 'abc', seq: 3, event: { kind: 'text', id: 'c', text: 'z' } });

    expect(seen).toEqual(['text', 'text']);
    expect(connection.getLastSeq()).toBe(3);
  });

  it('sends prompt, permission and interrupt frames', () => {
    const { connection, socket } = setup();
    connection.open('abc');
    socket().open();

    connection.sendPrompt('do the thing');
    connection.sendPermission('p1', 'allow_session');
    connection.sendPermission('p2', 'deny', 'not that file');
    connection.sendInterrupt();

    expect(socket().parsedSent().slice(1)).toEqual([
      { type: 'prompt', sessionId: 'abc', text: 'do the thing' },
      { type: 'permission', sessionId: 'abc', requestId: 'p1', decision: 'allow_session' },
      { type: 'permission', sessionId: 'abc', requestId: 'p2', decision: 'deny', message: 'not that file' },
      { type: 'interrupt', sessionId: 'abc' },
    ]);
  });
});
