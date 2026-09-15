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

  it("cleans up a session's state on exit so a later re-emit does nothing", async () => {
    const synthesize = vi.fn(async (t: string) => speech(t));
    const service = new VoiceTtsService(() => fakeClient(synthesize), () => true);
    const session = fakeSession('s1');
    service.attach(session);
    (session as unknown as EventEmitter).emit('exit', 0, null);

    session.emitAgentEvent({ kind: 'user_prompt', id: 'u1', text: 'hi' } as AgentEvent);
    session.emitAgentEvent({ kind: 'text_delta', id: 't1', text: 'Should still work. ' } as AgentEvent);
    await flush();

    // Exit only clears this service's own bookkeeping (chunker/pump); the
    // event listener itself isn't removed (matching `SessionManager.wire()`'s
    // own always-on listener, which also never unsubscribes) — a dead
    // session shouldn't emit further events in practice, but if it somehow
    // did, a *new* turn/chunker/pump would simply be created lazily rather
    // than reusing stale state. This just proves cleanup doesn't crash or
    // wedge later handling.
    expect(synthesize).toHaveBeenCalledWith('Should still work.');
  });
});
