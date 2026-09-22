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
  /**
   * RMS at or above which a frame counts as speech — an *absolute floor*
   * since PA-85, not the whole rule: the effective threshold is this or the
   * tracked ambient noise floor times `noiseMarginMultiplier`, whichever is
   * higher (see `SpeechEndpointer.effectiveThresholds`).
   */
  speechThreshold: number;
  /** RMS below which a frame counts as silence. Lower than `speechThreshold`
   *  (hysteresis) so energy hovering right at one level doesn't chatter
   *  between states frame to frame. Also an absolute floor, scaled with
   *  `speechThreshold` when the adaptive threshold wins. */
  silenceThreshold: number;
  /** Continuous silence (ms) required before declaring end-of-turn — the
   *  "trailing silence hangover" the PA-20 ticket calls out as the main
   *  quality knob for false triggers (a mid-sentence thinking pause). */
  hangoverMs: number;
  /**
   * Speech shorter than this (ms) is discarded as noise rather than
   * producing a `speech_end` transition — a cough or a door slam should not
   * submit an empty/garbage utterance.
   *
   * PA-85 deliberately did **not** raise this. It is the obvious lever for
   * "stop sending 'oh' to the agent" and it is the wrong one: a spoken "yes"
   * or "no" runs about 300-400ms, so a floor high enough to reject a
   * throat-clear also rejects the single-word answers that are the most
   * valuable thing anyone says into a hands-free session — the same reason
   * the ticket's proposed three-word minimum was rejected. Short *and*
   * junk is separated from short *and* meant by `utterance-harness.ts`,
   * which has the transcript and the ASR's own confidence to judge with,
   * rather than by a duration threshold here that has neither.
   */
  minSpeechMs: number;
  /**
   * PA-85: the longest a single run of speech may last before it is closed
   * out regardless of what the energy is doing.
   *
   * Not a decay-into-allow timeout — it does not answer anything or relax a
   * gate, it only stops an *unbounded* state. Needed because ambient energy
   * sitting above the silence threshold means the hangover clock never
   * starts, which leaves the endpointer speaking forever: unbounded audio
   * buffering, and a barge-in pause nothing will ever resolve.
   */
  maxSpeechMs: number;
  /**
   * PA-85: how many times the tracked ambient noise floor a frame must
   * exceed to count as speech.
   *
   * `speechThreshold` alone is an *absolute* level, which is why PA-83 had
   * to expose a 1-10 sensitivity slider: no single number is right for both
   * a quiet room and a noisy one, so the user was asked to hand-tune a
   * quantity the code can measure for itself. A margin above the measured
   * floor self-calibrates, which is what removes most of the reported
   * "there was a sound, not even a word, and it sent something" class
   * before any audio is uploaded at all — no added latency, no STT call.
   *
   * It only ever makes the gate *stricter* (the absolute floor is a
   * minimum), so a quiet room behaves exactly as it did before PA-85.
   */
  noiseMarginMultiplier: number;
  /**
   * PA-85: of the frames that carried *any* sound, the fraction that must
   * have exceeded the speech threshold for the run to count as speech.
   *
   * Orthogonal to `minSpeechMs`, and it catches what a duration floor
   * cannot: a door slam or a dropped object is a sharp transient with a
   * slow decay tail, so it can *span* enough milliseconds to clear a
   * duration check while only a handful of frames were ever loud. Real
   * speech is sustained — most of its audible frames are above the
   * threshold, and what sits in the hysteresis band is a decay tail.
   *
   * The denominator is deliberately **voiced + hysteresis-band frames**, not
   * all frames in the run. Silent frames are excluded entirely, and that is
   * load-bearing rather than tidy: counting them would put every *internal*
   * pause into the denominator, so "run the tests" — long pause — "in watch
   * mode" would be *discarded as noise* at a generous `hangoverMs`, which is
   * exactly the settings combination a slow speaker would choose. It also
   * removes the need to special-case the trailing hangover, since those
   * frames are silent by definition.
   */
  minVoicedRatio: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  speechThreshold: 0.02,
  silenceThreshold: 0.012,
  hangoverMs: 800,
  minSpeechMs: 250,
  // 30s. Far longer than any real spoken instruction, because this is a
  // safety bound rather than a turn-detection knob — `hangoverMs` is what
  // ends a normal turn, and this only fires when that mechanism cannot.
  maxSpeechMs: 30_000,
  noiseMarginMultiplier: 2.5,
  minVoicedRatio: 0.35,
};

/**
 * PA-85: how fast the ambient noise floor estimate follows the room.
 *
 * Applied once per frame while idle, and a frame is one 128-sample render
 * quantum (~2.7ms at 48kHz), so 0.05 settles in roughly 50-60ms of silence.
 * Fast enough that the first utterance after switching the mic on is already
 * judged against a real measurement rather than a cold default, and slow
 * enough that it is not yanked around by one anomalous frame.
 */
