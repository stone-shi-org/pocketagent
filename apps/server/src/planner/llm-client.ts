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

/** OpenAI's own `usage` shape, snake_case for the same reason as the wire
    types above. `null` when the provider never sent one — not every
    OpenAI-compatible implementation honors `stream_options.include_usage`,
    so the settings-page turn footer simply omits the tokens/tps bits rather
    than showing a fabricated zero. */
export interface PlannerLlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface PlannerLlmCompletion {
  content: string | null;
  toolCalls: PlannerLlmToolCall[];
  usage: PlannerLlmUsage | null;
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

  /**
   * `GET /models`, the standard OpenAI-compatible discovery endpoint —
   * returns every model id the provider is willing to list, for the settings
   * page's "query models" button. Unlike `streamComplete`, this is a plain
   * JSON GET with no streaming to parse.
   */
  async listModels(): Promise<string[]> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = joinUrl(this.opts.baseUrl, '/models');

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'GET',
        headers: {
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
      });
    } catch (err) {
      throw new PlannerLlmError(`Could not reach the planner LLM endpoint: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PlannerLlmError(
        `Planner LLM endpoint returned ${res.status}: ${body.slice(0, 500)}`,
        res.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new PlannerLlmError(`Planner LLM endpoint's /models response was not valid JSON: ${(err as Error).message}`);
    }

    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new PlannerLlmError("Planner LLM endpoint's /models response had no \"data\" array.");
    }
    return data
      .map((entry) => (entry && typeof entry === 'object' ? String((entry as { id?: unknown }).id ?? '') : ''))
      .filter((id) => id.length > 0);
  }

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
          // Asks for a final usage-only chunk (`choices: []`, a `usage`
          // object) before `[DONE]` — the standard OpenAI streaming opt-in,
          // silently ignored by any compatible implementation that doesn't
          // support it (an unknown JSON field, not an unknown parameter
          // name). Without it there is no token count to compute tokens/sec
          // from, so the turn footer just omits that bit — see `usage`
          // below.
          stream_options: { include_usage: true },
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
    let usage: PlannerLlmUsage | null = null;
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

      // The `stream_options.include_usage` chunk carries a top-level `usage`
      // alongside an empty `choices: []` — captured here rather than
      // returned as its own stream event, the same "assemble internally,
      // surface only in `done`" treatment tool-call chunks already get.
      const rawUsage = (parsed as { usage?: { prompt_tokens?: number; completion_tokens?: number } | null }).usage;
      if (rawUsage) {
        usage = {
          promptTokens: rawUsage.prompt_tokens ?? 0,
          completionTokens: rawUsage.completion_tokens ?? 0,
        };
      }

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

    yield { type: 'done', content, toolCalls, usage };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
