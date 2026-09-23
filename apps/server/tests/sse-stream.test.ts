import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { openSseStream } from '../src/routes/sse.js';

describe('openSseStream (PA-90)', () => {
  it('does not prematurely close when incoming request stream emits close after body parsing', async () => {
    const app = Fastify();
    let streamClosedPrematurely = false;
    let onCloseFired = false;

    app.post('/test-sse', async (request, reply) => {
      const stream = openSseStream(request, reply, {
        onClose: () => {
          onCloseFired = true;
        },
      });

      // Emulate request.raw emitting close (which happens as soon as the POST body is consumed)
      request.raw.emit('close');

      if (stream.closed) {
        streamClosedPrematurely = true;
      }

      stream.write({ kind: 'test_event', payload: 'ok' });
      stream.end();
    });

    const res = await app.inject({
      method: 'POST',
      url: '/test-sse',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ id: 'claude' }),
    });

    expect(streamClosedPrematurely).toBe(false);
    expect(onCloseFired).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.body).toContain('data: {"kind":"test_event","payload":"ok"}');
  });

  it('invokes onClose when client response socket is destroyed prematurely', async () => {
    const app = Fastify();
    let onCloseFired = false;

    app.post('/test-disconnect', async (request, reply) => {
      openSseStream(request, reply, {
        onClose: () => {
          onCloseFired = true;
        },
      });

      // Simulate client dropping connection before response finishes (writableEnded is false)
      reply.raw.emit('close');
    });

    await expect(
      app.inject({
        method: 'POST',
        url: '/test-disconnect',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ id: 'codex' }),
      }),
    ).rejects.toThrow();

    expect(onCloseFired).toBe(true);
  });
});
