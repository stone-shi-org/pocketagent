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
      { name: 'terminal', sessionId: 's-1', hostId: 'local' },
      { name: 'chat', conversationId: 'c-1', hostId: 'local' },
      { name: 'planner-chat', chatId: 'p-1', hostId: 'dev02' },
      { name: 'settings', hostId: 'local' },
      { name: 'cron', hostId: 'dev02' },
      { name: 'cron-job', jobId: 'j-1', hostId: 'local' },
      { name: 'webhooks', hostId: 'local' },
      { name: 'webhook', webhookId: 'w-1', hostId: 'local' },
      { name: 'planner', hostId: 'local' },
      { name: 'planner-agent', agentId: 'a-1', hostId: 'local' },
    ] as const;
    saveOpenTabRoutes([...routes]);
    expect(loadOpenTabRoutes('local')).toEqual(routes);
  });

  it('migrates a pre-PA-67 entry with no host onto the default host', () => {
    // Tabs written before hosts existed must survive the upgrade: dropping
    // them would empty the strip on first load, for a reason no user could
    // see, and the only host those tabs could have been open on is this one.
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem(
      'pocketagent:open-tabs',
      JSON.stringify([
        { name: 'terminal', sessionId: 's-1' },
        { name: 'settings' },
        { name: 'chat', conversationId: 'c-1', hostId: 'dev02' },
        { name: 'planner-chat', chatId: 'p-1', hostId: '' },
      ]),
    );
    expect(loadOpenTabRoutes('local')).toEqual([
      { name: 'terminal', sessionId: 's-1', hostId: 'local' },
      { name: 'settings', hostId: 'local' },
      // An explicit host is preserved as-is.
      { name: 'chat', conversationId: 'c-1', hostId: 'dev02' },
      // An empty one is not a host, so it migrates too.
      { name: 'planner-chat', chatId: 'p-1', hostId: 'local' },
    ]);
  });

  it('returns nothing before anything has been saved', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadOpenTabRoutes('local')).toEqual([]);
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
        { name: 'planner-chat' }, // missing chatId
        { name: 'something-else', sessionId: 's-2' },
        { name: 'settings' },
        { name: 'cron-job' }, // missing jobId
        { name: 'webhook', webhookId: '' }, // empty webhookId
        { name: 'planner-agent', agentId: 'a-1' },
        'not even an object',
        null,
      ]),
    );
    expect(loadOpenTabRoutes('local')).toEqual([
      { name: 'terminal', sessionId: 's-1', hostId: 'local' },
      { name: 'settings', hostId: 'local' },
      { name: 'planner-agent', agentId: 'a-1', hostId: 'local' },
    ]);
  });

  it('treats invalid JSON as no tabs', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('pocketagent:open-tabs', '{not json');
    expect(loadOpenTabRoutes('local')).toEqual([]);
  });

  it('treats a non-array JSON value as no tabs', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('pocketagent:open-tabs', JSON.stringify({ name: 'terminal', sessionId: 's-1' }));
    expect(loadOpenTabRoutes('local')).toEqual([]);
  });

  it('degrades to "nothing remembered" rather than throwing when storage is unavailable', () => {
    // No global `localStorage` at all — the situation this runs under in the
    // plain-Node test environment (and the same shape a browser's private
    // mode throwing on every access would take).
    vi.stubGlobal('localStorage', undefined);
    expect(() =>
      saveOpenTabRoutes([{ name: 'terminal', sessionId: 's-1', hostId: 'local' }]),
    ).not.toThrow();
    expect(loadOpenTabRoutes('local')).toEqual([]);
  });
});
