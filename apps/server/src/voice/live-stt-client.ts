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

export interface LiveSttModelEntry {
  id: string;
  type: string;
  default?: boolean;
  sampleRate?: number;
}

/**
 * One word live-stt reported, with its own confidence (PA-85 / LS-7).
 *
 * `confidence` is optional rather than defaulted, deliberately: a live-stt
 * predating LS-7 answers `verbose_json` with no such key, and substituting a
 * number there would be inventing evidence. The harness reading this treats
 * absent as "no signal" and falls back to its text-only rules.
 */
export interface LiveSttWord {
  word: string;
  start?: number;
  end?: number;
  confidence?: number;
}

/**
 * PA-85: `transcribe()` used to return a bare string. It now returns the
 * evidence the harness needs alongside it — see `TranscriptWord` in the
 * protocol package for why per-word confidence is the right discriminator for
 * filtering non-speech, and why it had to be unlocked in live-stt first.
 *
 * `words` is `[]` (not undefined) when live-stt answered with an empty list,
 * and undefined only when the response carried no `words` key at all — which
 * is how a caller tells "this service does not report words" from "it reported
 * none for this audio".
 */
export interface TranscriptionResult {
  text: string;
  words?: LiveSttWord[];
  durationSec?: number;
}

export interface LiveSttClient {
  /** Transcribes one buffered utterance. Throws `LiveSttError` on any failure. */
  transcribe(pcm16: Buffer, model?: string | null): Promise<TranscriptionResult>;
  /** Synthesizes one already-chunked sentence. Throws `LiveSttError` on any failure. */
  synthesize(text: string, model?: string | null): Promise<SynthesizedSpeech>;
  /** Fetches available model list from `GET /v1/models`. */
  listModels(): Promise<LiveSttModelEntry[]>;
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
    async transcribe(pcm16: Buffer, model?: string | null): Promise<TranscriptionResult> {
      const wav = pcm16ToWav(pcm16);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
      // `verbose_json` rather than `json` (PA-85): it is the only response
      // format that carries per-word timings and — since LS-7 — the ASR's own
      // per-word confidence, which is what the browser's utterance harness
      // gates on. Same request, same cost: this is a richer serialization of
      // a transcription live-stt already performed, not extra work asked of
      // it, which is the whole reason this beats adding an LLM filter.
      form.append('response_format', 'verbose_json');
      if (model?.trim()) {
        form.append('model', model.trim());
      }

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

      // Everything past `text` is optional evidence, so a malformed or absent
      // `words`/`duration` degrades to "no signal" instead of failing a
      // transcription that otherwise succeeded. A voice feature that started
      // erroring because the harness's *optional* input was missing would be
      // a strictly worse outcome than the noise the harness exists to filter.
      const rawWords = (body as { words?: unknown }).words;
      const words = Array.isArray(rawWords)
        ? rawWords.flatMap((entry): LiveSttWord[] => {
            if (!entry || typeof entry !== 'object') return [];
            const w = entry as { word?: unknown; start?: unknown; end?: unknown; confidence?: unknown };
            if (typeof w.word !== 'string') return [];
            return [
              {
                word: w.word,
                ...(typeof w.start === 'number' ? { start: w.start } : {}),
                ...(typeof w.end === 'number' ? { end: w.end } : {}),
                ...(typeof w.confidence === 'number' ? { confidence: w.confidence } : {}),
              },
            ];
          })
        : undefined;

      const rawDuration = (body as { duration?: unknown }).duration;
      const durationSec = typeof rawDuration === 'number' ? rawDuration : undefined;

      return {
        text: transcript,
        ...(words ? { words } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
      };
    },

    async synthesize(text: string, model?: string | null): Promise<SynthesizedSpeech> {
      let response: Response;
      const payload: Record<string, unknown> = {
        input: text,
        response_format: 'pcm',
      };
      if (model?.trim()) {
        payload.model = model.trim();
      }

      try {
        response = await fetchImpl(`${baseUrl}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
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
      const sampleRateHz = model?.toLowerCase().includes('piper') ? 22050 : TTS_SAMPLE_RATE_HZ;
      return { pcm: Buffer.from(arrayBuffer), sampleRateHz };
    },

    async listModels(): Promise<LiveSttModelEntry[]> {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/v1/models`);
      } catch {
        return [];
      }
      if (!response.ok) return [];
      try {
        const body = (await response.json()) as {
          data?: Array<{ id: string; type: string; default?: boolean; sample_rate?: number }>;
        };
        if (!body || !Array.isArray(body.data)) return [];
        return body.data.map((m) => ({
          id: m.id,
          type: m.type,
          default: m.default,
          sampleRate: m.sample_rate,
        }));
      } catch {
        return [];
      }
    },
  };
}
