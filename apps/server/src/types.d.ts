import type { Config } from './config/index.js';
import type { AuthService } from './auth/index.js';
import type { SessionManager } from './sessions/manager.js';
import type { WorkspaceRegistry } from './workspaces/index.js';
import type { AgentRegistry } from './agents/registry.js';
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

export interface PocketContext {
  config: Config;
  auth: AuthService;
  sessions: SessionManager;
  cron: CronService;
  webhooks: WebhookService;
  workspaces: WorkspaceRegistry;
  agents: AgentRegistry;
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
