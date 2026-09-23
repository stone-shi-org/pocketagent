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

    it('transcribes successfully for an inactive/exited session found in DB', async () => {
      // Terminate the session so it is no longer live in memory
      await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/terminate`,
        headers: { cookie: t.cookie },
      });

      const res = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ text: 'turn on the lights' });
    });

    it('transcribes successfully for a planner chat (PA-89)', async () => {
      const chatRes = await t.app.inject({
        method: 'POST',
        url: '/api/planner/chats',
        headers: { cookie: t.cookie },
        payload: { title: 'Test Planner Chat' },
      });
      expect(chatRes.statusCode).toBe(201);
      const chatId = chatRes.json().id as string;

      // Via /api/sessions/:id/voice/transcribe with planner_${chatId}
      const resPrefixed = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/planner_${chatId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(resPrefixed.statusCode).toBe(200);
      expect(resPrefixed.json()).toEqual({ text: 'turn on the lights' });

      // Via /api/sessions/:id/voice/transcribe with raw chatId
      const resRaw = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${chatId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(resRaw.statusCode).toBe(200);
      expect(resRaw.json()).toEqual({ text: 'turn on the lights' });

      // Via /api/planner/chats/:id/voice/transcribe
      const resPlannerRoute = await t.app.inject({
        method: 'POST',
        url: `/api/planner/chats/${chatId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(resPlannerRoute.statusCode).toBe(200);
      expect(resPlannerRoute.json()).toEqual({ text: 'turn on the lights' });
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

  describe('configuring live-stt via PATCH /api/settings, no restart (PA-20 follow-up)', () => {
    // Per reviewer feedback: this must be a Settings-UI-editable value, not
    // `POCKETAGENT_LIVE_STT_URL`. The whole point of `liveSttUrl` being a
    // *live* `SETTINGS_FIELDS` entry is that this test needs no restart
    // between "unconfigured" and "configured" — a second `createTestApp()`
    // boot would prove nothing about the live-reload behavior actually
    // requested.
    let t: TestApp;
    let liveStt: { url: string; close: () => Promise<void> };
    let sessionId: string;

    beforeEach(async () => {
      liveStt = await startFakeLiveStt((req, res) => {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'hello from live reload' }));
        });
      });
      // Deliberately no POCKETAGENT_LIVE_STT_URL — starts fully unconfigured.
      t = await createTestApp();
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

    it('is not in restartRequiredKeys and reports "" when unset', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: { cookie: t.cookie } });
      expect(res.json().settings.liveSttUrl).toBe('');
      expect(res.json().restartRequiredKeys).not.toContain('liveSttUrl');
    });

    it('starts disabled, then works immediately after a PATCH — no restart', async () => {
      const before = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(before.statusCode).toBe(503);
      expect(before.json().error.code).toBe('voice_disabled');

      const patch = await t.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: t.cookie },
        payload: { liveSttUrl: liveStt.url },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().settings.liveSttUrl).toBe(liveStt.url);

      const after = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(after.statusCode).toBe(200);
      expect(after.json()).toEqual({ text: 'hello from live reload' });
    });

    it('round-trips back to disabled after clearing it via PATCH', async () => {
      await t.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: t.cookie },
        payload: { liveSttUrl: liveStt.url },
      });
      // Confirm it actually turned on before proving it turns back off.
      const on = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(on.statusCode).toBe(200);

      await t.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: t.cookie },
        payload: { liveSttUrl: '' },
      });

      const off = await t.app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/voice/transcribe`,
        headers: { cookie: t.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
      });
      expect(off.statusCode).toBe(503);
      expect(off.json().error.code).toBe('voice_disabled');
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

  describe('STT and TTS diagnostic test routes (PA-81)', () => {
    let t: TestApp;
    let liveStt: { url: string; close: () => Promise<void> };
    let lastTranscribeBody = '';
    let lastSpeechBody: unknown = null;

    beforeEach(async () => {
      lastTranscribeBody = '';
      lastSpeechBody = null;
      liveStt = await startFakeLiveStt((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const bodyBuf = Buffer.concat(chunks);
          if (req.url === '/v1/audio/transcriptions') {
            lastTranscribeBody = bodyBuf.toString('latin1');
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({ text: 'diagnostic transcript ok' }),
            );
          } else if (req.url === '/v1/audio/speech') {
            lastSpeechBody = JSON.parse(bodyBuf.toString('utf8'));
            res.writeHead(200, { 'content-type': 'audio/pcm' }).end(
              Buffer.from(new Int16Array([10, 20, 30]).buffer),
            );
          } else if (req.url === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                object: 'list',
                data: [
                  { id: 'whisper-large-v3-turbo-q8_0', type: 'asr', default: true },
                  { id: 'kokoro-82m-v1', type: 'tts', default: true, sample_rate: 24000 },
                ],
              }),
            );
          } else {
            res.writeHead(404).end();
          }
        });
      });
      t = await createTestApp({ POCKETAGENT_LIVE_STT_URL: liveStt.url });
    });

    afterEach(async () => {
      await t.cleanup();
      await liveStt.close();
    });

    it('POST /api/voice/test-stt succeeds with transcript and duration', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/voice/test-stt',
        headers: { cookie: t.cookie },
        payload: { model: 'whisper-test-model' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.transcript).toBe('diagnostic transcript ok');
      expect(body.durationMs).toBeGreaterThanOrEqual(0);
      expect(lastTranscribeBody).toContain('name="model"');
      expect(lastTranscribeBody).toContain('whisper-test-model');
    });

    it('POST /api/voice/test-stt returns 400 when voice service URL is not configured', async () => {
      await t.app.inject({
        method: 'PATCH',
        url: '/api/settings',
        headers: { cookie: t.cookie },
        payload: { liveSttUrl: '' },
      });
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/voice/test-stt',
        headers: { cookie: t.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('voice_disabled');
    });

    it('POST /api/voice/test-tts succeeds with base64 audio and sample rate', async () => {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/voice/test-tts',
        headers: { cookie: t.cookie },
        payload: { model: 'piper-en-us', text: 'Hello test' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
      expect(body.sampleRateHz).toBe(22050);
      expect(typeof body.audio).toBe('string');
      expect(lastSpeechBody).toEqual({ input: 'Hello test', response_format: 'pcm', model: 'piper-en-us' });
    });

    it('GET /api/voice/models returns models list', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/voice/models',
        headers: { cookie: t.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().models).toEqual([
        { id: 'whisper-large-v3-turbo-q8_0', type: 'asr', default: true },
        { id: 'kokoro-82m-v1', type: 'tts', default: true, sampleRate: 24000 },
      ]);
    });
  });
});

/**
 * PA-85: the transcribe route forwards live-stt's per-word confidence rather
 * than judging it. The decision lives in the browser because that is where
 * the other half of the evidence is — the endpointer's measured voiced span,
 * and whether the agent's talk-back is currently playing.
 */
describe('POST /api/sessions/:id/voice/transcribe — harness evidence (PA-85)', () => {
  let t: TestApp;
  let liveStt: { url: string; close: () => Promise<void> };
  let sessionId: string;
  let requestedFormat = '';

  beforeEach(async () => {
    liveStt = await startFakeLiveStt((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        requestedFormat = body.includes('verbose_json') ? 'verbose_json' : 'json';
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            task: 'transcribe',
            language: '',
            duration: 1.5,
            text: "well i don't wish to see",
            words: [
              { word: 'well', start: 0.8, end: 0.88, confidence: 0.9546 },
              { word: 'i', start: 0.96, end: 1.04, confidence: 0.9957 },
            ],
          }),
        );
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

  it('asks live-stt for verbose_json', async () => {
    await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/voice/transcribe`,
      headers: { cookie: t.cookie },
      payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
    });
    expect(requestedFormat).toBe('verbose_json');
  });

  it('forwards words and duration to the browser untouched', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/voice/transcribe`,
      headers: { cookie: t.cookie },
      payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 500 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      text: "well i don't wish to see",
      durationSec: 1.5,
      words: [
        { word: 'well', start: 0.8, end: 0.88, confidence: 0.9546 },
        { word: 'i', start: 0.96, end: 1.04, confidence: 0.9957 },
      ],
    });
  });

  it('does not filter anything server-side — a filler transcript still comes back', async () => {
    // The harness deliberately does not run here. A server that dropped "oh"
    // would also drop it for push-to-talk, where the user deliberately held
    // the button and is owed whatever they said.
    await liveStt.close();
    liveStt = await startFakeLiveStt((req, res) => {
      req.resume();
      req.on('end', () => {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ text: 'oh', duration: 0.3, words: [{ word: 'oh', confidence: 0.2 }] }));
      });
    });
    const t2 = await createTestApp({ POCKETAGENT_LIVE_STT_URL: liveStt.url });
    try {
      const created = await t2.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: t2.cookie },
        payload: { agent: TEST_AGENT_ID, cwd: t2.projectDir, cols: 80, rows: 24 },
      });
      const id = created.json().id as string;
      const res = await t2.app.inject({
        method: 'POST',
        url: `/api/sessions/${id}/voice/transcribe`,
        headers: { cookie: t2.cookie },
        payload: { audio: { data: SOME_AUDIO_BASE64, durationMs: 300 } },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toBe('oh');
    } finally {
      await t2.cleanup();
    }
  });
});
