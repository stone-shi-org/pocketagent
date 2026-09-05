import crypto from 'node:crypto';
import type { PlannerChat, PlannerTranscriptEntry } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { SessionManager } from '../sessions/manager.js';
import type { SessionHistoryDeps } from '../sessions/history.js';
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
import { appendTranscriptEntry, readTranscript } from './transcript.js';
import { PlannerLlmClient, type PlannerChatMessage } from './llm-client.js';
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
    so nothing here has ever needed a backstop like this one. */
const MAX_TOOL_ITERATIONS = 8;

export interface PlannerChatServiceOptions {
  db: Db;
  workspaces: WorkspaceRegistry;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  sessions: SessionManager;
  historyDeps: SessionHistoryDeps;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
  /** Injected in tests to control exactly which tools are offered. Defaults to `PLANNER_TOOLS`. */
  tools?: readonly PlannerToolDefinition[];
}

/**
 * PA-6: planner chat CRUD and the turn loop.
 *
 * Phase 2 added a text-only loop; phase 3 adds read-only tool-calling — every
 * tool in `PLANNER_TOOLS` is `readOnly: true` (per the reporter's answer to
 * PA-6 open question 1), so each is executed the moment the model asks for it,
 * with no approval round-trip. A future phase's mutating tools will need the
 * approval gate this loop does not yet have; `execute()` below already
 * special-cases `readOnly` so that gate can slot in without restructuring the
 * loop itself.
 *
 * Tool calls and their results are **not** persisted to the transcript —
 * only the user's message and the model's final text reply are. The
 * transcript stays the clean back-and-forth a human would want to read back;
 * a turn's tool exchange is scratch work for producing that reply, not part
 * of the conversation itself. This does mean a later turn's context doesn't
 * include what earlier tool calls found — acceptable for now since each turn
 * can simply call the same read-only tools again, and revisited if a future
 * phase finds that limiting.
 */
export class PlannerChatService {
  private readonly tools: readonly PlannerToolDefinition[];

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
    return deletePlannerChat(this.opts.db, id);
  }

  async history(id: string): Promise<PlannerTranscriptEntry[]> {
    const chat = this.requireChat(id);
    return readTranscript(this.workspacePathFor(chat), chat.id);
  }

  /**
   * Run one turn: append the user message, call the configured LLM with the
   * full running history (and the read-only tool catalog), executing any
   * tool calls it asks for until it returns a plain text reply, then append
   * and return that reply.
   *
   * Throws `PlannerChatError('not_configured')` before ever calling out if
   * there is no provider base URL or no model to use — a clear, immediate
   * error beats a confusing failure from `fetch` against an empty string.
   */
  async sendMessage(
    id: string,
    content: string,
    opts: { modelId?: string; signal?: AbortSignal } = {},
  ): Promise<{ userEntry: PlannerTranscriptEntry; assistantEntry: PlannerTranscriptEntry }> {
    const chat = this.requireChat(id);
    const settings = readPlannerSettings(this.opts.db);
    if (!settings.baseUrl) {
      throw new PlannerChatError('Planner LLM endpoint is not configured.', 'not_configured');
    }
    const modelId = opts.modelId ?? chat.lastModelId ?? settings.lastModelId;
    if (!modelId) {
      throw new PlannerChatError('No model selected, and none is configured.', 'not_configured');
    }

    const workspacePath = this.workspacePathFor(chat);

    const userEntry: PlannerTranscriptEntry = { role: 'user', content, createdAt: Date.now() };
    await appendTranscriptEntry(workspacePath, chat.id, userEntry);
    const history = await readTranscript(workspacePath, chat.id);

    const client = new PlannerLlmClient({
      baseUrl: settings.baseUrl,
      apiKey: revealPlannerApiKey(this.opts.db),
      ...(this.opts.llmFetch ? { fetchImpl: this.opts.llmFetch } : {}),
    });

    const messages: PlannerChatMessage[] = history.map((entry) => ({
      role: entry.role,
      content: entry.content,
    }));
    const toolSpecs = toOpenAiToolSpecs(this.tools);

    let replyText: string;
    try {
      replyText = await this.runToolLoop(client, modelId, messages, toolSpecs, opts.signal);
    } catch (err) {
      this.opts.logger?.warn({ err, chat: id, model: modelId }, 'planner LLM call failed');
      throw err;
    }

    const assistantEntry: PlannerTranscriptEntry = {
      role: 'assistant',
      content: replyText,
      createdAt: Date.now(),
    };
    await appendTranscriptEntry(workspacePath, chat.id, assistantEntry);

    updatePlannerChat(this.opts.db, chat.id, {
      lastModelId: modelId,
      lastActivityAt: assistantEntry.createdAt,
    });
    writePlannerLastModelId(this.opts.db, modelId);

    return { userEntry, assistantEntry };
  }

  /**
   * Calls the LLM, executing every tool call it returns and feeding the
   * results back, until it replies with plain text (or the iteration cap is
   * hit). Every tool offered today is read-only, so every call executes
   * immediately — see this class's doc comment for what changes once a
   * mutating tool needs the approval gate.
   */
  private async runToolLoop(
    client: PlannerLlmClient,
    modelId: string,
    messages: PlannerChatMessage[],
    toolSpecs: unknown[],
    signal?: AbortSignal,
  ): Promise<string> {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const completion = await client.complete(modelId, messages, toolSpecs, signal);
      if (completion.toolCalls.length === 0) {
        return completion.content ?? '';
      }

      messages.push({
        role: 'assistant',
        content: completion.content,
        tool_calls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        const resultText = await this.executeTool(call.function.name, call.function.arguments);
        messages.push({ role: 'tool', tool_call_id: call.id, content: resultText });
      }
    }

    return (
      "I made too many tool calls without reaching an answer — try narrowing your request, " +
      'or ask me to summarize what I found so far.'
    );
  }

  private async executeTool(name: string, rawArguments: string): Promise<string> {
    const tool = findPlannerTool(name);
    if (!tool) return `Unknown tool: ${name}`;
    if (!tool.readOnly) {
      // Unreachable while `PLANNER_TOOLS` is read-only-only; guards against a
      // future mutating tool being wired in here before the approval gate
      // (a later phase) exists to gate it.
      return `Tool "${name}" requires approval, which this chat does not support yet.`;
    }
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
          historyDeps: this.opts.historyDeps,
        },
        args,
      );
    } catch (err) {
      return `Error running tool "${name}": ${(err as Error).message}`;
    }
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
