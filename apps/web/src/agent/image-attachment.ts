import { LIMITS, type PromptImage } from '@pocketagent/protocol';

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
  if (file.size > LIMITS.maxImageBytes) {
    const maxMb = Math.floor(LIMITS.maxImageBytes / (1024 * 1024));
    throw new Error(`Image is too large — the limit is ${maxMb} MB.`);
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });

  // `readAsDataURL` yields `data:image/png;base64,AAAA...` — the wire format
  // wants the base64 payload only, since `mediaType` already carries what's
  // before the comma.
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { mediaType: file.type, data };
}
