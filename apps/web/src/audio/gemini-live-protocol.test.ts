import { describe, expect, it } from 'vitest';
import {
  LiveTurnTracker,
  approvalOutcomeMessage,
  audioMessage,
  parseDurationMs,
  parseServerMessage,
  sampleRateFromMime,
  seedMessage,
  setupMessage,
  textMessage,
  toolResponseMessage,
} from './gemini-live-protocol.js';

/**
 * PA-96. The fixtures below are trimmed copies of real messages from
 * `gemini-3.8-live`, captured while building this — the parser is written
 * against what the service sends, not against what the docs describe.
 */

describe('parseServerMessage', () => {
  it('reads setupComplete and ignores the empty keep-alives the service sends', () => {
    expect(parseServerMessage({ setupComplete: {} })).toEqual([{ type: 'setupComplete' }]);
    expect(parseServerMessage({})).toEqual([]);
    expect(parseServerMessage(null)).toEqual([]);
    expect(parseServerMessage('nope')).toEqual([]);
  });

  it('reads audio at the rate its mime type names, and skips thinking-text parts', () => {
    const events = parseServerMessage({
      serverContent: {
        modelTurn: {
          parts: [
            { text: '**Determining the Answer**' },
            { inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } },
          ],
        },
      },
    });
    expect(events).toEqual([{ type: 'audio', data: 'AAAA', sampleRateHz: 24000 }]);
  });

  it('reads transcriptions, interruption and turn completion in application order', () => {
    const events = parseServerMessage({
      serverContent: {
        inputTranscription: { text: 'what is' },
        outputTranscription: { text: 'The secret' },
        interrupted: true,
        turnComplete: true,
      },
    });
    expect(events.map((e) => e.type)).toEqual(['inputTranscript', 'outputTranscript', 'interrupted', 'turnComplete']);
  });

  it('reads top-level usage, counting thinking tokens as output', () => {
    const [usage] = parseServerMessage({
      usageMetadata: { promptTokenCount: 606, responseTokenCount: 53, totalTokenCount: 659, thoughtsTokenCount: 48 },
    });
    expect(usage).toEqual({ type: 'usage', inputTokens: 606, outputTokens: 101 });
    expect(parseServerMessage({ usageMetadata: {} })).toEqual([{ type: 'usage', inputTokens: null, outputTokens: null }]);
  });

  it('reads tool calls, dropping malformed entries and defaulting args', () => {
    const [event] = parseServerMessage({
      toolCall: {
        functionCalls: [
          { name: 'list_workspaces', args: {}, id: 'call_546756' },
          { name: 'read_file', id: 'call_2' },
          { name: 'no_id' },
        ],
      },
    });
    expect(event).toEqual({
      type: 'toolCall',
      calls: [
        { id: 'call_546756', name: 'list_workspaces', args: {} },
        { id: 'call_2', name: 'read_file', args: {} },
      ],
    });
  });

  it('reads resumption handles only when resumable, and goAway time left', () => {
    expect(parseServerMessage({ sessionResumptionUpdate: { newHandle: 'h1', resumable: true } })).toEqual([
      { type: 'resumptionHandle', handle: 'h1' },
    ]);
    // Observed: an update with no handle at all, before the first turn.
    expect(parseServerMessage({ sessionResumptionUpdate: {} })).toEqual([]);
    expect(parseServerMessage({ sessionResumptionUpdate: { newHandle: 'h2', resumable: false } })).toEqual([]);
    expect(parseServerMessage({ goAway: { timeLeft: '10s' } })).toEqual([{ type: 'goAway', timeLeftMs: 10000 }]);
    expect(parseServerMessage({ toolCallCancellation: { ids: ['a', 3] } })).toEqual([
      { type: 'toolCallCancellation', ids: ['a'] },
    ]);
  });

  it('parses rates and durations defensively', () => {
    expect(sampleRateFromMime('audio/pcm;rate=16000')).toBe(16000);
    expect(sampleRateFromMime('audio/pcm')).toBe(24000);
    expect(sampleRateFromMime('audio/pcm;rate=5')).toBe(24000);
    expect(parseDurationMs('1.5s')).toBe(1500);
    expect(parseDurationMs('soon')).toBeNull();
  });
});

