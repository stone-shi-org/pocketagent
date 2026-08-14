import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './helpers.js';

/**
 * `StructuredSession.busy` (`_busy`, structured-session.ts) has driven the new
 * `SessionInfo.busy` field (see `manager.ts`'s `toInfo`) since before this
 * test existed, but nothing pinned its own true/false transitions directly —
 * only the events it happens to accompany. The Agent SDK is mocked for the
 * same reason `resume.test.ts` mocks it: running a real agent would test
 * Anthropic's code, cost money, and not be deterministic.
 *
 * The fake `query()` below turns every message the session pushes into its
 * input stream into one `result` message back, which is enough to drive a
 * real prompt -> turn_complete cycle without hand-rolled synchronization.
 */
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess_test' };
      for await (const _msg of prompt) {
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          duration_ms: 5,
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
    },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    applyFlagSettings: async () => {},
  }),
}));

// Imported after the mock is registered — see `resume.test.ts` for the same
// ordering requirement.
const { StructuredSession } = await import('../src/sessions/structured-session.js');

function makeSession() {
  return new StructuredSession({
    id: 'test-session',
    title: 'Test',
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    cwd: '/tmp',
    env: {},
    workspaceLabel: 'tmp',
    eventBufferBytes: 64 * 1024,
    createdAt: Date.now(),
  });
}

describe('StructuredSession.busy', () => {
  let session: InstanceType<typeof StructuredSession> | null = null;
  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('is false before any prompt, true immediately on prompt(), false again after turn_complete', async () => {
    session = makeSession();
    await session.start();
    expect(session.busy).toBe(false);

    expect(session.prompt('hello')).toBe(true);
    // Synchronous: `prompt()` sets `_busy` itself, before the SDK reports
    // anything back. A UI dot flipping only on the *next* event would lag by
    // a full round trip for no reason.
    expect(session.busy).toBe(true);

    await waitFor(() => session?.busy === false);
  });

  it('goes busy again for a second turn on the same session', async () => {
    session = makeSession();
    await session.start();

    session.prompt('first');
    await waitFor(() => session?.busy === false);

    session.prompt('second');
    expect(session.busy).toBe(true);
    await waitFor(() => session?.busy === false);
  });
});
