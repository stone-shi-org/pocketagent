import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createMcpHandler,
  fromJsonSchema,
  isInitializeRequest,
  isLegacyRequest,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ResourceTemplate,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { z } from 'zod';
import {
  MCP_DEPTH_HEADER,
  MCP_DEPTH_META_KEY,
  MCP_MODERN_PROTOCOL_VERSIONS,
  MCP_POCKET_CHAT_RESOURCE_PREFIX,
  MCP_SESSION_RESOURCE_PREFIX,
  type McpProtocolEra,
  type McpScope,
} from '@pocketagent/protocol';
import type { McpClientIdentity } from '../auth/mcp-tokens.js';
import { summarizeEvents, truncateTail } from '../planner/tools.js';
import { MCP_TOOLS, type McpToolDefinition, type McpToolDeps } from './tools.js';

/**
 * PA-118: the Streamable HTTP endpoint, serving **both protocol eras** from one
 * definition of the tools, resources and prompts.
 *
 * MCP revision 2026-07-28 ("modern") made the protocol stateless: no
 * `initialize` handshake and no `Mcp-Session-Id` — every request carries its
 * protocol version and client capabilities in `_meta`, `server/discover`
 * advertises what the server speaks, an unsupported version is a `-32022`
 * error naming the supported ones, and change notifications moved from the
 * session's `GET` stream to a `subscriptions/listen` POST stream. Every
 * earlier revision ("legacy": 2025-11-25 back to 2024-10-07) negotiates once,
 * in `initialize`, and holds a session. Claude Code, Codex and most clients in
 * the field are still legacy, so dropping either era would cut someone off.
 *
 * How a request is routed is decided by the SDK's own classifier
 * (`isLegacyRequest`, the exact code `createMcpHandler` runs), never by a
 * second copy of the rule here:
 *
 * - **Modern** requests go to a `createMcpHandler(..., { legacy: 'reject' })`
 *   — one per principal, which is what lets a revocation close that
 *   principal's `subscriptions/listen` streams without touching anyone
 *   else's. The handler answers `server/discover`, the `-32022` negotiation,
 *   the `Mcp-Method`/`Mcp-Name` header checks and `ttlMs`/`cacheScope`.
 * - **Legacy** requests keep the stateful sessions this endpoint shipped
 *   with, on the v2 SDK's sessionful `WebStandardStreamableHTTPServerTransport`
 *   — *not* the SDK's stateless legacy fallback, which answers the session
 *   `GET` with 405 and so would silently break `resources/subscribe` for
 *   every legacy client. `initialize` negotiates the version: a supported
 *   requested version is echoed, anything else is counter-offered the newest
 *   legacy one.
 *
 * Both eras build their server from the same `buildServer`, so a tool cannot
 * exist in one era and not the other, and the same principal re-check, scope
 * filter and audit line apply to both.
 *
 * What makes a stateful legacy session safe is unchanged: it is bound to the
 * principal that opened it (another principal's session id is answered as
 * unknown), every tool call re-reads the principal so a revocation or a
 * narrowed scope applies on the next call, sessions are capped per principal
 * and expire idle, and none of them holds work — closing one never touches a
 * coding-agent session or a Pocket Agent chat.
 *
 * Nothing about a tool's *arguments or results* is logged — prompts and
 * transcripts sit with terminal I/O, which is never logged or persisted by
 * this server. Each call logs its name, principal, era, duration and outcome.
 */

const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS_PER_CLIENT = 8;
/** Open `subscriptions/listen` streams one principal may hold (modern era). */
const MAX_LISTEN_STREAMS_PER_CLIENT = 16;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Every revision this endpoint serves, newest first: the modern ones, then
 * every legacy revision the SDK can negotiate in `initialize`. Handed to each
 * `McpServer` so the legacy handshake and the modern era agree on one list.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MCP_MODERN_PROTOCOL_VERSIONS,
  ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => !MCP_MODERN_PROTOCOL_VERSIONS.includes(v)),
];

