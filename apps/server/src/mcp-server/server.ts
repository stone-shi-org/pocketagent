import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  isInitializeRequest,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  MCP_DEPTH_HEADER,
  MCP_DEPTH_META_KEY,
  MCP_POCKET_CHAT_RESOURCE_PREFIX,
  MCP_SESSION_RESOURCE_PREFIX,
  type McpScope,
} from '@pocketagent/protocol';
import type { McpClientIdentity } from '../auth/mcp-tokens.js';
import { summarizeEvents, truncateTail } from '../planner/tools.js';
import { MCP_TOOLS, type McpToolDefinition, type McpToolDeps } from './tools.js';

/**
 * PA-118: the Streamable HTTP endpoint — MCP sessions, and what each one may see.
 *
 * **Stateful**, not the stateless mode the plan first proposed, because the
 * ticket moved resource subscriptions into v1 and a subscription needs a
 * session to notify on (the standalone `GET` stream). What makes that safe:
 *
 * - **A session is bound to the principal that opened it.** Every request
 *   still passes `app.ts`'s gate with its own bearer token; a request whose
 *   principal differs from the session's is answered as if the session did not
 *   exist, so a session id is never a credential on its own.
 * - **A revoked token ends its sessions.** Every tool call re-reads the
 *   principal (`resolve`), so a revocation or a scope change applies to the
 *   very next call, and a notification is never sent on behalf of a token that
 *   no longer exists.
 * - **Sessions are bounded.** At most `MAX_SESSIONS_PER_CLIENT` per principal
 *   (the oldest is closed), and an idle one is closed after `IDLE_TTL_MS`. A
 *   session holds no work: closing it never touches a coding-agent session or
 *   a Pocket Agent chat, which is also why a restart needs no drain here.
 *
 * Nothing about a tool's *arguments or results* is logged — prompts and
 * transcripts sit with terminal I/O, which is never logged or persisted by
 * this server. Each call logs its name, principal, duration and outcome.
 */

const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS_PER_CLIENT = 8;
const SWEEP_INTERVAL_MS = 60_000;

interface McpSessionEntry {
  id: string;
  principalId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  createdAt: number;
  subscriptions: Map<string, () => void>;
}

export interface McpServerServiceOptions {
  deps: McpToolDeps;
  version: string;
  /** Re-reads a principal by id; `null` once its token is revoked. */
  resolve: (principalId: string) => McpClientIdentity | null;
  logger: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
  };
  now?: () => number;
}

export class McpServerService {
  private readonly sessions = new Map<string, McpSessionEntry>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly unsubscribeTurns: () => void;

