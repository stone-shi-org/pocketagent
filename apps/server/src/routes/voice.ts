import type { FastifyPluginAsync } from 'fastify';
import {
  LIMITS,
  VoiceTranscribeRequest,
  VoiceTestSttRequest,
  VoiceTestTtsRequest,
} from '@pocketagent/protocol';
import { createLiveSttClient, LiveSttError } from '../voice/live-stt-client.js';
import { getTestUtterancePcm16 } from '../voice/fixtures/test-utterance.js';

/**
 * PA-20 Phase 1: push-to-talk transcription.
 * PA-81: STT and TTS model selection & diagnostic test endpoints.
 *
 * Deliberately not gated on transport (`sessions.get` only checks the
 * session exists) — unlike the later live-listen/talk-back mode, submitting
 * a transcribed prompt has no dependency on `text_delta`/`interrupt`, so it
 * works for a terminal session exactly as well as a structured one (PA-20
 * plan D4). This route does not itself submit a prompt: it hands the
 * transcript back to the browser, which calls `PromptBox`'s existing
 * `onSend` — the same path a typed message already uses.
 */
export const voiceRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, config } = app.pocket;

  app.post<{ Params: { id: string } }>('/api/sessions/:id/voice/transcribe', async (request, reply) => {
    // `liveSttUrl` is a live (no-restart) `SETTINGS_FIELDS` entry (PA-20),
    // so this is re-derived per request rather than captured once at plugin
    // registration — a route plugin's setup body runs exactly once at boot,
    // which would otherwise pin every future request to whatever the value
    // was then. Constructing a `LiveSttClient` is cheap (wraps `fetch`,
    // opens nothing eagerly), so there's no cost to not caching it.
    const client = config.liveSttUrl ? createLiveSttClient(config.liveSttUrl) : null;
    if (!client) {
      return reply.code(503).send({
        error: { code: 'voice_disabled', message: 'Voice input is not configured on this server.' },
      });
    }

    const session = sessions.find(request.params.id);
    if (!session) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such session.' } });
    }

    const parsed = VoiceTranscribeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const pcm16 = Buffer.from(parsed.data.audio.data, 'base64');
    // Defense in depth: the schema already bounds the base64 *string* length
    // (`LIMITS.maxVoiceAudioBase64Chars`), but that's an upper bound on the
    // encoded form, not an exact one — check the decoded byte count too.
    if (pcm16.length > LIMITS.maxVoiceAudioBytes) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Audio exceeds the size limit.' } });
    }
    if (pcm16.length === 0) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'Audio is empty.' } });
    }

    try {
      const text = await client.transcribe(pcm16, config.liveSttModel);
      return reply.send({ text });
    } catch (err) {
      if (err instanceof LiveSttError) {
        return reply.code(err.retryable ? 503 : 502).send({
          error: { code: err.retryable ? 'voice_service_busy' : 'voice_service_error', message: err.message },
        });
      }
      throw err;
    }
  });

  /**
   * PA-81: Query models available on live-stt (covers ASR and TTS).
   */
  app.get('/api/voice/models', async (request, reply) => {
    const rawUrl = config.liveSttUrl;
    if (!rawUrl) {
      return reply.code(503).send({
        error: { code: 'voice_disabled', message: 'Voice service is not configured on this server.' },
      });
    }
    const client = createLiveSttClient(rawUrl);
    try {
      const models = await client.listModels();
      return reply.send({ models });
    } catch (err) {
      if (err instanceof LiveSttError) {
        return reply.code(err.retryable ? 503 : 502).send({
          error: { code: err.retryable ? 'voice_service_busy' : 'voice_service_error', message: err.message },
        });
      }
      throw err;
    }
  });

  /**
   * PA-81: Test STT transcription against live-stt using an embedded audio sample.
   */
  app.post('/api/voice/test-stt', async (request, reply) => {
    const parsed = VoiceTestSttRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const rawUrl = parsed.data.liveSttUrl?.trim() || config.liveSttUrl;
    if (!rawUrl) {
      return reply.code(400).send({
        error: { code: 'voice_disabled', message: 'Voice service URL is not configured.' },
      });
    }

    const client = createLiveSttClient(rawUrl);
    const model = parsed.data.model !== undefined ? parsed.data.model.trim() : (config.liveSttModel ?? undefined);
    const pcm16 = getTestUtterancePcm16();

    const start = performance.now();
    try {
      const transcript = await client.transcribe(pcm16, model || undefined);
      const durationMs = Math.round(performance.now() - start);
      return reply.send({ ok: true, transcript, durationMs });
    } catch (err) {
      if (err instanceof LiveSttError) {
        return reply.code(err.retryable ? 503 : 502).send({
          error: { code: err.retryable ? 'voice_service_busy' : 'voice_service_error', message: err.message },
        });
      }
      throw err;
    }
  });

  /**
   * PA-81: Test TTS speech synthesis against live-stt and return PCM16 audio.
   */
  app.post('/api/voice/test-tts', async (request, reply) => {
    const parsed = VoiceTestTtsRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const rawUrl = parsed.data.liveSttUrl?.trim() || config.liveSttUrl;
    if (!rawUrl) {
      return reply.code(400).send({
        error: { code: 'voice_disabled', message: 'Voice service URL is not configured.' },
      });
    }

    const client = createLiveSttClient(rawUrl);
    const model = parsed.data.model !== undefined ? parsed.data.model.trim() : (config.liveSttTtsModel ?? undefined);
    const text = parsed.data.text?.trim() || 'This is a test of the speech synthesis service in Pocket Agent.';

    const start = performance.now();
    try {
      const speech = await client.synthesize(text, model || undefined);
      const durationMs = Math.round(performance.now() - start);
      return reply.send({
        ok: true,
        audio: speech.pcm.toString('base64'),
        sampleRateHz: speech.sampleRateHz,
        durationMs,
      });
    } catch (err) {
      if (err instanceof LiveSttError) {
        return reply.code(err.retryable ? 503 : 502).send({
          error: { code: err.retryable ? 'voice_service_busy' : 'voice_service_error', message: err.message },
        });
      }
      throw err;
    }
  });
};
