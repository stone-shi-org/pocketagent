import { describe, expect, it } from 'vitest';
import { PtySession, type PtySessionSpec } from '../src/sessions/pty-session.js';
import type { ProcessBackend, ProcessHandle } from '../src/backends/index.js';
import { waitFor } from './helpers.js';

/**
 * A `ProcessHandle` double that lets a test push bytes as if they came from
 * the real process, without spawning one. `PtySession.busy` is derived purely
 * from the classifier's reaction to that data, so this is enough to exercise
 * it without the PTY/tmux machinery `sessions.test.ts` needs for everything
 * else.
 */
function fakeHandle(): ProcessHandle & { emit(data: string): void } {
  let onData: ((data: string) => void) | null = null;
  return {
    pid: 1234,
    externalId: null,
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: (listener) => {
      onData = listener;
    },
    onExit: () => {},
    detach: () => {},
    emit(data: string) {
      onData?.(data);
    },
  };
}

const fakeBackend: ProcessBackend = {
  id: 'direct',
  displayName: 'fake',
  survivesServerRestart: false,
  checkAvailable: async () => ({ available: true }),
  start: async () => {
    throw new Error('not used — tests call adopt() directly');
  },
};

function makeSpec(overrides: Partial<PtySessionSpec> = {}): PtySessionSpec {
  return {
    id: 's1',
    title: 'test',
    agent: 'shell',
    agentDisplayName: 'Shell',
    command: '/bin/sh',
    args: [],
    cwd: '/tmp',
    env: {},
    envOverrideKeys: [],
    cols: 80,
    rows: 24,
    workspaceLabel: 'tmp',
    outputBufferBytes: 1024 * 1024,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * The classifier only looks at the last 1500 characters of its rolling tail
 * (`classifier.ts`'s `recent`), so a working-pattern match does not clear
 * just because the *next* line happens to be a prompt — the spinner text is
 * still sitting inside that window. Filler this size pushes it out, the way
 * enough real output eventually would, without the test depending on the
 * classifier's real 30s `checkIdle` timeout (not overridable from outside
 * `PtySession`, which builds its own classifier with the default).
 */
const PAST_THE_WINDOW = 'x'.repeat(2000);

describe('PtySession.busy', () => {
  it('goes true when the classifier sees a working pattern, false once that scrolls out and a prompt appears', async () => {
    const session = new PtySession(makeSpec(), fakeBackend);
    const handle = fakeHandle();
    session.adopt(handle, Date.now());

    expect(session.busy).toBe(false);

    handle.emit('⠹ Thinking… (esc to interrupt)');
    await waitFor(() => session.busy === true);

    handle.emit(`${PAST_THE_WINDOW}\n$ `);
    await waitFor(() => session.busy === false);
  });

  it('does not stay stuck busy once the classifier settles without re-emitting', async () => {
    // Regression case: `process()`/`checkIdle()` only *return* a hint set
    // when it changes (dedup in `HeuristicTerminalClassifier`) — calling
    // code that only reacted to a non-empty return would miss the moment
    // the state actually settled. `PtySession.busy` instead reads
    // `currentHints()` every time, emitted or not; this exercises exactly
    // that path by emitting the same idle-looking prompt twice in a row,
    // where the second `process()` call is guaranteed to dedup to `[]`.
    const session = new PtySession(makeSpec(), fakeBackend);
    const handle = fakeHandle();
    session.adopt(handle, Date.now());

    handle.emit('⠹ Thinking… (esc to interrupt)');
    await waitFor(() => session.busy === true);

    handle.emit(`${PAST_THE_WINDOW}\n$ `);
    await waitFor(() => session.busy === false);

    // Same shell-prompt text again: the classifier will not re-emit (state
    // unchanged, so `process()` returns `[]`), but busy must already be —
    // and must stay — false.
    handle.emit('$ ');
    expect(session.busy).toBe(false);
  });

  it('treats a plain waiting-for-input prompt as idle, not busy', async () => {
    const session = new PtySession(makeSpec(), fakeBackend);
    const handle = fakeHandle();
    session.adopt(handle, Date.now());

    handle.emit('user@host:~/src$ ');
    await waitFor(() => session.busy === false);
    // Confirm it actually classified something, rather than this trivially
    // passing because nothing happened.
    expect(session.busy).toBe(false);
  });
});
