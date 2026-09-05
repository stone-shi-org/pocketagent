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
 * Non-streaming: every call to this client always sends `stream: false` and
 * gets back one full assistant turn (text and/or tool calls), not per-token
 * deltas — even though the planner's own turn *is* streamed to the browser
 * now (`PlannerChatService`'s generators, drained by `routes/planner.ts`'s
 * `streamPlannerEvents`). Those are two different layers: a turn can consist
 * of several of these round-trips (one per tool-calling iteration), and each
 * one still resolves in a single piece. Parsing a provider's own SSE format
 * varies enough between OpenAI-compatible implementations that doing it
 * blind was judged the highest-risk part of this feature — see
 * `packages/protocol/src/planner.ts`'s `PlannerChatHistoryResponse` doc
 * comment for the full reasoning. `stream: false` keeps this client to one
 * request/response with no upstream SSE parser to get wrong.
 *
 * Uses the platform's native `fetch` rather than a dependency, the same
 * choice `sessions/opencode-server.ts` already made for outbound HTTP in this
 * codebase.
 */
export class PlannerLlmClient {
  constructor(private readonly opts: PlannerLlmClientOptions) {}

  async complete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
  ): Promise<PlannerLlmCompletion> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = joinUrl(this.opts.baseUrl, '/chat/completions');

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
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

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new PlannerLlmError('Planner LLM endpoint returned a non-JSON response.');
    }

    const message = (
      json as {
        choices?: { message?: { content?: string | null; tool_calls?: PlannerLlmToolCall[] } }[];
      }
    ).choices?.[0]?.message;

    if (!message || (message.content == null && !message.tool_calls?.length)) {
      throw new PlannerLlmError('Planner LLM response had no message content or tool calls.');
    }

    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
