import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CALL_MCP_TOOL_NAME,
  LIST_MCP_TOOLS_NAME,
  LIST_SKILLS_NAME,
  USE_SKILL_NAME,
  UpdateSettingsRequest,
  UpdateWebhookRequest,
  UpdateCronJobRequest,
  UpdateCustomClaudeProviderRequest,
  UpdateTelegramBotRequest,
  isTerminalStatus,
  type AgentEvent,
  type SessionInfo,
} from '@pocketagent/protocol';
import { isContained, type WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import { readSessionHistory, type SessionHistoryDeps } from '../sessions/history.js';
import { stripAnsi } from '../terminal/classifier.js';
import type { WorktreeService } from '../git/worktree.js';
import { WorktreeError } from '../git/worktree.js';
import { treeRootOf } from '../git/worktree-paths.js';
import { buildChildEnv } from '../sessions/env.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';
import type { McpRegistryService } from './mcp/registry-service.js';
import { SkillRegistryError, type SkillRegistryService } from './skills.js';
import type { Db } from '../db/index.js';
import type { Config } from '../config/index.js';
import {
  SETTINGS_FIELDS,
  dtoKeyFor,
  fromDtoValue,
  writeSettingsField,
  buildRuntimeSettingsSnapshot,
} from '../settings/index.js';
import type { WebhookService } from '../webhooks/index.js';
import { WebhookServiceError } from '../webhooks/index.js';
import { resolveWebhookUpdatePatch } from '../routes/webhooks.js';
import type { CronService } from '../cron/index.js';
import { CronServiceError } from '../cron/index.js';
import { resolveCronJobUpdatePatch } from '../routes/cron.js';
import type { CustomClaudeProviderStore } from '../agents/custom-providers-store.js';
import { CustomClaudeProviderError } from '../agents/custom-providers-store.js';
import type { TelegramBotStore } from '../telegram/bots-store.js';
import { TelegramBotError } from '../telegram/bots-store.js';

/**
 * PA-6: the planner's tool catalog.
 *
 * Phase 3 added the read-only tools (`readOnly: true`), which skip the
 * approval gate entirely per the reporter's answer to open question 1 ("yes
 * please, let's skip gate for those read tools call"). Phase 4 added the
 * mutating ones — `send_instruction`, `write_file`, `mkdir`, `rmdir`,
 * `delete_worktree` — which `approval.ts` gates before `PlannerChatService`
 * ever calls `execute()` on them. Phase 5 adds `exec_command`, the highest-risk
 * tool here, gated exactly like the others per the reporter's answer to open
 * question 2 — no special-cased narrower "remember" scope for it.
 *
 * Each tool executes against the *existing* PocketAgent subsystems
 * (`WorkspaceRegistry`, `SessionManager`, `WorktreeService`) — per the plan,
 * the planner treats other sessions as sub-agents rather than owning a
 * parallel notion of "workspace" or "session" for them. File tools
 * additionally accept a planner workspace path, since the planner's own
 * scratch space is just as legitimate a target.
 *
 * PA-31 adds `web_search` and `url_fetch` — the first tools here that call
 * *outside* this machine rather than against another PocketAgent subsystem.
 * Both are read-only (an outbound HTTP read changes nothing this system
 * tracks) and both refuse rather than call anywhere until an operator has
 * configured and enabled their own provider in Settings -> Pocket Agent
 * (`PlannerToolDeps.webSearch`/`.urlFetch`, backed by `planner/store.ts`'s
 * `PLANNER_WEB_SEARCH_*`/`PLANNER_URL_FETCH_*` settings) — there is no
 * built-in default endpoint, so a fresh deployment cannot silently exfiltrate
 * anything on a model's say-so.
 *
 * PA-34 adds `get_current_time`, read-only and side-effect-free (it touches
 * no PocketAgent subsystem, just the host clock and `Intl`), so a chat can
 * ground "today"/"now"/a relative date against the host's actual wall clock
 * and timezone instead of the model guessing from its training cutoff.
 *
 * PA-44 adds two independent things. `grep_files`/`find_files` are plain
 * read-only search over the same containment boundary `read_file` already
 * enforces — no new trust model, just two more ways to look inside it.
 * `list_subagents`, `start_subagent_session` and `get_subagent_status` are
 * the "agent to agent" half: `list_subagents` (read-only) enumerates every
 * *configured* subagent — Pocket Agent workspaces and coding agents — so a
 * turn can pick one before committing to it; `start_subagent_session`
 * (mutating, gated) hands one an initial task and returns a handle
 * immediately rather than blocking the calling turn on however long the
 * subagent takes; `get_subagent_status` (read-only) is how a later turn
 * checks whether that handle is done yet. A coding-agent subagent is nothing
 * new — it is the same session `send_instruction` already treats as a
 * sub-agent, just freshly created rather than existing — but a Pocket Agent
 * spawning *another* Pocket Agent chat is: nothing before this could create
 * an unattached chat from inside a tool call, so `PlannerToolDeps.spawnDepth`
 * (read from `PlannerChatService`'s own in-memory, restart-resets-to-zero
 * bookkeeping — the same durability tradeoff `pendingTurns`/`observers`
 * already make) and `MAX_SUBAGENT_SPAWN_DEPTH` below exist specifically to
 * bound how deep that chain can go before anything is actually built to spawn
 * one.
 */

export interface PlannerToolDeps {
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  worktrees: WorktreeService;
  historyDeps: SessionHistoryDeps;
  /** The configured shell binary, for `exec_command`. */
  shell: string;
  /** PA-29: the memory service, for `memory_save`/`memory_search`. */
  memory: PlannerMemoryService;
  /**
   * PA-29: the workspace the calling chat belongs to right now.
   *
   * Added as its own field rather than widening `execute`'s own arity
   * (`PlannerChatService.executeTool` is the one call site that builds this
   * object, and it already has `chat.workspaceId` in scope) — every
   * existing tool ignores it and keeps compiling unchanged. `null` for an
   * orphaned chat whose workspace was since deleted; the memory tools below
   * refuse in that case rather than guessing which agent's memory to touch,
   * the same refusal `send_instruction`/`delete_worktree` already give for
   * their own "can't resolve what this needs" cases.
   */
  workspaceId: string | null;
  /**
   * PA-31: the `web_search`/`url_fetch` tools' own provider config, read
   * fresh per call by `PlannerChatService.executeTool` (like
   * `workspaceId` above, this is rebuilt every call rather than cached on
   * the deps object across calls) — a toggle or key flipped in Settings
   * must take effect on the very next call. `baseUrl: null` or
   * `enabled: false` means "not configured"; each tool's own `execute`
   * refuses rather than throwing.
   */
  webSearch: ToolIntegrationConfig;
  urlFetch: ToolIntegrationConfig;
  /** Injected in tests so no real network call is ever made; defaults to
      the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * PA-34: `get_current_time`'s clock. Injected in tests so an assertion
   * doesn't race the real clock (same reasoning as `fetchImpl` above);
   * defaults to `() => new Date()`, i.e. the host's real wall clock.
   */
  now?: () => Date;
  /**
   * PA-37: the MCP registry catalog/dispatcher `list_mcp_tools`/
   * `call_mcp_tool` are built on. Threaded through the same way `memory`/
   * `worktrees` are — one shared instance, read fresh on every call so a
   * registry created, disabled, or reconnected mid-conversation takes effect
   * on the very next turn.
   */
  mcpRegistry: McpRegistryService;
  /**
   * PA-38: the skills catalog `list_skills`/`use_skill` are built on.
   * Threaded through the same way `mcpRegistry` is — one shared instance,
   * read fresh on every call so a skill registered, disabled, or edited on
   * disk mid-conversation takes effect on the very next turn.
   */
  skills: SkillRegistryService;
  /** PA-44: the coding-agent catalog, for `list_subagents` — the same
      registry `GET /api/agents` reads, so a subagent's listed abilities
      (transports, static models, availability) never disagree with what the
      composer's own model picker shows for that agent. */
  agents: AgentRegistry;
  /**
   * PA-56: `read_settings`/`update_settings`'s own view of the
   * `SETTINGS_FIELDS`-backed rows `PATCH /api/settings` writes — the exact
   * same `db`/`config` pair that route uses, threaded here so a chat can read
   * or change a setting (e.g. rewire a Jira webhook's project map, per the
   * reporter's own example) without a human going to the Settings page.
   * `skipPermissionsEnabled` is deliberately unreachable through either tool:
   * it is not one of `SETTINGS_FIELDS`, `update_settings`'s own `execute`
   * refuses it explicitly if a call names it anyway, and there is no code
   * path here that could call `SessionManager.setGlobalSkipPermissions` even
   * by accident — see that tool's doc comment for why this is not merely a
   * validation check but a decision never to widen.
   */
  db: Db;
  config: Config;
  /** PA-56: `read_settings`'s own listing and `update_custom_claude_provider`'s
      target — the same store `GET`/`PATCH /api/custom-claude-providers` use.
      Its own `list()`/`get()`/`update()` already redact the API key (no
      reveal endpoint exists anywhere in this app), and the tool's own
      parameter schema never exposes an `apiKey` field at all, so a turn has
      no way to make a plaintext key part of this chat's persisted
      transcript — see `update_custom_claude_provider`'s doc comment. */
  customClaudeProviders: CustomClaudeProviderStore;
  /** PA-56: the Telegram bot half of `read_settings`/`update_telegram_bot` —
      same redaction posture as `customClaudeProviders` above (no `botToken`
      parameter on the tool, ever). `null` only for a test that builds
      `PlannerToolDeps` directly without it; every real request has it, since
      `app.ts` constructs it well before `plannerChats`. */
  telegramBots: TelegramBotStore | null;
  /**
   * PA-56: `read_settings`'s listing and `update_webhook`'s target — the
   * same service `GET`/`PATCH /api/webhooks` use, so the tool runs through
   * `resolveWebhookUpdatePatch` (`routes/webhooks.ts`), the exact validation
   * (slug format, cwd containment, agent-transport rules, Bamboo/hmac
   * rejection, project/plan-map dedup) that route itself runs, rather than a
   * second copy that could drift from it. `null` briefly at boot and in any
   * test that never calls `PlannerChatService.attachRunServices` — see that
   * method's own doc comment for why `webhooks`/`cron` are the one pair of
   * dependencies here that cannot be threaded through a constructor. Both
   * tools refuse cleanly when this is `null` rather than throwing.
   */
  webhooks: WebhookService | null;
  /** PA-56: the scheduled-job half of `read_settings`/`update_cron_job` —
      see `webhooks`'s own doc comment just above for why this is nullable. */
  cron: CronService | null;
  /** PA-44: `start_subagent_session`/`get_subagent_status`'s escape hatch for
      the one thing this file cannot do on its own — create or inspect
      *another Pocket Agent chat*, which is `PlannerChatService`'s state, not
      this module's. See `PlannerSubagentDeps`'s own doc comment. */
  subagents: PlannerSubagentDeps;
  /**
   * PA-44: how many Pocket-Agent-spawned-Pocket-Agent hops separate the
   * *calling* chat from a human. `0` for every chat a human started (the
   * overwhelming majority); `start_subagent_session`'s `pocket_agent` branch
   * refuses once this reaches `MAX_SUBAGENT_SPAWN_DEPTH`, which is the only
   * thing standing between this feature and an agent that spawns an agent
   * that spawns an agent forever — nothing else in this codebase has ever
   * needed a recursion guard, because nothing before this let a tool call
   * create a brand-new, unattached conversation.
   */
  spawnDepth: number;
  /** PA-75: the calling planner chat id, for subagent provenance. */
  plannerChatId?: string | null;
  /**
   * PA-74: Configurable cap on how many subagents may be spawned during a
   * single turn. Falls back to `MAX_SUBAGENT_SPAWNS_PER_TURN` if unset.
   */
  maxSubagentSpawnsPerTurn?: number;
  /**
   * PA-53: `send_telegram_message`'s own view of the world — every currently
   * paired Telegram id (across every configured bot) it may address, and how
   * to actually deliver to one. Rebuilt fresh per call by
   * `PlannerChatService.executeTool`, the same "read live configuration on
   * every call" posture `webSearch`/`urlFetch` already take, so a pairing
   * added or removed in Settings mid-conversation takes effect on the very
   * next call rather than requiring a fresh chat.
   */
  telegram: PlannerTelegramDeps;
}

/** See `PlannerToolDeps.telegram`'s own doc comment. */
export interface PlannerTelegramDeps {
  /** Every currently paired Telegram id. `send_telegram_message` may only
      address one of these — never an arbitrary id typed into the argument —
      the same "the model choosing to call something is not this server's
      decision to trust unchecked" posture `exec_command`'s own input
      validation already takes. */
  links: readonly { botId: string; telegramChatId: string; label: string | null }[];
  /** Deliver `text` to `telegramChatId` via `botId`'s bot. Never throws —
      failure (bad token, Telegram API error, network) comes back as
      `{ ok: false, error }` so the tool can fold it into its result text the
      same way every other refusal here does. */
  send(botId: string, telegramChatId: string, text: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * PA-44: the planner-tool-facing surface of "create or check on another
 * Pocket Agent chat" — implemented by `PlannerChatService` (see
 * `startSubagentChatForTool`/`subagentChatStatusForTool`), not here, because
 * only that service owns chat creation, the turn loop, and the transcript a
 * status check reads. Kept to exactly the two operations a tool call needs,
 * rather than handing the whole service down: a tool should not be able to
 * do anything to another chat that isn't mediated by this narrow seam.
 */
export interface PlannerSubagentDeps {
  /** Creates a new chat in `workspaceId` and starts it on `prompt`,
      returning as soon as the chat exists — see `start_subagent_session`'s
      doc comment for why this does not wait for the subagent's own turn to
      finish. Throws (never resolves to an error string) so the tool's own
      `execute` can fold the message into its result the same way every
      other refusal here does. */
  startPocketAgentChat(workspaceId: string, prompt: string): Promise<{ chatId: string }>;
  /** Reads back whether a chat started this way has finished its turn yet —
      see `get_subagent_status`'s doc comment for the status values. */
  pocketAgentChatStatus(chatId: string): Promise<SubagentChatStatus>;
  /**
   * PA-44: the tool names actually enabled for a Pocket Agent workspace
   * right now — the reporter's own "combine with available tools ... main
   * agent can pick correct subagent" ask for `list_subagents`. Delegates to
   * `PlannerChatService.toolsFor` (global *and* per-agent disabled sets
   * already applied, PA-6 round 5) rather than this file re-deriving that
   * filtering from the disabled-tool tables directly, so the two can never
   * disagree about which tools a given agent's own turns actually see.
   * Synchronous — `toolsFor` touches no I/O — unlike the two methods above.
   */
  pocketAgentEnabledTools(workspaceId: string): string[];
  /**
   * PA-74: Find any live coding-agent subagent session already started by this
   * chat for the working tree rooted at `treeRoot`.
   */
  findLiveCodingSubagent?(treeRoot: string): { id: string; status: 'running' | 'idle' } | null;
  /**
   * PA-74: Record a coding-agent subagent session started by this chat.
   */
  recordCodingSubagent?(sessionId: string, cwd: string): void;
  /**
   * PA-74: How many subagents (pocket or coding) have been spawned in the current turn.
   */
  spawnsThisTurn?(): number;
  /**
   * PA-74: Record that a subagent was spawned during the current turn.
   */
  recordSpawn?(): void;
  /**
   * PA-76: Record a subagent action (spawn or instruction) that consumes wake budget.
   */
  recordAction?(): void;
  /**
   * PA-76: Re-track a coding subagent session with a parent chat.
   */
  trackCodingSubagent?(sessionId: string, parentChatId: string): void;
  /**
   * PA-76: Invalidate cached status for a coding subagent session when new work begins.
   */
  invalidateCodingStatus?(sessionId: string): void;
  /**
   * PA-76: Cached status for a coding-agent subagent from SubagentSupervisor.
   */
  codingAgentStatus?(id: string): SubagentChatStatus | null;
  /**
   * PA-76: Whether the action budget for wake-driven turns has been exhausted.
   */
  wakeBudgetExhausted?(): boolean;
  /**
   * PA-78: Checks whether get_subagent_status has already been called for this subagent
   * during the current turn with no change in state.
   */
  checkSubagentStatusTurn?(
    kind: 'coding_agent' | 'pocket_agent',
    id: string,
    state: { busy: boolean; busyForMs?: number | null; lastActivityAt?: number | null; summary?: string },
  ): { shortCircuit: false } | { shortCircuit: true; message: string };
  /**
   * PA-78: Checks whether read_session_output has already been called for this tracked subagent
   * session during the current turn with no change in output.
   */
  checkSessionOutputTurn?(
    sessionId: string,
    info: SessionInfo,
  ): { shortCircuit: false } | { shortCircuit: true; message: string };
  /**
   * PA-78: Check if a session id is a tracked subagent session for this chat.
   */
  isTrackedSubagentSession?(sessionId: string): boolean;
  /**
   * PA-78: Schedule a non-blocking timer to wake this chat after seconds.
   */
  scheduleCheckBackIn?(seconds: number): { ok: true } | { ok: false; error: string };
  /**
   * PA-78: Stop/terminate a subagent session or chat.
   */
  stopSubagent?(kind: 'coding_agent' | 'pocket_agent', id: string): Promise<{ ok: boolean; message: string }>;
}

/** One `get_subagent_status` answer for a subagent handle. `'gone'`
    covers both an unknown id and a chat/session since deleted — indistinguishable to
    a caller, and both mean "nothing left to check on". */
export interface SubagentChatStatus {
  status: 'running' | 'paused_for_approval' | 'done' | 'error' | 'idle' | 'exited' | 'gone';
  summary: string;
  busyForMs?: number | null;
  lastOutputAgoMs?: number | null;
  pendingApprovals?: number;
  lastActivityAt?: number | null;
}

/** PA-44: see `PlannerToolDeps.spawnDepth`'s doc comment. Exported so
    `PlannerChatService` can apply the same limit defensively on its own side
    of `subagents.startPocketAgentChat` — belt and suspenders, the same
    "the model choosing to call something is not this server's decision to
    trust unchecked" posture the disabled-tool checks already take. */
export const MAX_SUBAGENT_SPAWN_DEPTH = 2;

/** PA-74: Maximum subagents (pocket or coding) a chat can spawn in a single turn.
    Stops a confused turn from looping on start_subagent_session and exhausting MAX_SESSIONS. */
export const MAX_SUBAGENT_SPAWNS_PER_TURN = 3;

/** PA-31: one third-party HTTP integration's live config — see
    `PlannerToolDeps.webSearch`/`.urlFetch`. */
export interface ToolIntegrationConfig {
  enabled: boolean;
  baseUrl: string | null;
  apiKey: string | null;
}

/** The "not configured" value of `ToolIntegrationConfig` — exported so a
    test building a `PlannerToolDeps` for a tool that doesn't care about
    `web_search`/`url_fetch` (most of the catalog) can fill the two required
    fields with one shared constant rather than repeating this shape. */
export const TOOL_INTEGRATION_DISABLED: ToolIntegrationConfig = {
  enabled: false,
  baseUrl: null,
  apiKey: null,
};

export interface PlannerToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, sent to the LLM verbatim as the function's `parameters`. */
  parameters: Record<string, unknown>;
  readOnly: boolean;
  execute: (deps: PlannerToolDeps, args: Record<string, unknown>) => Promise<string>;
}

/** Caps how much of a tool's result is fed back to the LLM — a runaway
    transcript or a large file must not blow out the next request's body. */
const MAX_TOOL_RESULT_CHARS = 20_000;
/** Exported so `planner/skills.ts`'s `loadSkillBody` caps a skill's body at
    the same limit `read_file` caps a file at, rather than inventing a second
    number that would drift from it. */
export const MAX_FILE_READ_BYTES = 200_000;
const MAX_FILE_WRITE_CHARS = 200_000;
/** A chat turn is a synchronous HTTP request/response — a runaway command
    must not hang it forever. */
const EXEC_TIMEOUT_MS = 60_000;
/** PA-31: same reasoning as `EXEC_TIMEOUT_MS`, shorter — a third-party
    search/fetch call has no reason to run anywhere near a minute, and a
    tighter cap keeps one slow provider from stalling a whole chat turn. */
const TOOL_HTTP_TIMEOUT_MS = 20_000;
/** PA-44: `grep_files`/`find_files` walk a real directory tree rather than
    calling out to a network, so this is closer to `TOOL_HTTP_TIMEOUT_MS`
    than to `EXEC_TIMEOUT_MS` — a search that hasn't finished in 20s is far
    more likely mis-scoped (too shallow a `path`, too broad a pattern) than
    genuinely still working. */
const SEARCH_TIMEOUT_MS = 20_000;
/** PA-44: caps how many matches/paths `grep_files`/`find_files` hand back
    before `MAX_TOOL_RESULT_CHARS` even gets a chance to bite — a result list
    this long is a sign the search needs narrowing, not more room. */
const MAX_SEARCH_RESULTS = 300;

/** Keeps the head — used for file reading, grep, and search results. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
}

/** PA-76: Keeps the tail for subagent results and summaries so conclusions aren't lost. */
export function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…(truncated, ${text.length - max} earlier characters)\n${text.slice(-max)}`;
}

/** PA-76: Trailer appended to subagent prompts asking for a structured result summary. */
export const SUBAGENT_RESULT_TRAILER =
  '\n\nWhen you have completed your task, please end your final message with a `## RESULT` section covering:\n' +
  '- What changed\n' +
  '- What was verified\n' +
  '- What could not be done or remains open';

/**
 * PA-76: Extracts the content under a `## RESULT` section if present.
 * Exported for direct unit testing.
 */
export function extractResultSummary(text: string): string | null {
  const resultTagMatch = text.match(/<result>([\s\S]*?)<\/result>/i);
  const tagContent = resultTagMatch?.[1]?.trim();
  if (tagContent) return tagContent;
  const match = text.match(/(?:^|\n)##\s+RESULT\b[^\n]*(?:\r?\n([\s\S]*))?$/i);
  if (!match) return null;
  const result = (match[1] ?? '').trim();
  return result.length > 0 ? result : null;
}

/**
 * PA-76: Returns the subagent's own last message summary:
 * Prefers the content of `## RESULT` from the last assistant message;
 * falls back to the full last assistant message;
 * falls back to `summarizeEvents` only if no assistant text event exists.
 * Exported for direct unit testing.
 */
export function lastMessageSummary(events: readonly AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.kind === 'text') {
      const result = extractResultSummary(ev.text);
      return truncateTail(result ?? ev.text, MAX_TOOL_RESULT_CHARS);
    }
  }
  return truncateTail(summarizeEvents(events), MAX_TOOL_RESULT_CHARS);
}

