import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@pocketagent/protocol';
import { VoiceTtsService } from '../src/voice/tts-service.js';
import type { LiveSttClient, SynthesizedSpeech } from '../src/voice/live-stt-client.js';
import { TurnTtsPump, type TtsAudioChunk } from '../src/voice/turn-tts-pump.js';
import type { StructuredLikeSession } from '../src/sessions/manager.js';

/** A minimal fake structured session: just enough `EventEmitter` surface for
 *  `VoiceTtsService.attach()` to subscribe to (`on('event', ...)`,
 *  `on('exit', ...)`) and a `.emit('event', seq, agentEvent)` helper for
 *  tests to drive it, without spinning up a real SDK-backed session. */
function fakeSession(id: string): StructuredLikeSession & { emitAgentEvent: (e: AgentEvent) => void } {
  const emitter = new EventEmitter();
  let seq = 0;
  return Object.assign(emitter, {
    id,
    transport: 'structured' as const,
    emitAgentEvent(event: AgentEvent) {
      emitter.emit('event', ++seq, event);
    },
  }) as unknown as StructuredLikeSession & { emitAgentEvent: (e: AgentEvent) => void };
}

function fakeClient(synthesize: LiveSttClient['synthesize']): LiveSttClient {
  return {
    transcribe: async () => {
      throw new Error('not used in these tests');
    },
    synthesize,
  };
}

function speech(text: string): SynthesizedSpeech {
  return { pcm: Buffer.from(text, 'utf8'), sampleRateHz: 24000 };
}

