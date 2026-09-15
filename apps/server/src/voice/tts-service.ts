import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@pocketagent/protocol';
import type { StructuredLikeSession } from '../sessions/manager.js';
import type { LiveSttClient } from './live-stt-client.js';
import { SentenceChunker } from './sentence-chunker.js';
import { TurnTtsPump } from './turn-tts-pump.js';

export type { TtsAudioChunk } from './turn-tts-pump.js';

/**
 * PA-20 Phase 3: subscribes to a structured session's `AgentEvent` stream
 * while its live-listen mode is on, sentence-chunks the streamed reply, and
 * synthesizes + emits each sentence's audio as soon as it's ready.
 *
 * A separate module rather than logic baked into `StructuredSession` (or any
 * of the other four structured-like backends) — it subscribes the same way
 * `SessionManager.wire()`'s own always-on `session.on('event', ...)`
 * listener does (a plain `EventEmitter`, many independent listeners
 * coexist), so nothing about how a session is implemented needs to change
 * for this to work across every structured-like backend that emits
 * `text_delta`.
 *
 * Emits `audio:<sessionId>` with a `TtsAudioChunk` for `ws/index.ts`'s
 * per-connection handler to forward to whichever browser tab(s) are
 * currently attached — dynamic, session-scoped event names rather than one
 * generic event every connection would have to filter, since only a
 * genuinely small number of sessions have voice mode on at once.
 */
export class VoiceTtsService extends EventEmitter {
  private readonly attached = new Set<string>();
  private readonly chunkers = new Map<string, SentenceChunker>();
  private readonly pumps = new Map<string, TurnTtsPump>();

  constructor(
    private readonly client: LiveSttClient | null,
    private readonly isVoiceModeEnabled: (sessionId: string) => boolean,
    private readonly logger?: { warn: (obj: unknown, msg: string) => void },
  ) {
    super();
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Broadcasts a `voice_mode` toggle to every tab currently attached to this
   * session, including the one that sent it — `ws/index.ts`'s `attachTo`
   * subscribes each connection to `mode:<sessionId>` the same way it does
   * `audio:<sessionId>`, so this is the single fan-out point rather than the
   * `case 'voice_mode':` handler replying only to its own socket. The
   * persistent "mic is live" indicator and the toggle itself must never
   * disagree across two tabs open on the same chat.
   */
  notifyModeChanged(sessionId: string, enabled: boolean): void {
    this.emit(`mode:${sessionId}`, enabled);
  }

  /** Idempotent: subscribes to this session's event stream at most once for
   *  its whole lifetime, regardless of how many times voice mode is toggled
   *  on/off. The listener itself checks `isVoiceModeEnabled` on every event,
   *  so toggling off needs no unsubscribe — it just becomes a no-op. */
  attach(session: StructuredLikeSession): void {
    if (!this.client) return;
    if (this.attached.has(session.id)) return;
    this.attached.add(session.id);

    session.on('event', (_seq: number, event: AgentEvent) => {
      if (this.isVoiceModeEnabled(session.id)) this.handleEvent(session.id, event);
    });

    // A dead session has nothing left to synthesize for; drop its state so a
    // long-lived server does not accumulate one chunker/pump per session
    // that ever turned voice mode on, for as long as the process runs.
    session.on('exit', () => this.cleanupSession(session.id));
  }

  /** Called from `ws/index.ts`'s `interrupt` handler — the one explicit,
   *  non-heuristic signal that a turn just ended early (there is no
   *  dedicated "interrupted" `AgentEvent`; see the PA-20 Phase 2-4
   *  implementation notes). Stops any further audio for the *current* turn
   *  without needing to know its `turnId`. */
  cancel(sessionId: string): void {
    this.pumps.get(sessionId)?.cancel();
    this.chunkers.get(sessionId)?.reset();
  }

  private handleEvent(sessionId: string, event: AgentEvent): void {
    switch (event.kind) {
      case 'user_prompt':
        this.startTurn(sessionId);
        break;
      case 'text_delta':
        this.onDelta(sessionId, event.text);
        break;
      case 'turn_complete':
        this.onTurnComplete(sessionId);
        break;
    }
  }

  private chunkerFor(sessionId: string): SentenceChunker {
    let chunker = this.chunkers.get(sessionId);
    if (!chunker) {
      chunker = new SentenceChunker();
      this.chunkers.set(sessionId, chunker);
    }
    return chunker;
  }

  private startTurn(sessionId: string): void {
    // A still-running pump from a turn that ended without a `turn_complete`
    // we saw (should not happen, but this is user-facing audio — fail safe
    // rather than let two turns' audio interleave) is cancelled first.
    this.pumps.get(sessionId)?.cancel();
    this.chunkerFor(sessionId).reset();
    const turnId = crypto.randomUUID();
    this.pumps.set(
      sessionId,
      new TurnTtsPump(
        turnId,
        (text) => this.client!.synthesize(text),
        (chunk) => this.emit(`audio:${sessionId}`, chunk),
        (err) =>
          this.logger?.warn(
            { sessionId, turnId, err },
            'voice: TTS synthesis failed for one sentence; reply text is unaffected',
          ),
      ),
    );
  }

  private onDelta(sessionId: string, text: string): void {
    // Voice mode can be toggled on mid-reply — there is no `user_prompt` to
    // have started a turn in that case, so start one lazily rather than
    // dropping the rest of an already-in-progress reply's audio entirely.
    if (!this.pumps.has(sessionId)) this.startTurn(sessionId);
    const sentences = this.chunkerFor(sessionId).push(text);
    for (const sentence of sentences) this.pumps.get(sessionId)!.push(sentence);
  }

  private onTurnComplete(sessionId: string): void {
    const pump = this.pumps.get(sessionId);
    if (!pump) return;
    const remainder = this.chunkerFor(sessionId).flush();
    if (remainder) pump.push(remainder);
    pump.finish();
    this.pumps.delete(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    this.attached.delete(sessionId);
    this.chunkers.delete(sessionId);
    this.pumps.get(sessionId)?.cancel();
    this.pumps.delete(sessionId);
  }
}