interface LegacySessionEntry {
  id: string;
  principalId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  lastSeen: number;
  /** Resource URIs this session subscribed to with `resources/subscribe`. */
  subscriptions: Set<string>;
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
  private readonly legacySessions = new Map<string, LegacySessionEntry>();
  private readonly modernHandlers = new Map<string, McpHttpHandler>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly opts: McpServerServiceOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    const { sessions, plannerChats } = opts.deps.pocket;
    this.unsubscribers.push(
      sessions.onSessionTurnComplete((sessionId) => {
        this.notifyResource(`${MCP_SESSION_RESOURCE_PREFIX}${sessionId}`);
      }),
      plannerChats.observeAll((chatId, event) => {
        if (event.kind === 'turn_complete' || event.kind === 'permission_request') {
          this.notifyResource(`${MCP_POCKET_CHAT_RESOURCE_PREFIX}${chatId}`);
        }
      }),
    );
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Open legacy sessions (for tests and diagnostics). */
  openSessions(): number {
    return this.legacySessions.size;
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

    const abort = new AbortController();
    const webRequest = toWebRequest(request, abort.signal);
    const legacy = await isLegacyRequest(webRequest, request.body);

    if (!legacy) {
      const response = await this.modernHandlerFor(principal.id).fetch(webRequest, {
        parsedBody: request.body,
      });
      await sendWebResponse(reply, response, abort);
      return;
    }

    const header = request.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    if (sessionId !== undefined) {
      const entry = this.legacySessions.get(sessionId);
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
      const response = await entry.transport.handleRequest(webRequest, { parsedBody: request.body });
      await sendWebResponse(reply, response, abort);
      return;
    }

    if (request.method !== 'POST' || !isInitializeRequest(request.body)) {
      await reply.code(400).send({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message:
            `No MCP session. Send initialize (protocol ${legacyVersions().join(', ')}), ` +
            `or a per-request _meta envelope (protocol ${MCP_MODERN_PROTOCOL_VERSIONS.join(', ')}).`,
        },
        id: null,
      });
      return;
    }

