import { DEFAULT_HOST_ID } from '../api/host.js';

/**
 * Which project folders, shell sections, and pocket agent workspaces are
 * collapsed or expanded per host (PA-117).
 *
 * ## Why per-host
 *
 * In Hub model, users frequently switch between hosts via the HostRail or switcher.
 * Visible hosts change, unmounting the previous host's tree sections. Without
 * persistence, remounting a host defaults to all folders and sections expanded,
 * losing the operator's carefully organized view.
 *
 * Persisting in `localStorage` under `pocketagent:tree-state:<hostId>` ensures
 * that each host's layout status sticks across host switching and page reloads.
 *
 * Every access is defensive — `localStorage` may be unavailable (private browsing,
 * iframe restrictions) or absent (SSR/test environments without DOM), and corrupted
 * values safely fall back to the default (all expanded).
 */

const KEY_PREFIX = 'pocketagent:tree-state:';

export interface HostTreeState {
  collapsedProjects?: string[];
  collapsedSubagents?: string[];
  collapsedQueued?: string[];
  expandedDeleted?: string[];
  expandedChats?: string[];
  shellCollapsed?: boolean;
  collapsedPocketAgents?: string[];
  collapsedPocketAgentCron?: string[];
}

function cleanStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

export function loadHostTreeState(hostId: string): HostTreeState {
  try {
    if (typeof localStorage === 'undefined') return {};
    const key = KEY_PREFIX + (hostId || DEFAULT_HOST_ID);
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const obj = parsed as Record<string, unknown>;
    return {
      collapsedProjects: cleanStringArray(obj.collapsedProjects),
      collapsedSubagents: cleanStringArray(obj.collapsedSubagents),
      collapsedQueued: cleanStringArray(obj.collapsedQueued),
      expandedDeleted: cleanStringArray(obj.expandedDeleted),
      expandedChats: cleanStringArray(obj.expandedChats),
      shellCollapsed: typeof obj.shellCollapsed === 'boolean' ? obj.shellCollapsed : undefined,
      collapsedPocketAgents: cleanStringArray(obj.collapsedPocketAgents),
      collapsedPocketAgentCron: cleanStringArray(obj.collapsedPocketAgentCron),
    };
  } catch {
    return {};
  }
}

export function updateHostTreeState(hostId: string, patch: Partial<HostTreeState>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const current = loadHostTreeState(hostId);
    const updated: HostTreeState = { ...current, ...patch };
    const key = KEY_PREFIX + (hostId || DEFAULT_HOST_ID);
    localStorage.setItem(key, JSON.stringify(updated));
  } catch {
    /* private browsing, quota exceeded, or DOM-less test environment */
  }
}

export function clearHostTreeState(hostId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const key = KEY_PREFIX + (hostId || DEFAULT_HOST_ID);
    localStorage.removeItem(key);
  } catch {
    /* best effort only */
  }
}

// Helpers for ProjectList
export function loadProjectTreeState(hostId: string): {
  collapsed: Set<string>;
  collapsedSubagents: Set<string>;
  collapsedQueued: Set<string>;
  expandedDeleted: Set<string>;
  expandedChats: Set<string>;
} {
  const state = loadHostTreeState(hostId);
  return {
    collapsed: new Set(state.collapsedProjects ?? []),
    collapsedSubagents: new Set(state.collapsedSubagents ?? []),
    collapsedQueued: new Set(state.collapsedQueued ?? []),
    expandedDeleted: new Set(state.expandedDeleted ?? []),
    expandedChats: new Set(state.expandedChats ?? []),
  };
}

export function saveCollapsedProjects(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { collapsedProjects: Array.from(ids) });
}

export function saveCollapsedSubagents(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { collapsedSubagents: Array.from(ids) });
}

export function saveCollapsedQueued(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { collapsedQueued: Array.from(ids) });
}

export function saveExpandedDeleted(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { expandedDeleted: Array.from(ids) });
}

export function saveExpandedChats(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { expandedChats: Array.from(ids) });
}

// Helpers for ShellSection
export function loadShellCollapsed(hostId: string): boolean {
  const state = loadHostTreeState(hostId);
  return state.shellCollapsed ?? false;
}

export function saveShellCollapsed(hostId: string, collapsed: boolean): void {
  updateHostTreeState(hostId, { shellCollapsed: collapsed });
}

// Helpers for PocketAgentsSection
export function loadPocketAgentsTreeState(hostId: string): {
  collapsed: Set<string>;
  cronCollapsed: Set<string>;
} {
  const state = loadHostTreeState(hostId);
  return {
    collapsed: new Set(state.collapsedPocketAgents ?? []),
    cronCollapsed: new Set(state.collapsedPocketAgentCron ?? []),
  };
}

export function saveCollapsedPocketAgents(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { collapsedPocketAgents: Array.from(ids) });
}

export function saveCollapsedPocketAgentCron(hostId: string, ids: Iterable<string>): void {
  updateHostTreeState(hostId, { collapsedPocketAgentCron: Array.from(ids) });
}
