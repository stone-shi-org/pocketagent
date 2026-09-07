import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SHORT_TERM_MEMORIES, MEMORY_RECENCY_HALF_LIFE_MS, PlannerMemoryService, score } from '../src/planner/memory.js';
import { decodeEmbedding, insertPlannerMemory } from '../src/planner/store.js';
import { findPlannerTool, type PlannerToolDeps } from '../src/planner/tools.js';
import { createTestApp, type TestApp } from './helpers.js';

/**
 * PA-29: the memory system. Exercised against a real `createTestApp()`
 * context (a real better-sqlite3 db, including FTS5) rather than a mock, the
 * same posture `planner-tools.test.ts` already takes for the rest of the
 * tool catalog.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function depsFor(t: TestApp, workspaceId: string | null): PlannerToolDeps {
  const { workspaces, plannerWorkspaces, sessions, worktrees, conversations, agyTranscripts, piTranscripts } =
    t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
    shell: t.context.config.shell,
    memory: t.context.plannerMemory,
    workspaceId,
  };
}

function embeddingRowFor(t: TestApp, id: string): { embedding: Buffer | null; embedding_model: string | null } {
  return t.db
    .prepare('SELECT embedding, embedding_model FROM planner_memories WHERE id = ?')
    .get(id) as { embedding: Buffer | null; embedding_model: string | null };
}

describe('score', () => {
  it('scales linearly with importance and halves once per half-life of inactivity', () => {
    const now = Date.now();
    expect(score({ importance: 4, lastAccessedAt: now }, now)).toBeCloseTo(4, 5);
    expect(score({ importance: 4, lastAccessedAt: now - MEMORY_RECENCY_HALF_LIFE_MS }, now)).toBeCloseTo(2, 5);
    expect(score({ importance: 4, lastAccessedAt: now - 2 * MEMORY_RECENCY_HALF_LIFE_MS }, now)).toBeCloseTo(1, 5);
  });

  it('never decays past zero for an arbitrarily old memory', () => {
    const now = Date.now();
    expect(score({ importance: 5, lastAccessedAt: now - 365 * DAY_MS }, now)).toBeGreaterThan(0);
  });
});

describe('PlannerMemoryService budget eviction', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('evicts the single lowest-scoring row when a save pushes a tier one over its cap', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const now = Date.now();

    // Fill the tier to exactly its cap: one deliberately worst-scoring row
    // (old *and* unimportant, so there is no ambiguity about which row a
    // correct implementation must pick) and the rest fresh, important ones.
    const victimId = randomUUID();
    insertPlannerMemory(t.db, {
      id: victimId,
      workspaceId,
      tier: 'short',
      content: 'a stale, unimportant note nobody has touched in a month',
      importance: 1,
      sourceChatId: null,
      createdAt: now - 30 * DAY_MS,
      lastAccessedAt: now - 30 * DAY_MS,
    });
    for (let i = 1; i < MAX_SHORT_TERM_MEMORIES; i++) {
      insertPlannerMemory(t.db, {
        id: randomUUID(),
        workspaceId,
        tier: 'short',
        content: `fresh important note ${i}`,
        importance: 5,
        sourceChatId: null,
        createdAt: now,
        lastAccessedAt: now,
      });
    }
    expect(t.context.plannerMemory.list(workspaceId, 'short')).toHaveLength(MAX_SHORT_TERM_MEMORIES);

    // One more save pushes the tier one row over its cap.
    await t.context.plannerMemory.save(workspaceId, 'the newest note', 5, null);

    const after = t.context.plannerMemory.list(workspaceId, 'short');
    expect(after).toHaveLength(MAX_SHORT_TERM_MEMORIES);
    expect(after.some((m) => m.id === victimId)).toBe(false);
    expect(after.some((m) => m.content === 'the newest note')).toBe(true);
  });

  it('does not evict anything below the cap', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.context.plannerMemory.save(workspaceId, 'first note', 1, null);
    await t.context.plannerMemory.save(workspaceId, 'second note', 1, null);
    expect(t.context.plannerMemory.list(workspaceId, 'short')).toHaveLength(2);
  });

  it('scopes the budget per workspace, not globally', async () => {
    t = await createTestApp();
    const defaultWs = t.context.plannerWorkspaces.getDefault()!.id;
    const otherWs = await t.context.plannerWorkspaces.create(t.context.plannerWorkspacesRoot, 'Other Agent');

    for (let i = 0; i < MAX_SHORT_TERM_MEMORIES; i++) {
      await t.context.plannerMemory.save(defaultWs, `default agent note ${i}`, 3, null);
    }
    await t.context.plannerMemory.save(otherWs.id, 'other agent note', 3, null);

    expect(t.context.plannerMemory.list(defaultWs, 'short')).toHaveLength(MAX_SHORT_TERM_MEMORIES);
    expect(t.context.plannerMemory.list(otherWs.id, 'short')).toHaveLength(1);
  });
});

describe('PlannerMemoryService.search', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('ranks a textual match above an unrelated memory', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.context.plannerMemory.save(workspaceId, 'The user prefers dark mode in the dashboard', 3, null);
    await t.context.plannerMemory.save(workspaceId, 'The user is allergic to peanuts', 3, null);

    const results = await t.context.plannerMemory.search(workspaceId, 'dashboard dark mode preference', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.content).toContain('dark mode');
  });

  it('combines textual relevance with importance/recency, not textual relevance alone', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const now = Date.now();
    // Two memories that match the query text equally well; only importance
    // and freshness differ, so the ranking can only come from `score()`.
    insertPlannerMemory(t.db, {
      id: randomUUID(),
      workspaceId,
      tier: 'short',
      content: 'deployment process uses blue-green releases',
      importance: 5,
      sourceChatId: null,
      createdAt: now,
      lastAccessedAt: now,
    });
    insertPlannerMemory(t.db, {
      id: randomUUID(),
      workspaceId,
      tier: 'short',
      content: 'deployment process uses blue-green releases as well',
      importance: 1,
      sourceChatId: null,
      createdAt: now - 30 * DAY_MS,
      lastAccessedAt: now - 30 * DAY_MS,
    });

    const results = await t.context.plannerMemory.search(workspaceId, 'deployment process blue-green', { limit: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]!.memory.importance).toBe(5);
  });

  it('filters by tier when asked', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.context.plannerMemory.save(workspaceId, 'short-term rollout note', 3, null, 'short');
    await t.context.plannerMemory.save(workspaceId, 'long-term rollout policy', 3, null, 'long');

    const shortOnly = await t.context.plannerMemory.search(workspaceId, 'rollout', { tier: 'short', limit: 5 });
    expect(shortOnly).toHaveLength(1);
    expect(shortOnly[0]!.memory.tier).toBe('short');
  });

  it('returns no results for a query with no usable tokens, rather than throwing', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.context.plannerMemory.save(workspaceId, 'a memory', 3, null);
    expect(await t.context.plannerMemory.search(workspaceId, '   ---   ', { limit: 5 })).toEqual([]);
  });

  it('bumps last_accessed_at on a real search, but never on a dry run', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const saved = await t.context.plannerMemory.save(workspaceId, 'remember the staging URL', 3, null);
    const before = saved.lastAccessedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));

    await t.context.plannerMemory.search(workspaceId, 'staging URL', { limit: 5, dryRun: true });
    expect(t.context.plannerMemory.get(saved.id)!.lastAccessedAt).toBe(before);

    await t.context.plannerMemory.search(workspaceId, 'staging URL', { limit: 5 });
    expect(t.context.plannerMemory.get(saved.id)!.lastAccessedAt).toBeGreaterThan(before);
  });
});

describe('memory_save and memory_search tools', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('are registered in the catalog with the right approval-gate posture', () => {
    expect(findPlannerTool('memory_save')!.readOnly).toBe(false);
    expect(findPlannerTool('memory_search')!.readOnly).toBe(true);
  });

  it('memory_save persists a memory that memory_search can then find', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const saveTool = findPlannerTool('memory_save')!;
    const saveResult = await saveTool.execute(depsFor(t, workspaceId), {
      content: 'the release process requires a signed tag',
      importance: 4,
    });
    expect(saveResult).toMatch(/Saved memory/);

    const searchTool = findPlannerTool('memory_search')!;
    const parsed = JSON.parse(
      await searchTool.execute(depsFor(t, workspaceId), { query: 'release process signed tag' }),
    ) as { content: string; importance: number }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.content).toContain('signed tag');
    expect(parsed[0]!.importance).toBe(4);
  });

  it('defaults importance to 3 and clamps an out-of-range value into 1-5', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const saveTool = findPlannerTool('memory_save')!;
    await saveTool.execute(depsFor(t, workspaceId), { content: 'no importance given' });
    await saveTool.execute(depsFor(t, workspaceId), { content: 'way too important', importance: 99 });

    const list = t.context.plannerMemory.list(workspaceId, 'short');
    expect(list.find((m) => m.content === 'no importance given')!.importance).toBe(3);
    expect(list.find((m) => m.content === 'way too important')!.importance).toBe(5);
  });

  it('memory_save reports empty content without saving anything', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const saveTool = findPlannerTool('memory_save')!;
    const result = await saveTool.execute(depsFor(t, workspaceId), { content: '   ' });
    expect(result).toMatch(/No memory content/);
    expect(t.context.plannerMemory.list(workspaceId, 'short')).toHaveLength(0);
  });

  it('memory_save and memory_search both refuse plainly for an orphaned chat (no workspace)', async () => {
    t = await createTestApp();
    const saveTool = findPlannerTool('memory_save')!;
    const searchTool = findPlannerTool('memory_search')!;
    expect(await saveTool.execute(depsFor(t, null), { content: 'orphaned' })).toMatch(/no agent to save/);
    expect(await searchTool.execute(depsFor(t, null), { query: 'anything' })).toMatch(/no agent to search/);
  });

  it('memory_search reports an empty list (not an error) for an unmatched query', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const searchTool = findPlannerTool('memory_search')!;
    const parsed = JSON.parse(await searchTool.execute(depsFor(t, workspaceId), { query: 'nonexistentword' }));
    expect(parsed).toEqual([]);
  });
});

/**
 * PA-29: embedding at write time and hybrid (lexical + semantic) ranking at
 * read time. A fresh `PlannerMemoryService` is constructed directly against
 * the same `t.db` for each of these (rather than using `t.context.plannerMemory`,
 * which `createTestApp()` always wires up with no embedding provider
 * configured) — the same "construct the service under test directly" posture
 * `planner-memory-consolidation.test.ts` already takes for its own service.
 * The embed "client" is always a plain fake object, never a real
 * `PlannerLlmClient`/`fetch` — see `PlannerMemoryEmbedClient`'s own doc
 * comment for why that structural interface is what makes this possible.
 */
