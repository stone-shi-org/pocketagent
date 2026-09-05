import crypto from 'node:crypto';
import type { PlannerChat, PlannerToolApprovalChoice, PlannerTranscriptEntry, PlannerTurnResult } from '@pocketagent/protocol';
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
import { rememberDecisionIfAsked, rememberedDecision } from './approval.js';
import { appendTranscriptEntry, readTranscript } from './transcript.js';
import { PlannerLlmClient, type PlannerChatMessage, type PlannerLlmToolCall } from './llm-client.js';
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
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
  /** Injected in tests to control exactly which tools are offered. Defaults to `PLANNER_TOOLS`. */
  tools?: readonly PlannerToolDefinition[];
}

/** State for a turn parked on an unanswered mutating-tool approval. Held only
    in memory — like `StructuredSession`'s own pending-permission map, this
    does not survive a server restart; see `PlannerTurnResult`'s doc comment
    in the protocol package. */
interface PendingPlannerTurn {
  chatId: string;
  workspaceId: string | null;
  modelId: string;
  messages: PlannerChatMessage[];
  toolCalls: PlannerLlmToolCall[];
  /** Index into `toolCalls` of the call awaiting a decision. */
  index: number;
  iteration: number;
}

type TurnStep =
  | { done: true; content: string }
  | {
      done: false;
      pendingId: string;
      toolName: string;
      argsSummary: string;
    };

