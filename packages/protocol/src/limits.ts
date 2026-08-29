import { MAX_IMAGE_BASE64_CHARS, MAX_IMAGE_BYTES } from './prompt-image.js';

/**
 * Hard caps, enforced on the server before any frame is acted on.
 *
 * Lives in its own leaf module rather than in `ws.ts` (where it started)
 * because it is the one thing in this package that *everything* wants,
 * including modules that sit below the frame definitions. `ws.ts` imports
 * `session.ts`, so leaving `LIMITS` there meant any entity module needing a
 * cap had to import `ws.ts` and close a cycle — `session.ts → cron.ts →
 * ws.ts → session.ts`. That cycle is not a type-level nicety: `LIMITS` is read
 * at module-evaluation time by the schemas that use it, so one of the modules
 * in the loop observes it before initialisation and throws.
 */
export const LIMITS = {
  // A base64'd 5 MB image runs ~6.7 MB of text, plus JSON overhead — this
  // used to be 256 KiB (plenty for a terminal keystroke or a paragraph of
  // prompt text) but has to cover the largest single frame the protocol now
  // carries, which is an image-bearing prompt.
  maxMessageBytes: 8 * 1024 * 1024,
  /** Max characters of a single `input` payload. */
  maxInputChars: 128 * 1024,
  /** Raw file size cap for a prompt's attached image, before base64 encoding. */
  maxImageBytes: MAX_IMAGE_BYTES,
  /** Base64 inflates by 4/3; this is the cap actually applied to `image.data`. */
  maxImageBase64Chars: MAX_IMAGE_BASE64_CHARS,
  minCols: 2,
  maxCols: 1000,
  minRows: 2,
  maxRows: 500,
} as const;
