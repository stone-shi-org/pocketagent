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