/** Exported for direct unit testing — see `tests/planner-tools.test.ts`. */
export function summarizeEvents(events: readonly AgentEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.kind) {
      case 'user_prompt':
        lines.push(`[user] ${event.text}`);
        break;
      case 'text':
        lines.push(`[assistant] ${event.text}`);
        break;
      case 'tool_use':
        lines.push(`[tool call] ${event.summary}`);
        break;
      case 'tool_result':
        if (event.content.trim().length > 0) {
          lines.push(`[tool result${event.isError ? ' (error)' : ''}] ${event.content}`);
        }
        break;
      case 'notice':
        lines.push(`[${event.level}] ${event.text}`);
        break;
      default:
        // Every other kind (deltas, lifecycle/meta events) carries nothing a
        // one-shot summary needs — see this file's doc comment.
        break;
    }
  }
  return lines.length > 0 ? lines.join('\n') : '(no transcript content yet)';
}

/**
 * The body of `read_session_output`, factored out so `get_subagent_status`'s
 * `coding_agent` branch (PA-44) can report the same summary once a spawned
 * session is done, rather than re-deriving "live buffer vs. on-disk history,
 * terminal vs. structured" a second time. Assumes the caller already
 * confirmed the id resolves to a real session (`read_session_output` and
 * `get_subagent_status` each do this their own way, since one refuses before
 * calling this and the other has already read `SessionInfo` to get here).
 */
