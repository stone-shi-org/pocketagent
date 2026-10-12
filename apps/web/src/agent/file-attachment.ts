import { LIMITS } from '@pocketagent/protocol';

/**
 * PA-136: the composer's rules for files, kept pure so they can be tested
 * without a DOM (the web project has none; see CLAUDE.md's conventions).
 *
 * Two kinds of thing can be attached, and the split is the point:
 * - **An inline image** — JPEG, PNG, GIF or WebP, at most one per message.
 *   Exactly the pre-PA-136 path (`readImageFile`): base64 inside the prompt,
 *   downscaled, so `claude` gets an SDK image block and a Pocket Agent's model
 *   an `image_url` part.
 * - **A file** — anything else, and any image past the first. Uploaded on its
 *   own (`POST /api/attachments`) and sent as an id; the agent is told a path.
 */

const INLINE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function isInlineImageType(mediaType: string): boolean {
  return INLINE_IMAGE_TYPES.has(mediaType);
}

export type AttachmentRoute = 'inline-image' | 'file';

/**
 * Where a picked, pasted or dropped file goes. An image goes inline unless
 * one is already attached: a second photo used to *replace* the first, which
 * with a multi-select picker would silently drop all but one of them.
 */
export function routeAttachment(
  file: { type: string },
  opts: { hasInlineImage: boolean; supportsFiles: boolean },
): AttachmentRoute | null {
  if (isInlineImageType(file.type) && !opts.hasInlineImage) return 'inline-image';
  return opts.supportsFiles ? 'file' : null;
}

/** Why a file cannot be attached, as a sentence for the user — or `null`. */
export function fileAttachProblem(file: { name: string; size: number }, filesAlreadyAttached: number): string | null {
  if (filesAlreadyAttached >= LIMITS.maxAttachmentsPerPrompt) {
    return `At most ${LIMITS.maxAttachmentsPerPrompt} files can be attached to one message.`;
  }
  if (file.size > LIMITS.maxAttachmentBytes) {
    const maxMb = Math.floor(LIMITS.maxAttachmentBytes / (1024 * 1024));
    return `“${file.name}” is too large — files can be at most ${maxMb} MB.`;
  }
  return null;
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** One file chip in the composer. */
export interface PendingFile {
  /** Local only, for React keys and for matching an upload's result. */
  localId: string;
  name: string;
  size: number;
  mediaType: string;
  state: 'uploading' | 'ready' | 'error';
  attachmentId?: string;
  error?: string;
}

/** Ids of the files ready to send, in the order they were attached. */
export function readyAttachmentIds(files: readonly PendingFile[]): string[] {
  return files.flatMap((f) => (f.state === 'ready' && f.attachmentId ? [f.attachmentId] : []));
}

/**
 * What blocks Send. An upload still running blocks it (sending now would drop
 * the file). A failed one does too, until it is removed, so a message never
 * goes out without a file the user can still see attached.
 */
export function filesBlockSend(files: readonly PendingFile[]): 'uploading' | 'error' | null {
  if (files.some((f) => f.state === 'uploading')) return 'uploading';
  if (files.some((f) => f.state === 'error')) return 'error';
  return null;
}

/** The files a clipboard or a drop carries. A plain text paste has none. */
export function filesFromDataTransfer(data: { items?: ArrayLike<DataTransferItemLike>; files?: ArrayLike<File> } | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  if (data.items && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) out.push(file);
    }
    return out;
  }
  return data.files ? Array.from(data.files) : [];
}

interface DataTransferItemLike {
  kind: string;
  getAsFile(): File | null;
}
