/**
 * PA-83 #3: a small, exact-match set of spoken commands that control the
 * live-listen session itself rather than being forwarded to the agent as a
 * prompt. "skip" (said while the agent is talking) is the ticket's own
 * example — it must silence the talk-back and do nothing else, never reach
 * the model as an instruction.
 *
 * Deliberately an exact match on the *whole* trimmed-and-normalized
 * utterance, not a substring test: a real prompt like "can you skip the
 * intro and summarize the rest" must still be sent to the agent normally.
 * Pure and browser-API-free, like `vad.ts`, so the matching rule has real
 * test coverage independent of a live transcription pipeline.
 */
const VOICE_SKIP_COMMANDS: ReadonlySet<string> = new Set([
  'skip',
  'skip it',
  'skip that',
  'skip this',
  'stop talking',
  'never mind',
  'nevermind',
]);

/** Strips trailing sentence punctuation and case before comparing — STT
 *  output routinely adds a trailing period even for a one-word utterance. */
export function isSkipCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[.!?,]+$/, '').trim();
  return VOICE_SKIP_COMMANDS.has(normalized);
}