async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('VoiceTtsService', () => {
  it('does nothing when voice mode is off for the session', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => false);
    const session = fakeSession('s1');
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Hello there. ' } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    expect(synthesize).not.toHaveBeenCalled();
  });

  it('synthesizes each sentence as it completes and emits a final done chunk', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'First one. ' } as AgentEvent);
    await flush();
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Second one.' } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize).toHaveBeenNthCalledWith(1, 'First one.');
    // "Second one." had no trailing whitespace, only flushed at turn_complete.
    expect(synthesize).toHaveBeenNthCalledWith(2, 'Second one.');
    expect(chunks).toHaveLength(3); // two sentences + the final done marker
    expect(chunks[0]).toMatchObject({ sentenceSeq: 0, done: false });
    expect(chunks[1]).toMatchObject({ sentenceSeq: 1, done: false });
    expect(chunks[2]).toMatchObject({ done: true, data: '' });
    // Every chunk in one turn shares the same turnId.
    expect(new Set(chunks.map((c) => c.turnId)).size).toBe(1);
  });

  it('cancel() stops audio for the current turn without needing its turnId', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Will be cancelled. ' } as AgentEvent);
    service.cancel('s1');
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    // turn_complete after cancel() finds no active pump (cancel() didn't
    // clear it, but the pump itself is cancelled) — either way nothing new
    // should ever reach the browser for this turn.
    expect(chunks).toEqual([]);
  });

  it('starts a turn lazily when voice mode is toggled on mid-reply (no user_prompt seen)', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    // No 'user_prompt' this time — the reply was already streaming when
    // voice mode got turned on.
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Mid-reply sentence. ' } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledWith('Mid-reply sentence.');
    expect(chunks.some((c) => c.done)).toBe(true);
  });

  it('attach() is idempotent — a second call does not double-subscribe', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    service.attach(session);
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    // Tagged, because PA-89 holds *untagged* text until `turn_complete` — this
    // test is about double-subscription, not about that hold.
    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't1',
      text: '<speak>Once only. </speak>',
    } as AgentEvent);
    await flush();

    // Double-subscription would call synthesize() twice for the same sentence.
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when live-stt is not configured', async () => {
    const service = new VoiceTtsService(() => null, () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Hello. ' } as AgentEvent);
    await flush();

    expect(service.isConfigured()).toBe(false);
    expect(chunks).toEqual([]);
  });

  it('notifyModeChanged() fans out to every listener on that session, not just one', () => {
    const service = new VoiceTtsService(() => fakeClient(async (t) => speech(t)), () => true);
    const seenByTabA: boolean[] = [];
    const seenByTabB: boolean[] = [];
    service.on('mode:s1', (enabled: boolean) => seenByTabA.push(enabled));
    service.on('mode:s1', (enabled: boolean) => seenByTabB.push(enabled));
    // A different session's listener must never see this session's toggle.
    const seenByOtherSession: boolean[] = [];
    service.on('mode:s2', (enabled: boolean) => seenByOtherSession.push(enabled));

    service.notifyModeChanged('s1', true);

    expect(seenByTabA).toEqual([true]);
    expect(seenByTabB).toEqual([true]);
    expect(seenByOtherSession).toEqual([]);
  });

  it("PA-83: marks a session exited so a later re-emit synthesizes nothing", async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    // `isVoiceModeEnabled` hardcoded `true` regardless of session state —
    // deliberately, to isolate this from `SessionManager.voiceModeSessions`'s
    // own lifecycle (only cleared by `forget()` or ten-minutes-later
    // housekeeping, per `manager.ts`), and prove the `exited` gate holds even
    // when that flag is stale.
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    service.attach(session);
    (session as unknown as EventEmitter).emit('exit', 0, null);

    // A real child process can still flush a few buffered stdout bytes — and
    // this file's own listener is never unsubscribed — a tick after `exit`
    // fires; simulating exactly that trailing event is the whole point of
    // this test (see the "talk-back keeps going after I terminated the
    // session" report this fixes).
    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Should never be synthesized. ' } as AgentEvent);
    await flush();

    expect(synthesize).not.toHaveBeenCalled();
  });

  it('PA-83: cancel() mutes the rest of the turn even once turn_complete deletes the pump', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Before stop. ' } as AgentEvent);
    await flush();
    // "Before stop." already made it to the browser — cancel() stopping a
    // *future* sentence was never in question and is not what this test is
    // about (see `chunkCountAfterStop` below).
    const chunkCountAfterStop = chunks.length;
    // The composer's "Stop speaking" button / a "skip" voice command — the
    // WS `stop_speech` handler calls exactly this, deliberately without
    // `session.interrupt()`, so the turn (and its `text_delta`s) keeps
    // coming.
    service.cancel('s1');
    // A `turn_complete` for the very turn that was just muted deletes the
    // pump out of `this.pumps` — the reproduction for the reported "stop
    // it, but it starts talking again a moment later" bug: without the
    // mute flag, the *next* `text_delta` would find no pump and lazily
    // start a brand new, unmuted one via the "voice mode toggled on
    // mid-reply" fallback.
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'After stop, same turn somehow. ' } as AgentEvent);
    await flush();

    expect(synthesize).not.toHaveBeenCalledWith('After stop, same turn somehow.');
    // No *new* chunk reached the browser after the stop point — the one
    // already-in-flight sentence from before it doesn't count against this.
    expect(chunks.length).toBe(chunkCountAfterStop);
  });

  /**
   * PA-83 follow-up: "when user stopped stream (click stream button again),
   * all talk-back must have hard stop." Turning voice mode off only flips
   * the getter below, and `attach()`'s listener consults it per *event* —
   * so it stops new `text_delta`s being chunked and does nothing whatsoever
   * about the sentences the pump is already holding, which go on being
   * synthesized and emitted. `ws/index.ts`'s `voice_mode` handler therefore
   * cancels explicitly when disabling, exactly as its `interrupt` and
   * `terminate()` siblings do; this pins that pairing.
   */
  it('PA-83: voice mode off + cancel() drops sentences the pump was already holding', async () => {
    let inFlightResolve!: (v: SynthesizedSpeech) => void;
    const inFlight = new Promise<SynthesizedSpeech>((resolve) => {
      inFlightResolve = resolve;
    });
    const synthesize = vi
      .fn<(text: string) => Promise<SynthesizedSpeech>>()
      .mockImplementationOnce(() => inFlight)
      .mockImplementation(async (t: string) => speech(t));

    let voiceModeEnabled = true;
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => voiceModeEnabled);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    // Two complete sentences in one delta: the first is handed to
    // `synthesize` (and left pending), the second waits behind it in the
    // pump's promise chain — the state the toggle has to be able to cancel.
    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't1',
      text: '<speak>One. Two. </speak>',
    } as AgentEvent);
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);

    // The toggle: the getter flips *and* the handler cancels.
    voiceModeEnabled = false;
    service.cancel('s1');
    inFlightResolve(speech('One.'));
    await flush();

    // Nothing reached the browser, and the sentence still queued behind the
    // in-flight one never even reached live-stt.
    expect(chunks).toEqual([]);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it('PA-83: a genuinely new user_prompt un-mutes and talks again normally', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Stopped mid-reply. ' } as AgentEvent);
    service.cancel('s1');
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    // A new, real turn — not another stray delta of the old one.
    session.emitAgentEvent({ kind: 'user_prompt', id: 'u2', text: 'go on' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't2', text: 'Fresh reply.' } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 1,
      costUsd: null,
    } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledWith('Fresh reply.');
  });

  it('passes configured model from getModel getter to client.synthesize (PA-81)', async () => {
    const synthesize = vi.fn(async (t: string, _m?: string | null) => speech(t));
    const currentModel = 'kokoro-82m-v1';
    const service = new VoiceTtsService(
      () => fakeClient(synthesize),
      () => true,
      undefined,
      () => currentModel,
    );
    const session = fakeSession('s1');
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't1',
      text: '<speak>Testing model. </speak>',
    } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledWith('Testing model.', 'kokoro-82m-v1');
  });

  it('PA-89: never speaks pre-tool scratchpad, and honours the post-tool <speak> tag', async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'what is the weather?' } as AgentEvent);
    // Pre-tool scratchpad / preamble text
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'I need to fetch the weather URL. ' } as AgentEvent);
    await flush();

    // Tool use occurs
    session.emitAgentEvent({
      kind: 'tool_use',
      id: 'tu1',
      name: 'fetch_url',
      input: { url: 'https://weather.test' },
      summary: 'Fetch weather',
      filePath: null,
    } as AgentEvent);
    session.emitAgentEvent({
      kind: 'tool_result',
      id: 'tr1',
      toolUseId: 'tu1',
      content: '66 degrees and sunny',
      isError: false,
    } as AgentEvent);

    // Final answer with <speak> tag
    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't2',
      text: '<speak>Today in Kirkland is sunny with a high of 66.</speak>\n\nHere is the detailed forecast.',
    } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 10,
      costUsd: null,
    } as AgentEvent);
    await flush();

    // The summary, and *only* the summary. The scratchpad was never spoken
    // (it was held, then dropped by the `tool_use`), and the written reply was
    // not narrated — which it would be if the extractor were still latched
    // into fallback by that scratchpad, as it was before PA-89.
    expect(synthesize.mock.calls.map(([t]) => t)).toEqual([
      'Today in Kirkland is sunny with a high of 66.',
    ]);
  });

  it('PA-89: a tagged lede still being synthesized survives a tool call', async () => {
    // The lede's synthesis is deliberately left pending when `tool_use`
    // lands. That is the only window in which the server can still retract
    // it — and retracting it is the regression: PA-84 asks for the summary
    // *first* precisely so a multi-minute tool-using turn is not silent, so
    // a `tool_use` that cancelled the pump would delete the one thing the
    // user is waiting to hear.
    let inFlightResolve!: (v: SynthesizedSpeech) => void;
    const inFlight = new Promise<SynthesizedSpeech>((resolve) => {
      inFlightResolve = resolve;
    });
    const synthesize = vi
      .fn<(text: string) => Promise<SynthesizedSpeech>>()
      .mockImplementationOnce(() => inFlight)
      .mockImplementation(async (t: string) => speech(t));

    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    const chunks: TtsAudioChunk[] = [];
    service.on('audio:s1', (c: TtsAudioChunk) => chunks.push(c));
    service.attach(session);

    session.emitAgentEvent({
      kind: 'user_prompt',
      id: 'u1',
      text: 'what is the weather?',
    } as AgentEvent);
    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't1',
      text: '<speak>Let me look up the weather for you.</speak>',
    } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledWith('Let me look up the weather for you.');
    expect(chunks).toEqual([]); // still synthesizing

    session.emitAgentEvent({
      kind: 'tool_use',
      id: 'tu1',
      name: 'fetch_url',
      input: { url: 'https://weather.test' },
      summary: 'Fetch weather',
      filePath: null,
    } as AgentEvent);
    await flush();

    inFlightResolve(speech('Let me look up the weather for you.'));
    await flush();

    // Reaches the browser despite the intervening tool call.
    expect(chunks.filter((c) => !c.done).length).toBe(1);

    session.emitAgentEvent({
      kind: 'text_delta',
      id: 't2',
      text: '<speak>It is 66 and sunny.</speak>',
    } as AgentEvent);
    session.emitAgentEvent({
      kind: 'turn_complete',
      stopReason: null,
      isError: false,
      numTurns: 1,
      durationMs: 10,
      costUsd: null,
    } as AgentEvent);
    await flush();

    expect(synthesize.mock.calls.map(([t]) => t)).toEqual([
      'Let me look up the weather for you.',
      'It is 66 and sunny.',
    ]);
  });
});

