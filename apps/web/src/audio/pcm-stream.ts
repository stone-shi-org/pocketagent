/**
 * PA-96: the pure halves of *streaming* audio — what Gemini Live needs and
 * the buffered push-to-talk/live-listen paths never did.
 *
 * `pcm.ts`'s `resampleLinear` works on one fully-assembled utterance. Applied
 * per 128-frame worklet quantum instead, it would restart its interpolation at
 * every quantum boundary and drop the fractional position between them — an
 * audible buzz at the quantum rate. `StreamingResampler` carries that state
 * across calls. Likewise `TtsPlaybackQueue` plays one sentence after another,
 * waiting for each `onended`; Gemini sends dozens of ~40ms chunks per second,
 * and chaining those on `onended` puts a gap (a click) between every one, so
 * playback is scheduled ahead on the audio clock instead (`scheduleChunk`).
 */

/**
 * Linear-interpolation resampler that keeps its phase across chunks, so a
 * stream resampled in pieces is sample-for-sample the stream resampled whole
 * (up to floating-point rounding).
 */
export class StreamingResampler {
  /** Position of the next output sample, in input samples, relative to the
      start of the *next* chunk (may be negative: between `last` and it). */
  private pos = 0;
  /** The previous chunk's final sample, for interpolating across the seam. */
  private last: number | null = null;
  private readonly step: number;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number,
  ) {
    this.step = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0);
    if (this.inputRate === this.outputRate) return input;
    const out: number[] = [];
    const sample = (i: number): number => {
      // i in [-1, input.length - 1]; -1 is the previous chunk's last sample.
      if (i < 0) return this.last ?? input[0]!;
      return input[i]!;
    };
    let pos = this.pos;
    // Interpolate while both neighbours are available in this chunk (or the seam).
    while (pos <= input.length - 1) {
      const lo = Math.floor(pos);
      const frac = pos - lo;
      const a = sample(lo);
      const b = lo + 1 <= input.length - 1 ? sample(lo + 1) : a;
      out.push(a * (1 - frac) + b * frac);
      pos += this.step;
    }
    this.pos = pos - input.length;
    this.last = input[input.length - 1]!;
    return Float32Array.from(out);
  }
}

/**
 * Collects samples until at least `size` are buffered, then hands them out in
 * one piece — ~100ms per WebSocket message rather than one per 8ms worklet
 * quantum, which is 12× fewer frames on a phone's radio for the same audio.
 */
export class SampleBatcher {
  private parts: Int16Array[] = [];
  private length = 0;

  constructor(private readonly size: number) {}

  push(samples: Int16Array): Int16Array | null {
    if (samples.length > 0) {
      this.parts.push(samples);
      this.length += samples.length;
    }
    return this.length >= this.size ? this.flush() : null;
  }

  flush(): Int16Array | null {
    if (this.length === 0) return null;
    const out = new Int16Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.length;
    }
    this.parts = [];
    this.length = 0;
    return out;
  }
}

/**
 * When the next chunk should start on the audio clock. Back-to-back with the
 * previous one while playback is ongoing, so there is no gap; after an
 * underrun (the network fell behind and the clock overtook the schedule),
 * restarted a little ahead of now rather than *at* now, since a start time in
 * the past is clamped by the browser and the first samples are lost.
 */
export function scheduleChunk(currentTime: number, scheduledEnd: number, leadSec = 0.04): number {
  return scheduledEnd > currentTime ? scheduledEnd : currentTime + leadSec;
}
