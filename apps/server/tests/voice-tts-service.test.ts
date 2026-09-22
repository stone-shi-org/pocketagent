import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '@pocketagent/protocol';
import { VoiceTtsService } from '../src/voice/tts-service.js';
import type { LiveSttClient, SynthesizedSpeech } from '../src/voice/live-stt-client.js';
import type { TtsAudioChunk } from '../src/voice/turn-tts-pump.js';
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
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Once only. ' } as AgentEvent);
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
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Testing model. ' } as AgentEvent);
    await flush();

    expect(synthesize).toHaveBeenCalledWith('Testing model.', 'kokoro-82m-v1');
  });
});
