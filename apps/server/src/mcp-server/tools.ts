import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  AttachmentIdList,
  EffortLevel,
  MAX_ATTACHMENT_NAME_CHARS,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_MCP_ATTACHMENT_BYTES,
  MCP_SERVER_PATH,
  type AgentInfo,
  type McpProtocolEra,
  type McpScope,
  type ProjectInfo,
  type SessionInfo,
} from '@pocketagent/protocol';
import type { PocketContext } from '../types.js';
import type { McpClientIdentity } from '../auth/mcp-tokens.js';
import { readMcpOwnedWork } from '../db/index.js';
import type { StructuredLikeSession } from '../sessions/manager.js';
import { summarizeEvents, truncate, truncateTail } from '../planner/tools.js';
import type { InternalApiClient } from './internal-api.js';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_WAIT_SECONDS,
  type McpWorkService,
  type StartSessionInput,
  type TurnResult,
} from './work.js';

const execFileAsync = promisify(execFile);

/**
 * PA-118: the MCP tool catalog.
 *
 * Every tool is a thin adapter over something that already exists — a service
 * call, or (for the tools that mirror a route) an in-process call to that very
 * route through `InternalApiClient`, so validation, response shapes and audit
 * lines are the route's own. Nothing here is a second implementation of a rule.
 *
 * What is *absent* is as deliberate as what is present, and a test
 * (`mcp-server-tools.test.ts`) pins it: no tool answers an approval, no input
 * carries `skipPermissions` or `force`, nothing takes an executable or argv,
 * nothing installs an agent or restarts the server, and the planner's raw
 * `exec_command`/`bash`/`write_file`/`rmdir` are not re-exported — MCP has no
 * pause/resume, so those would be a remote shell with no approval gate at all.
 */

export interface McpToolContext {
  principal: McpClientIdentity;
  /** PocketAgent hops already behind this request (`MCP_DEPTH_HEADER`). */
  depth: number;
  /** Which MCP protocol era this call arrived on. */
  era: McpProtocolEra;
  /** The revision a modern request declared; `null` on a legacy session. */
  protocolVersion: string | null;
  signal: AbortSignal;
  progress: (message: string, elapsedMs: number) => void;
}

export interface McpToolDeps {
  pocket: PocketContext;
  work: McpWorkService;
  api: InternalApiClient;
}