    this.enforceSessionCap(principal.id);
    const depth = depthOf(request.headers[MCP_DEPTH_HEADER]);
    const server = this.buildServer(principal.id, depth, 'legacy');
    let entry: LegacySessionEntry | null = null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        entry = {
          id,
          principalId: principal.id,
          transport,
          server,
          lastSeen: this.now(),
          subscriptions: new Set(),
        };
        this.legacySessions.set(id, entry);
        this.opts.logger.info(
          { mcpClient: principal.label, mcpSessionId: id, era: 'legacy' },
          'mcp session opened',
        );
      },
    });
    transport.onclose = () => {
      if (entry) this.legacySessions.delete(entry.id);
    };
    await server.connect(transport);
    const response = await transport.handleRequest(webRequest, { parsedBody: request.body });
    await sendWebResponse(reply, response, abort);
  }

  /**
   * Cut a principal off now — its legacy sessions and its modern listen
   * streams — rather than at the next sweep. Called when a token is revoked.
   */
  async revoke(principalId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const entry of [...this.legacySessions.values()]) {
      if (entry.principalId === principalId) closing.push(this.closeLegacy(entry));
    }
    const handler = this.modernHandlers.get(principalId);
    if (handler) {
      this.modernHandlers.delete(principalId);
      closing.push(handler.close());
    }
    await Promise.allSettled(closing);
  }

  /** Close everything — server shutdown (`preClose`). */
  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    const closing: Promise<void>[] = [...this.legacySessions.values()].map((entry) => this.closeLegacy(entry));
    for (const handler of this.modernHandlers.values()) closing.push(handler.close());
    this.modernHandlers.clear();
    await Promise.allSettled(closing);
  }

  private modernHandlerFor(principalId: string): McpHttpHandler {
    let handler = this.modernHandlers.get(principalId);
    if (!handler) {
      // One factory call per modern request: the instance is stateless, and
      // the depth a request claims is read from that request itself.
      handler = createMcpHandler(
        (ctx) =>
          this.buildServer(principalId, depthOf(ctx.requestInfo?.headers.get(MCP_DEPTH_HEADER) ?? undefined), 'modern'),
        {
          legacy: 'reject',
          maxSubscriptions: MAX_LISTEN_STREAMS_PER_CLIENT,
          onerror: (err) => this.opts.logger.warn({ err: err.message }, 'mcp modern request rejected or failed'),
        },
      );
      this.modernHandlers.set(principalId, handler);
    }
    return handler;
  }

  private enforceSessionCap(principalId: string): void {
    const mine = [...this.legacySessions.values()]
      .filter((e) => e.principalId === principalId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= MAX_SESSIONS_PER_CLIENT) {
      const oldest = mine.shift();
      if (oldest) void this.closeLegacy(oldest);
    }
  }

  private sweep(): void {
    const cutoff = this.now() - IDLE_TTL_MS;
    for (const entry of [...this.legacySessions.values()]) {
      if (entry.lastSeen < cutoff || this.opts.resolve(entry.principalId) === null) void this.closeLegacy(entry);
    }
    // A modern handler holds nothing but listen streams, so it is closed only
    // when its principal is gone — never for idleness, which a long-lived
    // listen stream legitimately is.
    for (const principalId of [...this.modernHandlers.keys()]) {
      if (this.opts.resolve(principalId) === null) void this.revoke(principalId);
    }
  }

  private async closeLegacy(entry: LegacySessionEntry): Promise<void> {
    this.legacySessions.delete(entry.id);
    try {
      await entry.transport.close();
    } catch {
      /* already closed */
    }
  }

  /**
   * A transcript changed. Legacy sessions are told if they subscribed to that
   * URI; modern listen streams are filtered by the SDK, so every handler whose
   * principal may read is handed the change and delivers it only where a
   * stream opted in.
   */
  private notifyResource(uri: string): void {
    for (const entry of [...this.legacySessions.values()]) {
      if (!entry.subscriptions.has(uri)) continue;
      if (this.opts.resolve(entry.principalId) === null) {
        void this.closeLegacy(entry);
        continue;
      }
      entry.server.server.sendResourceUpdated({ uri }).catch(() => {
        /* the client's notification stream is gone; it re-reads on reconnect */
      });
    }
    for (const [principalId, handler] of this.modernHandlers) {
      if (this.opts.resolve(principalId)?.scopes.includes('read') !== true) continue;
      handler.notify.resourceUpdated(uri);
    }
  }

  // ---- One server definition, both eras -------------------------------------

  private buildServer(principalId: string, depth: number, era: McpProtocolEra): McpServer {
    const initial = this.opts.resolve(principalId);
    const scopes = new Set<McpScope>(initial?.scopes ?? []);
    const server = new McpServer(
      { name: 'pocketagent', version: this.opts.version },
      {
        capabilities: { resources: { subscribe: true, listChanged: false }, prompts: {}, tools: {} },
        supportedProtocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
        instructions:
          'PocketAgent drives coding agents (Claude Code, Codex, …) and Pocket Agents on this machine. ' +
          'Start work with run_coding_task / start_session or run_pocket_task, then wait_for_turn. ' +
          'Tool calls that need approval wait for a human in PocketAgent; you can see them but cannot answer them.',
      },
    );

    // `MCP_TOOLS` order is fixed, which is what 2026-07-28's "tools/list in a
    // deterministic order" asks for (client-side caching, prompt-cache hits).
    for (const tool of MCP_TOOLS) {
      if (!scopes.has(tool.scope)) continue;
      this.registerTool(server, tool, principalId, depth, era);
    }
    if (scopes.has('read')) {
      this.registerResources(server, principalId, era);
      this.registerSkillPrompts(server);
    }
    return server;
  }

  private registerTool(
    server: McpServer,
    tool: McpToolDefinition,
    principalId: string,
    depth: number,
    era: McpProtocolEra,
  ): void {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // The catalog is written once in zod and converted to JSON Schema
        // here, so both eras validate against the identical schema.
        inputSchema: fromJsonSchema<Record<string, unknown>>(jsonSchemaOf(tool.input)),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: tool.destructive === true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        const started = Date.now();
        // Re-read on every call: a revoked token or a narrowed scope must not
        // keep working for the life of a long-lived session.
        const principal = this.opts.resolve(principalId);
        if (!principal || !principal.scopes.includes(tool.scope)) {
          return errorResult(
            principal
              ? `This token no longer has the "${tool.scope}" scope.`
              : 'This MCP client token has been revoked.',
          );
        }
        const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
        const progressToken = meta?.progressToken as string | number | undefined;
        // The SDK lifts the 2026-07-28 envelope keys out of `_meta` into
        // `envelope`, still keyed by their full `io.modelcontextprotocol/...` names.
        const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
        const declared = envelope?.[PROTOCOL_VERSION_META_KEY] ?? meta?.[PROTOCOL_VERSION_META_KEY];
        const protocolVersion = era === 'modern' && typeof declared === 'string' ? declared : null;
        try {
          const result = await tool.handler(
            this.opts.deps,
            {
              principal,
              depth: Math.max(depth, depthOf(meta?.[MCP_DEPTH_META_KEY])),
              era,
              protocolVersion,
              signal: ctx.mcpReq.signal,
              progress: (message, elapsedMs) => {
                if (progressToken === undefined) return;
                void ctx.mcpReq
                  .notify({
                    method: 'notifications/progress',
                    params: { progressToken, progress: Math.round(elapsedMs / 1000), message },
                  })
                  .catch(() => undefined);
              },
            },
            args,
          );
          this.opts.logger.info(
            { mcpClient: principal.label, tool: tool.name, era, durationMs: Date.now() - started, ok: true },
            'mcp tool call',
          );
          return okResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.opts.logger.info(
            { mcpClient: principal.label, tool: tool.name, era, durationMs: Date.now() - started, ok: false },
            'mcp tool call',
          );
          return errorResult(message);
        }
      },
    );
  }

  /**
   * Transcripts as resources. Change notifications reach a legacy client
   * through `resources/subscribe` on its session, and a modern client through
   * a `subscriptions/listen` stream (`resourceSubscriptions`), which the SDK
   * serves — `notifyResource` feeds both.
   */
  private registerResources(server: McpServer, principalId: string, era: McpProtocolEra): void {
    const { pocket } = this.opts.deps;
    const work = this.opts.deps.work;
    const readable = (): boolean => this.opts.resolve(principalId)?.scopes.includes('read') === true;
    const refuse = (): never => {
      throw new Error('This MCP client token has been revoked or lacks the "read" scope.');
    };

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
        if (!readable()) refuse();
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
        if (!readable()) refuse();
        const id = String(variables.chatId);
        if (!pocket.plannerChats.get(id)) throw new Error(`No Pocket Agent chat ${id}.`);
        const events = await pocket.plannerChats.history(id);
        return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: truncateTail(summarizeEvents(events), 50_000) }] };
      },
    );

    // `resources/subscribe` exists only in the legacy era; 2026-07-28 replaced
    // it with `subscriptions/listen`, which the modern handler owns.
    if (era !== 'legacy') return;

    server.server.setRequestHandler('resources/subscribe', async (req, ctx) => {
      if (!readable()) refuse();
      const uri = req.params.uri;
      const entry = ctx.sessionId ? this.legacySessions.get(ctx.sessionId) : undefined;
      if (!entry) return {};
      if (uri.startsWith(MCP_SESSION_RESOURCE_PREFIX)) {
        const id = uri.slice(MCP_SESSION_RESOURCE_PREFIX.length);
        if (!pocket.sessions.find(id)) throw new Error(`No session ${id}.`);
      } else if (uri.startsWith(MCP_POCKET_CHAT_RESOURCE_PREFIX)) {
        const id = uri.slice(MCP_POCKET_CHAT_RESOURCE_PREFIX.length);
        if (!pocket.plannerChats.get(id)) throw new Error(`No Pocket Agent chat ${id}.`);
      } else {
        throw new Error(`Cannot subscribe to ${uri}.`);
      }
      entry.subscriptions.add(uri);
      return {};
    });

    server.server.setRequestHandler('resources/unsubscribe', async (req, ctx) => {
      const entry = ctx.sessionId ? this.legacySessions.get(ctx.sessionId) : undefined;
      entry?.subscriptions.delete(req.params.uri);
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
    const argsSchema = fromJsonSchema<{ task?: string }>(
      jsonSchemaOf({ task: z.string().optional().describe('What to apply the skill to.') }),
    );
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
          argsSchema,
        },
        async (args: { task?: string }) => {
          const body = await skills.loadSkillBody(skill.id);
          const text = args.task ? `${body}\n\n---\n\nTask: ${args.task}` : body;
          return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
        },
      );
    }
  }
}

