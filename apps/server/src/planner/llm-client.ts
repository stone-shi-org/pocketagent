import { isContextOverflowMessage, isQuotaMessage, isRetryableStatus, retryAfterMs } from './llm-errors.js';

/** OpenAI wire format is snake_case; kept verbatim rather than translated,
    since these objects are serialized straight into the request body and
    parsed straight out of the response — a translation layer here would be
    pure overhead with a chance to get the mapping wrong. */
export interface PlannerLlmToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** PA-122: Anthropic's prompt-caching breakpoint, as Anthropic-compatible
    gateways (OpenRouter, LiteLLM) accept it on an OpenAI-shaped content
    part. Only ever added by `prompt-cache.ts`, and only for a model whose
    caching is on — a strict OpenAI-compatible server rejects the key. */
export interface PlannerCacheControl {
  type: 'ephemeral';
}

export type PlannerTextContentPart = { type: 'text'; text: string; cache_control?: PlannerCacheControl };

export type PlannerUserContentPart =
  | PlannerTextContentPart
  | { type: 'image_url'; image_url: { url: string }; cache_control?: PlannerCacheControl }
  /** PA-137: a PDF, for a model whose row sets `supportsPdf` — see `attachments/inline.ts`. */
  | { type: 'file'; file: { filename: string; file_data: string }; cache_control?: PlannerCacheControl };

export type PlannerChatMessage =
  | { role: 'system'; content: string | PlannerTextContentPart[] }
  | { role: 'user'; content: string | PlannerUserContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: PlannerLlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string | PlannerTextContentPart[] };

/** OpenAI's own `usage` shape, snake_case for the same reason as the wire
    types above. `null` when the provider never sent one — not every
    OpenAI-compatible implementation honors `stream_options.include_usage`,
    so the settings-page turn footer simply omits the tokens/tps bits rather
    than showing a fabricated zero. */
export interface PlannerLlmUsage {
  /** Every prompt token, cached ones included (OpenAI's convention). */
  promptTokens: number;
  completionTokens: number;
  /**
   * PA-122: how many of `promptTokens` were read from the provider's prompt
   * cache, and how many were written to it. `null` when the provider said
   * nothing either way, which is not the same as `0`. Both are subsets of
   * `promptTokens` — see `parseUsage` for the gateways that report them the
   * other way round.
   */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** PA-122: what the provider itself says the request cost, in USD, when it
      reports one (OpenRouter, LiteLLM). Preferred over a computed figure. */
  costUsd?: number | null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * PA-122: one `usage` object, in any of the shapes OpenAI-compatible servers
 * send. OpenAI, DeepSeek and OpenRouter report the cache inside
 * `prompt_tokens_details` and count it as part of `prompt_tokens`; an
 * Anthropic-style passthrough (LiteLLM, some proxies) reports
 * `cache_read_input_tokens` / `cache_creation_input_tokens` beside it, and a
 * proxy that copies Anthropic's own `input_tokens` leaves the cache *out* of
 * `prompt_tokens`. That last case is detectable — the cache cannot be bigger
 * than the whole prompt — and is normalised to the inclusive convention, so
 * token calibration and cost both read one meaning.
 */
export function parseUsage(raw: unknown): PlannerLlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const details = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object'
    ? u.prompt_tokens_details
    : {}) as Record<string, unknown>;
  const read = finiteNonNegative(details.cached_tokens) ?? finiteNonNegative(u.cache_read_input_tokens);
  const write = finiteNonNegative(details.cache_write_tokens) ?? finiteNonNegative(u.cache_creation_input_tokens);
  const explicitPromptTokens = finiteNonNegative(u.prompt_tokens);
  const anthropicInputTokens = finiteNonNegative(u.input_tokens);
  let promptTokens: number;
  if (explicitPromptTokens !== null) {
    promptTokens = explicitPromptTokens;
    if ((read ?? 0) + (write ?? 0) > promptTokens) promptTokens += (read ?? 0) + (write ?? 0);
  } else if (anthropicInputTokens !== null) {
    promptTokens = anthropicInputTokens + (read ?? 0) + (write ?? 0);
  } else {
    promptTokens = (read ?? 0) + (write ?? 0);
  }
  return {
    promptTokens,
    completionTokens: finiteNonNegative(u.completion_tokens) ?? finiteNonNegative(u.output_tokens) ?? 0,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    costUsd: finiteNonNegative(u.cost),
  };
}