async function sessionOutputSummary(deps: PlannerToolDeps, sessionId: string): Promise<string> {
  const live = deps.sessions.get(sessionId);
  if (live) {
    if (live.transport === 'terminal') {
      const raw = live.buffer.replayAfter(0).data;
      const text = stripAnsi(raw).trim();
      if (text.length === 0) return '(no terminal output yet)';
      return truncate(text, MAX_TOOL_RESULT_CHARS);
    }
    const buffered = live.buffer.replayAfter(0).events.map((e) => e.event);
    const { events: priorEvents } = await readSessionHistory(deps.historyDeps, sessionId);
    const allEvents = [...priorEvents, ...buffered];
    if (allEvents.length === 0) {
      return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
    }
    return truncate(summarizeEvents(allEvents), MAX_TOOL_RESULT_CHARS);
  }
  const { conversationId, events } = await readSessionHistory(deps.historyDeps, sessionId);
  if (!conversationId || events.length === 0) {
    return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
  }
  return truncate(summarizeEvents(events), MAX_TOOL_RESULT_CHARS);
}

/**
 * PA-76: Returns the last-message summary for a coding subagent session.
 */
async function sessionLastResultSummary(deps: PlannerToolDeps, sessionId: string): Promise<string> {
  const live = deps.sessions.get(sessionId);
  if (live) {
    if (live.transport === 'terminal') {
      const raw = live.buffer.replayAfter(0).data;
      const text = stripAnsi(raw).trim();
      if (text.length === 0) return '(no terminal output yet)';
      return truncateTail(text, MAX_TOOL_RESULT_CHARS);
    }
    const buffered = live.buffer.replayAfter(0).events.map((e) => e.event);
    const { events: priorEvents } = await readSessionHistory(deps.historyDeps, sessionId);
    const allEvents = [...priorEvents, ...buffered];
    if (allEvents.length === 0) {
      return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
    }
    return lastMessageSummary(allEvents);
  }
  const { conversationId, events } = await readSessionHistory(deps.historyDeps, sessionId);
  if (!conversationId || events.length === 0) {
    return 'This session has no readable transcript yet (it has not resumed or produced a conversation).';
  }
  return lastMessageSummary(events);
}

function isWithinTrustedRoot(deps: PlannerToolDeps, real: string): boolean {
  return deps.workspaces.getRoots().some((root) => isContained(root, real)) || deps.plannerWorkspaces.contains(real);
}

/**
 * Resolves a path that must already exist against either boundary this
 * server already trusts: an added project workspace (`WorkspaceRegistry`) or
 * a planner workspace (`PlannerWorkspaceRegistry`). Realpath first, then
 * check containment with the shared `isContained` primitive — never a
 * string-prefix check, and deliberately **not**
 * `WorkspaceRegistry.resolveWorkspacePath`, which requires its target to be a
 * *directory* (it exists to validate a session's cwd); a file needs the same
 * containment check applied to something `resolveWorkspacePath` would itself
 * reject.
 */
async function resolveExistingPathWithin(deps: PlannerToolDeps, requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new Error(`Cannot resolve path: ${requested}`);
  }
  if (!isWithinTrustedRoot(deps, real)) {
    throw new Error(`${requested} is outside every project workspace and every planner workspace.`);
  }
  return real;
}

/**
 * Resolves a path that may not exist yet (for a file/directory about to be
 * created), by walking up to the nearest ancestor that *does* exist,
 * containment-checking that ancestor's realpath, and rebuilding the full
 * target from it. The rebuilt suffix cannot itself be a symlink — none of it
 * exists yet — so checking only the existing ancestor is sound, the same
 * reasoning `WorktreeService.create()` relies on for a freshly-minted
 * worktree path.
 */
async function resolveCreatablePath(deps: PlannerToolDeps, requested: string): Promise<string> {
  const absolute = path.resolve(requested);
  let probe = absolute;
  let real: string | null = null;
  while (real === null) {
    try {
      real = await fs.realpath(probe);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) throw new Error(`Cannot resolve any existing ancestor of ${requested}.`);
      probe = parent;
    }
  }
  if (!isWithinTrustedRoot(deps, real)) {
    throw new Error(`${requested} is outside every project workspace and every planner workspace.`);
  }
  const suffix = path.relative(probe, absolute);
  return suffix ? path.join(real, suffix) : real;
}

/** The result of one `postJsonToIntegration` call — exported alongside it so
    a caller (a tool's own `execute`, or `routes/planner.ts`'s "Test
    search"/"Test fetch" buttons) can share the exact same success/failure
    shape rather than each declaring its own. */
export type JsonIntegrationResult = { ok: true; json: unknown } | { ok: false; message: string };

/**
 * PA-31: one POST-JSON round trip to a third-party integration
 * (`web_search`'s search endpoint, `url_fetch`'s scrape endpoint) — both
 * tools share this rather than each rolling their own fetch/timeout/error
 * handling. Exported so `routes/planner.ts`'s test-connection routes can
 * reuse it too, rather than re-implementing the same timeout/bearer-token/
 * error-shape logic a second time for what is, from the provider's point of
 * view, an identical request. The API key, when present, is sent as a
 * bearer token (`v1/search`-/Firecrawl-style endpoints both expect that),
 * and its absence just omits the header rather than sending an empty one —
 * the reporter's own example configures `url_fetch` against a Firecrawl
 * instance that needs no key at all.
 *
 * Never throws: every failure mode (bad URL, non-2xx, non-JSON body,
 * timeout, network error) resolves to `{ ok: false, message }`, so a
 * misconfigured or unreachable provider becomes a tool result the model
 * can see and explain, not an uncaught exception `executeTool`'s own
 * catch-all would otherwise have to paper over identically anyway.
 */
