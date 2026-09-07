import type { PlannerChat, PlannerMemory } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import type { PlannerWorkspaceRegistry, PlannerWorkspaceRow } from './workspaces.js';
import type { PlannerMemoryService } from './memory.js';
import { readPlannerChats, readPlannerSettings, revealPlannerApiKey } from './store.js';
import { readTranscriptEvents } from './transcript.js';
import { PlannerLlmClient, type PlannerChatMessage, type PlannerLlmCompletion } from './llm-client.js';

/**
 * How often to look for a workspace whose consolidation is due.
 *
 * Not `CronService`'s 30s: that granularity exists because a cron job's
 * schedule can be as fine as a minute and a firing has to be caught within
 * roughly that window. Consolidation's own due-check granularity
 * (`DEFAULT_CONSOLIDATION_INTERVAL_MS`, ~24h) is three orders of magnitude
 * coarser, so polling every 30 minutes bounds "how late a consolidation can
 * run past its due time" at something nobody will ever notice, without
 * spending a tick evaluating every workspace 2,880 times a day for nothing.
 */
const TICK_INTERVAL_MS = 30 * 60_000;

/**
 * Default per-workspace consolidation cadence. Not configurable per agent
 * yet (the brief calls this "configurable-but-defaulted" — the default is
 * implemented; a per-agent override is a natural follow-up once there's a
 * settings row to hang it off) — 24h keeps a "dream pass" roughly nightly,
 * long enough that the short-term rolling window (`ROLLING_WINDOW_TURNS` in
 * `chats.ts`) has had time to fold real content before each pass runs, short
 * enough that a workspace used every day is consolidated every day.
 */
const DEFAULT_CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60_000;

/** Bounds how much of one chat's transcript is fed to the consolidation
    prompt — long enough to carry real context, short enough that a single
    very chatty conversation cannot blow out the request body or the model's
    context window on its own. */
const MAX_TRANSCRIPT_CHARS_PER_CHAT = 8_000;

const CONSOLIDATION_SYSTEM_PROMPT =
  'You are consolidating an AI agent\'s working memory into durable long-term facts. You will be ' +
  "given the agent's short-term memories (already-summarized notes) and recent transcript excerpts " +
  'from its conversations. Extract only facts genuinely worth remembering indefinitely: durable ' +
  "preferences, decisions, and recurring facts about the user, their projects, or how they like " +
  'things done — not one-off task details or anything already fully captured by an existing ' +
  'short-term note verbatim. Reply with ONLY a JSON array (no prose, no markdown fence), each ' +
  'element shaped {"content": string, "importance": integer from 1 (trivial) to 5 (critical)}. ' +
  'Reply with an empty array [] if nothing is worth keeping long-term.';

export interface MemoryConsolidationServiceOptions {
  db: Db;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  memory: PlannerMemoryService;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injectable for tests, so a 24h wait is never actually waited on. */
  now?: () => number;
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
  /** Injectable for tests — how "due" is measured (see `TICK_INTERVAL_MS`'s
      own doc comment for why this is not the same number as the tick). */
  consolidationIntervalMs?: number;
}

/**
 * PA-29 phase 3: the "dream" pass. Periodically folds each memory-enabled
 * workspace's `tier: 'short'` memories, plus whatever its chats talked about
 * since the last pass, into durable `tier: 'long'` memories — one plain
 * (non-streaming, non-tool-calling) LLM call per due workspace.
 *
 * Modelled on `CronService`'s own ticker shape (a fixed poll against the
 * wall clock, not a chain of `setTimeout`s — see that class's doc comment
 * for why a suspended laptop or an NTP step make that the only sound
 * choice), but *without* `CronService`'s catch-up-grace policy: that policy
 * exists to tell "a `systemctl restart` blipped past a firing" apart from
 * "a week offline should not fire 168 times at boot," and neither situation
 * has an analogue here. A workspace's "due" check
 * (`now - (lastConsolidatedAt ?? createdAt) >= interval`) is naturally
 * idempotent and self-healing: a server that was down for a week simply
 * finds every memory-enabled workspace overdue on the next tick and
 * processes each exactly once, the same as if it had ticked on time the
 * whole while. There is no "ran 168 times" failure mode to guard against,
 * because there is nothing here that fires once per missed interval — only
 * once per tick, ever.
 */
export class MemoryConsolidationService {
  private timer: NodeJS.Timeout | null = null;
  /** Guards against a slow tick overlapping the next one, same as `CronService.ticking`. */
  private ticking = false;

