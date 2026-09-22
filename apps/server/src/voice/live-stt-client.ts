/**
 * Thin HTTP client for `live-stt` (PA-20), the self-hosted ASR/TTS service.
 * Isolates the wire contract to one file, since it was learned by reading
 * the real service's source (`~/src/live-stt`), not from documentation —
 * see the PA-20 implementation plan's §5.1/§9 for what was verified and why.
 *
 * Phase 1 (push-to-talk) added `transcribe()`. `synthesize()` (Phase 3) is
 * called once per already-chunked sentence from `voice/tts-service.ts` — see
 * the plan's D5/D6: no `stream: true` (live-stt's own streaming mode
 * multiplexes several independently-encoded files over one chunked-transfer
 * response, which this client would then have to re-split — pointless when
 * the caller already sentence-chunks) and `response_format: 'pcm'`, not the
 * default `mp3` (which pipes through `ffmpeg` and, on failure, silently
 * falls back to raw WAV while still labelling the response `audio/mpeg`).
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
 * live-stt's default TTS model (`kokoro-82m-v1`) emits 24kHz mono PCM16 — a
 * fact about that specific model, not something the `/v1/audio/speech`
 * response headers report back, so it has to be hardcoded rather than read
 * off the wire. This client never passes a `model` override, so this is
 * always correct *today*; if live-stt's default model ever changes, this
 * constant has to change with it — flagged rather than silently wrong,
 * since a mismatched sample rate makes played-back speech sound pitched.
 */
const TTS_SAMPLE_RATE_HZ = 24000;

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

/** `tts_http.py`'s error envelope is flatter than transcribe's: `{"error": "..."}`. */
function parseSpeechError(status: number, body: unknown): LiveSttError {
  const message =
    body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `live-stt returned ${status}`;
  return new LiveSttError(message, status === 503);
}

export interface SynthesizedSpeech {
  pcm: Buffer;
  sampleRateHz: number;
}

export interface LiveSttClient {
  /** Transcribes one buffered utterance. Throws `LiveSttError` on any failure. */
  transcribe(pcm16: Buffer): Promise<string>;
  /** Synthesizes one already-chunked sentence. Throws `LiveSttError` on any failure. */
  synthesize(text: string): Promise<SynthesizedSpeech>;
}

export function createLiveSttClient(rawBaseUrl: string, fetchImpl: typeof fetch = fetch): LiveSttClient {
  // Stripped here, not by the caller: `liveSttUrl` used to be boot-only
  // (`config/index.ts`'s `loadConfig` normalized it once via `new URL(...)`),
  // but is now a live `SETTINGS_FIELDS` entry (PA-20) whose `nullableStr`
  // parse/serialize is a plain passthrough with no normalization — a value
  // set via the Settings UI would otherwise reach here with a trailing
  // slash intact, producing a double slash against `/v1/audio/...` that
  // this codebase has no evidence live-stt's simple route dispatch
  // tolerates. Doing it here covers both origins uniformly.
  const baseUrl = rawBaseUrl.replace(/\/$/, '');
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

    async synthesize(text: string): Promise<SynthesizedSpeech> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: text, response_format: 'pcm' }),
        });
      } catch (err) {
        throw new LiveSttError(
          `Could not reach the voice service: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      if (!response.ok) {
        const text2 = await response.text();
        let body: unknown;
        try {
          body = text2 ? JSON.parse(text2) : {};
        } catch {
          body = {};
        }
        throw parseSpeechError(response.status, body);
      }

      const arrayBuffer = await response.arrayBuffer();
      return { pcm: Buffer.from(arrayBuffer), sampleRateHz: TTS_SAMPLE_RATE_HZ };
    },
  };
}
