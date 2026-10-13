import {
  MAX_MCP_CALL_DEPTH,
  MCP_APPROVAL_SCOPE_ARG_META_KEY,
  PROTOCOL_VERSION,
  describeIncompatibility,
  negotiateProtocol,
  type HubFleetToolName,
} from '@pocketagent/protocol';
import type { HubHostRow } from '../db.js';
import type { HostRegistry } from '../registry/store.js';
import { BackendMcpError, type BackendMcpClient, type BackendTarget } from './backend-client.js';
import { FENCE_NOTICE, fenceApproval, fenceTurnResult } from './fence.js';
import type { HubMcpPrincipal } from './tokens.js';

/**
 * PA-134: the Hub `/mcp` catalog — the Fleet agent's tools.
 *
 * Six tools, every one a thin composition of calls the target host's own `/mcp`
 * already serves (see `backend-client.ts`). What is absent is as deliberate as
 * what is present, and `fleet-mcp-tools.test.ts` pins it: no tool answers an
 * approval, no input carries a decision, `skipPermissions`, `force`, an
 * executable or an argv, and nothing reaches agent install, restart, settings
 * or `/api/hooks/*` — a backend token without `admin` could not anyway, and
 * the Hub calls a fixed allowlist of backend tools by name.
 *
 * The two `dispatch_*` tools are the mutating ones. They are marked
 * `readOnlyHint: false` and carry `MCP_APPROVAL_SCOPE_ARG_META_KEY = "host"`,
 * which is what makes the coordinator's approval gate stop for a human on
 * every dispatch to a host it has not been told it may use, and refuse to
 * remember a dispatch decision fleet-wide.
 */

/** Hub-wide ceiling on dispatch/wait calls in flight to backends at once. */
export const HUB_MAX_CONCURRENT_DISPATCHES = 6;
/** The same, per target host — matching a backend's own 3-sessions-per-client cap. */
export const HUB_MAX_DISPATCHES_PER_HOST = 3;
const DEFAULT_WAIT_SECONDS = 60;
const MAX_WAIT_SECONDS = 300;
/** A read across every host must not hang on the slowest one. */
const FAN_OUT_TIMEOUT_MS = 10_000;

export interface FleetToolContext {
  readonly principal: HubMcpPrincipal;
  /** PocketAgent hops behind this call, from `_meta[MCP_DEPTH_META_KEY]`. */
  readonly depth: number;
  readonly signal: AbortSignal;
}

export interface FleetToolDeps {
  readonly registry: HostRegistry;
  readonly client: BackendMcpClient;
  readonly limiter: DispatchLimiter;
}

type JsonSchema = Record<string, unknown>;

