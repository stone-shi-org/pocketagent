import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  createTestHub,
  registerHost,
  startStubBackend,
  type StubBackend,
  type TestHub,
} from './helpers.js';

function wsUrl(hub: TestHub, path: string): string {
  return `${hub.baseUrl.replace('http://', 'ws://')}${path}`;
}

function open(hub: TestHub, path: string, options: { deflate?: boolean } = {}): WebSocket {
  return new WebSocket(wsUrl(hub, path), {
    headers: { cookie: hub.cookie },
    perMessageDeflate: options.deflate ?? false,
  });
}

function once<T>(socket: WebSocket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.once(event, (value: T) => resolve(value));
    socket.once('error', reject);
  });
}

describe('the WebSocket splice (PA-66 hard constraint #2)', () => {
  let hub: TestHub;
  let backend: StubBackend;

  beforeEach(async () => {
    backend = await startStubBackend();
    hub = await createTestHub();
    registerHost(hub, { id: 'dev01', baseUrl: backend.baseUrl, credential: 'pah_ws-cred' });
  });

  afterEach(async () => {
    await hub.cleanup();
    await backend.close();
  });

  it('carries a text frame end to end', async () => {
    const socket = open(hub, '/h/dev01/api/ws?v=15');
    await once(socket, 'open');
    socket.send('hello');
    const reply = await once<Buffer>(socket, 'message');
    expect(reply.toString()).toBe('hello');
    socket.close();
  });

  it('reaches the backend with the credential and no cookie', async () => {
    const socket = open(hub, '/h/dev01/api/ws?v=15');
    await once(socket, 'open');
    const connection = backend.wsConnections[0];
    expect(connection?.url).toBe('/api/ws?v=15');
    expect(connection?.headers.authorization).toBe('Bearer pah_ws-cred');
    expect(connection?.headers.cookie).toBeUndefined();
    expect(connection?.headers.origin).toBeUndefined();
    socket.close();
  });

  it('carries a large binary frame byte-identically', async () => {
    // Large enough to be fragmented across TCP segments by the kernel, which
    // is what makes this an assertion about the *pipe* rather than about one
    // small write that could not have been reframed anyway.
    const payload = crypto.randomBytes(1024 * 1024);
    const socket = open(hub, '/h/dev01/api/ws?v=15');
    await once(socket, 'open');
    socket.send(payload, { binary: true });
    const reply = await once<Buffer>(socket, 'message');
    expect(reply.equals(payload)).toBe(true);
    socket.close();
  });

  it('lets permessage-deflate negotiate end to end, with the Hub not a party to it', async () => {
    // The strongest single piece of evidence that nothing is reframed: if the
    // Hub were decoding and re-encoding frames it would have to terminate the
    // extension itself, and a compressed payload could not survive a Hub that
    // never negotiated it.
    const socket = open(hub, '/h/dev01/api/ws?v=15', { deflate: true });
    await once(socket, 'open');
    expect(backend.wsConnections[0]?.headers['sec-websocket-extensions']).toContain(
      'permessage-deflate',
    );
    const payload = Buffer.alloc(64 * 1024, 0x61); // compresses enormously
    socket.send(payload, { binary: true });
    const reply = await once<Buffer>(socket, 'message');
    expect(reply.equals(payload)).toBe(true);
    socket.close();
  });

  it('relays a close code and reason unchanged', async () => {
    // PA-61's 4001 protocol mismatch is the case that matters: the browser
    // stops reconnecting on exactly that code and renders the reason string.
    backend.onSocket((socket) => {
      socket.close(4001, 'server speaks protocol v15');
    });
    const socket = open(hub, '/h/dev01/api/ws?v=9');
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code: number, reason: Buffer) =>
        resolve({ code, reason: reason.toString() }),
      );
    });
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe('server speaks protocol v15');
  });

  it('logs no frame payload anywhere', async () => {
    // Asserted rather than left to convention, as the ticket requires. The
    // structural reason it holds is that there is no WebSocket library on
    // this path at all — nothing here could observe a frame to log it — but
    // a test is what stops someone adding one later.
    const lines: string[] = [];
    const secret = `frame-secret-${crypto.randomUUID()}`;
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      const socket = open(hub, '/h/dev01/api/ws?v=15');
      await once(socket, 'open');
      socket.send(secret);
      await once<Buffer>(socket, 'message');
      socket.close();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.stdout.write = original;
    }
    expect(lines.join('')).not.toContain(secret);
  });

  it('refuses an unauthenticated upgrade', async () => {
    const socket = new WebSocket(wsUrl(hub, '/h/dev01/api/ws?v=15'));
    await expect(once(socket, 'open')).rejects.toThrow(/401/);
    expect(backend.wsConnections).toHaveLength(0);
  });

  it('refuses an upgrade to a denied path without dialing the backend', async () => {
    const socket = open(hub, '/h/dev01/api/hooks/foo');
    await expect(once(socket, 'open')).rejects.toThrow(/404/);
    expect(backend.wsConnections).toHaveLength(0);
    expect(backend.requests).toHaveLength(0);
  });

  it('does not leak the upstream dial when the client gives up first', async () => {
    // A browser that closes cleanly emits `close`, not `error`, so the
    // pre-upgrade cleanup used to miss it entirely and leave the upstream
    // socket open with nothing left to close it.
    const stalled = await startStubBackend();
    try {
      // Accept the TCP connection but never answer the handshake.
      registerHost(hub, { id: 'stall', baseUrl: stalled.baseUrl });
      const socket = open(hub, '/h/stall/api/ws?v=15');
      // The `ws` client rejects an abandoned handshake with an error of its
      // own; swallow it, since the abandonment is the point of the test.
      socket.on('error', () => undefined);
      // Abandon it before the handshake can complete.
      socket.terminate();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hub.context.sockets.countFor('stall')).toBe(0);
    } finally {
      await stalled.close();
    }
  });

  it('relays a refused upgrade status rather than hanging', async () => {
    registerHost(hub, { id: 'dead', baseUrl: 'http://127.0.0.1:1' });
    const socket = open(hub, '/h/dead/api/ws?v=15');
    await expect(once(socket, 'open')).rejects.toThrow(/502/);
  });
});