  constructor(private readonly opts: MemoryConsolidationServiceOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private intervalMs(): number {
    return this.opts.consolidationIntervalMs ?? DEFAULT_CONSOLIDATION_INTERVAL_MS;
  }

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One consolidation pass. Public so tests can drive it deterministically
   * instead of waiting on the real ticker. Never throws — a broken workspace
   * (a malformed transcript, an LLM that replies with garbage) must not stop
   * every other due workspace in the same tick from being processed, the
   * same per-job isolation `CronService.tick` gives its own jobs.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      const interval = this.intervalMs();
      for (const workspace of this.opts.plannerWorkspaces.list()) {
        if (!workspace.memoryEnabled) continue;
        const dueSince = workspace.lastConsolidatedAt ?? workspace.createdAt;
        if (now - dueSince < interval) continue;
        try {
          await this.consolidateWorkspace(workspace, now);
        } catch (err) {
          this.opts.logger?.warn(
            { err, workspaceId: workspace.id },
            'memory consolidation failed for this agent; it will be retried next cycle',
          );
        }
      }
    } catch (err) {
      this.opts.logger?.warn({ err }, 'memory consolidation tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Process one due workspace. Throws on a genuine failure (bad LLM
   * response, unreachable endpoint) so `tick`'s per-workspace `catch` can log
   * and move on to the next one — this method itself never swallows an
   * error into a silent no-op, so a failure here is always visible.
   */
  private async consolidateWorkspace(workspace: PlannerWorkspaceRow, now: number): Promise<void> {
    const since = workspace.lastConsolidatedAt ?? workspace.createdAt;
    const shortTermMemories = this.opts.memory.list(workspace.id, 'short');
    // Transcript events carry no per-event timestamp (only `TurnCompleteEvent
    // .completedAt` does, and Pocket Agent turns are the only source of that
    // field at all) — so "since the last consolidation" is approximated at
    // the chat level via `lastActivityAt`, the same granularity the home
    // screen already uses to decide what counts as recent. This can re-read
    // a chat's very first turns again on a later cycle if that chat stays
    // active across many consolidation windows, which is an acceptable
    // amount of duplicate context for an LLM prompt, not a correctness bug —
    // unlike the rolling-window fold, this pass has no obligation to touch
    // each turn exactly once.
    const activeChats = readPlannerChats(this.opts.db, workspace.id).filter(
      (chat) => chat.lastActivityAt >= since,
    );
    const transcriptExcerpt = await buildTranscriptExcerpt(workspace.path, activeChats);

    if (shortTermMemories.length === 0 && transcriptExcerpt.length === 0) {
      // Nothing to fold this cycle. Still worth advancing the marker: the
      // alternative (leaving it alone) means this workspace stays "due" on
      // every tick from now on and this exact same empty check re-runs
      // forever, rather than the "due" window simply starting fresh from
      // now — the direct analogue of `CronService` never leaving a fired job
      // due for the next tick to re-discover.
      this.opts.plannerWorkspaces.setLastConsolidatedAt(workspace.id, now);
      return;
    }

    const settings = readPlannerSettings(this.opts.db);
    if (!settings.baseUrl) {
      this.opts.logger?.warn(
        { workspaceId: workspace.id },
        'memory consolidation skipped: no planner LLM endpoint is configured',
      );
      return; // Not advancing the marker: nothing was actually processed.
    }
    // Same fallback order `PlannerChatService.create` uses for a new chat's
    // model: this agent's own configured default, else the last model used
    // anywhere.
    const modelId = workspace.defaultModelId ?? settings.lastModelId;
    if (!modelId) {
      this.opts.logger?.warn(
        { workspaceId: workspace.id },
        'memory consolidation skipped: no model is configured for this agent, and none is configured globally',
      );
      return;
    }

    const client = new PlannerLlmClient({
      baseUrl: settings.baseUrl,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });
    const messages: PlannerChatMessage[] = [
      { role: 'system', content: CONSOLIDATION_SYSTEM_PROMPT },
      { role: 'user', content: buildConsolidationUserMessage(shortTermMemories, transcriptExcerpt) },
    ];

    // A plain completion: no `tools` argument, so `streamComplete` never
    // offers the model anything to call — the same "no tools, no streaming
    // loop" shape `PlannerChatService.testModel` already uses for its own
    // one-off round trip. `text_delta` chunks are ignored; only the final
    // `done` event carries anything this method needs.
    let completion: PlannerLlmCompletion | null = null;
    for await (const chunk of client.streamComplete(modelId, messages)) {
      if (chunk.type === 'done') completion = chunk;
    }
    if (!completion?.content) {
      throw new Error('Consolidation model returned no content.');
    }

    const facts = parseConsolidationFacts(completion.content);
    for (const fact of facts) {
      await this.opts.memory.save(workspace.id, fact.content, fact.importance, null, 'long');
    }
    // Prune exactly the short-term rows this pass considered — not a fresh
    // re-read of the tier — so a memory saved by a live turn *during* this
    // same async call (a race with `save`'s own budget eviction) is never
    // deleted out from under a conversation that just wrote it.
    for (const memory of shortTermMemories) {
      this.opts.memory.remove(memory.id);
    }
    this.opts.plannerWorkspaces.setLastConsolidatedAt(workspace.id, now);
  }
}

interface ConsolidationFact {
  content: string;
  importance: number;
}

/**
 * PA-29: the three tools through which a Pocket Agent turn can already have
 * pulled coding-agent-session content into its own conversation — a
 * consolidation pass folding that content in too means a fact "learned"
 * from a sub-agent's own output gets a chance to become durable, the same
 * as a fact stated directly by the user. Deliberately narrow: every other
 * tool's result (file/exec traffic, `write_file`, `mkdir`, `exec_command`,
 * …) stays excluded, because that traffic is *this* agent's own
 * housekeeping, not something read *from* another agent worth
 * remembering.
 */
const CONSOLIDATION_INCLUDED_TOOL_RESULTS: ReadonlySet<string> = new Set([
  'read_session_output',
  'list_sessions',
  'send_instruction',
]);

/** How much of one included tool result's own content is folded in, before
    the whole chat's text is truncated again by `MAX_TRANSCRIPT_CHARS_PER_CHAT`
    — a single `read_session_output` call can return up to that tool's own
    20,000-character cap, which would let one call dominate an entire
    consolidation prompt on its own. */
const MAX_TOOL_RESULT_EXCERPT_CHARS = 300;

/**
 * Builds the transcript half of the consolidation prompt: each active
 * chat's `user_prompt`/`text` events flattened into a plain back-and-forth,
 * plus a truncated one-line summary of a `tool_result` for a call to
 * `read_session_output`, `list_sessions`, or `send_instruction` (see
 * `CONSOLIDATION_INCLUDED_TOOL_RESULTS`'s own doc comment for why only
 * these three) — matched to its tool name via the preceding `tool_use`
 * event's `id`, the same `toolUseId` correlation `chats.ts`'s own
 * `eventsToLlmMessages` uses to pair a call with its result. Every other
 * tool's result stays omitted, the same lean treatment `summarizeFoldedTurns`
 * (`chats.ts`) already gives the rolling-window fold. The whole thing is
 * truncated per chat by `MAX_TRANSCRIPT_CHARS_PER_CHAT`, combined text
 * included.
 */
async function buildTranscriptExcerpt(
  workspacePath: string,
  chats: readonly PlannerChat[],
): Promise<string> {
  const sections: string[] = [];
  for (const chat of chats) {
    const events = await readTranscriptEvents(workspacePath, chat.id);
    const includedToolNameById = new Map<string, string>();
    const lines: string[] = [];
    for (const event of events) {
      if (event.kind === 'user_prompt') {
        lines.push(`User: ${event.text}`);
      } else if (event.kind === 'text') {
        lines.push(`Assistant: ${event.text}`);
      } else if (event.kind === 'tool_use') {
        if (CONSOLIDATION_INCLUDED_TOOL_RESULTS.has(event.name)) {
          includedToolNameById.set(event.id, event.name);
        }
      } else if (event.kind === 'tool_result') {
        const toolName = includedToolNameById.get(event.toolUseId);
        if (!toolName) continue;
        const oneLine = event.content.replace(/\s+/g, ' ').trim();
        if (oneLine.length === 0) continue;
        const excerpt =
          oneLine.length > MAX_TOOL_RESULT_EXCERPT_CHARS
            ? `${oneLine.slice(0, MAX_TOOL_RESULT_EXCERPT_CHARS)}…`
            : oneLine;
        lines.push(`Tool result (${toolName}): ${excerpt}`);
      }
    }
    if (lines.length === 0) continue;
    let text = lines.join('\n');
    if (text.length > MAX_TRANSCRIPT_CHARS_PER_CHAT) {
      text = `${text.slice(0, MAX_TRANSCRIPT_CHARS_PER_CHAT)}…`;
    }
    sections.push(`Chat "${chat.title ?? '(untitled)'}":\n${text}`);
  }
  return sections.join('\n\n');
}

function buildConsolidationUserMessage(
  shortTermMemories: readonly PlannerMemory[],
  transcriptExcerpt: string,
): string {
  const shortTermSection =
    shortTermMemories.length > 0
      ? `Short-term memories:\n${shortTermMemories.map((m) => `- ${m.content}`).join('\n')}`
      : 'No short-term memories.';
  const transcriptSection =
    transcriptExcerpt.length > 0
      ? `Recent conversation excerpts:\n${transcriptExcerpt}`
      : 'No new conversation activity.';
  return `${shortTermSection}\n\n${transcriptSection}`;
}

/**
 * Parses the model's reply into facts to save, throwing (rather than
 * returning `[]`) on anything that isn't a usable JSON array — a caller that
 * silently treated "the model ignored the format" the same as "the model
 * found nothing worth keeping" would prune this cycle's short-term memories
 * and advance `lastConsolidatedAt` over content that was never actually
 * reviewed.
 */
function parseConsolidationFacts(raw: string): ConsolidationFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonArray(raw));
  } catch (err) {
    throw new Error(`Consolidation model reply was not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Consolidation model reply was not a JSON array.');
  }
  return parsed
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      content: typeof item.content === 'string' ? item.content.trim() : '',
      importance: clampImportance(item.importance),
    }))
    .filter((fact) => fact.content.length > 0);
}

function clampImportance(value: unknown): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 3;
  return Math.min(5, Math.max(1, num));
}

/** Strips a markdown code fence around the JSON array, if the model wrapped
    its reply in one despite the system prompt asking for raw JSON — cheap
    insurance against the single most common way a "reply with JSON only"
    ask gets slightly mis-followed. */
function extractJsonArray(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  return fenced ? fenced[1]!.trim() : trimmed;
}
