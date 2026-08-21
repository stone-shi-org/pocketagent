import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveFontFamily } from './font-family.js';

/** A minimal in-memory stand-in for the real `localStorage`. */
function fakeStorage(initial?: Record<string, string>): Storage {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
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

describe('resolveFontFamily', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the bundled Nerd Font plus the system fallback stack when there is no override', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(resolveFontFamily()).toBe(
      '"JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, ' +
        '"Liberation Mono", monospace',
    );
  });

  it('puts a configured override first, ahead of the bundled default', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({ 'pocketagent:terminal-font-override': 'MesloLGS NF' }),
    );
    expect(resolveFontFamily()).toBe(
      '"MesloLGS NF", "JetBrainsMono Nerd Font Mono", ui-monospace, SFMono-Regular, Menlo, ' +
        'Consolas, "Liberation Mono", monospace',
    );
  });

  it('strips embedded quotes from an override rather than breaking the font-family list', () => {
    vi.stubGlobal(
      'localStorage',
      fakeStorage({ 'pocketagent:terminal-font-override': 'Weird"Font' }),
    );
    expect(resolveFontFamily().startsWith('"WeirdFont", ')).toBe(true);
  });
});
