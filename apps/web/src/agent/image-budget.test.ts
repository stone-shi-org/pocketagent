import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_SIDE_PX,
  TARGET_IMAGE_BASE64_CHARS,
  encodingAttempts,
  fitWithin,
  needsDownscale,
} from './image-budget.js';

describe('image budget (PA-122)', () => {
  it('scales the longer side down to 2000 px and keeps the aspect ratio', () => {
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin({ width: 1170, height: 2532 })).toEqual({ width: 924, height: 2000 });
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });

  it('downscales for size in pixels or in bytes, and leaves a small image alone', () => {
    expect(needsDownscale({ width: 2001, height: 10 }, 100)).toBe(true);
    expect(needsDownscale({ width: 1000, height: 1000 }, TARGET_IMAGE_BASE64_CHARS + 1)).toBe(true);
    expect(needsDownscale({ width: MAX_IMAGE_SIDE_PX, height: 1000 }, TARGET_IMAGE_BASE64_CHARS)).toBe(false);
  });

  it('tries lossless PNG first for a screenshot, never for a photo, then JPEG getting smaller', () => {
    const shot = encodingAttempts({ width: 3000, height: 2000 }, 'image/png');
    expect(shot[0]).toEqual({ width: 2000, height: 1333, type: 'image/png' });
    expect(shot.slice(1).every((a) => a.type === 'image/jpeg')).toBe(true);

    const photo = encodingAttempts({ width: 4032, height: 3024 }, 'image/jpeg');
    expect(photo[0]).toEqual({ width: 2000, height: 1500, type: 'image/jpeg', quality: 0.85 });
    expect(photo.every((a) => a.width <= MAX_IMAGE_SIDE_PX && a.height <= MAX_IMAGE_SIDE_PX)).toBe(true);
    // Quality steps down before size does, and the last attempt is the smallest.
    expect(photo[1]).toMatchObject({ width: 2000, quality: 0.7 });
    expect(photo.at(-1)!.width).toBeLessThan(photo[0]!.width);
  });
});
