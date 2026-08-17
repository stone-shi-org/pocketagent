import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createTestApp, waitFor, sleep, type TestApp } from './helpers.js';

// Same fixture `sessions.test.ts` uses to drive a real turn through the agy
// adapter without paying for real inference: it emits the same line shapes
// captured from a live probe, deterministically and fast.
const AGY_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/fake-agy.mjs',
);

function headers(t: TestApp): Record<string, string> {
  return { cookie: t.cookie };
}

async function createAgySession(t: TestApp): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: headers(t),
    payload: { agent: 'agy', cwd: t.projectDir, cols: 80, rows: 24 },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('push notification on turn completion (structured)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp({ POCKETAGENT_AGY_BIN: AGY_FIXTURE });
  });
  afterEach(() => t.cleanup());

  it('pushes once a turn finishes with nobody attached', async () => {
    const sendSpy = vi.spyOn(t.context.push, 'send');
    const id = await createAgySession(t);

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('hello');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    await waitFor(() => sendSpy.mock.calls.length > 0);

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'PocketAgent — turn complete',
        url: `/#/s/${encodeURIComponent(id)}`,
        tag: `turn-complete-${id}`,
      }),
    );
    const [payload] = sendSpy.mock.calls[0]!;
    expect(payload.body).toContain('waiting for your next prompt');
  });

  it('does not push while a client is attached to the session', async () => {
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const address = t.app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/ws`, {
      headers: { cookie: t.cookie },
    });
    await new Promise<void>((resolve) => {
      ws.once('open', () => resolve());
      ws.once('error', () => resolve());
    });

    const id = await createAgySession(t);
    ws.send(JSON.stringify({ type: 'attach', sessionId: id, afterSeq: 0 }));
    await waitFor(() => t.context.sessions.attachedCount(id) === 1);

    const sendSpy = vi.spyOn(t.context.push, 'send');
    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    session.prompt('hello');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    // Give any (wrongly) scheduled push a moment to have fired.
    await sleep(200);
    expect(sendSpy).not.toHaveBeenCalled();

    ws.close();
    await waitFor(() => t.context.sessions.attachedCount(id) === 0);
  });

  it('still pushes exactly once for a turn that ends in error', async () => {
    const sendSpy = vi.spyOn(t.context.push, 'send');
    const id = await createAgySession(t);

    const session = t.context.sessions.getOrThrow(id);
    if (session.transport !== 'structured') throw new Error('expected a structured session');
    // QUOTA makes the fixture emit a well-formed `result` line with
    // status !== 'SUCCESS' (mirrors a live quota-exhausted response) — still
    // exactly one `turn_complete`, and still worth waking someone up for.
    session.prompt('QUOTA');

    await waitFor(() =>
      session.buffer.replayAfter(0).events.some((e) => e.event.kind === 'turn_complete'),
    );
    await waitFor(() => sendSpy.mock.calls.length > 0);
    // A settle window: if anything were wired to fire twice, this would catch it.
    await sleep(200);
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});

describe('push notification on terminal idle (advisory hint)', () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(() => t.cleanup());

  it('pushes when the classifier reports idle and nobody is attached', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = res.json().id as string;
    const session = t.context.sessions.getOrThrow(id);

    const sendSpy = vi.spyOn(t.context.push, 'send');
    // The classifier's own 30s-of-silence timing is exercised by
    // classifier.test.ts; here we only care that the manager reacts correctly
    // to the hint it emits, so drive that hint directly rather than waiting.
    session.emit('hint', ['idle']);

    await waitFor(() => sendSpy.mock.calls.length > 0);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'PocketAgent — session idle',
        url: `/#/s/${encodeURIComponent(id)}`,
        tag: `idle-${id}`,
      }),
    );
  });

  it('does not push for other hint kinds', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: headers(t),
      payload: { agent: 'shell', cwd: t.projectDir, cols: 80, rows: 24 },
    });
    const id = res.json().id as string;
    const session = t.context.sessions.getOrThrow(id);

    const sendSpy = vi.spyOn(t.context.push, 'send');
    session.emit('hint', ['working']);
    session.emit('hint', ['possible_approval_prompt']);
    await sleep(200);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
