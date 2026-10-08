/**
 * PA-122: Anthropic-style prompt caching for the Pocket Agent loop.
 *
 * OpenAI, DeepSeek and most OpenAI-compatible servers cache a repeated prompt
 * prefix on their own, and `parseUsage` (`llm-client.ts`) reads what they
 * report whatever this module does. Anthropic does not: a request is cached
 * only up to a `cache_control` breakpoint the client marks, and the
 * Anthropic-compatible gateways (OpenRouter, LiteLLM) accept the same marker
 * on an OpenAI-shaped content part. A strict OpenAI-compatible server answers
 * an unknown `cache_control` key with a 400, so markers are per model and off
 * unless the model is a Claude one or an operator turned them on.
 *
 * Three breakpoints, inside Anthropic's limit of four:
 *  1. the stable part of the system message — the base preamble and the
 *     persona, *not* the ranked memories after it, which change from turn to
 *     turn (they are ranked against the latest prompt) and would otherwise
 *     invalidate everything after them on every turn;
 *  2. the last tool spec, since the tool list is stable for an agent and
 *     precedes the system message in Anthropic's cache order;
 *  3. the last `user` or `tool` message — the rolling breakpoint that lets
 *     each round trip of a tool loop read the previous one from cache.
 *
 * Pure, so the exact request shape is pinned by a unit test rather than by a
 * real gateway.
 */
import type { PlannerChatMessage, PlannerLlmError, PlannerTextContentPart } from './llm-client.js';

const EPHEMERAL = { type: 'ephemeral' } as const;

/** Model families that take Anthropic's breakpoints — matched the way
    `knownModelLimits` matches, with any `provider/` prefix removed. */
const CACHE_CONTROL_MODELS: readonly RegExp[] = [/^claude-/, /^anthropic\./];

/**
 * Whether to mark this model's requests. The row's explicit choice wins;
 * `null` (the default) means "on for a Claude model, off otherwise".
 */
export function resolvePromptCaching(modelId: string, rowSetting: boolean | null | undefined): boolean {
  if (rowSetting === true || rowSetting === false) return rowSetting;
  const bare = modelId.toLowerCase().replace(/^.*\//, '');
  return CACHE_CONTROL_MODELS.some((pattern) => pattern.test(bare));
}

/**
 * The request with breakpoints added. Returns new arrays and objects; the
 * inputs are left untouched, so the unmarked messages can be re-sent as-is if
 * the endpoint refuses the markers.
 *
 * `stableSystemPrefix` is the part of the system message that does not
 * change between turns. When the system message starts with it and has more
 * after it, the message becomes two text parts with the breakpoint on the
 * first; otherwise the whole message is one marked part.
 */
export function applyCacheControl(
  messages: readonly PlannerChatMessage[],
  tools: readonly unknown[],
  stableSystemPrefix: string | null,
): { messages: PlannerChatMessage[]; tools: unknown[] } {
  const out = messages.map((m) => ({ ...m })) as PlannerChatMessage[];

  const system = out.find((m) => m.role === 'system');
  if (system && typeof system.content === 'string' && system.content.length > 0) {
    const text = system.content;
    const parts: PlannerTextContentPart[] =
      stableSystemPrefix && text.length > stableSystemPrefix.length && text.startsWith(stableSystemPrefix)
        ? [
            { type: 'text', text: stableSystemPrefix, cache_control: EPHEMERAL },
            { type: 'text', text: text.slice(stableSystemPrefix.length) },
          ]
        : [{ type: 'text', text, cache_control: EPHEMERAL }];
    (system as { content: PlannerTextContentPart[] }).content = parts;
  }

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'user' && m.role !== 'tool') continue;
    if (typeof m.content === 'string') {
      if (m.content.length === 0) break;
      (m as { content: PlannerTextContentPart[] }).content = [
        { type: 'text', text: m.content, cache_control: EPHEMERAL },
      ];
    } else if (m.content.length > 0) {
      const parts = m.content.map((p) => ({ ...p }));
      parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: EPHEMERAL };
      (m as { content: typeof parts }).content = parts;
    }
    break;
  }

  const outTools = [...tools];
  const last = outTools[outTools.length - 1];
  if (last && typeof last === 'object') {
    outTools[outTools.length - 1] = { ...(last as Record<string, unknown>), cache_control: EPHEMERAL };
  }
  return { messages: out, tools: outTools };
}

/** The endpoint refused the markers themselves (a strict server, or a
    gateway in front of a non-Anthropic model): a 400 that names the field. */
export function isCacheControlRejection(err: PlannerLlmError): boolean {
  return (
    !err.contextOverflow &&
    (err.statusCode === 400 || err.statusCode === 422) &&
    /cache_control/i.test(err.message)
  );
}
