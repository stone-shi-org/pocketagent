import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CreateSessionRequest,
  MAX_SESSION_TITLE_CHARS,
  type PromptImage,
  type SessionInfo,
} from '@pocketagent/protocol';
import { setPendingPrompt, takePendingPrompt } from './pending-prompt.js';
import { continueFinishedSession } from '../pages/AgentPage.js';

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

  it('resumes a finished session that has a stored 136-character title, clamps the title, and delivers the pending prompt (PA-163)', async () => {
    const tes46Title =
      '[TES-46] LLM coding benchmark: Java problems from interview-question-bank, judged on Piston (retries, tools, LLM judge, composite score)';
    expect(tes46Title).toHaveLength(136);

    const createSession = vi.fn(async (input: unknown) => {
      // Validate through the real protocol schema the server enforces.
      const parsed = CreateSessionRequest.parse(input);
      return {
        id: 'resumed-sess-1',
        title: parsed.title ?? 'default',
      } as SessionInfo;
    });
    const onResumed = vi.fn();

    const created = await continueFinishedSession({
      api: { createSession },
      session: {
        agent: 'agy',
        cwd: '/data/repo/test',
        agentSessionId: 'f919dbb7-tes46',
        title: tes46Title,
        skipPermissionsEnabled: true,
      },
      text: 'continue the benchmark run',
      onResumed,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    const passedTitle = (createSession.mock.calls[0]![0] as { title: string }).title;
    expect(passedTitle).toHaveLength(MAX_SESSION_TITLE_CHARS);
    expect(passedTitle.endsWith('…')).toBe(true);
    expect(created.id).toBe('resumed-sess-1');
    expect(onResumed).toHaveBeenCalledWith('resumed-sess-1');
    expect(takePendingPrompt('resumed-sess-1')).toEqual({ text: 'continue the benchmark run' });
  });

  it('does not queue a pending prompt or navigate when resuming fails (PA-163)', async () => {
    const createSession = vi.fn(async () => {
      throw new Error('network failure');
    });
    const onResumed = vi.fn();

    await expect(
      continueFinishedSession({
        api: { createSession },
        session: {
          agent: 'agy',
          cwd: '/data/repo/test',
          agentSessionId: 'f919dbb7-tes46',
          title: 'Short title',
          skipPermissionsEnabled: true,
        },
        text: 'do not lose this prompt',
        onResumed,
      }),
    ).rejects.toThrow('network failure');

    expect(onResumed).not.toHaveBeenCalled();
  });
});
