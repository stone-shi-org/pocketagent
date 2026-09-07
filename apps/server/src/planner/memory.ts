import crypto from 'node:crypto';
import type { PlannerMemory, PlannerMemoryTier } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import {
  decodeEmbedding,
  deletePlannerMemory,
  encodeEmbedding,
  insertPlannerMemory,
  readPlannerMemories,
  readPlannerMemoriesForTier,
  readPlannerMemory,
  searchPlannerMemoriesFts,
  touchPlannerMemoriesLastAccessed,
  updatePlannerMemory,
  updatePlannerMemoryEmbedding,
  type PlannerMemoryFtsHit,
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

/** Standard cosine similarity, `[-1, 1]`. `0` for a length mismatch (should
    not happen — both vectors come from the same `embedding_model`, checked
    by the caller before this is ever reached — but a defensive `0` is
    cheaper than a thrown error over a coding mistake this deep in a ranking
    formula) or for either vector being all-zero (a `0`-norm vector has no
    direction to compare). */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface PlannerMemoryScoredResult {
  memory: PlannerMemory;
  score: number;
}

/**
 * PA-29: the narrow surface `PlannerMemoryService` needs from an embedding
 * provider — deliberately an interface rather than the concrete
 * `PlannerLlmClient`, so a test can inject a plain fake object (`{ embed:
 * async () => ... }`) without needing to satisfy that class's private
 * fields, the same way `llmFetch` injection elsewhere in this codebase keeps
 * network access mockable. A real `PlannerLlmClient` instance already
 * satisfies this structurally — it has a public `embed` method with this
 * exact signature.
 */
export interface PlannerMemoryEmbedClient {
  embed(model: string, input: string[]): Promise<{ embeddings: number[][] }>;
}

export interface PlannerMemoryEmbedConfig {
  client: PlannerMemoryEmbedClient;
  modelId: string;
}

export interface PlannerMemoryServiceOptions {
  db: Db;
  /** Injectable for tests, so eviction/scoring behaviour is checkable without waiting on the real clock. */
  now?: () => number;
  /**
   * PA-29: the embedding provider, resolved by whoever constructs this
   * service (`apps/server/src/app.ts`, from `readPlannerSettings`) — `null`
   * or omitted when `embeddingBaseUrl`/`embeddingModelId` aren't both set,
   * which is the expected, common steady state, not an error condition
   * (exactly like an unconfigured chat LLM endpoint elsewhere in this
   * codebase). Every embedding-touching code path below (`save`, `search`)
   * must no-op cleanly — never throw — when this is absent. Resolved once at
   * construction rather than re-read live on every call (contrast
   * `PlannerChatService.llmClient`, which re-reads chat settings on every
   * turn): changing the embedding settings therefore only takes effect for
   * this service after a restart, a known limitation traded for not having
   * to thread a `Db` lookup through every `save`/`search` call — the
   * settings page's own "Test embeddings" button (`routes/planner.ts`)
   * builds its own client straight from current settings, independent of
   * this, so testing a change is never blocked on a restart, only *using*
   * it in a real turn is.
   */
  embed?: PlannerMemoryEmbedConfig | null;
  logger?: { warn: (obj: unknown, msg?: string) => void };
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
   * Insert a new memory, embed it (if an embedding provider is configured),
   * then enforce that tier's per-workspace budget by evicting the
   * lowest-scoring row(s) if this pushed it over the cap. `tier` defaults to
   * `'short'` — the rolling-window fold and `memory_save` both write
   * short-term rows; only `MemoryConsolidationService` (phase 3,
   * `planner/memory-consolidation.ts`) writes `'long'` directly.
   *
   * Async only because of the embedding step — every existing caller already
   * sits inside an `async` context (a tool's `execute`, an async generator's
   * turn loop, a consolidation pass), so awaiting this added nothing new to
   * any call site's own control flow.
   */
  async save(
    workspaceId: string,
    content: string,
    importance = 3,
    sourceChatId: string | null = null,
    tier: PlannerMemoryTier = 'short',
  ): Promise<PlannerMemory> {
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
    await this.embedIfConfigured(memory.id, content);
    this.enforceBudget(workspaceId, tier);
    return memory;
  }

  /**
   * Embeds one memory's content and stores the vector + the model it came
   * from — a no-op when no embedding provider is configured. **Never lets an
   * embedding failure fail the save**: caught and logged here, leaving
   * `embedding`/`embedding_model` `NULL` on this row (it simply doesn't
   * participate in the semantic half of ranking later; the memory itself is
   * already durably saved by the time this runs).
   */
  private async embedIfConfigured(memoryId: string, content: string): Promise<void> {
    const embed = this.opts.embed;
    if (!embed) return;
    try {
      const { embeddings } = await embed.client.embed(embed.modelId, [content]);
      const vector = embeddings[0];
      if (!vector) return;
      updatePlannerMemoryEmbedding(this.db, memoryId, encodeEmbedding(vector), embed.modelId);
    } catch (err) {
      this.opts.logger?.warn(
        { err, memoryId },
        'planner memory embedding failed at write time; memory saved without one',
      );
    }
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
   *
   * PA-29: when an embedding provider is configured, this additionally
   * embeds `queryText` (one call) and blends cosine similarity into each
   * candidate's textual relevance — see `relevanceFor`'s own doc comment for
   * exactly how. A query-embedding failure (provider down, misconfigured)
   * is caught and logged here, falling every candidate back to the
   * pre-existing lexical-only formula rather than failing the search itself
   * — and therefore the turn that's asking for it.
   */
  async search(
    workspaceId: string,
    queryText: string,
    opts: { tier?: PlannerMemoryTier; limit?: number; dryRun?: boolean } = {},
  ): Promise<PlannerMemoryScoredResult[]> {
    const limit = opts.limit ?? 5;
    // Pull a wider candidate set than `limit` from FTS5 (ordered by textual
    // relevance alone) before re-ranking with `score()` — a memory that is
    // the 30th-best textual match but by far the most important/freshest
    // should still be able to win the final cut.
    const candidateLimit = Math.max(limit * 6, 30);
    const hits = searchPlannerMemoriesFts(this.db, workspaceId, queryText, opts.tier, candidateLimit);
    const now = this.now();
    const queryVector = await this.embedQueryIfConfigured(queryText);

    const ranked = hits
      .map((hit) => ({ memory: hit.memory, score: this.relevanceFor(hit, queryVector, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (!opts.dryRun && ranked.length > 0) {
      touchPlannerMemoriesLastAccessed(this.db, ranked.map((r) => r.memory.id), now);
    }
    return ranked;
  }

  /** `null` when no embedding provider is configured, or when embedding the
      query itself fails — either way, `relevanceFor` treats every candidate
      as lexical-only, which is exactly this method's pre-existing behaviour
      before this feature. */
  private async embedQueryIfConfigured(queryText: string): Promise<number[] | null> {
    const embed = this.opts.embed;
    if (!embed) return null;
    try {
      const { embeddings } = await embed.client.embed(embed.modelId, [queryText]);
      return embeddings[0] ?? null;
    } catch (err) {
      this.opts.logger?.warn(
        { err },
        'planner memory query embedding failed; falling back to lexical-only ranking',
      );
      return null;
    }
  }

  /**
   * One candidate's final ranking number. `hit.bm25` is SQLite's own
   * convention (more negative is a better match); `-hit.bm25` flips that so
   * a larger number always means "more relevant" on both axes being
   * combined — unchanged from before this feature.
   *
   * When a query embedding is available *and* this row has one from the
   * *same* embedding model as the one configured right now (a mismatched or
   * missing `embedding_model` means the two vectors were never placed in a
   * comparable space — see the migration's own doc comment), the textual
   * half is first squashed into a bounded range with `x / (1 + abs(x))` — a
   * cheap monotonic normalization, not a rigorous statistic, whose only job
   * is keeping bm25's unbounded scale from swamping cosine similarity's own
   * `[-1, 1]` range — then blended 50/50 with cosine similarity, and *that*
   * blend is multiplied by `score()`, exactly the same way the lexical-only
   * formula already multiplies its own textual proxy by `score()`.
   *
   * A row with no usable embedding (not configured, the row predates this
   * feature, or `embedding_model` doesn't match) falls straight through to
   * that unchanged lexical-only formula — the regression path every
   * pre-existing test exercises.
   */
  private relevanceFor(
    hit: PlannerMemoryFtsHit,
    queryVector: number[] | null,
    now: number,
  ): number {
    const importanceRecency = score(hit.memory, now);
    const textual = -hit.bm25;
    const embed = this.opts.embed;
    if (queryVector && embed && hit.embedding && hit.embeddingModel === embed.modelId) {
      const cosine = cosineSimilarity(queryVector, decodeEmbedding(hit.embedding));
      const normalizedBm25 = textual / (1 + Math.abs(textual));
      return (0.5 * normalizedBm25 + 0.5 * cosine) * importanceRecency;
    }
    return textual * importanceRecency;
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
