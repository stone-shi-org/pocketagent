import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PushToTalkRecorder } from './capture.js';
import { LiveListenController } from './live-listen.js';
import { resetSharedAudioContext } from './audio-context.js';

class MockGainNode {
  readonly gain = {
    value: 1,
    setValueAtTime: vi.fn(),
  };
  connectedTo: unknown[] = [];
  disconnect = vi.fn();

  connect(dest: unknown): void {
    this.connectedTo.push(dest);
  }
}

class MockAudioWorkletNode {
  connectedTo: unknown[] = [];
  port = {
    onmessage: null as unknown,
    close: vi.fn(),
  };
  disconnect = vi.fn();

  constructor(_ctx: unknown, _name: string) {}

  connect(dest: unknown): void {
    this.connectedTo.push(dest);
  }
}

class MockAudioContext {
  state: 'suspended' | 'running' | 'closed' = 'running';
  sampleRate = 48000;
  currentTime = 0;
  readonly destination = { name: 'hardware-destination' };
  gainNodes: MockGainNode[] = [];
  workletNodes: MockAudioWorkletNode[] = [];
  modulesAdded: string[] = [];

  audioWorklet = {
    addModule: vi.fn(async (url: string) => {
      this.modulesAdded.push(url);
    }),
  };

  createMediaStreamSource(_stream: unknown): { connect: (dest: unknown) => void; disconnect: () => void } {
    return {
      connect: (_dest: unknown) => {},
      disconnect: vi.fn(),
    };
  }

  createGain(): MockGainNode {
    const gain = new MockGainNode();
    this.gainNodes.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

describe('WebKit AudioWorklet pull-sink graph (PA-54)', () => {
  let mockContextInstance: MockAudioContext | null = null;
  const mockTrack = { stop: vi.fn(), onended: null };
  const mockStream = {
    getTracks: () => [mockTrack],
  };

  beforeEach(() => {
    resetSharedAudioContext();
    mockContextInstance = null;
    mockTrack.stop.mockClear();

    const Ctx = function () {
      mockContextInstance = new MockAudioContext();
      return mockContextInstance;
    };
    vi.stubGlobal('AudioContext', Ctx);
    vi.stubGlobal('AudioWorkletNode', function (ctx: unknown, name: string) {
      const node = new MockAudioWorkletNode(ctx, name);
      mockContextInstance?.workletNodes.push(node);
      return node;
    });

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => mockStream),
      },
    });
  });

  afterEach(() => {
    resetSharedAudioContext();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('PushToTalkRecorder', () => {
    it('connects AudioWorkletNode to destination via muted GainNode for WebKit pull', async () => {
      const recorder = new PushToTalkRecorder();
      await recorder.start();

      expect(mockContextInstance).not.toBeNull();
      expect(mockContextInstance!.gainNodes.length).toBe(1);
      expect(mockContextInstance!.workletNodes.length).toBe(1);

      const gain = mockContextInstance!.gainNodes[0]!;
      const worklet = mockContextInstance!.workletNodes[0]!;

      // Gain is muted to 0 to avoid audio feedback
      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);

      // Worklet connects to silentGain, silentGain connects to hardware destination
      expect(worklet.connectedTo).toContain(gain);
      expect(gain.connectedTo).toContain(mockContextInstance!.destination);

      // Clean teardown disconnects silentGain
      await recorder.stop();
      expect(gain.disconnect).toHaveBeenCalled();
      expect(worklet.disconnect).toHaveBeenCalled();
      expect(mockTrack.stop).toHaveBeenCalled();
    });

    it('disconnects silentGain on cancel()', async () => {
      const recorder = new PushToTalkRecorder();
      await recorder.start();

      const gain = mockContextInstance!.gainNodes[0]!;
      await recorder.cancel();
      expect(gain.disconnect).toHaveBeenCalled();
    });

    it('does not close the shared AudioContext on stop() or cancel()', async () => {
      const recorder = new PushToTalkRecorder();
      await recorder.start();
      expect(mockContextInstance!.state).toBe('running');

      await recorder.stop();
      expect(mockContextInstance!.state).toBe('running');

      await recorder.start();
      await recorder.cancel();
      expect(mockContextInstance!.state).toBe('running');
    });

    it('loads worklet module via ensureAudioWorkletModule once across multiple recordings', async () => {
      const recorder1 = new PushToTalkRecorder();
      await recorder1.start();
      await recorder1.stop();

      const recorder2 = new PushToTalkRecorder();
      await recorder2.start();
      await recorder2.stop();

      expect(mockContextInstance!.modulesAdded.length).toBe(1);
    });
  });

  describe('LiveListenController', () => {
    it('connects AudioWorkletNode to destination via muted GainNode for WebKit pull', async () => {
      const controller = new LiveListenController({
        onUtterance: () => {},
      });
      await controller.start();

      expect(mockContextInstance).not.toBeNull();
      expect(mockContextInstance!.gainNodes.length).toBe(1);
      expect(mockContextInstance!.workletNodes.length).toBe(1);

      const gain = mockContextInstance!.gainNodes[0]!;
      const worklet = mockContextInstance!.workletNodes[0]!;

      expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
      expect(worklet.connectedTo).toContain(gain);
      expect(gain.connectedTo).toContain(mockContextInstance!.destination);

      await controller.stop();
      expect(gain.disconnect).toHaveBeenCalled();
      expect(worklet.disconnect).toHaveBeenCalled();
      expect(mockTrack.stop).toHaveBeenCalled();
    });

    it('does not close the shared AudioContext on stop()', async () => {
      const controller = new LiveListenController({
        onUtterance: () => {},
      });
      await controller.start();
      expect(mockContextInstance!.state).toBe('running');

      await controller.stop();
      expect(mockContextInstance!.state).toBe('running');
    });

    it('loads worklet module via ensureAudioWorkletModule once across multiple starts', async () => {
      const controller1 = new LiveListenController({ onUtterance: () => {} });
      await controller1.start();
      await controller1.stop();

      const controller2 = new LiveListenController({ onUtterance: () => {} });
      await controller2.start();
      await controller2.stop();

      expect(mockContextInstance!.modulesAdded.length).toBe(1);
    });
  });
});