/**
 * PA-6: planner chat CRUD and the turn loop.
 *
 * Phase 2 added a text-only loop; phase 3 added read-only tool-calling; phase
 * 4 adds mutating tools gated by remembered approvals or a pause-and-resume
 * round-trip (`approval.ts`'s doc comment explains why a pause rather than a
 * blocking wait). Read-only tools still execute immediately, no gate.
 *
 * Tool calls and their results are **not** persisted to the transcript —
 * only the user's message and the model's final text reply are. The
 * transcript stays the clean back-and-forth a human would want to read back;
 * a turn's tool exchange (including any approval pause) is scratch work for
 * producing that reply, not part of the conversation itself.
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

  async history(id: string): Promise<PlannerTranscriptEntry[]> {
    const chat = this.requireChat(id);
    return readTranscript(this.workspacePathFor(chat), chat.id);
  }

  /**
   * Run one turn: append the user message, then drive the tool loop until it
   * finishes or pauses on an unapproved mutating tool call.
   *
   * Throws `PlannerChatError('not_configured')` before ever calling out if
   * there is no provider base URL or no model to use — a clear, immediate
   * error beats a confusing failure from `fetch` against an empty string.
   */
  async sendMessage(
    id: string,
    content: string,
    opts: { modelId?: string; signal?: AbortSignal } = {},
  ): Promise<{ userEntry: PlannerTranscriptEntry; turn: PlannerTurnResult }> {
    const chat = this.requireChat(id);
    const modelId = this.resolveModelId(chat, opts.modelId);

    const workspacePath = this.workspacePathFor(chat);
    const userEntry: PlannerTranscriptEntry = { role: 'user', content, createdAt: Date.now() };
    await appendTranscriptEntry(workspacePath, chat.id, userEntry);
    const history = await readTranscript(workspacePath, chat.id);
    const messages: PlannerChatMessage[] = history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));

    const turn = await this.driveAndFinish(chat, modelId, messages, 0, opts.signal);
    return { userEntry, turn };
  }

  /**
   * Resolve a paused turn's approval and continue it — possibly pausing
   * again on a *different* tool call in the same batch, possibly finishing.
   */
  async resolveApproval(
    chatId: string,
    approvalId: string,
    choice: PlannerToolApprovalChoice,
    signal?: AbortSignal,
  ): Promise<PlannerTurnResult> {
    const pending = this.pendingTurns.get(approvalId);
    if (!pending || pending.chatId !== chatId) {
      throw new PlannerChatError('No pending approval with that id for this chat.', 'not_found');
    }
    this.pendingTurns.delete(approvalId);
    const chat = this.requireChat(chatId);

    const call = pending.toolCalls[pending.index]!;
    rememberDecisionIfAsked(this.opts.db, choice, call.function.name, pending.workspaceId);
    const resultText =
      choice === 'deny' ? 'Denied by user.' : await this.executeTool(call.function.name, call.function.arguments);
    pending.messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });

    return this.driveAndFinish(
      chat,
      pending.modelId,
      pending.messages,
      pending.iteration,
      signal,
      { toolCalls: pending.toolCalls, index: pending.index + 1 },
    );
  }

  /** Runs the loop, then persists+returns a `completed` result or returns a `approval_required` one. */
  private async driveAndFinish(
    chat: PlannerChat,
    modelId: string,
    messages: PlannerChatMessage[],
    iteration: number,
    signal?: AbortSignal,
    resumeBatch?: { toolCalls: PlannerLlmToolCall[]; index: number },
  ): Promise<PlannerTurnResult> {
    const settings = readPlannerSettings(this.opts.db);
    // `sendMessage`/an earlier call in this same turn already checked
    // `settings.baseUrl` is set before any of this ran.
    const client = new PlannerLlmClient({
      baseUrl: settings.baseUrl!,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });

    let step: TurnStep;
    try {
      step = await this.runToolLoop(chat, modelId, messages, client, iteration, signal, resumeBatch);
    } catch (err) {
      this.opts.logger?.warn({ err, chat: chat.id, model: modelId }, 'planner LLM call failed');
      throw err;
    }

    if (!step.done) {
      return { status: 'approval_required', approvalId: step.pendingId, toolName: step.toolName, argsSummary: step.argsSummary };
    }

    const workspacePath = this.workspacePathFor(chat);
    const assistantEntry: PlannerTranscriptEntry = {
      role: 'assistant',
      content: step.content,
      createdAt: Date.now(),
    };
    await appendTranscriptEntry(workspacePath, chat.id, assistantEntry);
    updatePlannerChat(this.opts.db, chat.id, { lastModelId: modelId, lastActivityAt: assistantEntry.createdAt });
    writePlannerLastModelId(this.opts.db, modelId);

    return { status: 'completed', assistantEntry };
  }

  /**
   * Calls the LLM, executing read-only tool calls immediately and mutating
   * ones once approved (remembered or freshly granted), until it replies
   * with plain text, a mutating call needs a decision, or the iteration cap
   * is hit.
   */
  private async runToolLoop(
    chat: PlannerChat,
    modelId: string,
    messages: PlannerChatMessage[],
    client: PlannerLlmClient,
    iteration: number,
    signal?: AbortSignal,
    resumeBatch?: { toolCalls: PlannerLlmToolCall[]; index: number },
  ): Promise<TurnStep> {
    const toolSpecs = toOpenAiToolSpecs(this.tools);
    let batch = resumeBatch;

    for (;;) {
      if (!batch) {
        if (iteration >= MAX_TOOL_ITERATIONS) return { done: true, content: GIVE_UP_MESSAGE };
        const completion = await client.complete(modelId, messages, toolSpecs, signal);
        iteration++;
        if (completion.toolCalls.length === 0) return { done: true, content: completion.content ?? '' };
        messages.push({ role: 'assistant', content: completion.content, tool_calls: completion.toolCalls });
        batch = { toolCalls: completion.toolCalls, index: 0 };
      }

      while (batch.index < batch.toolCalls.length) {
        const call = batch.toolCalls[batch.index]!;
        const tool = findPlannerTool(call.function.name);

        if (tool && !tool.readOnly) {
          const decision = rememberedDecision(this.opts.db, call.function.name, chat.workspaceId);
          if (decision === null) {
            const pendingId = crypto.randomUUID();
            this.pendingTurns.set(pendingId, {
              chatId: chat.id,
              workspaceId: chat.workspaceId,
              modelId,
              messages,
              toolCalls: batch.toolCalls,
              index: batch.index,
              iteration,
            });
            return { done: false, pendingId, toolName: call.function.name, argsSummary: call.function.arguments };
          }
          if (decision === 'deny') {
            messages.push({ role: 'tool', tool_call_id: call.id, content: 'Denied by a remembered decision.' });
            batch.index++;
            continue;
          }
          // decision === 'allow': fall through and execute below.
        }

        const resultText = await this.executeTool(call.function.name, call.function.arguments);
        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
        batch.index++;
      }

      batch = undefined; // batch fully resolved — ask the model what's next
    }
  }

  private async executeTool(name: string, rawArguments: string): Promise<string> {
    const tool = findPlannerTool(name);
    if (!tool) return `Unknown tool: ${name}`;
    let args: Record<string, unknown>;
    try {
      args = rawArguments ? (JSON.parse(rawArguments) as Record<string, unknown>) : {};
    } catch {
      return `Invalid JSON arguments for tool "${name}".`;
    }
    try {
      return await tool.execute(
        {
          workspaces: this.opts.workspaces,
          plannerWorkspaces: this.opts.plannerWorkspaces,
          sessions: this.opts.sessions,
          worktrees: this.opts.worktrees,
          historyDeps: this.opts.historyDeps,
        },
        args,
      );
    } catch (err) {
      return `Error running tool "${name}": ${(err as Error).message}`;
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