export interface PlannerLlmCompletion {
  content: string | null;
  toolCalls: PlannerLlmToolCall[];
  usage: PlannerLlmUsage | null;
  reasoning: string | null;
  /**
   * PA-121: the provider's `choices[0].finish_reason` (`stop`, `tool_calls`,
   * `length`, …), or `null` when it never sent one. `length` is the one that
   * matters: a reply cut off at the output-token limit may carry tool calls
   * whose argument JSON is incomplete, and `driveLoop` refuses to run those.
   */
  finishReason: string | null;
}

/**
 * One piece of a streamed completion. `text_delta` arrives zero or more
 * times as the model's reply is generated; `thinking_delta` arrives when
 * the model outputs chain-of-thought tokens; `done` arrives exactly once,
 * at the end, with the fully assembled result — the same shape `PlannerLlmCompletion`
 * always had, so a caller that only wants the final answer can ignore every
 * delta and just read the last event.
 */
export type PlannerLlmStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  /** PA-121: an attempt failed before streaming anything and will be
      retried after `delayMs`. Surfaced so the chat is not silent while it
      waits; nothing about the failed attempt reaches the transcript. */
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; reason: string }
  | ({ type: 'done' } & PlannerLlmCompletion);

export interface PlannerLlmStreamOptions {
  effort?: string | null;
  thinking?: boolean;
  /**
   * PA-121: abandon the request when no byte has arrived for this long —
   * waiting for the response headers included. `0`/absent means no idle
   * timeout, which is how every caller behaved before.
   */
  idleTimeoutMs?: number;
  /** PA-121: sent as `max_tokens` when set. Omitted otherwise, because some
      OpenAI-compatible servers reject the field outright. */
  maxTokens?: number;
  /** Sent as `tool_choice: 'none'` when true: the tools stay declared (a
      history holding tool calls is refused by some providers without them)
      but the model may not call one. Used for the final summary round at the
      tool-call limit. */
  forbidToolCalls?: boolean;
}

