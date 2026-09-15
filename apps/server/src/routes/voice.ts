import type { FastifyPluginAsync } from 'fastify';
import { LIMITS, VoiceTranscribeRequest } from '@pocketagent/protocol';
import { createLiveSttClient, LiveSttError } from '../voice/live-stt-client.js';

/**
 * PA-20 Phase 1: push-to-talk transcription.
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

  // Constructed once at boot from a fixed `Config` value — a set-but-invalid
  // `POCKETAGENT_LIVE_STT_URL` already fails `loadConfig` before this ever
  // runs, so there is nothing left to validate here, only "configured or not".
  const client = config.liveSttUrl ? createLiveSttClient(config.liveSttUrl) : null;

  app.post<{ Params: { id: string } }>('/api/sessions/:id/voice/transcribe', async (request, reply) => {
    if (!client) {
      return reply.code(503).send({
        error: { code: 'voice_disabled', message: 'Voice input is not configured on this server.' },
      });
    }

    const session = sessions.get(request.params.id);
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
      const text = await client.transcribe(pcm16);
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
};