export interface FleetToolDefinition {
  readonly name: HubFleetToolName;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly readOnly: boolean;
  /** Extra `_meta` on the tool definition (the approval-scope annotation). */
  readonly meta?: Record<string, unknown>;
  /** The host this call targets, for the audit line — never its arguments. */
  readonly targetOf?: (args: Record<string, unknown>) => string | null;
  readonly handler: (deps: FleetToolDeps, ctx: FleetToolContext, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Counts work in flight per host and overall. A refusal names the cap, so the
 * model can wait on what it already started instead of retrying blind.
 */
export class DispatchLimiter {
  private total = 0;
  private readonly perHost = new Map<string, number>();

  async run<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
    const mine = this.perHost.get(hostId) ?? 0;
    if (this.total >= HUB_MAX_CONCURRENT_DISPATCHES) {
      throw new Error(
        `The Hub already has ${HUB_MAX_CONCURRENT_DISPATCHES} dispatch or wait calls in flight. Wait for one to finish first.`,
      );
    }
    if (mine >= HUB_MAX_DISPATCHES_PER_HOST) {
      throw new Error(
        `The Hub already has ${HUB_MAX_DISPATCHES_PER_HOST} dispatch or wait calls in flight to ${hostId}. Wait for one to finish first.`,
      );
    }
    this.total += 1;
    this.perHost.set(hostId, mine + 1);
    try {
      return await fn();
    } finally {
      this.total -= 1;
      const left = (this.perHost.get(hostId) ?? 1) - 1;
      if (left > 0) this.perHost.set(hostId, left);
      else this.perHost.delete(hostId);
    }
  }

  inFlight(): number {
    return this.total;
  }
}

const hostArg = {
  type: 'string',
  minLength: 1,
  maxLength: 40,
  description: 'A host id from list_hosts.',
} as const;

const SCOPED_BY_HOST = { [MCP_APPROVAL_SCOPE_ARG_META_KEY]: 'host' };

/** A host that may be dispatched to, or an error naming why not. */
function targetFor(deps: FleetToolDeps, hostId: unknown): BackendTarget & { row: HubHostRow } {
  if (typeof hostId !== 'string' || hostId.length === 0) throw new Error('Name a host id from list_hosts.');
  const row = deps.registry.getRow(hostId);
  if (row === null) throw new Error(`No host "${hostId}". Call list_hosts.`);
  if (row.enabled !== 1) throw new Error(`${row.label} is disabled on the Hub.`);
  const state = deps.registry.mcpTokenState(row);
  if (state !== 'ok') throw new Error(`${row.label} cannot be dispatched to: ${tokenProblem(state)}`);
  const token = deps.registry.mcpCredentialFor(row);
  if (token === null) throw new Error(`${row.label} cannot be dispatched to: ${tokenProblem('unreadable')}`);
  return { hostId: row.id, baseUrl: row.base_url, token, row };
}

function tokenProblem(state: string): string {
  switch (state) {
    case 'unbound':
      return 'it is not bound to this Hub.';
    case 'unreadable':
      return "its dispatch token no longer decrypts (the Hub's encryption key changed). Re-enable the Fleet agent.";
    case 'missing':
      return 'the Hub holds no dispatch token for it. Re-enable the Fleet agent.';
    default:
      return 'it has no usable dispatch token.';
  }
}

function deepLinkSession(hostId: string, sessionId: string): string {
  return `/#/h/${encodeURIComponent(hostId)}/s/${encodeURIComponent(sessionId)}`;
}

function deepLinkChat(hostId: string, chatId: string): string {
  return `/#/h/${encodeURIComponent(hostId)}/planner/${encodeURIComponent(chatId)}`;
}

function assertMayStart(ctx: FleetToolContext): void {
  if (ctx.depth >= MAX_MCP_CALL_DEPTH) {
    throw new Error(
      `Refusing to dispatch ${ctx.depth} PocketAgent hops deep (the limit is ${MAX_MCP_CALL_DEPTH}), to stop agents calling agents in a loop.`,
    );
  }
}

function waitSeconds(args: Record<string, unknown>): number {
  const raw = args.timeoutSeconds;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_WAIT_SECONDS;
  return Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(raw)));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms / 1000}s.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorText(err: unknown): string {
  return err instanceof BackendMcpError || err instanceof Error ? err.message : String(err);
}

/** Deep links and fencing for a backend turn result. */
function turnView(hostId: string, ref: string, result: Record<string, unknown>): Record<string, unknown> {
  const fenced = fenceTurnResult(hostId, result);
  const sessionId = typeof result.sessionId === 'string' ? result.sessionId : null;
  const chatId = typeof result.chatId === 'string' ? result.chatId : null;
  const link = sessionId ? deepLinkSession(hostId, sessionId) : chatId ? deepLinkChat(hostId, chatId) : null;
  return {
    host: hostId,
    ref,
    ...fenced,
    ...(link ? { deepLink: link } : {}),
    ...(result.state === 'awaiting_approval'
      ? {
          approvalNote:
            'A human must answer this approval in PocketAgent (the deep link opens it). You cannot answer it, ' +
            'and nothing here can. Call wait again later.',
        }
      : {}),
    notice: FENCE_NOTICE,
  };
}

