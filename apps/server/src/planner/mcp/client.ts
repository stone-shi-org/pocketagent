import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { MCP_DEPTH_META_KEY, type McpAuthKind, type McpTransportKind } from '@pocketagent/protocol';

/**
 * PA-37: a thin wrapper around the official `@modelcontextprotocol/sdk`
 * client, covering exactly the two remote transports the reporter asked for
 * (`streamable_http`, the current single-endpoint transport, and `sse`, the
 * legacy two-endpoint one) and exactly the three MCP calls this app needs
 * (`initialize` — implicit in `connect()` —, `tools/list`, `tools/call`).
 *
 * Depending on the official SDK rather than hand-rolling JSON-RPC framing for
 * two transports is a deliberate choice, not a shortcut: MCP's own session-id,
 * reconnection and batching rules are more than a single-shot
 * `postJsonToIntegration`-style POST, and reimplementing them by hand would
 * only reproduce a spec the SDK already gets right.
 *
 * One `McpClient` is one short-lived connection — connect, do one or more
 * calls, close — matching the fact that nothing else in the planner's own
 * tool execution keeps a resource open across calls either. `McpRegistryService`
 * is the layer above this that decides when to reuse a connection versus
 * reconnect.
 */

const MCP_CONNECT_TIMEOUT_MS = 15_000;
const MCP_CALL_TIMEOUT_MS = 60_000;

export interface McpConnectionConfig {
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  bearerToken: string | null;
  headerName: string | null;
  headerValue: string | null;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** From the MCP tool's own `annotations.readOnlyHint`, or `null` when the
      server did not declare one. Callers must treat `null` as "unknown,
      assume mutating" — the same fail-closed default this codebase applies
      everywhere else a tool's safety cannot be established. */
  readOnlyHint: boolean | null;
}

/** The auth headers this registry's config implies, sent identically on both
    transports (the SSE transport's initial GET and its recurring POSTs, the
    Streamable HTTP transport's single endpoint). `none`/incomplete config
    yields no headers at all rather than an empty `Authorization` value. */
function authHeaders(config: McpConnectionConfig): Record<string, string> {
  if (config.authKind === 'bearer' && config.bearerToken) {
    return { authorization: `Bearer ${config.bearerToken}` };
  }
  if (config.authKind === 'header' && config.headerName && config.headerValue) {
    return { [config.headerName]: config.headerValue };
  }
  return {};
}

function buildTransport(config: McpConnectionConfig): Transport {
  const url = new URL(config.url);
  const headers = authHeaders(config);
  if (config.transport === 'streamable_http') {
    return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  }
  // HTTP+SSE (legacy): `requestInit` covers the recurring POSTs, but the
  // initial GET that opens the SSE stream is made by the `eventsource`
  // package, not `fetch` directly — its own `EventSourceInit.fetch` override
  // is the documented way to attach headers to that first request too.
  return new SSEClientTransport(url, {
    requestInit: { headers },
    eventSourceInit: {
      fetch: (input, init) =>
        fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
    },
  });
}

/** Content blocks an MCP `tools/call` result can carry, collapsed to text the
    same way every other tool in `planner/tools.ts` returns a plain string —
    an image/audio/resource block is described rather than rendered, since the
    planner's transcript and its LLM message format are both text-only. */
function contentToText(content: readonly unknown[]): string {
  return content
    .map((block) => {
      if (block && typeof block === 'object' && 'type' in block) {
        const typed = block as { type: string; text?: string; resource?: { uri?: string } };
        if (typed.type === 'text') return typed.text ?? '';
        if (typed.type === 'resource' && typed.resource?.uri) {
          return `[resource: ${typed.resource.uri}]`;
        }
        return `[${typed.type} content]`;
      }
      return JSON.stringify(block);
    })
    .join('\n');
}

export class McpClientError extends Error {
  override readonly name = 'McpClientError';
}

export interface McpClientOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  customTransport?: Transport;
}

export class McpClient {
  private client: Client | null = null;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly customTransport?: Transport;

  constructor(
    private readonly config: McpConnectionConfig,
    optionsOrTransport?: Transport | McpClientOptions,
  ) {
    if (optionsOrTransport && 'start' in optionsOrTransport) {
      this.customTransport = optionsOrTransport;
      this.connectTimeoutMs = MCP_CONNECT_TIMEOUT_MS;
      this.callTimeoutMs = MCP_CALL_TIMEOUT_MS;
    } else if (optionsOrTransport) {
      this.customTransport = optionsOrTransport.customTransport;
      this.connectTimeoutMs = optionsOrTransport.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
      this.callTimeoutMs = optionsOrTransport.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
    } else {
      this.connectTimeoutMs = MCP_CONNECT_TIMEOUT_MS;
      this.callTimeoutMs = MCP_CALL_TIMEOUT_MS;
    }
  }

  async connect(): Promise<void> {
    const transport = this.customTransport ?? buildTransport(this.config);
    const client = new Client({ name: 'pocketagent', version: '1.0.0' }, { capabilities: {} });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP error -32001: Request timed out')), this.connectTimeoutMs);
      });
      await Promise.race([client.connect(transport, { timeout: this.connectTimeoutMs }), timeoutPromise]);
    } catch (err) {
      throw new McpClientError(`Could not connect: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.client = client;
  }

  /**
   * The MCP `initialize` response's optional `instructions` field, if the
   * server set one — a server-authored "how to use me" blurb, distinct from
   * a registry's own user-authored `description`. `null` both when not
   * connected and when the server simply didn't set one; callers cannot and
   * do not need to tell those apart. Must be called after `connect()`.
   */
  getInstructions(): string | null {
    return this.client?.getInstructions() ?? null;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    if (!this.client) throw new McpClientError('Not connected.');
    let result;
    try {
      result = await this.client.listTools(undefined, { timeout: this.callTimeoutMs });
    } catch (err) {
      throw new McpClientError(`tools/list failed: ${(err as Error).message}`);
    }
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
      readOnlyHint: tool.annotations?.readOnlyHint ?? null,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { depth?: number } = {},
  ): Promise<{ text: string; isError: boolean }> {
    if (!this.client) throw new McpClientError('Not connected.');
    let result;
    try {
      // PA-118: how many PocketAgent hops deep this call already is, so a
      // PocketAgent registered as its own MCP registry cannot loop forever.
      // Harmless to any other server: `_meta` keys it does not know are ignored.
      const meta = opts.depth !== undefined ? { _meta: { [MCP_DEPTH_META_KEY]: opts.depth } } : {};
      result = await this.client.callTool({ name, arguments: args, ...meta }, undefined, {
        timeout: this.callTimeoutMs,
      });
    } catch (err) {
      throw new McpClientError(`tools/call failed: ${(err as Error).message}`);
    }
    const content = 'content' in result && Array.isArray(result.content) ? result.content : [];
    return { text: contentToText(content), isError: 'isError' in result ? Boolean(result.isError) : false };
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => undefined);
  }
}
