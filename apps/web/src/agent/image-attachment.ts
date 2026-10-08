import { LIMITS, type PromptImage } from '@pocketagent/protocol';
import {
  MAX_SOURCE_IMAGE_BYTES,
  TARGET_IMAGE_BASE64_CHARS,
  encodingAttempts,
  needsDownscale,
  type EncodingAttempt,
} from './image-budget.js';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type AllowedMediaType = (typeof ALLOWED_TYPES)[number];

function isAllowedType(type: string): type is AllowedMediaType {
  return (ALLOWED_TYPES as readonly string[]).includes(type);
}

/**
 * Read a browser `File` — from the attach button's file picker, or a pasted
 * clipboard image — into the base64 shape the wire protocol carries.
 *
 * Throws a plain `Error` whose message is meant to be shown to the user
 * directly, so both of `PromptBox`'s entry points (file input `onChange` and
 * textarea `onPaste`) can catch and display it the same way, without each
 * having to know what actually went wrong.
 */
export async function readImageFile(file: File): Promise<PromptImage> {
  if (!isAllowedType(file.type)) {
    throw new Error('Only JPEG, PNG, GIF or WebP images can be attached.');
  }
  // PA-122: a large photo is shrunk rather than refused, so the cap here is
  // on what is worth decoding; what is *sent* is held to the image budget.
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    const maxMb = Math.floor(MAX_SOURCE_IMAGE_BYTES / (1024 * 1024));
    throw new Error(`Image is too large — the limit is ${maxMb} MB.`);
  }

  const mediaType: AllowedMediaType = file.type;
  const original = async (): Promise<PromptImage> => ({ mediaType, data: await blobToBase64(file) });

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = typeof createImageBitmap === 'function' ? await createImageBitmap(file) : null;
  } catch {
    bitmap = null;
  }
  if (!bitmap) {
    // Cannot decode it here (an old browser, or a file the browser cannot
    // read): send it as it is if it fits, as before PA-122.
    if (file.size > LIMITS.maxImageBytes) {
      throw new Error('Image is too large to attach, and this browser could not shrink it.');
    }
    return original();
  }
  try {
    const size = { width: bitmap.width, height: bitmap.height };
    // An image already inside the budget is sent untouched — including an
    // animated GIF, which re-encoding would flatten to its first frame.
    if (!needsDownscale(size, Math.ceil(file.size / 3) * 4)) return await original();
    for (const attempt of encodingAttempts(size, file.type)) {
      const blob = await encode(bitmap, attempt);
      if (!blob) continue;
      const data = await blobToBase64(blob);
      if (data.length <= TARGET_IMAGE_BASE64_CHARS) return { mediaType: attempt.type, data };
    }
  } finally {
    bitmap.close();
  }
  throw new Error('Could not shrink that image enough to attach it.');
}

async function encode(bitmap: ImageBitmap, attempt: EncodingAttempt): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = attempt.width;
  canvas.height = attempt.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (attempt.type === 'image/jpeg') {
    // JPEG has no alpha: transparent pixels would otherwise come out black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, attempt.width, attempt.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
  return new Promise((resolve) => canvas.toBlob(resolve, attempt.type, attempt.quality));
}

/** `readAsDataURL` yields `data:image/png;base64,AAAA...`; the wire format
    wants the payload only, since `mediaType` already carries the rest. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(blob);
  });
}
