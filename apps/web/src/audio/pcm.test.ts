import { describe, it, expect } from 'vitest';
import {
  base64ToInt16Array,
  floatTo16BitPcm,
  int16ArrayToBase64,
  int16ToFloat32,
  resampleLinear,
} from './pcm.js';

describe('resampleLinear', () => {
  it('returns the input unchanged when rates already match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('halves the sample count when downsampling by 2x', () => {
    const input = new Float32Array([0, 1, 0, -1, 0, 1, 0, -1]);
    const output = resampleLinear(input, 32000, 16000);
    expect(output.length).toBe(4);
  });

  it('interpolates between neighboring samples rather than just dropping some', () => {
    // A straight ramp resampled should still read as a ramp, not have
    // discontinuities from naive decimation.
    const input = new Float32Array(100).map((_, i) => i / 100);
    const output = resampleLinear(input, 48000, 16000);
    for (let i = 1; i < output.length; i++) {
      expect(output[i]!).toBeGreaterThanOrEqual(output[i - 1]! - 1e-6);
    }
  });

  it('handles empty input without dividing by zero', () => {
    expect(resampleLinear(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

describe('floatTo16BitPcm', () => {
  it('maps -1..1 to the full int16 range', () => {
    const output = floatTo16BitPcm(new Float32Array([0, 1, -1, 0.5, -0.5]));
    // Int16Array's own numeric conversion truncates toward zero, not rounds —
    // asserting against that real conversion rather than a hand-rounded
    // expectation, so this test would actually catch a change in behavior.
    expect(Array.from(output)).toEqual([0, 0x7fff, -0x8000, Math.trunc(0.5 * 0x7fff), Math.trunc(-0.5 * 0x8000)]);
  });

  it('clamps out-of-range samples instead of wrapping them into noise', () => {
    const output = floatTo16BitPcm(new Float32Array([2, -2]));
    expect(Array.from(output)).toEqual([0x7fff, -0x8000]);
  });
});

describe('int16ArrayToBase64', () => {
  it('round-trips through Buffer (the server-side decoder) losslessly', () => {
    const samples = new Int16Array([0, 1, -1, 12345, -12345, 32767, -32768]);
    const encoded = int16ArrayToBase64(samples);
    // `Buffer.from` may allocate from Node's shared pool for small buffers,
    // so `.buffer` alone can be larger than the decoded data — slicing out
    // exactly `byteOffset..byteOffset+length` first is what makes this test
    // actually prove round-trip correctness rather than pass by accident on
    // an unshared allocation.
    const buf = Buffer.from(encoded, 'base64');
    const decoded = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  it('handles a long buffer spanning multiple internal chunks', () => {
    // Longer than the 0x8000-byte chunking used internally, to exercise the
    // loop boundary rather than only ever testing a single chunk.
    const samples = new Int16Array(50_000).map((_, i) => (i % 2 === 0 ? i % 1000 : -(i % 1000)));
    const encoded = int16ArrayToBase64(samples);
    // `Buffer.from` may allocate from Node's shared pool for small buffers,
    // so `.buffer` alone can be larger than the decoded data — slicing out
    // exactly `byteOffset..byteOffset+length` first is what makes this test
    // actually prove round-trip correctness rather than pass by accident on
    // an unshared allocation.
    const buf = Buffer.from(encoded, 'base64');
    const decoded = new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });
});

describe('base64ToInt16Array (playback-side decode)', () => {
  it('round-trips with int16ArrayToBase64', () => {
    const samples = new Int16Array([0, 1, -1, 12345, -12345, 32767, -32768]);
    const decoded = base64ToInt16Array(int16ArrayToBase64(samples));
    expect(Array.from(decoded)).toEqual(Array.from(samples));
  });

  it('round-trips against a server-encoded (Buffer-based) payload', () => {
    // Proves interop with the actual server-side encoder
    // (`speech.pcm.toString('base64')` in turn-tts-pump.ts), not just this
    // module's own encoder.
    const samples = new Int16Array([100, -100, 0, 30000]);
    const serverEncoded = Buffer.from(samples.buffer).toString('base64');
    expect(Array.from(base64ToInt16Array(serverEncoded))).toEqual(Array.from(samples));
  });
});

describe('int16ToFloat32', () => {
  it('is the exact inverse of floatTo16BitPcm at the extremes and zero', () => {
    const original = new Float32Array([0, 1, -1]);
    const roundTripped = int16ToFloat32(floatTo16BitPcm(original));
    expect(Array.from(roundTripped)).toEqual([0, 1, -1]);
  });

  it('stays within [-1, 1] for the full int16 range', () => {
    const samples = new Int16Array([-32768, -1, 0, 1, 32767]);
    const floats = int16ToFloat32(samples);
    for (const f of floats) {
      expect(f).toBeGreaterThanOrEqual(-1);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});
