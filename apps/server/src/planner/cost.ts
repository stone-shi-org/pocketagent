/**
 * PA-122: what one Pocket Agent LLM round trip cost, in USD.
 *
 * The prices are whatever the operator typed into Settings → Models, so this
 * is an estimate rather than a bill — a custom Claude provider has the same
 * problem in the other direction (its cost figures use Anthropic's prices).
 * Two rules keep the estimate honest:
 *
 *  - a cost the provider reports itself (`usage.cost`, which OpenRouter and
 *    LiteLLM send) is believed over anything computed here;
 *  - with nothing to compute from — no input or output price, or a round
 *    trip that reported no usage — the answer is `null`, never `0`. A turn
 *    footer showing `$0.0000` for a model nobody priced would be a lie that
 *    reads as a fact.
 */
import type { PlannerLlmUsage } from './llm-client.js';

export interface PlannerModelPrices {
  inputPricePerMTok: number | null;
  outputPricePerMTok: number | null;
  cacheReadPricePerMTok: number | null;
  cacheWritePricePerMTok: number | null;
}

const PER_TOKEN = 1 / 1_000_000;

export function roundTripCostUsd(usage: PlannerLlmUsage | null, prices: PlannerModelPrices | null): number | null {
  if (!usage) return null;
  if (usage.costUsd !== null && usage.costUsd !== undefined) return usage.costUsd;
  if (!prices || prices.inputPricePerMTok === null || prices.outputPricePerMTok === null) return null;
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  // `parseUsage` guarantees the cache is a subset of `promptTokens`; the
  // clamp only guards a provider that reports the two inconsistently.
  const uncached = Math.max(0, usage.promptTokens - read - write);
  const input = prices.inputPricePerMTok;
  return (
    (uncached * input +
      read * (prices.cacheReadPricePerMTok ?? input) +
      write * (prices.cacheWritePricePerMTok ?? input) +
      usage.completionTokens * prices.outputPricePerMTok) *
    PER_TOKEN
  );
}
