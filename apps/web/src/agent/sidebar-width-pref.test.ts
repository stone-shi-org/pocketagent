import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  getSidebarWidthPref,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  setSidebarWidthPref,
} from './sidebar-width-pref.js';

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

describe('sidebar width preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clamps width to min and max boundaries', () => {
    expect(clampSidebarWidth(100)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(250)).toBe(250);
    expect(clampSidebarWidth(1000)).toBe(MAX_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('returns default width when unset', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(getSidebarWidthPref()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('saves and reads preferred sidebar width', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setSidebarWidthPref(400);
    expect(getSidebarWidthPref()).toBe(400);
  });

  it('clamps saved width upon reading', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    setSidebarWidthPref(150);
    expect(getSidebarWidthPref()).toBe(MIN_SIDEBAR_WIDTH);
    setSidebarWidthPref(800);
    expect(getSidebarWidthPref()).toBe(MAX_SIDEBAR_WIDTH);
  });

  it('handles unavailable localStorage gracefully', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => setSidebarWidthPref(350)).not.toThrow();
    expect(getSidebarWidthPref()).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});
