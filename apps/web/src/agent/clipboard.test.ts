import { describe, expect, it, vi } from 'vitest';
import { copyText, type ClipboardDeps } from './clipboard.js';

const deps = (over: Partial<ClipboardDeps> = {}): ClipboardDeps => ({
  write: null,
  legacy: null,
  ...over,
});

describe('copyText', () => {
  it('uses the async clipboard when it is available', async () => {
    const write = vi.fn(async () => {});
    const legacy = vi.fn(() => true);
    expect(await copyText('hello', deps({ write, legacy }))).toBe(true);
    expect(write).toHaveBeenCalledWith('hello');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('falls back when there is no clipboard at all', async () => {
    // The case that matters: `navigator.clipboard` is undefined on a plain-HTTP
    // origin, which is how this app is usually reached from a phone.
    const legacy = vi.fn(() => true);
    expect(await copyText('hello', deps({ legacy }))).toBe(true);
    expect(legacy).toHaveBeenCalledWith('hello');
  });

  it('falls back when the clipboard rejects', async () => {
    // A context that claims the API but denies permission.
    const write = vi.fn(async () => {
      throw new Error('NotAllowedError');
    });
    const legacy = vi.fn(() => true);
    expect(await copyText('hello', deps({ write, legacy }))).toBe(true);
    expect(legacy).toHaveBeenCalled();
  });

  it('reports failure when neither path works', async () => {
    const write = vi.fn(async () => {
      throw new Error('nope');
    });
    expect(await copyText('hello', deps({ write, legacy: () => false }))).toBe(false);
  });

  it('reports failure when there is nothing to copy with', async () => {
    expect(await copyText('hello', deps())).toBe(false);
  });

  it('does nothing for empty text', async () => {
    const write = vi.fn(async () => {});
    expect(await copyText('', deps({ write }))).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
