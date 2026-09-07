import type { Config } from './config/index.js';
import type { AuthService } from './auth/index.js';
import type { SessionManager } from './sessions/manager.js';
import type { WorkspaceRegistry } from './workspaces/index.js';
import type { AgentRegistry } from './agents/registry.js';
import type { CustomClaudeProviderStore } from './agents/custom-providers-store.js';
import type { ProcessBackend } from './backends/index.js';
import type { Db } from './db/index.js';
import type { PushService } from './push/index.js';
import type { ConversationStore } from './conversations/index.js';
import type { AgyTranscriptStore } from './conversations/agy.js';
import type { PiTranscriptStore } from './conversations/pi.js';
import type { AdoptionService } from './adopt/index.js';
import type { ProjectService } from './projects/index.js';
import type { UsageService } from './usage/index.js';
import type { WorktreeService } from './git/worktree.js';
import type { CronService } from './cron/index.js';
import type { WebhookService } from './webhooks/index.js';
import type { PromptQueueService } from './sessions/prompt-queue.js';
import type { PlannerWorkspaceRegistry } from './planner/workspaces.js';
import type { PlannerChatService } from './planner/chats.js';

export interface PocketContext {
  config: Config;
  auth: AuthService;
  sessions: SessionManager;
  cron: CronService;
  webhooks: WebhookService;
  /** PA-11: a human's follow-up prompts waiting on a busy working tree. */
  promptQueue: PromptQueueService;
  workspaces: WorkspaceRegistry;
  /** PA-6 phase 1: the planner's own app-owned scratch/skills directories. */
  plannerWorkspaces: PlannerWorkspaceRegistry;
  /** Where a new planner workspace's directory is created on disk. */
  plannerWorkspacesRoot: string;
  /** PA-6 phase 2: planner chat CRUD and the turn loop. */
  plannerChats: PlannerChatService;
  agents: AgentRegistry;
  /** PA-28: user-managed Claude Code provider variants, kept in sync with `agents`. */
  customClaudeProviders: CustomClaudeProviderStore;
  db: Db;
  backend: ProcessBackend;
  push: PushService;
  conversations: ConversationStore;
  agyTranscripts: AgyTranscriptStore;
  piTranscripts: PiTranscriptStore;
  adoption: AdoptionService;
  projects: ProjectService;
  usage: UsageService;
  worktrees: WorktreeService;
}

declare module 'fastify' {
  interface FastifyInstance {
    pocket: PocketContext;
  }
}