export class PlannerLlmError extends Error {
  override readonly name = 'PlannerLlmError';
  /** PA-121: worth trying again — see `llm-errors.ts`. */
  readonly retryable: boolean;
  /** PA-121: the prompt did not fit the model's context window. Never
      retried as-is; `driveLoop` compacts the conversation and tries once. */
  readonly contextOverflow: boolean;
  /** PA-121: the delay the server asked for, when it named one. */
  readonly retryAfterMs: number | null;
  constructor(
    message: string,
    readonly statusCode?: number,
    details: { retryable?: boolean; contextOverflow?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.contextOverflow = details.contextOverflow ?? false;
    this.retryable = !this.contextOverflow && (details.retryable ?? false);
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

/**
 * PA-121: the error for a non-2xx response, classified. Quota and overflow
 * are decided from the body text first, because a provider will happily
 * report either with a 429 or a 400.
 */
export function httpError(prefix: string, status: number, body: string, headers: Headers): PlannerLlmError {
  const message = `${prefix} returned ${status}: ${body.slice(0, 500)}`;
  if (isQuotaMessage(body)) return new PlannerLlmError(message, status, { retryable: false });
  if (isContextOverflowMessage(body)) return new PlannerLlmError(message, status, { contextOverflow: true });
  return new PlannerLlmError(message, status, {
    retryable: isRetryableStatus(status),
    retryAfterMs: retryAfterMs(headers),
  });
}

/**
 * The error for a `data: {"error": …}` frame inside a 200 stream, classified
 * like `httpError`. There are no headers to read, so the status comes from
 * the frame itself (`status`/`code` when numeric) or from a `[429]` in the
 * message, the shape omniroute relays a provider's failure in.
 */
export function streamError(raw: unknown): PlannerLlmError {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text =
    typeof raw === 'string'
      ? raw
      : typeof obj.message === 'string'
        ? obj.message
        : JSON.stringify(raw);
  const numeric = [obj.status, obj.code, obj.status_code].find((v) => typeof v === 'number' && v >= 400 && v < 600) as
    | number
    | undefined;
  const bracketed = /\[(\d{3})\]/.exec(text);
  const status = numeric ?? (bracketed ? Number(bracketed[1]) : undefined);
  const message = `Planner LLM endpoint reported an error mid-stream${status ? ` (${status})` : ''}: ${text.slice(0, 500)}`;
  if (isQuotaMessage(text)) return new PlannerLlmError(message, status, { retryable: false });
  if (isContextOverflowMessage(text)) return new PlannerLlmError(message, status, { contextOverflow: true });
  return new PlannerLlmError(message, status, { retryable: status !== undefined && isRetryableStatus(status) });
}

/**
 * PA-121: retry policy for `streamComplete` — pi's agent-level defaults
 * (3 retries, 2s doubling, at most 60s). A server asking for a longer wait
 * than `maxDelayMs` is not waited for: a minute-plus `retry-after` means the
 * provider is not coming back on the timescale of a chat turn.
 */
export interface PlannerLlmRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_LLM_RETRY_POLICY: PlannerLlmRetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
};

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PlannerLlmError('Aborted.'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PlannerLlmError('Aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface PlannerLlmClientOptions {
  baseUrl: string;
  apiKey: string | null;
  /** Injected in tests so no real network call is ever made. */
  fetchImpl?: typeof fetch;
  /** PA-121: overrides `DEFAULT_LLM_RETRY_POLICY` — tests shrink the delays,
      and `maxRetries: 0` turns retrying off. */
  retry?: Partial<PlannerLlmRetryPolicy>;
}

/**
 * PA-148: the contract every Pocket Agent LLM provider implementation
 * (`openai-compatible` in phase 1, OAuth providers in later phases) satisfies.
 * Emits the existing `text_delta` / `thinking_delta` / `retry` / `done`
 * stream events and throws `PlannerLlmError` on failure.
 */
export interface PlannerLlmProvider {
  listModels(): Promise<string[]>;
  streamComplete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options?: PlannerLlmStreamOptions,
  ): AsyncGenerator<PlannerLlmStreamEvent>;
  test(model: string): Promise<{ ok: boolean; message: string; latencyMs: number }>;
}

/** PA-29: bounds `embed()`'s round trip. Unlike `streamComplete` (which may
    legitimately run for as long as a model takes to generate a reply),
    `embed()` can sit on `PlannerChatService`'s hot path — every turn's
    pre-turn memory ranking and every `memory_save` call — so a hung or
    slow embedding endpoint must not hang a turn indefinitely. 5s is
    generous for what should be one of the cheapest calls an OpenAI-
    compatible endpoint offers. */
const EMBEDDING_TIMEOUT_MS = 5_000;

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
export class PlannerLlmClient implements PlannerLlmProvider {
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

  /**
   * Round-trips one minimal prompt through `model` to confirm the provider
   * endpoint and model id actually work. Swallows `PlannerLlmError` into
   * `ok: false` so the caller can return a structured verdict.
   */
  async test(model: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const startedAt = Date.now();
    try {
      let content: string | null = null;
      for await (const chunk of this.streamComplete(model, [
        { role: 'user', content: 'Reply with exactly one word: ok' },
      ])) {
        if (chunk.type === 'done') content = chunk.content;
      }
      return {
        ok: true,
        message: content ? content.trim().slice(0, 200) : '(empty reply)',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  /**
   * `POST /embeddings`, the standard OpenAI-compatible embedding endpoint —
   * one request embeds every string in `input`, in order, and the response's
   * `data[]` is expected to line up with it positionally (the documented
   * OpenAI contract; every entry also carries its own `index`, but this
   * follows callers elsewhere in this file that trust response order rather
   * than re-sorting by an echoed index).
   *
   * Bounded by `EMBEDDING_TIMEOUT_MS` — see that constant's doc comment.
   * Throws `PlannerLlmError` on a non-2xx response, a malformed body, or a
   * `data[]` whose length doesn't match `input`'s; the caller (memory
   * ranking/save, `PlannerMemoryService`) is responsible for catching and
   * degrading gracefully, not this method swallowing the error itself — a
   * genuine misconfiguration must stay visible in logs rather than silently
   * behaving like "no embedding available".
   */
  async embed(model: string, input: string[]): Promise<{ embeddings: number[][] }> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = joinUrl(this.opts.baseUrl, '/embeddings');

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PlannerLlmError(`Could not reach the planner embedding endpoint: ${(err as Error).message}`);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new PlannerLlmError(
        `Planner embedding endpoint returned ${res.status}: ${body.slice(0, 500)}`,
        res.status,
      );
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new PlannerLlmError(
        `Planner embedding endpoint's response was not valid JSON: ${(err as Error).message}`,
      );
    }

    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) {
      throw new PlannerLlmError('Planner embedding endpoint response had no "data" array.');
    }
    const embeddings = data.map((entry) => {
      const embedding = (entry as { embedding?: unknown } | null)?.embedding;
      if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === 'number')) {
        throw new PlannerLlmError('Planner embedding endpoint returned a malformed embedding.');
      }
      return embedding as number[];
    });
    if (embeddings.length !== input.length) {
      throw new PlannerLlmError(
        `Planner embedding endpoint returned ${embeddings.length} embeddings for ${input.length} inputs.`,
      );
    }
    return { embeddings };
  }

