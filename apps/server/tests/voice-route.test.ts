import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp, TEST_AGENT_ID, type TestApp } from './helpers.js';

function startFakeLiveStt(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Base64 of a few arbitrary PCM16 samples — content doesn't matter to these tests. */
const SOME_AUDIO_BASE64 = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer).toString('base64');

describe('POST /api/sessions/:id/voice/transcribe', () => {
  describe('voice not configured', () => {
    let t: TestApp;
    beforeEach(async () => {
      t = await createTestApp();
    });
    afterEach(() => t.cleanup());

    it('answers 503 without ever needing a valid session id', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/sessions/does-not-exist/voice/transcribe',
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('voice_disabled');
    });

    it('requires authentication', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/sessions/does-not-exist/voice/transcribe',
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('voice configured against a fake live-stt', () => {
    let t: TestApp;
    let liveStt: { url: string; close: () => Promise<void> };
    let sessionId: string;

    beforeEach(async () => {
      liveStt = await startFakeLiveStt((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'turn on the lights' }));
        });
      });
      t = await createTestApp({ POCKETAGENT_LIVE_STT_URL: liveStt.url });

      const created = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: t.cookie },
        payload: { agent: TEST_AGENT_ID, cwd: t.projectDir, cols: 80, rows: 24 },
      });
      expect(created.statusCode).toBe(201);
      sessionId = created.json().id as string;
    });

    afterEach(async () => {
      await t.cleanup();
      await liveStt.close();
    });

    it('transcribes and returns plain text, on a session of any transport', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: 'turn on the lights' });
    });

    it('404s for an unknown session id even when voice is configured', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/sessions/does-not-exist/voice/transcribe',
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    });

    it('400s on a malformed body', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: '', durationMs: 500 } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    });

    it('400s on empty (zero-byte) decoded audio', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        // A base64 string that is non-empty but decodes to zero bytes.
        payload: { audio: { data: '====', durationMs: 500 } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('upstream live-stt failure', () => {
    let t: TestApp;
    let liveStt: { url: string; close: () => Promise<void> };
    let sessionId: string;

    beforeEach(async () => {
      liveStt = await startFakeLiveStt((_req, res) => {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: { message: 'at capacity, try again shortly' } }));
      });
      t = await createTestApp({ POCKETAGENT_LIVE_STT_URL: liveStt.url });
      const created = await t.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: t.cookie },
        payload: { agent: TEST_AGENT_ID, cwd: t.projectDir, cols: 80, rows: 24 },
      });
      sessionId = created.json().id as string;
    });

    afterEach(async () => {
      await t.cleanup();
      await liveStt.close();
    });

    it('surfaces a 503 from live-stt as voice_service_busy, not a generic 500', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('voice_service_busy');
      expect(res.json().error.message).toContain('at capacity');
    });
  });
});
