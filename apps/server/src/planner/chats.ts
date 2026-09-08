import crypto from 'node:crypto';
import type {
  AgentEvent,
  PlannerChat,
  PlannerContextPreviewResponse,
  PlannerMemory,
  PlannerToolApprovalChoice,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionHistoryDeps } from '../sessions/history.js';
import type { WorktreeService } from '../git/worktree.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';
import {
  deletePlannerChat,
  insertPlannerChat,
  readDisabledToolNames,
  readGlobalDisabledToolNames,
  readPlannerChat,
  readPlannerChatMemoryFoldedTurns,
  readPlannerChats,
  readPlannerSettings,
  resolvePlannerUrlFetchApiKey,
  resolvePlannerWebSearchApiKey,
  revealPlannerApiKey,
  updatePlannerChat,
  writePlannerChatMemoryFoldedTurns,
  writePlannerLastModelId,
} from './store.js';
import { resolveApprovalStatus, rememberDecisionIfAsked } from './approval.js';
import { appendTranscriptEvent, readTranscriptEvents } from './transcript.js';
import {
  PlannerLlmClient,
  PlannerLlmError,
  type PlannerChatMessage,
  type PlannerLlmCompletion,
  type PlannerLlmToolCall,
  type PlannerLlmUsage,
} from './llm-client.js';
import { PLANNER_TOOLS, findPlannerTool, toOpenAiToolSpecs, type PlannerToolDefinition } from './tools.js';

export class PlannerChatError extends Error {
  override readonly name = 'PlannerChatError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'not_configured',
  ) {
    super(message);
  }
}

/** A runaway tool-call loop is a new failure mode this codebase hasn't had to
    guard against before — the Claude Agent SDK owns its own loop internally,
    so nothing here has ever needed a backstop like this one. Counted across
    the whole turn, including any iterations spent before/after a pause for
    approval. */
const MAX_TOOL_ITERATIONS = 8;

const GIVE_UP_MESSAGE =
  'I made too many tool calls without reaching an answer — try narrowing your request, ' +
  'or ask me to summarize what I found so far.';

/**
 * PA-29: how many of a chat's most recent turns (one `user_prompt` and
 * everything up to the next one) are sent to the LLM as-is. Anything older
 * is folded into a single short-term memory the first time it falls out of
 * this window, rather than silently discarded — see
 * `PlannerChatService.applyRollingWindow`. 20 turns is generous enough that
 * an ordinary conversation never hits this at all, while still bounding a
 * long-running chat's request body and the model's own context window
 * without needing a token counter (a per-turn cap is a much simpler safety
 * net than tracking token budgets across an arbitrary mix of tool calls and
 * replies).
 */
const ROLLING_WINDOW_TURNS = 20;

/**
 * How many of a workspace's memories are ranked against the current
 * conversation and actually injected into the system message before a real
 * turn. Kept small deliberately: these are meant to be the handful of facts
 * most relevant right now, not a dump of everything remembered — a longer
 * list would compete with the conversation itself for the model's attention
 * and cost tokens on every single turn, not just the ones that need them.
 */
const MEMORY_INJECT_TOP_K = 5;

/**
 * How many candidates `GET .../context-preview` asks for, wider than
 * `MEMORY_INJECT_TOP_K` on purpose — the preview's whole point is showing a
 * human *which* memories almost made the cut, not just the ones that did.
 */
const MEMORY_PREVIEW_CANDIDATES = 20;

export interface PlannerChatServiceOptions {
  db: Db;
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  worktrees: WorktreeService;
  historyDeps: SessionHistoryDeps;
  /** The configured shell binary, forwarded to `exec_command`. */
  shell: string;
  /** PA-29: the memory service, threaded to `memory_save`/`memory_search`
      (via `executeTool`) and to the rolling-window fold and pre-turn
      ranking below. */
  memory: PlannerMemoryService;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
  /** PA-31: injected in tests so `web_search`/`url_fetch` never make a real
      network call either — distinct from `llmFetch` above, which is only
      ever handed to `PlannerLlmClient`, not to `PlannerToolDeps`. */
  toolFetch?: typeof fetch;
  /** Injected in tests to control exactly which tools are offered. Defaults to `PLANNER_TOOLS`. */
  tools?: readonly PlannerToolDefinition[];
}

/**
 * State for a turn parked on an unanswered mutating-tool approval. Held only
 * in memory — like `StructuredSession`'s own pending-permission map, this
 * does not survive a server restart (see `PlannerChatHistoryResponse`'s doc
 * comment in the protocol package). Deliberately thin: `messages` is never
 * stored here — `driveLoop` always rebuilds the LLM message list fresh from
 * the persisted transcript (`eventsToLlmMessages`), so resuming a paused
 * batch only needs to remember *which* call is still waiting and where in
 * the tool-iteration budget the turn was.
 */
interface PendingPlannerTurn {
  chatId: string;
  workspaceId: string | null;
  modelId: string;
  toolCalls: PlannerLlmToolCall[];
  /** Index into `toolCalls` of the call awaiting a decision. */
  index: number;
  iteration: number;
  /** Accumulated so far — see `PlannerTurnStats`'s own doc comment for why
      this has to survive the pause/resume boundary rather than restart at
      zero when a batch resumes. */
  stats: PlannerTurnStats;
}

/**
 * Running per-turn stats for the settings-page-adjacent "small text after
 * each turn" ask: tokens/sec, total input/output tokens, and (via
 * `TurnCompleteEvent.completedAt`) a timestamp. Threaded through every stage
 * of the loop — `driveLoop`, `processToolCalls`, and across an approval
 * pause via `PendingPlannerTurn.stats` — because a turn can involve several
 * LLM round trips (once per tool-call batch), and the totals shown at the
 * end have to cover the whole turn, not just its last round trip.
 *
 * `elapsedMs` only ever accumulates time spent actually waiting on the LLM
 * (`driveLoop`'s `streamComplete` call) — never tool execution time, and
 * never an approval pause (a human deciding is not the agent "working",
 * and its duration is arbitrary and would swamp everything else). Tokens
 * stay `null` until a provider actually returns a `usage` block (not every
 * OpenAI-compatible implementation honors `stream_options.include_usage`),
 * so a footer can tell "never reported" from "reported zero".
 */
