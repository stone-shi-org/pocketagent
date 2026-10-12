/**
 * PA-121: how big a Pocket Agent's context is allowed to get, and how big it
 * is right now.
 *
 * Before this the loop had no notion of either: it sent the last 20 turns
 * whatever their size, a long chat eventually exceeded the model's context
 * window, and from then on every turn failed with the provider's 400 until
 * old turns happened to age out. pi (`earendil-works/pi`) keeps a
 * `contextWindow` per model and compacts at `contextWindow - reserveTokens`;
 * this module is the "how big" half of that, `compaction.ts` the "what to do
 * about it" half.
 */

import { estimatePdfPartTokens } from '../attachments/inline.js';

/** pi's defaults for a model it knows nothing about. 128k is the smallest
    window any current general-purpose chat model ships with; a model with
    less is the one an operator needs to tell us about. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export interface ModelLimits {
  contextWindow: number;
  maxOutputTokens: number;
  /** Where `contextWindow` came from — shown in `/context` so a wrong number
      can be traced to "set on the model row", "guessed from the name" or
      "nothing known". */
  source: 'model' | 'known' | 'default';
}

/**
 * Context windows of model families, matched against the model id with any
 * `provider/` prefix removed (gateways such as OpenRouter or omniroute name
 * models `openai/gpt-4o`). First match wins, so a specific entry must come
 * before the family it belongs to.
 *
 * Evidence, not authority: these are the providers' published figures as of
 * 2026, a self-hosted server is often configured with a smaller window than
 * the model supports, and a gateway may cap it further. That is why the
 * model row's own `contextWindow` always wins, and why overflow recovery
 * exists as the backstop when this table is wrong.
 */
const KNOWN_MODEL_WINDOWS: ReadonlyArray<readonly [RegExp, number, number]> = [
  [/^claude-.*\[1m\]/, 1_000_000, 64_000],
  [/^claude-/, 200_000, 32_000],
  [/^gpt-4\.1/, 1_047_576, 32_768],
  [/^gpt-5/, 400_000, 128_000],
  [/^gpt-4o/, 128_000, 16_384],
  [/^gpt-4-turbo/, 128_000, 4_096],
  [/^gpt-4/, 8_192, 4_096],
  [/^gpt-3\.5/, 16_385, 4_096],
  [/^o[134](-|$)/, 200_000, 100_000],
  [/^gemini-/, 1_048_576, 65_536],
  // V4 (flash and pro): 1M context, 384k output — omniroute's /v1/models and
  // DeepSeek's own catalog both report it. Earlier DeepSeek models keep the
  // family default below.
  [/^deepseek-(v4|flash)/, 1_000_000, 393_216],
  [/^deepseek/, 128_000, 8_192],
  [/^qwen3-coder/, 262_144, 65_536],
  [/^qwen/, 131_072, 8_192],
  [/^kimi-k2/, 262_144, 16_384],
  [/^glm-4\.[5-9]/, 131_072, 16_384],
  [/^grok-4/, 256_000, 16_384],
  [/^(mistral-large|codestral)/, 131_072, 8_192],
  [/^llama-?3\.[1-9]/, 131_072, 8_192],
];

export function knownModelLimits(modelId: string): { contextWindow: number; maxOutputTokens: number } | null {
  const bare = modelId.toLowerCase().replace(/^.*\//, '');
  for (const [pattern, contextWindow, maxOutputTokens] of KNOWN_MODEL_WINDOWS) {
    if (pattern.test(bare)) return { contextWindow, maxOutputTokens };
  }
  return null;
}

/**
 * The limits to plan a request against: the model row's own numbers when set,
 * then the known-family table, then the defaults. The two figures are
 * resolved independently, so a row that sets only its context window still
 * gets a sensible output limit.
 */
export function resolveModelLimits(
  modelId: string,
  row: { contextWindow: number | null; maxOutputTokens: number | null } | null,
): ModelLimits {
  const known = knownModelLimits(modelId);
  const contextWindow = row?.contextWindow ?? known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = row?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const source = row?.contextWindow ? 'model' : known ? 'known' : 'default';
  return { contextWindow, maxOutputTokens: Math.min(maxOutputTokens, contextWindow), source };
}

/**
 * The context size at which a chat is compacted: the window minus the
 * headroom the operator asked to keep. Never below a quarter of the window,
 * so a reserve set larger than a small model's window cannot make every
 * single request trigger a compaction.
 */
export function compactionThreshold(contextWindow: number, reserveTokens: number): number {
  return Math.max(Math.floor(contextWindow / 4), contextWindow - reserveTokens);
}

/** What one image counts for: pi's `ESTIMATED_IMAGE_CHARS` (4 800) ÷ 4. */
export const IMAGE_TOKEN_ESTIMATE = 1_200;

/**
 * Tokens in a request body, estimated: characters ÷ 4, plus a flat figure
 * per image (a base64 data URL is not billed by its length, and counting it
 * that way would make one photo look like 500k tokens).
 */
export function estimateRequestTokens(messages: readonly unknown[], tools: readonly unknown[]): number {
  let chars = 0;
  let images = 0;
  let fileTokens = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const part of content as Array<{ type?: string; text?: string; file?: { file_data?: string } }>) {
        if (part.type === 'image_url') images += 1;
        // PA-137: a PDF is billed by its pages, not by its base64 length.
        else if (part.type === 'file') fileTokens += estimatePdfPartTokens(part.file?.file_data?.length ?? 0);
        else chars += JSON.stringify(part).length;
      }
      chars += 32;
    } else {
      chars += JSON.stringify(message).length;
    }
  }
  if (tools.length > 0) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4) + images * IMAGE_TOKEN_ESTIMATE + fileTokens;
}

/**
 * Calibrates the character estimate against what the provider actually
 * counted, per chat. chars ÷ 4 is a good average for English prose and a poor
 * one for code, JSON and non-Latin scripts, where it can be off by 2× in
 * either direction — and an *under*-estimate is the dangerous one, because it
 * is what lets a request overflow. pi anchors on the last real `usage` figure
 * for the same reason.
 *
 * After every round trip that reported usage, the ratio of the provider's
 * `prompt_tokens` to this module's estimate of that same request is kept, and
 * later estimates for the chat are scaled by it. A ratio, rather than the raw
 * last figure plus an estimate of what was added since, because it survives
 * compaction and system-prompt changes without bookkeeping about which events
 * the figure covered. In memory only: after a restart a chat simply starts
 * uncalibrated, at ratio 1. Clamped to [0.5, 4] so one odd provider response
 * cannot make the next estimate absurd.
 */
export class TokenCalibration {
  private readonly ratios = new Map<string, number>();

  record(chatId: string, estimatedTokens: number, actualPromptTokens: number): void {
    if (estimatedTokens <= 0 || actualPromptTokens <= 0) return;
    this.ratios.set(chatId, Math.min(4, Math.max(0.5, actualPromptTokens / estimatedTokens)));
  }

  apply(chatId: string, estimatedTokens: number): number {
    return Math.ceil(estimatedTokens * (this.ratios.get(chatId) ?? 1));
  }

  forget(chatId: string): void {
    this.ratios.delete(chatId);
  }
}
