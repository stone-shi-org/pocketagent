import crypto from 'node:crypto';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import {
  createMcpHandler,
  fromJsonSchema,
  isInitializeRequest,
  isLegacyRequest,
  McpServer,
  SUPPORTED_PROTOCOL_VERSIONS,
  WebStandardStreamableHTTPServerTransport,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { MCP_DEPTH_HEADER, MCP_DEPTH_META_KEY, MCP_MODERN_PROTOCOL_VERSIONS, type McpProtocolEra } from '@pocketagent/protocol';
import type { HubMcpPrincipal } from './tokens.js';
import { FLEET_TOOLS, type FleetToolDefinition, type FleetToolDeps } from './tools.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** PA-134: set by the Hub gate for a valid `phm_` bearer on `/mcp` only. */
    hubMcpPrincipal?: HubMcpPrincipal;
  }
}

/**
 * PA-134: the Hub's `/mcp` — Streamable HTTP, **both protocol eras**, one
 * catalog (`FLEET_TOOLS`).
 *
 * A deliberate port of `apps/server/src/mcp-server/server.ts` rather than a
 * shared module, and narrower: no resources, no prompts, no subscriptions —
 * the Fleet catalog is tools only. Moving the backend's endpoint into
 * `packages/node-kit` would have dragged Fastify and both MCP SDKs into the
 * leaf package that holds the security primitives, for about a hundred lines
 * of routing. What is kept identical, because it is the part that is easy to
 * get wrong:
 *
 * - **Routing is the SDK's own classifier** (`isLegacyRequest`), never a second
 *   copy of the rule.
 * - **Modern** requests go to a `createMcpHandler(..., { legacy: 'reject' })`
 *   held per principal, so a revocation closes that principal's streams only.
 * - **Legacy** requests get sessionful transports bound to the principal that
 *   opened them; another principal's session id is answered as unknown.
 * - **Every tool call re-reads the principal**, so a revoked token stops on its
 *   next call even inside a long-lived session.
 * - **Nothing about arguments or results is logged** — a prompt dispatched to
 *   another machine is as private as terminal I/O. Each call logs its name,
 *   principal, target host, era, duration and outcome.
 */

const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS_PER_PRINCIPAL = 8;
const SWEEP_INTERVAL_MS = 60_000;

const SUPPORTED: readonly string[] = [
  ...MCP_MODERN_PROTOCOL_VERSIONS,
  ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => !MCP_MODERN_PROTOCOL_VERSIONS.includes(v)),
];