interface PlannerTurnStats {
  elapsedMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

const EMPTY_TURN_STATS: PlannerTurnStats = { elapsedMs: 0, inputTokens: null, outputTokens: null };

/** Reused rather than allocating a fresh empty `Set` per call for an
    orphaned chat's `toolsFor` — see that method's doc comment. */
const EMPTY_DISABLED_SET: ReadonlySet<string> = new Set();

/** Folds one LLM call's usage (if the provider sent one) into the running
    total — accumulates rather than replaces, since a turn's tokens are the
    sum across every round trip it took. */
function addUsage(stats: PlannerTurnStats, usage: PlannerLlmUsage | null): PlannerTurnStats {
  if (!usage) return stats;
  return {
    ...stats,
    inputTokens: (stats.inputTokens ?? 0) + usage.promptTokens,
    outputTokens: (stats.outputTokens ?? 0) + usage.completionTokens,
  };
}

/**
 * PA-6: planner chat CRUD and the turn loop.
 *
 * The loop is now a streaming one: `sendMessage`/`resolveApproval` are async
 * generators that `yield` one `AgentEvent` at a time — the same union a
 * structured session's own event stream produces — as each step of the turn
 * happens, rather than computing the whole turn and returning one JSON blob
 * at the end. Every yielded event is also persisted to the transcript file
 * immediately, in the same order, so the chat's history *is* the event log a
 * later `history()` call replays. See `routes/planner.ts` for how these
 * events reach the browser (an SSE response) and `llm-client.ts`'s doc
 * comment for exactly what "streaming" does and does not mean here.
 *
 * Read-only tools still execute the moment they're called, no gate. A
 * mutating tool without a remembered decision or yolo still pauses the turn
 * — `PendingPlannerTurn` — and is resumed by a second call
 * (`resolveApproval`), the same architecture phase 4 introduced; only the
 * transport carrying each step to the browser changed.
 */
export class PlannerChatService {
  private readonly tools: readonly PlannerToolDefinition[];
  private readonly pendingTurns = new Map<string, PendingPlannerTurn>();
  /**
   * PA-10: side-channel observers of one chat's persisted events, keyed by
   * chat id.
   *
   * A chat turn is a *pull*-based generator: nothing happens unless someone
   * drains it, and whoever drains it is the only one who sees the events. That
   * is exactly right for a browser, and exactly wrong for an inbound webhook,
   * because of the approval pause. A webhook-started turn that parks on
   * `permission_request` ends that leg of the generator; when a human later
   * answers in the Pocket Agent UI, the continuation is driven by
   * `resolveApproval` streaming to *their* browser, and the webhook's own
   * `RunSink` would never learn the run finished — the delivery row would sit
   * in `running` forever, holding a concurrency slot.
   *
   * So the sink observes the chat instead of only draining its own generator,
   * which is the direct analogue of `RunExecutor.watch` listening to
   * `session.on('event')` rather than to whoever called `prompt()`. Notified
   * from `emit`, the single choke point every persisted event already goes
   * through, so no future event kind can bypass it.
   *
   * In memory, single-process, and deliberately not durable: a restart closes
   * out open deliveries via `markStaleWebhookDeliveriesFailed` anyway, the same
   * fate `pendingTurns` and a live session's listeners already share.
   */
  private readonly observers = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(private readonly opts: PlannerChatServiceOptions) {
    this.tools = opts.tools ?? PLANNER_TOOLS;
  }

  /**
   * Watch one chat's events regardless of who is driving the turn. Returns the
   * unsubscribe function.
   *
   * A listener must not throw — one bad observer must not break the turn that
   * is merely notifying it — so `notify` swallows and logs instead.
   */
  observe(chatId: string, listener: (event: AgentEvent) => void): () => void {
    const set = this.observers.get(chatId) ?? new Set();
    set.add(listener);
    this.observers.set(chatId, set);
    return () => {
      const current = this.observers.get(chatId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.observers.delete(chatId);
    };
  }

  private notify(chatId: string, event: AgentEvent): void {
    const set = this.observers.get(chatId);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (err) {
        this.opts.logger?.warn({ err, chatId }, 'planner chat observer threw');
      }
    }
  }

  list(workspaceId?: string): PlannerChat[] {
    return readPlannerChats(this.opts.db, workspaceId);
  }

  get(id: string): PlannerChat | null {
    return readPlannerChat(this.opts.db, id);
  }

  create(input: {
    workspaceId?: string;
    title?: string;
    modelId?: string;
    /**
     * PA-10: pre-approve this chat's mutating tool calls. Only an unattended
     * trigger that already carries its own skip-permissions decision passes
     * this — `CreatePlannerChatRequest` has no such field, so no HTTP client
     * can. See `PlannerChat.skipToolApprovalsEnabled`.
     */
    skipToolApprovals?: boolean;
  }): PlannerChat {
    const workspace = input.workspaceId
      ? this.opts.plannerWorkspaces.get(input.workspaceId)
      : this.opts.plannerWorkspaces.getDefault();
    if (!workspace) {
      throw new PlannerChatError('Planner workspace not found.', 'not_found');
    }
    const now = Date.now();
    const chat: PlannerChat = {
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      title: input.title ?? null,
      // An explicit request wins, then this agent's own configured default
      // (PA-6 round 4), then the last model used anywhere.
      lastModelId: input.modelId ?? workspace.defaultModelId ?? readPlannerSettings(this.opts.db).lastModelId,
      createdAt: now,
      lastActivityAt: now,
      skipToolApprovalsEnabled: input.skipToolApprovals === true,
    };
    insertPlannerChat(this.opts.db, chat);
    return chat;
  }

