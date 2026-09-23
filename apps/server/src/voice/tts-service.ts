import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@pocketagent/protocol';
import type { StructuredLikeSession } from '../sessions/manager.js';
import type { LiveSttClient } from './live-stt-client.js';
import { SpokenTextPipeline } from './spoken-text-pipeline.js';
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
 *
 * Takes a *getter* for the `LiveSttClient`, not a constructed instance —
 * `liveSttUrl` is a live (no-restart) `SETTINGS_FIELDS` entry (PA-20,
 * following user feedback that it belongs in Settings, not
 * `POCKETAGENT_LIVE_STT_URL`), so `app.ts` passes `() =>
 * (config.liveSttUrl ? createLiveSttClient(config.liveSttUrl) : null)`
 * rather than resolving it once at construction — the same
 * `getCodeServerBaseUrl: () => config.codeServerBaseUrl` shape
 * `ProjectService` already uses for its own live field. Constructing a
 * `LiveSttClient` is cheap (it wraps `fetch`, opens nothing eagerly), so
 * re-deriving it on every call is not a meaningful cost for how rarely
 * voice mode toggles or a turn starts.
 */
export class VoiceTtsService extends EventEmitter {
  private readonly attached = new Set<string>();
  /**
   * PA-84: per-session `SpokenTextExtractor` + `SentenceChunker`, held
   * together so a reset can never clear one and leave the other — see
   * `SpokenTextPipeline`'s own doc comment for why that pairing is load-bearing
   * rather than tidy.
   */
  private readonly pipelines = new Map<string, SpokenTextPipeline>();
  private readonly pumps = new Map<string, TurnTtsPump>();
  /**
   * PA-83: sessions whose process has already exited — a hard, permanent
   * stop, checked before anything else in the `'event'` listener below.
   * Deliberately *not* the same thing as `!isVoiceModeEnabled(id)`: that
   * flag is `SessionManager.voiceModeSessions`, which is only cleared by an
   * explicit `forget()` or by 10-minutes-later housekeeping
   * (`manager.ts`'s sweep) — for up to that whole window after a session
   * merely *exits*, the flag still reads `true`. And it's not the same as
   * `!attached.has(id)` either, since `attach()`'s listener is never
   * unsubscribed (matching `SessionManager.wire()`'s own always-on
   * listener). Node's child-process stdout can still flush a few final
   * buffered bytes — and this file's stream parser can still emit the
   * `AgentEvent`s they decode into — a tick or two *after* the process's
   * own `'exit'` event fires; without this set, that trailing
   * `text_delta` (or worse, a stray `user_prompt`) would lazily start a
   * brand new, unmuted `TurnTtsPump` and keep talking to a session that no
   * longer exists. This is the fix for "even after I terminated the
   * session, talk-back is still going on" (PA-83 follow-up).
   */
  private readonly exited = new Set<string>();
  /**
   * PA-83 #3/#4: sessions where a human explicitly stopped the talk-back
   * for the turn in progress (`cancel()`, called from `stop_speech` — the
   * composer's Stop button, a "skip" voice command — and also from
   * `interrupt`). The underlying turn is not necessarily dead the way
   * `interrupt`'s is: `stop_speech` deliberately leaves the agent's turn
   * running, so more `text_delta`/`turn_complete` events for it keep
   * arriving, and none of them may resurrect audio — `onDelta`'s own
   * "start a pump lazily if one is missing" fallback (for the unrelated
   * "voice mode toggled on mid-reply" case) is exactly the mechanism that
   * would otherwise do it, the moment `turn_complete` deletes the
   * cancelled pump out from under a reply that is still continuing.
   * Cleared the instant a genuinely *new* turn starts (`user_prompt`),
   * matching the reporter's own words: "never tried to talk again unless
   * NEW turn."
   */
  private readonly mutedUntilNextTurn = new Set<string>();

  constructor(
    private readonly getClient: () => LiveSttClient | null,
    private readonly isVoiceModeEnabled: (sessionId: string) => boolean,
    private readonly logger?: { warn: (obj: unknown, msg: string) => void },
    private readonly getModel?: () => string | null,
  ) {
    super();
  }

  isConfigured(): boolean {
    return this.getClient() !== null;
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
    if (!this.getClient()) return;
    if (this.attached.has(session.id)) return;
    this.attached.add(session.id);

    session.on('event', (_seq: number, event: AgentEvent) => {
      // PA-83: checked first and unconditionally — see `exited`'s own doc
      // comment for why `isVoiceModeEnabled` alone cannot be trusted here.
      if (this.exited.has(session.id)) return;
      if (this.isVoiceModeEnabled(session.id)) this.handleEvent(session.id, event);
    });

    // A dead session has nothing left to synthesize for; drop its state so a
    // long-lived server does not accumulate one pipeline/pump per session
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
    this.pipelines.get(sessionId)?.reset();
    // PA-83: stays silent through the rest of *this* turn no matter how
    // many more `text_delta`s or stray `turn_complete`s arrive for it —
    // see `mutedUntilNextTurn`'s own doc comment. Harmless for the
    // `interrupt` caller too: that turn is meant to be over, so muting it
    // until the next real `user_prompt` changes nothing it didn't already
    // want.
    this.mutedUntilNextTurn.add(sessionId);
  }

