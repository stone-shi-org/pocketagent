import { describe, it, expect } from 'vitest';
import { DEFAULT_VAD_OPTIONS, rms, SpeechEndpointer, vadOptionsForSensitivity, type VadOptions } from './vad.js';

describe('rms', () => {
  it('is zero for silence', () => {
    expect(rms(new Float32Array(100))).toBe(0);
  });

  it('is 1 for a full-scale constant signal', () => {
    expect(rms(new Float32Array(10).fill(1))).toBeCloseTo(1, 10);
  });

  it('handles an empty frame without dividing by zero', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

const OPTS: VadOptions = {
  speechThreshold: 0.1,
  silenceThreshold: 0.05,
  hangoverMs: 500,
  minSpeechMs: 200,
};

describe('SpeechEndpointer', () => {
  it('stays idle while energy never crosses the speech threshold', () => {
    const vad = new SpeechEndpointer(OPTS);
    expect(vad.push(0.01, 0)).toBeNull();
    expect(vad.push(0.02, 10)).toBeNull();
    expect(vad.isSpeaking()).toBe(false);
  });

  it('transitions to speech_start the instant the threshold is crossed', () => {
    const vad = new SpeechEndpointer(OPTS);
    expect(vad.push(0.15, 0)).toBe('speech_start');
    expect(vad.isSpeaking()).toBe(true);
  });

  it('does not re-fire speech_start on every subsequent loud frame', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.15, 0);
    expect(vad.push(0.2, 10)).toBeNull();
    expect(vad.push(0.3, 20)).toBeNull();
  });

  it('declares speech_end only after hangoverMs of continuous silence', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.2, 0); // speech_start
    vad.push(0.2, 300); // still speaking, long enough to clear minSpeechMs
    expect(vad.push(0.01, 400)).toBeNull(); // silence begins
    expect(vad.push(0.01, 700)).toBeNull(); // only 300ms of silence so far
    expect(vad.push(0.01, 900)).toBe('speech_end'); // 500ms of silence now
    expect(vad.isSpeaking()).toBe(false);
  });

  it('a brief dip below silenceThreshold that recovers does not start the hangover clock early', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.2, 0);
    vad.push(0.2, 500); // clears minSpeechMs
    expect(vad.push(0.01, 600)).toBeNull(); // dip
    expect(vad.push(0.2, 650)).toBeNull(); // recovers — cancels the hangover
    // If the dip had "counted", 600 + hangoverMs(500) = 1100 would already
    // have elapsed by 1000ms; it must not have fired yet.
    expect(vad.push(0.01, 1000)).toBeNull();
    // A fresh, full hangover window from the real silence start (1000ms):
    expect(vad.push(0.01, 1500)).toBe('speech_end');
  });

  it('discards speech shorter than minSpeechMs as noise, reporting no speech_end', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.2, 0); // speech_start at t=0
    // Silence begins almost immediately — total "speech" duration is only 50ms,
    // well under minSpeechMs (200ms).
    expect(vad.push(0.01, 50)).toBeNull();
    expect(vad.push(0.01, 550)).toBeNull(); // 500ms hangover elapses, but too short to count
    expect(vad.isSpeaking()).toBe(false);
  });

  it('goes back to idle (and can speech_start again) after a discarded short blip', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.2, 0);
    vad.push(0.01, 50);
    vad.push(0.01, 550); // discarded as noise
    expect(vad.push(0.2, 600)).toBe('speech_start');
  });

  it('reset() forces back to idle regardless of in-progress state (barge-in / mode off)', () => {
    const vad = new SpeechEndpointer(OPTS);
    vad.push(0.2, 0);
    expect(vad.isSpeaking()).toBe(true);
    vad.reset();
    expect(vad.isSpeaking()).toBe(false);
    // A fresh speech_start still fires correctly after reset.
    expect(vad.push(0.2, 1)).toBe('speech_start');
  });
});

describe('vadOptionsForSensitivity', () => {
  it('reproduces DEFAULT_VAD_OPTIONS exactly at sensitivity 5 and silenceMs 800', () => {
    expect(vadOptionsForSensitivity(5, 800)).toEqual(DEFAULT_VAD_OPTIONS);
  });

  it('lowers both thresholds as sensitivity increases, preserving their ratio', () => {
    const low = vadOptionsForSensitivity(1, 800);
    const mid = vadOptionsForSensitivity(5, 800);
    const high = vadOptionsForSensitivity(10, 800);
    expect(low.speechThreshold).toBeGreaterThan(mid.speechThreshold);
    expect(mid.speechThreshold).toBeGreaterThan(high.speechThreshold);
    for (const opts of [low, mid, high]) {
      expect(opts.silenceThreshold / opts.speechThreshold).toBeCloseTo(
        DEFAULT_VAD_OPTIONS.silenceThreshold / DEFAULT_VAD_OPTIONS.speechThreshold,
        10,
      );
    }
  });

  it('clamps sensitivity to [1, 10] rather than extrapolating unboundedly', () => {
    expect(vadOptionsForSensitivity(20, 800)).toEqual(vadOptionsForSensitivity(10, 800));
    expect(vadOptionsForSensitivity(-3, 800)).toEqual(vadOptionsForSensitivity(1, 800));
  });

  it('clamps silenceMs to [200, 3000], the Settings-page range', () => {
    expect(vadOptionsForSensitivity(5, 50).hangoverMs).toBe(200);
    expect(vadOptionsForSensitivity(5, 10_000).hangoverMs).toBe(3000);
  });

  it('passes an in-range silenceMs straight through as hangoverMs', () => {
    expect(vadOptionsForSensitivity(5, 1200).hangoverMs).toBe(1200);
  });
});
