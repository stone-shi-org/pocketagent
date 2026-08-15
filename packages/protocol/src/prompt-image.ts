import { z } from 'zod';

/**
 * A screenshot or photo attached to a prompt.
 *
 * Its own file rather than living in `ws.ts` (where it's sent) or
 * `agent-events.ts` (where it's echoed back): both of those need it, and
 * `ws.ts` already imports from `agent-events.ts`, so putting it in either one
 * would make the other import back and create a cycle.
 *
 * Only the Claude Agent SDK backend (`StructuredSession`) can actually act on
 * one today — the other structured backends (codex, agy, opencode, pi) reject
 * a prompt that carries one rather than silently dropping it, see
 * `apps/server/src/ws/index.ts`.
 */

/** Raw file size cap, before base64 encoding. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Base64 inflates by 4/3; this is the cap actually applied to `image.data`. */
export const MAX_IMAGE_BASE64_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3);

export const PromptImage = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  /** Raw base64, no `data:` URL prefix. */
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
});
export type PromptImage = z.infer<typeof PromptImage>;