export async function postJsonToIntegration(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string | null,
  body: Record<string, unknown>,
): Promise<JsonIntegrationResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOOL_HTTP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${truncate(text, 500)}` };
    }
    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return { ok: false, message: `Response was not valid JSON: ${truncate(text, 500)}` };
    }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      message: timedOut
        ? `Request timed out after ${TOOL_HTTP_TIMEOUT_MS / 1000}s.`
        : `Request failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export const PLANNER_TOOLS: readonly PlannerToolDefinition[] = [
  // ---- Read-only (PA-6 phase 3) ---------------------------------------------
  {
    name: 'list_workspaces',
    description: "List the project folders (workspaces) PocketAgent's coding agents can run in.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const entries = await deps.workspaces.list();
      return JSON.stringify(
        entries.map((e) => ({ path: e.path, name: e.name, isGitRepo: e.isGitRepo })),
      );
    },
  },
  {
    name: 'list_sessions',
    description:
      'List PocketAgent coding-agent sessions (running or finished), each a potential sub-agent to inspect or instruct.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of sessions to return (default 50).' },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const limit = typeof args.limit === 'number' ? args.limit : 50;
      const list: SessionInfo[] = deps.sessions.list(limit);
      return JSON.stringify(
        list.map((s) => ({
          id: s.id,
          title: s.title,
          agent: s.agent,
          status: s.status,
          cwd: s.cwd,
          transport: s.transport,
          lastActivityAt: s.lastActivityAt,
        })),
      );
    },
  },
  {
    name: 'read_session_output',
    description: "Read a session's transcript so far, to judge what its agent has done.",
    parameters: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'A session id from list_sessions.' } },
      required: ['sessionId'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const sessionId = String(args.sessionId ?? '');
      const info = deps.sessions.find(sessionId);
      if (!info) return `No session found with id ${sessionId}.`;
      const isTracked =
        (deps.plannerChatId && info.plannerChatId === deps.plannerChatId) ||
        (deps.subagents.isTrackedSubagentSession?.(sessionId) ?? false);
      if (info.busy && isTracked) {
        const shortCircuit = deps.subagents.checkSessionOutputTurn?.(sessionId, info);
        if (shortCircuit?.shortCircuit) {
          return shortCircuit.message;
        }
      }
      return sessionOutputSummary(deps, sessionId);
    },
  },
  {
    name: 'read_file',
    description:
      'Read a text file. The path must be inside an added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const real = await resolveExistingPathWithin(deps, requested);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return `${requested} is not a file.`;
      if (stat.size > MAX_FILE_READ_BYTES) {
        return `${requested} is ${stat.size} bytes, over this tool's ${MAX_FILE_READ_BYTES}-byte limit.`;
      }
      const content = await fs.readFile(real, 'utf8');
      return truncate(content, MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: 'get_current_time',
    description:
      "Get the current date and time on this PocketAgent server's host, and the host's local " +
      'timezone (IANA name and UTC offset). Call this before reasoning about "today", "now", or ' +
      'any relative date/time — the model has no other way to know the current moment or which ' +
      "timezone the host observes it in; the host's timezone, not the caller's, is what governs " +
      'every other tool here (session timestamps, file mtimes).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const now = deps.now ? deps.now() : new Date();
      // Intl (not process.env.TZ, which is frequently unset) is the one
      // source of the host's configured zone that works the same whether
      // this process was started from a login shell, systemd, or a
      // container with no TZ env var at all.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const offsetMinutes = -now.getTimezoneOffset();
      const offsetSign = offsetMinutes >= 0 ? '+' : '-';
      const offsetAbs = Math.abs(offsetMinutes);
      const utcOffset = `${offsetSign}${String(Math.floor(offsetAbs / 60)).padStart(2, '0')}:${String(offsetAbs % 60).padStart(2, '0')}`;
      return JSON.stringify({
        iso: now.toISOString(),
        epochMs: now.getTime(),
        timeZone,
        utcOffset,
        local: now.toLocaleString('en-US', { timeZone }),
      });
    },
  },
  {
    name: 'grep_files',
    description:
      'Search file contents for a pattern under a directory, like `grep -r`. The directory must be ' +
      'inside an added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search under.' },
        pattern: { type: 'string', description: 'A basic regular expression to search for.' },
        caseInsensitive: { type: 'boolean', description: 'Match case-insensitively. Default false.' },
        filePattern: {
          type: 'string',
          description: 'Only search files matching this glob, e.g. "*.ts". Default: every file.',
        },
        maxResults: {
          type: 'number',
          description: `Maximum number of matching lines to return (default 100, capped at ${MAX_SEARCH_RESULTS}).`,
        },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const pattern = String(args.pattern ?? '');
      if (!pattern) return 'No search pattern provided.';
      let real: string;
      try {
        real = await resolveExistingPathWithin(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return `${requested} is not a directory.`;

      // `-I` skips binary files (grep's own heuristic) — a binary match is
      // never something an LLM can usefully act on, and it risks smuggling
      // non-UTF8 bytes into the tool result. Argv array, not a shell string:
      // unlike `exec_command`, the pattern and glob here are never
      // shell-interpreted, so there is nothing for either to inject into.
      const grepArgs = ['-r', '-n', '-I'];
      if (args.caseInsensitive === true) grepArgs.push('-i');
      if (typeof args.filePattern === 'string' && args.filePattern.trim()) {
        grepArgs.push(`--include=${args.filePattern.trim()}`);
      }
      grepArgs.push('--', pattern, '.');

      const result = await runArgvCommand('grep', grepArgs, real, SEARCH_TIMEOUT_MS);
      if (result.timedOut) return `grep timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Narrow path or pattern.`;
      // grep's own exit codes: 0 = matches found, 1 = none found (not an
      // error), 2+ = a real usage/read error.
      if (result.code !== null && result.code > 1) {
        return `grep failed: ${truncate(result.stderr || result.stdout, 500)}`;
      }
      const lines = result.stdout.split('\n').filter((l) => l.length > 0);
      if (lines.length === 0) return 'No matches found.';
      const rawLimit = typeof args.maxResults === 'number' ? Math.round(args.maxResults) : 100;
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, rawLimit));
      const shown = lines.slice(0, limit);
      const suffix =
        lines.length > shown.length ? `\n…(${lines.length - shown.length} more matches — narrow your search)` : '';
      return truncate(shown.join('\n'), MAX_TOOL_RESULT_CHARS) + suffix;
    },
  },
  {
    name: 'find_files',
    description:
      'Find files by name under a directory, like `find -iname`. The directory must be inside an ' +
      'added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search under.' },
        namePattern: { type: 'string', description: 'A glob to match file/directory names, e.g. "*.test.ts".' },
        maxResults: {
          type: 'number',
          description: `Maximum number of paths to return (default 200, capped at ${MAX_SEARCH_RESULTS}).`,
        },
      },
      required: ['path', 'namePattern'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const namePattern = String(args.namePattern ?? '');
      if (!namePattern) return 'No name pattern provided.';
      let real: string;
      try {
        real = await resolveExistingPathWithin(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return `${requested} is not a directory.`;

      const result = await runArgvCommand('find', ['.', '-iname', namePattern], real, SEARCH_TIMEOUT_MS);
      if (result.timedOut) return `find timed out after ${SEARCH_TIMEOUT_MS / 1000}s. Narrow path or pattern.`;
      if (result.code !== 0) return `find failed: ${truncate(result.stderr || result.stdout, 500)}`;
      const lines = result.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => path.join(real, l.replace(/^\.\//, '').replace(/^\.$/, '')));
      if (lines.length === 0) return 'No files found.';
      const rawLimit = typeof args.maxResults === 'number' ? Math.round(args.maxResults) : 200;
      const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, rawLimit));
      const shown = lines.slice(0, limit);
      const suffix =
        lines.length > shown.length ? `\n…(${lines.length - shown.length} more — narrow your search)` : '';
      return truncate(shown.join('\n'), MAX_TOOL_RESULT_CHARS) + suffix;
    },
  },
  {
    name: 'list_subagents',
    description:
      "List every configured subagent this planner can hand work to: this server's Pocket Agent " +
      "workspaces (with each one's own identity/capability description, if it has one) and its coding " +
      'agents, with what each one is (model defaults, memory, transports, availability) — call this ' +
      'before start_subagent_session to pick the right target.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const pocketAgents = deps.plannerWorkspaces.list().map((w) => ({
        kind: 'pocket_agent' as const,
        id: w.id,
        name: w.name,
        isDefault: w.isDefault,
        // PA-45: this agent's own free-text persona/capability description —
        // exactly the "ability" a caller picking a subagent needs, and the
        // reason this tool waited on PA-45 rather than inventing a second
        // description field. `null` (the common case: never auto-populated,
        // see that field's own doc comment) just means this agent has not
        // said anything about itself beyond its name.
        identityPrompt: w.identityPrompt,
        defaultModelId: w.defaultModelId,
        memoryEnabled: w.memoryEnabled,
        // PA-44: the other half of "pick the right subagent" — a Pocket
        // Agent with `exec_command`/`start_subagent_session` disabled is a
        // different tool for routing purposes than one with everything on,
        // even if their identity text reads the same.
        enabledTools: deps.subagents.pocketAgentEnabledTools(w.id),
      }));
      const codingAgents = deps.agents.list().map((a) => ({
        kind: 'coding_agent' as const,
        id: a.id,
        name: a.displayName,
        description: a.description,
        available: a.available,
        transports: a.transports,
        staticModels: a.staticModels,
      }));
      return JSON.stringify({ pocketAgents, codingAgents });
    },
  },
  {
    name: 'get_subagent_status',
    description:
      'Check whether a subagent started with start_subagent_session has finished the task it was ' +
      "given, and read back its latest output if so. Use the same 'kind' and 'id' start_subagent_session " +
      'returned.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['coding_agent', 'pocket_agent'] },
        id: { type: 'string', description: 'The id start_subagent_session returned.' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const id = String(args.id ?? '');
      if (args.kind === 'pocket_agent') {
        const result = await deps.subagents.pocketAgentChatStatus(id);
        if (result.status === 'running') {
          const shortCircuit = deps.subagents.checkSubagentStatusTurn?.('pocket_agent', id, {
            busy: true,
            busyForMs: result.busyForMs,
            lastActivityAt: result.lastActivityAt,
            summary: result.summary,
          });
          if (shortCircuit?.shortCircuit) {
            return shortCircuit.message;
          }
        }
        return truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS);
      }
      const info = deps.sessions.find(id);
      if (!info) return JSON.stringify({ status: 'gone', summary: `No session found with id ${id}.` });
      const now = Date.now();
      const busyForMs = info.busySince != null ? Math.max(0, now - info.busySince) : null;
      const lastOutputAgoMs = info.lastActivityAt != null ? Math.max(0, now - info.lastActivityAt) : null;
      if (info.pendingApprovalsCount > 0) {
        return truncate(
          JSON.stringify({
            status: 'paused_for_approval',
            busyForMs,
            lastOutputAgoMs,
            pendingApprovals: info.pendingApprovalsCount,
            summary: `Waiting on a human to approve ${info.pendingApprovalsCount} tool call(s) — open this session in the Pocket Agent UI to answer.`,
          }),
          MAX_TOOL_RESULT_CHARS,
        );
      }
      if (info.busy) {
        const shortCircuit = deps.subagents.checkSubagentStatusTurn?.('coding_agent', id, {
          busy: true,
          busyForMs,
          lastActivityAt: info.lastActivityAt,
        });
        if (shortCircuit?.shortCircuit) {
          return shortCircuit.message;
        }
        const busySec = busyForMs != null ? Math.round(busyForMs / 1000) : null;
        const outputSec = lastOutputAgoMs != null ? Math.round(lastOutputAgoMs / 1000) : null;
        const busyDetail = busySec != null ? `running ${busySec}s` : 'running';
        const outputDetail = outputSec != null ? `, last output ${outputSec}s ago` : '';
        return truncate(
          JSON.stringify({
            status: 'running',
            busyForMs,
            lastOutputAgoMs,
            pendingApprovals: info.pendingApprovalsCount,
            summary: `Still working on its assigned task (${busyDetail}${outputDetail}).`,
          }),
          MAX_TOOL_RESULT_CHARS,
        );
      }
      const cached = deps.subagents.codingAgentStatus?.(id);
      if (isTerminalStatus(info.status)) {
        const summary =
          cached && (cached.status === 'exited' || cached.status === 'done')
            ? cached.summary
            : await sessionLastResultSummary(deps, id);
        return truncate(
          JSON.stringify({ status: 'exited', sessionStatus: info.status, summary }),
          MAX_TOOL_RESULT_CHARS,
        );
      }
      const summary =
        cached && cached.status === 'idle'
          ? cached.summary
          : await sessionLastResultSummary(deps, id);
      return truncate(
        JSON.stringify({ status: 'idle', summary }),
        MAX_TOOL_RESULT_CHARS,
      );
    },
  },
  {
    name: 'memory_search',
    description:
      "Search this agent's saved memories (short- and long-term) by relevance to a query, so past " +
      'facts, decisions, or preferences can be recalled instead of asked for again.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      if (deps.workspaceId === null) {
        return 'This chat has no agent to search memories for (its workspace was removed).';
      }
      const query = String(args.query ?? '').trim();
      if (!query) return 'No search query provided.';
      const limit = typeof args.limit === 'number' ? args.limit : 5;
      const results = await deps.memory.search(deps.workspaceId, query, { limit });
      return truncate(
        JSON.stringify(
          results.map((r) => ({
            id: r.memory.id,
            content: r.memory.content,
            importance: r.memory.importance,
            tier: r.memory.tier,
            createdAt: r.memory.createdAt,
            score: r.score,
          })),
        ),
        MAX_TOOL_RESULT_CHARS,
      );
    },
  },

  {
    name: 'web_search',
    description:
      'Search the web for up-to-date information, via the operator-configured search provider. ' +
      'Returns raw provider results as JSON; refuses if search is not enabled and configured in ' +
      'Settings -> Pocket Agent.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        limit: { type: 'number', description: 'Maximum number of results to return (default 5).' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    // PA-31: an outbound read against a third-party index — like `read_file`/
    // `list_sessions` above, nothing about *this* system's own state changes,
    // so it is exempt from the approval gate for the same reason those are.
    readOnly: true,
    async execute(deps, args) {
      if (!deps.webSearch.enabled || !deps.webSearch.baseUrl) {
        return 'Web search is not configured. An operator can enable it under Settings -> Pocket Agent.';
      }
      const query = String(args.query ?? '').trim();
      if (!query) return 'No search query provided.';
      const rawLimit = typeof args.limit === 'number' ? Math.round(args.limit) : 5;
      const limit = Math.min(20, Math.max(1, rawLimit));
      const url = `${deps.webSearch.baseUrl.replace(/\/+$/, '')}/v1/search`;
      const result = await postJsonToIntegration(deps.fetchImpl ?? fetch, url, deps.webSearch.apiKey, {
        query,
        limit,
      });
      if (!result.ok) return `Web search failed: ${result.message}`;
      return truncate(JSON.stringify(result.json), MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: 'url_fetch',
    description:
      "Fetch a URL and return its readable content, via the operator-configured fetch provider " +
      '(e.g. a Firecrawl-style scrape endpoint). Refuses if not enabled and configured in ' +
      'Settings -> Pocket Agent.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The URL to fetch.' } },
      required: ['url'],
      additionalProperties: false,
    },
    // Same reasoning as `web_search`: a read against a third-party service,
    // not a change to anything this system tracks.
    readOnly: true,
    async execute(deps, args) {
      if (!deps.urlFetch.enabled || !deps.urlFetch.baseUrl) {
        return 'URL fetch is not configured. An operator can enable it under Settings -> Pocket Agent.';
      }
      const target = String(args.url ?? '').trim();
      if (!target) return 'No URL provided.';
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(target);
      } catch {
        return `${target} is not a valid URL.`;
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return `Refusing to fetch a ${parsedUrl.protocol} URL.`;
      }
      const url = `${deps.urlFetch.baseUrl.replace(/\/+$/, '')}/v1/scrape`;
      const result = await postJsonToIntegration(deps.fetchImpl ?? fetch, url, deps.urlFetch.apiKey, {
        url: target,
      });
      if (!result.ok) return `URL fetch failed: ${result.message}`;
      return truncate(JSON.stringify(result.json), MAX_TOOL_RESULT_CHARS);
    },
  },

  // ---- Mutating (PA-6 phase 4) — each goes through the approval gate --------
  {
    name: 'send_instruction',
    description:
      'Send an instruction (prompt) to an existing PocketAgent session, treating it as a sub-agent. ' +
      'If the session is not currently running, resumes its conversation into a new session first.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'A session id from list_sessions.' },
        prompt: { type: 'string', description: 'The instruction to send.' },
      },
      required: ['sessionId', 'prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      if (deps.subagents.wakeBudgetExhausted?.()) {
        return 'Subagent action budget for wake-driven turns has been exhausted. Wait for a human to continue.';
      }

      const sessionId = String(args.sessionId ?? '');
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'No instruction text provided.';

      const info = deps.sessions.find(sessionId);
      if (!info) return `No session found with id ${sessionId}.`;
      if (info.transport !== 'structured') {
        return `Session ${sessionId} is a terminal session; the planner can only instruct structured sessions.`;
      }

      if (info.status === 'running' || info.status === 'starting') {
        const live = deps.sessions.get(sessionId);
        if (!live || !('prompt' in live)) {
          return `Session ${sessionId} cannot receive prompts right now.`;
        }
        const sent = (live as StructuredLikeSession).prompt(prompt);
        if (sent) {
          deps.subagents.recordAction?.();
          if (deps.plannerChatId) {
            deps.subagents.trackCodingSubagent?.(sessionId, deps.plannerChatId);
          } else {
            deps.subagents.invalidateCodingStatus?.(sessionId);
          }
          return `Instruction sent to running session ${sessionId}.`;
        }
        return `Session ${sessionId} ended before the instruction could be sent.`;
      }

      // Not live: resume into a fresh session. Re-validate `cwd` at call
      // time rather than trusting the value cached on the old session row —
      // the same discipline `RunExecutor.run()` applies before every
      // unattended session start, for the same reason: a folder can be
      // removed from the workspace list, or deleted, long after that row
      // was written.
      if (!info.agentSessionId) return `Session ${sessionId} has no conversation to resume.`;
      let cwd: string;
      try {
        cwd = await deps.workspaces.resolveWorkspacePath(info.cwd);
      } catch (err) {
        return `Cannot resume session ${sessionId}: ${(err as Error).message}`;
      }
      try {
        const resumed = await deps.sessions.create({
          agent: info.agent,
          cwd,
          cols: 0,
          rows: 0,
          transport: 'structured',
          resumeAgentSessionId: info.agentSessionId,
          forkSession: false,
          ...(deps.plannerChatId ? { plannerChatId: deps.plannerChatId } : {}),
        });
        if (resumed.transport !== 'structured') {
          return `Resuming session ${sessionId} unexpectedly produced a terminal session.`;
        }
        const sent = (resumed as StructuredLikeSession).prompt(prompt);
        if (sent) {
          deps.subagents.recordAction?.();
          if (deps.plannerChatId) {
            deps.subagents.trackCodingSubagent?.(resumed.id, deps.plannerChatId);
          } else {
            deps.subagents.invalidateCodingStatus?.(resumed.id);
          }
          return `Resumed session ${sessionId} as ${resumed.id} and sent the instruction.`;
        }
        return `Resumed session ${sessionId} as ${resumed.id}, but it ended before the instruction could be sent.`;
      } catch (err) {
        return `Could not resume session ${sessionId}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'start_subagent_session',
    description:
      'Start a new subagent and hand it a task: either a fresh coding-agent session in an ' +
      'already-configured project workspace, or a new chat with another configured Pocket Agent. ' +
      'Call list_subagents first to see what is configured. Returns a handle immediately — the ' +
      'subagent runs asynchronously in the background. Completion is delivered automatically as a wake ' +
      'notification to this chat; do NOT poll get_subagent_status, list_sessions, or read_session_output in a loop — ' +
      'end your turn immediately. Starting another ' +
      `subagent is refused past a depth of ${MAX_SUBAGENT_SPAWN_DEPTH} hops from a human, to ` +
      'stop an unbounded chain of agents spawning agents. Only one live subagent session may be started ' +
      'per working tree; if one already exists in the target tree, its existing handle and status are ' +
      `returned. Up to ${MAX_SUBAGENT_SPAWNS_PER_TURN} subagents may be spawned per turn.`,
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['coding_agent', 'pocket_agent'] },
        workspaceId: {
          type: 'string',
          description: 'A Pocket Agent id from list_subagents. Required when kind is "pocket_agent".',
        },
        path: {
          type: 'string',
          description: 'A project workspace directory to run in. Required when kind is "coding_agent".',
        },
        agent: {
          type: 'string',
          description: 'A coding-agent id from list_subagents. Required when kind is "coding_agent".',
        },
        prompt: { type: 'string', description: 'The task to hand the subagent.' },
      },
      required: ['kind', 'prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const prompt = String(args.prompt ?? '').trim();
      if (!prompt) return 'No task prompt provided.';

      if (deps.spawnDepth >= MAX_SUBAGENT_SPAWN_DEPTH) {
        const target = args.kind === 'pocket_agent' ? 'another Pocket Agent chat' : 'another subagent session';
        return (
          `Refusing: this chat is already ${deps.spawnDepth} subagent hop(s) from a human; starting ` +
          `${target} would exceed the depth limit of ${MAX_SUBAGENT_SPAWN_DEPTH}.`
        );
      }

      const maxSpawns = deps.maxSubagentSpawnsPerTurn ?? MAX_SUBAGENT_SPAWNS_PER_TURN;
      const spawnsThisTurn = deps.subagents.spawnsThisTurn ? deps.subagents.spawnsThisTurn() : 0;
      if (spawnsThisTurn >= maxSpawns) {
        return (
          `Refusing: already spawned ${spawnsThisTurn} subagent(s) this turn ` +
          `(limit is ${maxSpawns}). Wait for existing subagents to finish or end your turn.`
        );
      }

      if (deps.subagents.wakeBudgetExhausted?.()) {
        return (
          'Refusing: subagent spawn budget for wake-driven turns has been exhausted. ' +
          'Wait for existing subagents to finish or end your turn.'
        );
      }

      const promptWithTrailer = prompt.includes(SUBAGENT_RESULT_TRAILER) ? prompt : prompt + SUBAGENT_RESULT_TRAILER;

      if (args.kind === 'pocket_agent') {
        const workspaceId = String(args.workspaceId ?? '');
        if (!deps.plannerWorkspaces.get(workspaceId)) {
          return `No Pocket Agent workspace found with id ${workspaceId}. Check list_subagents.`;
        }
        try {
          const { chatId } = await deps.subagents.startPocketAgentChat(workspaceId, promptWithTrailer);
          deps.subagents.recordSpawn?.();
          return JSON.stringify({
            kind: 'pocket_agent',
            id: chatId,
            message: `Started Pocket Agent chat ${chatId}. Completion will be delivered automatically; end your turn now.`,
          });
        } catch (err) {
          return `Could not start subagent chat: ${(err as Error).message}`;
        }
      }

      const requestedPath = String(args.path ?? '');
      const agentId = String(args.agent ?? '');
      if (!requestedPath || !agentId) return 'A coding-agent subagent needs both path and agent. Check list_subagents.';
      let cwd: string;
      try {
        cwd = await deps.workspaces.resolveWorkspacePath(requestedPath);
      } catch (err) {
        return `Cannot resolve ${requestedPath}: ${(err as Error).message}`;
      }

      const treeRoot = treeRootOf(cwd);

      // PA-74: Return existing live subagent session handle if this chat already started one in this working tree.
      const existing = deps.subagents.findLiveCodingSubagent ? deps.subagents.findLiveCodingSubagent(treeRoot) : null;
      if (existing) {
        return JSON.stringify({
          kind: 'coding_agent',
          id: existing.id,
          status: existing.status,
          message:
            `This chat already has an active subagent session (${existing.id}) in ${treeRoot} ` +
            `(status: ${existing.status}). Use get_subagent_status to check on its progress or read its output.`,
        });
      }

      // PA-74: Consult RunQueue's occupancy check — refuse if another session is mid-turn in this working tree.
      if (deps.sessions.busyTreeRoots().includes(treeRoot)) {
        return (
          `Working tree "${treeRoot}" is currently busy with another running session. ` +
          `Try again later or use get_subagent_status to check on running tasks.`
        );
      }

      try {
        const session = await deps.sessions.create({
          agent: agentId,
          cwd,
          cols: 0,
          rows: 0,
          transport: 'structured',
          ...(deps.plannerChatId ? { plannerChatId: deps.plannerChatId } : {}),
        });
        if (!('prompt' in session)) {
          return `${agentId} could not be started as a structured session that can receive a task.`;
        }
        deps.subagents.recordCodingSubagent?.(session.id, cwd);
        deps.subagents.recordSpawn?.();
        const sent = (session as StructuredLikeSession).prompt(promptWithTrailer);
        return JSON.stringify({
          kind: 'coding_agent',
          id: session.id,
          message: sent
            ? `Started session ${session.id} and sent it the task. Completion will be notified automatically; end your turn now.`
            : `Started session ${session.id}, but it ended before the task could be sent.`,
        });
      } catch (err) {
        return `Could not start subagent session: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'check_back_in',
    description:
      'Schedule a non-blocking timer to wake this chat after the specified number of seconds. ' +
      'Returns immediately. You MUST end your turn immediately after calling this tool so that the ' +
      'chat becomes idle and can receive the wake prompt when the timer expires. ' +
      'If a background subagent finishes before the timer fires, its completion will wake the chat earlier.',
    parameters: {
      type: 'object',
      properties: {
        seconds: {
          type: 'integer',
          description: 'Number of seconds to wait before waking this chat (between 1 and 300).',
          minimum: 1,
          maximum: 300,
        },
      },
      required: ['seconds'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const seconds = Number(args.seconds);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
        return 'seconds must be an integer between 1 and 300.';
      }
      if (deps.subagents.wakeBudgetExhausted?.()) {
        return 'Cannot schedule check_back_in: subagent action budget for wake-driven turns is exhausted.';
      }
      if (!deps.subagents.scheduleCheckBackIn) {
        return 'check_back_in is not available in this environment.';
      }
      const result = deps.subagents.scheduleCheckBackIn(seconds);
      if (!result.ok) {
        return `Could not schedule timer: ${result.error}`;
      }
      deps.subagents.recordAction?.();
      return `Timer scheduled to wake in ${seconds} second(s). End your turn now so the chat is idle when the wake arrives.`;
    },
  },
  {
    name: 'stop_subagent',
    description:
      'Stop a running coding-agent subagent session that is stuck, unresponsive, or no longer needed. ' +
      'Terminates the target session. Only subagents started by this chat may be stopped. Subject to human approval.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['coding_agent'],
          description: 'The kind start_subagent_session returned (only coding_agent is supported for termination).',
        },
        id: { type: 'string', description: 'The session id start_subagent_session returned.' },
      },
      required: ['kind', 'id'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const id = String(args.id ?? '');
      const kind = args.kind as 'coding_agent' | 'pocket_agent';
      if (!deps.subagents.stopSubagent) {
        return 'stop_subagent is not available in this environment.';
      }
      const res = await deps.subagents.stopSubagent(kind, id);
      return res.message;
    },
  },
  {
    name: 'write_file',
    description:
      'Write (create or overwrite) a text file. The parent directory must already exist, inside an ' +
      'added project workspace or a planner workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const content = String(args.content ?? '');
      if (content.length > MAX_FILE_WRITE_CHARS) {
        return `Refusing: ${content.length} characters is over this tool's ${MAX_FILE_WRITE_CHARS}-character limit.`;
      }
      const absolute = path.resolve(requested);
      const parent = path.dirname(absolute);
      let realParent: string;
      try {
        realParent = await fs.realpath(parent);
      } catch {
        return `${requested}'s parent directory does not exist. Create it first with mkdir.`;
      }
      if (!isWithinTrustedRoot(deps, realParent)) {
        return `${requested} is outside every project workspace and every planner workspace.`;
      }
      const target = path.join(realParent, path.basename(absolute));
      try {
        const existing = await fs.stat(target).catch(() => null);
        if (existing?.isDirectory()) return `${requested} is a directory, not a file.`;
        await fs.writeFile(target, content, 'utf8');
        return `Wrote ${content.length} characters to ${requested}.`;
      } catch (err) {
        return `Could not write ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'memory_save',
    description:
      "Save a fact, decision, or preference to this agent's long-lived memory, so it survives past " +
      'this conversation. Mutating (it changes what future turns recall), so it goes through the same ' +
      'approval gate as any other write.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory to save, in a few sentences.' },
        importance: {
          type: 'number',
          description: 'How important this is to remember, 1 (trivial) to 5 (critical). Default 3.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      if (deps.workspaceId === null) {
        return 'This chat has no agent to save a memory for (its workspace was removed).';
      }
      const content = String(args.content ?? '').trim();
      if (!content) return 'No memory content provided.';
      const rawImportance = typeof args.importance === 'number' ? Math.round(args.importance) : 3;
      const importance = Math.min(5, Math.max(1, rawImportance));
      const memory = await deps.memory.save(deps.workspaceId, content, importance, null);
      return `Saved memory ${memory.id} (importance ${memory.importance}).`;
    },
  },
  {
    name: 'mkdir',
    description: 'Create a directory (and any missing parent directories), inside a project or planner workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      let target: string;
      try {
        target = await resolveCreatablePath(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      try {
        await fs.mkdir(target, { recursive: true });
        return `Created ${requested}.`;
      } catch (err) {
        return `Could not create ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'rmdir',
    description:
      'Remove a directory inside a project or planner workspace. Refuses a non-empty directory unless ' +
      '`recursive` is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Remove the directory and everything inside it.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      const recursive = args.recursive === true;
      let real: string;
      try {
        real = await resolveExistingPathWithin(deps, requested);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(real);
      if (!stat.isDirectory()) return `${requested} is not a directory.`;
      try {
        if (recursive) {
          await fs.rm(real, { recursive: true, force: false });
        } else {
          await fs.rmdir(real);
        }
        return `Removed ${requested}.`;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY') {
          return `${requested} is not empty. Pass recursive: true to remove it and everything inside.`;
        }
        return `Could not remove ${requested}: ${(err as Error).message}`;
      }
    },
  },
  {
    name: 'delete_worktree',
    description:
      'Delete a git worktree and its local branch. Refuses if a session is still running in it, if it ' +
      'has uncommitted changes, or if the branch is unmerged.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute path to the worktree directory.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requested = String(args.path ?? '');
      let worktreeCwd: string;
      try {
        worktreeCwd = await deps.workspaces.resolveWorkspacePath(requested);
      } catch (err) {
        return `Cannot resolve ${requested}: ${(err as Error).message}`;
      }
      if (deps.sessions.hasAliveSessionIn(worktreeCwd)) {
        return `Refusing: a session is still running in ${requested}. Stop it first.`;
      }
      try {
        const result = await deps.worktrees.remove({ worktreeCwd });
        return `Removed worktree ${requested} and branch ${result.branch}.`;
      } catch (err) {
        if (err instanceof WorktreeError) return `Could not remove worktree: ${err.message}`;
        throw err;
      }
    },
  },
  {
    name: 'exec_command',
    description:
      'Run a shell command inside a project or planner workspace. Output is captured and size-capped, ' +
      `and the command is killed after ${EXEC_TIMEOUT_MS / 1000}s if it has not finished.`,
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Directory to run the command in.' },
        command: { type: 'string', description: 'The shell command line to run.' },
      },
      required: ['cwd', 'command'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const requestedCwd = String(args.cwd ?? '');
      const command = String(args.command ?? '').trim();
      if (!command) return 'No command provided.';

      let cwd: string;
      try {
        cwd = await resolveExistingPathWithin(deps, requestedCwd);
      } catch (err) {
        return (err as Error).message;
      }
      const stat = await fs.stat(cwd);
      if (!stat.isDirectory()) return `${requestedCwd} is not a directory.`;

      return runShellCommand(deps.shell, command, cwd);
    },
  },

  // ---- Telegram (PA-53) --------------------------------------------------
  //
  // `list_telegram_links` is read-only and exempt from the gate for the same
  // reason `list_workspaces`/`list_sessions` are: it discloses nothing that
  // `send_telegram_message` itself doesn't already reveal in its own refusal
  // message, and a model has no other way to learn which ids exist — there
  // is no picker, and the id is a bare number with no mnemonic to guess.
  // Added after a live bug report (PA-53 debug comment): the *first* version
  // of `send_telegram_message`'s own description pointed the model at
  // `list_workspaces` to discover paired ids, which has nothing to do with
  // Telegram at all — the model called it, found nothing relevant, and gave
  // up rather than ever attempting `send_telegram_message` (whose own error
  // message would have listed the paired ids). That is exactly the kind of
  // tool-description bug this catalog cannot unit-test its way out of: the
  // fix is a real tool to point at, not a better sentence.
  {
    name: 'list_telegram_links',
    description:
      'List the Telegram chat ids currently paired to a Pocket Agent (set up in Settings -> ' +
      'Telegram). Call this before send_telegram_message if you do not already know which id to ' +
      'address.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      if (deps.telegram.links.length === 0) return 'No Telegram ids are currently paired.';
      return JSON.stringify(
        deps.telegram.links.map((l) => ({ telegramChatId: l.telegramChatId, label: l.label })),
      );
    },
  },
  // The one mutating tool here that reaches a human directly rather than
  // another PocketAgent subsystem or a third-party HTTP API. `readOnly:
  // false` even though `web_search`/`url_fetch` (also outbound HTTP) are
  // read-only: those two change nothing this system tracks, but a message
  // landing in a stranger's Telegram client is exactly the consequential
  // action the approval gate exists for, so this is gated like
  // `send_instruction`/`exec_command` instead. It goes through that gate
  // unconditionally, even when called from a chat whose own inbound messages
  // are approval-exempt (a Telegram pairing with `skipToolApprovals` on) —
  // "this chat is trusted to talk to the agent" and "this agent is trusted
  // to message anyone" are different grants, and collapsing them would let
  // one bypass double as the other.
  {
    name: 'send_telegram_message',
    description:
      'Send a message to a Telegram user who has paired their chat with a Pocket Agent. Only ids ' +
      'already paired in Settings -> Telegram may be addressed; call list_telegram_links first if ' +
      'you do not already know which id to address.',
    parameters: {
      type: 'object',
      properties: {
        telegramChatId: { type: 'string', description: 'A paired Telegram chat id.' },
        text: { type: 'string', description: 'The message to send.' },
      },
      required: ['telegramChatId', 'text'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const telegramChatId = String(args.telegramChatId ?? '').trim();
      const text = String(args.text ?? '').trim();
      if (!telegramChatId) return 'No telegramChatId provided.';
      if (!text) return 'No message text provided.';

      const link = deps.telegram.links.find((l) => l.telegramChatId === telegramChatId);
      if (!link) {
        return (
          `"${telegramChatId}" is not a paired Telegram id. Paired ids: ` +
          (deps.telegram.links.length > 0
            ? deps.telegram.links.map((l) => `${l.telegramChatId}${l.label ? ` (${l.label})` : ''}`).join(', ')
            : 'none configured.')
        );
      }

      const result = await deps.telegram.send(link.botId, telegramChatId, text);
      return result.ok ? `Message sent to ${telegramChatId}.` : `Failed to send message: ${result.error}`;
    },
  },

  // ---- MCP (PA-37) -----------------------------------------------------
  //
  // Exactly two tools represent *every* MCP registry's *every* tool, no
  // matter how many are configured — the goal the reporter stated directly
  // ("NOT to have full tools on each turn"). A per-tool JSON Schema is only
  // ever returned in `list_mcp_tools`'s own *result* text, on a call the
  // model chose to make, never as a standing entry in the turn's own `tools`
  // array the way a native tool's schema is. `driveLoop`/`toolsFor`
  // (`planner/chats.ts`) additionally omit both of these two whenever no
  // enabled MCP tool exists for the calling agent, so an agent with no
  // registries sees no change at all.
  //
  // `list_mcp_tools` itself is two-tiered (follow-up: a real deployment with
  // several registries found a no-argument call dumping the first 50 tools'
  // full schemas across *every* registry combined — a single chatty registry
  // (many tools, verbose per-tool descriptions) could exhaust the whole
  // `MAX_TOOL_RESULT_CHARS` budget before any other registry's tools even
  // appeared, mid-truncated). A no-argument, no-`query` call now answers with
  // the cheap `listEnabledRegistries()` directory — id/name/description/
  // toolCount per registry, no schemas — so the model reads *which* registry
  // is relevant first; a follow-up call scoped by `registry` then gets that
  // one registry's own `MAX_TOOL_RESULT_CHARS` budget entirely to itself,
  // rather than sharing one budget across every registry configured.
  //
  // `call_mcp_tool`'s approval gating cannot come from its own `readOnly`
  // below — its risk depends entirely on which underlying tool `arguments.tool`
  // names. `PlannerChatService.effectiveMcpToolIdentity` resolves that
  // dynamically before `processToolCalls`/`resolveApproval` ever consult
  // `readOnly`; the `false` here is only the fail-closed static fallback for
  // if that resolution ever comes back empty (an unparsable call, an unknown
  // tool name) — see that method's own doc comment.
  {
    name: LIST_MCP_TOOLS_NAME,
    description:
      'Discover MCP (Model Context Protocol) tools available to this agent, in two steps. Step 1: ' +
      'call with no arguments to see the *registry directory* — every enabled MCP server\'s name, ' +
      'description, and tool count, never a full tool schema. Step 2: once you know which registry ' +
      'is relevant, call again with `registry` set to its name or id (from the directory) to see ' +
      'that registry\'s own tools, each with its full description and parameter schema — optionally ' +
      'narrowed further with `query`. Never assume a schema; always call this before call_mcp_tool. ' +
      '`query` with no `registry` searches by keyword across every enabled registry instead of ' +
      'browsing one (capped at 50 matches) — useful when you already know the tool name you want.',
    parameters: {
      type: 'object',
      properties: {
        registry: {
          type: 'string',
          description:
            'An MCP registry name or id, from the directory returned by a no-argument call. Omit to see ' +
            'the directory itself (or, combined with `query` alone, to search across every registry).',
        },
        query: {
          type: 'string',
          description:
            'Text to match against tool names and descriptions, within `registry` if given, otherwise ' +
            'across every enabled registry. Omit (with a registry) to list all of that registry\'s tools.',
        },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const registryRef = typeof args.registry === 'string' ? args.registry.trim() : '';

      // Step 1, and the fix for a chatty registry (many tools, verbose
      // per-tool descriptions — arr-mcp's Lidarr/Radarr/Sonarr tools were the
      // reported case) blowing through `MAX_TOOL_RESULT_CHARS` before every
      // *other* registry's tools even got a chance to appear: with no
      // `registry` scope and no `query`, answer with the cheap directory
      // instead of dumping the first 50 tools' full schemas across every
      // registry combined.
      if (!registryRef && !query) {
        const registries = deps.mcpRegistry.listEnabledRegistries(deps.workspaceId);
        if (registries.length === 0) {
          return 'No MCP registries are currently enabled for this agent.';
        }
        return truncate(JSON.stringify(registries), MAX_TOOL_RESULT_CHARS);
      }

      // A `query` with no `registry` keeps the old cross-registry keyword
      // search working — useful when the model already knows roughly what
      // tool it wants and would rather not browse the directory first.
      let candidates = deps.mcpRegistry.listEnabledTools(deps.workspaceId);
      if (candidates.length === 0) {
        return 'No MCP registries are currently enabled for this agent.';
      }

      if (registryRef) {
        const registryId = deps.mcpRegistry.resolveRegistryRef(registryRef, deps.workspaceId);
        if (!registryId) {
          const directory = deps.mcpRegistry.listEnabledRegistries(deps.workspaceId);
          return (
            `No enabled MCP registry matched "${registryRef}". Available: ` +
            (directory.length > 0 ? directory.map((r) => r.name).join(', ') : 'none.')
          );
        }
        candidates = candidates.filter((t) => t.registryId === registryId);
      }

      const matches = query
        ? candidates.filter(
            (t) => t.qualifiedName.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
          )
        : candidates.slice(0, 50);
      if (matches.length === 0) {
        return `No enabled MCP tool matched "${query}"${registryRef ? ` in "${registryRef}"` : ''}. ` +
          `${candidates.length} tool(s) available there in total; call again with no query to list them.`;
      }
      const detailed = matches.map((t) => {
        const resolved = deps.mcpRegistry.resolveTool(t.qualifiedName);
        return {
          tool: t.qualifiedName,
          description: t.description,
          parameters: resolved?.tool.inputSchema ?? { type: 'object', properties: {} },
        };
      });
      return truncate(JSON.stringify(detailed), MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: CALL_MCP_TOOL_NAME,
    description:
      'Call one MCP tool by the exact name returned from list_mcp_tools, with arguments matching ' +
      'its parameter schema. Always call list_mcp_tools first if you have not already learned this ' +
      "tool's schema in this conversation.",
    parameters: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The exact tool name from list_mcp_tools.' },
        arguments: { type: 'object', description: "The tool's arguments, matching its parameter schema." },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    // Static fallback only — see this section's own doc comment above.
    readOnly: false,
    async execute(deps, args) {
      const toolName = String(args.tool ?? '').trim();
      if (!toolName) return 'No MCP tool name provided. Call list_mcp_tools first to find one.';
      const callArgs =
        args.arguments && typeof args.arguments === 'object' ? (args.arguments as Record<string, unknown>) : {};

      const enabled = deps.mcpRegistry.listEnabledTools(deps.workspaceId);
      if (!enabled.some((t) => t.qualifiedName === toolName)) {
        return deps.mcpRegistry.resolveTool(toolName)
          ? `MCP tool "${toolName}" is disabled.`
          : `Unknown MCP tool: ${toolName}. Call list_mcp_tools to see what's available.`;
      }
      try {
        const result = await deps.mcpRegistry.callTool(toolName, callArgs);
        const text = result.text.length > 0 ? result.text : '(empty result)';
        return truncate(result.isError ? `Error from ${toolName}: ${text}` : text, MAX_TOOL_RESULT_CHARS);
      } catch (err) {
        return `Error calling MCP tool "${toolName}": ${(err as Error).message}`;
      }
    },
  },

  // ---- Skills (PA-38) ---------------------------------------------------
  //
  // A skill is inert content — loading one only adds text to the
  // conversation, so both tools here are read-only, unlike `call_mcp_tool`
  // (which stands in for arbitrary, individually risky MCP tools). The model
  // then acts using its own, already-gated tools; no new approval mechanism
  // was needed for skills themselves. `PlannerChatService.toolsFor` omits
  // both whenever no enabled skill exists for the calling agent, the same
  // "an agent with none configured sees no difference at all" rule
  // `list_mcp_tools`/`call_mcp_tool` already follow.
  {
    name: LIST_SKILLS_NAME,
    description:
      'List the skills currently enabled for this agent — reusable instructions to load with ' +
      'use_skill before attempting a task one of them covers.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const known = deps.skills.listKnownSkills(deps.workspaceId);
      if (known.length === 0) return '(no skills available)';
      return known.map((s) => `${s.name} — ${s.description}`).join('\n');
    },
  },
  {
    name: USE_SKILL_NAME,
    description:
      'Load one enabled skill by name (from list_skills) into this conversation — its instructions ' +
      'are returned as text; nothing else happens. Act on them using your other tools.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'A skill name from list_skills.' } },
      required: ['name'],
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const requested = String(args.name ?? '').trim();
      if (!requested) return 'No skill name provided. Call list_skills first to find one.';
      const known = deps.skills.listKnownSkills(deps.workspaceId);
      const match = known.find((s) => s.name.toLowerCase() === requested.toLowerCase() || s.slug === requested);
      if (!match) {
        // Distinguish unknown / disabled globally / disabled for this
        // agent, mirroring `PlannerChatService.toolUnavailableMessage`'s own
        // three-way wording for a native tool exactly.
        const visible = deps.skills
          .listVisibleTo(deps.workspaceId)
          .find((s) => s.name.toLowerCase() === requested.toLowerCase() || s.slug === requested);
        if (!visible) {
          return `Unknown skill: ${requested}. Call list_skills to see what's available.`;
        }
        return deps.skills.disabledGlobally(visible.id)
          ? `Skill "${visible.name}" is disabled globally.`
          : `Skill "${visible.name}" is disabled for this agent.`;
      }
      try {
        return await deps.skills.loadSkillBody(match.id);
      } catch (err) {
        if (err instanceof SkillRegistryError) return err.message;
        throw err;
      }
    },
  },
  // PA-38 round 2: authoring a skill via `mkdir` + `write_file` worked, but a
  // purpose-built tool gets the frontmatter format right (quoted where it
  // needs to be, so it round-trips through `parseSkillFile`) and de-dupes
  // the model having to know that layout at all. Mutating (it writes to
  // disk) and gated exactly like `write_file`/`mkdir` — no new approval
  // mechanism, same trust level. Deliberately limited to the calling agent's
  // *own* workspace: reaching the global catalog is the separate, explicit
  // "promote to global" action a human takes from Settings, never something
  // a model call can do directly.
  {
    name: 'write_skill',
    description:
      "Create or overwrite a skill in this agent's own workspace (as <workspace>/.skills/<slug>/SKILL.md), " +
      'so it can be loaded later with use_skill. Refuses if a skill with the same name already exists here ' +
      'unless overwrite is true. This never reaches the global catalog shared with other agents — that is a ' +
      'separate, manual "promote to global" action a human takes from Settings.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A short, human-readable name for the skill.' },
        description: {
          type: 'string',
          description:
            'States when to use this skill (the trigger), not just what it does — this is the only text ' +
            'list_skills shows when deciding whether to load it.',
        },
        body: { type: 'string', description: "The skill's instructions, as Markdown." },
        overwrite: { type: 'boolean', description: 'Replace an existing skill with the same name. Default false.' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      if (deps.workspaceId === null) {
        return 'This chat has no agent workspace to write a skill into (its workspace was removed).';
      }
      const name = String(args.name ?? '').trim();
      const description = String(args.description ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!name) return 'No skill name provided.';
      if (!description) return 'No skill description provided.';
      if (!body) return 'No skill body provided.';
      try {
        const summary = await deps.skills.writeWorkspaceSkill(deps.workspaceId, {
          name,
          description,
          body,
          overwrite: args.overwrite === true,
        });
        return (
          `Wrote skill "${summary.name}" (${summary.id}) to this agent's own workspace. ` +
          'Use list_skills/use_skill to confirm, or promote it to the global catalog from Settings if other ' +
          'agents should have it too.'
        );
      } catch (err) {
        if (err instanceof SkillRegistryError) return err.message;
        throw err;
      }
    },
  },
  // PA-56: "add internal tool allow pocket agent (planner) access settings" —
  // read/update access to general settings, webhooks, scheduled jobs, custom
  // Claude providers and Telegram bots, so a chat can act on the reporter's
  // own example ("change Jira webhook auto project map") without a human
  // going to the Settings page. Scoped deliberately to read + update: create/
  // delete of any of these resources, and the global skip-permissions switch,
  // are out of scope for this ticket (see the doc comments on
  // `update_settings`/`PlannerToolDeps` for why the latter is not just
  // "unimplemented" but actively refused). `read_settings` is the one
  // read-only tool of the six; the five updates are mutating and gated
  // exactly like `write_file`/`exec_command` — no special-cased narrower
  // "remember" scope, same precedent Phase 5 established.
  {
    name: 'read_settings',
    description:
      "Read this server's configuration: general settings (log level, session limits, binaries, ...), every " +
      'configured webhook, scheduled job, custom Claude provider and Telegram bot. Never includes a secret ' +
      '(a webhook HMAC secret, a provider API key, a Telegram bot token) — those are never readable through ' +
      'any tool, only re-enterable from the Settings page. Call this before update_settings/update_webhook/' +
      'update_cron_job/update_custom_claude_provider/update_telegram_bot to see current values and valid ids.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async execute(deps) {
      const snapshot = buildRuntimeSettingsSnapshot(deps.config, deps.sessions.getGlobalSkipPermissions());
      const result: Record<string, unknown> = {
        general: snapshot.settings,
        restartRequiredKeys: snapshot.restartRequiredKeys,
        note:
          'general.skipPermissionsEnabled cannot be changed through update_settings — a human must flip ' +
          'that switch from the Settings page.',
        customClaudeProviders: deps.customClaudeProviders.list(),
      };
      const webhooks = deps.webhooks;
      if (webhooks) result.webhooks = webhooks.list().map((row) => webhooks.toWebhook(row));
      const cron = deps.cron;
      if (cron) result.cronJobs = cron.list().map((row) => cron.toJob(row));
      const telegramBots = deps.telegramBots;
      if (telegramBots) result.telegramBots = telegramBots.list();
      return truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS);
    },
  },
  {
    name: 'update_settings',
    description:
      "Change one or more of this server's general settings — the same ones read_settings's \"general\" " +
      'section shows (e.g. {"settings": {"maxSessions": 20}}). skipPermissionsEnabled is never accepted here: ' +
      'a human must flip that switch from the Settings page.',
    parameters: {
      type: 'object',
      properties: {
        settings: {
          type: 'object',
          description: 'Partial patch, keyed by the same names read_settings\'s "general" section uses.',
          additionalProperties: true,
        },
      },
      required: ['settings'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const rawPatch =
        args.settings && typeof args.settings === 'object' ? (args.settings as Record<string, unknown>) : {};
      // Checked before validation, and never simply omitted from the schema
      // above the way a provider/bot's own secret field is: the reporter's
      // ticket asked for read/write access to "all settings", and this is
      // the one deliberate exception, decided on PA-56 itself rather than
      // left to this tool's own judgment — see the invariants list in
      // CLAUDE.md for the four earlier, all-or-nothing overrides of the same
      // "never default to skipping approval" rule this switch guards.
      if ('skipPermissionsEnabled' in rawPatch) {
        return (
          'Refusing: skipPermissionsEnabled cannot be changed through this tool. ' +
          'A human must flip that switch from the Settings page.'
        );
      }
      const parsed = UpdateSettingsRequest.safeParse(rawPatch);
      if (!parsed.success) {
        return `Refusing: ${parsed.error.issues[0]?.message ?? 'invalid settings patch.'}`;
      }
      const validated = parsed.data as Record<string, unknown>;
      const applied: string[] = [];
      for (const field of SETTINGS_FIELDS) {
        const dtoKey = dtoKeyFor(field);
        if (!(dtoKey in validated)) continue;
        writeSettingsField(deps.db, deps.config, field, fromDtoValue(field, validated[dtoKey]));
        applied.push(dtoKey);
      }
      if (applied.length === 0) {
        return 'Nothing changed: no recognized settings keys were present. Call read_settings for valid keys.';
      }
      const restartNeeded = SETTINGS_FIELDS.filter((f) => !f.live && applied.includes(dtoKeyFor(f))).map(dtoKeyFor);
      return (
        `Updated: ${applied.join(', ')}.` +
        (restartNeeded.length > 0 ? ` Restart required to take effect: ${restartNeeded.join(', ')}.` : '')
      );
    },
  },
  {
    name: 'update_webhook',
    description:
      'Update an existing inbound webhook (see read_settings for ids and current config) — e.g. its Jira/' +
      'Bamboo project map, filter, or which agent handles it. Runs the exact same validation the Settings ' +
      'page does. Never returns or accepts the webhook secret — rotate it from the Settings page.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The webhook id, from read_settings.' },
        patch: {
          type: 'object',
          description:
            'Partial patch — any subset of the fields read_settings shows for this webhook (name, slug, ' +
            'enabled, config, authMode, cwd, agent, worktreeMode, model, effort, skipPermissions, ' +
            'autoSelectAgentModel, promptTemplate, conversationMode, overlapPolicy, directoryPolicy, ' +
            'skipQueueLabelEnabled, agentIdentity, maxConcurrent, storePayloads).',
          additionalProperties: true,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const webhooks = deps.webhooks;
      if (!webhooks) return 'Webhook management is not available on this server right now.';
      const id = String(args.id ?? '');
      if (!id) return 'No webhook id provided. Call read_settings to find one.';
      const parsed = UpdateWebhookRequest.safeParse(args.patch ?? {});
      if (!parsed.success) return `Refusing: ${parsed.error.issues[0]?.message ?? 'invalid webhook patch.'}`;
      try {
        const existing = webhooks.get(id);
        const result = await resolveWebhookUpdatePatch(
          { workspaces: deps.workspaces, agents: deps.agents, plannerWorkspaces: deps.plannerWorkspaces },
          existing,
          parsed.data,
        );
        if (!result.ok) return `Refusing: ${result.error}`;
        return JSON.stringify(webhooks.toWebhook(webhooks.update(id, result.patch)));
      } catch (err) {
        if (err instanceof WebhookServiceError) return err.message;
        throw err;
      }
    },
  },
  {
    name: 'update_cron_job',
    description:
      'Update an existing scheduled job (see read_settings for ids and current config) — its schedule, ' +
      'prompt, agent, directory, or approvals policy. Runs the exact same validation the Settings page does.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The scheduled job id, from read_settings.' },
        patch: {
          type: 'object',
          description:
            'Partial patch — any subset of the fields read_settings shows for this job (name, enabled, ' +
            'preset or cronExpr, timeZone, cwd, agent, worktreeMode, model, effort, skipPermissions, prompt, ' +
            'overlapPolicy).',
          additionalProperties: true,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const cron = deps.cron;
      if (!cron) return 'Scheduled-job management is not available on this server right now.';
      const id = String(args.id ?? '');
      if (!id) return 'No scheduled job id provided. Call read_settings to find one.';
      const existing = cron.get(id);
      if (existing === null) return `No such scheduled job: ${id}.`;
      const parsed = UpdateCronJobRequest.safeParse(args.patch ?? {});
      if (!parsed.success) return `Refusing: ${parsed.error.issues[0]?.message ?? 'invalid job patch.'}`;
      const result = await resolveCronJobUpdatePatch(
        { workspaces: deps.workspaces, plannerWorkspaces: deps.plannerWorkspaces, agents: deps.agents },
        existing.agent,
        parsed.data,
      );
      if (!result.ok) return `Refusing: ${result.error}`;
      try {
        const row = cron.update(id, result.patch);
        if (row.enabled === 1 && row.next_run_at === null) {
          return 'That schedule has no future run. Check the day and month you picked.';
        }
        return JSON.stringify(cron.toJob(row));
      } catch (err) {
        if (err instanceof CronServiceError) return err.message;
        throw err;
      }
    },
  },
  {
    name: 'update_custom_claude_provider',
    description:
      'Update an existing custom Claude provider variant (see read_settings for ids and current config) — ' +
      'its name, base URL, model catalog, or unattended-use setting. This tool can never set, change or read ' +
      'the API key: omit it entirely, and re-enter it from the Settings page if it needs rotating.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The provider id, from read_settings.' },
        patch: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            providerKind: { type: 'string' },
            baseUrl: { type: 'string' },
            models: { type: 'array', items: { type: 'string' } },
            defaultModel: { type: 'string' },
            smallModel: { type: 'string' },
            allowUnattended: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const id = String(args.id ?? '');
      if (!id) return 'No provider id provided. Call read_settings to find one.';
      const rawPatch =
        args.patch && typeof args.patch === 'object' ? (args.patch as Record<string, unknown>) : {};
      // Never merely omitted from the schema above — checked explicitly so a
      // model that names the field anyway (a stale memory of the create
      // form, a guess) gets a refusal that says why, not a silently dropped
      // argument. See `PlannerToolDeps.customClaudeProviders`'s doc comment.
      if ('apiKey' in rawPatch) {
        return (
          'Refusing: this tool can never set, change or read the API key. ' +
          'Re-enter it from the Settings page if it needs rotating.'
        );
      }
      const parsed = UpdateCustomClaudeProviderRequest.safeParse(rawPatch);
      if (!parsed.success) return `Refusing: ${parsed.error.issues[0]?.message ?? 'invalid provider patch.'}`;
      try {
        return JSON.stringify(deps.customClaudeProviders.update(id, parsed.data));
      } catch (err) {
        if (err instanceof CustomClaudeProviderError) return err.message;
        throw err;
      }
    },
  },
  {
    name: 'update_telegram_bot',
    description:
      'Update an existing Telegram bot (see read_settings for ids and current config) — its name or enabled ' +
      'state. This tool can never set, change or read the bot token: omit it entirely, and re-enter it from ' +
      'the Settings page if it needs rotating.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The Telegram bot id, from read_settings.' },
        patch: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    async execute(deps, args) {
      const bots = deps.telegramBots;
      if (!bots) return 'Telegram bot management is not available on this server right now.';
      const id = String(args.id ?? '');
      if (!id) return 'No Telegram bot id provided. Call read_settings to find one.';
      const rawPatch =
        args.patch && typeof args.patch === 'object' ? (args.patch as Record<string, unknown>) : {};
      // See `update_custom_claude_provider`'s identical check just above.
      if ('botToken' in rawPatch) {
        return (
          'Refusing: this tool can never set, change or read the bot token. ' +
          'Re-enter it from the Settings page if it needs rotating.'
        );
      }
      const parsed = UpdateTelegramBotRequest.safeParse(rawPatch);
      if (!parsed.success) return `Refusing: ${parsed.error.issues[0]?.message ?? 'invalid bot patch.'}`;
      try {
        return JSON.stringify(bots.update(id, parsed.data));
      } catch (err) {
        if (err instanceof TelegramBotError) return err.message;
        throw err;
      }
    },
  },
];

