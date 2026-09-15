/**
 * Thin HTTP client for `live-stt` (PA-20), the self-hosted ASR/TTS service.
 * Isolates the wire contract to one file, since it was learned by reading
 * the real service's source (`~/src/live-stt`), not from documentation —
 * see the PA-20 implementation plan's §5.1/§9 for what was verified and why.
 *
 * Phase 1 (push-to-talk) only needs `transcribe()`. `synthesize()` lands in
 * a later phase alongside the sentence-chunked TTS pipeline (plan §5.4).
 *
 * Uses Node's built-in `fetch`/`FormData`/`Blob` (Node 22+, no dependency
 * needed) to build the outbound `multipart/form-data` request — that global
 * surface is for building an outbound request, unlike `@fastify/multipart`
 * (for parsing an *inbound* one), which this server does not need here since
 * the browser uploads plain JSON with base64 audio, not multipart (PA-20
 * plan D2).
 */

const SAMPLE_RATE_HZ = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/**
 * Thrown for every failure this client can distinguish. `retryable` is set
 * for exactly the conditions live-stt itself considers transient (503s for
 * VRAM/capacity/draining, and a connection failure) — never retried
 * automatically here (no timeout-into-retry-storm, this app's existing
 * no-decay posture elsewhere), just surfaced so the caller can show "voice
 * service busy, try again" instead of a generic error.
 */
export class LiveSttError extends Error {
  override readonly name = 'LiveSttError';
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/**
 * Wraps raw PCM16 samples in a minimal RIFF/WAV header. live-stt's
 * `/v1/audio/transcriptions` requires a WAV file, not a raw-bytes body
 * (verified against `live_stt/transcribe_http.py`'s `_pcm16_mono_16k_from_wav`)
 * — the browser only ever captures/uploads raw samples (PA-20 plan §6.1), so
 * the server is what turns that into a file live-stt will accept.
 */
export function pcm16ToWav(pcm16: Buffer): Buffer {
  const byteRate = (SAMPLE_RATE_HZ * CHANNELS * BITS_PER_SAMPLE) / 8;
  const blockAlign = (CHANNELS * BITS_PER_SAMPLE) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm16.length, 40);

  return Buffer.concat([header, pcm16]);
}

/** `transcribe_http.py`'s error envelope: `{"error": {"message": "..."}}`. */
function parseTranscribeError(status: number, body: unknown): LiveSttError {
  const message =
    body && typeof body === 'object' && 'error' in body
      ? ((body as { error?: { message?: string } }).error?.message ?? `live-stt returned ${status}`)
      : `live-stt returned ${status}`;
  return new LiveSttError(message, status === 503);
}

export interface LiveSttClient {
  /** Transcribes one buffered utterance. Throws `LiveSttError` on any failure. */
  transcribe(pcm16: Buffer): Promise<string>;
}

export function createLiveSttClient(baseUrl: string, fetchImpl: typeof fetch = fetch): LiveSttClient {
  return {
    async transcribe(pcm16: Buffer): Promise<string> {
      const wav = pcm16ToWav(pcm16);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      form.append('response_format', 'json');

      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/audio/transcriptions`, {
          method: 'POST',
          body: form,
        });
      } catch (err) {
        throw new LiveSttError(
          `Could not reach the voice service: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new LiveSttError('The voice service returned an unreadable response.', false);
      }

      if (!response.ok) throw parseTranscribeError(response.status, body);

      const transcript = (body as { text?: unknown }).text;
      if (typeof transcript !== 'string') {
        throw new LiveSttError('The voice service response was missing a transcript.', false);
      }
      return transcript;
    },
  };
}
