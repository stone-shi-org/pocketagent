import type { Config } from './config/index.js';
import type { AuthService } from './auth/index.js';
import type { HubCredentialStore } from './auth/hub-credentials.js';
import type { SessionManager } from './sessions/manager.js';
import type { WorkspaceRegistry } from './workspaces/index.js';
import type { AgentRegistry } from './agents/registry.js';
import type { AgentInstallService } from './agents/install.js';
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
import type { PlannerMemoryService } from './planner/memory.js';
import type { McpRegistryService } from './planner/mcp/registry-service.js';
import type { SkillRegistryService } from './planner/skills.js';
import type { TelegramBotStore } from './telegram/bots-store.js';
import type { TelegramLinksStore } from './telegram/links-store.js';
import type { AdminService } from './admin/index.js';

export interface PocketContext {
  config: Config;
  auth: AuthService;
  /** PA-63: hub credentials — the second credential class, checked by the same
      `onRequest` gate that checks a session cookie. */
  hubCredentials: HubCredentialStore;
  sessions: SessionManager;
  /** PA-69: is it safe to stop, and the seam through which we ask to. */
  admin: AdminService;
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
  /** PA-29: the memory system — see `planner/memory.ts`'s doc comment. */
  plannerMemory: PlannerMemoryService;
  /** PA-37: MCP registries — see `planner/mcp/registry-service.ts`'s doc comment. */
  mcpRegistry: McpRegistryService;
  /** PA-38: skills — see `planner/skills.ts`'s doc comment. */
  skills: SkillRegistryService;
  /** Where the global skills catalog lives on disk. */
  plannerSkillsRoot: string;
  /** PA-29: injected in tests so a route that builds its own ad hoc
      `PlannerLlmClient` (`POST /api/planner/settings/embeddings/test`) never
      makes a real network call either — the same fetch override
      `PlannerChatService`/`MemoryConsolidationService` already accept via
      their own constructors, just decorated here too since this one route
      builds a client directly rather than through either service. */
  plannerLlmFetch?: typeof fetch;
  agents: AgentRegistry;
  /** PA-68: on-demand agent CLI installation — see `agents/install.ts`. */
  agentInstall: AgentInstallService;
  /** PA-28: user-managed Claude Code provider variants, kept in sync with `agents`. */
  customClaudeProviders: CustomClaudeProviderStore;
  /** PA-53: Telegram bots (secret-backed rows) and their Telegram-id -> Pocket
      Agent pairings — see `telegram/bridge.ts`'s doc comment for how a chat
      turn is driven from an inbound message. */
  telegramBots: TelegramBotStore;
  telegramLinks: TelegramLinksStore;
  /** Injected in tests so a Telegram "Test" button's `getMe()` call
      (`routes/telegram.ts`) never makes a real network call — same reasoning
      as `plannerLlmFetch`. */
  telegramFetch?: typeof fetch;
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