export interface McpToolDefinition {
  name: string;
  scope: McpScope;
  /** PA-137: further scopes that also offer this tool (`upload_attachment`
      serves both `sessions` and `planner`). Any one is enough. */
  alsoScopes?: readonly McpScope[];
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  destructive?: boolean;
  handler: (deps: McpToolDeps, ctx: McpToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_TEXT = 20_000;

/** PA-137: whether a token holding `scopes` may use `tool`. */
export function toolAllowed(tool: McpToolDefinition, scopes: Iterable<McpScope>): boolean {
  const held = new Set(scopes);
  return held.has(tool.scope) || (tool.alsoScopes ?? []).some((s) => held.has(s));
}

/** PA-137: base64 of `MAX_MCP_ATTACHMENT_BYTES`, the longest `dataBase64` accepted. */
const MAX_MCP_ATTACHMENT_BASE64 = Math.ceil(MAX_MCP_ATTACHMENT_BYTES / 3) * 4;

const attachmentsInput = AttachmentIdList.optional().describe(
  `Up to ${MAX_ATTACHMENTS_PER_PROMPT} attachment ids from upload_attachment. Each is single-use and only this client's.`,
);

function attachmentIds(args: Record<string, unknown>): string[] {
  return Array.isArray(args.attachments) ? (args.attachments as string[]) : [];
}
const sessionId = z.string().min(1).max(200).describe('A session id from list_sessions.');
const chatId = z.string().min(1).max(200).describe('A Pocket Agent chat id from list_pocket_chats.');
const limit = (max: number, def: number) =>
  z.number().int().min(1).max(max).optional().describe(`Maximum results (default ${def}, max ${max}).`);
const waitSeconds = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_SECONDS)
  .optional()
  .describe(
    `How long to wait for the turn to finish, in seconds (default ${DEFAULT_WAIT_SECONDS}, max ${MAX_WAIT_SECONDS}). ` +
      'The timeout ends the wait, never the turn: call wait_for_turn again to keep waiting.',
  );

/** Narrow a session to what a caller needs, never more. */
function sessionView(info: SessionInfo, deps: McpToolDeps): Record<string, unknown> {
  const owner = readMcpOwnedWork(deps.pocket.db, 'session', info.id);
  return {
    id: info.id,
    title: info.title,
    agent: info.agent,
    agentDisplayName: info.agentDisplayName,
    transport: info.transport,
    status: info.status,
    cwd: info.cwd,
    conversationId: info.agentSessionId,
    busy: info.busy,
    busySince: info.busySince,
    createdAt: info.createdAt,
    lastActivityAt: info.lastActivityAt,
    skipPermissionsEnabled: info.skipPermissionsEnabled,
    providerDisclosure: info.providerDisclosure ?? null,
    startedByMcpClient: owner?.client_label ?? null,
  };
}

function agentView(agent: AgentInfo): Record<string, unknown> {
  // Deliberately not `resolvedPath`/`otherCopies`: a caller asking "which
  // agents can I use" needs ids and readiness, not this machine's filesystem.
  return {
    id: agent.id,
    displayName: agent.displayName,
    description: agent.description,
    available: agent.available,
    setupState: agent.setupState,
    transports: agent.transports,
    structured: agent.transports.includes('structured'),
    defaultModel: agent.defaultModel,
    models: (agent.staticModels.length > 0 ? agent.staticModels : agent.cachedModels).map((m) => m.value ?? m),
    providerDisclosure: agent.providerDisclosure,
  };
}

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function trimProject(project: ProjectInfo, maxChats: number): Record<string, unknown> {
  const chats = project.chats.slice(0, maxChats);
  return {
    cwd: project.cwd,
    name: project.name,
    gitBranch: project.gitBranch,
    chats: chats.map((c) => ({
      id: c.id,
      sessionId: c.sessionId,
      conversationId: c.conversationId,
      title: c.title,
      agent: c.agent,
      status: c.status,
      live: c.live,
      updatedAt: c.updatedAt,
      startedBy: c.cronJobId ? 'cron' : c.webhookId ? 'webhook' : c.plannerChatId ? 'pocket-agent' : c.mcpClient ? `mcp:${c.mcpClient}` : 'human',
    })),
    moreChats: Math.max(0, project.chats.length - chats.length),
    worktrees: project.worktrees.map((w) => ({ cwd: w.cwd, name: w.name, gitBranch: w.gitBranch, chats: w.chats.length })),
    cronJobs: project.cronJobs.map((j) => ({ id: j.id, name: j.name, enabled: j.enabled })),
    queued: project.queued ?? [],
  };
}

function eventsText(events: Parameters<typeof summarizeEvents>[0], maxChars: number, tail: boolean): string {
  if (events.length === 0) return '(no transcript yet)';
  const text = summarizeEvents(events);
  return tail ? truncateTail(text, maxChars) : truncate(text, maxChars);
}

async function waitWithProgress(
  ctx: McpToolContext,
  run: (opts: { signal: AbortSignal; onProgress: (ms: number) => void }) => Promise<TurnResult>,
): Promise<TurnResult> {
  return run({ signal: ctx.signal, onProgress: (ms) => ctx.progress('Waiting for the turn to finish…', ms) });
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  // ---- read ----------------------------------------------------------------
  {
    name: 'get_host_info',
    scope: 'read',
    title: 'Host info',
    description: 'Which PocketAgent machine this is: name, version, running sessions, and the scopes your token holds.',
    input: {},
    readOnly: true,
    async handler(deps, ctx) {
      return {
        host: deps.pocket.projects.host(),
        mcpEndpoint: MCP_SERVER_PATH,
        protocol: { era: ctx.era, version: ctx.protocolVersion },
        client: { label: ctx.principal.label, scopes: ctx.principal.scopes },
        liveSessionsStartedByYou: deps.work.liveSessionsFor(ctx.principal.id),
      };
    },
  },
  {
    name: 'list_agents',
    scope: 'read',
    title: 'List coding agents',
    description:
      'Coding agents installed on this machine (claude, codex, opencode, …) with readiness (setupState). ' +
      'Only agents with a structured transport can be started over MCP.',
    input: {},
    readOnly: true,
    async handler(deps, ctx) {
      const agents = await deps.api.call<AgentInfo[] | { agents: AgentInfo[] }>(ctx.principal, 'GET', '/api/agents');
      const list = Array.isArray(agents) ? agents : agents.agents;
      return { agents: list.map(agentView) };
    },
  },
  {
    name: 'list_workspaces',
    scope: 'read',
    title: 'List project folders',
    description: 'Project folders added to PocketAgent. Sessions can only run inside one of these (or a folder below one).',
    input: {},
    readOnly: true,
    async handler(deps) {
      return { workspaces: await deps.pocket.workspaces.list() };
    },
  },
  {
    name: 'list_projects',
    scope: 'read',
    title: 'List projects and chats',
    description:
      'The home screen: each project directory with its chats (live and finished), worktrees, scheduled jobs and queued work.',
    input: {
      cwd: z.string().max(4096).optional().describe('Only projects at or below this directory.'),
      maxChatsPerProject: limit(200, 20),
    },
    readOnly: true,
    async handler(deps, ctx, args) {
      const res = await deps.api.call<{ projects: ProjectInfo[]; shells: unknown[] }>(ctx.principal, 'GET', '/api/projects');
      const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : null;
      const max = (args.maxChatsPerProject as number | undefined) ?? 20;
      const projects = res.projects.filter((p) => cwd === null || within(cwd, p.cwd) || within(p.cwd, cwd));
      return { projects: projects.map((p) => trimProject(p, max)) };
    },
  },
  {
    name: 'list_sessions',
    scope: 'read',
    title: 'List sessions',
    description: 'Coding-agent sessions, most recent first.',
    input: {
      status: z.enum(['live', 'finished', 'all']).optional().describe('Default "all".'),
      agent: z.string().max(200).optional(),
      cwd: z.string().max(4096).optional().describe('Only sessions at or below this directory.'),
      limit: limit(200, 50),
    },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const status = (args.status as string | undefined) ?? 'all';
      const cwd = typeof args.cwd === 'string' ? path.resolve(args.cwd) : null;
      const max = (args.limit as number | undefined) ?? 50;
      const list = deps.pocket.sessions
        .list(500)
        .filter((s) => {
          const live = s.status === 'starting' || s.status === 'running';
          if (status === 'live' && !live) return false;
          if (status === 'finished' && live) return false;
          if (typeof args.agent === 'string' && s.agent !== args.agent) return false;
          if (cwd !== null && !within(cwd, s.cwd)) return false;
          return true;
        })
        .slice(0, max);
      return { sessions: list.map((s) => sessionView(s, deps)) };
    },
  },
  {
    name: 'get_session',
    scope: 'read',
    title: 'Get a session',
    description: 'One session: status, whether it is mid-turn, pending approvals and queued prompts.',
    input: { sessionId },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const id = String(args.sessionId);
      const info = deps.pocket.sessions.find(id);
      if (!info) throw new Error(`No session ${id}.`);
      const live = deps.pocket.sessions.get(id);
      const pending =
        live && live.transport === 'structured'
          ? (live as StructuredLikeSession).pendingPermissions().map((p) => ({ toolName: p.toolName, title: p.title }))
          : [];
      return {
        session: sessionView(info, deps),
        pendingApprovals: pending,
        queuedPrompts: deps.pocket.promptQueue.forSession(id).length,
      };
    },
  },
  {
    name: 'read_session_history',
    scope: 'read',
    title: 'Read a session transcript',
    description: 'A readable transcript of a session (prompts, replies, tool calls and results), newest content kept.',
    input: {
      sessionId,
      maxChars: z.number().int().min(500).max(100_000).optional().describe('Default 20000.'),
    },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const id = String(args.sessionId);
      if (!deps.pocket.sessions.find(id)) throw new Error(`No session ${id}.`);
      const { events, conversationId } = await deps.work.sessionEvents(id);
      return {
        sessionId: id,
        conversationId,
        transcript: eventsText(events, (args.maxChars as number | undefined) ?? MAX_TEXT, true),
      };
    },
  },
  {
    name: 'list_conversations',
    scope: 'read',
    title: 'List Claude conversations on disk',
    description: 'Finished Claude Code conversations inside project folders, resumable with start_session(resumeConversationId).',
    input: { limit: limit(200, 40) },
    readOnly: true,
    async handler(deps, _ctx, args) {
      return { conversations: await deps.pocket.conversations.list((args.limit as number | undefined) ?? 40) };
    },
  },
  {
    name: 'read_conversation',
    scope: 'read',
    title: 'Read a conversation',
    description: 'Read a Claude Code conversation straight off disk. Starts no agent process.',
    input: {
      conversationId: z.string().min(1).max(200),
      maxChars: z.number().int().min(500).max(100_000).optional(),
    },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const info = await deps.pocket.conversations.find(String(args.conversationId));
      if (!info) throw new Error('No such conversation.');
      const events = await deps.pocket.conversations.historyForConversation(info);
      return {
        conversation: info,
        transcript: eventsText(events, (args.maxChars as number | undefined) ?? MAX_TEXT, true),
      };
    },
  },
  {
    name: 'list_pocket_agents',
    scope: 'read',
    title: 'List Pocket Agents',
    description: 'Pocket Agents (planner agents) configured on this machine.',
    input: {},
    readOnly: true,
    async handler(deps) {
      return {
        pocketAgents: deps.pocket.plannerWorkspaces.list().map((w) => ({
          id: w.id,
          name: w.name,
          defaultModelId: w.defaultModelId ?? null,
          liveProvider: w.liveProvider,
        })),
      };
    },
  },
  {
    name: 'list_pocket_chats',
    scope: 'read',
    title: 'List Pocket Agent chats',
    description: 'Pocket Agent chats, optionally for one agent.',
    input: { workspaceId: z.string().max(200).optional().describe('A Pocket Agent id from list_pocket_agents.'), limit: limit(200, 50) },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const chats = deps.pocket.plannerChats
        .list(typeof args.workspaceId === 'string' ? args.workspaceId : undefined)
        .slice(0, (args.limit as number | undefined) ?? 50);
      return {
        chats: chats.map((c) => ({
          id: c.id,
          title: c.title,
          workspaceId: c.workspaceId,
          busy: c.busy,
          lastActivityAt: c.lastActivityAt,
          createdByMcpClient: readMcpOwnedWork(deps.pocket.db, 'planner_chat', c.id)?.client_label ?? null,
        })),
      };
    },
  },
  {
    name: 'read_pocket_chat',
    scope: 'read',
    title: 'Read a Pocket Agent chat',
    description: 'A readable transcript of a Pocket Agent chat.',
    input: { chatId, maxChars: z.number().int().min(500).max(100_000).optional() },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const id = String(args.chatId);
      const chat = deps.pocket.plannerChats.get(id);
      if (!chat) throw new Error(`No Pocket Agent chat ${id}.`);
      const events = await deps.pocket.plannerChats.history(id);
      return {
        chat: { id: chat.id, title: chat.title, workspaceId: chat.workspaceId, busy: chat.busy },
        transcript: eventsText(events, (args.maxChars as number | undefined) ?? MAX_TEXT, true),
      };
    },
  },
  {
    name: 'list_cron_jobs',
    scope: 'read',
    title: 'List scheduled jobs',
    description: 'Scheduled (cron) jobs. Read-only over MCP.',
    input: {},
    readOnly: true,
    async handler(deps) {
      return { jobs: deps.pocket.cron.list().map((row) => deps.pocket.cron.toJob(row)) };
    },
  },
  {
    name: 'list_cron_runs',
    scope: 'read',
    title: 'List scheduled-job runs',
    description: 'Recent runs of scheduled jobs, optionally for one job.',
    input: { jobId: z.string().max(200).optional(), limit: limit(200, 50) },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const rows = deps.pocket.cron.runs({
        ...(typeof args.jobId === 'string' ? { jobId: args.jobId } : {}),
        limit: (args.limit as number | undefined) ?? 50,
      });
      return { runs: rows.map((row) => deps.pocket.cron.toRun(row)) };
    },
  },
  {
    name: 'list_webhooks',
    scope: 'read',
    title: 'List inbound webhooks',
    description: 'Inbound webhooks (Jira, Bamboo). Read-only; secrets are never returned.',
    input: {},
    readOnly: true,
    async handler(deps) {
      return { webhooks: deps.pocket.webhooks.list().map((row) => deps.pocket.webhooks.toWebhook(row)) };
    },
  },
  {
    name: 'list_webhook_deliveries',
    scope: 'read',
    title: 'List webhook deliveries',
    description: 'Recent webhook deliveries and what each one did.',
    input: { webhookId: z.string().max(200).optional(), limit: limit(200, 50) },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const rows = deps.pocket.webhooks.deliveries({
        ...(typeof args.webhookId === 'string' ? { webhookId: args.webhookId } : {}),
        limit: (args.limit as number | undefined) ?? 50,
      });
      return { deliveries: rows.map((row) => deps.pocket.webhooks.toDelivery(row)) };
    },
  },
  {
    name: 'get_usage',
    scope: 'read',
    title: 'Agent usage and rate limits',
    description: 'Each agent provider’s current usage and rate-limit window, to decide whether to start more work now.',
    input: {},
    readOnly: true,
    async handler(deps) {
      return { usage: await deps.pocket.usage.list() };
    },
  },
  {
    name: 'list_worktrees',
    scope: 'read',
    title: 'List worktrees',
    description: 'Git worktrees of one project folder, as the home screen groups them.',
    input: { cwd: z.string().min(1).max(4096).describe('The project folder.') },
    readOnly: true,
    async handler(deps, ctx, args) {
      const cwd = path.resolve(String(args.cwd));
      const res = await deps.api.call<{ projects: ProjectInfo[] }>(ctx.principal, 'GET', '/api/projects');
      const project = res.projects.find((p) => p.cwd === cwd);
      if (!project) throw new Error(`No project at ${cwd}.`);
      return { worktrees: project.worktrees.map((w) => ({ cwd: w.cwd, name: w.name, gitBranch: w.gitBranch, chats: w.chats.length })) };
    },
  },
  {
    name: 'list_pending_approvals',
    scope: 'read',
    title: 'List pending approvals',
    description:
      'Tool calls waiting for a human to approve, across every live session. Read-only: MCP clients can see an ' +
      'approval but can never answer one — a person answers in PocketAgent.',
    input: {},
    readOnly: true,
    async handler(deps) {
      const approvals: Record<string, unknown>[] = [];
      for (const info of deps.pocket.sessions.list(500)) {
        const live = deps.pocket.sessions.get(info.id);
        if (!live || live.transport !== 'structured') continue;
        for (const p of (live as StructuredLikeSession).pendingPermissions()) {
          approvals.push({ sessionId: info.id, sessionTitle: info.title, toolName: p.toolName, title: p.title, filePath: p.filePath });
        }
      }
      return { approvals };
    },
  },
  {
    name: 'get_session_diff',
    scope: 'read',
    title: 'Diff of a session’s working tree',
    description: 'git status and diff (against HEAD) of the directory a session works in — what it changed.',
    input: { sessionId, maxChars: z.number().int().min(500).max(200_000).optional().describe('Default 40000.') },
    readOnly: true,
    async handler(deps, _ctx, args) {
      const id = String(args.sessionId);
      const info = deps.pocket.sessions.find(id);
      if (!info) throw new Error(`No session ${id}.`);
      // Re-validated, never trusted from the row: a folder can leave the
      // workspace list long after the session ran in it.
      const cwd = await deps.pocket.workspaces.resolveWorkspacePath(info.cwd);
      const git = async (gitArgs: string[]): Promise<string> => {
        try {
          const { stdout } = await execFileAsync('git', ['-C', cwd, ...gitArgs], {
            timeout: 20_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          return stdout;
        } catch (err) {
          throw new Error(`git ${gitArgs[0]} failed: ${(err as Error).message.split('\n')[0]}`);
        }
      };
      const status = await git(['status', '--porcelain=v1', '--branch']);
      const diff = await git(['diff', 'HEAD', '--no-color', '--no-ext-diff']);
      const max = (args.maxChars as number | undefined) ?? 40_000;
      return { cwd, status, diff: truncate(diff, max) };
    },
  },

  // ---- attachments (PA-137) -------------------------------------------------
  {
    name: 'upload_attachment',
    scope: 'sessions',
    alsoScopes: ['planner'],
    title: 'Upload a file to attach to a prompt',
    description:
      `Stage a file (at most ${MAX_MCP_ATTACHMENT_BYTES / (1024 * 1024)} MB, base64) to attach to a prompt, and get back an ` +
      'attachmentId. Pass it in `attachments` on start_session, send_prompt, run_coding_task, send_pocket_message or ' +
      'run_pocket_task. Nothing is written into a project until that prompt is sent: then the file lands in the ' +
      "session's .pocketagent/attachments/ (or the Pocket Agent's artifacts/uploads/) and the agent is told its path. " +
      'An id is single-use, expires after an hour unsent, and only this client can use it.',
    input: {
      name: z.string().min(1).max(MAX_ATTACHMENT_NAME_CHARS).describe('The file name, e.g. "report.pdf". Sanitised to a basename.'),
      mediaType: z.string().max(255).optional().describe('e.g. "application/pdf". Informational only.'),
      dataBase64: z.string().min(1).max(MAX_MCP_ATTACHMENT_BASE64).describe('The file\'s bytes, base64-encoded.'),
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      const encoded = String(args.dataBase64).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
        throw new Error('dataBase64 is not valid base64.');
      }
      const staged = await deps.work.uploadAttachment(ctx.principal, {
        name: String(args.name),
        ...(typeof args.mediaType === 'string' ? { mediaType: args.mediaType } : {}),
        data: Buffer.from(encoded, 'base64'),
      });
      return { ...staged, expiresInSeconds: 3600 };
    },
  },

  // ---- sessions ------------------------------------------------------------
  {
    name: 'start_session',
    scope: 'sessions',
    title: 'Start a coding-agent session',
    description:
      'Start a coding agent (structured transport) in a project folder with a first prompt. Returns immediately with a ' +
      'sessionId; use wait_for_turn for the answer, or run_coding_task to do both. Tool calls that need approval wait ' +
      'for a human in PocketAgent. If another session is mid-turn in the same working tree, the prompt queues behind it.',
    input: {
      cwd: z.string().min(1).max(4096).describe('Directory inside an added project folder.'),
      agent: z.string().min(1).max(200).describe('An agent id from list_agents, e.g. "claude".'),
      prompt: z.string().min(1).max(100_000),
      title: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      effort: EffortLevel.nullable().optional(),
      worktree: z
        .enum(['none', 'new-branch'])
        .optional()
        .describe('"new-branch" works in a fresh git worktree on a newly minted branch. Default "none".'),
      branchBase: z.string().max(60).optional().describe('Readable base for the minted branch name.'),
      resumeConversationId: z.string().max(200).optional().describe('Continue an existing conversation (claude).'),
      attachments: attachmentsInput,
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      const started = await deps.work.startSession(ctx.principal, ctx.depth, startInput(args));
      return started;
    },
  },
  {
    name: 'send_prompt',
    scope: 'sessions',
    title: 'Send a prompt to a session',
    description:
      'Send a follow-up prompt to a structured session. A finished session is resumed into a new one. ' +
      'If another session is mid-turn in the same tree, the prompt queues.',
    input: { sessionId, prompt: z.string().min(1).max(100_000), attachments: attachmentsInput },
    readOnly: false,
    async handler(deps, ctx, args) {
      return deps.work.sendPrompt(ctx.principal, ctx.depth, String(args.sessionId), String(args.prompt), attachmentIds(args));
    },
  },
  {
    name: 'wait_for_turn',
    scope: 'sessions',
    title: 'Wait for a session’s turn',
    description:
      'Wait for a session’s current turn to finish and return its final answer. States: complete, awaiting_approval ' +
      '(a human must answer in PocketAgent — you cannot), queued, still_running (call again), ended.',
    input: { sessionId, timeoutSeconds: waitSeconds },
    readOnly: true,
    async handler(deps, ctx, args) {
      return waitWithProgress(ctx, (o) =>
        deps.work.waitForTurn(String(args.sessionId), (args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS, o),
      );
    },
  },
  {
    name: 'run_coding_task',
    scope: 'sessions',
    title: 'Run a coding task and get the answer',
    description:
      'start_session + wait_for_turn in one call: give a coding agent a task and get its final answer. If the task ' +
      'outlasts the wait, returns the sessionId with state still_running — keep calling wait_for_turn.',
    input: {
      cwd: z.string().min(1).max(4096),
      agent: z.string().min(1).max(200),
      prompt: z.string().min(1).max(100_000),
      title: z.string().max(200).optional(),
      model: z.string().max(200).optional(),
      effort: EffortLevel.nullable().optional(),
      worktree: z.enum(['none', 'new-branch']).optional(),
      branchBase: z.string().max(60).optional(),
      attachments: attachmentsInput,
      timeoutSeconds: waitSeconds,
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      const started = await deps.work.startSession(ctx.principal, ctx.depth, startInput(args));
      const result = await waitWithProgress(ctx, (o) =>
        deps.work.waitForTurn(started.sessionId, (args.timeoutSeconds as number | undefined) ?? MAX_WAIT_SECONDS, o),
      );
      return { ...result, cwd: started.cwd };
    },
  },
  {
    name: 'interrupt_session',
    scope: 'sessions',
    title: 'Interrupt a session’s turn',
    description: 'Stop the current turn of a session this MCP client started. The session stays alive.',
    input: { sessionId },
    readOnly: false,
    async handler(deps, ctx, args) {
      return { interrupted: await deps.work.interruptSession(ctx.principal, String(args.sessionId)) };
    },
  },
  {
    name: 'stop_session',
    scope: 'sessions',
    title: 'Stop a session',
    description: 'End a session this MCP client started. Its transcript is kept.',
    input: { sessionId },
    readOnly: false,
    destructive: true,
    async handler(deps, ctx, args) {
      deps.work.stopSession(ctx.principal, String(args.sessionId));
      return { stopped: true };
    },
  },

  // ---- planner -------------------------------------------------------------
  {
    name: 'create_pocket_chat',
    scope: 'planner',
    title: 'Create a Pocket Agent chat',
    description: 'Create a chat with a Pocket Agent. Its mutating tools still need a human’s approval in PocketAgent.',
    input: {
      workspaceId: z.string().min(1).max(200).describe('A Pocket Agent id from list_pocket_agents.'),
      title: z.string().max(200).optional(),
      modelId: z.string().max(200).optional(),
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      const id = deps.work.createPocketChat(ctx.principal, ctx.depth, {
        workspaceId: String(args.workspaceId),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
        ...(typeof args.modelId === 'string' ? { modelId: args.modelId } : {}),
      });
      return { chatId: id };
    },
  },
  {
    name: 'send_pocket_message',
    scope: 'planner',
    title: 'Message a Pocket Agent',
    description: 'Send a message to a Pocket Agent chat and wait (up to timeoutSeconds) for its reply.',
    input: { chatId, message: z.string().min(1).max(100_000), attachments: attachmentsInput, timeoutSeconds: waitSeconds },
    readOnly: false,
    async handler(deps, ctx, args) {
      const id = String(args.chatId);
      await deps.work.sendPocketMessage(ctx.principal, id, String(args.message), attachmentIds(args));
      return waitWithProgress(ctx, (o) =>
        deps.work.waitForPocketTurn(id, (args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS, o),
      );
    },
  },
  {
    name: 'run_pocket_task',
    scope: 'planner',
    title: 'Run a Pocket Agent task',
    description: 'create_pocket_chat + send_pocket_message in one call: give a Pocket Agent a task and get its reply.',
    input: {
      workspaceId: z.string().min(1).max(200),
      message: z.string().min(1).max(100_000),
      title: z.string().max(200).optional(),
      attachments: attachmentsInput,
      timeoutSeconds: waitSeconds,
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      const id = deps.work.createPocketChat(ctx.principal, ctx.depth, {
        workspaceId: String(args.workspaceId),
        ...(typeof args.title === 'string' ? { title: args.title } : {}),
      });
      await deps.work.sendPocketMessage(ctx.principal, id, String(args.message), attachmentIds(args));
      return waitWithProgress(ctx, (o) =>
        deps.work.waitForPocketTurn(id, (args.timeoutSeconds as number | undefined) ?? MAX_WAIT_SECONDS, o),
      );
    },
  },
  {
    name: 'wait_for_pocket_turn',
    scope: 'planner',
    title: 'Wait for a Pocket Agent reply',
    description: 'Wait for a Pocket Agent chat’s turn to finish. Same states as wait_for_turn.',
    input: { chatId, timeoutSeconds: waitSeconds },
    readOnly: true,
    async handler(deps, ctx, args) {
      return waitWithProgress(ctx, (o) =>
        deps.work.waitForPocketTurn(String(args.chatId), (args.timeoutSeconds as number | undefined) ?? DEFAULT_WAIT_SECONDS, o),
      );
    },
  },
  {
    name: 'interrupt_pocket_chat',
    scope: 'planner',
    title: 'Interrupt a Pocket Agent turn',
    description: 'Stop the current turn of a Pocket Agent chat this MCP client created.',
    input: { chatId },
    readOnly: false,
    async handler(deps, ctx, args) {
      return { interrupted: await deps.work.interruptPocketChat(ctx.principal, String(args.chatId)) };
    },
  },

  // ---- admin ---------------------------------------------------------------
  {
    name: 'add_workspace',
    scope: 'admin',
    title: 'Add a project folder',
    description: 'Add a project folder. From then on, agents may run inside it. Logged.',
    input: { path: z.string().min(1).max(4096), create: z.boolean().optional().describe('Create the folder if missing.') },
    readOnly: false,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/workspaces/add', {
        path: String(args.path),
        ...(args.create === true ? { create: true } : {}),
      });
    },
  },
  {
    name: 'remove_workspace',
    scope: 'admin',
    title: 'Remove a project folder',
    description: 'Forget a project folder. Nothing on disk is deleted; sessions already running keep running.',
    input: { path: z.string().min(1).max(4096) },
    readOnly: false,
    destructive: true,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/workspaces/remove', { path: String(args.path) });
    },
  },
  {
    name: 'create_worktree',
    scope: 'admin',
    title: 'Create a git worktree',
    description: 'Create a git worktree of a project folder, on a new branch or the current one.',
    input: {
      cwd: z.string().min(1).max(4096),
      branchMode: z.enum(['new', 'current']),
      branchName: z.string().max(200).optional(),
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/projects/worktree', {
        cwd: String(args.cwd),
        branchMode: args.branchMode,
        ...(typeof args.branchName === 'string' ? { branchName: args.branchName } : {}),
      });
    },
  },
  {
    name: 'delete_worktree',
    scope: 'admin',
    title: 'Delete a git worktree',
    description: 'Delete a worktree. Refused while a session is running in it, or if it has uncommitted or unmerged work.',
    input: { cwd: z.string().min(1).max(4096) },
    readOnly: false,
    destructive: true,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/projects/worktree/delete', { cwd: String(args.cwd) });
    },
  },
  {
    name: 'hide_chat',
    scope: 'admin',
    title: 'Remove a chat from the list',
    description: 'Remove a finished chat from the home screen. The transcript on disk is never deleted.',
    input: {
      sessionId: z.string().max(200).optional(),
      conversationId: z.string().max(200).optional(),
    },
    readOnly: false,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/chats/remove', {
        ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
        ...(typeof args.conversationId === 'string' ? { conversationId: args.conversationId } : {}),
      });
    },
  },
  {
    name: 'clear_finished',
    scope: 'admin',
    title: 'Clear finished chats in a folder',
    description: 'Remove every finished chat in one project folder from the list. Transcripts are kept on disk.',
    input: { cwd: z.string().min(1).max(4096) },
    readOnly: false,
    async handler(deps, ctx, args) {
      return deps.api.call(ctx.principal, 'POST', '/api/projects/clear-finished', { cwd: String(args.cwd) });
    },
  },
];

function startInput(args: Record<string, unknown>): StartSessionInput {
  return {
    cwd: String(args.cwd),
    agent: String(args.agent),
    prompt: String(args.prompt),
    ...(typeof args.title === 'string' ? { title: args.title } : {}),
    ...(typeof args.model === 'string' ? { model: args.model } : {}),
    ...(args.effort !== undefined ? { effort: args.effort as z.infer<typeof EffortLevel> | null } : {}),
    ...(args.worktree === 'new-branch' || args.worktree === 'none'
      ? { worktree: args.worktree as 'new-branch' | 'none' }
      : {}),
    ...(typeof args.branchBase === 'string' ? { branchBase: args.branchBase } : {}),
    ...(typeof args.resumeConversationId === 'string' ? { resumeConversationId: args.resumeConversationId } : {}),
    ...(attachmentIds(args).length > 0 ? { attachments: attachmentIds(args) } : {}),
  };
}
