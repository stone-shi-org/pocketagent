import { base64ToInt16Array, int16ToFloat32 } from './pcm.js';

/**
 * Plays a structured session's `tts_audio` chunks (PA-20 Phase 3) in order,
 * one sentence at a time, via the Web Audio API — raw PCM16 (per the PA-20
 * plan's D6), so each chunk becomes an `AudioBuffer` directly with no
 * container/codec decode step (`decodeAudioData`, which has real
 * cross-browser quirks for less-common formats).
 *
 * A queue rather than firing all chunks at once: they arrive as the reply
 * streams, well before earlier ones have finished playing, and must be
 * heard in the order the reply was written, not the order the network
 * happened to deliver them.
 */
export class TtsPlaybackQueue {
  private context: AudioContext | null = null;
  private queue: { pcm: Int16Array; sampleRateHz: number }[] = [];
  private playing = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private stopped = false;

  constructor(private readonly onPlaybackStateChange?: (playing: boolean) => void) {}

  /** Enqueue one chunk's base64 PCM16 (empty `data` on a `done` marker is a
   *  no-op — nothing to play, it exists only as an end-of-turn signal). */
  enqueue(base64Data: string, sampleRateHz: number): void {
    if (base64Data.length === 0) return;
    this.stopped = false;
    this.queue.push({ pcm: base64ToInt16Array(base64Data), sampleRateHz });
    if (!this.playing) void this.pump();
  }

  private async pump(): Promise<void> {
    this.playing = true;
    this.onPlaybackStateChange?.(true);
    while (this.queue.length > 0 && !this.stopped) {
      const chunk = this.queue.shift()!;
      await this.playChunk(chunk);
    }
    this.playing = false;
    this.onPlaybackStateChange?.(false);
  }

  private async playChunk(chunk: { pcm: Int16Array; sampleRateHz: number }): Promise<void> {
    if (this.stopped) return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // May fail if user gesture is required by browser policy
      }
    }
    if (this.stopped) return;

    return new Promise((resolve) => {
      if (this.stopped || !this.context) {
        resolve();
        return;
      }
      const float32 = int16ToFloat32(chunk.pcm);
      const buffer = this.context.createBuffer(1, float32.length, chunk.sampleRateHz);
      buffer.getChannelData(0).set(float32);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      source.onended = () => resolve();
      this.currentSource = source;
      source.start();
    });
  }

  /**
   * Barge-in (PA-20 Phase 4): stop whatever is playing right now and discard
   * everything still queued. Idempotent and safe to call even with nothing
   * playing — the VAD's `speech_start` transition calls this unconditionally
   * the instant new speech is detected, not just while `isPlaying()`.
   */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    try {
      this.currentSource?.stop();
    } catch {
      // Already stopped/ended — `AudioBufferSourceNode.stop()` throws if
      // called on a node that never started or already finished.
    }
    this.currentSource = null;
    // `isPlaying()` must reflect the stop immediately, but the *callback*
    // deliberately isn't invoked here: calling `.stop()` above fires the
    // current chunk's `onended`, which resolves `playChunk`'s promise and
    // lets `pump()`'s own loop notice `stopped` and invoke
    // `onPlaybackStateChange(false)` exactly once, right after actually
    // finishing — invoking it here too would fire it twice for one stop.
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }
}
