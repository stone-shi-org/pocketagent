import type { SynthesizedSpeech } from './live-stt-client.js';

export interface TtsAudioChunk {
  turnId: string;
  sentenceSeq: number;
  /** Base64 raw PCM16 mono. Empty on the final, `done` chunk. */
  data: string;
  sampleRateHz: number;
  done: boolean;
}

/**
 * Synthesizes and emits one turn's TTS audio, one sentence at a time, in
 * strict order.
 *
 * A promise chain rather than a loop over an async queue: each call to
 * `push()` appends `.then(...)` to `this.queue`, so sentences are always
 * synthesized and emitted in the order they were pushed even though
 * `synthesize()` calls are async and could otherwise race. This is what
 * makes `cancel()` safe to call from anywhere (the interrupt handler) —
 * every step checks `cancelled` both before starting work and again after
 * the `await`, so a cancellation that lands mid-synthesis still suppresses
 * that call's result rather than emitting stale audio for a turn the user
 * already interrupted (PA-20 Phase 4's barge-in requirement).
 */
export class TurnTtsPump {
  private queue: Promise<void> = Promise.resolve();
  private cancelled = false;
  private sentenceSeq = 0;

  constructor(
    private readonly turnId: string,
    private readonly synthesize: (text: string) => Promise<SynthesizedSpeech>,
    private readonly onChunk: (chunk: TtsAudioChunk) => void,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Enqueue one sentence. Resolves in order relative to every other push(). */
  push(sentence: string): void {
    if (this.cancelled) return;
    this.queue = this.queue.then(async () => {
      if (this.cancelled) return;
      let speech: SynthesizedSpeech;
      try {
        speech = await this.synthesize(sentence);
      } catch (err) {
        // A TTS failure must not break the turn — the text reply already
        // succeeded and is already on screen; losing just the audio for one
        // sentence is a degraded experience, not a broken one. Reported so
        // the caller can log/notify, never thrown back into the chain (that
        // would abandon every sentence still queued behind this one).
        if (!this.cancelled) this.onError(err);
        return;
      }
      if (this.cancelled) return;
      this.onChunk({
        turnId: this.turnId,
        sentenceSeq: this.sentenceSeq++,
        data: speech.pcm.toString('base64'),
        sampleRateHz: speech.sampleRateHz,
        done: false,
      });
    });
  }

  /** Call once the turn is fully known to be over — emits the final `done`
   *  marker after every already-queued sentence has been synthesized. */
  finish(): void {
    if (this.cancelled) return;
    this.queue = this.queue.then(() => {
      if (this.cancelled) return;
      this.onChunk({
        turnId: this.turnId,
        sentenceSeq: this.sentenceSeq++,
        data: '',
        sampleRateHz: 0,
        done: true,
      });
    });
  }

  /** Stop emitting anything further for this turn — already-in-flight
   *  synthesis calls are let run to completion (nothing to `AbortController`
   *  here, and their result is simply dropped), but no more chunks reach
   *  `onChunk` after this. Idempotent. */
  cancel(): void {
    this.cancelled = true;
  }
}
