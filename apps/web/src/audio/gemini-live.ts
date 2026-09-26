import type {
  GeminiLiveTokenRequest,
  GeminiLiveTokenResponse,
  GeminiLiveToolCall,
  GeminiLiveToolCallsResponse,
  GeminiLiveTranscriptRequest,
} from '@pocketagent/protocol';
import { floatTo16BitPcm, int16ArrayToBase64, base64ToInt16Array, int16ToFloat32 } from './pcm.js';
import { rms } from './vad.js';
import { SampleBatcher, StreamingResampler, scheduleChunk } from './pcm-stream.js';
import { ensureAudioWorkletModule, getSharedAudioContext, unlockAudioContext } from './audio-context.js';
import {
  GEMINI_INPUT_SAMPLE_RATE,
  LiveTurnTracker,
  approvalOutcomeMessage,
  audioMessage,
  parseServerMessage,
  seedMessage,
  setupMessage,
  textMessage,
  toolResponseMessage,
  type GeminiServerEvent,
} from './gemini-live-protocol.js';
import { getVoiceMicDeviceIdPref } from '../agent/voice-prefs.js';

/**
 * PA-96: one Gemini Live session for one Pocket Agent chat, driven from the
 * browser.
 *
 * The page talks to Google directly — audio never passes through this app's
 * server, so no new long-lived upstream socket per chat and nothing about the
 * "terminal I/O is never logged or persisted" posture changes. What *does*
 * pass through the server is everything consequential: the token (minted
 * there, constraint-locked, single-use), every tool call (run through the
 * planner's own approval gate by the bridge), and the transcript (persisted
 * there as ordinary chat events).
 *
 * Load-bearing details, all found against the real service:
 * - Every (re)connect mints a new token. Resuming consumes a token use, and
 *   the resumption handle only takes effect when baked into the token.
 * - `turnComplete` arrives right after a `toolCall`, before it is answered;
 *   `LiveTurnTracker` owns what that means for the transcript.
 * - A dead socket must turn the mic indicator off (PA-83's "voice mode just
 *   went dead" rule) rather than leave it listening to nothing — hence
 *   `onError` on any unrecoverable close.
 */

/** From `WebSocket` open to `setupComplete`. */
const CONNECT_TIMEOUT_MS = 8000;
/** ~100ms of 16kHz audio per message. */
const MIC_BATCH_SAMPLES = GEMINI_INPUT_SAMPLE_RATE / 10;
/** Unplanned drops retried before giving up and turning live mode off. */
const MAX_RECONNECT_ATTEMPTS = 3;
const IDLE_CHECK_INTERVAL_MS = 15_000;

export type GeminiLiveState = 'connecting' | 'live' | 'reconnecting' | 'stopped';

export interface GeminiLiveApi {
  mintGeminiLiveToken(chatId: string, body?: GeminiLiveTokenRequest): Promise<GeminiLiveTokenResponse>;
  runGeminiLiveToolCalls(chatId: string, calls: GeminiLiveToolCall[]): Promise<GeminiLiveToolCallsResponse>;
  recordGeminiLiveTranscript(chatId: string, body: GeminiLiveTranscriptRequest): Promise<void>;
  endGeminiLive(chatId: string): Promise<void>;
}

export interface GeminiLiveControllerOptions {
  chatId: string;
  api: GeminiLiveApi;
  deviceId?: string;
  onState?: (state: GeminiLiveState) => void;
  /** What Gemini has heard this turn so far — the strip's "you" line. */
  onHeard?: (text: string) => void;
  /** What Gemini has said this turn so far — the strip's "Gemini" line. */
  onSaid?: (text: string) => void;
  onLevel?: (level: number) => void;
  onSpeaking?: (speaking: boolean) => void;
  /** Unrecoverable: the session is over and the caller should turn live mode off. */
  onError?: (message: string) => void;
  /** Informational, e.g. the idle auto-off. The session is over when `stopped` follows. */
  onNotice?: (message: string) => void;
  /** Injected in tests. */
  createSocket?: (url: string) => WebSocket;
}