  rename(id: string, title: string | null): PlannerChat {
    const chat = this.requireChat(id);
    updatePlannerChat(this.opts.db, id, { title });
    return { ...chat, title };
  }

  setModel(id: string, modelId: string): PlannerChat {
    this.requireChat(id);
    updatePlannerChat(this.opts.db, id, { lastModelId: modelId });
    return this.requireChat(id);
  }

  remove(id: string): boolean {
    // A removed chat's pending approvals (if any) can never be resolved —
    // dropped here rather than left to leak for the life of the process.
    for (const [pendingId, pending] of this.pendingTurns) {
      if (pending.chatId === id) this.pendingTurns.delete(pendingId);
    }
    // Same reasoning for observers (PA-10): a deleted chat will never emit
    // again, so a webhook sink still watching it would leak for the life of
    // the process. It has already been settled by its own run — the delivery
    // row is closed out either by `turn_complete` or, if the chat was deleted
    // mid-turn, by the sweep at the next restart.
    this.observers.delete(id);
    return deletePlannerChat(this.opts.db, id);
  }

  /**
   * PA-35: bulk counterpart to `remove`, for the Pocket Agents section's
   * "..." menu — mirrors `ProjectMenu`'s "Clear N finished chats". A planner
   * chat has no `live` field anywhere (its turn streams over a one-way SSE
   * response rather than a long-lived process `SessionManager` could report
   * as busy), so unlike the project side's clear-finished, which excludes
   * live rows, "finished" and "every chat in this workspace" are the same set
   * here — this removes all of them and returns the count for the caller to
   * report back.
   */
  removeAllForWorkspace(workspaceId: string): number {
    let removed = 0;
    for (const chat of this.list(workspaceId)) {
      if (this.remove(chat.id)) removed += 1;
    }
    return removed;
  }

  async history(id: string): Promise<AgentEvent[]> {
    const chat = this.requireChat(id);
    return readTranscriptEvents(this.workspacePathFor(chat), chat.id);
  }

  /**
   * PA-29: a read-only "as if a turn were about to run" view of the memory
   * ranking and rolling-window trimming `driveLoop` would apply right now —
   * for `GET /api/planner/chats/:id/context-preview`. Must never call the
   * LLM, write a memory, or bump a `last_accessed_at` (`memory.search`'s own
   * `dryRun: true` is what keeps the last one from happening) — a human
   * merely looking at this must not itself change what a real turn later
   * sees.
   *
   * Ranks a wider candidate set than a real turn ever asks for
   * (`MEMORY_PREVIEW_CANDIDATES` vs. `MEMORY_INJECT_TOP_K`), so the panel can
   * show near-misses too, not just the ones that would actually be
   * injected — `selected` marks exactly the top `MEMORY_INJECT_TOP_K` of
   * that wider list, which is the same set `driveLoop`'s own narrower call
   * would produce as long as the true top-K sits within the wider pool (see
   * `PlannerMemoryService.search`'s own candidate-widening comment for why
   * that is true in every case that matters in practice).
   */
  async previewContext(id: string): Promise<PlannerContextPreviewResponse> {
    const chat = this.requireChat(id);
    const workspacePath = this.workspacePathFor(chat);
    const events = await readTranscriptEvents(workspacePath, chat.id);
    const turns = splitIntoTurns(events);
    const keepFrom = Math.max(0, turns.length - ROLLING_WINDOW_TURNS);
    const inWindowMessages = turns.slice(keepFrom).flat().length;
    const foldedMessages = turns.slice(0, keepFrom).flat().length;

    const memoryEnabled = this.memoryEnabledFor(chat.workspaceId);
    let candidates: PlannerContextPreviewResponse['candidates'] = [];
    if (memoryEnabled && chat.workspaceId) {
      const queryText = lastUserPromptText(events);
      const results = await this.opts.memory.search(chat.workspaceId, queryText, {
        limit: MEMORY_PREVIEW_CANDIDATES,
        dryRun: true,
      });
      candidates = results.map((r, index) => ({
        memory: r.memory,
        score: r.score,
        selected: index < MEMORY_INJECT_TOP_K,
      }));
    }

    return {
      memoryEnabled,
      candidates,
      window: { inWindowMessages, foldedMessages, windowLimit: ROLLING_WINDOW_TURNS },
    };
  }

  /** Builds a client against the one configured provider — every caller that
      needs to talk to it (the turn loop, model discovery, the test button)
      shares this so `llmFetch` injection and the base-url/api-key lookup
      never drift between them. Throws `not_configured` if no endpoint is
      set, same as `resolveModelId`. */
  private llmClient(): PlannerLlmClient {
    const settings = readPlannerSettings(this.opts.db);
    if (!settings.baseUrl) {
      throw new PlannerChatError('Planner LLM endpoint is not configured.', 'not_configured');
    }
    return new PlannerLlmClient({
      baseUrl: settings.baseUrl,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });
  }

  /** For the settings page's "query models" button — see `listModels`'s doc
      comment. Never touches the model catalog itself; the caller decides
      what to do with the ids. */
  async discoverModels(): Promise<string[]> {
    return this.llmClient().listModels();
  }

