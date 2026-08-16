import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
// Populated as `prompt()` pushes into the SDK's input stream, so tests below
// can inspect exactly what shape a call built without reaching into private
// state — cleared per test in `beforeEach`.
const received: unknown[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'sess_test' };
      for await (const msg of prompt) {
        received.push(msg);
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
    expect(session.busySince).toBeNull();

    expect(session.prompt('hello')).toBe(true);
    // Synchronous: `prompt()` sets `_busy` itself, before the SDK reports
    // anything back. A UI dot flipping only on the *next* event would lag by
    // a full round trip for no reason.
    expect(session.busy).toBe(true);
    expect(session.busySince).not.toBeNull();

    await waitFor(() => session?.busy === false);
    expect(session.busySince).toBeNull();
  });

  it('goes busy again for a second turn on the same session', async () => {
    session = makeSession();
    await session.start();

    session.prompt('first');
    await waitFor(() => session?.busy === false);

    session.prompt('second');
    expect(session.busy).toBe(true);
    expect(session.busySince).not.toBeNull();
    await waitFor(() => session?.busy === false);
    expect(session.busySince).toBeNull();
  });
});

describe('StructuredSession.prompt image attachment', () => {
  let session: InstanceType<typeof StructuredSession> | null = null;
  const image = { mediaType: 'image/png' as const, data: 'aGVsbG8=' };

  beforeEach(() => {
    received.length = 0;
  });

  afterEach(() => {
    session?.terminate();
    session = null;
  });

  it('sends an image alongside a caption as a leading content block', async () => {
    session = makeSession();
    await session.start();

    session.prompt('what is this?', image);
    await waitFor(() => session?.busy === false);

    expect(received).toHaveLength(1);
    const sdkMessage = received[0] as { message: { content: unknown } };
    expect(sdkMessage.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
      { type: 'text', text: 'what is this?' },
    ]);
  });

  it('sends an image-only prompt without a trailing empty text block', async () => {
    session = makeSession();
    await session.start();

    session.prompt('', image);
    await waitFor(() => session?.busy === false);

    const sdkMessage = received[0] as { message: { content: unknown } };
    expect(sdkMessage.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
    ]);
  });

  it('still sends a plain string for a text-only prompt, unchanged', async () => {
    session = makeSession();
    await session.start();

    session.prompt('just text');
    await waitFor(() => session?.busy === false);

    const sdkMessage = received[0] as { message: { content: unknown } };
    expect(sdkMessage.message.content).toBe('just text');
  });

  it('echoes the image on the emitted user_prompt event, for replay', async () => {
    session = makeSession();
    await session.start();

    const events: unknown[] = [];
    session.on('event', (_seq: number, event: unknown) => events.push(event));

    session.prompt('what is this?', image);
    await waitFor(() => session?.busy === false);

    expect(events[0]).toMatchObject({ kind: 'user_prompt', text: 'what is this?', image });
  });
});
