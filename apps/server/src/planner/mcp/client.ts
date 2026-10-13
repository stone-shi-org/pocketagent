import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type DiscoverResult,
  type Transport,
} from '@modelcontextprotocol/client';
import {
  MCP_APPROVAL_SCOPE_ARG_META_KEY,
  MCP_DEPTH_META_KEY,
  type McpAuthKind,
  type McpProtocolEra,
  type McpTransportKind,
} from '@pocketagent/protocol';

/**
 * PA-37: a thin wrapper around the official MCP SDK's
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
 * **Dual-era since PA-118.** Built on the v2 SDK client
 * (`@modelcontextprotocol/client`), so a registry can be a server speaking the
 * stateless 2026-07-28 revision as well as any 2025-era one. On
 * `streamable_http` the client negotiates (`versionNegotiation: 'auto'`): it
 * probes `server/discover`, adopts the modern era on definitive modern
 * evidence and otherwise falls back to the plain `initialize` handshake,
 * byte-equivalent to a 2025 client — so every server that worked before still
 * does. `sse` is the deprecated HTTP+SSE transport, which exists only in the
 * legacy era, so it never probes.
 *
 * Because this class is one connection per call, probing every time would put
 * a `server/discover` round trip in front of every tool call. The spec's answer
 * is that a client SHOULD cache the era per server, so `connect` accepts the
 * verdict a previous connection produced (`McpEraVerdict`, persisted on the
 * registry row by `McpRegistryService`) and passes it as the SDK's `prior`:
 * a cached modern verdict adopts the stored `DiscoverResult` with zero round
 * trips, a cached legacy one skips the probe.
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
  /** PA-134: the argument naming this tool's target, from the tool's own
      `_meta[MCP_APPROVAL_SCOPE_ARG_META_KEY]` — `null` for every tool that
      does not declare one, which is every tool not served by a PocketAgent
      Hub. Narrows what an approval may remember; it never widens anything. */
  approvalScopeArg: string | null;
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

/**
 * What a connection learned about the server's protocol era, for the next
 * connection to reuse. `discover` is the server's own `server/discover`
 * result and is present exactly when `era` is `modern` — it is what lets a
 * modern verdict be adopted with zero round trips.
 */
export interface McpEraVerdict {
  era: McpProtocolEra;
  version: string | null;
  discover: DiscoverResult | null;
}

export class McpClientError extends Error {
  override readonly name = 'McpClientError';
}

export interface McpClientOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  customTransport?: Transport;
  /** A verdict a previous connection produced; `null`/absent probes afresh. */
  prior?: McpEraVerdict | null;
}

export class McpClient {
  private client: Client | null = null;
  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly customTransport?: Transport;
  private readonly prior: McpEraVerdict | null;

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
    this.prior =
      optionsOrTransport && !('start' in optionsOrTransport) ? (optionsOrTransport.prior ?? null) : null;
  }

  /** Whether this connection was handed a cached verdict rather than probing. */
  get usedPriorVerdict(): boolean {
    return this.prior !== null && this.config.transport !== 'sse';
  }

  /**
   * The era this connection actually ended up in, for the caller to persist.
   * `null` before `connect()` succeeds.
   */
  getEraVerdict(): McpEraVerdict | null {
    const client = this.client;
    if (!client) return null;
    const era = client.getProtocolEra();
    if (!era) return null;
    const discover = era === 'modern' ? (client.getDiscoverResult() ?? null) : null;
    return { era, version: client.getNegotiatedProtocolVersion() ?? null, discover };
  }

  async connect(): Promise<void> {
    const transport = this.customTransport ?? buildTransport(this.config);
    const negotiate = this.config.transport !== 'sse';
    const client = new Client(
      { name: 'pocketagent', version: '1.0.0' },
      {
        capabilities: {},
        // `sse` is legacy-only by definition; everything else negotiates.
        ...(negotiate ? { versionNegotiation: { mode: 'auto' as const } } : {}),
      },
    );
    const prior = negotiate ? priorFor(this.prior) : undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP error -32001: Request timed out')), this.connectTimeoutMs);
      });
      await Promise.race([
        client.connect(transport, { timeout: this.connectTimeoutMs, ...(prior ? { prior } : {}) }),
        timeoutPromise,
      ]);
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
      approvalScopeArg: approvalScopeArgOf(tool._meta),
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
      result = await this.client.callTool({ name, arguments: args, ...meta }, { timeout: this.callTimeoutMs });
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

/**
 * A stored verdict as the SDK's `prior`. A modern verdict without its
 * `DiscoverResult` cannot be adopted, so it probes afresh instead of guessing.
 */
function priorFor(verdict: McpEraVerdict | null):
  | { kind: 'modern'; discover: DiscoverResult }
  | { kind: 'legacy' }
  | undefined {
  if (!verdict) return undefined;
  if (verdict.era === 'legacy') return { kind: 'legacy' };
  return verdict.discover ? { kind: 'modern', discover: verdict.discover } : undefined;
}

/** A well-formed scope-argument name, or null. Anything odd is ignored rather
    than trusted: the annotation can only ever narrow an approval. */
function approvalScopeArgOf(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>)[MCP_APPROVAL_SCOPE_ARG_META_KEY];
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value) ? value : null;
}
