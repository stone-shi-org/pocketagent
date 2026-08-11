import { describe, expect, it } from 'vitest';
import { OutputBuffer } from '../src/terminal/output-buffer.js';

describe('OutputBuffer', () => {
  it('assigns monotonically increasing sequence numbers from 1', () => {
    const buffer = new OutputBuffer(1024);
    expect(buffer.append('a')).toBe(1);
    expect(buffer.append('b')).toBe(2);
    expect(buffer.append('c')).toBe(3);
    expect(buffer.getLastSeq()).toBe(3);
  });

  it('replays everything for a fresh attach', () => {
    const buffer = new OutputBuffer(1024);
    buffer.append('hello ');
    buffer.append('world');

    const replay = buffer.replayAfter(0);
    expect(replay.data).toBe('hello world');
    expect(replay.toSeq).toBe(2);
    expect(replay.truncated).toBe(false);
  });

  it('replays only the gap after a reconnect', () => {
    const buffer = new OutputBuffer(1024);
    buffer.append('one ');
    buffer.append('two ');
    buffer.append('three');

    const replay = buffer.replayAfter(1);
    expect(replay.data).toBe('two three');
    expect(replay.fromSeq).toBe(1);
    expect(replay.toSeq).toBe(3);
    expect(replay.truncated).toBe(false);
  });

  it('returns nothing when the client is already current', () => {
    const buffer = new OutputBuffer(1024);
    buffer.append('one');
    const replay = buffer.replayAfter(1);
    expect(replay.data).toBe('');
    expect(replay.toSeq).toBe(1);
    expect(replay.truncated).toBe(false);
  });

  it('tolerates a sequence number ahead of the buffer', () => {
    const buffer = new OutputBuffer(1024);
    buffer.append('one');
    const replay = buffer.replayAfter(99);
    expect(replay.data).toBe('');
    expect(replay.truncated).toBe(false);
  });

  it('evicts oldest data once the byte budget is exceeded', () => {
    const buffer = new OutputBuffer(100);
    for (let i = 0; i < 50; i++) buffer.append('x'.repeat(10));

    expect(buffer.getByteLength()).toBeLessThanOrEqual(100);
    expect(buffer.getDroppedChunks()).toBeGreaterThan(0);
    expect(buffer.getFirstSeq()).toBeGreaterThan(1);
  });

  it('flags a replay whose starting point was already evicted', () => {
    const buffer = new OutputBuffer(50);
    for (let i = 0; i < 20; i++) buffer.append('y'.repeat(10));

    // Sequence 1 is long gone.
    const replay = buffer.replayAfter(1);
    expect(replay.truncated).toBe(true);
    expect(replay.data.length).toBeGreaterThan(0);
    expect(replay.toSeq).toBe(buffer.getLastSeq());
  });

  it('does not flag a replay that is still contiguous', () => {
    const buffer = new OutputBuffer(1000);
    for (let i = 0; i < 5; i++) buffer.append('z'.repeat(10));
    expect(buffer.replayAfter(2).truncated).toBe(false);
  });

  it('keeps the most recent chunk even when it alone exceeds the budget', () => {
    const buffer = new OutputBuffer(64);
    buffer.append('small');
    buffer.append('B'.repeat(500));

    const replay = buffer.replayAfter(0);
    expect(replay.data).toBe('B'.repeat(500));
    expect(replay.truncated).toBe(true);
  });

  it('accounts for multi-byte characters by bytes, not code units', () => {
    const buffer = new OutputBuffer(1000);
    buffer.append('🚀'); // 4 bytes, 2 UTF-16 code units
    expect(buffer.getByteLength()).toBe(4);
  });

  it('never lets memory grow without bound under sustained output', () => {
    const buffer = new OutputBuffer(4096);
    for (let i = 0; i < 10_000; i++) buffer.append(`line ${i}\r\n`);
    expect(buffer.getByteLength()).toBeLessThanOrEqual(4096);
    expect(buffer.replayAfter(0).data).toContain('line 9999');
  });
});