  /**
   * Tools available to a given agent right now: the injected/global catalog
   * minus whatever is disabled at either of two layers (PA-6 round 5) — see
   * `PlannerAgentToolInfo`'s doc comment for why each is a deny-list, not an
   * allow-list. The global layer (`readGlobalDisabledToolNames`) applies
   * regardless of `workspaceId`, including `null` (an orphaned chat whose
   * workspace was since deleted) — a global switch has no agent identity to
   * be scoped by. The per-agent layer only applies when `workspaceId` is
   * present; an orphaned chat has no agent left to restrict it further, the
   * same reasoning `workspacePathFor` already falls back on for its
   * transcript directory.
   */
  private toolsFor(workspaceId: string | null): readonly PlannerToolDefinition[] {
    const globalDisabled = readGlobalDisabledToolNames(this.opts.db);
    const agentDisabled = workspaceId ? readDisabledToolNames(this.opts.db, workspaceId) : EMPTY_DISABLED_SET;
    if (globalDisabled.size === 0 && agentDisabled.size === 0) return this.tools;
    return this.tools.filter((t) => !globalDisabled.has(t.name) && !agentDisabled.has(t.name));
  }

  /**
   * Looks a tool up by name *and* confirms it's actually enabled for this
   * agent right now — refused the same way an unknown tool name already is,
   * whether the model still names a tool that was disabled after the
   * conversation started, or a paused approval's tool was disabled while it
   * sat waiting for a human. Defense in depth: `driveLoop` already excludes
   * a disabled tool from what's offered to the model at all, so this should
   * rarely trigger, but the model choosing to call something is not this
   * server's decision to trust unchecked.
   */
  private resolveEnabledTool(workspaceId: string | null, name: string): PlannerToolDefinition | undefined {
    return this.toolsFor(workspaceId).find((t) => t.name === name);
  }

  /** Distinguishes three outcomes for the same "a tool call can't run"
      moment: a name that doesn't exist in the catalog at all, one that's
      off globally (PA-6 round 5), and one that's merely restricted for this
      one agent — so a genuinely unknown name, an operator-wide switch, and a
      per-agent restriction never read as the same failure to whoever's
      watching the transcript. */
  private toolUnavailableMessage(workspaceId: string | null, name: string): string {
    if (!findPlannerTool(name)) return `Unknown tool: ${name}`;
    if (readGlobalDisabledToolNames(this.opts.db).has(name)) return `Tool "${name}" is disabled globally.`;
    return `Tool "${name}" is disabled for this agent.`;
  }

