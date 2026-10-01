import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearHostTreeState,
  loadHostTreeState,
  loadPocketAgentsTreeState,
  loadProjectTreeState,
  loadShellCollapsed,
  saveCollapsedPocketAgents,
  saveCollapsedPocketAgentCron,
  saveCollapsedProjects,
  saveCollapsedQueued,
  saveCollapsedSubagents,
  saveExpandedChats,
  saveExpandedDeleted,
  saveShellCollapsed,
} from './tree-pref.js';

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

describe('tree preferences (PA-117)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('persists and round-trips project tree states per host', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    saveCollapsedProjects('host-a', ['/repo/proj1', '/repo/proj2']);
    saveCollapsedSubagents('host-a', ['/repo/proj1']);
    saveCollapsedQueued('host-a', ['/repo/proj2']);
    saveExpandedDeleted('host-a', ['/repo/proj3']);
    saveExpandedChats('host-a', ['/repo/proj1']);

    const loaded = loadProjectTreeState('host-a');
    expect(Array.from(loaded.collapsed)).toEqual(['/repo/proj1', '/repo/proj2']);
    expect(Array.from(loaded.collapsedSubagents)).toEqual(['/repo/proj1']);
    expect(Array.from(loaded.collapsedQueued)).toEqual(['/repo/proj2']);
    expect(Array.from(loaded.expandedDeleted)).toEqual(['/repo/proj3']);
    expect(Array.from(loaded.expandedChats)).toEqual(['/repo/proj1']);

    // Host B remains unaffected
    const hostB = loadProjectTreeState('host-b');
    expect(hostB.collapsed.size).toBe(0);
    expect(hostB.collapsedSubagents.size).toBe(0);
    expect(hostB.collapsedQueued.size).toBe(0);
    expect(hostB.expandedDeleted.size).toBe(0);
    expect(hostB.expandedChats.size).toBe(0);
  });

  it('persists and round-trips shell section collapsed state', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    expect(loadShellCollapsed('host-a')).toBe(false);

    saveShellCollapsed('host-a', true);
    expect(loadShellCollapsed('host-a')).toBe(true);

    // Host B still defaults to false
    expect(loadShellCollapsed('host-b')).toBe(false);

    saveShellCollapsed('host-a', false);
    expect(loadShellCollapsed('host-a')).toBe(false);
  });

  it('persists and round-trips pocket agent workspaces and scheduled jobs collapsed state', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    saveCollapsedPocketAgents('host-a', ['ws-alpha', 'ws-beta']);
    saveCollapsedPocketAgentCron('host-a', ['ws-alpha']);

    const loaded = loadPocketAgentsTreeState('host-a');
    expect(Array.from(loaded.collapsed)).toEqual(['ws-alpha', 'ws-beta']);
    expect(Array.from(loaded.cronCollapsed)).toEqual(['ws-alpha']);

    const hostB = loadPocketAgentsTreeState('host-b');
    expect(hostB.collapsed.size).toBe(0);
    expect(hostB.cronCollapsed.size).toBe(0);
  });

  it('falls back to default host when hostId is empty', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    saveShellCollapsed('', true);
    expect(loadShellCollapsed('local')).toBe(true);
  });

  it('recovers gracefully from corrupted localStorage content', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage);

    storage.setItem('pocketagent:tree-state:corrupt', '{bad json');
    expect(loadHostTreeState('corrupt')).toEqual({});
    expect(loadShellCollapsed('corrupt')).toBe(false);
    expect(loadProjectTreeState('corrupt').collapsed.size).toBe(0);

    storage.setItem('pocketagent:tree-state:corrupt', JSON.stringify({
      collapsedProjects: 'not-an-array',
      shellCollapsed: 'not-a-boolean',
    }));
    expect(loadHostTreeState('corrupt')).toEqual({});
  });

  it('handles missing localStorage gracefully without throwing', () => {
    vi.stubGlobal('localStorage', undefined);

    expect(() => saveShellCollapsed('host-a', true)).not.toThrow();
    expect(loadShellCollapsed('host-a')).toBe(false);
    expect(loadProjectTreeState('host-a').collapsed.size).toBe(0);
    expect(loadPocketAgentsTreeState('host-a').collapsed.size).toBe(0);
  });

  it('clears host tree state with clearHostTreeState', () => {
    vi.stubGlobal('localStorage', fakeStorage());

    saveShellCollapsed('host-a', true);
    expect(loadShellCollapsed('host-a')).toBe(true);

    clearHostTreeState('host-a');
    expect(loadShellCollapsed('host-a')).toBe(false);
  });
});