/**
 * Runs one command through the configured shell, with the same env-stripping
 * every other child process this server spawns already gets
 * (`sessions/env.ts` — `POCKETAGENT_*` must never reach a spawned process,
 * including one started by the planner). No PTY: this is one-shot output
 * capture, not an interactive terminal.
 */
function runShellCommand(shell: string, command: string, cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(shell, ['-lc', command], { cwd, env: buildChildEnv({ cwd }) });
    } catch (err) {
      resolve(`Could not start the shell: ${(err as Error).message}`);
      return;
    }

    let output = '';
    let truncated = false;
    const onChunk = (chunk: Buffer): void => {
      if (output.length >= MAX_TOOL_RESULT_CHARS) {
        truncated = true;
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, EXEC_TIMEOUT_MS);
    let timedOut = false;

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Could not run command: ${err.message}`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const status = timedOut
        ? `timed out after ${EXEC_TIMEOUT_MS / 1000}s and was killed`
        : signal
          ? `killed by ${signal}`
          : `exit code ${code}`;
      const body = truncate(output, MAX_TOOL_RESULT_CHARS) + (truncated ? '\n…(output truncated)' : '');
      resolve(`$ ${command}\n(${status})\n${body}`);
    });
  });
}

/**
 * PA-44: one no-shell process run for `grep_files`/`find_files` — `bin`/`args`
 * reach `spawn` as an argv array, never through a shell, so an untrusted
 * `pattern`/`namePattern` from the model has no shell metacharacters to
 * inject into (unlike `exec_command`, which is deliberately a full shell
 * because that is the feature). Output is captured up to a generous cap
 * (twice `MAX_TOOL_RESULT_CHARS`, since the caller still line-limits and
 * `truncate`s afterward) so a runaway search cannot hold megabytes of stdout
 * in memory while it fills the caller's own limit.
 */
function runArgvCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  const CAPTURE_CAP = MAX_TOOL_RESULT_CHARS * 2;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env: buildChildEnv({ cwd }) });
    } catch (err) {
      resolve({ stdout: '', stderr: `Could not start ${bin}: ${(err as Error).message}`, code: null, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < CAPTURE_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < CAPTURE_CAP) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || err.message, code: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

export function findPlannerTool(name: string): PlannerToolDefinition | undefined {
  return PLANNER_TOOLS.find((t) => t.name === name);
}

/** The JSON-schema-as-function shape an OpenAI-compatible `tools` param expects. */
export function toOpenAiToolSpecs(tools: readonly PlannerToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
