/**
 * PA-122: what images a Pocket Agent request carries.
 *
 * Before this every image anywhere in the projected context was re-sent, as
 * base64, on every round trip of every turn — to a model that might not read
 * images at all. Three rules, applied to the messages after they are built so
 * the transcript itself is never touched (switching back to a vision model
 * sees every image again):
 *
 *  - a model that cannot read images gets a one-line note in place of each;
 *  - only the newest `MAX_CONTEXT_IMAGES` are sent, older ones become a note,
 *    because the screenshot a user is asking about is nearly always the
 *    latest and an old one costs the same tokens every round trip;
 *  - an image whose header cannot be read, or that is larger than any
 *    provider accepts, is left out with a note rather than sent to fail the
 *    whole request.
 *
 * Images are *resized* in the browser (`apps/web/src/agent/image-budget.ts`)
 * rather than here: the server has no image library, `sharp` would be a third
 * native dependency, and the browser has already decoded the image to show
 * its preview. This module only needs dimensions, which a few bytes of each
 * format's header give without decoding anything.
 */
import type { PlannerChatMessage, PlannerUserContentPart } from './llm-client.js';

/** The newest images a request carries; older ones are replaced by a note. */
export const MAX_CONTEXT_IMAGES = 4;

/** The longest side any provider accepts (Anthropic's limit; OpenAI resizes
    above 2048 itself). An image over it fails the request outright. */
export const MAX_IMAGE_SIDE_PX = 8000;

/** Enough base64 to reach a JPEG's frame header past a large EXIF block. */
const HEADER_BASE64_CHARS = 350_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Width and height from the image's own header — PNG `IHDR`, a JPEG `SOFn`
 * marker, GIF's logical screen, WebP's `VP8 `/`VP8L`/`VP8X` chunk — or `null`
 * when the bytes are not a well-formed image of that kind.
 */
export function imageDimensions(mediaType: string, base64: string): ImageDimensions | null {
  let bytes: Buffer;
  try {
    // A prefix of valid base64 is valid base64 once cut to a multiple of 4.
    const prefix = base64.slice(0, HEADER_BASE64_CHARS);
    bytes = Buffer.from(prefix.slice(0, prefix.length - (prefix.length % 4)), 'base64');
  } catch {
    return null;
  }
  const ok = (d: ImageDimensions): ImageDimensions | null => (d.width > 0 && d.height > 0 ? d : null);
  switch (mediaType) {
    case 'image/png':
      if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
        return null;
      }
      return ok({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
    case 'image/gif':
      if (bytes.length < 10 || bytes.toString('latin1', 0, 4) !== 'GIF8') return null;
      return ok({ width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) });
    case 'image/webp':
      return webpDimensions(bytes);
    case 'image/jpeg':
      return jpegDimensions(bytes);
    default:
      return null;
  }
}

function webpDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b0 = b[21]!;
    const b1 = b[22]!;
    const b2 = b[23]!;
    const b3 = b[24]!;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}

/** SOF0–SOF15 minus DHT (C4), JPG (C8) and DAC (CC), which share the range. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(b: Buffer): ImageDimensions | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return null;
    const marker = b[off + 1]!;
    if (marker === 0xff) {
      off += 1; // fill byte
      continue;
    }
    // Markers with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      off += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end, or scan data before any frame header
    const length = b.readUInt16BE(off + 2);
    if (length < 2) return null;
    if (JPEG_SOF.has(marker)) {
      if (off + 9 > b.length) return null;
      const d = { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
      return d.width > 0 && d.height > 0 ? d : null;
    }
    off += 2 + length;
  }
  return null;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * The messages with the three rules above applied. Pure; returns new message
 * objects only where something changed. A user message left with no image
 * goes back to plain-string content, which is what it would have been had it
 * never carried one — some text-only servers refuse array content outright.
 */
export function budgetContextImages(
  messages: readonly PlannerChatMessage[],
  opts: { supportsImages: boolean; modelId: string; maxImages?: number },
): PlannerChatMessage[] {
  const maxImages = opts.maxImages ?? MAX_CONTEXT_IMAGES;
  let kept = 0;
  const out = [...messages];
  // Newest first, so "the newest N" is a running count.
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    if (!m.content.some((p) => p.type === 'image_url')) continue;
    const parts: PlannerUserContentPart[] = [];
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j]!;
      if (part.type !== 'image_url') {
        parts.unshift(part);
        continue;
      }
      const note = imageNote(part.image_url.url, opts, kept >= maxImages);
      if (note === null) {
        kept++;
        parts.unshift(part);
      } else {
        parts.unshift({ type: 'text', text: note });
      }
    }
    out[i] = parts.every((p) => p.type === 'text')
      ? { role: 'user', content: parts.map((p) => (p as { text: string }).text).join('\n\n') }
      : { role: 'user', content: parts };
  }
  return out;
}

/** Why one image is left out, or `null` to send it. */
function imageNote(url: string, opts: { supportsImages: boolean; modelId: string }, overBudget: boolean): string | null {
  if (!opts.supportsImages) {
    return `[An image was attached here, but ${opts.modelId} cannot read images, so it was left out.]`;
  }
  if (overBudget) return '[An earlier image was attached here; it was left out to save context.]';
  const match = DATA_URL.exec(url);
  if (!match) return null; // not ours to judge — a remote URL is the provider's to fetch
  const dims = imageDimensions(match[1]!, match[2]!);
  if (!dims) return '[An image was attached here, but it could not be read, so it was left out.]';
  if (dims.width > MAX_IMAGE_SIDE_PX || dims.height > MAX_IMAGE_SIDE_PX) {
    return `[An image was attached here, but at ${dims.width}×${dims.height} it is too large to send, so it was left out.]`;
  }
  return null;
}
