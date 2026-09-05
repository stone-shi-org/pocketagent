/** OpenAI wire format is snake_case; kept verbatim rather than translated,
    since these objects are serialized straight into the request body and
    parsed straight out of the response — a translation layer here would be
    pure overhead with a chance to get the mapping wrong. */
export interface PlannerLlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type PlannerChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: PlannerLlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface PlannerLlmCompletion {
  content: string | null;
  toolCalls: PlannerLlmToolCall[];
}

/**
 * One piece of a streamed completion. `text_delta` arrives zero or more
 * times as the model's reply is generated; `done` arrives exactly once, at
 * the end, with the fully assembled result — the same shape `PlannerLlmCompletion`
 * always had, so a caller that only wants the final answer can ignore every
 * `text_delta` and just read the last event.
 */
export type PlannerLlmStreamEvent = { type: 'text_delta'; text: string } | ({ type: 'done' } & PlannerLlmCompletion);

export class PlannerLlmError extends Error {
  override readonly name = 'PlannerLlmError';
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

export interface PlannerLlmClientOptions {
  baseUrl: string;
  apiKey: string | null;
  /** Injected in tests so no real network call is ever made. */
  fetchImpl?: typeof fetch;
}

/**
 * A thin client for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * `streamComplete` always sends `stream: true` and parses the response as
 * Server-Sent Events — the standard OpenAI streaming contract every
 * OpenAI-compatible gateway implements by definition of claiming that
 * compatibility (verified live against this deployment's own configured
 * gateway, `omniroute.local.shifamily.com`, which identifies itself as an
 * OpenAI/Anthropic-compatible router; a valid API key was not available to
 * run an authenticated call end to end, so this follows the documented
 * contract rather than an observed one — see PA-6 for the invitation to
 * verify against a live key if the exact shape ever needs correcting).
 *
 * Text deltas (`choices[0].delta.content`) are yielded as they arrive so
 * `PlannerChatService` can stream them to the browser as `text_delta` events
 * without ever persisting a partial block — only the fully assembled `text`
 * survives to the transcript, the same "deltas are transport, not history"
 * split a structured session's own JSONL transcript already relies on.
 *
 * Tool calls stream too (`delta.tool_calls[].index`, with `id`/`function.name`
 * typically present only on that call's first chunk and `function.arguments`
 * accumulating as a raw string across every later chunk for the same index),
 * but a partial tool call cannot be validated or executed — so those chunks
 * are accumulated internally and never surfaced as their own stream events;
 * only the fully assembled calls appear in the final `done` event, the same
 * way a real Claude Agent SDK turn only shows a `tool_use` once the whole
 * call is known.
 *
 * Uses the platform's native `fetch` rather than a dependency, the same
 * choice `sessions/opencode-server.ts` already made for outbound HTTP in this
 * codebase.
 */
export class PlannerLlmClient {
  constructor(private readonly opts: PlannerLlmClientOptions) {}

  async *streamComplete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = joinUrl(this.opts.baseUrl, '/chat/completions');

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          ...(tools && tools.length > 0 ? { tools } : {}),
        }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new PlannerLlmError(
        `Could not reach the planner LLM endpoint: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PlannerLlmError(
        `Planner LLM endpoint returned ${res.status}: ${body.slice(0, 500)}`,
        res.status,
      );
    }

    const reader = res.body?.getReader();
    if (!reader) {
      throw new PlannerLlmError('Planner LLM endpoint returned no readable stream body.');
    }

    const decoder = new TextDecoder();
    // Keyed by the wire `index` OpenAI's streaming format uses to say which
    // in-progress tool call a chunk belongs to — not by call id, since the id
    // itself typically only appears on that call's very first chunk.
    const toolCallsByIndex = new Map<number, { id: string; name: string; args: string }>();
    let contentSoFar = '';
    let sawAnyChunk = false;
    let buffer = '';

    const handleLine = (line: string): PlannerLlmStreamEvent | null => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return null;
      const payload = trimmed.slice(5).trim();
      if (payload.length === 0 || payload === '[DONE]') return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return null; // A malformed chunk is dropped rather than aborting the whole stream.
      }
      sawAnyChunk = true;

      const choice = (
        parsed as {
          choices?: {
            delta?: {
              content?: string | null;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        }
      ).choices?.[0];
      const delta = choice?.delta;

      for (const call of delta?.tool_calls ?? []) {
        const existing = toolCallsByIndex.get(call.index);
        if (!existing) {
          toolCallsByIndex.set(call.index, {
            id: call.id ?? `call_${call.index}`,
            name: call.function?.name ?? '',
            args: call.function?.arguments ?? '',
          });
        } else {
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.args += call.function.arguments;
        }
      }

      if (delta?.content) {
        contentSoFar += delta.content;
        return { type: 'text_delta', text: delta.content };
      }
      return null;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n');
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          const event = handleLine(line);
          if (event) yield event;
          boundary = buffer.indexOf('\n');
        }
      }
      if (buffer.length > 0) {
        const event = handleLine(buffer);
        if (event) yield event;
      }
    } catch (err) {
      throw new PlannerLlmError(`Lost connection to the planner LLM endpoint: ${(err as Error).message}`);
    }

    if (!sawAnyChunk) {
      throw new PlannerLlmError('Planner LLM endpoint returned an empty stream.');
    }

    const toolCalls: PlannerLlmToolCall[] = Array.from(toolCallsByIndex.values())
      .filter((call) => call.name.length > 0)
      .map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } }));
    const content = contentSoFar.length > 0 ? contentSoFar : null;

    if (content === null && toolCalls.length === 0) {
      throw new PlannerLlmError('Planner LLM response had no message content or tool calls.');
    }

    yield { type: 'done', content, toolCalls };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
