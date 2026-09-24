import crypto from 'node:crypto';
import {
  appendSpokenSummaryInstruction,
  stripSpokenSummary,
  stripSpokenSummaryInstruction,
  type AgentEvent,
  type GeminiLiveSeedTurn,
  type GeminiLiveToolCall,
  type GeminiLiveToolCallResult,
  type GeminiLiveTranscriptRequest,
  type PlannerChat,
  type PlannerContextPreviewResponse,
  type PlannerMemory,
  type PlannerSystemPromptSection,
  type PlannerToolApprovalChoice,
  type SessionInfo,
} from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import type { Config } from '../config/index.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionHistoryDeps } from '../sessions/history.js';
import type { WorktreeService } from '../git/worktree.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { CustomClaudeProviderStore } from '../agents/custom-providers-store.js';
import type { WebhookService } from '../webhooks/index.js';
import type { CronService } from '../cron/index.js';
import type { PlannerWorkspaceRegistry, PlannerWorkspaceRow } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';
import {
  deletePlannerChat,
  insertPlannerChat,
  readDisabledToolNames,
  readGlobalDisabledToolNames,
  readPlannerChat,
  readPlannerChatMemoryFoldedTurns,
  readPlannerChats,
  readPlannerChatsByParentId,
  readPlannerSettings,
  resolvePlannerUrlFetchApiKey,
  resolvePlannerWebSearchApiKey,
  revealPlannerApiKey,
  updatePlannerChat,
  writePlannerChatMemoryFoldedTurns,
  writePlannerLastModelId,
  type PlannerSettingsSnapshot,
} from './store.js';
import {
  CALL_MCP_TOOL_NAME,
  LIST_MCP_TOOLS_NAME,
  LIST_SKILLS_NAME,
  USE_SKILL_NAME,
  isTerminalStatus,
  type PromptImage,
} from '@pocketagent/protocol';
import { treeRootOf } from '../git/worktree-paths.js';
import { resolveApprovalStatus, rememberDecisionIfAsked } from './approval.js';
import { appendTranscriptEvent, clearTranscriptEvents, readTranscriptEvents } from './transcript.js';
import {
  PlannerLlmClient,
  PlannerLlmError,
  type PlannerChatMessage,
  type PlannerLlmCompletion,
  type PlannerLlmToolCall,
  type PlannerLlmUsage,
  type PlannerUserContentPart,
} from './llm-client.js';
import {
  MAX_SUBAGENT_SPAWN_DEPTH,
  MAX_SUBAGENT_SPAWNS_PER_TURN,
  PLANNER_TOOLS,
  findPlannerTool,
  lastMessageSummary,
  toOpenAiToolSpecs,
  type PlannerToolDefinition,
  type SubagentChatStatus,
} from './tools.js';
import { SubagentSupervisor, type MailboxMessage } from './supervisor.js';
import type { McpRegistryService } from './mcp/registry-service.js';
import type { SkillRegistryService } from './skills.js';
import type { TelegramBotStore } from '../telegram/bots-store.js';
import type { TelegramLinksStore } from '../telegram/links-store.js';
import { TelegramClient } from '../telegram/client.js';
import { estimateTokens } from './token-estimate.js';
import type { GeminiFunctionDeclaration } from './gemini-live.js';

export class PlannerChatError extends Error {
  override readonly name = 'PlannerChatError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'not_configured' | 'busy',
  ) {
    super(message);
  }
}

