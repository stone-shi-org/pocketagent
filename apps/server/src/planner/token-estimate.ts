/**
 * PA-59: a local, dependency-free token estimate, for the context-preview
 * panel's display use only — "roughly how big is this system-prompt
 * section / memory / in-window history" next to each piece the panel shows.
 * Nothing in this file feeds back into any real accounting: not the rolling
 * window (`ROLLING_WINDOW_TURNS` counts turns, not tokens — see that
 * constant's own doc comment for why), not truncation, not cost. There is no
 * tokenizer dependency anywhere in this repo (no tiktoken or equivalent) and
 * adding one just to round a debug number for a preview panel is not worth
 * the weight, so this is the same rough "~4 characters per token" ratio
 * commonly quoted for English text under OpenAI-style BPE tokenizers — close
 * enough to compare "this section is small" against "this section is huge,"
 * not close enough to bill against.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
