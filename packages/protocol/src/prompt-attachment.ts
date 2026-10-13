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

export const TruncatedReason = z.enum(['time', 'size', 'memory']);
export type TruncatedReason = z.infer<typeof TruncatedReason>;

/**
 * PA-139: one file produced by extracting an attachment — the `.txt` overview
 * (`kind: 'overview'`) or a per-sheet `.csv` (`kind: 'sheet_csv'`) or formula
 * sidecar (`kind: 'formulas'`). `PromptAttachment.extractedPath` continues to
 * name the primary `.txt` file so older readers keep working.
 */
export const ExtractedAttachmentFile = z.object({
  path: z.string().max(4096),
  kind: z.enum(['overview', 'sheet_csv', 'formulas']),
  label: z.string().max(255),
});
export type ExtractedAttachmentFile = z.infer<typeof ExtractedAttachmentFile>;

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
  /**
   * PA-137: the file is UTF-8 text (judged when it landed, from its type and
   * its bytes), so a Pocket Agent may inline it when it is small enough.
   * Absent on anything landed before PA-137, which reads as "not text".
   */
  text: z.boolean().optional(),
  /**
   * PA-137: text extracted from a PDF, docx, xlsx or pptx when it landed, as
   * a sidecar `<landed name>.txt` beside it. Relative like `path`. Plain text,
   * so `read_file` (or any agent's own file tool) can page through it with no
   * shell and no approval.
   */
  extractedPath: z.string().max(4096).optional(),
  /**
   * PA-139: all files written by extraction (the `.txt` overview plus, for a
   * spreadsheet, one `.csv` per sheet). `extractedPath` stays set to the
   * primary `.txt` file for compatibility.
   */
  extractedFiles: z.array(ExtractedAttachmentFile).max(200).optional(),
  /** Characters across the extracted sidecar(s). */
  extractedChars: z.number().int().nonnegative().optional(),
  /** The extract stopped at a cap (time, size or memory) before the document ended. */
  truncated: z.boolean().optional(),
  /** PA-139: which abuse cap stopped the extract when `truncated` is true. */
  truncatedReason: TruncatedReason.optional(),
  /** PA-139: where in the document extraction stopped, e.g. `"page 812 of 1400"`. */
  stoppedAt: z.string().max(255).optional(),
  /**
   * Why extraction failed, in a short sentence the model can be shown — a
   * timeout, a heap cap, a document that would not parse. Never fails the
   * turn: the file is still there and the note says it could not be read.
   */
  extractError: z.string().max(300).optional(),
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
 * PA-137/139: the line that follows a file's note when its text was extracted
 * into a sidecar (or per-sheet CSVs). Parsed back out with the file notes,
 * but it names no chip of its own: the sidecar is a byproduct of the file
 * above it, not something the user attached.
 */
export const EXTRACTED_TEXT_NOTE_PREFIX = '[Extracted text saved to: ';

export interface ExtractedTextNoteOptions {
  truncated?: boolean | undefined;
  truncatedReason?: TruncatedReason | undefined;
  stoppedAt?: string | undefined;
}

export function formatTruncationDetail(
  truncatedReason?: TruncatedReason | undefined,
  stoppedAt?: string | undefined,
): string {
  const reason =
    truncatedReason === 'time'
      ? 'time limit'
      : truncatedReason === 'size'
        ? 'output size limit'
        : truncatedReason === 'memory'
          ? 'memory limit'
          : 'limit';
  if (stoppedAt && truncatedReason) return `at ${stoppedAt} (${reason})`;
  if (stoppedAt) return `at ${stoppedAt}`;
  if (truncatedReason) return `at its ${reason}`;
  return 'at its limit';
}

export function extractedTextNote(
  relPath: string,
  truncated: boolean | ExtractedTextNoteOptions = false,
): string {
  const opts: ExtractedTextNoteOptions = typeof truncated === 'boolean' ? { truncated } : truncated;
  if (!opts.truncated) return `${EXTRACTED_TEXT_NOTE_PREFIX}${relPath}]`;
  if (opts.truncatedReason || opts.stoppedAt) {
    return `${EXTRACTED_TEXT_NOTE_PREFIX}${relPath} (truncated ${formatTruncationDetail(opts.truncatedReason, opts.stoppedAt)})]`;
  }
  return `${EXTRACTED_TEXT_NOTE_PREFIX}${relPath} (truncated)]`;
}

/** PA-137: inline caps a Pocket Agent applies when Settings leave them alone. */
export const DEFAULT_INLINE_TEXT_MAX_BYTES = 32 * 1024;
export const DEFAULT_INLINE_EXTRACT_MAX_TOKENS = 8000;
/** PA-137: the most Settings may raise either cap to. */
export const MAX_INLINE_TEXT_MAX_BYTES = 256 * 1024;
export const MAX_INLINE_EXTRACT_MAX_TOKENS = 64_000;

/**
 * PA-137: largest file an MCP client may upload with `upload_attachment`.
 * Smaller than `MAX_ATTACHMENT_BYTES` because it rides inside a JSON-RPC
 * message as base64, and the MCP endpoint's body limit has to hold it.
 */
export const MAX_MCP_ATTACHMENT_BYTES = 5 * 1024 * 1024;

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
    // PA-137: a sidecar line belongs to the file note above it. Only taken
    // once inside the trailing block, or a prompt ending in one would lose it.
    if (last.startsWith(EXTRACTED_TEXT_NOTE_PREFIX) && last.endsWith(']') && lines.length > 1) {
      const above = lines[lines.length - 2]!;
      if (above.startsWith(ATTACHED_FILE_NOTE_PREFIX) || above.startsWith(EXTRACTED_TEXT_NOTE_PREFIX)) {
        lines.pop();
        continue;
      }
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
