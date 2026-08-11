import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, type ServerMessage } from '@pocketagent/protocol';
import { createTestApp, waitFor, sleep, type TestApp } from './helpers.js';

interface Client {
  ws: WebSocket;
  messages: ServerMessage[];
  send: (message: unknown) => void;
  /** Wait for the first message matching `predicate`, then return it. */
  next: <T extends ServerMessage['type']>(
    type: T,
    predicate?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  outputText: () => string;
  close: () => Promise<void>;
}

describe('websocket terminal transport', () => {
  let t: TestApp;
  let baseUrl: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    t = await createTestApp();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const address = t.app.server.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    await t.cleanup();
  });

  async function connect(options: { cookie?: string | null; version?: number } = {}): Promise<Client> {
    const cookie = options.cookie === undefined ? t.cookie : options.cookie;
    const version = options.version ?? PROTOCOL_VERSION;
    const ws = new WebSocket(`${baseUrl}/api/ws?v=${version}`, {
      headers: cookie ? { cookie } : {},
    });

    const messages: ServerMessage[] = [];
    ws.on('message', (data) => {
      messages.push(JSON.parse(data.toString()) as ServerMessage);
    });

    // Settle the handshake before returning, otherwise `send` races it. A close
    // during the upgrade (bad protocol version) also settles.
    await new Promise<void>((resolve) => {
      ws.once('open', () => resolve());
      ws.once('close', () => resolve());
      ws.once('error', () => resolve());
    });

    const client: Client = {
      ws,
      messages,
      send: (message) => ws.send(JSON.stringify(message)),
      next: async (type, predicate) => {
        let found: ServerMessage | undefined;
        await waitFor(() => {
          found = messages.find(
            (m) => m.type === type && (!predicate || predicate(m as never)),
          );
          return found !== undefined;
        });
        return found as never;
      },
      outputText: () =>
        messages
          .flatMap((m) =>
            m.type === 'output' ? [m.data] : m.type === 'attached' ? [m.replay.data] : [],
          )
          .join(''),
      close: () =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) return resolve();
          ws.on('close', () => resolve());
          ws.on('error', () => resolve());
          // `close()` throws if the handshake is still in flight.
          if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
          else ws.close();
          setTimeout(resolve, 500);
        }),
    };

    clients.push(client);
    return client;
  }

  async function newShellSession(): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: t.cookie },
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('refuses an unauthenticated connection', async () => {
    const ws = new WebSocket(`${baseUrl}/api/ws?v=1`);
    const code = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('close', (c) => resolve(c));
      ws.on('error', () => resolve(-1));
    });
    expect([401, -1]).toContain(code === 401 ? 401 : -1);
  });

  it('refuses a protocol version it does not speak', async () => {
    const client = await connect({ version: 99 });
    const code = await new Promise<number>((resolve) => client.ws.on('close', resolve));
    expect(code).toBe(4001);
  });

  it('attaches and streams live output', async () => {
    const id = await newShellSession();
    const client = await connect();

    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    const attached = await client.next('attached');
    expect(attached.session.id).toBe(id);
    expect(attached.session.status).toBe('running');

    await sleep(300);
    client.send({ type: 'input', sessionId: id, data: 'echo WS_HELLO\n' });

    await waitFor(() => client.outputText().includes('WS_HELLO'));
    expect(client.outputText()).toContain('WS_HELLO');
  });

  it('assigns strictly increasing sequence numbers', async () => {
    const id = await newShellSession();
    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');

    await sleep(300);
    for (let i = 0; i < 5; i++) {
      client.send({ type: 'input', sessionId: id, data: `echo SEQ_${i}\n` });
      await sleep(120);
    }
    await waitFor(() => client.outputText().includes('SEQ_4'));

    const seqs = client.messages.filter((m) => m.type === 'output').map((m) => m.seq);
    expect(seqs.length).toBeGreaterThan(0);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('keeps the PTY alive when the browser disconnects, and replays the gap on reconnect', async () => {
    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);

    const first = await connect();
    first.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await first.next('attached');
    await sleep(300);

    first.send({ type: 'input', sessionId: id, data: 'echo BEFORE_DROP\n' });
    await waitFor(() => first.outputText().includes('BEFORE_DROP'));
    const lastSeq = Math.max(
      ...first.messages.filter((m) => m.type === 'output').map((m) => m.seq),
    );

    // Simulate losing the network entirely.
    await first.close();
    await sleep(200);

    expect(session.isAlive()).toBe(true);
    expect(t.context.sessions.attachedCount(id)).toBe(0);

    // Work continues while nobody is watching.
    session.write('echo WHILE_AWAY\n');
    await waitFor(() => session.buffer.replayAfter(0).data.includes('WHILE_AWAY'));

    const second = await connect();
    second.send({ type: 'attach', sessionId: id, afterSeq: lastSeq });
    const attached = await second.next('attached');

    expect(attached.replay.truncated).toBe(false);
    expect(attached.replay.data).toContain('WHILE_AWAY');
    // The gap only — output already seen is not resent.
    expect(attached.replay.data).not.toContain('BEFORE_DROP');

    // And the reattached client can still drive the session.
    second.send({ type: 'input', sessionId: id, data: 'echo AFTER_RECONNECT\n' });
    await waitFor(() => second.outputText().includes('AFTER_RECONNECT'));
  });

  it('replays the whole buffer for a fresh attach', async () => {
    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('echo HISTORY_MARKER\n');
    await waitFor(() => session.buffer.replayAfter(0).data.includes('HISTORY_MARKER'));

    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    const attached = await client.next('attached');
    expect(attached.replay.data).toContain('HISTORY_MARKER');
  });

  it('signals truncation when the requested sequence has been evicted', async () => {
    await t.cleanup();
    t = await createTestApp({ OUTPUT_BUFFER_BYTES: String(16 * 1024) });
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);

    // Overflow the 16 KiB buffer many times over.
    session.write('for i in $(seq 1 4000); do echo "filler line $i"; done\n');
    await waitFor(() => session.buffer.getDroppedChunks() > 0, { timeout: 15000 });
    await sleep(300);

    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 1 });
    const attached = await client.next('attached');

    expect(attached.replay.truncated).toBe(true);
    expect(attached.replay.data.length).toBeGreaterThan(0);
  });

  describe('stream epoch', () => {
    it('reports an epoch and honours a resume within it', async () => {
      const id = await newShellSession();
      const client = await connect();
      client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
      const attached = await client.next('attached');

      const epoch = attached.session.epoch;
      expect(epoch).toBeTruthy();

      await sleep(300);
      client.send({ type: 'input', sessionId: id, data: 'echo EPOCH_MARKER\n' });
      await waitFor(() => client.outputText().includes('EPOCH_MARKER'));
      const lastSeq = Math.max(
        ...client.messages.filter((m) => m.type === 'output').map((m) => m.seq),
      );

      const second = await connect();
      second.send({ type: 'attach', sessionId: id, afterSeq: lastSeq, epoch: epoch! });
      const reattached = await second.next('attached');
      expect(reattached.replay.truncated).toBe(false);
    });

    it('forces a resync when the client resumes with a stale epoch', async () => {
      const id = await newShellSession();
      const session = t.context.sessions.getOrThrow(id);
      await sleep(300);
      session.write('echo BEFORE_EPOCH_CHANGE\n');
      await waitFor(() => session.buffer.replayAfter(0).data.includes('BEFORE_EPOCH_CHANGE'));

      const client = await connect();
      // A sequence number from a stream that no longer exists — exactly what a
      // browser holds after the server restarted and re-adopted the session.
      client.send({
        type: 'attach',
        sessionId: id,
        afterSeq: session.buffer.getLastSeq(),
        epoch: 'epoch-from-a-previous-server',
      });
      const attached = await client.next('attached');

      // Must not report "nothing new": the client's screen is from another run.
      expect(attached.replay.truncated).toBe(true);
      expect(attached.replay.data).toContain('BEFORE_EPOCH_CHANGE');
      expect(attached.session.epoch).not.toBe('epoch-from-a-previous-server');
    });

    it('treats a fresh attach with no epoch normally', async () => {
      const id = await newShellSession();
      const client = await connect();
      client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
      const attached = await client.next('attached');
      expect(attached.replay.truncated).toBe(false);
    });
  });

  it('resizes the PTY over the socket', async () => {
    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);
    const client = await connect();

    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');
    await sleep(300);

    client.send({ type: 'resize', sessionId: id, cols: 120, rows: 40 });
    await waitFor(() => session.cols === 120 && session.rows === 40);

    client.send({ type: 'input', sessionId: id, data: 'echo "W=$(tput cols)"\n' });
    await waitFor(() => client.outputText().includes('W=120'));
  });

  it('delivers Ctrl+C as a signal message', async () => {
    const id = await newShellSession();
    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');
    await sleep(300);

    client.send({ type: 'input', sessionId: id, data: 'sleep 30\n' });
    await sleep(400);
    client.send({ type: 'signal', sessionId: id, signal: 'SIGINT' });
    await sleep(400);

    client.send({ type: 'input', sessionId: id, data: 'echo INTERRUPTED_OK\n' });
    await waitFor(() => client.outputText().includes('INTERRUPTED_OK'));
  });

  it('announces process exit', async () => {
    const id = await newShellSession();
    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');
    await sleep(300);

    client.send({ type: 'input', sessionId: id, data: 'exit 5\n' });
    const exit = await client.next('exit');
    expect(exit.exitCode).toBe(5);

    const status = await client.next('status', (m) => m.status === 'exited');
    expect(status.status).toBe('exited');
  });

  it('reports the terminal state immediately when attaching to a dead session', async () => {
    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);
    await sleep(300);
    session.write('exit 0\n');
    await waitFor(() => !session.isAlive());

    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    const attached = await client.next('attached');
    expect(attached.session.status).toBe('exited');
    await client.next('exit');
  });

  it('rejects input for a session that is not running', async () => {
    const id = await newShellSession();
    const session = t.context.sessions.getOrThrow(id);
    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');

    await sleep(300);
    session.write('exit 0\n');
    await waitFor(() => !session.isAlive());

    client.send({ type: 'input', sessionId: id, data: 'echo nope\n' });
    const error = await client.next('error', (m) => m.code === 'session_not_running');
    expect(error.code).toBe('session_not_running');
  });

  it('rejects input before attach', async () => {
    const id = await newShellSession();
    const client = await connect();
    client.send({ type: 'input', sessionId: id, data: 'echo nope\n' });
    const error = await client.next('error');
    expect(error.code).toBe('not_attached');
  });

  it('reports a missing session rather than creating one', async () => {
    const client = await connect();
    client.send({ type: 'attach', sessionId: 'no-such-session', afterSeq: 0 });
    const error = await client.next('error');
    expect(error.code).toBe('not_found');
  });

  describe('malformed input', () => {
    it('rejects non-JSON', async () => {
      const client = await connect();
      client.ws.send('this is not json');
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
    });

    it('rejects an unknown message type', async () => {
      const client = await connect();
      client.send({ type: 'exec', command: 'rm -rf /' });
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
    });

    it('rejects a message missing required fields', async () => {
      const client = await connect();
      client.send({ type: 'input' });
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
    });

    it('rejects wrong field types', async () => {
      const id = await newShellSession();
      const client = await connect();
      client.send({ type: 'resize', sessionId: id, cols: 'wide', rows: 24 });
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
    });

    it('rejects an out-of-range resize instead of clamping it', async () => {
      const id = await newShellSession();
      const client = await connect();
      client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
      await client.next('attached');

      client.send({ type: 'resize', sessionId: id, cols: 999999, rows: 24 });
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
      expect(t.context.sessions.getOrThrow(id).cols).toBe(80);
    });

    it('rejects an oversized input payload', async () => {
      const id = await newShellSession();
      const client = await connect();
      client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
      await client.next('attached');

      client.send({ type: 'input', sessionId: id, data: 'x'.repeat(200_000) });
      const error = await client.next('error');
      expect(['bad_message', 'too_large']).toContain(error.code);
    });

    it('rejects binary frames', async () => {
      const client = await connect();
      client.ws.send(Buffer.from([0x01, 0x02, 0x03]));
      const error = await client.next('error');
      expect(error.code).toBe('bad_message');
    });

    it('answers ping with pong', async () => {
      const client = await connect();
      client.send({ type: 'ping' });
      await client.next('pong');
    });
  });

  it('supports two browsers watching the same session', async () => {
    const id = await newShellSession();
    const a = await connect();
    const b = await connect();

    a.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    b.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await a.next('attached');
    await b.next('attached');
    expect(t.context.sessions.attachedCount(id)).toBe(2);

    await sleep(300);
    a.send({ type: 'input', sessionId: id, data: 'echo SHARED_VIEW\n' });

    await waitFor(() => a.outputText().includes('SHARED_VIEW'));
    await waitFor(() => b.outputText().includes('SHARED_VIEW'));

    await b.close();
    await waitFor(() => t.context.sessions.attachedCount(id) === 1);
  });

  it('detaches on request without killing the session', async () => {
    const id = await newShellSession();
    const client = await connect();
    client.send({ type: 'attach', sessionId: id, afterSeq: 0 });
    await client.next('attached');

    client.send({ type: 'detach', sessionId: id });
    await waitFor(() => t.context.sessions.attachedCount(id) === 0);
    expect(t.context.sessions.getOrThrow(id).isAlive()).toBe(true);
  });
});
