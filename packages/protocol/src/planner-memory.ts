import { z } from 'zod';

/**
 * PA-29: a memory system so a Pocket Agent doesn't forget things
 * within/between conversations. Split into its own file rather than folded
 * into `planner.ts` for the same reason `webhook-template.ts` sits beside
 * `webhooks.ts` rather than inside it — this schema has its own reason to
 * exist (a settings UI, a context-preview route) independent of the chat
 * schema that already fills `planner.ts`, and a fresh file makes that
 * boundary visible rather than implicit.
 *
 * A memory row's two tiers: `'short'` is folded automatically out of a
 * chat's own rolling window as old turns are evicted from what the LLM sees
 * (`PlannerChatService`'s `eventsToLlmMessages`), tagged with the chat it
 * came from. `'long'` is written directly by `MemoryConsolidationService`
 * (PA-29 phase 3, `apps/server/src/planner/memory-consolidation.ts`) — a
 * background pass that periodically folds a workspace's short-term memories
 * (plus its chats' own recent transcript content) into durable facts.
 * `PlannerWorkspace.lastConsolidatedAt` records when that pass last ran for
 * a given agent. Both tiers share one table and one scoring function
 * (`score()` in `apps/server/src/planner/memory.ts`) — "one function, two
 * call sites" per the approved design, so eviction and search relevance can
 * never silently diverge on what "worth keeping" means.
 */
export const PlannerMemoryTier = z.enum(['short', 'long']);
export type PlannerMemoryTier = z.infer<typeof PlannerMemoryTier>;

export const PlannerMemory = z.object({
  id: z.string(),
  workspaceId: z.string(),
  tier: PlannerMemoryTier,
  content: z.string(),
  /** 1 (trivial) to 5 (critical) — feeds `score()` alongside recency. */
  importance: z.number().int().min(1).max(5),
  /** The chat this memory was folded out of or saved from, if any — not a
      foreign key on the server side (a chat can be deleted long after), so
      this can point at nothing and that is fine; see the migration's own
      doc comment in `db/index.ts`. */
  sourceChatId: z.string().nullable(),
  createdAt: z.number().int(),
  lastAccessedAt: z.number().int(),
});
export type PlannerMemory = z.infer<typeof PlannerMemory>;

export const PlannerMemoryListResponse = z.object({
  memories: z.array(PlannerMemory),
});
export type PlannerMemoryListResponse = z.infer<typeof PlannerMemoryListResponse>;

export const UpdatePlannerMemoryRequest = z.object({
  content: z.string().min(1).max(20_000).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});
export type UpdatePlannerMemoryRequest = z.infer<typeof UpdatePlannerMemoryRequest>;

/**
 * One memory considered for a chat's *next* turn, with the score it was
 * ranked by — `GET /api/planner/chats/:id/context-preview`'s own read-only
 * view of the same ranking `driveLoop` runs for real before every turn,
 * minus the side effects: a preview must never bump `last_accessed_at` the
 * way an actual injection does, so this and the live path share the scoring
 * function but not the "this counts as a use" bookkeeping around it (see
 * `PlannerMemoryService.search`'s `dryRun` option).
 */
export const PlannerMemoryPreviewEntry = z.object({
  memory: PlannerMemory,
  score: z.number(),
  /** Whether this row made the top-K actually injected into the system message. */
  selected: z.boolean(),
});
export type PlannerMemoryPreviewEntry = z.infer<typeof PlannerMemoryPreviewEntry>;

/**
 * Rolling-window bookkeeping for the same preview: how many of the chat's
 * persisted transcript messages would be sent to the LLM as-is versus have
 * already been folded into a `'short'` memory by a previous turn's eviction.
 * `foldedCount` is a count of *messages*, not memory rows, since one
 * eviction can fold several transcript events into a single memory.
 */
export const PlannerContextWindowStats = z.object({
  inWindowMessages: z.number().int(),
  foldedMessages: z.number().int(),
  windowLimit: z.number().int(),
});
export type PlannerContextWindowStats = z.infer<typeof PlannerContextWindowStats>;

export const PlannerContextPreviewResponse = z.object({
  memoryEnabled: z.boolean(),
  candidates: z.array(PlannerMemoryPreviewEntry),
  window: PlannerContextWindowStats,
});
export type PlannerContextPreviewResponse = z.infer<typeof PlannerContextPreviewResponse>;
