import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { int16ArrayToBase64 } from './pcm.js';
import { TtsPlaybackQueue } from './playback.js';

/**
 * A minimal Web Audio stand-in. `TtsPlaybackQueue` only ever creates a
 * context, builds a buffer, and starts a source that must eventually fire
 * `onended` — enough to let `pump()` drain, and enough to count how many
 * chunks actually reached playback, which is the only thing these tests
 * assert about. `start()` resolves the chunk on the next microtask rather
 * than after real audio time, so a test never waits on a clock.
 */
class FakeAudioContext {
  static started: number = 0;
  readonly destination = {};
  state = 'running';
  closed = false;

  createBuffer(_channels: number, length: number, _rate: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }

  createBufferSource(): {
    buffer: unknown;
    onended: (() => void) | null;
    connect: () => void;
    start: () => void;
    stop: () => void;
  } {
    const source = {
      buffer: null as unknown,
      onended: null as (() => void) | null,
      connect: () => {},
      start: () => {
        FakeAudioContext.started += 1;
        queueMicrotask(() => source.onended?.());
      },
      stop: () => {},
    };
    return source;
  }

  async resume(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

function chunk(text: string): string {
  const pcm = new Int16Array(text.length);
  for (let i = 0; i < text.length; i++) pcm[i] = text.charCodeAt(i);
  return int16ArrayToBase64(pcm);
}

/** Enough turns of the microtask queue for `pump()` to drain what it has. */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('TtsPlaybackQueue', () => {
  beforeEach(() => {
    FakeAudioContext.started = 0;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });

  afterEach(() => {
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('plays each enqueued chunk in order', async () => {
    const queue = new TtsPlaybackQueue();
    queue.enqueue(chunk('one'), 24000);
    queue.enqueue(chunk('two'), 24000);
    await flush();

    expect(FakeAudioContext.started).toBe(2);
  });

  it('ignores an empty done-marker chunk', async () => {
    const queue = new TtsPlaybackQueue();
    queue.enqueue('', 0);
    await flush();

    expect(FakeAudioContext.started).toBe(0);
  });

  /**
   * PA-83, the reported "I stopped it and it kept talking": every sentence
   * of a reply is already synthesized and in flight when the stop happens,
   * and `enqueue()` used to clear `stopped` on each one — so playback
   * resumed a moment later, over and over, for as long as chunks kept
   * landing.
   */
  it('stays silent for chunks that arrive after stop(), however many', async () => {
    const queue = new TtsPlaybackQueue();
    queue.enqueue(chunk('before'), 24000);
    await flush();
    expect(FakeAudioContext.started).toBe(1);

    queue.stop();
    // The rest of the same reply, already on its way when stop() landed.
    queue.enqueue(chunk('in flight one'), 24000);
    queue.enqueue(chunk('in flight two'), 24000);
    queue.enqueue(chunk('in flight three'), 24000);
    await flush();

    expect(FakeAudioContext.started).toBe(1);
    expect(queue.isPlaying()).toBe(false);
  });

  it('arm() lets a genuinely new turn speak again', async () => {
    const queue = new TtsPlaybackQueue();
    queue.stop();
    queue.enqueue(chunk('muted'), 24000);
    await flush();
    expect(FakeAudioContext.started).toBe(0);

    // What a `user_prompt` event (or live-listen being switched back on)
    // does — nothing else un-mutes.
    queue.arm();
    queue.enqueue(chunk('new turn'), 24000);
    await flush();

    expect(FakeAudioContext.started).toBe(1);
  });

  it('stop() is idempotent and safe with nothing playing', async () => {
    const queue = new TtsPlaybackQueue();
    queue.stop();
    queue.stop();
    await flush();

    expect(queue.isPlaying()).toBe(false);
    expect(FakeAudioContext.started).toBe(0);
  });

  it('reports playback state transitions to its callback', async () => {
    const seen: boolean[] = [];
    const queue = new TtsPlaybackQueue((playing) => seen.push(playing));
    queue.enqueue(chunk('hello'), 24000);
    await flush();

    expect(seen).toEqual([true, false]);
  });
});