export const FLEET_TOOLS: readonly FleetToolDefinition[] = [
  {
    name: 'list_hosts',
    title: 'List hosts',
    description:
      'Every PocketAgent machine behind this Hub: id, label, whether it is online, its version, whether its ' +
      'protocol is compatible with this Hub, and whether the Hub can dispatch to it. Call get_host_capabilities ' +
      'for what a host can actually run.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async handler(deps) {
      return {
        hosts: deps.registry.listRows().map((row) => {
          const health = deps.registry.healthFor(row.id);
          const verdict = negotiateProtocol(PROTOCOL_VERSION, health.protocol);
          const tokenState = deps.registry.mcpTokenState(row);
          return {
            id: row.id,
            label: row.label,
            isDefault: row.is_default === 1,
            enabled: row.enabled === 1,
            online: health.lastCheckedAt === null ? null : health.online,
            version: health.version,
            protocol: {
              compatible: verdict.compatible,
              problem: describeIncompatibility(row.label, verdict),
            },
            dispatch: row.enabled !== 1 ? 'disabled' : tokenState === 'ok' ? 'ready' : tokenState,
          };
        }),
      };
    },
  },
  {
    name: 'get_host_capabilities',
    title: 'What a host can run',
    description:
      'One host in detail: its platform and architecture (darwin = macOS, where Xcode work goes), the coding ' +
      'agents installed there and whether they are signed in, its Pocket Agents, and its project folders. Use it ' +
      'to decide where a task belongs before dispatching.',
    inputSchema: {
      type: 'object',
      properties: { host: hostArg },
      required: ['host'],
      additionalProperties: false,
    },
    readOnly: true,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const target = targetFor(deps, args.host);
      const call = (tool: string, toolArgs: Record<string, unknown> = {}) =>
        deps.client.call(target, tool, toolArgs, { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 });
      const [info, caps, agents, pocket, projects] = await Promise.all([
        call('get_host_info'),
        call('get_capabilities').catch(() => null),
        call('list_agents'),
        call('list_pocket_agents'),
        call('list_projects', { maxChatsPerProject: 1 }),
      ]);
      const host = (info.host ?? {}) as Record<string, unknown>;
      const capsPocket = Array.isArray(caps?.pocketAgents)
        ? (caps.pocketAgents as Record<string, unknown>[])
        : null;
      const capsProjects = new Map<string, Record<string, unknown>>(
        (Array.isArray(caps?.projects) ? (caps.projects as Record<string, unknown>[]) : []).map((p) => [
          String(p.path),
          p,
        ]),
      );
      return {
        host: target.hostId,
        label: target.row.label,
        platform: caps?.platform ?? host.platform ?? null,
        arch: caps?.arch ?? host.arch ?? null,
        osVersion: caps?.osVersion ?? null,
        version: host.version ?? null,
        description: caps?.description ?? '',
        tags: Array.isArray(caps?.tags) ? caps.tags : [],
        executables: Array.isArray(caps?.executables) ? caps.executables : [],
        runningSessions: host.runningSessions ?? null,
        codingAgents: ((agents.agents as Record<string, unknown>[] | undefined) ?? []).map((a) => ({
          id: a.id,
          displayName: a.displayName,
          available: a.available,
          setupState: a.setupState,
          canDispatch: a.available === true && a.structured === true,
        })),
        pocketAgents:
          capsPocket !== null
            ? capsPocket.map((p) => ({
                id: p.id,
                name: p.name,
                defaultModelId: p.defaultModelId ?? null,
                identityPrompt: p.identityPrompt ?? null,
                enabledTools: p.enabledTools ?? [],
                skills: p.skills ?? [],
              }))
            : ((pocket.pocketAgents as Record<string, unknown>[] | undefined) ?? []).map((p) => ({
                id: p.id,
                name: p.name,
                defaultModelId: p.defaultModelId ?? null,
              })),
        projects: ((projects.projects as Record<string, unknown>[] | undefined) ?? []).map((p) => {
          const capProj = capsProjects.get(String(p.cwd));
          return {
            cwd: p.cwd,
            name: p.name,
            label: capProj?.label ?? p.name,
            gitBranch: p.gitBranch ?? null,
            gitRemoteUrl: capProj?.gitRemoteUrl ?? null,
          };
        }),
        note:
          'Capabilities are read live from the host. A coding agent with canDispatch false is not installed, ' +
          'or has no structured transport.',
      };
    },
  },
  {
    name: 'dispatch_pocket_task',
    title: 'Dispatch a task to a Pocket Agent on a host',
    description:
      'Start a new chat with a Pocket Agent on another host and send it the task. Returns at once with a ref; ' +
      'call wait(host, ref) for the reply. Needs approval on this side, per host. Any approval the task then ' +
      'needs on that host is answered by a human there.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        pocketAgentId: { type: 'string', minLength: 1, maxLength: 200, description: 'From get_host_capabilities.' },
        prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
        title: { type: 'string', maxLength: 200 },
        modelId: {
          type: 'string',
          maxLength: 200,
          description: 'Optional. Defaults to that Pocket Agent\'s own default model (defaultModelId in get_host_capabilities).',
        },
      },
      required: ['host', 'pocketAgentId', 'prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      assertMayStart(ctx);
      const target = targetFor(deps, args.host);
      return deps.limiter.run(target.hostId, async () => {
        const created = await deps.client.call(
          target,
          'create_pocket_chat',
          {
            workspaceId: String(args.pocketAgentId),
            title: typeof args.title === 'string' && args.title.length > 0 ? args.title : `Fleet · ${ctx.principal.label}`,
            ...(typeof args.modelId === 'string' && args.modelId.length > 0 ? { modelId: args.modelId } : {}),
          },
          { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
        );
        const chatId = typeof created.chatId === 'string' ? created.chatId : null;
        if (!chatId) throw new Error(`${target.row.label} created a chat but did not say which.`);
        const sent = await deps.client.call(
          target,
          'send_pocket_message',
          { chatId, message: String(args.prompt), timeoutSeconds: 0 },
          { depth: ctx.depth, signal: ctx.signal },
        );
        return turnView(target.hostId, `chat:${chatId}`, { ...sent, chatId });
      });
    },
  },
  {
    name: 'dispatch_coding_task',
    title: 'Dispatch a coding task to a host',
    description:
      'Start a coding agent (claude, codex, …) in a project folder on another host with this prompt. Returns at ' +
      'once with a ref; call wait(host, ref) for the answer. Needs approval on this side, per host. Approvals the ' +
      'agent needs on that host are answered by a human there.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        cwd: { type: 'string', minLength: 1, maxLength: 4096, description: 'A project folder from get_host_capabilities.' },
        agent: { type: 'string', minLength: 1, maxLength: 200, description: 'A coding agent id with canDispatch true.' },
        prompt: { type: 'string', minLength: 1, maxLength: 100_000 },
        worktree: {
          type: 'string',
          enum: ['none', 'new-branch'],
          description: '"new-branch" works in a fresh git worktree on a newly minted branch. Default "none".',
        },
        title: { type: 'string', maxLength: 200 },
        model: { type: 'string', maxLength: 200 },
      },
      required: ['host', 'cwd', 'agent', 'prompt'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      assertMayStart(ctx);
      const target = targetFor(deps, args.host);
      return deps.limiter.run(target.hostId, async () => {
        const started = await deps.client.call(
          target,
          'start_session',
          {
            cwd: String(args.cwd),
            agent: String(args.agent),
            prompt: String(args.prompt),
            title: typeof args.title === 'string' && args.title.length > 0 ? args.title : `Fleet · ${ctx.principal.label}`,
            ...(args.worktree === 'new-branch' ? { worktree: 'new-branch' } : {}),
            ...(typeof args.model === 'string' && args.model.length > 0 ? { model: args.model } : {}),
          },
          { depth: ctx.depth, signal: ctx.signal, timeoutMs: 60_000 },
        );
        const sessionId = typeof started.sessionId === 'string' ? started.sessionId : null;
        if (!sessionId) throw new Error(`${target.row.label} started a session but did not say which.`);
        return turnView(target.hostId, `session:${sessionId}`, started);
      });
    },
  },
  {
    name: 'wait',
    title: 'Wait for dispatched work',
    description:
      'Wait (up to timeoutSeconds, default 60, max 300) for work started with dispatch_* to finish its turn. ' +
      'States: complete, awaiting_approval (a human must answer on that host — follow deepLink; you cannot), ' +
      'queued, still_running (call again), ended. The timeout ends the wait, never the work.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        ref: { type: 'string', minLength: 1, maxLength: 220, description: 'The ref a dispatch_* call returned.' },
        timeoutSeconds: { type: 'integer', minimum: 0, maximum: MAX_WAIT_SECONDS },
      },
      required: ['host', 'ref'],
      additionalProperties: false,
    },
    readOnly: true,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const target = targetFor(deps, args.host);
      const ref = String(args.ref);
      const match = /^(session|chat):(.{1,200})$/.exec(ref);
      if (!match) throw new Error('A ref looks like "session:<id>" or "chat:<id>", exactly as dispatch_* returned it.');
      const [, kind, id] = match as unknown as [string, 'session' | 'chat', string];
      const timeoutSeconds = waitSeconds(args);
      return deps.limiter.run(target.hostId, async () => {
        const result =
          kind === 'session'
            ? await deps.client.call(target, 'wait_for_turn', { sessionId: id, timeoutSeconds }, { depth: ctx.depth, signal: ctx.signal })
            : await deps.client.call(target, 'wait_for_pocket_turn', { chatId: id, timeoutSeconds }, { depth: ctx.depth, signal: ctx.signal });
        return turnView(target.hostId, ref, kind === 'session' ? { sessionId: id, ...result } : { chatId: id, ...result });
      });
    },
  },
  {
    name: 'list_pending_approvals',
    title: 'Pending approvals across hosts',
    description:
      'Tool calls waiting for a human on every host, each with a deep link that opens it. Read-only: you can see ' +
      'an approval but never answer one. Hosts that could not be asked are listed with the reason.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
    async handler(deps, ctx) {
      const rows = deps.registry.listRows().filter((row) => row.enabled === 1);
      const approvals: Record<string, unknown>[] = [];
      const unavailable: { host: string; reason: string }[] = [];
      await Promise.all(
        rows.map(async (row) => {
          let target;
          try {
            target = targetFor(deps, row.id);
          } catch (err) {
            unavailable.push({ host: row.id, reason: errorText(err) });
            return;
          }
          try {
            const result = await withTimeout(
              deps.client.call(target, 'list_pending_approvals', {}, { depth: ctx.depth, signal: ctx.signal, timeoutMs: FAN_OUT_TIMEOUT_MS }),
              FAN_OUT_TIMEOUT_MS,
              row.label,
            );
            for (const item of (result.approvals as Record<string, unknown>[] | undefined) ?? []) {
              const sessionId = typeof item.sessionId === 'string' ? item.sessionId : null;
              approvals.push({
                host: row.id,
                ...(fenceApproval(row.id, item) as Record<string, unknown>),
                ...(sessionId ? { deepLink: deepLinkSession(row.id, sessionId) } : {}),
              });
            }
          } catch (err) {
            unavailable.push({ host: row.id, reason: errorText(err) });
          }
        }),
      );
      approvals.sort((a, b) => String(a.host).localeCompare(String(b.host)));
      unavailable.sort((a, b) => a.host.localeCompare(b.host));
      return {
        approvals,
        unavailable,
        note: 'A human answers each of these in PocketAgent, on that host. Nothing here can.',
        notice: FENCE_NOTICE,
      };
    },
  },
];
