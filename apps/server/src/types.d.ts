import type { Config } from './config/index.js';
import type { AuthService } from './auth/index.js';
import type { HubCredentialIdentity, HubCredentialStore } from './auth/hub-credentials.js';
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
import type { McpTokenStore, McpClientIdentity } from './auth/mcp-tokens.js';
import type { McpWorkService } from './mcp-server/work.js';
import type { McpServerService } from './mcp-server/server.js';
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
import type { GeminiLiveService } from './planner/gemini-live.js';
import type { TelegramLinksStore } from './telegram/links-store.js';
import type { AdminService } from './admin/index.js';
import type { VoiceTtsService } from './voice/tts-service.js';

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
  /** PA-20 Phase 3: sentence-chunked TTS for live-listen/talk-back mode —
      see `voice/tts-service.ts`'s doc comment. */
  voiceTts: VoiceTtsService;
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
  /** PA-96: the encrypted Gemini API key and ephemeral-token minting. */
  geminiLive: GeminiLiveService;
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
  /** PA-118: the MCP server — its tokens, its work-starting half and its endpoint. */
  mcpTokens: McpTokenStore;
  mcpWork: McpWorkService;
  mcpServer: McpServerService;
}

declare module 'fastify' {
  interface FastifyInstance {
    pocket: PocketContext;
  }

  interface FastifyRequest {
    /**
     * PA-70: set by `app.ts`'s single auth gate when a *hub credential*
     * authenticated this request, and left undefined for a cookie session.
     *
     * It exists so a mutation can name who made it. PA-63 deliberately kept
     * the gate the only thing that knows hub credentials exist, and this does
     * not weaken that: no route consults it to *decide* anything — a hub
     * credential is full-access exactly like a session, by that ticket's own
     * design — it is read only by audit lines, which is the one question a
     * route legitimately has about its caller.
     */
    hubPrincipal?: HubCredentialIdentity;
    /**
     * PA-118: set by the same gate when this request is an MCP client's — a
     * `pam_` token on the MCP endpoint, a hub credential on the MCP endpoint
     * (full scopes, labelled `hub:<label>`), or an MCP tool's own in-process
     * call to a route (`mcp-server/internal-api.ts`). Read by audit lines, and
     * by exactly one decision: an MCP principal may not manage MCP tokens.
     */
    mcpPrincipal?: McpClientIdentity;
  }
}
