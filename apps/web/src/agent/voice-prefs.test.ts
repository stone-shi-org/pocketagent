import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getGeminiLivePref,
  getVoiceDirectSendPref,
  getVoiceMicDeviceIdPref,
  setGeminiLivePref,
  setVoiceDirectSendPref,
  setVoiceMicDeviceIdPref,
} from './voice-prefs.js';

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

describe('voice mic device id preference (PA-94)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to empty string when unset (meaning system default)', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getVoiceMicDeviceIdPref()).toBe('');
  });

  it('remembers preference when set', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setVoiceMicDeviceIdPref('device-mic-123');
    expect(getVoiceMicDeviceIdPref()).toBe('device-mic-123');
  });

  it('removes item from storage when set to empty string or whitespace', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setVoiceMicDeviceIdPref('device-mic-123');
    expect(getVoiceMicDeviceIdPref()).toBe('device-mic-123');
    setVoiceMicDeviceIdPref('');
    expect(getVoiceMicDeviceIdPref()).toBe('');
    setVoiceMicDeviceIdPref('device-mic-456');
    expect(getVoiceMicDeviceIdPref()).toBe('device-mic-456');
    setVoiceMicDeviceIdPref('   ');
    expect(getVoiceMicDeviceIdPref()).toBe('');
  });

  it('degrades to empty string without throwing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setVoiceMicDeviceIdPref('device-mic-123')).not.toThrow();
    expect(getVoiceMicDeviceIdPref()).toBe('');
  });
});

describe('gemini live preference (PA-98)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to false when unset', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getGeminiLivePref()).toBe(false);
    expect(getGeminiLivePref('chat-1')).toBe(false);
  });

  it('remembers global and per-chat preference', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setGeminiLivePref(true, 'chat-1');
    expect(getGeminiLivePref('chat-1')).toBe(true);
    expect(getGeminiLivePref()).toBe(true);

    setGeminiLivePref(false, 'chat-1');
    expect(getGeminiLivePref('chat-1')).toBe(false);
    expect(getGeminiLivePref()).toBe(false);
  });

  it('degrades to false without throwing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setGeminiLivePref(true, 'chat-1')).not.toThrow();
    expect(getGeminiLivePref('chat-1')).toBe(false);
  });
});