/** A runaway tool-call loop is a new failure mode this codebase hasn't had to
    guard against before — the Claude Agent SDK owns its own loop internally,
    so nothing here has ever needed a backstop like this one. Counted across
    the whole turn, including any iterations spent before/after a pause for
    approval. The cap itself is `PlannerSettingsSnapshot.maxToolIterations`
    (Settings page, "Tool safety" — default 20, was a hardcoded 8), read
    fresh every iteration alongside the rest of `settings` in `driveLoop`
    rather than cached on `this`, the same "read the flag live" discipline
    `plannerYoloEnabled` and `globalSkipPermissions` already use. */

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
  /** PA-56: `read_settings`/`update_settings`'s own view of the world — see
      `PlannerToolDeps.config`'s doc comment. */
  config: Config;
  /** PA-56: `read_settings`/`update_custom_claude_provider`'s store —
      constructed well before `plannerChats` in `app.ts` (unlike
      `webhooks`/`cron` below), so it is threaded through the constructor
      like every other dependency here rather than needing the same
      late-binding setter. */
  customClaudeProviders: CustomClaudeProviderStore;
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  worktrees: WorktreeService;
  historyDeps: SessionHistoryDeps;
  /** PA-44: threaded to `list_subagents`' coding-agent half. */
  agents: AgentRegistry;
  /** The configured shell binary, forwarded to `exec_command`. */
  shell: string;
  /** PA-29: the memory service, threaded to `memory_save`/`memory_search`
      (via `executeTool`) and to the rolling-window fold and pre-turn
      ranking below. */
  memory: PlannerMemoryService;
  /** PA-37: the MCP registry catalog/dispatcher `list_mcp_tools`/
      `call_mcp_tool` are built on, and what `toolsFor`/the dynamic
      approval-gating special case (`effectiveMcpToolIdentity`) both read. */
  mcpRegistry: McpRegistryService;
  /** PA-38: the skills catalog `list_skills`/`use_skill` are built on, and
      what `toolsFor`'s own omission rule reads — mirrors `mcpRegistry`
      exactly, one layer up. */
  skills: SkillRegistryService;
  /**
   * PA-53: `send_telegram_message`'s own view of the world, threaded the same
   * way `mcpRegistry`/`skills` are. Both optional — every existing test that
   * constructs a `PlannerChatService` directly and never touches Telegram
   * keeps compiling unchanged, and `executeTool` degrades to "no pairings, no
   * delivery" when either is absent rather than throwing.
   */
  telegramBots?: TelegramBotStore;
  telegramLinks?: TelegramLinksStore;
  logger?: {
    warn: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
  /** PA-31: injected in tests so `web_search`/`url_fetch` never make a real
      network call either — distinct from `llmFetch` above, which is only
      ever handed to `PlannerLlmClient`, not to `PlannerToolDeps`. */
  toolFetch?: typeof fetch;
  /** PA-53: injected in tests so `send_telegram_message` never makes a real
      network call either. */
  telegramFetch?: typeof fetch;
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
/**
 * One Pocket Agent turn a restart would destroy — see
 * `PlannerChatService.inFlightTurns` (PA-69).
 *
 * Deliberately not the protocol's own `DrainBlocker`: this service knows
 * nothing about drains, and shaping the wire type is `AdminService`'s job.
 */
export interface InFlightPlannerTurn {
  chatId: string;
  /** The chat's title, or something recognisable when it has none yet. */
  title: string;
  /** Which Pocket Agent it belongs to, when the chat still resolves. */
  workspaceName: string | null;
  reason: 'mid_turn' | 'awaiting_approval';
}

interface PendingPlannerTurn {
  kind: 'loop';
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
 * PA-96: one Gemini Live tool call parked on the approval gate. Unlike a
 * `PendingPlannerTurn` there is no LLM continuation to resume — Gemini holds
 * its own conversation, and was already answered with a holding message so no
 * synchronous tool response sits open across its ~10-minute socket. Resolving
 * this runs (or refuses) the one call and persists the result; the browser
 * relays that result to Gemini as ordinary conversation.
 *
 * Kept in the same `pendingTurns` map on purpose: PA-69's drain check, the
 * chat's `busy` flag and chat deletion all read that map, so a parked live
 * approval blocks a restart and is cleaned up with its chat with no second
 * code path to forget.
 */
interface PendingLiveToolCall {
  kind: 'live';
  chatId: string;
  workspaceId: string | null;
  call: PlannerLlmToolCall;
}

type PendingApproval = PendingPlannerTurn | PendingLiveToolCall;

/** What one tool call is allowed to do, decided once for both callers. */
type ToolGateDecision =
  | { kind: 'unavailable'; message: string }
  | { kind: 'denied' }
  | {
      kind: 'needs_approval';
      tool: PlannerToolDefinition;
      mcpIdentity: { name: string; displayName: string; readOnly: boolean } | null;
    }
  | { kind: 'run'; tool: PlannerToolDefinition };

/**
 * PA-96: what Gemini hears back, at once, for a call parked on approval. It
 * must never read as the tool having run — the whole point is that Gemini
 * keeps talking while the human decides, and says so, instead of either
 * holding a synchronous response open or inventing an outcome.
 */
export const LIVE_AWAITING_APPROVAL_MESSAGE =
  'Not run yet: this action is waiting for the user to approve or deny it on screen. ' +
  'Tell the user it is waiting for their approval on screen, and do not claim it has run. ' +
  'You will be sent the real result once they decide. You cannot approve it yourself, ' +
  'and the user saying yes out loud does not approve it.';

/**
 * PA-96: the live-mode rules, prepended to the persona in the Gemini session's
 * system instruction (which the ephemeral token locks, so the page cannot
 * swap it out).
 */
export const LIVE_MODE_SYSTEM_INSTRUCTION =
  'You are talking with the user by voice, in real time. Keep spoken replies short and ' +
  'conversational. Never read out code, file contents, long lists, paths or URLs verbatim: ' +
  'summarise them in a sentence. You can call the tools you have been given. Some tools change ' +
  'things and need the user to approve them on screen; if a tool result says it is waiting for ' +
  'approval, tell the user briefly and do not claim it ran. The real result arrives later as a ' +
  'message. You can never approve a tool yourself, and the user saying "yes" out loud is not an ' +
  'approval — only the on-screen button is.';

/** Caps what one tool result contributes to a live session's seed history. */
const LIVE_SEED_TOOL_RESULT_CHARS = 1500;
/** Caps the whole seed, oldest turns dropped first. */
const LIVE_SEED_MAX_CHARS = 60_000;
/**
 * PA-96: how long after its last sign of life a chat still counts as having a
 * Gemini Live session open, for deferring subagent wake turns. The browser
 * says so explicitly on the way out (`endLive`); this only bounds a tab that
 * vanished without saying goodbye.
 */
const LIVE_ACTIVITY_TTL_MS = 10 * 60 * 1000;

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
 * PA-76: Formats one or more queued mailbox messages into a single prompt that wakes
 * the parent chat. Coalesces multiple subagent completions into one turn.
 */
export function buildWakePrompt(messages: MailboxMessage[]): string {
  if (messages.length === 1) {
    const m = messages[0]!;
    if (m.kind === 'timer') {
      return `[Timer Notification]\n${m.summary} Check on subagents or wait again if still working.`;
    }
    const label = m.kind === 'coding_agent' ? 'Coding subagent' : 'Pocket agent subagent';
    return `[Subagent Notification]\n${label} "${m.subagentId}" has finished with status: ${m.status}.\n\nResult:\n${m.summary}`;
  }
  const countLine = messages.some((m) => m.kind === 'timer')
    ? `${messages.length} notifications queued:\n`
    : `${messages.length} subagents have finished:\n`;
  const lines: string[] = ['[Subagent Notifications]', countLine];
  for (const m of messages) {
    if (m.kind === 'timer') {
      lines.push(`- Timer (${m.status}): ${m.summary}\n`);
    } else {
      const label = m.kind === 'coding_agent' ? 'Coding subagent' : 'Pocket agent subagent';
      lines.push(`- ${label} "${m.subagentId}" (${m.status}):\n${m.summary}\n`);
    }
  }
  return lines.join('\n');
}

interface TurnPollRecord {
  lastCheckedAt: number;
  lastActivityAt: number | null;
  count: number;
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
  private readonly pendingTurns = new Map<string, PendingApproval>();
  /**
   * PA-96: Gemini Live work being done for a chat right now — bridged tool
   * calls and resolutions of parked live approvals. Also counted in
   * `activeTurns` (so PA-69's drain sees it), and counted separately here only
   * so `busyWithPlannerLoop` can tell "the planner LLM is mid-turn" from
   * "Gemini is running a tool", which must not refuse each other's follow-up
   * calls.
   */
  private readonly liveWork = new Map<string, number>();
  /** PA-96: per-chat serialisation of live bridge/transcript writes, so the
      JSONL keeps the order the browser reported things in even when two
      requests overlap. */
  private readonly liveQueues = new Map<string, Promise<unknown>>();
  /** PA-96: chats with a Gemini Live session believed open → last activity.
      See `LIVE_ACTIVITY_TTL_MS`. */
  private readonly liveSessions = new Map<string, number>();
  private readonly liveExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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

  /**
   * PA-44: how many Pocket-Agent-spawned-Pocket-Agent hops separate a chat
   * from a human — see `PlannerToolDeps.spawnDepth`'s doc comment for why
   * this exists at all. Absence means `0`, so every chat a human created
   * (the entire map, before this feature's first use) reads as depth zero
   * without needing a backfill. In-memory only, like `pendingTurns`/
   * `observers` above: after a restart nothing is mid-spawn anyway, and a
   * chat that already exists is unaffected either way — depth only ever
   * gates *starting a new* subagent chat, never resuming an old one.
   */
  private readonly spawnDepthByChat = new Map<string, number>();
  /**
   * PA-74: Coding-agent subagent sessions spawned by a chat, keyed by chat id.
   * Used to prevent duplicate agents in the same working tree and clean up on chat deletion.
   */
  private readonly subagentSessionsByChat = new Map<string, Set<string>>();
  /**
   * PA-74: Number of subagents (pocket or coding) spawned during the current turn,
   * keyed by chat id. Reset at the start of a turn and cleaned up on completion.
   */
  private readonly spawnsThisTurnByChat = new Map<string, number>();
  /**
   * PA-76: Active wake turns, keyed by chat id.
   */
  private readonly activeWakeTurns = new Set<string>();
  /**
   * PA-76: Mailbox of completed subagent outcomes waiting to wake the parent chat.
   */
  private readonly mailboxByChat = new Map<string, MailboxMessage[]>();
  /**
   * PA-76: Decrementing subagent action budget across wake-driven turns for a chat.
   */
  private readonly wakeActionBudgetByChat = new Map<string, number>();
  /**
   * PA-76: Retry timeouts for mailbox draining when wake turns fail.
   */
  private readonly drainRetryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * PA-76: Consecutive failed drain attempts by chat.
   */
  private readonly drainRetryAttempts = new Map<string, number>();
  /**
   * PA-76: Coordinates subagent completion and approval notifications.
   */
  private readonly supervisor: SubagentSupervisor;
  /**
   * PA-78: Non-blocking self-wake timers scheduled by check_back_in, keyed by chat id.
   */
  private readonly scheduledWakeTimersByChat = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  /**
   * PA-78: Timestamp when the current active turn started, keyed by chat id.
   */
  private readonly turnStartedAtByChat = new Map<string, number>();
  /**
   * PA-78: Per-turn poll check state for short-circuiting unchanged repeat calls (status and output).
   */
  private readonly turnPollChecksByChat = new Map<string, Map<string, TurnPollRecord>>();

  /**
   * PA-69: how many turns are being driven right now, per chat id.
   *
   * A Pocket Agent turn is invisible to `SessionManager.busySince` — it has no
   * session, no cwd and no worktree, which is exactly why the run queue
   * deliberately never keys on one — so a drain check that consulted only the
   * session manager would report "nothing is in the way" and then destroy a
   * turn mid-flight. For a webhook- or Telegram-driven chat there is nobody
   * watching to notice.
   *
   * A *count* rather than a boolean because nothing stops two `sendMessage`
   * calls overlapping on one chat, and a boolean would then be cleared by
   * whichever finished first.
   *
   * Incremented after the synchronous precondition checks and cleared in a
   * `finally`, so an in-flight failure releases it too. The one way to leak an
   * entry is a caller that abandons the generator without draining or closing
   * it; a `for await` loop that breaks or throws calls `.return()` and so runs
   * the `finally`. That error direction is the safe one on purpose: an
   * over-count refuses a restart that would have been clean, which `force`
   * escapes, while an under-count silently kills work.
   *
   * PA-76's single-turn-in-flight guard reads the same map through `isBusy`:
   * a chat is busy while it has any entry here, so the concurrency guard and
   * the drain check cannot disagree about what "a turn is running" means.
   */
  private readonly activeTurns = new Map<string, number>();

  /** Marks a turn as running; returns the release callback for a `finally`. */
  private beginTurn(chatId: string): () => void {
    this.activeTurns.set(chatId, (this.activeTurns.get(chatId) ?? 0) + 1);
    return () => {
      const remaining = (this.activeTurns.get(chatId) ?? 1) - 1;
      if (remaining > 0) this.activeTurns.set(chatId, remaining);
      else this.activeTurns.delete(chatId);
    };
  }

  /**
   * Turns that a restart would destroy, described well enough to name in a UI
   * (PA-69).
   *
   * Two sources, both genuinely in progress and neither recoverable across a
   * restart. `activeTurns` is a turn being driven right now. `pendingTurns` is
   * one parked on an unanswered approval, which counts for the same reason a
   * structured session parked on one still holds its working tree: it is
   * *genuinely still running*, and the standing rule is that an undecided
   * approval never decays. Here it is sharper than for a session — the pending
   * map is in-memory only, so a restart does not pause that turn and let a
   * human answer later, it loses the approval outright and the chat is stuck
   * mid-turn forever.
   *
   * A chat that is somehow in both states is reported once, as
   * `awaiting_approval`, because that is the one an operator can act on.
   */
  inFlightTurns(): InFlightPlannerTurn[] {
    const byChat = new Map<string, InFlightPlannerTurn>();
    const describe = (chatId: string, reason: 'mid_turn' | 'awaiting_approval'): void => {
      const chat = this.get(chatId);
      // A chat deleted mid-turn still has a turn to report, so fall back to
      // the id rather than dropping the blocker on the floor.
      byChat.set(chatId, {
        chatId,
        title: chat?.title ?? chat?.workspaceName ?? chatId,
        workspaceName: chat?.workspaceName ?? null,
        reason,
      });
    };
    for (const chatId of this.activeTurns.keys()) describe(chatId, 'mid_turn');
    // Second, so it wins for a chat that appears in both.
    for (const pending of this.pendingTurns.values()) describe(pending.chatId, 'awaiting_approval');
    return [...byChat.values()];
  }

  /**
   * PA-56: `webhooks`/`cron`, for `read_settings`/`update_webhook`/
   * `update_cron_job`. Unlike every other dependency on this class, these
   * cannot be threaded through the constructor: `app.ts` builds `cron` and
   * `webhooks` *after* `plannerChats` (each of them takes `plannerChats`
   * itself, to drive a Pocket Agent cron run / webhook delivery), so passing
   * them in the other direction would be a genuine constructor cycle.
   * `attachRunServices` below closes that one edge — `app.ts` calls it once,
   * synchronously, right after both exist and before the server accepts its
   * first request. Until then (and in any test that never calls it) `null`,
   * and the tools that need these degrade to a refusal rather than throwing —
   * the same "optional, and the tool checks before using" contract
   * `telegramBots`/`telegramLinks` already establish above.
   */
  private runServices: { webhooks: WebhookService; cron: CronService } | null = null;

  constructor(private readonly opts: PlannerChatServiceOptions) {
    this.tools = opts.tools ?? PLANNER_TOOLS;
    this.supervisor = new SubagentSupervisor({
      sessions: opts.sessions,
      historyDeps: opts.historyDeps,
      getPlannerChatHistory: (chatId) => this.history(chatId),
      observePlannerChat: (chatId, listener) => this.observe(chatId, listener),
      enqueueMailbox: (chatId, message) => this.enqueueMailbox(chatId, message),
      logger: opts.logger,
    });
  }

  dispose(): void {
    for (const timers of this.scheduledWakeTimersByChat.values()) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.scheduledWakeTimersByChat.clear();
    for (const timer of this.liveExpiryTimers.values()) clearTimeout(timer);
    this.liveExpiryTimers.clear();
    for (const timer of this.drainRetryTimeouts.values()) {
      clearTimeout(timer);
    }
    this.drainRetryTimeouts.clear();
    this.drainRetryAttempts.clear();
    this.turnPollChecksByChat.clear();
    this.supervisor.dispose();
  }

  /** See `runServices`'s own doc comment. */
  attachRunServices(services: { webhooks: WebhookService; cron: CronService }): void {
    this.runServices = services;
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

  private decorate(chat: PlannerChat): PlannerChat {
    return {
      ...chat,
      busy: this.isBusy(chat.id),
    };
  }

  /**
   * PA-76: Backs server-side running state signal for PlannerChat and composer.
   * True if an active turn is currently in-flight or waiting on an approval.
   */
  isBusy(chatId: string): boolean {
    if (this.activeTurns.has(chatId)) return true;
    for (const pending of this.pendingTurns.values()) {
      if (pending.chatId === chatId) return true;
    }
    return false;
  }

  private isWakeTurnActive(chatId: string): boolean {
    return this.activeWakeTurns.has(chatId);
  }

  /**
   * PA-76: Enqueues a completed subagent outcome to the parent chat's mailbox.
   * If the parent chat is currently idle, immediately drains the mailbox.
   */
  enqueueMailbox(chatId: string, message: MailboxMessage): void {
    const chat = readPlannerChat(this.opts.db, chatId);
    if (!chat) return;
    let list = this.mailboxByChat.get(chatId);
    if (!list) {
      list = [];
      this.mailboxByChat.set(chatId, list);
    }
    list.push(message);
    if (!this.isBusy(chatId) && !this.isLiveActive(chatId)) {
      void this.drainMailbox(chatId);
    }
  }

  /**
   * PA-76: Coalesces queued mailbox messages and wakes the parent chat.
   */
  private async drainMailbox(chatId: string): Promise<void> {
    const pendingTimer = this.drainRetryTimeouts.get(chatId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.drainRetryTimeouts.delete(chatId);
    }

    if (this.isBusy(chatId)) return;
    // PA-96: a wake turn runs the planner LLM, and while Gemini Live is this
    // chat's model that would put two models in one conversation. Deferred,
    // not dropped: `endLive` (or the activity TTL lapsing) drains it.
    if (this.isLiveActive(chatId)) return;
    const messages = this.mailboxByChat.get(chatId);
    if (!messages || messages.length === 0) return;
    const queued = [...messages];
    this.mailboxByChat.delete(chatId);

    const wakePrompt = buildWakePrompt(queued);
    this.opts.logger?.warn?.({ chatId, count: queued.length }, 'draining subagent mailbox to wake planner chat');

    try {
      const turn = this.sendMessage(chatId, wakePrompt, { isWake: true });
      for await (const _event of turn) {
        // drain events (they are emitted to observers via emit)
      }
      this.drainRetryAttempts.delete(chatId);
    } catch (err) {
      if (readPlannerChat(this.opts.db, chatId)) {
        const current = this.mailboxByChat.get(chatId) ?? [];
        this.mailboxByChat.set(chatId, [...queued, ...current]);

        const attempts = (this.drainRetryAttempts.get(chatId) ?? 0) + 1;
        this.drainRetryAttempts.set(chatId, attempts);
        const MAX_DRAIN_RETRIES = 5;
        if (attempts <= MAX_DRAIN_RETRIES) {
          const delayMs = Math.min(1000 * Math.pow(2, attempts - 1), 30_000);
          const timer = setTimeout(() => {
            this.drainRetryTimeouts.delete(chatId);
            if (!this.isBusy(chatId)) {
              void this.drainMailbox(chatId);
            }
          }, delayMs);
          timer.unref?.();
          this.drainRetryTimeouts.set(chatId, timer);
        } else {
          this.opts.logger?.error?.({ chatId, attempts }, 'subagent mailbox drain retries exhausted');
        }
      }
      this.opts.logger?.warn?.({ err, chatId }, 'wake turn failed; restored messages to mailbox');
    }
  }

  list(workspaceId?: string): PlannerChat[] {
    return readPlannerChats(this.opts.db, workspaceId).map((c) => this.decorate(c));
  }

  get(id: string): PlannerChat | null {
    const chat = readPlannerChat(this.opts.db, id);
    return chat ? this.decorate(chat) : null;
  }

  listByParentChatId(parentChatId: string): PlannerChat[] {
    return readPlannerChatsByParentId(this.opts.db, parentChatId).map((c) => this.decorate(c));
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
    /**
     * PA-75: provenance for planner-spawned subagent chats.
     */
    parentChatId?: string | null;
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
      parentChatId: input.parentChatId ?? null,
      busy: false,
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
    // PA-44: same reasoning as the two deletes above — a removed chat can
    // never spawn or be spawned into again, so its depth entry would just
    // leak for the life of the process otherwise.
    this.spawnDepthByChat.delete(id);
    // PA-76: Clean up supervisor outcomes for this chat and any subagents it spawned.
    this.supervisor.forget('pocket_agent', id);
    // PA-74: terminate any live subagent sessions this chat spawned, and clean up tracking.
    const subagents = this.subagentSessionsByChat.get(id);
    if (subagents) {
      for (const sessionId of subagents) {
        this.supervisor.forget('coding_agent', sessionId);
        const info = this.opts.sessions.find(sessionId);
        if (info && !isTerminalStatus(info.status)) {
          try {
            this.opts.sessions.terminate(sessionId);
          } catch (err) {
            this.opts.logger?.warn({ err, sessionId, chatId: id }, 'failed to terminate subagent session on chat deletion');
          }
        }
      }
      this.subagentSessionsByChat.delete(id);
    }
    this.spawnsThisTurnByChat.delete(id);
    this.activeTurns.delete(id);
    this.activeWakeTurns.delete(id);
    this.mailboxByChat.delete(id);
    this.wakeActionBudgetByChat.delete(id);
    const timers = this.scheduledWakeTimersByChat.get(id);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      this.scheduledWakeTimersByChat.delete(id);
    }
    this.turnPollChecksByChat.delete(id);
    this.turnStartedAtByChat.delete(id);
    const retryTimer = this.drainRetryTimeouts.get(id);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.drainRetryTimeouts.delete(id);
    }
    this.drainRetryAttempts.delete(id);
    this.liveSessions.delete(id);
    const liveTimer = this.liveExpiryTimers.get(id);
    if (liveTimer) {
      clearTimeout(liveTimer);
      this.liveExpiryTimers.delete(id);
    }
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
   * Clears all stored transcript events for this chat and drops any in-flight
   * pending approvals.
   */
  async clearHistory(id: string): Promise<void> {
    const chat = this.requireChat(id);
    for (const [pendingId, pending] of this.pendingTurns) {
      if (pending.chatId === id) this.pendingTurns.delete(pendingId);
    }
    this.mailboxByChat.delete(id);
    const workspacePath = this.workspacePathFor(chat);
    await clearTranscriptEvents(workspacePath, chat.id);
    updatePlannerChat(this.opts.db, chat.id, { lastActivityAt: Date.now() });
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
    const inWindowEvents = turns.slice(keepFrom).flat();
    const inWindowMessages = inWindowEvents.length;
    const foldedMessages = turns.slice(0, keepFrom).flat().length;
    // PA-59: converted through the same `eventsToLlmMessages` a real turn
    // uses, then estimated as one JSON blob — a human comparing this number
    // against what actually gets sent should be comparing like with like,
    // not a raw transcript-text length against a serialized-messages length.
    const windowTokens = estimateTokens(JSON.stringify(eventsToLlmMessages(inWindowEvents)));

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
        tokens: estimateTokens(r.memory.content),
      }));
    }

    // PA-59: the same three persona pieces `buildPersonaSystemMessage` joins
    // into one string for a real turn, kept apart here so the panel can show
    // and size each independently — plus a fourth, generated section
    // summarizing the enabled tool/meta-tool catalog, which has no prose
    // system-prompt text today (tool info reaches the model only via the
    // `tools` JSON-schema param) but is exactly the kind of "what's in
    // context" a human asking this question wants to see.
    const settings = readPlannerSettings(this.opts.db);
    const workspace = chat.workspaceId ? this.opts.plannerWorkspaces.get(chat.workspaceId) : undefined;
    const systemPrompt: PlannerSystemPromptSection[] = personaSections(workspace ?? null, settings).map((s) => ({
      id: s.id,
      label: s.label,
      text: s.text,
      tokens: estimateTokens(s.text),
    }));
    const enabledTools = this.toolsFor(chat.workspaceId);
    if (enabledTools.length > 0) {
      const summary = summarizeEnabledTools(enabledTools);
      systemPrompt.push({
        id: 'internalTools',
        label: 'Tools & meta-tools',
        text: summary,
        tokens: estimateTokens(summary),
      });
    }

    const toolsTokens = estimateTokens(JSON.stringify(toOpenAiToolSpecs(enabledTools)));
    // PA-59: only the memory rows that would actually be injected count
    // toward the total — the rest of `candidates` exists so a human can see
    // what almost made the cut, and counting them would make the headline
    // overstate what the next turn actually sends.
    const selectedMemoryTokens = candidates.filter((c) => c.selected).reduce((sum, c) => sum + c.tokens, 0);
    const systemPromptTokens = systemPrompt.reduce((sum, s) => sum + s.tokens, 0);
    const totalTokens = systemPromptTokens + windowTokens + selectedMemoryTokens + toolsTokens;

    return {
      memoryEnabled,
      candidates,
      window: { inWindowMessages, foldedMessages, windowLimit: ROLLING_WINDOW_TURNS, tokens: windowTokens },
      systemPrompt,
      tools: {
        enabledCount: enabledTools.length,
        // The actual footprint sent as the `tools` param, not the prose
        // summary above — see `summarizeEnabledTools`'s own doc comment for
        // why the two are reported separately.
        tokens: toolsTokens,
        mcpActive: enabledTools.some((t) => t.name === LIST_MCP_TOOLS_NAME),
        skillsActive: enabledTools.some((t) => t.name === LIST_SKILLS_NAME),
      },
      totalTokens,
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
    // PA-37 round three: `list_mcp_tools`/`call_mcp_tool` are deliberately
    // exempt from the ordinary global/per-agent deny-list, even though they
    // are plain `PLANNER_TOOLS` entries like any other. They are the *only*
    // gate an MCP tool call passes through, so letting the everyday Tools
    // checklist individually disable one of them would silently reintroduce
    // the per-tool footgun the PA-37 follow-up asked to remove — an operator
    // unchecking a row that looks like any other native tool, with nothing
    // marking it as "this is the whole of MCP," and getting no MCP tools at
    // all with no explanation (the prod bug report this round fixes). MCP
    // availability is governed solely by `mcpRegistry.listEnabledTools`
    // below; `fullToolCatalog()` (`routes/planner.ts`) also excludes both
    // names from the Tools UI entirely, so there is no checkbox that would
    // silently do nothing.
    const exempt = (name: string): boolean => name === LIST_MCP_TOOLS_NAME || name === CALL_MCP_TOOL_NAME;
    let tools =
      globalDisabled.size === 0 && agentDisabled.size === 0
        ? this.tools
        : this.tools.filter((t) => exempt(t.name) || (!globalDisabled.has(t.name) && !agentDisabled.has(t.name)));

    // PA-37: `list_mcp_tools`/`call_mcp_tool` stand in for every MCP
    // registry's tools (see `tools.ts`'s own "MCP" section doc comment) —
    // omitted entirely when this agent has nothing enabled behind them. An
    // agent with no MCP registries configured must see no difference at all
    // from before this feature existed.
    if (this.opts.mcpRegistry.listEnabledTools(workspaceId).length === 0) {
      tools = tools.filter((t) => t.name !== LIST_MCP_TOOLS_NAME && t.name !== CALL_MCP_TOOL_NAME);
    }

    // PA-38: same rule, one layer up — `list_skills`/`use_skill` stand in for
    // every enabled skill, and are omitted entirely when this agent has none.
    // An agent with no skills configured must see no difference at all from
    // before this feature existed.
    if (this.opts.skills.listKnownSkills(workspaceId).length === 0) {
      tools = tools.filter((t) => t.name !== LIST_SKILLS_NAME && t.name !== USE_SKILL_NAME);
    }

    // PA-95: when `bash` is enabled, omit legacy `exec_command` from what is sent to the LLM
    // so models are not presented with conflicting or duplicate command tools.
    if (tools.some((t) => t.name === 'bash')) {
      tools = tools.filter((t) => t.name !== 'exec_command');
    }
    return tools;
  }

  /**
   * PA-37: for a `call_mcp_tool` invocation, resolves the *real* underlying
   * MCP tool identity from its own (LLM-authored, not yet trusted)
   * arguments — this is what approval gating, "remember" persistence, and
   * the permission card must key off, never the wrapper's own static
   * `readOnly`/name. Returns `null` for every other tool call, in which case
   * the caller falls back to the tool's own static `readOnly` exactly as
   * before this feature existed.
   *
   * Fails closed: an unparsable/missing `tool` argument, or one that does not
   * resolve to a currently-enabled MCP tool, comes back `readOnly: false`
   * (gated) rather than `true` — the same posture an unresolvable safety hint
   * gets everywhere else in this codebase. `enabled` is re-checked here
   * (not just "does this tool exist at all") so a call naming a tool that is
   * individually disabled still pauses for a human rather than silently
   * running once approved elsewhere.
   */
  private effectiveMcpToolIdentity(
    workspaceId: string | null,
    call: PlannerLlmToolCall,
  ): { name: string; displayName: string; readOnly: boolean } | null {
    if (call.function.name !== CALL_MCP_TOOL_NAME) return null;
    const args = safeParseArgs(call.function.arguments);
    const requested = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (!requested) {
      return { name: CALL_MCP_TOOL_NAME, displayName: 'an MCP tool (not yet named)', readOnly: false };
    }
    const enabled = this.opts.mcpRegistry.listEnabledTools(workspaceId).some((t) => t.qualifiedName === requested);
    const resolved = this.opts.mcpRegistry.resolveTool(requested);
    return {
      name: requested,
      displayName: resolved ? `"${resolved.tool.name}" on "${resolved.registryName}"` : requested,
      readOnly: enabled && resolved ? resolved.tool.readOnlyHint === true : false,
    };
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
    const direct = this.toolsFor(workspaceId).find((t) => t.name === name);
    if (direct) return direct;
    if (name === 'exec_command') {
      return this.toolsFor(workspaceId).find((t) => t.name === 'bash');
    }
    return undefined;
  }

  /** Distinguishes three outcomes for the same "a tool call can't run"
      moment: a name that doesn't exist in the catalog at all, one that's
      off globally (PA-6 round 5), and one that's merely restricted for this
      one agent — so a genuinely unknown name, an operator-wide switch, and a
      per-agent restriction never read as the same failure to whoever's
      watching the transcript.

      `list_mcp_tools`/`call_mcp_tool` are special-cased (PA-37 round three):
      since `toolsFor` exempts them from the ordinary deny-lists, the only
      way either can reach this method at all is `mcpRegistry.listEnabledTools`
      being empty for this agent — reporting "disabled globally"/"disabled
      for this agent" there would name the wrong mechanism entirely. */
  private toolUnavailableMessage(workspaceId: string | null, name: string): string {
    if (!findPlannerTool(name)) return `Unknown tool: ${name}`;
    if (name === LIST_MCP_TOOLS_NAME || name === CALL_MCP_TOOL_NAME) {
      return 'No MCP tools are currently enabled for this agent.';
    }
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
    opts: { modelId?: string; image?: PromptImage; signal?: AbortSignal; isWake?: boolean; voiceMode?: boolean } = {},
  ): AsyncGenerator<AgentEvent> {
    const chat = this.requireChat(id);
    if (this.isBusy(id)) {
      throw new PlannerChatError('A turn is already in flight for this chat.', 'busy');
    }

    const settings = readPlannerSettings(this.opts.db);
    const maxSpawns = settings.maxSubagentSpawnsPerTurn ?? MAX_SUBAGENT_SPAWNS_PER_TURN;
    if (opts.isWake) {
      this.activeWakeTurns.add(id);
      this.spawnsThisTurnByChat.set(id, 0);
    } else {
      this.spawnsThisTurnByChat.set(id, 0);
      this.wakeActionBudgetByChat.set(id, maxSpawns);
    }

    const endTurn = this.beginTurn(chat.id);
    this.turnStartedAtByChat.set(chat.id, Date.now());
    this.turnPollChecksByChat.set(chat.id, new Map());
    try {
      const modelId = this.resolveModelId(chat, opts.modelId);
      const workspacePath = this.workspacePathFor(chat);

      let promptContent = content;
      if (opts.voiceMode && this.opts.config?.voiceSpokenSummaryEnabled) {
        promptContent = appendSpokenSummaryInstruction(promptContent);
      }

      if (chat.title === null) {
        const title = deriveChatTitle(stripSpokenSummaryInstruction(promptContent) || (opts.image ? 'Image prompt' : ''));
        if (title) updatePlannerChat(this.opts.db, chat.id, { title });
      }

      const userEvent: AgentEvent = {
        kind: 'user_prompt',
        id: crypto.randomUUID(),
        text: promptContent,
        ...(opts.image ? { image: opts.image } : {}),
      };
      yield* this.emit(workspacePath, chat.id, userEvent);

      yield* this.driveLoop(chat, workspacePath, modelId, 0, EMPTY_TURN_STATS, opts.signal);
    } finally {
      endTurn();
      this.activeWakeTurns.delete(chat.id);
      if (!this.isBusy(chat.id)) {
        this.turnStartedAtByChat.delete(chat.id);
        this.turnPollChecksByChat.delete(chat.id);
        void this.drainMailbox(chat.id);
      }
    }
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
    // The turn was already in flight — parked, but in flight — so it moves
    // from `pendingTurns` (deleted above) to `activeTurns` here, and PA-69's
    // drain check sees it continuously across the handover rather than
    // briefly reading as idle in between.
    const endTurn = pending.kind === 'live' ? this.beginLiveWork(chatId) : this.beginTurn(chatId);
    try {
      const chat = this.requireChat(chatId);
      const workspacePath = this.workspacePathFor(chat);
      const call = pending.kind === 'live' ? pending.call : pending.toolCalls[pending.index]!;
      yield* this.applyApprovalDecision(chat, workspacePath, approvalId, pending.workspaceId, call, choice);

      // PA-96: a live call has no continuation to resume — Gemini drives its
      // own conversation, and the browser relays the `tool_result` just
      // emitted. A planner turn carries on with the rest of its batch.
      if (pending.kind === 'loop') {
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
    } finally {
      endTurn();
      if (!this.isBusy(chatId)) {
        this.turnStartedAtByChat.delete(chatId);
        this.turnPollChecksByChat.delete(chatId);
        void this.drainMailbox(chatId);
      }
    }
  }

  /**
   * The resolution half of the gate, shared by a parked planner turn and a
   * parked Gemini Live call (PA-96), so "what happens when a human answers"
   * cannot differ between the two models.
   */
  private async *applyApprovalDecision(
    chat: PlannerChat,
    workspacePath: string,
    approvalId: string,
    workspaceId: string | null,
    call: PlannerLlmToolCall,
    choice: PlannerToolApprovalChoice,
  ): AsyncGenerator<AgentEvent> {
    // Re-resolved rather than remembered: a tool disabled while the approval
    // sat waiting is refused now, whatever the human says.
    const tool = this.resolveEnabledTool(workspaceId, call.function.name);
    // PA-37: same real-identity resolution the gate used to decide to pause in
    // the first place — recomputed here (deterministically, from the same
    // unchanged `call`) rather than threaded through the pending entry, so
    // "remember" persists against the underlying MCP tool, never the
    // wrapper's own name.
    const mcpIdentity = this.effectiveMcpToolIdentity(workspaceId, call);
    const gateName = mcpIdentity?.name ?? call.function.name;

    if (choice !== 'allow_once') {
      rememberDecisionIfAsked(this.opts.db, choice, gateName, workspaceId);
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
        content: choice === 'deny' ? 'Denied by the user.' : this.toolUnavailableMessage(workspaceId, call.function.name),
        truncated: false,
        isError: true,
      });
      return;
    }
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

  /** Persist then yield — every event this service produces goes through here, so the two never drift apart. */
  private async *emit(workspacePath: string, chatId: string, event: AgentEvent): AsyncGenerator<AgentEvent> {
    await this.persist(workspacePath, chatId, event);
    yield event;
  }

  /** The non-generator half of `emit`, for callers with no stream to yield
      onto (the Gemini Live bridge, PA-96). The same two steps in the same
      order, so an observer can never see an event the transcript lacks. */
  private async persist(workspacePath: string, chatId: string, event: AgentEvent): Promise<void> {
    await appendTranscriptEvent(workspacePath, chatId, event);
    this.notify(chatId, event);
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
    this.spawnsThisTurnByChat.delete(chat.id);
    this.turnPollChecksByChat.delete(chat.id);
    this.turnStartedAtByChat.delete(chat.id);
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
    const settings = readPlannerSettings(this.opts.db);
    if (iteration >= settings.maxToolIterations) {
      yield* this.finishTurn(chat, workspacePath, modelId, GIVE_UP_MESSAGE, true, stats);
      return;
    }

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
    // PA-45: this agent's own identity/capability text plus the global "me"
    // (who the operator is) and "tools" (their environment) instructions,
    // unshifted last so it lands ahead of the memory system message above —
    // who this agent is and who it's talking to is more foundational than
    // what it remembers. Omitted entirely (not an empty system message)
    // when every one of the three is unset, so an agent with none of this
    // configured behaves exactly as it did before this feature existed.
    const workspace = chat.workspaceId ? this.opts.plannerWorkspaces.get(chat.workspaceId) : undefined;
    const personaMessage = buildPersonaSystemMessage(workspace ?? null, settings);
    if (personaMessage) {
      messages.unshift({ role: 'system', content: personaMessage });
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
      const gate = this.gateToolCall(chat, call);

      if (gate.kind === 'unavailable') {
        yield* this.emit(workspacePath, chat.id, {
          kind: 'tool_result',
          id: crypto.randomUUID(),
          toolUseId: call.id,
          content: gate.message,
          truncated: false,
          isError: true,
        });
        continue;
      }
      if (gate.kind === 'needs_approval') {
        const approvalId = crypto.randomUUID();
        this.pendingTurns.set(approvalId, {
          kind: 'loop',
          chatId: chat.id,
          workspaceId: chat.workspaceId,
          modelId,
          toolCalls,
          index,
          iteration,
          stats,
        });
        yield* this.emit(workspacePath, chat.id, permissionRequestEvent(approvalId, call, gate.tool, gate.mcpIdentity));
        return; // paused — the rest of this batch waits for `resolveApproval`
      }
      if (gate.kind === 'denied') {
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

      const resultText = await this.executeTool(gate.tool, call.function.arguments, chat);
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

  /**
   * The approval gate's decision for one call — the single place both the
   * planner loop and the Gemini Live bridge (PA-96) ask "may this run?", so a
   * call coming from Google's model gets exactly the refusals, remembered
   * decisions, yolo and `skipToolApprovalsEnabled` handling a call from the
   * planner LLM does, and neither can drift from the other.
   */
  private gateToolCall(chat: PlannerChat, call: PlannerLlmToolCall): ToolGateDecision {
    const tool = this.resolveEnabledTool(chat.workspaceId, call.function.name);
    if (!tool) {
      return { kind: 'unavailable', message: this.toolUnavailableMessage(chat.workspaceId, call.function.name) };
    }
    // PA-37: a `call_mcp_tool` invocation's real risk lives in *which*
    // underlying MCP tool it names, never in the wrapper's own static
    // `readOnly` — see `effectiveMcpToolIdentity`'s own doc comment.
    const mcpIdentity = this.effectiveMcpToolIdentity(chat.workspaceId, call);
    const gateName = mcpIdentity?.name ?? tool.name;
    const gateReadOnly = mcpIdentity?.readOnly ?? tool.readOnly;
    if (gateReadOnly) return { kind: 'run', tool };
    const decision = resolveApprovalStatus(this.opts.db, gateName, chat.workspaceId, chat.skipToolApprovalsEnabled);
    if (decision === null) return { kind: 'needs_approval', tool, mcpIdentity };
    if (decision === 'deny') return { kind: 'denied' };
    return { kind: 'run', tool };
  }

  // ---- Gemini Live (PA-96) --------------------------------------------------

  /** Marks Gemini Live work for a chat; returns the release for a `finally`. */
  private beginLiveWork(chatId: string): () => void {
    const endTurn = this.beginTurn(chatId);
    this.liveWork.set(chatId, (this.liveWork.get(chatId) ?? 0) + 1);
    return () => {
      const remaining = (this.liveWork.get(chatId) ?? 1) - 1;
      if (remaining > 0) this.liveWork.set(chatId, remaining);
      else this.liveWork.delete(chatId);
      endTurn();
    };
  }

  /**
   * True while the *planner LLM* owns this chat: a typed or wake turn being
   * driven, or one parked on an approval. Gemini Live refuses to start or act
   * then, because two models writing one transcript is exactly what "only one
   * model drives the chat at a time" rules out. Live work of its own does not
   * count, or a second tool call in the same Gemini turn would refuse itself.
   */
  private busyWithPlannerLoop(chatId: string): boolean {
    const active = (this.activeTurns.get(chatId) ?? 0) - (this.liveWork.get(chatId) ?? 0);
    if (active > 0) return true;
    for (const pending of this.pendingTurns.values()) {
      if (pending.chatId === chatId && pending.kind === 'loop') return true;
    }
    return false;
  }

  private isLiveActive(chatId: string): boolean {
    const last = this.liveSessions.get(chatId);
    if (last === undefined) return false;
    if (Date.now() - last < LIVE_ACTIVITY_TTL_MS) return true;
    this.liveSessions.delete(chatId);
    return false;
  }

  private touchLive(chatId: string): void {
    this.liveSessions.set(chatId, Date.now());
    // One timer per chat, re-armed on activity: when the TTL lapses with no
    // `endLive`, the deferred mailbox still gets drained rather than waiting
    // for some unrelated future event.
    const previous = this.liveExpiryTimers.get(chatId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.liveExpiryTimers.delete(chatId);
      if (!this.isLiveActive(chatId) && !this.isBusy(chatId)) void this.drainMailbox(chatId);
    }, LIVE_ACTIVITY_TTL_MS + 1000);
    timer.unref?.();
    this.liveExpiryTimers.set(chatId, timer);
  }

  /** The browser left live mode (best effort — a vanished tab is covered by
      the TTL). Releases anything `drainMailbox` deferred for it. */
  endLive(chatId: string): void {
    this.requireChat(chatId);
    this.liveSessions.delete(chatId);
    const timer = this.liveExpiryTimers.get(chatId);
    if (timer) {
      clearTimeout(timer);
      this.liveExpiryTimers.delete(chatId);
    }
    this.spawnsThisTurnByChat.delete(chatId);
    if (!this.isBusy(chatId)) void this.drainMailbox(chatId);
  }

  private serializeLive<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.liveQueues.get(chatId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => undefined);
    this.liveQueues.set(chatId, settled);
    void settled.then(() => {
      if (this.liveQueues.get(chatId) === settled) this.liveQueues.delete(chatId);
    });
    return next;
  }

  /**
   * Everything the Gemini session is seeded with, from the chat's real
   * context: the live-mode rules plus this agent's persona and its most
   * relevant memories (the system instruction the token locks), the exact
   * tool list the planner would offer this agent, and the rolling-window
   * history as replayable turns. Refuses while the planner LLM owns the chat.
   */
  async liveSetup(
    chatId: string,
    opts: { resumed: boolean },
  ): Promise<{
    systemInstruction: string;
    functionDeclarations: GeminiFunctionDeclaration[];
    seedTurns: GeminiLiveSeedTurn[];
  }> {
    const chat = this.requireChat(chatId);
    if (this.busyWithPlannerLoop(chatId)) {
      throw new PlannerChatError(
        'A Pocket Agent turn is still running in this chat. Wait for it to finish before going live.',
        'busy',
      );
    }
    const workspacePath = this.workspacePathFor(chat);
    const events = await readTranscriptEvents(workspacePath, chat.id);
    // The same window `previewContext` shows and a real turn sends, taken
    // without folding: minting a token must not write memories as a side
    // effect of a human merely switching the mic on.
    const turns = splitIntoTurns(events);
    const inWindow = turns.slice(Math.max(0, turns.length - ROLLING_WINDOW_TURNS)).flat();

    const settings = readPlannerSettings(this.opts.db);
    const workspace = chat.workspaceId ? this.opts.plannerWorkspaces.get(chat.workspaceId) : undefined;
    const parts: string[] = [LIVE_MODE_SYSTEM_INSTRUCTION];
    const persona = buildPersonaSystemMessage(workspace ?? null, settings);
    if (persona) parts.push(persona);
    if (this.memoryEnabledFor(chat.workspaceId) && chat.workspaceId) {
      const results = await this.opts.memory.search(chat.workspaceId, lastUserPromptText(events), {
        limit: MEMORY_INJECT_TOP_K,
      });
      if (results.length > 0) parts.push(buildMemorySystemMessage(results.map((r) => r.memory)));
    }

    const functionDeclarations = this.toolsFor(chat.workspaceId).map((t) => ({
      name: t.name,
      description: t.description,
      parametersJsonSchema: t.parameters,
    }));
    this.touchLive(chatId);
    return {
      systemInstruction: parts.join('\n\n'),
      functionDeclarations,
      seedTurns: opts.resumed ? [] : eventsToSeedTurns(inWindow),
    };
  }

  /**
   * The Gemini Live tool bridge: each call goes through `gateToolCall` and
   * `executeTool`, exactly as a planner-LLM call does in `processToolCalls`,
   * and everything is persisted as the same `tool_use` / `permission_request`
   * / `tool_result` events. A call needing approval is parked
   * (`PendingLiveToolCall`) and answered at once with
   * `LIVE_AWAITING_APPROVAL_MESSAGE`; nothing about it runs until
   * `POST .../approvals/:id`, and there is no timeout.
   *
   * The persisted `tool_use` id is minted here rather than taken from Gemini:
   * Gemini's ids are short and restart with each session, and a collision with
   * an earlier call in the same transcript would pair a later result with the
   * wrong call when the planner LLM reads the history back.
   */
  async runLiveToolCalls(chatId: string, calls: readonly GeminiLiveToolCall[]): Promise<GeminiLiveToolCallResult[]> {
    const chat = this.requireChat(chatId);
    if (this.busyWithPlannerLoop(chatId)) {
      throw new PlannerChatError('A Pocket Agent turn is running in this chat.', 'busy');
    }
    this.touchLive(chatId);
    return this.serializeLive(chatId, async () => {
      const release = this.beginLiveWork(chatId);
      if (!this.turnStartedAtByChat.has(chatId)) this.turnStartedAtByChat.set(chatId, Date.now());
      try {
        const workspacePath = this.workspacePathFor(chat);
        const llmCalls: PlannerLlmToolCall[] = calls.map((c) => ({
          id: `live_${crypto.randomUUID()}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
        }));
        for (const call of llmCalls) {
          const args = safeParseArgs(call.function.arguments);
          await this.persist(workspacePath, chat.id, {
            kind: 'tool_use',
            id: call.id,
            name: call.function.name,
            input: args,
            summary: summarizeToolCall(call.function.name, args),
            filePath: extractFilePath(args),
          });
        }
        const results: GeminiLiveToolCallResult[] = [];
        for (let i = 0; i < llmCalls.length; i++) {
          const call = llmCalls[i]!;
          const base = { callId: calls[i]!.id, name: call.function.name, toolUseId: call.id };
          const gate = this.gateToolCall(chat, call);
          if (gate.kind === 'needs_approval') {
            const approvalId = crypto.randomUUID();
            this.pendingTurns.set(approvalId, { kind: 'live', chatId: chat.id, workspaceId: chat.workspaceId, call });
            await this.persist(workspacePath, chat.id, permissionRequestEvent(approvalId, call, gate.tool, gate.mcpIdentity));
            results.push({ ...base, status: 'awaiting_approval', output: LIVE_AWAITING_APPROVAL_MESSAGE, approvalId });
            continue;
          }
          let output: string;
          let isError: boolean;
          if (gate.kind === 'unavailable') {
            output = gate.message;
            isError = true;
          } else if (gate.kind === 'denied') {
            output = 'Denied by a remembered decision.';
            isError = true;
          } else {
            output = await this.executeTool(gate.tool, call.function.arguments, chat);
            isError = false;
          }
          await this.persist(workspacePath, chat.id, {
            kind: 'tool_result',
            id: crypto.randomUUID(),
            toolUseId: call.id,
            content: output,
            truncated: false,
            isError,
          });
          results.push({ ...base, status: isError ? 'refused' : 'completed', output, approvalId: null });
        }
        return results;
      } finally {
        release();
      }
    });
  }

  /**
   * Persists what Gemini heard and said as the ordinary events a typed turn
   * produces. `turn_complete` carries Gemini's own `usageMetadata` token
   * counts and the time the model spent answering, so the existing
   * `TurnFooter` renders it with no new frontend code.
   */
  async recordLiveTranscript(chatId: string, req: GeminiLiveTranscriptRequest): Promise<void> {
    const chat = this.requireChat(chatId);
    if (this.busyWithPlannerLoop(chatId)) {
      throw new PlannerChatError('A Pocket Agent turn is running in this chat.', 'busy');
    }
    this.touchLive(chatId);
    await this.serializeLive(chatId, async () => {
      const workspacePath = this.workspacePathFor(chat);
      const userText = req.userText?.trim();
      if (userText) {
        if (this.get(chatId)?.title === null) {
          const title = deriveChatTitle(userText);
          if (title) updatePlannerChat(this.opts.db, chat.id, { title });
        }
        await this.persist(workspacePath, chat.id, { kind: 'user_prompt', id: crypto.randomUUID(), text: userText });
      }
      const modelText = req.modelText?.trim();
      if (modelText) {
        await this.persist(workspacePath, chat.id, { kind: 'text', id: crypto.randomUUID(), text: modelText });
      }
      if (req.turnComplete) {
        await this.persist(workspacePath, chat.id, {
          kind: 'turn_complete',
          stopReason: req.turnComplete.interrupted ? 'interrupted' : 'end_turn',
          isError: false,
          numTurns: null,
          durationMs: req.turnComplete.durationMs,
          costUsd: null,
          inputTokens: req.turnComplete.inputTokens,
          outputTokens: req.turnComplete.outputTokens,
          completedAt: Date.now(),
        });
        // A Gemini turn is this chat's turn for the per-turn budgets the tools
        // keep (spawns, poll short-circuits), the same reset `finishTurn` does.
        this.spawnsThisTurnByChat.delete(chat.id);
        this.turnPollChecksByChat.delete(chat.id);
        this.turnStartedAtByChat.delete(chat.id);
      }
      updatePlannerChat(this.opts.db, chat.id, { lastActivityAt: Date.now() });
    });
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
          mcpRegistry: this.opts.mcpRegistry,
          skills: this.opts.skills,
          workspaceId: chat.workspaceId,
          workspacePath: this.workspacePathFor(chat),
          commandTimeoutSeconds: settings.commandTimeoutSeconds,
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
          agents: this.opts.agents,
          // PA-56: `read_settings`/`update_settings`/`update_webhook`/
          // `update_cron_job`/`update_custom_claude_provider`/
          // `update_telegram_bot` — see `PlannerToolDeps`'s own doc comments.
          db: this.opts.db,
          config: this.opts.config,
          customClaudeProviders: this.opts.customClaudeProviders,
          telegramBots: this.opts.telegramBots ?? null,
          webhooks: this.runServices?.webhooks ?? null,
          cron: this.runServices?.cron ?? null,
          subagents: {
            startPocketAgentChat: (workspaceId: string, prompt: string) =>
              this.startSubagentChatForTool(chat.id, workspaceId, prompt),
            pocketAgentChatStatus: (chatId: string) => this.subagentChatStatusForTool(chatId),
            pocketAgentEnabledTools: (workspaceId: string) => this.toolsFor(workspaceId).map((t) => t.name),
            findLiveCodingSubagent: (treeRoot: string) => this.findLiveCodingSubagentForChat(chat.id, treeRoot),
            recordCodingSubagent: (sessionId: string) => this.recordCodingSubagentForChat(chat.id, sessionId),
            trackCodingSubagent: (sessionId: string, parentChatId: string) =>
              this.supervisor.trackCodingSubagent(sessionId, parentChatId),
            invalidateCodingStatus: (sessionId: string) =>
              this.supervisor.invalidate('coding_agent', sessionId),
            codingAgentStatus: (sessionId: string) => this.supervisor.getOutcome('coding_agent', sessionId),
            spawnsThisTurn: () => this.spawnsThisTurnForChat(chat.id),
            recordAction: () => {
              if (this.isWakeTurnActive(chat.id)) {
                const budget = this.wakeActionBudgetByChat.get(chat.id) ?? 0;
                this.wakeActionBudgetByChat.set(chat.id, Math.max(0, budget - 1));
              }
            },
            recordSpawn: () => {
              this.recordSpawnForChat(chat.id);
              if (this.isWakeTurnActive(chat.id)) {
                const budget = this.wakeActionBudgetByChat.get(chat.id) ?? 0;
                this.wakeActionBudgetByChat.set(chat.id, Math.max(0, budget - 1));
              }
            },
            wakeBudgetExhausted: () => {
              if (this.isWakeTurnActive(chat.id)) {
                const budget = this.wakeActionBudgetByChat.get(chat.id) ?? 0;
                if (budget <= 0) {
                  this.opts.logger?.warn?.(
                    { chatId: chat.id },
                    'subagent action budget for wake-driven turns exhausted',
                  );
                  return true;
                }
              }
              return false;
            },
            checkSubagentStatusTurn: (kind, id, state) =>
              this.checkSubagentStatusTurnForChat(chat.id, kind, id, state),
            checkSessionOutputTurn: (sessionId, info) =>
              this.checkSessionOutputTurnForChat(chat.id, sessionId, info),
            isTrackedSubagentSession: (sessionId) => {
              if (this.subagentSessionsByChat.get(chat.id)?.has(sessionId)) return true;
              const info = this.opts.sessions.find(sessionId);
              return info?.plannerChatId === chat.id;
            },
            scheduleCheckBackIn: (seconds) =>
              this.scheduleCheckBackInForChat(chat.id, seconds),
            stopSubagent: (kind, id) =>
              this.stopSubagentForChat(chat.id, kind, id),
          },
          spawnDepth: this.spawnDepthOf(chat.id),
          maxSubagentSpawnsPerTurn: settings.maxSubagentSpawnsPerTurn,
          plannerChatId: chat.id,
          telegram: {
            links:
              this.opts.telegramLinks
                ?.list()
                .map((l) => ({ botId: l.botId, telegramChatId: l.telegramChatId, label: l.telegramUserLabel })) ?? [],
            send: async (botId: string, telegramChatId: string, text: string) => {
              const token = this.opts.telegramBots?.revealToken(botId) ?? null;
              if (!token) return { ok: false, error: 'Telegram is not configured on this server.' };
              const client = new TelegramClient({
                token,
                ...(this.opts.telegramFetch ? { fetchImpl: this.opts.telegramFetch } : {}),
              });
              try {
                await client.sendMessage(telegramChatId, text);
                return { ok: true };
              } catch (err) {
                return { ok: false, error: (err as Error).message };
              }
            },
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

  /** See `spawnDepthByChat`'s doc comment: absence means a human started it. */
  private spawnDepthOf(chatId: string): number {
    return this.spawnDepthByChat.get(chatId) ?? 0;
  }

  /**
   * PA-44: backs `start_subagent_session`'s `pocket_agent` branch —
   * `PlannerToolDeps.subagents.startPocketAgentChat`. Creates a new chat in
   * `workspaceId` and starts its first turn following the exact ordering
   * `RunExecutor.startPocketAgent` already established for a cron/webhook
   * pocket run — chat, then prompt via the `sendMessage` generator, with its
   * first `next()` awaited synchronously so a precondition failure (no LLM
   * endpoint configured for this agent, no model to use) surfaces as part of
   * *this* call's own rejection rather than a background warning nobody
   * reads — and the rest of the turn pumped in the background afterward, so
   * the calling turn gets its handle back immediately rather than blocking
   * on however long the subagent takes. Every event the pump produces is
   * still persisted and notified through `emit`/`notify` exactly as a
   * human-driven turn's would be; nothing here bypasses that, only who is
   * doing the draining changes.
   *
   * The depth check is re-derived from `callerChatId` here too, not merely
   * trusted from the tool's own check — the same defense-in-depth
   * `resolveEnabledTool` already applies to a disabled tool name the model
   * might still send.
   */
  private async startSubagentChatForTool(
    callerChatId: string,
    workspaceId: string,
    prompt: string,
  ): Promise<{ chatId: string }> {
    const callerDepth = this.spawnDepthOf(callerChatId);
    if (callerDepth >= MAX_SUBAGENT_SPAWN_DEPTH) {
      throw new Error(
        `Refusing: starting another Pocket Agent chat here would exceed the depth limit of ${MAX_SUBAGENT_SPAWN_DEPTH}.`,
      );
    }
    const workspace = this.opts.plannerWorkspaces.get(workspaceId);
    if (!workspace) throw new Error(`No Pocket Agent workspace found with id ${workspaceId}.`);

    const child = this.create({ workspaceId, parentChatId: callerChatId });
    this.spawnDepthByChat.set(child.id, callerDepth + 1);
    this.supervisor.trackPocketSubagent(child.id, callerChatId);

    const turn = this.sendMessage(child.id, prompt);
    try {
      await turn.next();
    } catch (err) {
      throw err instanceof PlannerChatError ? new Error(err.message) : err;
    }
    void (async () => {
      try {
        while (true) {
          const next = await turn.next();
          if (next.done === true) break;
        }
      } catch (err) {
        this.opts.logger?.warn({ err, chatId: child.id }, 'subagent chat turn failed');
      }
    })();

    return { chatId: child.id };
  }

  /**
   * PA-44: backs `get_subagent_status`'s `pocket_agent` branch. A spawned
   * chat has no `SessionInfo.status`/`busy` the way a coding-agent session
   * does — there is no live process to ask — so "is it done yet" is read
   * off the tail of the same persisted transcript `history()` returns,
   * which can never disagree with what a human opening the chat in the UI
   * would see.
   */
  private async subagentChatStatusForTool(chatId: string): Promise<SubagentChatStatus> {
    const chat = this.get(chatId);
    if (!chat) return { status: 'gone', summary: `No subagent chat found with id ${chatId}.` };

    if (this.isBusy(chatId)) {
      const now = Date.now();
      const busySince = this.turnStartedAtByChat.get(chatId) ?? chat.lastActivityAt;
      const busyForMs = Math.max(0, now - busySince);
      const lastOutputAgoMs = Math.max(0, now - chat.lastActivityAt);
      const pendingCount = Array.from(this.pendingTurns.values()).filter((p) => p.chatId === chatId).length;
      if (pendingCount > 0) {
        return {
          status: 'paused_for_approval',
          busyForMs,
          lastOutputAgoMs,
          lastActivityAt: chat.lastActivityAt,
          pendingApprovals: pendingCount,
          summary: `Waiting on a human to approve ${pendingCount} tool call(s) — open this chat in the Pocket Agent UI to answer.`,
        };
      }
      const busySec = Math.round(busyForMs / 1000);
      const outputSec = Math.round(lastOutputAgoMs / 1000);
      return {
        status: 'running',
        busyForMs,
        lastOutputAgoMs,
        lastActivityAt: chat.lastActivityAt,
        pendingApprovals: 0,
        summary: `(still working on its assigned task, running ${busySec}s, last activity ${outputSec}s ago)`,
      };
    }

    const cached = this.supervisor.getOutcome('pocket_agent', chatId);
    if (cached) return cached;

    const events = await this.history(chatId);
    const last = events[events.length - 1];
    if (!last) return { status: 'running', summary: '(just started, no output yet)' };
    if (last.kind === 'turn_complete') {
      return { status: last.isError ? 'error' : 'done', summary: lastMessageSummary(events) };
    }
    if (last.kind === 'permission_request') {
      return {
        status: 'paused_for_approval',
        summary: `Waiting on a human to approve tool "${last.toolName}" — open this chat in the Pocket Agent UI to answer.`,
      };
    }
    return { status: 'running', summary: '(still working on its assigned task)' };
  }

  /**
   * PA-78: Short-circuit repeat status/output calls within the same turn when state is unchanged.
   */
  private checkPollTurnForChat(
    chatId: string,
    key: string,
    callLabel: string,
    runningSec: string,
    currentActivityAt: number | null,
  ): { shortCircuit: false } | { shortCircuit: true; message: string } {
    let map = this.turnPollChecksByChat.get(chatId);
    if (!map) {
      map = new Map();
      this.turnPollChecksByChat.set(chatId, map);
    }
    const record = map.get(key);
    const now = Date.now();
    if (!record) {
      map.set(key, { lastCheckedAt: now, lastActivityAt: currentActivityAt, count: 0 });
      return { shortCircuit: false };
    }

    // Reset repeat count if new activity arrived since the last check.
    // Handles null baseline if first check had no activity timestamp yet.
    const hasNewActivity =
      (record.lastActivityAt === null && currentActivityAt !== null) ||
      (currentActivityAt !== null && record.lastActivityAt !== null && currentActivityAt > record.lastActivityAt);

    if (hasNewActivity) {
      record.lastCheckedAt = now;
      record.lastActivityAt = currentActivityAt;
      record.count = 0;
      return { shortCircuit: false };
    }

    record.count++;
    const elapsedSec = ((now - record.lastCheckedAt) / 1000).toFixed(1);
    record.lastCheckedAt = now;

    if (record.count >= 3) {
      return {
        shortCircuit: true,
        message: `Refusing repeated ${callLabel} call: still running with no new output. You are notified automatically when this finishes — end your turn now.`,
      };
    }

    return {
      shortCircuit: true,
      message: `Unchanged since your last check ${elapsedSec}s ago (running ${runningSec}, no new output). You are notified automatically when this finishes — end your turn now.`,
    };
  }

  private checkSubagentStatusTurnForChat(
    chatId: string,
    kind: 'coding_agent' | 'pocket_agent',
    id: string,
    state: { busy: boolean; busyForMs?: number | null; lastActivityAt?: number | null; summary?: string },
  ): { shortCircuit: false } | { shortCircuit: true; message: string } {
    const runningSec = state.busyForMs != null ? `${(state.busyForMs / 1000).toFixed(1)}s` : 'recently';
    return this.checkPollTurnForChat(
      chatId,
      `status:${kind}:${id}`,
      `get_subagent_status call for ${id}`,
      runningSec,
      state.lastActivityAt ?? null,
    );
  }

  private checkSessionOutputTurnForChat(
    chatId: string,
    sessionId: string,
    info: SessionInfo,
  ): { shortCircuit: false } | { shortCircuit: true; message: string } {
    const now = Date.now();
    const runningSec = info.busySince != null ? `${((now - info.busySince) / 1000).toFixed(1)}s` : 'recently';
    return this.checkPollTurnForChat(
      chatId,
      `output:${sessionId}`,
      `read_session_output call for subagent session ${sessionId}`,
      runningSec,
      info.lastActivityAt ?? null,
    );
  }

  /**
   * PA-78: Schedule a non-blocking self-wake timer.
   */
  private scheduleCheckBackInForChat(chatId: string, seconds: number): { ok: true } | { ok: false; error: string } {
    const chat = readPlannerChat(this.opts.db, chatId);
    if (!chat) return { ok: false, error: 'Chat not found' };

    let timers = this.scheduledWakeTimersByChat.get(chatId);
    if (!timers) {
      timers = new Set();
      this.scheduledWakeTimersByChat.set(chatId, timers);
    }
    const MAX_ACTIVE_TIMERS = 3;
    if (timers.size >= MAX_ACTIVE_TIMERS) {
      return { ok: false, error: `Too many active timers for this chat (maximum ${MAX_ACTIVE_TIMERS}).` };
    }

    const timer = setTimeout(() => {
      const set = this.scheduledWakeTimersByChat.get(chatId);
      if (set) {
        set.delete(timer);
        if (set.size === 0) {
          this.scheduledWakeTimersByChat.delete(chatId);
        }
      }
      this.enqueueMailbox(chatId, {
        subagentId: `timer-${seconds}s`,
        kind: 'timer',
        status: 'fired',
        summary: `Timer check_back_in fired after ${seconds}s.`,
      });
    }, seconds * 1000);
    timer.unref?.();
    timers.add(timer);
    return { ok: true };
  }

  /**
   * PA-78: Stop/terminate a subagent session.
   */
  private async stopSubagentForChat(
    chatId: string,
    kind: 'coding_agent' | 'pocket_agent',
    id: string,
  ): Promise<{ ok: boolean; message: string }> {
    if (kind === 'pocket_agent') {
      return {
        ok: false,
        message: 'Stopping pocket_agent subagents is not supported — only coding_agent sessions can be terminated.',
      };
    }
    const info = this.opts.sessions.find(id);
    if (!info) return { ok: false, message: `No session found with id ${id}.` };

    const isOwned =
      (info.plannerChatId && info.plannerChatId === chatId) ||
      (this.subagentSessionsByChat.get(chatId)?.has(id) ?? false);
    if (!isOwned) {
      return {
        ok: false,
        message: `Refusing to terminate session ${id}: session was not started by this chat.`,
      };
    }
    if (isTerminalStatus(info.status)) {
      return { ok: true, message: `Subagent session ${id} has already ended (status: ${info.status}).` };
    }
    try {
      this.opts.sessions.terminate(id);
      return { ok: true, message: `Terminated coding subagent session ${id}.` };
    } catch (err) {
      return { ok: false, message: `Failed to terminate coding subagent session ${id}: ${(err as Error).message}` };
    }
  }

  /**
   * PA-74: Backs `PlannerSubagentDeps.findLiveCodingSubagent`. Checks whether
   * `chatId` already started a live coding-agent session in the working tree
   * rooted at `treeRoot`. Terminal sessions are pruned on the fly.
   */
  private findLiveCodingSubagentForChat(
    chatId: string,
    treeRoot: string,
  ): { id: string; status: 'running' | 'idle' } | null {
    const set = this.subagentSessionsByChat.get(chatId);
    if (!set) return null;
    for (const sessionId of set) {
      const info = this.opts.sessions.find(sessionId);
      if (!info || isTerminalStatus(info.status)) {
        set.delete(sessionId);
        continue;
      }
      if (treeRootOf(info.cwd) === treeRoot) {
        return { id: info.id, status: info.busy ? 'running' : 'idle' };
      }
    }
    return null;
  }

  /**
   * PA-74: Backs `PlannerSubagentDeps.recordCodingSubagent`. Records a
   * coding-agent session started by `chatId`.
   */
  private recordCodingSubagentForChat(chatId: string, sessionId: string): void {
    let set = this.subagentSessionsByChat.get(chatId);
    if (!set) {
      set = new Set();
      this.subagentSessionsByChat.set(chatId, set);
    }
    set.add(sessionId);
    this.supervisor.trackCodingSubagent(sessionId, chatId);
  }

  /**
   * PA-74: Backs `PlannerSubagentDeps.spawnsThisTurn`. Reads how many subagents
   * have been spawned during the chat's current turn.
   */
  private spawnsThisTurnForChat(chatId: string): number {
    return this.spawnsThisTurnByChat.get(chatId) ?? 0;
  }

  /**
   * PA-74: Backs `PlannerSubagentDeps.recordSpawn`. Increments the spawn count
   * for the chat's current turn.
   */
  private recordSpawnForChat(chatId: string): void {
    const current = this.spawnsThisTurnByChat.get(chatId) ?? 0;
    this.spawnsThisTurnByChat.set(chatId, current + 1);
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


/** The `permission_request` a parked call emits — shared by the planner loop
    and the Gemini Live bridge (PA-96) so the approval card reads the same
    whichever model asked. */
function permissionRequestEvent(
  approvalId: string,
  call: PlannerLlmToolCall,
  tool: PlannerToolDefinition,
  mcpIdentity: { name: string; displayName: string } | null,
): AgentEvent {
  const args = safeParseArgs(call.function.arguments);
  return {
    kind: 'permission_request',
    id: approvalId,
    toolName: mcpIdentity?.name ?? tool.name,
    input: args,
    title: mcpIdentity ? `Run MCP tool ${mcpIdentity.displayName}` : `Run ${tool.name}`,
    displayName: mcpIdentity?.displayName ?? null,
    filePath: extractFilePath(args),
    reason: null,
    canAllowForSession: false,
    questions: null,
  };
}

/**
 * PA-96: a chat's windowed transcript as the text turns a Gemini Live session
 * is seeded with. Tool calls become a line of model-side narration rather than
 * Gemini `functionCall`/`functionResponse` parts — the ids would not match
 * anything in the new session, and a model reading "I called X and got Y" has
 * everything it needs. Consecutive same-role entries are merged, and the
 * oldest turns go first when the whole thing exceeds `LIVE_SEED_MAX_CHARS`.
 */
export function eventsToSeedTurns(events: readonly AgentEvent[]): GeminiLiveSeedTurn[] {
  const turns: GeminiLiveSeedTurn[] = [];
  const push = (role: GeminiLiveSeedTurn['role'], text: string): void => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n${trimmed}`;
    else turns.push({ role, text: trimmed });
  };
  const toolNames = new Map<string, string>();
  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
        push('user', stripSpokenSummaryInstruction(event.text) || (event.image ? '[sent an image]' : ''));
        break;
      case 'text':
        push('model', stripSpokenSummary(event.text));
        break;
      case 'tool_use':
        toolNames.set(event.id, event.summary || event.name);
        break;
      case 'tool_result': {
        const call = toolNames.get(event.toolUseId) ?? 'a tool';
        const content =
          event.content.length > LIVE_SEED_TOOL_RESULT_CHARS
            ? `${event.content.slice(0, LIVE_SEED_TOOL_RESULT_CHARS)}…`
            : event.content;
        push('model', `[I called ${call}${event.isError ? ', which failed' : ''}: ${content}]`);
        break;
      }
      default:
        break;
    }
  }
  let total = turns.reduce((sum, t) => sum + t.text.length, 0);
  while (total > LIVE_SEED_MAX_CHARS && turns.length > 1) {
    total -= turns.shift()!.text.length;
  }
  return turns;
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
        if (event.image) {
          const parts: PlannerUserContentPart[] = [
            {
              type: 'image_url',
              image_url: { url: `data:${event.image.mediaType};base64,${event.image.data}` },
            },
            ...(event.text ? [{ type: 'text' as const, text: event.text }] : []),
          ];
          messages.push({ role: 'user', content: parts });
        } else {
          messages.push({ role: 'user', content: event.text });
        }
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

/** One independently-configurable piece of the persona system message —
    kept apart so `PlannerChatService.previewContext` (PA-59) can show and
    size each piece separately; `buildPersonaSystemMessage` below joins them
    back into the single string a real turn actually sends, so the two can
    never drift on what a section's label or content is. */
interface PersonaSection {
  id: 'identity' | 'about' | 'toolsEnvironment';
  label: string;
  text: string;
}

/**
 * PA-45: this agent's own `identityPrompt`, the global `me` (who the
 * operator is) and `tools` (their environment) instructions — a section with
 * nothing configured is simply omitted from the result, not returned as an
 * empty entry.
 */
function personaSections(
  workspace: PlannerWorkspaceRow | null,
  settings: Pick<PlannerSettingsSnapshot, 'meInstruction' | 'toolsInstruction'>,
): PersonaSection[] {
  const sections: PersonaSection[] = [];
  if (workspace?.identityPrompt) {
    sections.push({ id: 'identity', label: 'Who you are', text: workspace.identityPrompt });
  }
  if (settings.meInstruction) {
    sections.push({ id: 'about', label: 'About the person you are helping', text: settings.meInstruction });
  }
  if (settings.toolsInstruction) {
    sections.push({ id: 'toolsEnvironment', label: 'About their tools and environment', text: settings.toolsInstruction });
  }
  return sections;
}

/**
 * PA-45: combines `personaSections`' pieces into one system message — `null`
 * when all three are unset, so `driveLoop` skips injecting anything at all
 * rather than an empty/near-empty system message. Each section is labelled
 * so the model can tell "who I am" from "who I'm talking to" from "what's in
 * their environment" rather than treating all three as one undifferentiated
 * blob.
 */
function buildPersonaSystemMessage(
  workspace: PlannerWorkspaceRow | null,
  settings: Pick<PlannerSettingsSnapshot, 'meInstruction' | 'toolsInstruction'>,
): string | null {
  const sections = personaSections(workspace, settings);
  return sections.length > 0 ? sections.map((s) => `${s.label}:\n${s.text}`).join('\n\n') : null;
}

/**
 * PA-59: a human-readable, no-LLM-call summary of the enabled tool/meta-tool
 * catalog for the context-preview panel's "anything else in context?"
 * section — there is no existing prose system-prompt text for this today
 * (a tool's `description` reaches the model only via the `tools`
 * JSON-schema param sent alongside the messages, never as system-prompt
 * text), so this is a display-only stand-in rather than a section that
 * mirrors something `driveLoop` actually sends. Grouped by `readOnly` since
 * that is the one distinction this codebase's own approval gate cares
 * about — a mutating tool is "subject to approval unless remembered/yolo'd,"
 * a read-only one never is.
 */
function summarizeEnabledTools(tools: readonly PlannerToolDefinition[]): string {
  const readOnly = tools.filter((t) => t.readOnly).map((t) => t.name);
  const mutating = tools.filter((t) => !t.readOnly).map((t) => t.name);
  const lines = [`${tools.length} tool${tools.length === 1 ? '' : 's'} enabled for this agent.`];
  if (readOnly.length > 0) lines.push(`Read-only: ${readOnly.join(', ')}`);
  if (mutating.length > 0) lines.push(`Mutating (subject to approval unless remembered/yolo'd): ${mutating.join(', ')}`);
  return lines.join('\n');
}
