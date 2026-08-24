import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadOpenTabRoutes, saveOpenTabRoutes } from './open-tabs-pref.js';

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

describe('open tabs preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips an ordered list of tab routes', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const routes = [
      { name: 'terminal', sessionId: 's-1' },
      { name: 'chat', conversationId: 'c-1' },
    ] as const;
    saveOpenTabRoutes([...routes]);
    expect(loadOpenTabRoutes()).toEqual(routes);
  });

  it('returns nothing before anything has been saved', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadOpenTabRoutes()).toEqual([]);
  });

  it('drops malformed entries instead of failing the whole list', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(
      'pocketagent:open-tabs',
      JSON.stringify([
        { name: 'terminal', sessionId: 's-1' },
        { name: 'terminal' }, // missing sessionId
        { name: 'chat', conversationId: '' }, // empty conversationId
        { name: 'something-else', sessionId: 's-2' },
        'not even an object',
        null,
      ]),
    );
    expect(loadOpenTabRoutes()).toEqual([{ name: 'terminal', sessionId: 's-1' }]);
  });

  it('treats invalid JSON as no tabs', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('pocketagent:open-tabs', '{not json');
    expect(loadOpenTabRoutes()).toEqual([]);
  });

  it('treats a non-array JSON value as no tabs', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('pocketagent:open-tabs', JSON.stringify({ name: 'terminal', sessionId: 's-1' }));
    expect(loadOpenTabRoutes()).toEqual([]);
  });

  it('degrades to "nothing remembered" rather than throwing when storage is unavailable', () => {
    // No global `localStorage` at all — the situation this runs under in the
    // plain-Node test environment (and the same shape a browser's private
    // mode throwing on every access would take).
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveOpenTabRoutes([{ name: 'terminal', sessionId: 's-1' }])).not.toThrow();
    expect(loadOpenTabRoutes()).toEqual([]);
  });
});
