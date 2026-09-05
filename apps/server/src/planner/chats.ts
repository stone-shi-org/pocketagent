import crypto from 'node:crypto';
import type { AgentEvent, PlannerChat, PlannerToolApprovalChoice } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionHistoryDeps } from '../sessions/history.js';
import type { WorktreeService } from '../git/worktree.js';
import type { PlannerWorkspaceRegistry } from './workspaces.js';
import {
  deletePlannerChat,
  insertPlannerChat,
  readPlannerChat,
  readPlannerChats,
  readPlannerSettings,
  revealPlannerApiKey,
  updatePlannerChat,
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

export interface PlannerChatServiceOptions {
  db: Db;
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  worktrees: WorktreeService;
  historyDeps: SessionHistoryDeps;
  /** The configured shell binary, forwarded to `exec_command`. */
  shell: string;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
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

  constructor(private readonly opts: PlannerChatServiceOptions) {
    this.tools = opts.tools ?? PLANNER_TOOLS;
  }

  list(workspaceId?: string): PlannerChat[] {
    return readPlannerChats(this.opts.db, workspaceId);
  }

  get(id: string): PlannerChat | null {
    return readPlannerChat(this.opts.db, id);
  }

  create(input: { workspaceId?: string; title?: string; modelId?: string }): PlannerChat {
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
      lastModelId: input.modelId ?? readPlannerSettings(this.opts.db).lastModelId,
      createdAt: now,
      lastActivityAt: now,
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
    return deletePlannerChat(this.opts.db, id);
  }

  async history(id: string): Promise<AgentEvent[]> {
    const chat = this.requireChat(id);
    return readTranscriptEvents(this.workspacePathFor(chat), chat.id);
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
   */
  async *sendMessage(
    id: string,
    content: string,
    opts: { modelId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent> {
    const chat = this.requireChat(id);
    const modelId = this.resolveModelId(chat, opts.modelId);
    const workspacePath = this.workspacePathFor(chat);

    const userEvent: AgentEvent = { kind: 'user_prompt', id: crypto.randomUUID(), text: content };
    await appendTranscriptEvent(workspacePath, chat.id, userEvent);
    yield userEvent;

    yield* this.driveLoop(chat, workspacePath, modelId, 0, opts.signal);
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
    const tool = findPlannerTool(call.function.name);

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
        content: choice === 'deny' ? 'Denied by the user.' : `Unknown tool: ${call.function.name}`,
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

    yield* this.processToolCalls(chat, workspacePath, pending.modelId, pending.toolCalls, pending.index + 1, pending.iteration);
  }

  /** Persist then yield — every event this service produces goes through here, so the two never drift apart. */
  private async *emit(workspacePath: string, chatId: string, event: AgentEvent): AsyncGenerator<AgentEvent> {
    await appendTranscriptEvent(workspacePath, chatId, event);
    yield event;
  }

  /** Ends a turn: emits the final `text` (or nothing, if `text` is empty) and `turn_complete`, and updates the chat row. */
  private async *finishTurn(
    chat: PlannerChat,
    workspacePath: string,
    modelId: string,
    text: string,
    isError: boolean,
  ): AsyncGenerator<AgentEvent> {
    if (text.length > 0) {
      yield* this.emit(workspacePath, chat.id, { kind: 'text', id: crypto.randomUUID(), text });
    }
    yield* this.emit(workspacePath, chat.id, {
      kind: 'turn_complete',
      stopReason: isError ? 'error' : 'end_turn',
      isError,
      numTurns: null,
      durationMs: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
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
   */
  private async *driveLoop(
    chat: PlannerChat,
    workspacePath: string,
    modelId: string,
    iteration: number,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (iteration >= MAX_TOOL_ITERATIONS) {
      yield* this.finishTurn(chat, workspacePath, modelId, GIVE_UP_MESSAGE, true);
      return;
    }

    const settings = readPlannerSettings(this.opts.db);
    const events = await readTranscriptEvents(workspacePath, chat.id);
    const messages = eventsToLlmMessages(events);
    const client = new PlannerLlmClient({
      baseUrl: settings.baseUrl!,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });

    const textBlockId = crypto.randomUUID();
    let completion: PlannerLlmCompletion | null = null;
    try {
      for await (const chunk of client.streamComplete(modelId, messages, toOpenAiToolSpecs(this.tools), signal)) {
        if (chunk.type === 'text_delta') {
          yield { kind: 'text_delta', id: textBlockId, text: chunk.text };
        } else {
          completion = chunk;
        }
      }
    } catch (err) {
      this.opts.logger?.warn({ err, chat: chat.id, model: modelId }, 'planner LLM call failed');
      const message = err instanceof PlannerLlmError ? err.message : (err as Error).message;
      yield* this.finishTurn(chat, workspacePath, modelId, `Could not reach the LLM endpoint: ${message}`, true);
      return;
    }

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
      );
      return;
    }

    if (completion.toolCalls.length === 0) {
      yield* this.finishTurn(chat, workspacePath, modelId, completion.content ?? '', false);
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

    yield* this.processToolCalls(chat, workspacePath, modelId, completion.toolCalls, 0, iteration + 1);
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
  ): AsyncGenerator<AgentEvent> {
    for (let index = startIndex; index < toolCalls.length; index++) {
      const call = toolCalls[index]!;
      const tool = findPlannerTool(call.function.name);

      if (!tool) {
        yield* this.emit(workspacePath, chat.id, {
          kind: 'tool_result',
          id: crypto.randomUUID(),
          toolUseId: call.id,
          content: `Unknown tool: ${call.function.name}`,
          truncated: false,
          isError: true,
        });
        continue;
      }

      if (!tool.readOnly) {
        const decision = resolveApprovalStatus(this.opts.db, tool.name, chat.workspaceId);
        if (decision === null) {
          const approvalId = crypto.randomUUID();
          this.pendingTurns.set(approvalId, {
            chatId: chat.id,
            workspaceId: chat.workspaceId,
            modelId,
            toolCalls,
            index,
            iteration,
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
    yield* this.driveLoop(chat, workspacePath, modelId, iteration, undefined);
  }

  private async executeTool(tool: PlannerToolDefinition, rawArguments: string, chat: PlannerChat): Promise<string> {
    const args = safeParseArgs(rawArguments);
    try {
      return await tool.execute(
        {
          workspaces: this.opts.workspaces,
          plannerWorkspaces: this.opts.plannerWorkspaces,
          sessions: this.opts.sessions,
          worktrees: this.opts.worktrees,
          historyDeps: this.opts.historyDeps,
          shell: this.opts.shell,
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
