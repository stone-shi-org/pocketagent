import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PROMPT_HISTORY_ENTRIES,
  appendPromptHistory,
  clearPromptHistory,
  codePromptHistoryKey,
  getPromptHistory,
  normalizeWorkspacePath,
  plannerPromptHistoryKey,
} from './prompt-history.js';

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

describe('prompt-history (PA-119)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('normalizeWorkspacePath & key derivation', () => {
    it('normalizes worktree paths to main project repository root', () => {
      expect(
        normalizeWorkspacePath('/data/repos/pocketagent/.worktrees/feature-ui'),
      ).toBe('/data/repos/pocketagent');
      expect(
        normalizeWorkspacePath('/data/repos/pocketagent/.worktrees/feature-ui/apps/web'),
      ).toBe('/data/repos/pocketagent');
    });

    it('preserves regular workspace paths without worktree segments', () => {
      expect(normalizeWorkspacePath('/data/repos/pocketagent')).toBe(
        '/data/repos/pocketagent',
      );
      expect(normalizeWorkspacePath('/data/repos/pocketagent/')).toBe(
        '/data/repos/pocketagent',
      );
    });

    it('derives global planner prompt history key', () => {
      expect(plannerPromptHistoryKey()).toBe('pocketagent:prompt-history:planner');
    });

    it('derives per-workspace code prompt history key', () => {
      expect(codePromptHistoryKey('/data/repos/project-a')).toBe(
        'pocketagent:prompt-history:code:/data/repos/project-a',
      );
      // Worktree rolls into main checkout key
      expect(
        codePromptHistoryKey('/data/repos/project-a/.worktrees/fix-123'),
      ).toBe('pocketagent:prompt-history:code:/data/repos/project-a');
      // Blank or null falls back to default
      expect(codePromptHistoryKey(null)).toBe('pocketagent:prompt-history:code:default');
      expect(codePromptHistoryKey('')).toBe('pocketagent:prompt-history:code:default');
    });
  });

  describe('history storage and manipulation', () => {
    const testKey = 'pocketagent:prompt-history:test-scope';

    afterEach(() => {
      clearPromptHistory(testKey);
    });

    it('returns empty array when no history exists', () => {
      vi.stubGlobal('localStorage', fakeStorage());
      expect(getPromptHistory(testKey)).toEqual([]);
    });

    it('appends and persists human prompts', () => {
      vi.stubGlobal('localStorage', fakeStorage());
      appendPromptHistory(testKey, 'npm test');
      appendPromptHistory(testKey, 'git status');

      expect(getPromptHistory(testKey)).toEqual(['npm test', 'git status']);
    });

    it('trims whitespace and ignores blank prompts', () => {
      vi.stubGlobal('localStorage', fakeStorage());
      appendPromptHistory(testKey, '   ');
      appendPromptHistory(testKey, '  echo hello  ');

      expect(getPromptHistory(testKey)).toEqual(['echo hello']);
    });

    it('de-duplicates prompts and moves existing entry to latest position', () => {
      vi.stubGlobal('localStorage', fakeStorage());
      appendPromptHistory(testKey, 'cmd 1');
      appendPromptHistory(testKey, 'cmd 2');
      appendPromptHistory(testKey, 'cmd 3');
      appendPromptHistory(testKey, 'cmd 1');

      expect(getPromptHistory(testKey)).toEqual(['cmd 2', 'cmd 3', 'cmd 1']);
    });

    it('caps history length at MAX_PROMPT_HISTORY_ENTRIES', () => {
      vi.stubGlobal('localStorage', fakeStorage());
      for (let i = 0; i < MAX_PROMPT_HISTORY_ENTRIES + 20; i++) {
        appendPromptHistory(testKey, `prompt ${i}`);
      }

      const history = getPromptHistory(testKey);
      expect(history.length).toBe(MAX_PROMPT_HISTORY_ENTRIES);
      expect(history[0]).toBe('prompt 20');
      expect(history[MAX_PROMPT_HISTORY_ENTRIES - 1]).toBe(
        `prompt ${MAX_PROMPT_HISTORY_ENTRIES + 19}`,
      );
    });

    it('operates in memory when localStorage is not available', () => {
      vi.stubGlobal('localStorage', undefined);
      appendPromptHistory(testKey, 'memory prompt 1');
      appendPromptHistory(testKey, 'memory prompt 2');

      expect(getPromptHistory(testKey)).toEqual([
        'memory prompt 1',
        'memory prompt 2',
      ]);
    });
  });
});