/**
 * PA-89. A Pocket Agent turn's audio can only reach the browser on the request
 * that produced it, so the drain budget is the whole of whether talk-back is
 * audible — and the failure when it is too short is *silent*, which is why it
 * survived a release. Measured against this deployment on 2026-09-23: one
 * one-sentence `<speak>` summary took ~9.5s to synthesize on live-stt's CPU
 * backend, against a budget that was then 5s, so the summary was always lost.
 */
describe('planner TTS drain budget', () => {
  /** live-stt, CPU backend, one `<speak>` sentence, measured 2026-09-23. */
  const MEASURED_ONE_SENTENCE_MS = 9_500;

  it('covers the queue it is given at the measured CPU synthesis rate', async () => {
    const { ttsDrainBudgetMs } = await import('../src/routes/planner.js');
    // An untagged reply releases every sentence at once (see
    // `SpokenTextPipeline.push`), and the pump synthesizes them serially — so
    // the budget has to grow with the queue, not just clear a single sentence.
    for (const pending of [1, 2, 3, 5, 8, 10]) {
      expect(ttsDrainBudgetMs(pending)).toBeGreaterThanOrEqual(
        pending * MEASURED_ONE_SENTENCE_MS,
      );
    }
  });

  it('stays tight when only one sentence is outstanding', async () => {
    const { ttsDrainBudgetMs } = await import('../src/routes/planner.js');
    // The point of scaling: a wedged voice service must not pin the response
    // open for minutes when there is almost nothing left to synthesize.
    expect(ttsDrainBudgetMs(1)).toBeLessThanOrEqual(40_000);
    expect(ttsDrainBudgetMs(0)).toBeLessThanOrEqual(15_000);
  });

  it('is bounded however long the reply is', async () => {
    const { ttsDrainBudgetMs } = await import('../src/routes/planner.js');
    expect(ttsDrainBudgetMs(10_000)).toBeLessThanOrEqual(180_000);
  });
});

