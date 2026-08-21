import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTakeOverSizePref, setTakeOverSizePref } from './adopted-size-prefs.js';

/** A minimal in-memory stand-in for the real `localStorage`. */
function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => void store.set(key, value),
    removeItem: (key) => void store.delete(key),
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe('adopted-size preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remembers a pane once "fit to this screen anyway" is chosen for it', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getTakeOverSizePref('pane-1')).toBe(false);
    setTakeOverSizePref('pane-1');
    expect(getTakeOverSizePref('pane-1')).toBe(true);
  });

  it('keeps two panes independent', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setTakeOverSizePref('pane-1');
    expect(getTakeOverSizePref('pane-1')).toBe(true);
    expect(getTakeOverSizePref('pane-2')).toBe(false);
  });

  it('degrades to "not remembered" rather than throwing when storage is unavailable', () => {
    // No global `localStorage` at all — the situation this runs under in the
    // plain-Node test environment (and the same shape a browser's private
    // mode throwing on every access would take).
    vi.stubGlobal('localStorage', undefined);
    expect(() => setTakeOverSizePref('pane-1')).not.toThrow();
    expect(getTakeOverSizePref('pane-1')).toBe(false);
  });
});
