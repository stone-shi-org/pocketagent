/**
 * Prompt history storage for chat inputs (PA-119).
 *
 * Persisted in `localStorage` so previous commands survive page reloads and tab closures:
 * - Planner agent: global across all planner chats (`pocketagent:prompt-history:planner`).
 * - Code agent: scoped per-workspace (`pocketagent:prompt-history:code:<workspaceRoot>`).
 *
 * Only human-entered prompts submitted through `PromptBox` are recorded here; automated
 * triggers, scheduled cron jobs, and inbound webhooks never touch this store.
 */

const PLANNER_HISTORY_KEY = 'pocketagent:prompt-history:planner';
const CODE_HISTORY_KEY_PREFIX = 'pocketagent:prompt-history:code:';
export const MAX_PROMPT_HISTORY_ENTRIES = 100;

// In-memory fallback if localStorage is disabled or throws (private browsing, SSR, unit tests).
const memoryHistory = new Map<string, string[]>();

/**
 * Normalizes a workspace or session directory to its base project workspace directory.
 * If the directory is inside `.worktrees/` (e.g. `/path/to/repo/.worktrees/feature-x`),
 * it rolls up to the main repo checkout `/path/to/repo` so all worktrees of a project
 * share the same command history.
 */
export function normalizeWorkspacePath(dir: string): string {
  const trimmed = dir.trim().replace(/[/\\]+$/, '');
  const marker = '/.worktrees/';
  const idx = trimmed.indexOf(marker);
  if (idx !== -1) {
    return trimmed.slice(0, idx);
  }
  const winMarker = '\\.worktrees\\';
  const winIdx = trimmed.indexOf(winMarker);
  if (winIdx !== -1) {
    return trimmed.slice(0, winIdx);
  }
  return trimmed;
}

/** Global history key for the planner agent. */
export function plannerPromptHistoryKey(): string {
  return PLANNER_HISTORY_KEY;
}

/** Workspace-scoped history key for code agents. */
export function codePromptHistoryKey(workspaceOrCwd?: string | null): string {
  if (!workspaceOrCwd || !workspaceOrCwd.trim()) {
    return `${CODE_HISTORY_KEY_PREFIX}default`;
  }
  return `${CODE_HISTORY_KEY_PREFIX}${normalizeWorkspacePath(workspaceOrCwd)}`;
}

/**
 * Retrieve saved prompt history for a given scope key, oldest first.
 */
export function getPromptHistory(key: string): string[] {
  if (!key) return [];
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      }
    }
  } catch {
    // localStorage disabled or JSON parse error — fall through to in-memory store
  }
  return memoryHistory.get(key)?.slice() ?? [];
}

/**
 * Appends a human-entered prompt to the history for a given scope key.
 * Removes any earlier duplicate of the same prompt, trims whitespace,
 * caps the history length, and persists to localStorage.
 * Returns the updated history array.
 */
export function appendPromptHistory(key: string, prompt: string): string[] {
  if (!key) return [];
  const trimmed = prompt.trim();
  if (!trimmed) return getPromptHistory(key);

  const existing = getPromptHistory(key);
  // De-duplicate (move to tail) and cap to MAX_PROMPT_HISTORY_ENTRIES
  const next = [...existing.filter((item) => item !== trimmed), trimmed];
  const clamped = next.length > MAX_PROMPT_HISTORY_ENTRIES ? next.slice(-MAX_PROMPT_HISTORY_ENTRIES) : next;

  memoryHistory.set(key, clamped);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(clamped));
    }
  } catch {
    /* private browsing / quota exceeded — best effort in memory */
  }

  return clamped;
}

/**
 * Clears prompt history for a given scope key (primarily for unit tests).
 */
export function clearPromptHistory(key: string): void {
  memoryHistory.delete(key);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(key);
    }
  } catch {
    /* best effort */
  }
}
