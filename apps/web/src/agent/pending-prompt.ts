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
let pending: { sessionId: string; text: string; image?: PromptImage; attachments?: string[] } | null = null;

/**
 * `attachments` are upload ids (PA-136), not bytes: the files are already
 * staged on the server, and the ids are good for an hour, which comfortably
 * outlasts one navigation.
 */
export function setPendingPrompt(sessionId: string, text: string, image?: PromptImage, attachments?: string[]): void {
  const trimmed = text.trim();
  const files = attachments && attachments.length > 0 ? attachments : undefined;
  // An attached image or file makes an otherwise-empty prompt worth sending —
  // only drop the whole thing when there is truly nothing to hand off.
  pending = trimmed || image || files ? { sessionId, text: trimmed, image, ...(files ? { attachments: files } : {}) } : null;
}

/** Returns the prompt for this session exactly once, then forgets it. */
export function takePendingPrompt(
  sessionId: string,
): { text: string; image?: PromptImage; attachments?: string[] } | null {
  if (pending?.sessionId !== sessionId) return null;
  const { text, image, attachments } = pending;
  pending = null;
  return attachments ? { text, image, attachments } : { text, image };
}
