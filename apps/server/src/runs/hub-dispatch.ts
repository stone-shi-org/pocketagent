import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { MCP_DEPTH_META_KEY } from '@pocketagent/protocol';

/**
 * PA-171: this backend as an MCP *client* of the Hub's `/mcp`, for webhook
 * runs routed to another host.
 *
 * The Hub's `BackendMcpClient`, pointed the other way: one connection per
 * call, the v2 SDK negotiating either protocol era, and a bearer that is this
 * backend's `webhook`-kind Hub MCP token (`WebhookRoutingStore`). It calls only
 * the four tools a remote webhook run needs, by name in code — nothing a Jira
 * payload or a model writes can name a Hub tool.
 *
 * Nothing about a call's arguments or result is logged here: they carry the
 * rendered prompt, which is Jira text.
 */

export const HUB_DISPATCH_TOOLS = new Set(['dispatch_coding_task', 'dispatch_pocket_task', 'dispatch_prompt', 'wait']);

const CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 90_000;

export type HubDispatchErrorCode =
  /** Routing is not set up (or its token no longer decrypts) on this backend. */
  | 'not_configured'
  /** The Hub could not be reached, or the call failed in transit. */
  | 'unreachable'
  /** The Hub refused the token (401): revoked, or routing was re-minted. */
  | 'rejected'
  /** The Hub (or the target behind it) answered the call with an error. */
  | 'tool_error';

export class HubDispatchError extends Error {
  override readonly name = 'HubDispatchError';
  constructor(
    message: string,
    readonly code: HubDispatchErrorCode,
  ) {
    super(message);
  }
}

export interface HubDispatchClientOptions {
  /** Read fresh on every call, so a re-minted token is picked up mid-wait. */
  credential: () => { url: string; token: string } | null;
  version: string;
  fetchImpl?: typeof fetch;
}

export class HubDispatchClient {
  constructor(private readonly opts: HubDispatchClientOptions) {}

  async call(
    tool: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (!HUB_DISPATCH_TOOLS.has(tool)) throw new HubDispatchError(`A webhook run does not call "${tool}".`, 'tool_error');
    const credential = this.opts.credential();
    if (credential === null) {
      throw new HubDispatchError(
        'Webhook routing is not set up on this server (or its token no longer decrypts). Turn it on for this host on the Hub page.',
        'not_configured',
      );
    }
    const client = await this.connect(credential, opts.signal);
    try {
      let result;
      try {
        result = await client.callTool(
          // Depth 0: a webhook run is where a chain of work begins.
          { name: tool, arguments: args, _meta: { [MCP_DEPTH_META_KEY]: 0 } },
          { timeout: opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
        );
      } catch (err) {
        throw new HubDispatchError(`The Hub call ${tool} failed in transit: ${(err as Error).message}`, 'unreachable');
      }
      const text = textOf(result);
      if ('isError' in result && result.isError) throw new HubDispatchError(text || `${tool} failed on the Hub.`, 'tool_error');
      const structured = 'structuredContent' in result ? result.structuredContent : undefined;
      if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
        return structured as Record<string, unknown>;
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
      return { text };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async connect(credential: { url: string; token: string }, signal?: AbortSignal): Promise<Client> {
    let url: URL;
    try {
      url = new URL(credential.url);
    } catch {
      throw new HubDispatchError(`The stored Hub address is not a URL: ${credential.url}`, 'not_configured');
    }
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${credential.token}` } },
      ...(this.opts.fetchImpl ? { fetch: this.opts.fetchImpl } : {}),
    });
    const client = new Client(
      { name: 'pocketagent-webhooks', version: this.opts.version },
      { capabilities: {}, versionNegotiation: { mode: 'auto' as const } },
    );
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    } catch (err) {
      const message = (err as Error).message;
      if (/\b401\b|unauthori[sz]ed/i.test(message)) {
        throw new HubDispatchError(
          'The Hub rejected this server’s webhook routing token (401). Save webhook routing for this host again on the Hub page.',
          'rejected',
        );
      }
      throw new HubDispatchError(`Hub at ${url.origin} unreachable: ${message}`, 'unreachable');
    }
    return client;
  }
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string };
      return typed?.type === 'text' ? (typed.text ?? '') : '';
    })
    .join('\n');
}
