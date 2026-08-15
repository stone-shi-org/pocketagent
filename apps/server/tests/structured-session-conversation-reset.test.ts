import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from './helpers.js';

/**
 * `/clear` (and the SDK's other conversation-reset triggers) hand back a
 * `conversation_reset` message carrying a fresh conversation id, without a
 * matching `session_started` — see `normalize.ts`'s `conversation_reset` case
 * and `structured-session.ts`'s own handler for why `agentSessionId` has to
 * move to that new id or a resume after `/clear` would point at a
 * conversation that no longer exists. Kept as its own file, separate from
 * `structured-session.test.ts`, because that file's shared mock always
 * answers a prompt with a plain `result` — this needs a different one-shot
 * reply shape instead.
 */
const received: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess_original' };
      for await (const msg of prompt) {
        received.push(msg);
        yield {
          type: 'conversation_reset',
          new_conversation_id: 'sess_after_clear',
          uuid: 'u-1',
          session_id: 'sess_original',
        };
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

describe('StructuredSession: conversation_reset', () => {
  let session: InstanceType<typeof StructuredSession> | null = null;
  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('emits a conversation_reset event and moves agentSessionId to the new conversation', async () => {
    session = makeSession();
    await session.start();
    // `start()` returns once the query is spawned, not once the `pump()` loop
    // has actually consumed the first (`init`) message off it — same
    // asynchronicity `resume.test.ts` and `structured-session.test.ts` work
    // around with `waitFor` rather than assuming a synchronous handshake.
    await waitFor(() => session?.agentSessionId === 'sess_original');

    const events: unknown[] = [];
    session.on('event', (_seq: number, event: unknown) => events.push(event));

    session.prompt('/clear');
    await waitFor(() => session?.busy === false);

    expect(events).toContainEqual({ kind: 'conversation_reset', newConversationId: 'sess_after_clear' });
    expect(session.agentSessionId).toBe('sess_after_clear');
  });
});