const NOISE_FLOOR_ALPHA = 0.05;

/**
 * PA-83 #1: maps the Settings page's user-facing "turn detection" knobs onto
 * the RMS thresholds `SpeechEndpointer` actually reads. `sensitivity` is an
 * integer 1 (least sensitive — needs louder, clearer speech to count) to 10
 * (most sensitive — picks up much quieter speech); `silenceMs` is
 * `hangoverMs` under its Settings-page name, threaded straight through
 * rather than folded into the sensitivity scale, since "how long to wait in
 * silence before treating a turn as finished" is genuinely a separate knob
 * from "how loud does speech need to be."
 *
 * Deliberately anchored so `sensitivity === 5` reproduces
 * `DEFAULT_VAD_OPTIONS`'s thresholds exactly (0.8 ** 0 === 1) — an operator
 * who never opens the setting sees byte-identical behavior to before this
 * feature existed, and every step away from 5 scales both thresholds
 * together (preserving the hysteresis ratio between them) by a fixed 20%
 * rather than by a hand-picked pair of endpoints, which would have made 5
 * an arbitrary point on the curve instead of the anchor.
 *
 * PA-85's two additions are deliberately *not* on this scale. They are
 * relative measures already (a multiple of the measured floor, and a
 * fraction of an utterance's frames), so they mean the same thing at every
 * sensitivity setting and there is nothing for the slider to scale.
 */