/**
 * PA-89. `pendingSentences` is the multiplier on how long `routes/planner.ts`
 * holds the response open, so a count that leaks holds a socket open for a
 * pump with nothing left to do — and one that under-counts truncates audio.
 */
describe('TurnTtsPump.pendingSentences', () => {
  const chunks: TtsAudioChunk[] = [];
  const sink = (c: TtsAudioChunk) => chunks.push(c);

  it('counts queued work and releases it as each sentence completes', async () => {
    const pump = new TurnTtsPump('t', async (t) => speech(t), sink, () => {});
    pump.push('One.');
    pump.push('Two.');
    expect(pump.pendingSentences).toBe(2);
    await flush();
    expect(pump.pendingSentences).toBe(0);
  });

  it('releases the count when synthesis fails', async () => {
    const pump = new TurnTtsPump(
      't',
      async () => {
        throw new Error('live-stt is down');
      },
      sink,
      () => {},
    );
    pump.push('One.');
    expect(pump.pendingSentences).toBe(1);
    await flush();
    expect(pump.pendingSentences).toBe(0);
  });

  it('releases the count when the pump is cancelled mid-queue', async () => {
    const pump = new TurnTtsPump('t', async (t) => speech(t), sink, () => {});
    pump.push('One.');
    pump.cancel();
    await flush();
    expect(pump.pendingSentences).toBe(0);
  });

  it('releases the count even when the chunk sink itself throws', async () => {
    // The case the `finally` actually exists for: `synthesizeOne` handles its
    // own synthesis errors, so the only way out of it that skips a bare
    // decrement is `onChunk` throwing — which is reachable, since the planner's
    // sink writes to a socket and the session path emits to arbitrary
    // listeners. A leak here would inflate the drain budget of a finished pump.
    const pump = new TurnTtsPump(
      't',
      async (t) => speech(t),
      () => {
        throw new Error('socket went away');
      },
      () => {},
    );
    pump.push('One.');
    await flush();
    expect(pump.pendingSentences).toBe(0);
  });

  it('keeps synthesizing later sentences after the sink throws once', async () => {
    // A rejected `queue` would skip every `.then` appended after it, so one bad
    // write would silently take the rest of the turn's audio and the `done`
    // marker with it — leaving the planner's drain to time out for nothing.
    const seen: string[] = [];
    const errors: unknown[] = [];
    let first = true;
    const pump = new TurnTtsPump(
      't',
      async (t) => speech(t),
      () => {
        if (first) {
          first = false;
          throw new Error('socket went away');
        }
        seen.push('delivered');
      },
      (e) => errors.push(e),
    );
    pump.push('One.');
    pump.push('Two.');
    pump.finish();
    await flush();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual(['delivered', 'delivered']); // 2nd sentence + done
    expect(pump.pendingSentences).toBe(0);
  });
});
