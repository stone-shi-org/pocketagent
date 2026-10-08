/**
 * PA-121: classifying a failed chat-completion call — is it worth retrying,
 * is it a context overflow, or is it the account itself?
 *
 * The planner talks to *any* OpenAI-compatible endpoint (a gateway, vLLM,
 * llama.cpp, a cloud API), and they disagree on everything about how they
 * report errors except that the message is a string. So, like pi
 * (`ai/src/utils/overflow.ts`, `ai/src/utils/retry.ts`), the answer comes
 * from the HTTP status where there is one and from the message text where
 * there is not, using the phrasings actually observed in the wild. These
 * lists are evidence, not a contract: an unrecognised overflow is reported as
 * a plain failure, exactly as before this existed.
 */

/** Phrasings providers use for "the prompt is longer than the context
    window". Ported from pi's `OVERFLOW_PATTERNS`. */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i,
  /prompt exceeds max length/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,
  /input token count.*exceeds the maximum/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length/i,
  /input \(\d+ tokens\) is longer than the model'?s context length/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is/i,
  /model_context_window_exceeded/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /range of input length should be/i,
  /context[_ ]length[_ ]exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
];

/** Messages that mention tokens or limits but are about rate, not size —
    checked first so "too many tokens per minute" is not read as overflow. */
const NOT_OVERFLOW_PATTERNS: readonly RegExp[] = [/rate.?limit/i, /too many requests/i, /per minute/i, /throttl/i];

/** The account, not the request: retrying cannot help and only burns time
    (pi's non-retryable set). */
const QUOTA_PATTERNS: readonly RegExp[] = [
  /insufficient_quota/i,
  /quota exceeded/i,
  /exceeded your current quota/i,
  /billing/i,
  /available balance/i,
  /out of budget/i,
  /usage limit reached/i,
  /credit balance is too low/i,
];

export function isContextOverflowMessage(message: string): boolean {
  if (NOT_OVERFLOW_PATTERNS.some((p) => p.test(message))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(message));
}

export function isQuotaMessage(message: string): boolean {
  return QUOTA_PATTERNS.some((p) => p.test(message));
}

/**
 * Whether an HTTP error status is transient. 408 (timeout), 409 (conflict,
 * which OpenAI documents as retryable), 429 (rate limit) and every 5xx — the
 * set pi's provider layer retries. A 429 that is really a quota error is
 * caught by `isQuotaMessage` first.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * The delay a response asked for, in ms: `retry-after-ms` (OpenAI's own),
 * else `retry-after` as seconds or an HTTP date. `null` when neither is
 * present or parseable.
 */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | null {
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const after = headers.get('retry-after');
  if (after === null || after.trim() === '') return null;
  const seconds = Number(after);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(after);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
