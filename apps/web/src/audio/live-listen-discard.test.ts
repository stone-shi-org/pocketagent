import { describe, it, expect } from 'vitest';
import { DEFAULT_VAD_OPTIONS, SpeechEndpointer, type VadOptions } from './vad.js';

/**
 * PA-85 regression guard for the subtlest bug in two-stage barge-in.
 *
 * `LiveListenController.onSpeechStart` now *pauses* the agent's talk-back
 * (reversibly) instead of stopping it, and every verdict in
 * `AgentPage.onUtterance` resolves that pause. But a run of speech the
 * endpointer *rejects* — too short, or not sustained enough for
 * `minVoicedRatio` — never reaches `onUtterance` at all: `push()` returns
 * `null` and silently goes back to idle. Without `onSpeechDiscarded` the
 * reply would stay paused mid-sentence with nothing left to resume it, and
 * the Tier 1 gate added in this same ticket makes that outcome *more*
 * frequent rather than less.
 *
 * `LiveListenController` itself needs a real `AudioContext`, `getUserMedia`
 * and an `AudioWorklet`, none of which exist here — so this tests the
 * detection rule the controller uses (comparing `isSpeaking()` across the
 * `push`) against the endpointer directly, which is the part that can
 * actually be wrong.
 */
const OPTS: VadOptions = { ...DEFAULT_VAD_OPTIONS, speechThreshold: 0.1, silenceThreshold: 0.05, hangoverMs: 500, minSpeechMs: 200 };

/** Mirrors `LiveListenController.onFrame`'s classification exactly. */
function classify(vad: SpeechEndpointer, energy: number, atMs: number): string {
  const wasSpeaking = vad.isSpeaking();
  const transition = vad.push(energy, atMs);
  if (transition === 'speech_start') return 'start';
  if (vad.isSpeaking()) return 'buffering';
  if (transition === 'speech_end') return 'utterance';
  return wasSpeaking ? 'discarded' : 'idle';
}

describe('live-listen discard detection (PA-85)', () => {
  it('reports a discard for a blip too short to clear minSpeechMs', () => {
    const vad = new SpeechEndpointer(OPTS);
    expect(classify(vad, 0.5, 0)).toBe('start');
    expect(classify(vad, 0.01, 50)).toBe('buffering'); // hangover open
    // The hangover elapses and the run is rejected as too short. This is the
    // frame that must announce a discard rather than looking like silence.
    expect(classify(vad, 0.01, 560)).toBe('discarded');
  });

  it('reports a discard for a transient that spans long enough but was never sustained', () => {
    const vad = new SpeechEndpointer(OPTS);
    expect(classify(vad, 0.6, 0)).toBe('start');
    // A decay tail above the silence threshold but below the speech one:
    // clears minSpeechMs on a single voiced frame, so minVoicedRatio rejects.
    for (let t = 10; t <= 400; t += 10) classify(vad, 0.06, t);
    expect(classify(vad, 0.01, 410)).toBe('buffering');
    expect(classify(vad, 0.01, 950)).toBe('discarded');
  });

  it('reports an utterance, never a discard, for real sustained speech', () => {
    const vad = new SpeechEndpointer(OPTS);
    expect(classify(vad, 0.5, 0)).toBe('start');
    for (let t = 10; t <= 400; t += 10) expect(classify(vad, 0.5, t)).toBe('buffering');
    expect(classify(vad, 0.01, 410)).toBe('buffering');
    expect(classify(vad, 0.01, 950)).toBe('utterance');
  });

  it('never reports a discard while merely idle, so nothing fires without a speech_start', () => {
    const vad = new SpeechEndpointer(OPTS);
    for (let t = 0; t < 2000; t += 10) expect(classify(vad, 0.01, t)).toBe('idle');
  });

  it('every run that starts eventually terminates as exactly one of utterance or discard', () => {
    // The property the barge-in pause depends on: `onSpeechStart` always has
    // a matching resolution, so a pause can never be orphaned.
    for (const [label, level] of [['sustained', 0.5], ['transient', 0.06]] as const) {
      const vad = new SpeechEndpointer(OPTS);
      const seen: string[] = [];
      seen.push(classify(vad, 0.6, 0));
      for (let t = 10; t <= 400; t += 10) seen.push(classify(vad, level, t));
      for (let t = 410; t <= 1200; t += 10) seen.push(classify(vad, 0.01, t));
      const terminal = seen.filter((s) => s === 'utterance' || s === 'discarded');
      expect(terminal, label).toHaveLength(1);
    }
  });
});
