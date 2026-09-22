import { describe, it, expect } from 'vitest';

/**
 * PA-85: the parked-utterance handoff between `AgentPage` and `PromptBox`.
 *
 * `PromptBox` is a React component and this repo tests no components (no
 * jsdom render harness anywhere), so what is pinned here is the *rule* the
 * effect implements — consume every id above a high-water mark — against the
 * three sequences that broke the two simpler designs it replaced. Both were
 * real: keying the effect on `seq` alone double-appended on any remount, and
 * treating `seq` as "append one item" silently lost an utterance when two
 * parks resolved in one React batch.
 */
type Item = { text: string; seq: number };

/** Exactly the body of `PromptBox`'s review effect. */
function consume(items: Item[], mark: { current: number }): string | null {
  const pending = items.filter((item) => item.seq > mark.current);
  if (pending.length === 0) return null;
  mark.current = pending[pending.length - 1]!.seq;
  const incoming = pending
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join(' ');
  return incoming || null;
}

describe('parked-utterance handoff (PA-85)', () => {
  it('appends each newly parked utterance once', () => {
    const mark = { current: 0 };
    const items: Item[] = [];
    items.push({ text: 'rerun that', seq: 1 });
    expect(consume(items, mark)).toBe('rerun that');
    items.push({ text: 'in watch mode', seq: 2 });
    expect(consume(items, mark)).toBe('in watch mode');
  });

  it('appends the same text twice when it was genuinely said twice', () => {
    // Someone repeating themselves because they think they were not heard is
    // the single most likely thing to happen here. Comparing by text would
    // swallow the repeat.
    const mark = { current: 0 };
    const items: Item[] = [{ text: 'okay', seq: 1 }];
    expect(consume(items, mark)).toBe('okay');
    items.push({ text: 'okay', seq: 2 });
    expect(consume(items, mark)).toBe('okay');
  });

  it('appends nothing on a re-run with no new utterance (the remount case)', () => {
    // `AgentPage` never clears the list, so a remount re-runs the effect over
    // the same items. Keying on `seq` alone appended them a second time.
    const mark = { current: 0 };
    const items: Item[] = [{ text: 'rerun that', seq: 1 }];
    expect(consume(items, mark)).toBe('rerun that');
    expect(consume(items, mark)).toBeNull();
    expect(consume(items, mark)).toBeNull();
  });

  it('delivers both utterances when two parks land in one batch', () => {
    // Two `transcribeVoice` promises resolving in the same flush — normal
    // when a second utterance queues behind one slow STT call. A single
    // effect run sees only the later `seq`, so it has to catch up on both.
    const mark = { current: 0 };
    const items: Item[] = [
      { text: 'run the tests', seq: 1 },
      { text: 'in watch mode', seq: 2 },
    ];
    expect(consume(items, mark)).toBe('run the tests in watch mode');
    expect(consume(items, mark)).toBeNull();
  });

  it('never loses an utterance across any interleaving of parks and re-runs', () => {
    const mark = { current: 0 };
    const items: Item[] = [];
    const delivered: string[] = [];
    let seq = 0;
    // Park, re-run, park twice, re-run, re-run, park — an arbitrary mix.
    for (const parks of [1, 0, 2, 0, 0, 1, 3]) {
      for (let i = 0; i < parks; i++) items.push({ text: `u${++seq}`, seq });
      const got = consume(items, mark);
      if (got) delivered.push(got);
    }
    expect(delivered.join(' ').split(' ')).toEqual(items.map((i) => i.text));
  });

  it('ignores a whitespace-only park without consuming later ones', () => {
    const mark = { current: 0 };
    const items: Item[] = [{ text: '   ', seq: 1 }];
    expect(consume(items, mark)).toBeNull();
    items.push({ text: 'real text', seq: 2 });
    expect(consume(items, mark)).toBe('real text');
  });
});
