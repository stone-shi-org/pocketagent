import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTerminalFontOverride, setTerminalFontOverride } from './terminal-font-pref.js';

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

describe('terminal font override preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has no override until one is set', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getTerminalFontOverride()).toBeNull();
  });

  it('remembers a font name once set', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setTerminalFontOverride('MesloLGS NF');
    expect(getTerminalFontOverride()).toBe('MesloLGS NF');
  });

  it('trims surrounding whitespace', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setTerminalFontOverride('  Fira Code  ');
    expect(getTerminalFontOverride()).toBe('Fira Code');
  });

  it('clears the override when set to blank, rather than storing an empty string', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setTerminalFontOverride('MesloLGS NF');
    setTerminalFontOverride('   ');
    expect(getTerminalFontOverride()).toBeNull();
  });

  it('degrades to "no override" rather than throwing when storage is unavailable', () => {
    // No global `localStorage` at all — the situation this runs under in the
    // plain-Node test environment (and the same shape a browser's private
    // mode throwing on every access would take).
    vi.stubGlobal('localStorage', undefined);
    expect(() => setTerminalFontOverride('MesloLGS NF')).not.toThrow();
    expect(getTerminalFontOverride()).toBeNull();
  });
});