export class GeminiLiveError extends Error {
  override readonly name = 'GeminiLiveError';
}

const playbackContext = getSharedAudioContext;

/**
 * Plays Gemini's streamed PCM gaplessly by scheduling each chunk on the audio
 * clock right where the previous one ends — see `pcm-stream.ts` for why the
 * sentence-at-a-time `TtsPlaybackQueue` cannot serve here. `flush()` is the
 * barge-in: Gemini sends `interrupted` when it heard the user start talking,
 * and everything already scheduled has to go at once.
 */
class StreamingPcmPlayer {
  private scheduledEnd = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(private readonly onSpeaking?: (speaking: boolean) => void) {}

  enqueue(base64: string, sampleRateHz: number): void {
    const context = playbackContext();
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const samples = int16ToFloat32(base64ToInt16Array(base64));
    if (samples.length === 0) return;
    const buffer = context.createBuffer(1, samples.length, sampleRateHz);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = scheduleChunk(context.currentTime, this.scheduledEnd);
    source.start(startAt);
    this.scheduledEnd = startAt + buffer.duration;
    const wasSilent = this.sources.size === 0;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size === 0) this.onSpeaking?.(false);
    };
    if (wasSilent) this.onSpeaking?.(true);
  }

  flush(): void {
    const hadAudio = this.sources.size > 0;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already ended.
      }
    }
    this.sources.clear();
    this.scheduledEnd = 0;
    if (hadAudio) this.onSpeaking?.(false);
  }
}

/** Streams the microphone as 16kHz PCM16, ~100ms per callback. */
class MicStream {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private silentGain: GainNode | null = null;

  constructor(
    private readonly onChunk: (base64: string) => void,
    private readonly onLevel?: (level: number) => void,
    private readonly deviceId?: string,
  ) {}

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      throw new GeminiLiveError('Voice capture is not supported in this browser.');
    }
    const chosen = this.deviceId ?? getVoiceMicDeviceIdPref();
    const base: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: chosen ? { ...base, deviceId: { exact: chosen } } : base,
      });
    } catch (err) {
      if (!chosen) throw new GeminiLiveError(`Microphone access denied: ${(err as Error).message}`);
      // The remembered device is gone (unplugged headset) — same fallback the
      // other capture paths take (PA-94).
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      } catch (fallbackErr) {
        throw new GeminiLiveError(`Microphone access denied: ${(fallbackErr as Error).message}`);
      }
    }
    this.context = new AudioContext();
    if (this.context.state === 'suspended') await this.context.resume().catch(() => {});
    const workletUrl = typeof window !== 'undefined'
      ? new URL('/pcm-worklet-processor.js', window.location.href).href
      : '/pcm-worklet-processor.js';
    await ensureAudioWorkletModule(this.context, workletUrl);
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture-processor');
    const resampler = new StreamingResampler(this.context.sampleRate, GEMINI_INPUT_SAMPLE_RATE);
    const batcher = new SampleBatcher(MIC_BATCH_SAMPLES);
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      this.onLevel?.(rms(event.data));
      const batch = batcher.push(floatTo16BitPcm(resampler.push(event.data)));
      if (batch) this.onChunk(int16ArrayToBase64(batch));
    };
    source.connect(this.node);

    // iOS Safari / WebKit: WebAudio engine is pull-based from the output
    // destination. AudioWorkletProcessor.process() is only invoked if the node
    // graph leads to destination. A muted GainNode completes the pull path
    // without playing mic audio back through speakers.
    this.silentGain = this.context.createGain();
    this.silentGain.gain.setValueAtTime(0, this.context.currentTime);
    this.node.connect(this.silentGain);
    this.silentGain.connect(this.context.destination);
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.silentGain?.disconnect();
    this.silentGain = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close().catch(() => {});
    this.node = null;
    this.context = null;
    this.stream = null;
  }
}

