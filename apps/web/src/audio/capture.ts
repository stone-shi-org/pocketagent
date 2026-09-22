import { floatTo16BitPcm, int16ArrayToBase64, resampleLinear } from './pcm.js';
import { rms } from './vad.js';

/** `live-stt` requires exactly this — see the PA-20 implementation plan's §5.1. */
const TARGET_SAMPLE_RATE = 16000;

export class VoiceCaptureError extends Error {
  override readonly name = 'VoiceCaptureError';
}

export interface RecordedUtterance {
  /** Base64 16kHz mono PCM16, the exact `VoiceAudioUpload.data` shape. */
  audioBase64: string;
  durationMs: number;
}

export interface PushToTalkOptions {
  /** Per-frame RMS energy while recording, for live audio level / waveform UI. */
  onLevel?: (level: number) => void;
}

/**
 * Push-to-talk capture (PA-20 Phase 1, enhanced in PA-82): `start()` on press,
 * `stop()` on release, get back one buffered utterance ready to POST to
 * `/api/sessions/:id/voice/transcribe`.
 *
 * Streams RMS levels via `opts.onLevel` for dynamic audio level visualizers,
 * and supports `cancel()` to discard in-flight recordings cleanly.
 *
 * `AudioWorkletNode` over the simpler, deprecated `ScriptProcessorNode`
 * because the PA-20 ticket specifies it and it's what every current browser
 * recommends for real-time audio capture; the worklet itself does no
 * resampling (see `pcm-worklet-processor.js`'s own doc comment) — that
 * happens once, in `stop()`, on the fully assembled buffer.
 */
export class PushToTalkRecorder {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private chunks: Float32Array[] = [];
  private startedAt = 0;

  constructor(private readonly opts?: PushToTalkOptions) {}

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined'
    );
  }

  async start(): Promise<void> {
    if (!PushToTalkRecorder.isSupported()) {
      throw new VoiceCaptureError('Voice capture is not supported in this browser.');
    }
    this.chunks = [];
    this.startedAt = performance.now();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, channelCount: 1 },
      });
    } catch (err) {
      throw new VoiceCaptureError(
        err instanceof Error ? `Microphone access denied: ${err.message}` : 'Microphone access denied.',
      );
    }

    this.context = new AudioContext();
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    await this.context.audioWorklet.addModule('/pcm-worklet-processor.js');
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture-processor');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.chunks.push(event.data);
      this.opts?.onLevel?.(rms(event.data));
    };
    source.connect(this.node);
  }

  /**
   * Discards the recording immediately without resampling or emitting audio.
   * Cleans up all audio nodes, tracks, and the AudioContext.
   */
  async cancel(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();

    this.chunks = [];
    this.node = null;
    this.context = null;
    this.stream = null;
  }

  /**
   * Stops capture and returns the buffered utterance, resampled to 16kHz and
   * PCM16-encoded. Safe to call even if `start()` threw partway through —
   * tears down whatever was actually acquired rather than assuming all of
   * `stream`/`context`/`node` exist together.
   */
  async stop(): Promise<RecordedUtterance> {
    const durationMs = performance.now() - this.startedAt;
    const nativeSampleRate = this.context?.sampleRate ?? TARGET_SAMPLE_RATE;

    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close();

    const totalLength = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    if (totalLength === 0) {
      this.chunks = [];
      this.node = null;
      this.context = null;
      this.stream = null;
      return { audioBase64: '', durationMs };
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    this.chunks = [];
    this.node = null;
    this.context = null;
    this.stream = null;

    const resampled = resampleLinear(merged, nativeSampleRate, TARGET_SAMPLE_RATE);
    const pcm16 = floatTo16BitPcm(resampled);
    return { audioBase64: int16ArrayToBase64(pcm16), durationMs };
  }
}
