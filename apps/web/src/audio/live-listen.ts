import { floatTo16BitPcm, int16ArrayToBase64, resampleLinear } from './pcm.js';
import { DEFAULT_VAD_OPTIONS, rms, SpeechEndpointer, type VadOptions } from './vad.js';
import type { RecordedUtterance } from './capture.js';

/** `live-stt` requires exactly this — see the PA-20 implementation plan's §5.1. */
const TARGET_SAMPLE_RATE = 16000;

export class LiveListenError extends Error {
  override readonly name = 'LiveListenError';
}

export interface LiveListenOptions {
  vad?: Partial<VadOptions>;
  /** One buffered utterance is ready — the caller transcribes and submits
   *  it exactly like a push-to-talk recording. */
  onUtterance: (utterance: RecordedUtterance) => void;
  /**
   * Fires the instant new speech is detected, *before* the utterance is
   * complete — the barge-in signal (PA-20 Phase 4). The caller must react
   * immediately (stop TTS playback, send `interrupt`), not wait for
   * `onUtterance`; waiting would mean the agent keeps talking over the user
   * for the entire duration of what they're saying.
   */
  onSpeechStart?: () => void;
  /**
   * PA-85: a run of speech started (so `onSpeechStart` fired) but the
   * endpointer then *rejected* it — too short, or not sustained enough to
   * clear `minVoicedRatio` — so no utterance will ever be emitted for it.
   *
   * Load-bearing rather than informational. `onSpeechStart` is now the fast,
   * reversible half of two-stage barge-in: it pauses the agent's talk-back
   * before anything knows whether the sound was a command. Every other
   * outcome resolves that pause in `onUtterance`, but a VAD-level discard
   * never reaches `onUtterance` at all — so without this callback a cough
   * loud enough to trip `speech_start` and junky enough to be discarded would
   * leave the reply paused mid-sentence with nothing left to resume it. The
   * Tier 1 gate added in the same ticket makes that outcome *more* frequent,
   * not less, which is what turns this from a tidy-up into a requirement.
   */
  onSpeechDiscarded?: () => void;
  /** Per-frame RMS energy, for an audio-level meter — the ticket's only
   *  "listening" UI feedback (no live captions, no partials). */
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
}

/**
 * Continuous capture + endpointing (PA-20 Phase 2): unlike
 * `PushToTalkRecorder`, there is no press/release — this runs for as long as
 * live-listen mode is on, buffering audio only between a `speech_start` and
 * `speech_end` transition and emitting one `RecordedUtterance` per detected
 * turn. `echoCancellation: true` on the mic stream (so it doesn't hear the
 * agent's own TTS played back through the speakers) is the same constraint
 * `PushToTalkRecorder` already applies; unlike push-to-talk it actually
 * matters here, since capture and playback run concurrently during
 * barge-in — not independently verified against real hardware in this
 * environment, flagged as a real-device testing item.
 */
export class LiveListenController {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private readonly endpointer: SpeechEndpointer;
  private chunks: Float32Array[] = [];
  private speechStartedAtMs = 0;

  constructor(private readonly opts: LiveListenOptions) {
    this.endpointer = new SpeechEndpointer({ ...DEFAULT_VAD_OPTIONS, ...opts.vad });
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  async start(): Promise<void> {
    if (!LiveListenController.isSupported()) {
      throw new LiveListenError('Voice capture is not supported in this browser.');
    }
    this.chunks = [];
    this.endpointer.reset();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, channelCount: 1 },
      });
    } catch (err) {
      throw new LiveListenError(
        err instanceof Error ? `Microphone access denied: ${err.message}` : 'Microphone access denied.',
      );
    }

    // Unlike push-to-talk's one-shot recording, this runs indefinitely —
    // the mic can be revoked or the device unplugged at any point long
    // after `start()` has already resolved, with no promise left to reject.
    // `onError` is the only way to tell the caller "voice mode just went
    // dead," so the UI can turn the toggle back off instead of silently
    // listening to nothing.
    for (const track of this.stream.getTracks()) {
      track.onended = () => this.opts.onError?.('Microphone was disconnected.');
    }

    this.context = new AudioContext();
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    await this.context.audioWorklet.addModule('/pcm-worklet-processor.js');
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture-processor');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => this.onFrame(event.data);
    source.connect(this.node);
  }

  private onFrame(frame: Float32Array): void {
    const energy = rms(frame);
    this.opts.onLevel?.(energy);

    // Sampled before the push: the endpointer reports a *rejected* run by
    // silently returning to idle with a `null` transition, which is
    // indistinguishable from ordinary silence by the return value alone.
    // Comparing the speaking state across the call is what separates them,
    // and it does so without widening `VadTransition` — `SpeechEndpointer`'s
    // three-state contract is what `vad.ts` says every caller may depend on.
    const wasSpeaking = this.endpointer.isSpeaking();
    const transition = this.endpointer.push(energy, performance.now());

    if (transition === 'speech_start') {
      this.chunks = [frame];
      this.speechStartedAtMs = performance.now();
      this.opts.onSpeechStart?.();
      return;
    }
    if (this.endpointer.isSpeaking()) {
      // Still mid-utterance (including the trailing hangover window before
      // silence is confirmed long enough to end the turn) — a few hundred ms
      // of trailing silence in the buffer is harmless to transcribe.
      this.chunks.push(frame);
      return;
    }
    if (transition === 'speech_end') {
      this.emitUtterance();
      return;
    }
    // Not speaking, and no `speech_end`: either true silence between
    // utterances, or a blip the endpointer just discarded. `this.chunks` is
    // left for the *next* `speech_start` to reset either way, so a discarded
    // blip's few frames never leak into a later utterance — but a discard has
    // to be *announced*, because something is waiting on this utterance's
    // outcome (see `onSpeechDiscarded`).
    if (wasSpeaking) {
      this.chunks = [];
      this.opts.onSpeechDiscarded?.();
    }
  }

  private emitUtterance(): void {
    const nativeSampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const totalLength = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const durationMs = performance.now() - this.speechStartedAtMs;
    // The endpointer's own measurement, which excludes the hangover it just
    // waited out — see `SpeechEndpointer.lastVoicedMs`. `durationMs` above
    // describes the buffer being uploaded (hangover included, which is
    // harmless to transcribe); this describes the speech inside it, and is
    // the only one of the two a words-per-second check can use.
    const voicedMs = this.endpointer.lastVoicedMs();
    this.chunks = [];

    const resampled = resampleLinear(merged, nativeSampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPcm(resampled);
    this.opts.onUtterance({
      audioBase64: int16ArrayToBase64(pcm16),
      durationMs,
      ...(voicedMs !== null ? { voicedMs } : {}),
    });
  }

  /**
   * Barge-in support: force back to "not speaking" without emitting
   * whatever's buffered — so a half-captured recording is never submitted.
   *
   * Currently unused. If it is ever wired up, note what it bypasses: PA-85's
   * discard detection works by watching `isSpeaking()` change across a
   * `push()`, so resetting the endpointer directly ends a run *without*
   * firing `onSpeechDiscarded`. Any caller must therefore resolve the
   * talk-back pause itself (a `stop()` is what every existing teardown path
   * does), or the reply stays paused with nothing left to un-pause it.
   */
  resetTurn(): void {
    this.chunks = [];
    this.endpointer.reset();
    this.opts.onSpeechDiscarded?.();
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();
    this.node = null;
    this.context = null;
    this.stream = null;
    this.chunks = [];
    this.endpointer.reset();
  }
}