  constructor(private readonly opts: McpServerServiceOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    // One listener for every MCP session's session-resource subscriptions.
    this.unsubscribeTurns = opts.deps.pocket.sessions.onSessionTurnComplete((sessionId) => {
      this.notifyResource(`${MCP_SESSION_RESOURCE_PREFIX}${sessionId}`);
    });
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** How many MCP sessions are open (for tests and diagnostics). */
  openSessions(): number {
    return this.sessions.size;
  }

  /**
   * Serve one `/mcp` request. The gate has already authenticated it and set
   * `request.mcpPrincipal`; anything else reaching here is refused.
   */
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = request.mcpPrincipal;
    if (!principal) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'An MCP client token is required.' } });
      return;
    }
    const header = request.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;

    if (sessionId !== undefined) {
      const entry = this.sessions.get(sessionId);
      // Another principal's session id is answered exactly like an unknown one.
      if (!entry || entry.principalId !== principal.id) {
        await reply.code(404).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Re-initialize.' },
          id: null,
        });
        return;
      }
      entry.lastSeen = this.now();
      reply.hijack();
      await entry.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }

    if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
      await reply.code(400).send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No MCP session: send an initialize request first.' },
        id: null,
      });
      return;
    }

    this.enforceSessionCap(principal.id);
    const depth = depthOf(request.headers[MCP_DEPTH_HEADER]);
    const server = this.buildServer(principal.id, depth);
    let entry: McpSessionEntry | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        entry = {
          id,
          principalId: principal.id,
          transport,
          server,
          lastSeen: this.now(),
          createdAt: this.now(),
          subscriptions: new Map(),
        };
        this.sessions.set(id, entry);
        this.opts.logger.info({ mcpClient: principal.label, mcpSessionId: id }, 'mcp session opened');
      },
    });
    transport.onclose = () => {
      if (entry) this.forget(entry.id);
    };
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  }

  /** Close every MCP session — server shutdown (`preClose`). */
  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    this.unsubscribeTurns();
    const entries = [...this.sessions.values()];
    await Promise.allSettled(entries.map((entry) => this.close(entry)));
  }

  private enforceSessionCap(principalId: string): void {
    const mine = [...this.sessions.values()]
      .filter((e) => e.principalId === principalId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= MAX_SESSIONS_PER_CLIENT) {
      const oldest = mine.shift();
      if (oldest) void this.close(oldest);
    }
  }

  private sweep(): void {
    const cutoff = this.now() - IDLE_TTL_MS;
    for (const entry of [...this.sessions.values()]) {
      if (entry.lastSeen < cutoff || this.opts.resolve(entry.principalId) === null) void this.close(entry);
    }
  }

  private forget(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    for (const dispose of entry.subscriptions.values()) dispose();
    entry.subscriptions.clear();
    this.sessions.delete(id);
  }

  private async close(entry: McpSessionEntry): Promise<void> {
    this.forget(entry.id);
    try {
      await entry.transport.close();
    } catch {
      /* already closed */
    }
  }

  private notifyResource(uri: string): void {
    for (const entry of this.sessions.values()) {
      if (!entry.subscriptions.has(uri)) continue;
      if (this.opts.resolve(entry.principalId) === null) {
        void this.close(entry);
        continue;
      }
      entry.server.server.sendResourceUpdated({ uri }).catch(() => {
        /* the client's notification stream is gone; it re-reads on reconnect */
      });
    }
  }

  // ---- One McpServer per MCP session ---------------------------------------

  private buildServer(principalId: string, depth: number): McpServer {
    const initial = this.opts.resolve(principalId);
    const scopes = new Set<McpScope>(initial?.scopes ?? []);
    const server = new McpServer(
      { name: 'pocketagent', version: this.opts.version },
      {
        capabilities: { resources: { subscribe: true, listChanged: false }, prompts: {} },
        instructions:
          'PocketAgent drives coding agents (Claude Code, Codex, …) and Pocket Agents on this machine. ' +
          'Start work with run_coding_task / start_session or run_pocket_task, then wait_for_turn. ' +
          'Tool calls that need approval wait for a human in PocketAgent; you can see them but cannot answer them.',
      },
    );

    for (const tool of MCP_TOOLS) {
      if (!scopes.has(tool.scope)) continue;
      this.registerTool(server, tool, principalId, depth);
    }
    if (scopes.has('read')) {
      this.registerResources(server, principalId);
      this.registerSkillPrompts(server);
    }
    return server;
  }

  private registerTool(server: McpServer, tool: McpToolDefinition, principalId: string, depth: number): void {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive === true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>, extra) => {
        const started = Date.now();
        // Re-read on every call: a revoked token or a narrowed scope must not
        // keep working for the life of a long-lived MCP session.
        const principal = this.opts.resolve(principalId);
        if (!principal || !principal.scopes.includes(tool.scope)) {
          return errorResult(
            principal
              ? `This token no longer has the "${tool.scope}" scope.`
              : 'This MCP client token has been revoked.',
          );
        }
        const progressToken = extra._meta?.progressToken;
        try {
          const result = await tool.handler(this.opts.deps, {
            principal,
            depth: Math.max(
              depth,
              depthOf(extra.requestInfo?.headers?.[MCP_DEPTH_HEADER]),
              depthOf(extra._meta?.[MCP_DEPTH_META_KEY]),
            ),
            signal: extra.signal,
            progress: (message, elapsedMs) => {
              if (progressToken === undefined) return;
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { progressToken, progress: Math.round(elapsedMs / 1000), message },
                })
                .catch(() => undefined);
            },
          }, args);
          this.opts.logger.info(
            { mcpClient: principal.label, tool: tool.name, durationMs: Date.now() - started, ok: true },
            'mcp tool call',
          );
          return okResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.logger.info(
            { mcpClient: principal.label, tool: tool.name, durationMs: Date.now() - started, ok: false },
            'mcp tool call',
          );
          return errorResult(message);
        }
      },
    );
  }

  /**
   * Transcripts as resources, subscribable: a client that subscribes is told
   * at each `turn_complete` instead of polling `wait_for_turn`.
   */
  private registerResources(server: McpServer, principalId: string): void {
    const { pocket } = this.opts.deps;
    const work = this.opts.deps.work;
    const readable = (): boolean => this.opts.resolve(principalId)?.scopes.includes('read') === true;

    server.registerResource(
      'session-transcript',
      new ResourceTemplate(`${MCP_SESSION_RESOURCE_PREFIX}{sessionId}`, {
        list: async () => ({
          resources: pocket.sessions.list(50).map((s) => ({
            uri: `${MCP_SESSION_RESOURCE_PREFIX}${s.id}`,
            name: s.title || s.id,
            description: `${s.agentDisplayName} · ${s.status} · ${s.cwd}`,
            mimeType: 'text/plain',
          })),
        }),
      }),
      { title: 'Session transcript', description: 'A coding-agent session’s readable transcript.', mimeType: 'text/plain' },
      async (uri, variables) => {
        if (!readable()) throw new Error('This MCP client token has been revoked or lacks the "read" scope.');
        const id = String(variables.sessionId);
        if (!pocket.sessions.find(id)) throw new Error(`No session ${id}.`);
        const { events } = await work.sessionEvents(id);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: truncateTail(summarizeEvents(events), 50_000) }] };
      },
    );

    server.registerResource(
      'pocket-chat-transcript',
      new ResourceTemplate(`${MCP_POCKET_CHAT_RESOURCE_PREFIX}{chatId}`, {
        list: async () => ({
          resources: pocket.plannerChats.list().slice(0, 50).map((c) => ({
            uri: `${MCP_POCKET_CHAT_RESOURCE_PREFIX}${c.id}`,
            name: c.title ?? c.id,
            mimeType: 'text/plain',
          })),
        }),
      }),
      { title: 'Pocket Agent chat', description: 'A Pocket Agent chat’s readable transcript.', mimeType: 'text/plain' },
      async (uri, variables) => {
        if (!readable()) throw new Error('This MCP client token has been revoked or lacks the "read" scope.');
        const id = String(variables.chatId);
        if (!pocket.plannerChats.get(id)) throw new Error(`No Pocket Agent chat ${id}.`);
        const events = await pocket.plannerChats.history(id);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: truncateTail(summarizeEvents(events), 50_000) }] };
      },
    );

    server.server.setRequestHandler(SubscribeRequestSchema, async (req, extra) => {
      if (!readable()) throw new Error('This MCP client token has been revoked or lacks the "read" scope.');
      const uri = req.params.uri;
      const entry = extra.sessionId ? this.sessions.get(extra.sessionId) : undefined;
      if (!entry || entry.subscriptions.has(uri)) return {};
      if (uri.startsWith(MCP_SESSION_RESOURCE_PREFIX)) {
        const id = uri.slice(MCP_SESSION_RESOURCE_PREFIX.length);
        if (!pocket.sessions.find(id)) throw new Error(`No session ${id}.`);
        // Session turn completions arrive through the one shared listener
        // installed in the constructor; this entry only marks interest.
        entry.subscriptions.set(uri, () => undefined);
        return {};
      }
      if (uri.startsWith(MCP_POCKET_CHAT_RESOURCE_PREFIX)) {
        const id = uri.slice(MCP_POCKET_CHAT_RESOURCE_PREFIX.length);
        if (!pocket.plannerChats.get(id)) throw new Error(`No Pocket Agent chat ${id}.`);
        const dispose = pocket.plannerChats.observe(id, (event) => {
          if (event.kind === 'turn_complete' || event.kind === 'permission_request') this.notifyResource(uri);
        });
        entry.subscriptions.set(uri, dispose);
        return {};
      }
      throw new Error(`Cannot subscribe to ${uri}.`);
    });

    server.server.setRequestHandler(UnsubscribeRequestSchema, async (req, extra) => {
      const entry = extra.sessionId ? this.sessions.get(extra.sessionId) : undefined;
      const dispose = entry?.subscriptions.get(req.params.uri);
      if (entry && dispose) {
        dispose();
        entry.subscriptions.delete(req.params.uri);
      }
      return {};
    });
  }

  /**
   * The global Pocket Agent skills, as MCP prompts. Read-only: a prompt is text
   * the *client* chooses to send its own model; nothing runs here.
   */
  private registerSkillPrompts(server: McpServer): void {
    const { skills } = this.opts.deps.pocket;
    const used = new Set<string>();
    for (const skill of skills.listGlobalSkills()) {
      if (skills.disabledGlobally(skill.id)) continue;
      let name = `skill_${skill.slug.replace(/[^a-zA-Z0-9_-]+/g, '_')}`.slice(0, 64);
      while (used.has(name)) name = `${name}_`;
      used.add(name);
      server.registerPrompt(
        name,
        {
          title: skill.name,
          description: skill.description || `The "${skill.name}" Pocket Agent skill.`,
          argsSchema: { task: z.string().optional().describe('What to apply the skill to.') },
        },
        async ({ task }) => {
          const body = await skills.loadSkillBody(skill.id);
          const text = task ? `${body}\n\n---\n\nTask: ${task}` : body;
          return { messages: [{ role: 'user', content: { type: 'text', text } }] };
        },
      );
    }
  }
}

function okResult(result: unknown) {
  const structured = result !== null && typeof result === 'object' && !Array.isArray(result);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    ...(structured ? { structuredContent: result as Record<string, unknown> } : {}),
  };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function depthOf(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n =
    typeof value === 'number' ? Math.floor(value) : typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 0;
}
