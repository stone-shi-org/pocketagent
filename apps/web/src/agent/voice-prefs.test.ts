import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVoiceDirectSendPref, setVoiceDirectSendPref } from './voice-prefs.js';

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

describe('voice direct send preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to false when unset', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getVoiceDirectSendPref()).toBe(false);
  });

  it('remembers preference when set to true', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setVoiceDirectSendPref(true);
    expect(getVoiceDirectSendPref()).toBe(true);
  });

  it('removes item from storage when set to false', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setVoiceDirectSendPref(true);
    expect(getVoiceDirectSendPref()).toBe(true);
    setVoiceDirectSendPref(false);
    expect(getVoiceDirectSendPref()).toBe(false);
  });

  it('degrades to false without throwing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setVoiceDirectSendPref(true)).not.toThrow();
    expect(getVoiceDirectSendPref()).toBe(false);
  });
});
