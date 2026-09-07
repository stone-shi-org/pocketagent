import crypto from 'node:crypto';
import type { PlannerMemory, PlannerMemoryTier } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  deletePlannerMemory,
  insertPlannerMemory,
  readPlannerMemories,
  readPlannerMemoriesForTier,
  readPlannerMemory,
  searchPlannerMemoriesFts,
  touchPlannerMemoriesLastAccessed,
  updatePlannerMemory,
} from './store.js';

/**
 * PA-29: the memory system — short-term rows folded automatically out of a
 * chat's own rolling window (`PlannerChatService`) and long-term rows a
 * later consolidation pass writes directly (PA-29 phase 3, not implemented
 * here) — see `PlannerMemory`'s doc comment (protocol package) for the split.
 *
 * Everything here is per-workspace: a memory makes one agent sharper, and
 * nothing in this service ever reads or writes across a `workspaceId`
 * boundary. Budget caps, scoring, and search ranking are all workspace-scoped
 * for the same reason `planner_agent_disabled_tools` is — one agent's own
 * data, sized and ranked independently of every other agent's.
 */

/** Per-workspace cap on `tier: 'short'` rows. Chosen so a chat's own rolling
    window (20 turns, `ROLLING_WINDOW_TURNS` in `chats.ts`) can fold for a
    long time before this ever bites — 200 short-term memories is roughly
    the entire useful lifetime of a single agent's working memory before
    consolidation (phase 3) would fold the durable parts into `'long'`
    anyway. */
export const MAX_SHORT_TERM_MEMORIES = 200;

/** Per-workspace cap on `tier: 'long'` rows — larger than the short-term cap
    because a long-term memory survived a consolidation pass's own judgment
    of "worth keeping", so this tier should empty out far more slowly. */
export const MAX_LONG_TERM_MEMORIES = 500;

/**
 * How fast an unaccessed memory's recency weight decays. 3 days: short
 * enough that memories from an idle project genuinely fade within a couple
 * of weeks (so a stale short-term note stops out-competing a fresher one
 * for the same budget slot or search rank), long enough that a memory
 * touched even once every few days never meaningfully decays — this is a
 * *working* memory's half-life, not a "delete after N days" TTL; nothing
 * here ever expires a row on time alone, only on relative score during a
 * budget eviction.
 */
export const MEMORY_RECENCY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Combines importance (1-5, chosen at write time) with an exponential decay
 * of how long it's been since this memory was last accessed (touched by a
 * search hit or, implicitly, at creation). Exported so eviction (pick the
 * lowest score in a full tier) and search ranking (weight a textual match by
 * how important/fresh it is) are provably the same notion of "worth keeping"
 * rather than two definitions that can drift — the approved design's "one
 * function, two call sites" requirement.
 */
export function score(memory: { importance: number; lastAccessedAt: number }, now: number): number {
  const ageMs = Math.max(0, now - memory.lastAccessedAt);
  const decay = Math.pow(0.5, ageMs / MEMORY_RECENCY_HALF_LIFE_MS);
  return memory.importance * decay;
}

export interface PlannerMemoryScoredResult {
  memory: PlannerMemory;
  score: number;
}

export interface PlannerMemoryServiceOptions {
  db: Db;
  /** Injectable for tests, so eviction/scoring behaviour is checkable without waiting on the real clock. */
  now?: () => number;
}

export class PlannerMemoryService {
  private readonly db: Db;

  constructor(private readonly opts: PlannerMemoryServiceOptions) {
    this.db = opts.db;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /**
   * Insert a new memory, then enforce that tier's per-workspace budget by
   * evicting the lowest-scoring row(s) if this pushed it over the cap.
   * `tier` defaults to `'short'` — the rolling-window fold and `memory_save`
   * both write short-term rows; only a future consolidation pass (phase 3)
   * writes `'long'` directly.
   */
  save(
    workspaceId: string,
    content: string,
    importance = 3,
    sourceChatId: string | null = null,
    tier: PlannerMemoryTier = 'short',
  ): PlannerMemory {
    const now = this.now();
    const memory: PlannerMemory = {
      id: crypto.randomUUID(),
      workspaceId,
      tier,
      content,
      importance,
      sourceChatId,
      createdAt: now,
      lastAccessedAt: now,
    };
    insertPlannerMemory(this.db, memory);
    this.enforceBudget(workspaceId, tier);
    return memory;
  }

  private enforceBudget(workspaceId: string, tier: PlannerMemoryTier): void {
    const cap = tier === 'short' ? MAX_SHORT_TERM_MEMORIES : MAX_LONG_TERM_MEMORIES;
    const rows = readPlannerMemoriesForTier(this.db, workspaceId, tier);
    const overflow = rows.length - cap;
    if (overflow <= 0) return;
    // Read-only ranking, never touching `last_accessed_at` — checking
    // whether a row is the *worst* one is not the same as a caller having
    // used it (see `search`'s own doc comment on the same distinction).
    const now = this.now();
    const worstFirst = [...rows].sort((a, b) => score(a, now) - score(b, now));
    for (const victim of worstFirst.slice(0, overflow)) {
      deletePlannerMemory(this.db, victim.id);
    }
  }

  /**
   * Rank this workspace's memories against `queryText` (typically the
   * current conversation's own recent text) and return the top `limit`,
   * highest-relevance first. Relevance is SQLite's own FTS5 `bm25()` for the
   * textual match, weighted by `score()` — a perfectly-matched but stale,
   * unimportant memory and a loosely-related but critical one both get a
   * fair hearing, per this feature's approved design.
   *
   * Bumps `last_accessed_at` on every row actually returned — but not on
   * `dryRun`, and never on a row only pulled into the FTS candidate set and
   * then cut before the final `limit` (see `GET .../context-preview`, which
   * needs to show the same ranking without the "using a memory refreshes
   * it" side effect a real turn's injection has).
   */
  search(
    workspaceId: string,
    queryText: string,
    opts: { tier?: PlannerMemoryTier; limit?: number; dryRun?: boolean } = {},
  ): PlannerMemoryScoredResult[] {
    const limit = opts.limit ?? 5;
    // Pull a wider candidate set than `limit` from FTS5 (ordered by textual
    // relevance alone) before re-ranking with `score()` — a memory that is
    // the 30th-best textual match but by far the most important/freshest
    // should still be able to win the final cut.
    const candidateLimit = Math.max(limit * 6, 30);
    const hits = searchPlannerMemoriesFts(this.db, workspaceId, queryText, opts.tier, candidateLimit);
    const now = this.now();
    // SQLite's bm25() is more negative for a better match; negate it so a
    // larger number always means "more relevant" on both axes being combined.
    const ranked = hits
      .map((hit) => ({ memory: hit.memory, score: -hit.bm25 * score(hit.memory, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (!opts.dryRun && ranked.length > 0) {
      touchPlannerMemoriesLastAccessed(this.db, ranked.map((r) => r.memory.id), now);
    }
    return ranked;
  }

  /** Plain listing for a settings UI (PA-29 phase 4) — most-recent-first, no scoring. */
  list(workspaceId: string, tier?: PlannerMemoryTier): PlannerMemory[] {
    return readPlannerMemories(this.db, workspaceId, tier);
  }

  get(id: string): PlannerMemory | null {
    return readPlannerMemory(this.db, id);
  }

  /** Hard delete — this feature's v1 has no soft-delete/undo need. */
  remove(id: string): boolean {
    return deletePlannerMemory(this.db, id);
  }

  update(id: string, patch: { content?: string; importance?: number }): PlannerMemory | null {
    updatePlannerMemory(this.db, id, patch);
    return this.get(id);
  }
}
