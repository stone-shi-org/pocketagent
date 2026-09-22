/**
 * Voice-activity endpointing for PA-20 Phase 2 (live-listen mode).
 *
 * The ticket's own recommendation was Silero VAD via WASM. This ships a
 * simpler RMS-energy state machine with hysteresis and a hangover timer
 * instead — a deliberate scope decision, not an oversight: this environment
 * has no way to load/verify a WASM+ONNX model against a real microphone
 * (no real browser, no real audio hardware), so shipping an unverified
 * third-party inference pipeline would be worse than a simpler mechanism
 * that is fully covered by real unit tests below. Swapping in Silero later
 * is a clean, additive change — `LiveListenController` (`live-listen.ts`)
 * only depends on `SpeechEndpointer.push()`'s three-state contract, not on
 * how the RMS value it's fed was computed.
 *
 * Pure and stateful-but-isolated (no browser APIs) so the endpointing logic
 * itself has real test coverage, independent of whether a mic is present.
 */

export interface VadOptions {
  /** RMS at or above which a frame counts as speech. */
  speechThreshold: number;
  /** RMS below which a frame counts as silence. Lower than `speechThreshold`
   *  (hysteresis) so energy hovering right at one level doesn't chatter
   *  between states frame to frame. */
  silenceThreshold: number;
  /** Continuous silence (ms) required before declaring end-of-turn — the
   *  "trailing silence hangover" the PA-20 ticket calls out as the main
   *  quality knob for false triggers (a mid-sentence thinking pause). */
  hangoverMs: number;
  /** Speech shorter than this (ms) is discarded as noise rather than
   *  producing a `speech_end` transition — a cough or a door slam should not
   *  submit an empty/garbage utterance. */
  minSpeechMs: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  speechThreshold: 0.02,
  silenceThreshold: 0.012,
  hangoverMs: 800,
  minSpeechMs: 250,
};

export type VadTransition = 'speech_start' | 'speech_end' | null;

/** Root-mean-square energy of one audio frame — the endpointer's only input. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
  return Math.sqrt(sum / frame.length);
}

/**
 * A two-state (`idle` / `speaking`) endpointer. Feed it one frame's RMS and
 * timestamp at a time; it reports a transition exactly when one happens, and
 * `null` on every other frame — the caller (`LiveListenController`) buffers
 * audio between `speech_start` and `speech_end` and does nothing in between.
 */
export class SpeechEndpointer {
  private state: 'idle' | 'speaking' = 'idle';
  private silenceSinceMs: number | null = null;
  private speechStartedAtMs: number | null = null;

  constructor(private readonly opts: VadOptions = DEFAULT_VAD_OPTIONS) {}

  push(energy: number, atMs: number): VadTransition {
    if (this.state === 'idle') {
      if (energy >= this.opts.speechThreshold) {
        this.state = 'speaking';
        this.speechStartedAtMs = atMs;
        this.silenceSinceMs = null;
        return 'speech_start';
      }
      return null;
    }

    // state === 'speaking'
    if (energy < this.opts.silenceThreshold) {
      if (this.silenceSinceMs === null) this.silenceSinceMs = atMs;
      if (atMs - this.silenceSinceMs >= this.opts.hangoverMs) {
        // Measured up to when silence *began*, not up to now — using `atMs`
        // here would fold the hangover wait itself into "how long they
        // spoke," which would let a blip well under `minSpeechMs` sail
        // through just because the hangover window is long enough.
        const spoke =
          this.speechStartedAtMs !== null &&
          this.silenceSinceMs - this.speechStartedAtMs >= this.opts.minSpeechMs;
        this.reset();
        return spoke ? 'speech_end' : null;
      }
      return null;
    }

    // Still loud enough to count as ongoing speech — cancel any hangover
    // countdown a brief dip below `silenceThreshold` may have started.
    this.silenceSinceMs = null;
    return null;
  }

  /** Force back to `idle` — used on barge-in (a fresh utterance starting
   *  while TTS plays) and when live-listen mode is turned off. */
  reset(): void {
    this.state = 'idle';
    this.silenceSinceMs = null;
    this.speechStartedAtMs = null;
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }
}