  /**
   * One chat completion, streamed, retried on transient failure (PA-121).
   *
   * An attempt is retried only when it failed *before streaming anything*: a
   * connection error, a retryable status, an idle timeout or an empty stream.
   * Once a delta has been yielded the caller has shown it to someone, so a
   * retry would repeat it — that failure is thrown, as every failure was
   * before. A context overflow and a quota error are never retried here; the
   * first is the caller's to handle by shrinking the context, the second
   * cannot get better by waiting. Each retry is announced with a `retry`
   * event, and the wait itself ends early if `signal` aborts.
   */
  async *streamComplete(
    model: string,
    messages: PlannerChatMessage[],
    tools?: unknown[],
    signal?: AbortSignal,
    options?: PlannerLlmStreamOptions,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const policy = { ...DEFAULT_LLM_RETRY_POLICY, ...this.opts.retry };
    for (let attempt = 0; ; attempt++) {
      let streamedAnything = false;
      try {
        for await (const event of this.streamOnce(model, messages, tools, signal, options)) {
          if (event.type !== 'done') streamedAnything = true;
          yield event;
        }
        return;
      } catch (err) {
        if (signal?.aborted) throw err;
        const error = err instanceof PlannerLlmError ? err : new PlannerLlmError((err as Error).message);
        if (streamedAnything || !error.retryable || attempt >= policy.maxRetries) throw error;
        let delayMs: number;
        if (error.retryAfterMs !== null) {
          if (error.retryAfterMs > policy.maxDelayMs) throw error;
          delayMs = error.retryAfterMs;
        } else {
          // Exponential, with up to 25% jitter downward so several chats
          // failing together do not retry in lockstep.
          delayMs = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs) * (1 - Math.random() * 0.25);
        }
        delayMs = Math.round(delayMs);
        yield { type: 'retry', attempt: attempt + 1, maxRetries: policy.maxRetries, delayMs, reason: error.message };
        await abortableSleep(delayMs, signal);
      }
    }
  }

  private async *streamOnce(
    model: string,
    messages: PlannerChatMessage[],
    tools: unknown[] | undefined,
    externalSignal: AbortSignal | undefined,
    options: PlannerLlmStreamOptions | undefined,
  ): AsyncGenerator<PlannerLlmStreamEvent> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const url = joinUrl(this.opts.baseUrl, '/chat/completions');

    // PA-121: one controller for this attempt, aborted by the caller's signal
    // or by the idle timer — `fetch` and every `read()` both see it.
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const idleMs = options?.idleTimeoutMs ?? 0;
    let idledOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idleMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        controller.abort();
      }, idleMs);
    };
    const idleError = (): PlannerLlmError =>
      new PlannerLlmError(`The planner LLM endpoint sent nothing for ${Math.round(idleMs / 1000)}s.`, undefined, {
        retryable: true,
      });
    const signal = controller.signal;
    try {
      armIdle();
      yield* this.streamBody(fetchImpl, url, model, messages, tools, signal, options, armIdle, () =>
        idledOut ? idleError() : null,
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async *streamBody(
    fetchImpl: typeof fetch,
    url: string,
    model: string,
    messages: PlannerChatMessage[],
    tools: unknown[] | undefined,
    signal: AbortSignal,
    options: PlannerLlmStreamOptions | undefined,
    onActivity: () => void,
    idleFailure: () => PlannerLlmError | null,
  ): AsyncGenerator<PlannerLlmStreamEvent> {

    const requestPayload: Record<string, unknown> = {
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
      ...(tools && tools.length > 0 && options?.forbidToolCalls ? { tool_choice: 'none' } : {}),
    };

    if (options?.thinking === false || options?.effort === 'off') {
      requestPayload.reasoning_effort = 'none';
    } else if (options?.effort) {
      requestPayload.reasoning_effort = options.effort;
    }
    if (options?.maxTokens !== undefined && options.maxTokens > 0) {
      requestPayload.max_tokens = options.maxTokens;
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(requestPayload),
        signal,
      });
    } catch (err) {
      const idle = idleFailure();
      if (idle) throw idle;
      // A network-level failure (refused, reset, DNS) is transient by nature.
      throw new PlannerLlmError(`Could not reach the planner LLM endpoint: ${(err as Error).message}`, undefined, {
        retryable: !signal.aborted,
      });
    }
    onActivity();

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError('Planner LLM endpoint', res.status, body, res.headers);
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
    let reasoningSoFar = '';
    let inThinkTag = false;
    let sawAnyTextDelta = false;
    let sawAnyChunk = false;
    let usage: PlannerLlmUsage | null = null;
    let finishReason: string | null = null;
    let buffer = '';

    const handleLine = (line: string): PlannerLlmStreamEvent[] => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return [];
      const payload = trimmed.slice(5).trim();
      if (payload.length === 0 || payload === '[DONE]') return [];

      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        return []; // A malformed chunk is dropped rather than aborting the whole stream.
      }
      sawAnyChunk = true;

      // A gateway that has already answered 200 (omniroute sends keepalive
      // chunks while it waits on the provider) can only report a provider
      // failure in-band, as `data: {"error": …}`, before closing the stream.
      // Ignoring the frame made it look like an empty reply ("no message
      // content or tool calls") and hid the real cause, on prod chat 2c1054bb
      // a 429 from the model the gateway routed an image request to.
      const streamedError = (parsed as { error?: unknown }).error;
      if (streamedError !== undefined && streamedError !== null) {
        throw streamError(streamedError);
      }

      // The `stream_options.include_usage` chunk carries a top-level `usage`
      // alongside an empty `choices: []` — captured here rather than
      // returned as its own stream event, the same "assemble internally,
      // surface only in `done`" treatment tool-call chunks already get.
      const rawUsage = parseUsage((parsed as { usage?: unknown }).usage);
      if (rawUsage) usage = rawUsage;

      const choice = (
        parsed as {
          choices?: {
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              reasoning?: string | null;
              tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
            };
          }[];
        }
      ).choices?.[0];
      const delta = choice?.delta;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason;
      }

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

      const reasoningChunk = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof reasoningChunk === 'string' && reasoningChunk.length > 0) {
        reasoningSoFar += reasoningChunk;
        return [{ type: 'thinking_delta', text: reasoningChunk }];
      }

      if (delta?.content) {
        if (inThinkTag) {
          const closeIdx = delta.content.indexOf('</think>');
          if (closeIdx >= 0) {
            inThinkTag = false;
            const thinkPart = delta.content.slice(0, closeIdx);
            const events: PlannerLlmStreamEvent[] = [];
            if (thinkPart.length > 0) {
              reasoningSoFar += thinkPart;
              events.push({ type: 'thinking_delta', text: thinkPart });
            }
            const remainder = delta.content.slice(closeIdx + '</think>'.length).replace(/^\n+/, '');
            if (remainder.length > 0) {
              sawAnyTextDelta = true;
              contentSoFar += remainder;
              events.push({ type: 'text_delta', text: remainder });
            }
            return events;
          }
          reasoningSoFar += delta.content;
          return [{ type: 'thinking_delta', text: delta.content }];
        } else if (!sawAnyTextDelta && delta.content.startsWith('<think>')) {
          inThinkTag = true;
          const afterOpen = delta.content.slice('<think>'.length);
          const closeIdx = afterOpen.indexOf('</think>');
          if (closeIdx >= 0) {
            inThinkTag = false;
            const thinkPart = afterOpen.slice(0, closeIdx);
            const events: PlannerLlmStreamEvent[] = [];
            if (thinkPart.length > 0) {
              reasoningSoFar += thinkPart;
              events.push({ type: 'thinking_delta', text: thinkPart });
            }
            const remainder = afterOpen.slice(closeIdx + '</think>'.length).replace(/^\n+/, '');
            if (remainder.length > 0) {
              sawAnyTextDelta = true;
              contentSoFar += remainder;
              events.push({ type: 'text_delta', text: remainder });
            }
            return events;
          }
          if (afterOpen.length > 0) {
            reasoningSoFar += afterOpen;
            return [{ type: 'thinking_delta', text: afterOpen }];
          }
          return [];
        }

        sawAnyTextDelta = true;
        contentSoFar += delta.content;
        return [{ type: 'text_delta', text: delta.content }];
      }
      return [];
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onActivity();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n');
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          for (const event of handleLine(line)) {
            yield event;
          }
          boundary = buffer.indexOf('\n');
        }
      }
      if (buffer.length > 0) {
        for (const event of handleLine(buffer)) {
          yield event;
        }
      }
    } catch (err) {
      // An in-band error frame (above) is already classified.
      if (err instanceof PlannerLlmError) throw err;
      const idle = idleFailure();
      if (idle) throw idle;
      throw new PlannerLlmError(`Lost connection to the planner LLM endpoint: ${(err as Error).message}`, undefined, {
        retryable: !signal.aborted,
      });
    }

    if (!sawAnyChunk) {
      throw new PlannerLlmError('Planner LLM endpoint returned an empty stream.', undefined, { retryable: true });
    }

    const toolCalls: PlannerLlmToolCall[] = Array.from(toolCallsByIndex.values())
      .filter((call) => call.name.length > 0)
      .map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.args } }));
    const content = contentSoFar.length > 0 ? contentSoFar : null;
    const reasoning = reasoningSoFar.length > 0 ? reasoningSoFar : null;

    if (content === null && toolCalls.length === 0 && reasoning === null) {
      throw new PlannerLlmError('Planner LLM response had no message content or tool calls.');
    }

    yield { type: 'done', content, toolCalls, usage, reasoning, finishReason };
  }
}

function joinUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}
