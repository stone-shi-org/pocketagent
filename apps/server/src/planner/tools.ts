import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  CALL_MCP_TOOL_NAME,
  LIST_MCP_TOOLS_NAME,
  LIST_SKILLS_NAME,
  USE_SKILL_NAME,
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
import { buildChildEnv } from '../sessions/env.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';
import type { McpRegistryService } from './mcp/registry-service.js';
import { SkillRegistryError, type SkillRegistryService } from './skills.js';

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
}

/** One `get_subagent_status` answer for a `pocket_agent` handle. `'gone'`
    covers both an unknown id and a chat since deleted — indistinguishable to
    a caller, and both mean "nothing left to check on". */
export interface SubagentChatStatus {
  status: 'running' | 'paused_for_approval' | 'done' | 'error' | 'gone';
  summary: string;
}

/** PA-44: see `PlannerToolDeps.spawnDepth`'s doc comment. Exported so
    `PlannerChatService` can apply the same limit defensively on its own side
    of `subagents.startPocketAgentChat` — belt and suspenders, the same
    "the model choosing to call something is not this server's decision to
    trust unchecked" posture the disabled-tool checks already take. */
export const MAX_SUBAGENT_SPAWN_DEPTH = 2;

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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated, ${text.length - max} more characters)`;
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
      if (!deps.sessions.find(sessionId)) return `No session found with id ${sessionId}.`;
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
        return truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS);
      }
      const info = deps.sessions.find(id);
      if (!info) return JSON.stringify({ status: 'gone', summary: `No session found with id ${id}.` });
      if (isTerminalStatus(info.status)) {
        return truncate(
          JSON.stringify({ status: 'exited', sessionStatus: info.status, summary: await sessionOutputSummary(deps, id) }),
          MAX_TOOL_RESULT_CHARS,
        );
      }
      if (info.busy) {
        return JSON.stringify({ status: 'running', summary: 'Still working on its assigned task.' });
      }
      return truncate(
        JSON.stringify({ status: 'idle', summary: await sessionOutputSummary(deps, id) }),
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
        return sent
          ? `Instruction sent to running session ${sessionId}.`
          : `Session ${sessionId} ended before the instruction could be sent.`;
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
        });
        if (resumed.transport !== 'structured') {
          return `Resuming session ${sessionId} unexpectedly produced a terminal session.`;
        }
        const sent = (resumed as StructuredLikeSession).prompt(prompt);
        return sent
          ? `Resumed session ${sessionId} as ${resumed.id} and sent the instruction.`
          : `Resumed session ${sessionId} as ${resumed.id}, but it ended before the instruction could be sent.`;
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
      'subagent keeps working after this call returns, so poll get_subagent_status (for a coding ' +
      'agent, list_sessions/read_session_output work too) to learn when it is done. Starting another ' +
      `Pocket Agent chat is refused past a depth of ${MAX_SUBAGENT_SPAWN_DEPTH} hops from a human, to ` +
      'stop an unbounded chain of agents spawning agents.',
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

      if (args.kind === 'pocket_agent') {
        if (deps.spawnDepth >= MAX_SUBAGENT_SPAWN_DEPTH) {
          return (
            `Refusing: this chat is already ${deps.spawnDepth} subagent hop(s) from a human; starting ` +
            `another Pocket Agent chat would exceed the depth limit of ${MAX_SUBAGENT_SPAWN_DEPTH}.`
          );
        }
        const workspaceId = String(args.workspaceId ?? '');
        if (!deps.plannerWorkspaces.get(workspaceId)) {
          return `No Pocket Agent workspace found with id ${workspaceId}. Check list_subagents.`;
        }
        try {
          const { chatId } = await deps.subagents.startPocketAgentChat(workspaceId, prompt);
          return JSON.stringify({
            kind: 'pocket_agent',
            id: chatId,
            message: `Started Pocket Agent chat ${chatId}. Use get_subagent_status to check on it.`,
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
      try {
        const session = await deps.sessions.create({
          agent: agentId,
          cwd,
          cols: 0,
          rows: 0,
          transport: 'structured',
        });
        if (!('prompt' in session)) {
          return `${agentId} could not be started as a structured session that can receive a task.`;
        }
        const sent = (session as StructuredLikeSession).prompt(prompt);
        return JSON.stringify({
          kind: 'coding_agent',
          id: session.id,
          message: sent
            ? `Started session ${session.id} and sent it the task.`
            : `Started session ${session.id}, but it ended before the task could be sent.`,
        });
      } catch (err) {
        return `Could not start subagent session: ${(err as Error).message}`;
      }
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
      'Discover MCP (Model Context Protocol) tools available to this agent right now, by name or ' +
      'keyword. Returns each match\'s full description and parameter schema, so this is the way to ' +
      'learn how to call one — never assume a schema; always call this first. Omit `query` to see ' +
      'everything currently enabled (capped at 50).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match against MCP tool names and descriptions. Omit to list everything.',
        },
      },
      additionalProperties: false,
    },
    readOnly: true,
    async execute(deps, args) {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const enabled = deps.mcpRegistry.listEnabledTools(deps.workspaceId);
      if (enabled.length === 0) {
        return 'No MCP tools are currently enabled for this agent.';
      }
      const matches = query
        ? enabled.filter(
            (t) => t.qualifiedName.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
          )
        : enabled.slice(0, 50);
      if (matches.length === 0) {
        return `No enabled MCP tool matched "${query}". ${enabled.length} tool(s) are enabled in total; call again with no query to list them.`;
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