  /**
   * For the settings page's "test" / "test all" buttons: round-trips one
   * minimal prompt through `modelId` to confirm the endpoint and model id
   * actually work. Deliberately swallows `PlannerLlmError` into `ok: false`
   * rather than throwing — a failed test is the expected, common outcome of
   * clicking this button (a typo'd model id, a rate limit), not a server
   * error, so the route can always answer 200 with a verdict.
   */
  async testModel(modelId: string): Promise<{ ok: boolean; message: string; latencyMs: number }> {
    const client = this.llmClient();
    const startedAt = Date.now();
    try {
      let content: string | null = null;
      for await (const chunk of client.streamComplete(modelId, [
        { role: 'user', content: 'Reply with exactly one word: ok' },
      ])) {
        if (chunk.type === 'done') content = chunk.content;
      }
      return {
        ok: true,
        message: content ? content.trim().slice(0, 200) : '(empty reply)',
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      return { ok: false, message, latencyMs: Date.now() - startedAt };
    }
  }

  /**
   * Start a turn: append+yield `user_prompt`, then drive the loop until it
   * finishes (`turn_complete`) or pauses on an unapproved mutating tool call
   * (`permission_request`, with no matching `permission_resolved` yet).
   *
   * Validates synchronously, before the first `yield` — no provider base URL
   * or no model to use throws `PlannerChatError('not_configured')` — so the
   * route can still answer a clean HTTP error status for these instead of
   * having to fold them into the event stream: nothing has been written to
   * the response yet at that point.
   *
   * Auto-titles an untitled chat from this prompt (PA-6 round 6: "all chat
   * currently is 'untitled chat', after first prompt, agent should find a
   * suitable name") — checked before persisting anything else, so it only
   * ever fires once per chat, on whichever message first has usable text
   * (an all-whitespace one leaves `title` `null` and this tries again next
   * time). This never blocks on the LLM: `deriveChatTitle` is the same
   * "first non-empty line, truncated" heuristic `conversations/index.ts`'s
   * own `fallbackTitle` uses for a coding-agent session with no external
   * title-generating process — minus that function's Jira-webhook-specific
   * parsing, which doesn't apply to a prompt a human typed directly into a
   * chat. A user can always override it — see `rename`.
   */
  async *sendMessage(
    id: string,
    content: string,
    opts: { modelId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent> {
    const chat = this.requireChat(id);
    const modelId = this.resolveModelId(chat, opts.modelId);
    const workspacePath = this.workspacePathFor(chat);

    if (chat.title === null) {
      const title = deriveChatTitle(content);
      if (title) updatePlannerChat(this.opts.db, chat.id, { title });
    }

    const userEvent: AgentEvent = { kind: 'user_prompt', id: crypto.randomUUID(), text: content };
    await appendTranscriptEvent(workspacePath, chat.id, userEvent);
    yield userEvent;

    yield* this.driveLoop(chat, workspacePath, modelId, 0, EMPTY_TURN_STATS, opts.signal);
  }

  /**
   * Resolve a paused turn's approval and continue it — possibly pausing
   * again on a *different* tool call in the same batch, possibly finishing.
   *
   * Throws `PlannerChatError('not_found')` (before any `yield`, same
   * reasoning as `sendMessage`) if the approval id is unknown — already
   * resolved, or lost to a server restart, per this feature's own documented
   * limitation.
   */
  async *resolveApproval(
    chatId: string,
    approvalId: string,
    choice: PlannerToolApprovalChoice,
  ): AsyncGenerator<AgentEvent> {
    const pending = this.pendingTurns.get(approvalId);
    if (!pending || pending.chatId !== chatId) {
      throw new PlannerChatError('No pending approval with that id for this chat.', 'not_found');
    }
    this.pendingTurns.delete(approvalId);
    const chat = this.requireChat(chatId);
    const workspacePath = this.workspacePathFor(chat);
    const call = pending.toolCalls[pending.index]!;
    const tool = this.resolveEnabledTool(pending.workspaceId, call.function.name);

    if (choice !== 'allow_once') {
      rememberDecisionIfAsked(this.opts.db, choice, call.function.name, pending.workspaceId);
    }

    if (choice === 'deny' || !tool) {
      yield* this.emit(workspacePath, chat.id, {
        kind: 'permission_resolved',
        id: approvalId,
        decision: 'deny',
        message: null,
      });
      yield* this.emit(workspacePath, chat.id, {
        kind: 'tool_result',
        id: crypto.randomUUID(),
        toolUseId: call.id,
        content: choice === 'deny' ? 'Denied by the user.' : this.toolUnavailableMessage(pending.workspaceId, call.function.name),
        truncated: false,
        isError: true,
      });
    } else {
      yield* this.emit(workspacePath, chat.id, {
        kind: 'permission_resolved',
        id: approvalId,
        // `PermissionDecision` has no `allow_workspace`/`allow_global` of its
        // own (that finer grain is a planner-only concept the shared union
        // does not need) — the reducer only ever reads `decision === 'deny'`
        // to flip a tool card's `denied` flag, so collapsing every allow
        // variant to `'allow'` here is lossless for rendering. `message`
        // carries the scope for a human reading the raw event.
        decision: 'allow',
        message: scopeMessage(choice),
      });
      const resultText = await this.executeTool(tool, call.function.arguments, chat);
      yield* this.emit(workspacePath, chat.id, {
        kind: 'tool_result',
        id: crypto.randomUUID(),
        toolUseId: call.id,
        content: resultText,
        truncated: false,
        isError: false,
      });
    }

    yield* this.processToolCalls(
      chat,
      workspacePath,
      pending.modelId,
      pending.toolCalls,
      pending.index + 1,
      pending.iteration,
      pending.stats,
    );
  }

  /** Persist then yield — every event this service produces goes through here, so the two never drift apart. */
  private async *emit(workspacePath: string, chatId: string, event: AgentEvent): AsyncGenerator<AgentEvent> {
    await appendTranscriptEvent(workspacePath, chatId, event);
    this.notify(chatId, event);
    yield event;
  }

  /** Ends a turn: emits the final `text` (or nothing, if `text` is empty) and `turn_complete`, and updates the chat row. */
  private async *finishTurn(
    chat: PlannerChat,
    workspacePath: string,
    modelId: string,
    text: string,
    isError: boolean,
    stats: PlannerTurnStats,
  ): AsyncGenerator<AgentEvent> {
    if (text.length > 0) {
      yield* this.emit(workspacePath, chat.id, { kind: 'text', id: crypto.randomUUID(), text });
    }
    yield* this.emit(workspacePath, chat.id, {
      kind: 'turn_complete',
      stopReason: isError ? 'error' : 'end_turn',
      isError,
      numTurns: null,
      durationMs: stats.elapsedMs,
      costUsd: null,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      completedAt: Date.now(),
    });
    updatePlannerChat(this.opts.db, chat.id, { lastModelId: modelId, lastActivityAt: Date.now() });
    writePlannerLastModelId(this.opts.db, modelId);
  }

  /**
   * Calls the LLM with the transcript rebuilt fresh from disk (always —
   * never a `messages` array threaded through calls, so a resumed-after-pause
   * turn and a fresh one share exactly one code path for "what does the model
   * see"), then either finishes the turn or hands off to `processToolCalls`.
   *
   * Streams the reply token-by-token — `PlannerLlmClient.streamComplete`'s
   * `text_delta` events are re-yielded here as `AgentEvent`s but never
   * persisted (`this.emit` is deliberately not used for them): only the fully
   * assembled `text` survives to the transcript once the model finishes, the
   * same "deltas are transport, not history" split a structured session's own
   * JSONL transcript already relies on. A partial tool call is not
   * executable, so tool-call chunks are accumulated inside the client and
   * never surface here until the whole call is known.
   *
   * Never throws past the first `yield` of the *containing* `sendMessage`
   * call: an LLM failure here becomes an in-band error (`finishTurn` with
   * `isError: true`), not a rejected promise — once SSE headers are sent
   * (which happens after `sendMessage`'s first `user_prompt` yield), the
   * route can no longer change the HTTP status, so every failure from this
   * point on has to be representable as an event instead.
   *
   * PA-29: before building `messages`, the raw transcript is (a) trimmed to
   * `ROLLING_WINDOW_TURNS` via `applyRollingWindow` — folding anything older
   * into a memory the first time it falls out, never twice — and (b) if
   * this workspace has memory enabled, prepended with a system message
   * carrying the top `MEMORY_INJECT_TOP_K` memories ranked against the
   * conversation's own recent text. Both steps are skipped (window trimming
   * excepted — see `applyRollingWindow`'s own doc comment) when this
   * workspace's `memoryEnabled` is off, or when the chat has no workspace at
   * all (an orphaned chat has no agent's memory to read from or write into).
   */
  private async *driveLoop(
    chat: PlannerChat,
    workspacePath: string,
    modelId: string,
    iteration: number,
    stats: PlannerTurnStats,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (iteration >= MAX_TOOL_ITERATIONS) {
      yield* this.finishTurn(chat, workspacePath, modelId, GIVE_UP_MESSAGE, true, stats);
      return;
    }

    const settings = readPlannerSettings(this.opts.db);
    const events = await readTranscriptEvents(workspacePath, chat.id);
    const memoryEnabled = this.memoryEnabledFor(chat.workspaceId);
    const windowedEvents = await this.applyRollingWindow(chat, events, memoryEnabled);
    const messages = eventsToLlmMessages(windowedEvents);
    if (memoryEnabled && chat.workspaceId) {
      const queryText = lastUserPromptText(events);
      const results = await this.opts.memory.search(chat.workspaceId, queryText, { limit: MEMORY_INJECT_TOP_K });
      if (results.length > 0) {
        messages.unshift({ role: 'system', content: buildMemorySystemMessage(results.map((r) => r.memory)) });
      }
    }
    const client = new PlannerLlmClient({
      baseUrl: settings.baseUrl!,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });

    const textBlockId = crypto.randomUUID();
    let completion: PlannerLlmCompletion | null = null;
    // `elapsedMs` only ever covers this — the LLM actually generating a
    // reply — never tool execution or an approval pause; see
    // `PlannerTurnStats`'s doc comment for why.
    const llmStartedAt = Date.now();
    try {
      for await (const chunk of client.streamComplete(modelId, messages, toOpenAiToolSpecs(this.toolsFor(chat.workspaceId)), signal)) {
        if (chunk.type === 'text_delta') {
          yield { kind: 'text_delta', id: textBlockId, text: chunk.text };
        } else {
          completion = chunk;
        }
      }
    } catch (err) {
      this.opts.logger?.warn({ err, chat: chat.id, model: modelId }, 'planner LLM call failed');
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      const failedStats = { ...stats, elapsedMs: stats.elapsedMs + (Date.now() - llmStartedAt) };
      yield* this.finishTurn(chat, workspacePath, modelId, `Could not reach the LLM endpoint: ${message}`, true, failedStats);
      return;
    }
    const nextStats = addUsage(
      { ...stats, elapsedMs: stats.elapsedMs + (Date.now() - llmStartedAt) },
      completion?.usage ?? null,
    );

    if (!completion) {
      // Should not happen — `streamComplete` always yields exactly one
      // `done` event or throws — but a stream that somehow ends without
      // either must not leave the turn hanging forever.
      yield* this.finishTurn(
        chat,
        workspacePath,
        modelId,
        'The LLM endpoint closed the connection without a response.',
        true,
        nextStats,
      );
      return;
    }

    if (completion.toolCalls.length === 0) {
      yield* this.finishTurn(chat, workspacePath, modelId, completion.content ?? '', false, nextStats);
      return;
    }

    for (const call of completion.toolCalls) {
      const args = safeParseArgs(call.function.arguments);
      yield* this.emit(workspacePath, chat.id, {
        kind: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: args,
        summary: summarizeToolCall(call.function.name, args),
        filePath: extractFilePath(args),
      });
    }

    yield* this.processToolCalls(chat, workspacePath, modelId, completion.toolCalls, 0, iteration + 1, nextStats);
  }

  /**
   * Executes (or pauses on) each tool call in `toolCalls` from `startIndex`
   * onward. Read-only tools and remembered/yolo'd mutating ones run
   * immediately; a mutating one with no decision pauses the turn right there
   * — `pendingTurns` remembers only *where*, since `driveLoop` re-derives
   * everything else from the transcript once resumed.
   */
  private async *processToolCalls(
    chat: PlannerChat,
    workspacePath: string,
    modelId: string,
    toolCalls: PlannerLlmToolCall[],
    startIndex: number,
    iteration: number,
    stats: PlannerTurnStats,
  ): AsyncGenerator<AgentEvent> {
    for (let index = startIndex; index < toolCalls.length; index++) {
      const call = toolCalls[index]!;
      const tool = this.resolveEnabledTool(chat.workspaceId, call.function.name);

      if (!tool) {
        yield* this.emit(workspacePath, chat.id, {
          kind: 'tool_result',
          id: crypto.randomUUID(),
          toolUseId: call.id,
          content: this.toolUnavailableMessage(chat.workspaceId, call.function.name),
          truncated: false,
          isError: true,
        });
        continue;
      }

      if (!tool.readOnly) {
        const decision = resolveApprovalStatus(
          this.opts.db,
          tool.name,
          chat.workspaceId,
          chat.skipToolApprovalsEnabled,
        );
        if (decision === null) {
          const approvalId = crypto.randomUUID();
          this.pendingTurns.set(approvalId, {
            chatId: chat.id,
            workspaceId: chat.workspaceId,
            modelId,
            toolCalls,
            index,
            iteration,
            stats,
          });
          const args = safeParseArgs(call.function.arguments);
          yield* this.emit(workspacePath, chat.id, {
            kind: 'permission_request',
            id: approvalId,
            toolName: tool.name,
            input: args,
            title: `Run ${tool.name}`,
            displayName: null,
            filePath: extractFilePath(args),
            reason: null,
            canAllowForSession: false,
            questions: null,
          });
          return; // paused — the rest of this batch waits for `resolveApproval`
        }
        if (decision === 'deny') {
          yield* this.emit(workspacePath, chat.id, {
            kind: 'tool_result',
            id: crypto.randomUUID(),
            toolUseId: call.id,
            content: 'Denied by a remembered decision.',
            truncated: false,
            isError: true,
          });
          continue;
        }
        // decision === 'allow': fall through and execute below.
      }

      const resultText = await this.executeTool(tool, call.function.arguments, chat);
      yield* this.emit(workspacePath, chat.id, {
        kind: 'tool_result',
        id: crypto.randomUUID(),
        toolUseId: call.id,
        content: resultText,
        truncated: false,
        isError: false,
      });
    }

    // Every call in this batch resolved — ask the model what's next.
    yield* this.driveLoop(chat, workspacePath, modelId, iteration, stats, undefined);
  }

  private async executeTool(tool: PlannerToolDefinition, rawArguments: string, chat: PlannerChat): Promise<string> {
    const args = safeParseArgs(rawArguments);
    // PA-31: read fresh on every call, like `resolveModelId`'s own
    // `readPlannerSettings` above — a provider toggled or rekeyed in
    // Settings must take effect on the very next tool call.
    const settings = readPlannerSettings(this.opts.db);
    try {
      return await tool.execute(
        {
          workspaces: this.opts.workspaces,
          plannerWorkspaces: this.opts.plannerWorkspaces,
          sessions: this.opts.sessions,
          worktrees: this.opts.worktrees,
          historyDeps: this.opts.historyDeps,
          shell: this.opts.shell,
          memory: this.opts.memory,
          workspaceId: chat.workspaceId,
          webSearch: {
            enabled: settings.webSearchEnabled,
            baseUrl: settings.webSearchBaseUrl,
            apiKey: resolvePlannerWebSearchApiKey(this.opts.db),
          },
          urlFetch: {
            enabled: settings.urlFetchEnabled,
            baseUrl: settings.urlFetchBaseUrl,
            apiKey: resolvePlannerUrlFetchApiKey(this.opts.db),
          },
          ...(this.opts.toolFetch ? { fetchImpl: this.opts.toolFetch } : {}),
        },
        args,
      );
    } catch (err) {
      this.opts.logger?.warn({ err, tool: tool.name, chat: chat.id }, 'planner tool execution failed');
      return `Error running tool "${tool.name}": ${(err as Error).message}`;
    }
  }

  private resolveModelId(chat: PlannerChat, requested: string | undefined): string {
    const settings = readPlannerSettings(this.opts.db);
    if (!settings.baseUrl) {
      throw new PlannerChatError('Planner LLM endpoint is not configured.', 'not_configured');
    }
    const modelId = requested ?? chat.lastModelId ?? settings.lastModelId;
    if (!modelId) {
      throw new PlannerChatError('No model selected, and none is configured.', 'not_configured');
    }
    return modelId;
  }

  private requireChat(id: string): PlannerChat {
    const chat = this.get(id);
    if (!chat) throw new PlannerChatError('Chat not found.', 'not_found');
    return chat;
  }

  /**
   * The directory a chat's transcript lives in. Falls back to the default
   * planner workspace when the chat's own workspace was since deleted — the
   * chat row itself survives that deletion (`workspace_id` is `ON DELETE SET
   * NULL`), but a transcript file still needs a real directory to append to,
   * and the default workspace is guaranteed to exist (it refuses removal).
   */
  private workspacePathFor(chat: PlannerChat): string {
    const workspace = chat.workspaceId ? this.opts.plannerWorkspaces.get(chat.workspaceId) : undefined;
    if (workspace) return workspace.path;
    const fallback = this.opts.plannerWorkspaces.getDefault();
    if (!fallback) {
      throw new PlannerChatError('No planner workspace is available.', 'not_found');
    }
    return fallback.path;
  }

  /** `false` for an orphaned chat (`workspaceId === null`) as well as for a
      real agent with the setting off — both mean "no agent's memory to read
      from or write into right now". */
  private memoryEnabledFor(workspaceId: string | null): boolean {
    if (!workspaceId) return false;
    return this.opts.plannerWorkspaces.get(workspaceId)?.memoryEnabled ?? false;
  }

  /**
   * Caps `events` to the most recent `ROLLING_WINDOW_TURNS` turns for what
   * the LLM is shown this call, folding any turn that falls out of the
   * window *for the first time* into one short-term memory before dropping
   * it — never re-folding a span already folded by an earlier call, tracked
   * via `planner_chats.memory_folded_turns` (see that column's own doc
   * comment in `db/index.ts` for why a persisted marker is necessary at
   * all: the transcript file is append-only and re-read in full every turn,
   * so without it every turn past the window would re-summarize the same
   * growing prefix of old turns into a fresh, duplicate memory row).
   *
   * The fold-into-memory half is skipped when `memoryEnabled` is false or
   * the chat has no workspace — there is no agent's memory to write into —
   * but the truncation itself still runs regardless: a very long chat still
   * needs its request body and the model's context bounded even with
   * memory turned off, and turns that scroll out of the window while memory
   * is off are simply not recoverable later the way a fold would have made
   * them (the marker still advances past them either way, so re-enabling
   * memory later does not try to retroactively fold turns nothing kept a
   * copy of).
   */
  private async applyRollingWindow(
    chat: PlannerChat,
    events: readonly AgentEvent[],
    memoryEnabled: boolean,
  ): Promise<readonly AgentEvent[]> {
    const turns = splitIntoTurns(events);
    const keepFrom = turns.length - ROLLING_WINDOW_TURNS;
    if (keepFrom <= 0) return events;

    const alreadyFolded = readPlannerChatMemoryFoldedTurns(this.opts.db, chat.id);
    if (keepFrom > alreadyFolded) {
      const newlyEvicted = turns.slice(alreadyFolded, keepFrom);
      if (memoryEnabled && chat.workspaceId && newlyEvicted.length > 0) {
        await this.opts.memory.save(chat.workspaceId, summarizeFoldedTurns(newlyEvicted), 3, chat.id);
      }
      writePlannerChatMemoryFoldedTurns(this.opts.db, chat.id, keepFrom);
    }
    return turns.slice(keepFrom).flat();
  }
}


/** Best-effort title from a chat's first prompt: the first non-empty line,
    truncated to 80 characters — see `sendMessage`'s doc comment for why this
    mirrors, rather than reuses, `conversations/index.ts`'s own
    `fallbackTitle`. Returns `null` for a prompt with no usable text (e.g.
    all whitespace), leaving the chat to try again on its next message. */
function deriveChatTitle(firstPrompt: string): string | null {
  const firstLine = firstPrompt
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return null;
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

function scopeMessage(choice: PlannerToolApprovalChoice): string | null {
  switch (choice) {
    case 'allow_workspace':
      return 'Remembered: always allow for this workspace.';
    case 'allow_global':
      return 'Remembered: always allow everywhere.';
    default:
      return null;
  }
}

function safeParseArgs(rawArguments: string): Record<string, unknown> {
  if (!rawArguments) return {};
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Best-effort one-line summary for a `tool_use` event, matching `AgentEvent.summary`'s
    doc comment ("e.g. `Read hello.txt`") closely enough without per-tool special-casing. */
function summarizeToolCall(name: string, args: Record<string, unknown>): string {
  const entries = Object.entries(args).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const preview = entries.join(', ');
  const full = preview.length > 0 ? `${name}(${preview})` : `${name}()`;
  return full.length > 200 ? `${full.slice(0, 200)}…` : full;
}

function extractFilePath(args: Record<string, unknown>): string | null {
  return typeof args.path === 'string' ? args.path : null;
}

/**
 * Rebuilds the OpenAI-style message list a `/chat/completions` call needs
 * from a chat's persisted `AgentEvent[]`, so the LLM always sees the exact
 * same history a human reopening the chat would see rendered.
 *
 * Only ever runs over *completed* turns (an in-progress, paused turn's state
 * lives in `PendingPlannerTurn`, never in the persisted file until it
 * resolves) — so every `tool_use` here is guaranteed a matching `tool_result`
 * somewhere later in the stream, possibly with `permission_request`/
 * `permission_resolved` interleaved between them (skipped here; they carry
 * nothing the LLM's own message format has room for). Consecutive `tool_use`
 * events are grouped into one assistant message with a `tool_calls` array —
 * matching however many calls one real completion actually returned in a
 * single response — followed by one `tool`-role message per call.
 */
function eventsToLlmMessages(events: readonly AgentEvent[]): PlannerChatMessage[] {
  const messages: PlannerChatMessage[] = [];
  let pendingCalls: PlannerLlmToolCall[] | null = null;
  const resultsById = new Map<string, string>();

  const flushPendingCalls = (): void => {
    if (!pendingCalls) return;
    const calls = pendingCalls;
    pendingCalls = null;
    messages.push({ role: 'assistant', content: null, tool_calls: calls });
    for (const call of calls) {
      messages.push({ role: 'tool', tool_call_id: call.id, content: resultsById.get(call.id) ?? '' });
    }
  };

  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
        flushPendingCalls();
        messages.push({ role: 'user', content: event.text });
        break;
      case 'text':
        flushPendingCalls();
        messages.push({ role: 'assistant', content: event.text });
        break;
      case 'tool_use':
        (pendingCalls ??= []).push({
          id: event.id,
          type: 'function',
          function: { name: event.name, arguments: JSON.stringify(event.input) },
        });
        break;
      case 'tool_result':
        resultsById.set(event.toolUseId, event.content);
        break;
      default:
        // `notice`, `turn_complete`, `permission_request`, `permission_resolved`,
        // and everything else this union carries for a structured session are
        // not part of an LLM's own message format.
        break;
    }
  }
  flushPendingCalls();
  return messages;
}

/**
 * PA-29: splits a chat's persisted events into turns, each starting at a
 * `user_prompt` (inclusive) and running up to, but not including, the next
 * one — the unit `ROLLING_WINDOW_TURNS` counts in. Any events before the
 * first `user_prompt` (should not normally happen — every turn starts with
 * one) form a synthetic leading turn so nothing is ever silently dropped
 * from consideration by this split alone.
 */
function splitIntoTurns(events: readonly AgentEvent[]): AgentEvent[][] {
  const turns: AgentEvent[][] = [];
  let current: AgentEvent[] = [];
  for (const event of events) {
    if (event.kind === 'user_prompt') {
      if (current.length > 0) turns.push(current);
      current = [event];
    } else {
      current.push(event);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

/**
 * The cheap, no-LLM-call heuristic the approved design asks for: the first
 * line of the oldest evicted turn's own prompt, which tool names were used
 * across the whole folded span, and the last assistant reply in it — three
 * facts a human skimming this memory later would want, without a second
 * network round trip on every turn that happens to cross the window.
 */
function summarizeFoldedTurns(turns: readonly AgentEvent[][]): string {
  const flat = turns.flat();
  const firstPrompt = flat.find((e) => e.kind === 'user_prompt');
  const toolNames = [...new Set(flat.filter((e) => e.kind === 'tool_use').map((e) => e.name))];
  const lastReply = [...flat].reverse().find((e) => e.kind === 'text');

  const parts: string[] = [];
  if (firstPrompt) {
    const firstLine = firstPrompt.text.split('\n').find((line) => line.trim().length > 0) ?? firstPrompt.text;
    parts.push(`Discussed: ${firstLine.trim().slice(0, 200)}`);
  }
  if (toolNames.length > 0) parts.push(`Tools used: ${toolNames.join(', ')}`);
  if (lastReply) parts.push(`Outcome: ${lastReply.text.trim().slice(0, 300)}`);
  return parts.length > 0
    ? parts.join(' | ')
    : '(an earlier part of this conversation, with no summarizable content)';
}

/** The most recent thing the user actually typed — what pre-turn memory
    ranking searches against, since it is the clearest signal of what this
    turn is about (clearer than the model's own last reply, which may just
    be restating or asking a follow-up). `''` if the transcript somehow has
    no `user_prompt` yet (should not happen once `sendMessage` has appended
    one), and an empty query simply ranks nothing — see
    `PlannerMemoryService.search`'s own handling of that. */
function lastUserPromptText(events: readonly AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'user_prompt') return event.text;
  }
  return '';
}

/** The system message a real turn prepends when memory injection has any
    hits — plain enough that any OpenAI-compatible model reads it as
    background context rather than an instruction to follow literally. */
function buildMemorySystemMessage(memories: readonly PlannerMemory[]): string {
  const lines = memories.map((m) => `- ${m.content}`);
  return `Relevant memories from earlier conversations with this agent:\n${lines.join('\n')}`;
}