interface LegacySession {
  id: string;
  principalId: string;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

export interface HubMcpServerOptions {
  readonly deps: FleetToolDeps;
  readonly version: string;
  readonly resolve: (principalId: string) => HubMcpPrincipal | null;
  readonly log: FastifyBaseLogger;
}

export class HubMcpServer {
  private readonly legacy = new Map<string, LegacySession>();
  private readonly modern = new Map<string, McpHttpHandler>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly opts: HubMcpServerOptions) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  openSessions(): number {
    return this.legacy.size;
  }

  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = request.hubMcpPrincipal;
    if (!principal) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'A Hub MCP token is required.' } });
      return;
    }
    const abort = new AbortController();
    const webRequest = toWebRequest(request, abort.signal);

    if (!(await isLegacyRequest(webRequest, request.body))) {
      const response = await this.modernHandlerFor(principal.id).fetch(webRequest, { parsedBody: request.body });
      await sendWebResponse(reply, response, abort);
      return;
    }

    const header = request.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' ? header : undefined;
    if (sessionId !== undefined) {
      const entry = this.legacy.get(sessionId);
      if (!entry || entry.principalId !== principal.id) {
        await reply.code(404).send({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Re-initialize.' },
          id: null,
        });
        return;
      }
      entry.lastSeen = Date.now();
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
            `No MCP session. Send initialize, or a per-request _meta envelope (protocol ${MCP_MODERN_PROTOCOL_VERSIONS.join(', ')}).`,
        },
        id: null,
      });
      return;
    }

    this.enforceSessionCap(principal.id);
    const server = this.buildServer(principal.id, depthOf(request.headers[MCP_DEPTH_HEADER]), 'legacy');
    let entry: LegacySession | null = null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        entry = { id, principalId: principal.id, transport, lastSeen: Date.now() };
        this.legacy.set(id, entry);
      },
    });
    transport.onclose = () => {
      if (entry) this.legacy.delete(entry.id);
    };
    await server.connect(transport);
    const response = await transport.handleRequest(webRequest, { parsedBody: request.body });
    await sendWebResponse(reply, response, abort);
  }

  /** Cut a principal off now — called when its token is revoked. */
  async revoke(principalId: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const entry of [...this.legacy.values()]) {
      if (entry.principalId === principalId) closing.push(this.closeLegacy(entry));
    }
    const handler = this.modern.get(principalId);
    if (handler) {
      this.modern.delete(principalId);
      closing.push(handler.close());
    }
    await Promise.allSettled(closing);
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    const closing: Promise<void>[] = [...this.legacy.values()].map((entry) => this.closeLegacy(entry));
    for (const handler of this.modern.values()) closing.push(handler.close());
    this.modern.clear();
    await Promise.allSettled(closing);
  }

  private modernHandlerFor(principalId: string): McpHttpHandler {
    let handler = this.modern.get(principalId);
    if (!handler) {
      handler = createMcpHandler(
        (ctx) =>
          this.buildServer(principalId, depthOf(ctx.requestInfo?.headers.get(MCP_DEPTH_HEADER) ?? undefined), 'modern'),
        {
          legacy: 'reject',
          onerror: (err) => this.opts.log.warn({ err: err.message }, 'hub mcp modern request rejected or failed'),
        },
      );
      this.modern.set(principalId, handler);
    }
    return handler;
  }

  private enforceSessionCap(principalId: string): void {
    const mine = [...this.legacy.values()]
      .filter((e) => e.principalId === principalId)
      .sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= MAX_SESSIONS_PER_PRINCIPAL) {
      const oldest = mine.shift();
      if (oldest) void this.closeLegacy(oldest);
    }
  }

  private sweep(): void {
    const cutoff = Date.now() - IDLE_TTL_MS;
    for (const entry of [...this.legacy.values()]) {
      if (entry.lastSeen < cutoff || this.opts.resolve(entry.principalId) === null) void this.closeLegacy(entry);
    }
    for (const principalId of [...this.modern.keys()]) {
      if (this.opts.resolve(principalId) === null) void this.revoke(principalId);
    }
  }

  private async closeLegacy(entry: LegacySession): Promise<void> {
    this.legacy.delete(entry.id);
    try {
      await entry.transport.close();
    } catch {
      /* already closed */
    }
  }

  private buildServer(principalId: string, depth: number, era: McpProtocolEra): McpServer {
    const server = new McpServer(
      { name: 'pocketagent-hub', version: this.opts.version },
      {
        capabilities: { tools: {} },
        supportedProtocolVersions: [...SUPPORTED],
        instructions:
          'The PocketAgent Hub: every PocketAgent machine behind it. Find where a task belongs with list_hosts and ' +
          'get_host_capabilities, start it there with dispatch_coding_task or dispatch_pocket_task, then wait. ' +
          'Approvals on a host are answered by a human there; you can see them and never answer them.',
      },
    );
    for (const tool of FLEET_TOOLS) this.registerTool(server, tool, principalId, depth, era);
    return server;
  }

  private registerTool(
    server: McpServer,
    tool: FleetToolDefinition,
    principalId: string,
    depth: number,
    era: McpProtocolEra,
  ): void {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          // Dispatch reaches other machines: that is the open world.
          openWorldHint: !tool.readOnly,
        },
        ...(tool.meta ? { _meta: tool.meta } : {}),
      },
      async (args: Record<string, unknown>, ctx: ServerContext) => {
        const started = Date.now();
        const principal = this.opts.resolve(principalId);
        const target = tool.targetOf?.(args) ?? null;
        const audit = (ok: boolean): void => {
          this.opts.log.info(
            {
              hubMcpClient: principal?.label ?? principalId,
              tool: tool.name,
              targetHost: target,
              era,
              durationMs: Date.now() - started,
              ok,
            },
            'hub mcp tool call',
          );
        };
        if (!principal) {
          audit(false);
          return errorResult('This Hub MCP token has been revoked.');
        }
        const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
        try {
          const result = await tool.handler(
            this.opts.deps,
            {
              principal,
              depth: Math.max(depth, depthOf(meta?.[MCP_DEPTH_META_KEY])),
              signal: ctx.mcpReq.signal,
            },
            args,
          );
          audit(true);
          return okResult(result);
        } catch (err) {
          audit(false);
          return errorResult(err instanceof Error ? err.message : String(err));
        }
      },
    );
  }
}

/** Same as the backend's: re-serialise the parsed body; the SDK reads `parsedBody`. */
function toWebRequest(request: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, String(value));
  }
  const hasBody = request.method === 'POST' && request.body !== undefined;
  return new Request(`http://pocketagent-hub.invalid${request.url}`, {
    method: request.method,
    headers,
    signal,
    ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
  });
}

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
    /* client went away */
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
