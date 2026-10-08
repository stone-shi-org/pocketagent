/**
 * PA-122: how big an attached image may be, and how to get it there.
 *
 * pi sends at most 2000×2000 and about 4.5 MB of base64. Both limits matter
 * independently: the pixel cap is what providers actually charge and resize
 * by (Anthropic refuses a multi-image request with any side over 2000), and
 * the byte cap is what keeps one phone photo from dominating every later
 * round trip. Before this a photo was sent exactly as taken, or refused
 * outright past 5 MB — which is most photos a current phone takes.
 *
 * Pure, so the sizing decisions are unit-tested in the `node` test
 * environment; `image-attachment.ts` does the actual canvas work.
 */

export const MAX_IMAGE_SIDE_PX = 2000;

/** About 4.5 MB of base64 — well inside `MAX_IMAGE_BASE64_CHARS`. */
export const TARGET_IMAGE_BASE64_CHARS = 4_718_592;

/** The largest file worth trying to shrink. Past this the decode alone is
    a real memory spike on a phone. */
export const MAX_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;

export interface Size {
  width: number;
  height: number;
}

/** `size` scaled down, aspect ratio kept, so neither side exceeds `max`. */
export function fitWithin(size: Size, max = MAX_IMAGE_SIDE_PX): Size {
  const scale = Math.min(1, max / size.width, max / size.height);
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export function needsDownscale(size: Size, base64Chars: number): boolean {
  return (
    size.width > MAX_IMAGE_SIDE_PX || size.height > MAX_IMAGE_SIDE_PX || base64Chars > TARGET_IMAGE_BASE64_CHARS
  );
}

export interface EncodingAttempt extends Size {
  type: 'image/png' | 'image/jpeg';
  /** `toBlob`'s quality, for JPEG. */
  quality?: number;
}

/**
 * The encodings to try, best first; the first that fits the byte target
 * wins. A PNG, WebP or GIF source is tried as a lossless PNG first, which
 * keeps transparency and suits screenshots (the common case here) — then
 * JPEG, which flattens transparency onto white but is what makes a photo
 * fit. Quality is stepped down before size, since a slightly softer image
 * keeps more legible detail than a smaller one.
 */
export function encodingAttempts(source: Size, sourceType: string): EncodingAttempt[] {
  const attempts: EncodingAttempt[] = [];
  const fitted = fitWithin(source);
  if (sourceType !== 'image/jpeg') attempts.push({ ...fitted, type: 'image/png' });
  for (const scale of [1, 0.75, 0.5, 0.35]) {
    const size = fitWithin({ width: fitted.width * scale, height: fitted.height * scale }, MAX_IMAGE_SIDE_PX);
    for (const quality of [0.85, 0.7, 0.55]) attempts.push({ ...size, type: 'image/jpeg', quality });
  }
  return attempts;
}
