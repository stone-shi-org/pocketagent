import { Client, StreamableHTTPClientTransport, type DiscoverResult } from '@modelcontextprotocol/client';
import { MCP_DEPTH_META_KEY, MCP_SERVER_PATH } from '@pocketagent/protocol';
import { HUB_VERSION } from '../version.js';

/**
 * PA-134: the Hub as an MCP *client* of each backend.
 *
 * The PA-70 rule — "the Hub is an API client, not a new contract" — applied to
 * dispatch: everything the Fleet agent does on a host is a call to a tool that
 * host's own `/mcp` already serves (`start_session`, `send_pocket_message`,
 * `wait_for_turn`, …), validated, capped, approval-gated and audited there.
 * The Hub adds no backend route and re-implements no rule.
 *
 * Two things are fixed here rather than left to callers:
 *
 * - **Only names on `BACKEND_TOOL_ALLOWLIST` are ever called.** The Fleet
 *   catalog maps each of its own tools onto these by name, in code; nothing a
 *   model writes can name a backend tool. That keeps `admin` tools (which the
 *   token cannot reach anyway), `interrupt_*`/`stop_session` and anything a
 *   later backend adds out of reach of the Hub until someone decides otherwise.
 * - **The credential is the host's scoped `pam_` token, never the `pah_`
 *   credential.** A full-access hub credential would make every dispatch a
 *   terminal-access grant; the scoped token is what the backend's own scope
 *   check, caps and `mcp_owned_work` ownership are built around.
 *
 * The backend's `/mcp` is dialed directly at `<base_url>/mcp`, not through the
 * Hub's own `/h/` proxy: the proxy carries the `pah_` credential, and `/mcp`
 * is outside the paths it forwards at all.
 */

export const BACKEND_TOOL_ALLOWLIST = new Set([
  'get_host_info',
  'get_capabilities',
  'list_agents',
  'list_pocket_agents',
  'list_projects',
  'list_pending_approvals',
  'start_session',
  'wait_for_turn',
  'create_pocket_chat',
  'send_pocket_message',
  'wait_for_pocket_turn',
]);

const CONNECT_TIMEOUT_MS = 15_000;
/** Above the backend's own longest wait (300 s), so its timeout wins. */
const CALL_TIMEOUT_MS = 320_000;

export class BackendMcpError extends Error {
  override readonly name = 'BackendMcpError';
  constructor(
    message: string,
    readonly code: 'not_allowed' | 'unreachable' | 'rejected' | 'tool_error',
  ) {
    super(message);
  }
}

export interface BackendTarget {
  readonly hostId: string;
  readonly baseUrl: string;
  readonly token: string;
}

type Verdict = { kind: 'modern'; discover: DiscoverResult } | { kind: 'legacy' };

export interface BackendMcpClientOptions {
  readonly fetchImpl?: typeof fetch;
}

export class BackendMcpClient {
  /**
   * The negotiated era per host, in memory only. The backend serves both eras,
   * so a stale verdict costs one failed connect and a fresh probe, never a
   * wrong answer; persisting it would add a column for no correctness gain.
   */
  private readonly verdicts = new Map<string, Verdict>();

  constructor(private readonly opts: BackendMcpClientOptions = {}) {}

  /**
   * Call one allowlisted tool and return its structured result. A tool-level
   * error (`isError`) becomes a `BackendMcpError('tool_error')` carrying the
   * backend's own sentence, so the Fleet tool can relay it rather than
   * pretending the call succeeded.
   */
  async call(
    target: BackendTarget,
    tool: string,
    args: Record<string, unknown>,
    opts: { depth: number; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (!BACKEND_TOOL_ALLOWLIST.has(tool)) {
      throw new BackendMcpError(`The Hub does not call "${tool}" on a host.`, 'not_allowed');
    }
    const client = await this.connect(target, opts.signal);
    try {
      let result;
      try {
        result = await client.callTool(
          { name: tool, arguments: args, _meta: { [MCP_DEPTH_META_KEY]: opts.depth } },
          { timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS, ...(opts.signal ? { signal: opts.signal } : {}) },
        );
      } catch (err) {
        // The connection worked and the call did not: drop the verdict so a
        // server that changed era since is re-probed next time. The call is
        // *not* retried — it may have run, and dispatch is not idempotent.
        this.verdicts.delete(target.hostId);
        throw new BackendMcpError(`${tool} failed on ${target.hostId}: ${(err as Error).message}`, 'unreachable');
      }
      const text = textOf(result);
      if ('isError' in result && result.isError) throw new BackendMcpError(text || `${tool} failed.`, 'tool_error');
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

  /** Forget a host's cached era (its token or address changed). */
  forget(hostId: string): void {
    this.verdicts.delete(hostId);
  }

  private async connect(target: BackendTarget, signal?: AbortSignal): Promise<Client> {
    const url = new URL(`${target.baseUrl.replace(/\/$/, '')}${MCP_SERVER_PATH}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${target.token}` } },
      ...(this.opts.fetchImpl ? { fetch: this.opts.fetchImpl } : {}),
    });
    const client = new Client(
      { name: 'pocketagent-hub', version: HUB_VERSION },
      { capabilities: {}, versionNegotiation: { mode: 'auto' as const } },
    );
    const prior = this.verdicts.get(target.hostId);
    try {
      await client.connect(transport, {
        timeout: CONNECT_TIMEOUT_MS,
        ...(prior ? { prior } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      this.verdicts.delete(target.hostId);
      const message = (err as Error).message;
      const rejected = /\b401\b|unauthori[sz]ed/i.test(message);
      throw new BackendMcpError(
        rejected
          ? `${target.hostId} rejected the Hub's dispatch token. Re-enable the Fleet agent to mint a new one.`
          : `Could not reach ${target.hostId}'s MCP endpoint: ${message}`,
        rejected ? 'rejected' : 'unreachable',
      );
    }
    const era = client.getProtocolEra();
    if (era === 'modern') {
      const discover = client.getDiscoverResult();
      if (discover) this.verdicts.set(target.hostId, { kind: 'modern', discover });
    } else if (era === 'legacy') {
      this.verdicts.set(target.hostId, { kind: 'legacy' });
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