  private handleEvent(sessionId: string, event: AgentEvent): void {
    switch (event.kind) {
      case 'user_prompt':
        // PA-83: a real new turn is the one thing that un-mutes — see
        // `mutedUntilNextTurn`'s own doc comment.
        this.mutedUntilNextTurn.delete(sessionId);
        this.startTurn(sessionId);
        break;
      case 'tool_use':
        // When an agent invokes a tool, any pre-tool text was intermediate scratchpad.
        // Cancel in-flight pre-tool TTS audio and reset the pipeline so the post-tool final answer
        // starts with a fresh pump and extractor to catch the <speak> summary tag.
        this.pumps.get(sessionId)?.cancel();
        this.pumps.delete(sessionId);
        this.pipelineFor(sessionId).reset();
        break;
      case 'text_delta':
        this.onDelta(sessionId, event.text);
        break;
      case 'turn_complete':
        this.onTurnComplete(sessionId);
        break;
    }
  }

  private pipelineFor(sessionId: string): SpokenTextPipeline {
    let pipeline = this.pipelines.get(sessionId);
    if (!pipeline) {
      pipeline = new SpokenTextPipeline();
      this.pipelines.set(sessionId, pipeline);
    }
    return pipeline;
  }

  private startTurn(sessionId: string): void {
    // A still-running pump from a turn that ended without a `turn_complete`
    // we saw (should not happen, but this is user-facing audio — fail safe
    // rather than let two turns' audio interleave) is cancelled first.
    this.pumps.get(sessionId)?.cancel();
    this.pipelineFor(sessionId).reset();
    const turnId = crypto.randomUUID();
    this.pumps.set(
      sessionId,
      new TurnTtsPump(
        turnId,
        // Re-resolved per sentence, not captured once per turn — a URL
        // change mid-turn (unlikely, but this is a live setting) shouldn't
        // pin the rest of that turn's audio to a stale client. An explicit
        // throw (rather than a non-null assertion on a possibly-null
        // client) if it's been cleared entirely mid-turn — still caught by
        // `TurnTtsPump.push()`'s own try/catch and routed to `onError`,
        // the same graceful "this sentence's audio is lost, the text reply
        // is not" degradation any other synthesis failure gets.
        (text) => {
          const client = this.getClient();
          if (!client) throw new Error('live-stt is no longer configured');
          const model = this.getModel?.();
          return model ? client.synthesize(text, model) : client.synthesize(text);
        },
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
    // PA-83: a stop/skip for this turn must not be undone by the very
    // fallback that exists for a different case (below) — without this
    // check, `turn_complete` deleting the cancelled pump out from under a
    // still-continuing reply would make the next `text_delta` look
    // indistinguishable from "voice mode just got toggled on mid-reply,"
    // and resurrect audio the user explicitly stopped.
    if (this.mutedUntilNextTurn.has(sessionId)) return;
    // Voice mode can be toggled on mid-reply — there is no `user_prompt` to
    // have started a turn in that case, so start one lazily rather than
    // dropping the rest of an already-in-progress reply's audio entirely.
    if (!this.pumps.has(sessionId)) this.startTurn(sessionId);
    const sentences = this.pipelineFor(sessionId).push(text);
    for (const sentence of sentences) this.pumps.get(sessionId)!.push(sentence);
  }

  private onTurnComplete(sessionId: string): void {
    const pump = this.pumps.get(sessionId);
    if (!pump) return;
    for (const sentence of this.pipelineFor(sessionId).flush()) pump.push(sentence);
    pump.finish();
    this.pumps.delete(sessionId);
  }

  private cleanupSession(sessionId: string): void {
    this.attached.delete(sessionId);
    this.pipelines.delete(sessionId);
    this.pumps.get(sessionId)?.cancel();
    this.pumps.delete(sessionId);
    this.mutedUntilNextTurn.delete(sessionId);
    // PA-83: permanent, unlike everything else cleaned up above — a new
    // session gets a new id, so there is nothing to ever un-exit this one
    // for. See `exited`'s own doc comment for why this, and not the state
    // cleared above, is what actually closes the "talk-back keeps going
    // after I terminated the session" gap.
    this.exited.add(sessionId);
  }
}
