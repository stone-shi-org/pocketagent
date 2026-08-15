import { beforeEach, describe, expect, it } from 'vitest';
import type { PromptImage } from '@pocketagent/protocol';
import { setPendingPrompt, takePendingPrompt } from './pending-prompt.js';

const IMAGE: PromptImage = { mediaType: 'image/png', data: 'aGVsbG8=' };

describe('pending prompt handoff', () => {
  beforeEach(() => {
    // Drain anything a previous test left behind.
    takePendingPrompt('a');
    takePendingPrompt('b');
  });

  it('hands the prompt to the session it was typed for', () => {
    setPendingPrompt('a', 'do the thing');
    expect(takePendingPrompt('a')).toEqual({ text: 'do the thing' });
  });

  it('yields it exactly once', () => {
    // The session page re-runs its effect on reconnect; sending the first
    // prompt twice would silently start two turns.
    setPendingPrompt('a', 'do the thing');
    expect(takePendingPrompt('a')).toEqual({ text: 'do the thing' });
    expect(takePendingPrompt('a')).toBeNull();
  });

  it('never gives one session the prompt meant for another', () => {
    setPendingPrompt('a', 'for a');
    expect(takePendingPrompt('b')).toBeNull();
    expect(takePendingPrompt('a')).toEqual({ text: 'for a' });
  });

  it('trims, and treats blank input as nothing to send', () => {
    setPendingPrompt('a', '  spaced  ');
    expect(takePendingPrompt('a')).toEqual({ text: 'spaced' });

    setPendingPrompt('a', '   ');
    expect(takePendingPrompt('a')).toBeNull();
  });

  it('replaces an earlier prompt rather than queueing behind it', () => {
    setPendingPrompt('a', 'first');
    setPendingPrompt('b', 'second');
    expect(takePendingPrompt('a')).toBeNull();
    expect(takePendingPrompt('b')).toEqual({ text: 'second' });
  });

  it('carries an attached image alongside the text', () => {
    setPendingPrompt('a', 'look at this', IMAGE);
    expect(takePendingPrompt('a')).toEqual({ text: 'look at this', image: IMAGE });
  });

  it('keeps a pending entry for an image-only prompt, even with blank text', () => {
    // An attached image makes an otherwise-empty send worth keeping — only
    // truly nothing (no text, no image) should be dropped.
    setPendingPrompt('a', '   ', IMAGE);
    expect(takePendingPrompt('a')).toEqual({ text: '', image: IMAGE });
  });
});
