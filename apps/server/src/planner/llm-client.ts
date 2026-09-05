export interface PlannerChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
 * Non-streaming for phase 2 (PA-6): the chat loop needs one full assistant
 * message per turn to append to the transcript, not per-token deltas.
 * `structured-session.ts` only started handling partial SDK messages once a
 * WebSocket existed to deliver them token-by-token to a live renderer — the
 * planner has no such transport yet (see `packages/protocol/src/planner.ts`'s
 * `PlannerTranscriptEntry` doc comment), so building streaming here first
 * would be work with nothing downstream to consume it. `stream: false` keeps
 * this client to one request/response with no SSE parser to get wrong.
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
    signal?: AbortSignal,
  ): Promise<string> {
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
        body: JSON.stringify({ model, messages, stream: false }),
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

    const content = (json as { choices?: { message?: { content?: string | null } }[] })
      .choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new PlannerLlmError('Planner LLM response had no message content.');
    }
    return content;
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
