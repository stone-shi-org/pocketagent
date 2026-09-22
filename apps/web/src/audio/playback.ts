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
  /**
   * PA-83: `stopped` alone is not a stop — `enqueue()` cleared it on the
   * very next chunk, which is correct for "this turn ended, here comes the
   * next one" and catastrophic for "the user pressed stop". A reply's
   * remaining sentences are already synthesized and in flight over the
   * socket when the stop happens, so each arriving chunk un-paused the
   * queue and playback resumed a moment later — the reported "I clicked
   * stop / switched the stream off and it keeps talking". `muted` is the
   * durable half: it survives every subsequent `enqueue()` and is cleared
   * only by `arm()`, which the caller invokes when a genuinely new turn
   * starts. Mirrors `VoiceTtsService.mutedUntilNextTurn` on the server,
   * deliberately — the two halves of one rule ("stopped stays stopped
   * until a new turn"), each enforced where its own audio actually lives.
   */
  private muted = false;
  /**
   * PA-85: a *reversible* halt, unlike `stop()`/`muted`.
   *
   * Two-stage barge-in needs to silence the talk-back the instant energy is
   * detected — waiting for the transcript would mean the agent talks over the
   * whole interruption — but at that point nothing yet knows whether the
   * sound was a command or a cough. `stop()` cannot serve: it is deliberately
   * durable (PA-83) and discards the queue, so a cough would permanently
   * silence a reply mid-sentence. So the fast path pauses, the harness's
   * verdict then either commits (`stop()`) or undoes it (`resume()`).
   *
   * Deliberately *not* folded into `stopped`: `enqueue` drops chunks while
   * `muted` and must keep buffering them while merely paused, or resuming
   * would replay a reply with a hole in it.
   */
  private paused = false;
  /** The chunk currently being played, kept so `pause()` can put it back at
   *  the head of the queue. One chunk is one sentence (`sentence-chunker.ts`),
   *  so resuming replays that sentence from its start rather than losing it —
   *  `AudioBufferSourceNode` has no resume-from-offset, and re-hearing one
   *  sentence is a far better outcome than silently skipping it. */
  private currentChunk: { pcm: Int16Array; sampleRateHz: number } | null = null;
  /**
   * True for as long as a `pump()` call is still inside its loop, which is
   * *not* the same as `playing`.
   *
   * `pause()` sets `playing = false` immediately so `isPlaying()` — and the
   * "Speaking…" indicator reading it — reflects the halt at once. But the
   * `pump()` that was running is still parked on `await playChunk(...)` until
   * the stopped source fires `onended`. A `resume()` landing in that window
   * would see `!playing` and start a *second* pump against the same queue,
   * and the two would shift chunks out from under each other. Reachable only
   * on a sub-millisecond pause/resume pair, which the real callers cannot
   * produce (a discard is at least one audio frame after a start, and a
   * verdict is a network round trip later) — guarded anyway, because the
   * symptom would be garbled overlapping speech that no test would catch.
   */
  private pumpActive = false;

  constructor(private readonly onPlaybackStateChange?: (playing: boolean) => void) {}

  /** Enqueue one chunk's base64 PCM16 (empty `data` on a `done` marker is a
   *  no-op — nothing to play, it exists only as an end-of-turn signal). */
  enqueue(base64Data: string, sampleRateHz: number): void {
    if (base64Data.length === 0) return;
    // Dropped outright rather than buffered: a muted turn's audio is never
    // wanted later, and keeping it would make `arm()` replay a stale reply
    // over the top of the new one it was called for.
    if (this.muted) return;
    this.stopped = false;
    this.queue.push({ pcm: base64ToInt16Array(base64Data), sampleRateHz });
    // Buffered but not started while paused — a barge-in under evaluation
    // must not be drowned out by the next sentence arriving over the socket.
    if (!this.pumpActive && !this.paused) void this.pump();
  }

  /**
   * PA-83: allow speech again after a `stop()`. Called when a genuinely new
   * turn begins (the `user_prompt` event, or live-listen being switched
   * back on) — never on a mere incoming chunk, which is exactly the
   * "un-stop itself" behaviour that made a stop temporary.
   */
  arm(): void {
    this.muted = false;
    // A genuinely new turn supersedes any *paused* remnant of the previous
    // one — clearing the flag alone would let the old reply's parked
    // sentences play underneath the new one. Guarded on `paused` so the
    // non-paused path stays byte-identical to PA-83's own behaviour, where
    // `arm()` deliberately touches nothing but the mute.
    if (this.paused) {
      this.paused = false;
      this.currentChunk = null;
      this.queue = [];
    }
  }

  /**
   * PA-85, stage one of barge-in: silence playback now, keep everything so it
   * can be undone. Idempotent, and a no-op once `stop()` has been called —
   * a durable stop must not be downgradeable to a pause.
   */
  pause(): void {
    if (this.paused || this.muted) return;
    this.paused = true;
    this.stopped = true;
    // Back to the head of the queue so `resume()` replays this sentence
    // whole. Done before stopping the source: `stop()` synchronously fires
    // `onended`, which lets `pump()` proceed.
    if (this.currentChunk) {
      this.queue.unshift(this.currentChunk);
      this.currentChunk = null;
    }
    try {
      this.currentSource?.stop();
    } catch {
      // Already stopped/ended — same reason `stop()` below swallows this.
    }
    this.currentSource = null;
    this.playing = false;
  }

  /**
   * PA-85, the undo: the utterance that triggered the pause turned out to be
   * junk, so carry on reading. A no-op if a real stop happened in between,
   * so a `stop()` racing a verdict still wins.
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.muted) return;
    this.stopped = false;
    // `pumpActive`, not `playing`: see its own comment for why the two differ
    // exactly inside this window.
    if (this.queue.length > 0 && !this.pumpActive) void this.pump();
  }

  isPaused(): boolean {
    return this.paused;
  }

  private async pump(): Promise<void> {
    if (this.pumpActive) return;
    this.pumpActive = true;
    this.playing = true;
    this.onPlaybackStateChange?.(true);
    while (this.queue.length > 0 && !this.stopped && !this.paused) {
      const chunk = this.queue.shift()!;
      this.currentChunk = chunk;
      await this.playChunk(chunk);
      // Cleared only on an *uninterrupted* finish. `pause()` reads this to
      // decide what to put back, so clearing it unconditionally would lose
      // the sentence that was playing when the pause landed.
      if (!this.paused) this.currentChunk = null;
    }
    this.pumpActive = false;
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
   *
   * PA-83: also a *durable* stop (see `muted`) — nothing plays again until
   * `arm()`. That is what every caller here already meant: barge-in is
   * followed by the user's own utterance (whose `user_prompt` re-arms),
   * and every other caller is an explicit "stop talking".
   */
  stop(): void {
    this.muted = true;
    this.stopped = true;
    // A durable stop supersedes a pause in both directions: `resume()` must
    // not revive it, and the sentence `pause()` parked must not come back.
    this.paused = false;
    this.currentChunk = null;
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