export class GeminiLiveController {
  private socket: WebSocket | null = null;
  private socketLive = false;
  private state: GeminiLiveState = 'stopped';
  private stopping = false;
  private mic: MicStream | null = null;
  private readonly player: StreamingPcmPlayer;
  private readonly tracker = new LiveTurnTracker();
  private resumeHandle: string | null = null;
  private reconnectAttempts = 0;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idleMinutes = 0;
  private lastActivityAt = Date.now();
  /** Serialises transcript posts and tool-bridge calls so the server writes
      them in the order Gemini produced them. */
  private work: Promise<void> = Promise.resolve();
  /** `tool_use` id → tool name, for calls parked on approval. */
  private readonly parked = new Map<string, string>();
  /** Messages that must reach Gemini but arrived while reconnecting. */
  private outbox: unknown[] = [];
  private mutedUntilTurnEnd = false;

  constructor(private readonly opts: GeminiLiveControllerOptions) {
    this.player = new StreamingPcmPlayer(opts.onSpeaking);
  }

  /** Call synchronously inside the click that turns live mode on, so iOS
      lets the playback context start. Harmless anywhere else. */
  static prime(): void {
    void unlockAudioContext();
  }

  static isSupported(): boolean {
    return (
      typeof WebSocket !== 'undefined' &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined' &&
      !!globalThis.navigator?.mediaDevices?.getUserMedia
    );
  }

  get currentState(): GeminiLiveState {
    return this.state;
  }