describe('PlannerMemoryService embeddings', () => {
  let t: TestApp;
  afterEach(async () => {
    if (t) await t.cleanup();
  });

  it('stores an embedding and its model at save time when an embedding provider is configured', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const svc = new PlannerMemoryService({
      db: t.db,
      embed: { client: { embed: async () => ({ embeddings: [[1, 0, 0]] }) }, modelId: 'fake-embed-v1' },
    });

    const saved = await svc.save(workspaceId, 'a memory to embed', 3, null);

    const row = embeddingRowFor(t, saved.id);
    expect(row.embedding_model).toBe('fake-embed-v1');
    expect(row.embedding).not.toBeNull();
    expect(decodeEmbedding(row.embedding!)).toEqual([1, 0, 0]);
  });

  it('still saves the memory (with no embedding) when the embed call fails', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const logger = { warn: vi.fn() };
    const svc = new PlannerMemoryService({
      db: t.db,
      embed: {
        client: {
          embed: async () => {
            throw new Error('embedding endpoint is down');
          },
        },
        modelId: 'fake-embed-v1',
      },
      logger,
    });

    const saved = await svc.save(workspaceId, 'a memory whose embed call fails', 3, null);

    expect(svc.get(saved.id)).not.toBeNull();
    expect(svc.get(saved.id)!.content).toBe('a memory whose embed call fails');
    const row = embeddingRowFor(t, saved.id);
    expect(row.embedding).toBeNull();
    expect(row.embedding_model).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: saved.id }),
      expect.any(String),
    );
  });

  it('blends cosine similarity with bm25 when both an embedding config and matching-model embeddings exist', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    // Two memories with near-identical lexical overlap against the query
    // (same four words, one differing trailing word each) — bm25 alone
    // should barely distinguish them. Their embedding vectors point in
    // opposite directions, so only the semantic half of the blend can
    // explain a clear winner.
    const vectors: Record<string, number[]> = {
      'blue-green deployment rollout notes': [1, 0],
      'blue-green deployment rollout memo': [-1, 0],
      'blue-green deployment rollout': [1, 0],
    };
    const svc = new PlannerMemoryService({
      db: t.db,
      embed: {
        client: {
          embed: async (_model: string, input: string[]) => ({
            embeddings: input.map((text) => vectors[text] ?? [0, 0]),
          }),
        },
        modelId: 'fake-embed-v1',
      },
    });

    await svc.save(workspaceId, 'blue-green deployment rollout notes', 3, null);
    await svc.save(workspaceId, 'blue-green deployment rollout memo', 3, null);

    const results = await svc.search(workspaceId, 'blue-green deployment rollout', { limit: 5 });
    expect(results).toHaveLength(2);
    expect(results[0]!.memory.content).toBe('blue-green deployment rollout notes');
  });

  it('excludes a row whose embedding_model does not match the currently configured model from the semantic half of ranking', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    const svcOld = new PlannerMemoryService({
      db: t.db,
      embed: { client: { embed: async () => ({ embeddings: [[1, 0]] }) }, modelId: 'old-model' },
    });
    const saved = await svcOld.save(workspaceId, 'a note embedded under an old model', 3, null);
    expect(embeddingRowFor(t, saved.id).embedding_model).toBe('old-model');

    // A different service, standing in for "the operator changed the
    // embedding model" — this row's own `embedding_model` no longer matches,
    // so it must fall back to the pre-existing lexical-only formula rather
    // than comparing vectors from two unrelated models. It should still be
    // found (lexically) and must not throw.
    const svcNew = new PlannerMemoryService({
      db: t.db,
      embed: { client: { embed: async () => ({ embeddings: [[0, 1]] }) }, modelId: 'new-model' },
    });
    const results = await svcNew.search(workspaceId, 'a note embedded under an old model', { limit: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]!.memory.content).toBe('a note embedded under an old model');
  });

  it('falls back to the unchanged lexical-only formula when no embedding provider is configured at all', async () => {
    t = await createTestApp();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    // `t.context.plannerMemory` is the one `createTestApp()` always wires
    // with no embedding settings configured — this is the regression
    // coverage for every pre-existing `search` behaviour above.
    await t.context.plannerMemory.save(workspaceId, 'a plain lexical memory about deployments', 3, null);
    const results = await t.context.plannerMemory.search(workspaceId, 'plain lexical memory deployments', {
      limit: 5,
    });
    expect(results).toHaveLength(1);
  });
});
