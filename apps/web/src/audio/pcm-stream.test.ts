import { describe, expect, it } from 'vitest';
import { SampleBatcher, StreamingResampler, scheduleChunk } from './pcm-stream.js';

/** The reference: interpolate the *whole* signal at k * step. */
function wholeSignal(input: Float32Array, step: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < count; k++) {
    const p = k * step;
    const lo = Math.floor(p);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = p - lo;
    out.push(input[lo]! * (1 - frac) + input[hi]! * frac);
  }
  return out;
}

describe('StreamingResampler', () => {
  it('produces the same samples in 128-frame pieces as it would on the whole signal', () => {
    const input = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 7));
    const r = new StreamingResampler(48000, 16000);
    const pieces: number[] = [];
    for (let i = 0; i < input.length; i += 128) pieces.push(...r.push(input.subarray(i, i + 128)));
    const reference = wholeSignal(input, 3, pieces.length);
    expect(pieces.length).toBe(16000);
    for (let i = 0; i < pieces.length; i++) expect(pieces[i]).toBeCloseTo(reference[i]!, 6);
  });

  it('keeps phase across a non-integer ratio (44.1k → 16k)', () => {
    const input = Float32Array.from({ length: 44100 }, (_, i) => Math.cos(i / 11));
    const r = new StreamingResampler(44100, 16000);
    const pieces: number[] = [];
    for (let i = 0; i < input.length; i += 128) pieces.push(...r.push(input.subarray(i, i + 128)));
    // Within a sample of the exact output count, and matching the reference.
    expect(Math.abs(pieces.length - 16000)).toBeLessThanOrEqual(1);
    const reference = wholeSignal(input, 44100 / 16000, pieces.length);
    for (let i = 0; i < pieces.length; i++) expect(pieces[i]).toBeCloseTo(reference[i]!, 5);
  });

  it('passes through at equal rates and handles empty input', () => {
    const r = new StreamingResampler(16000, 16000);
    const x = Float32Array.from([0.1, 0.2]);
    expect(r.push(x)).toBe(x);
    expect(new StreamingResampler(48000, 16000).push(new Float32Array(0))).toHaveLength(0);
  });
});

describe('SampleBatcher', () => {
  it('releases whole batches and flushes the remainder', () => {
    const b = new SampleBatcher(4);
    expect(b.push(Int16Array.from([1, 2]))).toBeNull();
    expect(Array.from(b.push(Int16Array.from([3, 4, 5]))!)).toEqual([1, 2, 3, 4, 5]);
    expect(b.flush()).toBeNull();
    b.push(Int16Array.from([6]));
    expect(Array.from(b.flush()!)).toEqual([6]);
  });
});

describe('scheduleChunk', () => {
  it('queues back-to-back while playing, and restarts slightly ahead after an underrun', () => {
    expect(scheduleChunk(10, 10.5)).toBe(10.5);
    expect(scheduleChunk(10, 9.9)).toBeCloseTo(10.04);
    expect(scheduleChunk(10, 0, 0.1)).toBeCloseTo(10.1);
  });
});