describe('client messages', () => {
  it('sends only the model in setup, since the token locks the rest', () => {
    expect(setupMessage('models/gemini-3.8-live')).toEqual({ setup: { model: 'models/gemini-3.8-live' } });
  });

  it('uses realtimeInput for audio and typed text', () => {
    expect(audioMessage('QUJD')).toEqual({ realtimeInput: { audio: { data: 'QUJD', mimeType: 'audio/pcm;rate=16000' } } });
    expect(textMessage('hi')).toEqual({ realtimeInput: { text: 'hi' } });
  });

  it('seeds history as context, not as a question to answer', () => {
    expect(seedMessage([])).toBeNull();
    expect(seedMessage([{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }])).toEqual({
      clientContent: {
        turns: [
          { role: 'user', parts: [{ text: 'a' }] },
          { role: 'model', parts: [{ text: 'b' }] },
        ],
        turnComplete: false,
      },
    });
  });

  it('answers every call, including a parked one, so no response is held open', () => {
    const base = { toolUseId: 't', approvalId: null };
    expect(
      toolResponseMessage([
        { ...base, callId: 'a', name: 'read_file', status: 'completed', output: 'contents' },
        { ...base, callId: 'b', name: 'exec_command', status: 'refused', output: 'Tool "exec_command" is disabled globally.' },
        { ...base, callId: 'c', name: 'mkdir', status: 'awaiting_approval', output: 'waiting', approvalId: 'ap1' },
      ]),
    ).toEqual({
      toolResponse: {
        functionResponses: [
          { id: 'a', name: 'read_file', response: { output: 'contents' } },
          { id: 'b', name: 'exec_command', response: { error: 'Tool "exec_command" is disabled globally.' } },
          { id: 'c', name: 'mkdir', response: { status: 'awaiting_user_approval', message: 'waiting' } },
        ],
      },
    });
  });

  it('reports an approval outcome as a turn Gemini will speak about', () => {
    const ran = approvalOutcomeMessage('mkdir', 'Created x', false) as { clientContent: { turns: { parts: { text: string }[] }[]; turnComplete: boolean } };
    expect(ran.clientContent.turnComplete).toBe(true);
    expect(ran.clientContent.turns[0]!.parts[0]!.text).toContain('approved it and it ran. Result: Created x');
    const denied = approvalOutcomeMessage('mkdir', 'Denied by the user.', true) as typeof ran;
    expect(denied.clientContent.turns[0]!.parts[0]!.text).toContain('it did not run. Denied by the user.');
  });
});

describe('LiveTurnTracker', () => {
  it('closes a plain spoken exchange as one user_prompt, text and turn_complete', () => {
    const t = new LiveTurnTracker();
    t.heard('What is the ');
    t.heard('secret word?');
    t.said('The secret word ', 1000);
    t.said('is PINEAPPLE.', 1200);
    t.usage(606, 53);
    expect(t.turnComplete(1900)).toEqual({
      userText: 'What is the secret word?',
      modelText: 'The secret word is PINEAPPLE.',
      turnComplete: { inputTokens: 606, outputTokens: 53, durationMs: 900 },
    });
    expect(t.turnComplete(2000)).toEqual({ turnComplete: { inputTokens: null, outputTokens: null, durationMs: 0 } });
  });

  it('flushes before a tool call, and closes the turn only after the reply that follows it', () => {
    const t = new LiveTurnTracker();
    t.heard('List my workspaces');
    t.said('Let me check.', 100);
    expect(t.flushForToolCall(150)).toEqual({ userText: 'List my workspaces', modelText: 'Let me check.' });
    t.usage(605, 7);
    // Gemini ends the generation right after the tool call — not the turn.
    expect(t.turnComplete(160)).toBeNull();
    t.said('You have alpha and beta.', 400);
    t.usage(700, 20);
    expect(t.turnComplete(600)).toEqual({
      modelText: 'You have alpha and beta.',
      turnComplete: { inputTokens: 1305, outputTokens: 27, durationMs: 500 },
    });
  });

  it('carries speech heard after the model started into the next turn', () => {
    const t = new LiveTurnTracker();
    t.heard('Tell me a story.');
    t.said('Once upon a', 100);
    t.heard(' Stop, actually.');
    t.markInterrupted();
    expect(t.turnComplete(300)).toEqual({
      userText: 'Tell me a story.',
      modelText: 'Once upon a',
      turnComplete: { inputTokens: null, outputTokens: null, durationMs: 200, interrupted: true },
    });
    t.said('Sure.', 400);
    expect(t.turnComplete(500)).toMatchObject({ userText: 'Stop, actually.', modelText: 'Sure.' });
  });

  it('records a typed message as if heard, and drains leftovers on exit', () => {
    const t = new LiveTurnTracker();
    t.typed('  run the tests  ');
    expect(t.pendingUserText()).toBe('run the tests');
    t.heard(' please');
    expect(t.drain(0)).toEqual({ userText: 'run the tests please' });
    expect(t.drain(0)).toBeNull();
  });
});

describe('LiveTurnTracker.flushText', () => {
  it('persists what was said while waiting on an approval without closing the turn', () => {
    const t = new LiveTurnTracker();
    t.heard('Make a folder');
    t.flushForToolCall(0);
    t.turnComplete(10);
    t.said('Please approve it on screen.', 20);
    expect(t.flushText(30)).toEqual({ modelText: 'Please approve it on screen.' });
    t.said('Done, the folder exists.', 40);
    expect(t.turnComplete(60)).toMatchObject({ modelText: 'Done, the folder exists.', turnComplete: { durationMs: 60 } });
  });
});