  async start(): Promise<void> {
    if (!GeminiLiveController.isSupported()) {
      throw new GeminiLiveError('Gemini Live needs a browser with microphone and Web Audio support.');
    }
    this.stopping = false;
    this.setState('connecting');
    try {
      await this.connect(false);
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.mic = new MicStream(
      (chunk) => {
        if (this.socketLive) this.send(audioMessage(chunk));
      },
      this.opts.onLevel,
      this.opts.deviceId,
    );
    try {
      await this.mic.start();
    } catch (err) {
      await this.stop();
      throw err;
    }
    this.lastActivityAt = Date.now();
    this.idleTimer = setInterval(() => this.checkIdle(), IDLE_CHECK_INTERVAL_MS);
  }

  /** Ends the session: nothing heard is lost (the tracker is drained into the
      transcript), and the server is told so it can release deferred work. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    this.clearConnectTimer();
    await this.mic?.stop().catch(() => {});
    this.mic = null;
    this.closeSocket();
    this.player.flush();
    this.opts.onLevel?.(0);
    const leftover = this.tracker.drain(Date.now());
    if (leftover) this.enqueueWork(() => this.opts.api.recordGeminiLiveTranscript(this.opts.chatId, leftover));
    await this.work.catch(() => {});
    await this.opts.api.endGeminiLive(this.opts.chatId).catch(() => {});
    this.setState('stopped');
  }

  /** A typed message while live: Gemini answers it, not the planner LLM. */
  sendText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || this.state === 'stopped' || this.stopping) return false;
    this.tracker.typed(trimmed);
    this.opts.onHeard?.(this.tracker.pendingUserText());
    this.touch();
    this.sendOrQueue(textMessage(trimmed));
    return true;
  }

  /**
   * The "Stop" button while Gemini is talking. The Live API has no "cancel
   * this reply" message short of the user speaking over it, so the rest of
   * the current reply is dropped as it arrives, until the turn ends.
   */
  stopSpeaking(): void {
    this.player.flush();
    this.mutedUntilTurnEnd = true;
  }

  /**
   * Call (and await) before resolving an approval this session's call is
   * parked on. The tool result is written server-side the moment the human
   * decides; without this, whatever Gemini said while waiting would be
   * persisted after that result instead of before it.
   */
  async flushSpeech(): Promise<void> {
    const report = this.tracker.flushText(Date.now());
    if (report) this.enqueueWork(() => this.opts.api.recordGeminiLiveTranscript(this.opts.chatId, report));
    await this.work.catch(() => {});
  }

  /** Whether one of this session's calls is parked on approval. */
  hasParkedCalls(): boolean {
    return this.parked.size > 0;
  }

  /**
   * A human decided an approval that one of this session's calls was parked
   * on; tell Gemini the real outcome. Returns whether the call was ours.
   */
  relayApprovalOutcome(toolUseId: string, content: string, isError: boolean): boolean {
    const name = this.parked.get(toolUseId);
    if (name === undefined) return false;
    this.parked.delete(toolUseId);
    this.touch();
    this.sendOrQueue(approvalOutcomeMessage(name, content, isError));
    return true;
  }

  // ---- connection -------------------------------------------------------------

  private async connect(resume: boolean): Promise<void> {
    const minted = await this.opts.api.mintGeminiLiveToken(
      this.opts.chatId,
      resume && this.resumeHandle ? { resumeHandle: this.resumeHandle } : {},
    );
    if (this.stopping) return;
    this.idleMinutes = minted.idleMinutes;
    const url = `${minted.wsUrl}?access_token=${encodeURIComponent(minted.token)}`;
    const socket = this.opts.createSocket ? this.opts.createSocket(url) : new WebSocket(url);
    this.socket = socket;
    this.socketLive = false;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        this.clearConnectTimer();
        if (err) reject(err);
        else resolve();
      };
      this.connectTimer = setTimeout(() => {
        settle(new GeminiLiveError('Gemini Live did not answer within 8 seconds.'));
        if (this.socket === socket) this.closeSocket();
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => socket.send(JSON.stringify(setupMessage(minted.model)));
      socket.onmessage = (event) => {
        void this.readMessage(event.data).then((raw) => {
          if (this.socket !== socket) return;
          for (const ev of parseServerMessage(raw)) {
            if (ev.type === 'setupComplete') {
              this.socketLive = true;
              this.reconnectAttempts = 0;
              const seed = seedMessage(minted.seedTurns);
              if (seed) this.send(seed);
              const pending = this.outbox;
              this.outbox = [];
              for (const message of pending) this.send(message);
              this.setState('live');
              settle();
            } else {
              this.handle(ev);
            }
          }
        });
      };
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socketLive = false;
        if (!settled) {
          settle(new GeminiLiveError(closeMessage(event)));
          return;
        }
        this.onUnexpectedClose(event);
      };
      socket.onerror = () => {
        // `onclose` always follows with the code; nothing to add here.
      };
    });
  }

  private onUnexpectedClose(event: CloseEvent): void {
    if (this.stopping) return;
    this.player.flush();
    if (this.resumeHandle && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts += 1;
      void this.reconnect();
      return;
    }
    this.fail(closeMessage(event));
  }

  private async reconnect(): Promise<void> {
    this.setState('reconnecting');
    this.closeSocket();
    try {
      await this.connect(true);
    } catch (err) {
      if (this.stopping) return;
      if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts += 1;
        await new Promise((r) => setTimeout(r, 500 * this.reconnectAttempts));
        if (!this.stopping) void this.reconnect();
        return;
      }
      this.fail(err instanceof Error ? err.message : 'Could not reconnect to Gemini Live.');
    }
  }

  private fail(message: string): void {
    this.opts.onError?.(message);
    void this.stop();
  }

  // ---- inbound ------------------------------------------------------------------

  private handle(ev: GeminiServerEvent): void {
    const now = Date.now();
    switch (ev.type) {
      case 'audio':
        this.touch();
        this.tracker.modelAudio(now);
        if (!this.mutedUntilTurnEnd) this.player.enqueue(ev.data, ev.sampleRateHz);
        break;
      case 'inputTranscript':
        this.touch();
        this.tracker.heard(ev.text);
        this.opts.onHeard?.(this.tracker.pendingUserText());
        break;
      case 'outputTranscript':
        this.touch();
        this.tracker.said(ev.text, now);
        this.opts.onSaid?.(this.tracker.pendingModelText());
        break;
      case 'interrupted':
        // Gemini heard the user start talking: silence the reply now. Only its
        // audio stops — nothing the agent was doing is cancelled, because an
        // interruption is not an instruction.
        this.player.flush();
        this.tracker.markInterrupted();
        break;
      case 'usage':
        this.tracker.usage(ev.inputTokens, ev.outputTokens);
        break;
      case 'turnComplete': {
        this.mutedUntilTurnEnd = false;
        const report = this.tracker.turnComplete(now);
        if (report) this.enqueueWork(() => this.opts.api.recordGeminiLiveTranscript(this.opts.chatId, report));
        this.opts.onHeard?.(this.tracker.pendingUserText());
        this.opts.onSaid?.('');
        break;
      }
      case 'toolCall':
        this.touch();
        this.runTools(ev.calls, now);
        break;
      case 'toolCallCancellation':
        // The user barged in over a pending call. The bridge may already have
        // run it — a tool cannot be un-run — so there is nothing to undo; the
        // result simply goes unused by Gemini.
        break;
      case 'resumptionHandle':
        this.resumeHandle = ev.handle;
        break;
      case 'goAway':
        // The socket's ~10-minute lifetime is ending. Resume on a fresh one.
        if (this.resumeHandle && !this.stopping) {
          this.reconnectAttempts = 0;
          void this.reconnect();
        }
        break;
      case 'error':
        this.fail(ev.message);
        break;
      case 'setupComplete':
        break;
    }
  }

  private runTools(calls: GeminiLiveToolCall[], now: number): void {
    const flushed = this.tracker.flushForToolCall(now);
    const socket = this.socket;
    this.enqueueWork(async () => {
      if (flushed) await this.opts.api.recordGeminiLiveTranscript(this.opts.chatId, flushed);
      let message: unknown;
      try {
        const { results } = await this.opts.api.runGeminiLiveToolCalls(this.opts.chatId, calls);
        for (const r of results) if (r.status === 'awaiting_approval') this.parked.set(r.toolUseId, r.name);
        message = toolResponseMessage(results);
      } catch (err) {
        // Gemini must never be left waiting on a call that will not be
        // answered: report the bridge failure as the tool's error.
        const output = `The tool could not be run: ${err instanceof Error ? err.message : 'unknown error'}`;
        message = toolResponseMessage(
          calls.map((c) => ({ callId: c.id, toolUseId: '', name: c.name, status: 'refused' as const, output, approvalId: null })),
        );
      }
      // Only to the session that asked: a response for a call id the new
      // session never issued would be an error there.
      if (this.socket === socket && this.socketLive) this.send(message);
    });
  }

  // ---- plumbing ---------------------------------------------------------------

  private enqueueWork(task: () => Promise<void>): void {
    this.work = this.work.then(task).catch((err: unknown) => {
      // A transcript write failing must not wedge the chain or kill the
      // session; it is surfaced, and the next write still goes out.
      this.opts.onNotice?.(err instanceof Error ? `Could not save to the chat: ${err.message}` : 'Could not save to the chat.');
    });
  }

  private async readMessage(data: unknown): Promise<unknown> {
    try {
      const text = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : new TextDecoder().decode(data as ArrayBuffer);
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === 1) this.socket.send(JSON.stringify(message));
  }

  private sendOrQueue(message: unknown): void {
    if (this.socketLive) this.send(message);
    else this.outbox.push(message);
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.socketLive = false;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close(1000);
    } catch {
      // Already closing.
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  private checkIdle(): void {
    if (this.idleMinutes <= 0 || this.stopping) return;
    if (Date.now() - this.lastActivityAt < this.idleMinutes * 60_000) return;
    this.opts.onNotice?.(`Gemini Live turned off after ${this.idleMinutes} minute${this.idleMinutes === 1 ? '' : 's'} without speech.`);
    void this.stop();
  }

  private setState(state: GeminiLiveState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
  }
}

function closeMessage(event: CloseEvent): string {
  const reason = event.reason ? `: ${event.reason}` : '';
  return `Gemini Live disconnected (${event.code}${reason}).`;
}
