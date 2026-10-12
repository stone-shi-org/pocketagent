import { z } from 'zod';

/**
 * A non-image file attached to a prompt (PA-136): a PDF, a spreadsheet, a
 * Markdown file, anything.
 *
 * Deliberately *not* a widened `PromptImage`. An image rides inline, base64,
 * inside the prompt frame, because two consumers act on its bytes (the Claude
 * SDK's image block, the planner's `image_url` part). A file has no consumer
 * that wants its bytes in the prompt: the agent is told a *path* and reads it
 * with its own tools. So a file is uploaded on its own first, as raw bytes
 * (`POST /api/attachments`), and the prompt carries only the opaque id the
 * server minted for it. That keeps 20 MB of base64 out of the WebSocket frame
 * limit and the JSON body limit, and it means an upload that is never sent
 * writes nothing into anybody's working tree. The file lands in the tree only
 * when the prompt naming it is actually sent, so a removed chip leaves nothing
 * behind.
 *
 * Its own file for the same reason `prompt-image.ts` is: `ws.ts`,
 * `planner.ts` and `agent-events.ts` all need it.
 */

/** Raw file size cap for one non-image attachment. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Files per prompt, on top of the (at most one) image. */
export const MAX_ATTACHMENTS_PER_PROMPT = 5;

/** Longest original filename the upload route accepts before sanitising. */
export const MAX_ATTACHMENT_NAME_CHARS = 255;

/**
 * Server-minted, single-use, opaque. Never a path: the browser has no say in
 * where a file lands, only in what it was called (and even that is sanitised).
 */
export const AttachmentId = z.string().regex(/^att_[A-Za-z0-9_-]{16,64}$/, 'Not an attachment id.');
export type AttachmentId = z.infer<typeof AttachmentId>;

export const AttachmentIdList = z.array(AttachmentId).max(MAX_ATTACHMENTS_PER_PROMPT);

/** `POST /api/attachments` answers with this. */
export const UploadAttachmentResponse = z.object({
  attachmentId: AttachmentId,
  /** The original name, as the server will sanitise it on landing. */
  name: z.string(),
  size: z.number().int().nonnegative(),
  mediaType: z.string(),
});
export type UploadAttachmentResponse = z.infer<typeof UploadAttachmentResponse>;

/**
 * A file that has landed, as the transcript records it: metadata only, never
 * bytes. `path` is relative to the session's cwd (a coding agent) or to the
 * planner workspace (a Pocket Agent), using `/` separators.
 */
export const PromptAttachment = z.object({
  name: z.string().max(MAX_ATTACHMENT_NAME_CHARS),
  path: z.string().max(4096),
  size: z.number().int().nonnegative(),
  mediaType: z.string().max(255),
});
export type PromptAttachment = z.infer<typeof PromptAttachment>;

/**
 * The note a coding agent's prompt carries for each file, one line each. Lives
 * here because the browser parses it back out (`parseAttachedFileNotes`): a
 * transcript replayed from claude's own JSONL has only the prompt text, and a
 * chip that appears live but not on reload would be a lie about what was sent.
 */
export const ATTACHED_FILE_NOTE_PREFIX = '[Attached file saved to: ';

export function attachedFileNote(relPath: string): string {
  return `${ATTACHED_FILE_NOTE_PREFIX}${relPath}]`;
}

/**
 * Splits trailing `[Attached file saved to: …]` lines off a prompt. Only
 * *trailing* lines, and only whole lines: the note is always appended last by
 * the server, so a prompt that merely quotes the phrase mid-text keeps it.
 */
export function parseAttachedFileNotes(text: string): { text: string; paths: string[] } {
  const lines = text.split('\n');
  const paths: string[] = [];
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!;
    if (last.startsWith(ATTACHED_FILE_NOTE_PREFIX) && last.endsWith(']')) {
      paths.unshift(last.slice(ATTACHED_FILE_NOTE_PREFIX.length, -1));
      lines.pop();
      continue;
    }
    // Blank separator lines between the notes (and before them) go with them.
    if (paths.length > 0 && last.trim() === '') {
      lines.pop();
      continue;
    }
    break;
  }
  if (paths.length === 0) return { text, paths };
  return { text: lines.join('\n').replace(/\s+$/, ''), paths };
}

/**
 * What a chip calls a landed file when all it has is the path (a transcript
 * replayed from an agent's own JSONL): the basename with the server's
 * `_YYYYMMDD-HHmmss_xxxx` suffix taken back off.
 */
export function displayNameForLandedPath(relPath: string): string {
  const base = relPath.split('/').pop() ?? relPath;
  return base.replace(/_\d{8}-\d{6}_[0-9a-f]{4}(?=\.[A-Za-z0-9]{1,16}$|$)/, '');
}
