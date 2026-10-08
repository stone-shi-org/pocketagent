import { describe, expect, it, vi } from 'vitest';
import { PlannerLlmClient, PlannerLlmError, type PlannerLlmStreamEvent } from '../src/planner/llm-client.js';
import { isContextOverflowMessage, isQuotaMessage, retryAfterMs } from '../src/planner/llm-errors.js';

/** PA-121: retrying transient LLM failures, the idle timeout, and error classification. */

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const ok = (text: string) => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);

async function collect(gen: AsyncGenerator<PlannerLlmStreamEvent>): Promise<PlannerLlmStreamEvent[]> {
  const out: PlannerLlmStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const client = (fetchImpl: ReturnType<typeof vi.fn>, maxRetries = 3) =>
  new PlannerLlmClient({
    baseUrl: 'https://llm.example.com',
    apiKey: null,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    retry: { maxRetries, baseDelayMs: 1, maxDelayMs: 50 },
  });

describe('PlannerLlmClient retries (PA-121)', () => {
  it('retries a 503 and a network error, announcing each retry, then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('overloaded', { status: 503 }))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockImplementation(() => ok('hi'));
    const events = await collect(client(fetchImpl).streamComplete('m', []));
    expect(events.filter((e) => e.type === 'retry').map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(events.at(-1)).toMatchObject({ type: 'done', content: 'hi' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Response('busy', { status: 429 }));
    await expect(collect(client(fetchImpl, 2).streamComplete('m', []))).rejects.toMatchObject({ statusCode: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never retries a 400, a quota error or a context overflow', async () => {
    for (const [status, body] of [
      [400, 'bad request'],
      [429, '{"error":{"code":"insufficient_quota"}}'],
      [400, "This model's maximum context length is 8192 tokens"],
    ] as const) {
      const fetchImpl = vi.fn().mockImplementation(() => new Response(body, { status }));
      await expect(collect(client(fetchImpl).streamComplete('m', []))).rejects.toBeInstanceOf(PlannerLlmError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('marks a context overflow as such, so the caller can compact instead', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      () => new Response('{"error":{"message":"prompt is too long: 210000 tokens > 200000 maximum"}}', { status: 400 }),
    );
    await expect(collect(client(fetchImpl).streamComplete('m', []))).rejects.toMatchObject({
      contextOverflow: true,
      retryable: false,
    });
  });

  it('honours retry-after-ms, and refuses to wait longer than maxDelayMs', async () => {
    const quick = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after-ms': '5' } }))
      .mockImplementation(() => ok('done'));
    const events = await collect(client(quick).streamComplete('m', []));
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ delayMs: 5 });

    const slow = vi.fn().mockImplementation(() => new Response('later', { status: 429, headers: { 'retry-after': '3600' } }));
    await expect(collect(client(slow).streamComplete('m', []))).rejects.toMatchObject({ statusCode: 429 });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('does not retry once content has been streamed', async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Response(
          new ReadableStream({
            // The chunk is delivered first; the connection then drops on the
            // next read. (`error()` straight after `enqueue()` would discard
            // the queued chunk, and nothing would have been streamed.)
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\n`));
            },
            pull(controller) {
              controller.error(new Error('socket hang up'));
            },
          }),
          { status: 200 },
        ),
    );
    const seen: PlannerLlmStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const e of client(fetchImpl).streamComplete('m', [])) seen.push(e);
      })(),
    ).rejects.toThrow(/Lost connection/);
    expect(seen).toEqual([{ type: 'text_delta', text: 'half' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a stream that goes idle, and retries it', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                // Never sends anything; closes only when the request is aborted.
                init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
              },
            }),
            { status: 200 },
          ),
      )
      .mockImplementation(() => ok('second time lucky'));
    const events = await collect(client(fetchImpl).streamComplete('m', [], undefined, undefined, { idleTimeoutMs: 30 }));
    expect(events.find((e) => e.type === 'retry')).toMatchObject({ reason: expect.stringMatching(/sent nothing for/) });
    expect(events.at(-1)).toMatchObject({ type: 'done', content: 'second time lucky' });
  });

  it('stops waiting between retries as soon as the caller aborts', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => new Response('busy', { status: 503 }));
    const slowClient = new PlannerLlmClient({
      baseUrl: 'https://llm.example.com',
      apiKey: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxRetries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 },
    });
    const controller = new AbortController();
    const started = Date.now();
    const run = collect(slowClient.streamComplete('m', [], undefined, controller.signal));
    setTimeout(() => controller.abort(), 20);
    await expect(run).rejects.toBeInstanceOf(PlannerLlmError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('sends max_tokens only when asked to', async () => {
    const fetchImpl = vi.fn().mockImplementation(() => ok('x'));
    await collect(client(fetchImpl).streamComplete('m', [], undefined, undefined, { maxTokens: 1234 }));
    await collect(client(fetchImpl).streamComplete('m', []));
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body).max_tokens).toBe(1234);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body)).not.toHaveProperty('max_tokens');
  });
});

describe('llm-errors classification', () => {
  it('recognises the common overflow phrasings and not rate limits', () => {
    for (const msg of [
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
      'prompt is too long: 210000 tokens > 200000 maximum',
      'the request exceeds the available context size, try increasing it',
      'Input is too long for requested model.',
      'context_length_exceeded',
    ]) {
      expect(isContextOverflowMessage(msg), msg).toBe(true);
    }
    expect(isContextOverflowMessage('Rate limit reached: too many tokens per minute')).toBe(false);
    expect(isContextOverflowMessage('internal server error')).toBe(false);
  });

  it('recognises quota errors', () => {
    expect(isQuotaMessage('You exceeded your current quota, please check your plan and billing details.')).toBe(true);
    expect(isQuotaMessage('overloaded')).toBe(false);
  });

  it('parses retry-after headers', () => {
    expect(retryAfterMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250);
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(10_000).toUTCString() }), 4_000)).toBe(6000);
    expect(retryAfterMs(new Headers())).toBeNull();
  });
});
