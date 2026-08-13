import type { Config } from './config/index.js';
import type { AuthService } from './auth/index.js';
import type { SessionManager } from './sessions/manager.js';
import type { WorkspaceRegistry } from './workspaces/index.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ProcessBackend } from './backends/index.js';
import type { Db } from './db/index.js';
import type { PushService } from './push/index.js';
import type { ConversationStore } from './conversations/index.js';
import type { AdoptionService } from './adopt/index.js';
import type { ProjectService } from './projects/index.js';
import type { UsageService } from './usage/index.js';

export interface PocketContext {
  config: Config;
  auth: AuthService;
  sessions: SessionManager;
  workspaces: WorkspaceRegistry;
  agents: AgentRegistry;
  db: Db;
  backend: ProcessBackend;
  push: PushService;
  conversations: ConversationStore;
  adoption: AdoptionService;
  projects: ProjectService;
  usage: UsageService;
}

declare module 'fastify' {
  interface FastifyInstance {
    pocket: PocketContext;
  }
}
