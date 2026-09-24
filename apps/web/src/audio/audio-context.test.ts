import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSharedAudioContext,
  unlockAudioContext,
  registerAudioUnlockListeners,
  resetSharedAudioContext,
} from './audio-context.js';

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination = { id: 'destination-node' };
  buffersPlayed: unknown[] = [];

  constructor() {
    MockAudioContext.instances.push(this);
  }

  createBuffer(channels: number, length: number, rate: number): { channels: number; length: number; rate: number } {
    return { channels, length, rate };
  }

  createBufferSource(): {
    buffer: unknown;
    connect: (dest: unknown) => void;
    start: (when?: number) => void;
  } {
    const source = {
      buffer: null as unknown,
      connect: (_dest: unknown) => {},
      start: (_when = 0) => {
        this.buffersPlayed.push(source.buffer);
      },
    };
    return source;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

describe('audio-context (PA-54)', () => {
  beforeEach(() => {
    MockAudioContext.instances = [];
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = MockAudioContext;
    resetSharedAudioContext();
  });

  afterEach(() => {
    resetSharedAudioContext();
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
  });

  it('provides a singleton AudioContext instance', () => {
    const ctx1 = getSharedAudioContext();
    const ctx2 = getSharedAudioContext();
    expect(ctx1).toBe(ctx2);
    expect(MockAudioContext.instances.length).toBe(1);
  });

  it('recreates AudioContext if previous instance was closed', async () => {
    const ctx1 = getSharedAudioContext();
    await ctx1.close();
    expect(ctx1.state).toBe('closed');

    const ctx2 = getSharedAudioContext();
    expect(ctx2).not.toBe(ctx1);
    expect(MockAudioContext.instances.length).toBe(2);
  });

  it('unlocks suspended context by resuming and playing 1-sample silent buffer', async () => {
    const ctx = getSharedAudioContext() as unknown as MockAudioContext;
    expect(ctx.state).toBe('suspended');
    expect(ctx.buffersPlayed.length).toBe(0);

    const result = await unlockAudioContext();
    expect(result).toBe(true);
    expect(ctx.state).toBe('running');
    expect(ctx.buffersPlayed.length).toBe(1);
  });

  it('returns true immediately without playing buffer if already running and unlocked', async () => {
    const ctx = getSharedAudioContext() as unknown as MockAudioContext;
    await unlockAudioContext();
    expect(ctx.buffersPlayed.length).toBe(1);

    const secondResult = await unlockAudioContext();
    expect(secondResult).toBe(true);
    // Buffer count should still be 1 (did not re-play buffer)
    expect(ctx.buffersPlayed.length).toBe(1);
  });

  it('registers and unregisters window unlock gesture listeners', () => {
    const events: string[] = [];
    const fakeWindow = {
      addEventListener: (type: string) => events.push(`add:${type}`),
      removeEventListener: (type: string) => events.push(`remove:${type}`),
    };

    const originalWindow = globalThis.window;
    (globalThis as unknown as { window: unknown }).window = fakeWindow;

    try {
      const cleanup = registerAudioUnlockListeners();
      expect(events).toContain('add:pointerdown');
      expect(events).toContain('add:touchstart');
      expect(events).toContain('add:keydown');

      cleanup();
      expect(events).toContain('remove:pointerdown');
      expect(events).toContain('remove:touchstart');
      expect(events).toContain('remove:keydown');
    } finally {
      (globalThis as unknown as { window: unknown }).window = originalWindow;
    }
  });
});
