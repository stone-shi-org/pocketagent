/**
 * Pure PCM helpers for PA-20 voice capture.
 *
 * Kept separate from `capture.ts` (which touches `getUserMedia`/
 * `AudioContext`/`AudioWorkletNode`, none of which exist under vitest's
 * `node` test environment — see `vitest.config.ts`'s `web` project) so the
 * actual resample/convert/encode math has real unit test coverage instead of
 * only ever running for the first time in a real browser.
 */

/**
 * Linear-interpolation resample to `live-stt`'s required 16kHz. Good enough
 * for 16kHz speech capture, not broadcast-quality — the source is always a
 * human's own microphone here, never a wire down-conversion of studio audio,
 * so a cheap resampler is the right trade.
 */
export function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate || input.length === 0) return input;
  const ratio = inputRate / outputRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIndex = i * ratio;
    const lo = Math.floor(srcIndex);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = srcIndex - lo;
    // `lo`/`hi` are always in `[0, input.length - 1]` by construction
    // (`hi` explicitly clamped, `lo` derived from an `i < outLength` loop
    // bound tied to the same ratio) — `noUncheckedIndexedAccess` can't see
    // that invariant, hence the assertions rather than a runtime fallback
    // that would silently paper over a real bug if it were ever violated.
    output[i] = input[lo]! * (1 - frac) + input[hi]! * frac;
  }
  return output;
}

/**
 * Float32 samples in `[-1, 1]` to signed 16-bit PCM. Clamped rather than
 * wrapped on an out-of-range sample — a rare clipped peak should saturate,
 * not alias into noise live-stt would have to transcribe.
 */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]!));
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return output;
}

/**
 * Base64-encodes raw PCM16 samples without a `data:` URL or `Buffer`
 * (unavailable in the browser). Chunked so `String.fromCharCode` never
 * receives more arguments than an engine's call-stack tolerates for a long
 * recording — `LIMITS.maxVoiceAudioBytes` allows up to ~60s, which at 16kHz
 * mono 16-bit is ~2,000,000 samples.
 */
export function int16ArrayToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * The playback-side inverse of `int16ArrayToBase64` — decodes a `tts_audio`
 * frame's `data` field back into PCM16 samples. `atob` (not `Buffer`,
 * unavailable in the browser) plus a byte-by-byte `Uint8Array` fill, which
 * is the standard base64-to-bytes idiom without a `Buffer` polyfill.
 */
export function base64ToInt16Array(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

/**
 * Signed 16-bit PCM back to Float32 `[-1, 1]` — the shape
 * `AudioBuffer.copyToChannel`/`getChannelData` needs to actually play a
 * `tts_audio` chunk through the Web Audio API. The exact inverse of
 * `floatTo16BitPcm`'s two-sided scale (`0x8000` for negative, `0x7fff` for
 * non-negative), so a round trip through both functions is lossless up to
 * quantization — not the same expression as one might naively apply to
 * every sample uniformly.
 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    output[i] = s < 0 ? s / 0x8000 : s / 0x7fff;
  }
  return output;
}
