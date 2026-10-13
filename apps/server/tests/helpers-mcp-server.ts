import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';

/**
 * PA-37: a real, minimal MCP server over plain `node:http`, for testing the
 * MCP client wrapper (`planner/mcp/client.ts`) and the registry
 * service/routes against genuine wire traffic on both transports — a mock
 * `fetch` would only prove this codebase's own assumptions about the wire
 * format, not that it actually interoperates with the official SDK's server
 * side.
 *
 * Registers one read-only tool (`echo`, `annotations.readOnlyHint: true`)
 * and one mutating one (`delete_thing`, `readOnlyHint: false`) — enough to
 * exercise the dynamic approval-gating special case
 * (`PlannerChatService.effectiveMcpToolIdentity`) end to end.
 */

export interface TestMcpServerOptions {
  /** If set, every request must carry this exact header (case-insensitive
      name) or the server answers 401 — used to prove a registry's configured
      bearer token / custom header actually reaches the wire. */
  requireHeader?: { name: string; value: string };
  /** If set, the server reports this in `initialize`'s optional
      `instructions` field — most real servers don't set one; this is what
      lets a test prove `McpRegistryService` captures and refreshes it (a
      registry's own `reportedInstructions`) when one actually does. */
  instructions?: string;
  /** If set, registers an extra tool (`fail_tool`) that returns isError: true. */
  includeFailTool?: boolean;
  /** PA-134: registers `dispatch_thing`, a mutating tool scoped by its `host`
      argument (`_meta['pocketagent/approvalScopeArg'] = 'host'`) — the shape
      of the Hub's `dispatch_*` tools. Its result is `replyText` when set. */
  includeScopedTool?: { replyText?: string };
}

export interface TestMcpServerHandle {
  url: string;
  /** Every request this server received, for asserting auth headers arrived. */
  requestsSeen: http.IncomingHttpHeaders[];
  close: () => Promise<void>;
}

function buildMcpServer(opts: TestMcpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'pocketagent-test-mcp-server', version: '1.0.0' },
    opts.instructions !== undefined ? { instructions: opts.instructions } : undefined,
  );
  server.registerTool(
    'echo',
    {
      description: 'Echoes back the provided text.',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }: { text: string }) => ({ content: [{ type: 'text' as const, text: `echo: ${text}` }] }),
  );
  server.registerTool(
    'delete_thing',
    {
      description: 'Pretends to delete something by id.',
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: false },
    },
    async ({ id }: { id: string }) => ({ content: [{ type: 'text' as const, text: `deleted ${id}` }] }),
  );
  if (opts.includeScopedTool) {
    const reply = opts.includeScopedTool.replyText;
    server.registerTool(
      'dispatch_thing',
      {
        description: 'Pretends to dispatch a task to a host.',
        inputSchema: { host: z.string(), task: z.string() },
        annotations: { readOnlyHint: false },
        _meta: { 'pocketagent/approvalScopeArg': 'host' },
      },
      async ({ host, task }: { host: string; task: string }) => ({
        content: [{ type: 'text' as const, text: reply ?? `dispatched "${task}" to ${host}` }],
      }),
    );
  }
  if (opts.includeFailTool) {
    server.registerTool(
      'fail_tool',
      {
        description: 'Simulates a tool failure returning isError.',
        inputSchema: { message: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ message }: { message: string }) => ({
        content: [{ type: 'text' as const, text: `Tool error: ${message}` }],
        isError: true,
      }),
    );
  }
  return server;
}

function checkAuth(req: http.IncomingMessage, res: http.ServerResponse, opts: TestMcpServerOptions): boolean {
  if (!opts.requireHeader) return true;
  const actual = req.headers[opts.requireHeader.name.toLowerCase()];
  if (actual === opts.requireHeader.value) return true;
  res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
  return false;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/**
 * Streamable HTTP, stateful mode (`sessionIdGenerator` set) — a fresh
 * `StreamableHTTPServerTransport`/`McpServer` per session, routed by the
 * `Mcp-Session-Id` header exactly the way a real multi-client Streamable HTTP
 * deployment does, since `McpRegistryService`/`McpClient` open a brand new
 * connection per call (`McpClient`'s own doc comment) rather than keeping one
 * open — a *single* shared transport for the whole test server's lifetime
 * (tried first) only tolerates exactly one `initialize` ever and answers
 * every later reconnect with "Server already initialized".
 *
 * Stateless mode (`sessionIdGenerator: undefined`) was tried before this and
 * hit what looks like a bug in this SDK version's Node adapter
 * (`@hono/node-server`) that turns the `notifications/initialized` POST's
 * empty-body 202 response into a bare 500 with no error surfaced anywhere
 * (`transport.onerror` silent, no unhandled rejection) — reproduced in
 * isolation outside this codebase's own code, so worked around by using the
 * stateful, documented-example configuration instead: real MCP servers
 * overwhelmingly run stateful, and this still genuinely exercises the wire
 * protocol our client wrapper speaks.
 */
export async function startStreamableHttpTestServer(
  opts: TestMcpServerOptions = {},
): Promise<TestMcpServerHandle> {
  const requestsSeen: http.IncomingHttpHeaders[] = [];
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const mcpServers = new Map<string, McpServer>();

  const httpServer = http.createServer((req, res) => {
    requestsSeen.push(req.headers);
    if (!checkAuth(req, res, opts)) return;

    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    const existing = sessionId ? transports.get(sessionId) : undefined;
    if (existing) {
      void existing.handleRequest(req, res);
      return;
    }

    // No known session — this must be a fresh `initialize` call (a bad
    // request naming an unknown session is rejected by the new transport's
    // own session validation, the same outcome a real multi-session server
    // gives).
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) {
        transports.delete(id);
        mcpServers.delete(id);
      }
    };
    const mcpServer = buildMcpServer(opts);
    void mcpServer
      .connect(transport)
      .then(() => {
        if (transport.sessionId) mcpServers.set(transport.sessionId, mcpServer);
        return transport.handleRequest(req, res);
      })
      .catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
      });
  });
  const port = await listen(httpServer);
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    requestsSeen,
    close: async () => {
      for (const server of mcpServers.values()) await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/** Legacy HTTP+SSE — a GET opens the stream and hands back a `sessionId`-bearing
    POST endpoint; a fresh `McpServer` per connection, matching typical SSE
    server examples (the transport documents itself as usable by exactly one
    client for its lifetime). */
export async function startSseTestServer(opts: TestMcpServerOptions = {}): Promise<TestMcpServerHandle> {
  const requestsSeen: http.IncomingHttpHeaders[] = [];
  const transports = new Map<string, SSEServerTransport>();
  const mcpServers = new Map<string, McpServer>();

  const httpServer = http.createServer((req, res) => {
    requestsSeen.push(req.headers);
    if (!checkAuth(req, res, opts)) return;

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      const mcpServer = buildMcpServer(opts);
      transports.set(transport.sessionId, transport);
      mcpServers.set(transport.sessionId, mcpServer);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
        mcpServers.delete(transport.sessionId);
      };
      void mcpServer.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('no such session');
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  const port = await listen(httpServer);
  return {
    url: `http://127.0.0.1:${port}/sse`,
    requestsSeen,
    close: async () => {
      for (const server of mcpServers.values()) await server.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

