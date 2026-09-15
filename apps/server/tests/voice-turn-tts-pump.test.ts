import { describe, it, expect, vi } from 'vitest';
import { TurnTtsPump, type TtsAudioChunk } from '../src/voice/turn-tts-pump.js';
import type { SynthesizedSpeech } from '../src/voice/live-stt-client.js';

/** A promise plus its resolve/reject, for controlling exactly when a fake
 *  `synthesize()` call settles — needed to deterministically land `cancel()`
 *  in the middle of an in-flight call rather than racing real timers. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function speech(text: string): SynthesizedSpeech {
  return { pcm: Buffer.from(text, 'utf8'), sampleRateHz: 24000 };
}

describe('TurnTtsPump', () => {
  it('emits chunks in order, one per pushed sentence, with increasing sentenceSeq', async () => {
    const chunks: TtsAudioChunk[] = [];
    const synthesize = vi.fn(async (text: string) => speech(text));
    const pump = new TurnTtsPump('turn-1', synthesize, (c) => chunks.push(c), () => {});

    pump.push('First.');
    pump.push('Second.');
    pump.push('Third.');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(chunks.map((c) => c.data)).toEqual([
      Buffer.from('First.').toString('base64'),
      Buffer.from('Second.').toString('base64'),
      Buffer.from('Third.').toString('base64'),
    ]);
    expect(chunks.map((c) => c.sentenceSeq)).toEqual([0, 1, 2]);
    expect(chunks.every((c) => c.turnId === 'turn-1' && !c.done)).toBe(true);
  });

  it('finish() emits a final done:true chunk after every queued sentence', async () => {
    const chunks: TtsAudioChunk[] = [];
    const pump = new TurnTtsPump('turn-1', async (t) => speech(t), (c) => chunks.push(c), () => {});

    pump.push('Only sentence.');
    pump.finish();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({ done: true, data: '', sampleRateHz: 0 });
  });

  it('cancel() before any push means nothing is ever emitted', async () => {
    const chunks: TtsAudioChunk[] = [];
    const pump = new TurnTtsPump('turn-1', async (t) => speech(t), (c) => chunks.push(c), () => {});
    pump.cancel();
    pump.push('Should never be synthesized.');
    pump.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(chunks).toEqual([]);
  });

  it('cancel() mid-flight suppresses the in-flight sentence and everything queued behind it', async () => {
    const chunks: TtsAudioChunk[] = [];
    const first = deferred<SynthesizedSpeech>();
    const synthesize = vi
      .fn<(text: string) => Promise<SynthesizedSpeech>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (t) => speech(t));

    const pump = new TurnTtsPump('turn-1', synthesize, (c) => chunks.push(c), () => {});
    pump.push('In flight when cancelled.');
    pump.push('Queued behind it.');
    pump.finish();

    // Let the pump actually call synthesize() for the first sentence and
    // start awaiting it, before cancelling.
    await new Promise((r) => setTimeout(r, 0));
    pump.cancel();
    // Now let the in-flight call resolve — its result must be dropped.
    first.resolve(speech('In flight when cancelled.'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(chunks).toEqual([]);
  });

  it("a synthesize() failure for one sentence is reported via onError and does not break the ones after it", async () => {
    const chunks: TtsAudioChunk[] = [];
    const errors: unknown[] = [];
    const synthesize = vi
      .fn<(text: string) => Promise<SynthesizedSpeech>>()
      .mockRejectedValueOnce(new Error('voice service busy'))
      .mockImplementation(async (t) => speech(t));

    const pump = new TurnTtsPump('turn-1', synthesize, (c) => chunks.push(c), (e) => errors.push(e));
    pump.push('This one fails.');
    pump.push('This one succeeds.');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('voice service busy');
    // The failed sentence emits no chunk, but the next one still does, and
    // sentenceSeq is not consumed by the failed attempt.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ sentenceSeq: 0, data: Buffer.from('This one succeeds.').toString('base64') });
  });

  it('cancel() after finish() has already been queued suppresses the done marker too', async () => {
    const chunks: TtsAudioChunk[] = [];
    const gate = deferred<SynthesizedSpeech>();
    const pump = new TurnTtsPump('turn-1', () => gate.promise, (c) => chunks.push(c), () => {});

    pump.push('Slow sentence.');
    pump.finish();
    await new Promise((r) => setTimeout(r, 0));
    pump.cancel();
    gate.resolve(speech('Slow sentence.'));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(chunks).toEqual([]);
  });
});
