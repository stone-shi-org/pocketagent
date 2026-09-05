import crypto from 'node:crypto';
import type { PlannerChat, PlannerTranscriptEntry } from '@pocketagent/protocol';
import type { Db } from '../db/index.js';
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
import { PlannerLlmClient } from './llm-client.js';

export class PlannerChatError extends Error {
  override readonly name = 'PlannerChatError';
  constructor(
    message: string,
    readonly code: 'not_found' | 'invalid' | 'not_configured',
  ) {
    super(message);
  }
}

export interface PlannerChatServiceOptions {
  db: Db;
  plannerWorkspaces: PlannerWorkspaceRegistry;
  logger?: { warn: (obj: unknown, msg?: string) => void };
  /** Injected in tests so no real network call is ever made. */
  llmFetch?: typeof fetch;
}

/**
 * PA-6, phase 2 (chat core): planner chat CRUD and the turn loop.
 *
 * No tools, no approval gate — a turn is exactly "append the user's message,
 * ask the configured LLM for a reply given the whole running transcript,
 * append and return that reply". Those are later phases (see PA-6); this is
 * deliberately the smallest thing that is a real, usable chat.
 */
export class PlannerChatService {
  constructor(private readonly opts: PlannerChatServiceOptions) {}

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
   * full running history, append and return the assistant's reply.
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

    let replyText: string;
    try {
      replyText = await client.complete(
        modelId,
        history.map((entry) => ({ role: entry.role, content: entry.content })),
        opts.signal,
      );
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