function legacyVersions(): string[] {
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.filter((v) => !MCP_MODERN_PROTOCOL_VERSIONS.includes(v));
}

const jsonSchemaCache = new WeakMap<z.ZodRawShape, Record<string, unknown>>();

/** A tool's zod shape as JSON Schema — converted once per shape, not per request. */
function jsonSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  let schema = jsonSchemaCache.get(shape);
  if (!schema) {
    schema = toJsonSchemaCompat(z.object(shape)) as Record<string, unknown>;
    jsonSchemaCache.set(shape, schema);
  }
  return schema;
}

/**
 * The SDK's HTTP entries are web-standard (`Request` → `Response`). The body
 * Fastify already parsed is re-serialized for the `Request` and also passed as
 * `parsedBody`, which is what the SDK actually reads; nothing here verifies a
 * signature over the bytes, so re-serialization is harmless.
 */
function toWebRequest(request: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, String(value));
  }
  const hasBody = request.method === 'POST' && request.body !== undefined;
  return new Request(`http://pocketagent.invalid${request.url}`, {
    method: request.method,
    headers,
    signal,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

/**
 * Stream a web `Response` onto the raw socket, including the long-lived SSE
 * kinds (a legacy session's `GET`, a modern `subscriptions/listen`). The
 * client going away aborts the `Request`, which is how the SDK learns a
 * listen stream or an in-flight call is gone.
 */
async function sendWebResponse(reply: FastifyReply, response: Response, abort: AbortController): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  const headers: Record<string, string> = { 'x-content-type-options': 'nosniff' };
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  raw.writeHead(response.status, headers);
  if (!response.body) {
    raw.end();
    return;
  }
  const reader = response.body.getReader();
  const onClose = (): void => {
    abort.abort();
    void reader.cancel().catch(() => undefined);
  };
  raw.on('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw.write(value);
    }
  } catch {
    /* client went away or the stream was torn down */
  } finally {
    raw.off('close', onClose);
    raw.end();
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
