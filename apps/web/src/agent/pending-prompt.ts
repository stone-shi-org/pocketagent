import type { PromptImage } from '@pocketagent/protocol';

/**
 * The prompt typed on the composer screen, handed to the session page that is
 * about to mount.
 *
 * Deliberately in memory and single-use rather than in the URL or storage: it
 * belongs to one navigation, and a prompt that survived a reload would be sent
 * to a session the user did not type it for. If the handoff is lost — a reload
 * mid-navigation — the text is simply not sent, which is recoverable. Sending
 * it twice is not.
 */
let pending: { sessionId: string; text: string; image?: PromptImage } | null = null;

export function setPendingPrompt(sessionId: string, text: string, image?: PromptImage): void {
  const trimmed = text.trim();
  // An attached image makes an otherwise-empty prompt worth sending — only
  // drop the whole thing when there is truly nothing to hand off.
  pending = trimmed || image ? { sessionId, text: trimmed, image } : null;
}

/** Returns the prompt for this session exactly once, then forgets it. */
export function takePendingPrompt(
  sessionId: string,
): { text: string; image?: PromptImage } | null {
  if (pending?.sessionId !== sessionId) return null;
  const { text, image } = pending;
  pending = null;
  return { text, image };
}
