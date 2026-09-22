import { z } from 'zod';

/**
 * A recorded utterance uploaded for transcription (PA-20, Phase 1: push-to-talk).
 *
 * Its own file for the same reason `prompt-image.ts` is: `http.ts` needs it,
 * and a future `ws.ts` frame (Phase 2+, TTS audio down) will too — `ws.ts`
 * already imports from other protocol modules that would create a cycle if
 * this shape lived in one of them.
 *
 * Raw 16kHz mono PCM16, base64-encoded, no container/header — the exact
 * sample format `live-stt` requires (see the PA-20 implementation plan's
 * §5.1: the server wraps this in a WAV header before forwarding it to
 * `live-stt`'s `multipart/form-data` endpoint, so the browser never needs to
 * do any container encoding, just capture and base64).
 */

/** Raw PCM16 byte cap, before base64 encoding — ~60s of 16kHz mono audio plus headroom. */
export const MAX_VOICE_AUDIO_BYTES = 10 * 1024 * 1024;

/** Base64 inflates by 4/3; this is the cap actually applied to `audio.data`. */
export const MAX_VOICE_AUDIO_BASE64_CHARS = Math.ceil((MAX_VOICE_AUDIO_BYTES * 4) / 3);

export const VoiceAudioUpload = z.object({
  /** Raw base64 16kHz mono PCM16 samples, no `data:` URL prefix. */
  data: z.string().min(1, 'Audio data is required.').max(MAX_VOICE_AUDIO_BASE64_CHARS),
  durationMs: z.number().nonnegative(),
});
export type VoiceAudioUpload = z.infer<typeof VoiceAudioUpload>;

/**
 * One word of a transcript, with the ASR's own confidence in it (PA-85, and
 * LS-7 on the live-stt side).
 *
 * live-stt computed this all along — `proto/livestt/v1/asr.proto`'s `Word`
 * carries a `confidence` float, and `transcribe_http.py` accumulated it — but
 * its `verbose_json` serializer dropped the field, so nothing downstream could
 * read it. LS-7 added it; this is the shape it emits.
 *
 * Every field is optional because this is *evidence, not a contract*: a
 * live-stt predating LS-7 answers `verbose_json` with no `confidence` key, and
 * a server predating this change answers `{ text }` with no `words` at all.
 * The harness that reads this must degrade to "no confidence signal available"
 * rather than treat a missing number as a low one — a filter that silently
 * became strict against an older voice service would drop real commands and
 * look like a broken microphone.
 *
 * `confidence` is *not* comparable across live-stt's ASR backends: whisper
 * reports the mean token probability over the word, parakeet the `min` over
 * its tokens. Both are "higher is better" in (0,1], so a threshold is
 * meaningful against either, but one tuned on one backend does not transfer
 * exactly to the other. Raised as an open question on LS-7 rather than
 * papered over here.
 */
export const TranscriptWord = z.object({
  word: z.string(),
  start: z.number().optional(),
  end: z.number().optional(),
  confidence: z.number().optional(),
});
export type TranscriptWord = z.infer<typeof TranscriptWord>;