export function vadOptionsForSensitivity(sensitivity: number, silenceMs: number): VadOptions {
  const clampedSensitivity = Math.min(10, Math.max(1, Math.round(sensitivity)));
  const factor = 0.8 ** (clampedSensitivity - 5);
  return {
    speechThreshold: DEFAULT_VAD_OPTIONS.speechThreshold * factor,
    silenceThreshold: DEFAULT_VAD_OPTIONS.silenceThreshold * factor,
    hangoverMs: Math.min(3000, Math.max(200, Math.round(silenceMs))),
    minSpeechMs: DEFAULT_VAD_OPTIONS.minSpeechMs,
    maxSpeechMs: DEFAULT_VAD_OPTIONS.maxSpeechMs,
    noiseMarginMultiplier: DEFAULT_VAD_OPTIONS.noiseMarginMultiplier,
    minVoicedRatio: DEFAULT_VAD_OPTIONS.minVoicedRatio,
  };
}

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
  /**
   * PA-85: EMA of frame energy observed while idle, or null until the first
   * idle frame has been seen. Updated only while idle *and* only from frames
   * below the current speech threshold, so an utterance never raises the
   * floor that is supposed to be measuring the room between utterances.
   */
  private noiseFloor: number | null = null;
  /** Frames since `speech_start` whose energy cleared the speech threshold. */
  private voicedFrames = 0;
  /** Frames since `speech_start` in the hysteresis band — audible, but below
   *  the speech threshold. A transient's decay tail lives here; so do
   *  unvoiced consonants and word boundaries. */
  private bandFrames = 0;
  /** Voiced span of the last closed run — see `lastVoicedMs()`. */
  private lastRunVoicedMs: number | null = null;

  constructor(private readonly opts: VadOptions = DEFAULT_VAD_OPTIONS) {}

  /**
   * The thresholds actually in force for this frame: the configured absolute
   * floors, or a margin above the measured ambient noise, whichever is
   * higher. The silence threshold keeps its configured ratio to the speech
   * threshold so hysteresis survives the adaptive case — without that, a
   * noisy room would get a raised speech threshold and an unchanged silence
   * threshold, and every pause between words would read as end-of-turn.
   */
  private effectiveThresholds(): { speech: number; silence: number } {
    const adaptiveSpeech = (this.noiseFloor ?? 0) * this.opts.noiseMarginMultiplier;
    const speech = Math.max(this.opts.speechThreshold, adaptiveSpeech);
    // Guard a zero/negative configured speech threshold rather than dividing
    // by it: `vadOptionsForSensitivity` cannot produce one, but `VadOptions`
    // is a public shape and a caller can.
    const hysteresisRatio =
      this.opts.speechThreshold > 0 ? this.opts.silenceThreshold / this.opts.speechThreshold : 1;
    return { speech, silence: Math.min(speech, speech * hysteresisRatio) };
  }

  push(energy: number, atMs: number): VadTransition {
    const { speech, silence } = this.effectiveThresholds();

    if (this.state === 'idle') {
      if (energy >= speech) {
        this.state = 'speaking';
        this.speechStartedAtMs = atMs;
        this.silenceSinceMs = null;
        // This frame is itself the first frame of the utterance, and it is
        // by definition voiced — counting it keeps the ratio honest for a
        // very short utterance made of only a few frames.
        this.voicedFrames = 1;
        this.bandFrames = 0;
        return 'speech_start';
      }
      // Only frames that are *not* speech feed the floor estimate, so a loud
      // sound the hysteresis has not yet promoted to `speaking` cannot drag
      // the threshold up behind it.
      this.noiseFloor = this.noiseFloor === null ? energy : this.noiseFloor * (1 - NOISE_FLOOR_ALPHA) + energy * NOISE_FLOOR_ALPHA;
      return null;
    }

    // state === 'speaking'
    if (energy >= speech) this.voicedFrames++;
    else if (energy >= silence) this.bandFrames++;

    // PA-85: a run must end. Without this, ambient energy that stays at or
    // above the *silence* threshold — a fan, a café, a nearby conversation —
    // never starts the hangover clock, so `push` returns null forever with
    // `isSpeaking()` true: the caller buffers audio without bound and, since
    // PA-85 made `speech_start` pause the talk-back reversibly, nothing is
    // ever left to un-pause it. Treated as a normal end-of-turn so a genuinely
    // long instruction is still delivered rather than thrown away.
    if (this.speechStartedAtMs !== null && atMs - this.speechStartedAtMs >= this.opts.maxSpeechMs) {
      const sustained = this.isSustained();
      const voiced = atMs - this.speechStartedAtMs;
      this.reset();
      this.lastRunVoicedMs = voiced;
      return sustained ? 'speech_end' : null;
    }

    if (energy < silence) {
      if (this.silenceSinceMs === null) {
        this.silenceSinceMs = atMs;
      }
      if (atMs - this.silenceSinceMs >= this.opts.hangoverMs) {
        // Measured up to when silence *began*, not up to now — using `atMs`
        // here would fold the hangover wait itself into "how long they
        // spoke," which would let a blip well under `minSpeechMs` sail
        // through just because the hangover window is long enough.
        const longEnough =
          this.speechStartedAtMs !== null &&
          this.silenceSinceMs - this.speechStartedAtMs >= this.opts.minSpeechMs;
        // PA-85: and it has to have been *sustained*, not one transient with
        // a decay tail long enough to span the duration floor.
        const sustained = this.isSustained();
        const voiced = this.speechStartedAtMs !== null ? this.silenceSinceMs - this.speechStartedAtMs : null;
        this.reset();
        this.lastRunVoicedMs = voiced;
        return longEnough && sustained ? 'speech_end' : null;
      }
      return null;
    }

    // Still loud enough to count as ongoing speech — cancel any hangover
    // countdown a brief dip below the silence threshold may have started.
    this.silenceSinceMs = null;
    return null;
  }

  /**
   * The voiced span (ms) of the most recently closed run — start of speech to
   * the moment the closing silence began, so it excludes the hangover
   * entirely. Null until a run has ended.
   *
   * Exists because the hangover is 800ms by default and up to 3s by setting,
   * which makes it the dominant term in any duration the caller could
   * otherwise compute: a words-per-second check against a span that large
   * cannot distinguish a four-word hallucination from ordinary speech.
   */
  lastVoicedMs(): number | null {
    return this.lastRunVoicedMs;
  }

  /** Whether the run so far looks like speech rather than a decaying
   *  transient. See `minVoicedRatio` for why silent frames are not in the
   *  denominator. */
  private isSustained(): boolean {
    const audible = this.voicedFrames + this.bandFrames;
    return audible > 0 && this.voicedFrames / audible >= this.opts.minVoicedRatio;
  }

  /**
   * Force back to `idle` — used on barge-in (a fresh utterance starting
   * while TTS plays) and when live-listen mode is turned off.
   *
   * PA-85: deliberately keeps `noiseFloor`. The room is as noisy as it was a
   * moment ago, and throwing the measurement away would mean every reset
   * re-learned it from scratch — the first utterance after each one judged
   * against a cold default, which is exactly the case the estimate exists to
   * cover. `LiveListenController.stop()` discards the whole instance anyway,
   * so a genuinely new session still starts with no assumptions.
   */
  reset(): void {
    this.state = 'idle';
    this.silenceSinceMs = null;
    this.speechStartedAtMs = null;
    this.voicedFrames = 0;
    this.bandFrames = 0;
  }

  isSpeaking(): boolean {
    return this.state === 'speaking';
  }

  /** The current ambient noise estimate, or null before any idle frame has
   *  been observed. Exposed for tests and for diagnosing a room where the
   *  adaptive threshold, rather than the configured one, is in force. */
  noiseFloorEstimate(): number | null {
    return this.noiseFloor;
  }
}
