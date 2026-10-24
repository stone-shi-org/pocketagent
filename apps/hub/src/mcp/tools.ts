import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_MCP_CALL_DEPTH,
  MCP_APPROVAL_SCOPE_ARG_META_KEY,
  PROTOCOL_VERSION,
  describeIncompatibility,
  describeVersionDrift,
  detectVersionDrift,
  hostVersionStatus,
  latestKnownVersion,
  negotiateProtocol,
  secretHolesFor,
  type HubFleetToolName,
  type ProtocolRange,
} from '@pocketagent/protocol';
import type { HubHostRow } from '../db.js';
import type { PushNotificationRelay } from '../push/relay.js';
import type { HostRegistry } from '../registry/store.js';
import { Provisioner } from '../templates/provisioner.js';
import { isSystemTemplateId, type TemplateStore } from '../templates/store.js';
import { BackendMcpError, type BackendMcpClient, type BackendTarget } from './backend-client.js';
import { FENCE_NOTICE, fenceApproval, fenceHostText, fenceTurnResult } from './fence.js';
import type { HubMcpPrincipal } from './tokens.js';

/**
 * PA-134 / PA-135: the Hub `/mcp` catalog — the Fleet agent's tools.
 *
 * Every tool is a thin composition of calls the target host's own `/mcp`
 * already serves (see `backend-client.ts`). What is absent is as deliberate as
 * what is present, and `fleet-mcp-tools.test.ts` pins it: no tool answers an
 * approval, no input carries a decision, `skipPermissions`, `force`, an
 * executable or an argv, and nothing reaches agent install, restart, secrets
 * or `/api/hooks/*`.
 *
 * Mutating tools (`dispatch_*` and Tier 2 config tools) are marked
 * `readOnlyHint: false` and carry `MCP_APPROVAL_SCOPE_ARG_META_KEY` (`"host"`
 * or `"hosts"`), which makes the coordinator's approval gate stop for a human
 * per target host and refuse to remember a decision fleet-wide.
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
  readonly latestRelease?: string | null;
  readonly pushRelay?: PushNotificationRelay;
  readonly templates?: TemplateStore;
  readonly ensureAdminToken?: (host: HubHostRow) => Promise<string>;
  /**
   * PA-169: mint a host's scoped dispatch token on first use when none was
   * ever minted — Hub MCP client tokens work without a Fleet agent enabled.
   */
  readonly ensureDispatchToken?: (host: HubHostRow) => Promise<void>;
  readonly log?: FastifyBaseLogger;
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

const optionalHostsSchema: JsonSchema = {
  type: 'object',
  properties: {
    hosts: {
      type: 'array',
      items: hostArg,
      maxItems: 50,
      description: 'Optional subset of host ids from list_hosts; omit for every enabled host.',
    },
  },
  additionalProperties: false,
};

const SCOPED_BY_HOST = { [MCP_APPROVAL_SCOPE_ARG_META_KEY]: 'host' };
const SCOPED_BY_HOSTS = { [MCP_APPROVAL_SCOPE_ARG_META_KEY]: 'hosts' };

/** A host that may be dispatched to (or read via Tier 1), or an error naming why not. */
async function targetFor(deps: FleetToolDeps, hostId: unknown): Promise<BackendTarget & { row: HubHostRow }> {
  if (typeof hostId !== 'string' || hostId.length === 0) throw new Error('Name a host id from list_hosts.');
  let row = deps.registry.getRow(hostId);
  if (row === null) throw new Error(`No host "${hostId}". Call list_hosts.`);
  if (row.enabled !== 1) throw new Error(`${row.label} is disabled on the Hub.`);
  if (deps.registry.mcpTokenState(row) === 'missing' && deps.ensureDispatchToken) {
    try {
      await deps.ensureDispatchToken(row);
    } catch (err) {
      throw new Error(`${row.label} cannot be dispatched to: ${errorText(err)}`);
    }
    row = deps.registry.getRow(hostId) ?? row;
  }
  const state = deps.registry.mcpTokenState(row);
  if (state !== 'ok') throw new Error(`${row.label} cannot be dispatched to: ${tokenProblem(state)}`);
  const token = deps.registry.mcpCredentialFor(row);
  if (token === null) throw new Error(`${row.label} cannot be dispatched to: ${tokenProblem('unreadable')}`);
  return { hostId: row.id, baseUrl: row.base_url, token, row };
}

/**
 * PA-135: obtain the separate `admin`-scoped `pam_` token for Tier 2 config
 * changes on `hostId`. Never falls back to the PA-134 dispatch token.
 */
async function adminTargetFor(deps: FleetToolDeps, hostId: unknown): Promise<BackendTarget & { row: HubHostRow }> {
  if (typeof hostId !== 'string' || hostId.length === 0) throw new Error('Name a host id from list_hosts.');
  const row = deps.registry.getRow(hostId);
  if (row === null) throw new Error(`No host "${hostId}". Call list_hosts.`);
  if (row.enabled !== 1) throw new Error(`${row.label} is disabled on the Hub.`);
  if (deps.registry.mcpAdminTokenState(row) === 'ok') {
    const existing = deps.registry.mcpAdminCredentialFor(row);
    if (existing !== null) {
      return { hostId: row.id, baseUrl: row.base_url, token: existing, row };
    }
  }
  if (!deps.ensureAdminToken) {
    throw new Error(`${row.label} has no admin token for Tier 2 config changes.`);
  }
  const token = await deps.ensureAdminToken(row);
  const refreshed = deps.registry.getRow(row.id) ?? row;
  return { hostId: refreshed.id, baseUrl: refreshed.base_url, token, row: refreshed };
}

function selectRows(deps: FleetToolDeps, rawHosts: unknown): {
  rows: HubHostRow[];
  initialErrors: { host: string; label: string; error: string }[];
} {
  if (Array.isArray(rawHosts) && rawHosts.length > 0) {
    const rows: HubHostRow[] = [];
    const initialErrors: { host: string; label: string; error: string }[] = [];
    const seen = new Set<string>();
    for (const item of rawHosts) {
      const id = String(item ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const row = deps.registry.getRow(id);
      if (!row) {
        initialErrors.push({ host: id, label: id, error: `No host "${id}".` });
      } else if (row.enabled !== 1) {
        initialErrors.push({ host: row.id, label: row.label, error: `${row.label} is disabled on the Hub.` });
      } else {
        rows.push(row);
      }
    }
    return { rows, initialErrors };
  }
  return {
    rows: deps.registry.listRows().filter((row) => row.enabled === 1),
    initialErrors: [],
  };
}

async function fanOutRead<T extends Record<string, unknown>>(
  deps: FleetToolDeps,
  ctx: FleetToolContext,
  rawHosts: unknown,
  perHost: (row: HubHostRow, target: BackendTarget) => Promise<T>,
): Promise<{
  hosts: (T & { host: string; label: string })[];
  errors: { host: string; label: string; error: string }[];
}> {
  const { rows, initialErrors } = selectRows(deps, rawHosts);
  const hosts: (T & { host: string; label: string })[] = [];
  const errors: { host: string; label: string; error: string }[] = [...initialErrors];
  await Promise.all(
    rows.map(async (row) => {
      let target: BackendTarget;
      try {
        target = await targetFor(deps, row.id);
      } catch (err) {
        errors.push({ host: row.id, label: row.label, error: errorText(err) });
        return;
      }
      try {
        const data = await withTimeout(perHost(row, target), FAN_OUT_TIMEOUT_MS, row.label);
        hosts.push({ host: row.id, label: row.label, ...data });
      } catch (err) {
        errors.push({ host: row.id, label: row.label, error: errorText(err) });
      }
    }),
  );
  hosts.sort((a, b) => a.host.localeCompare(b.host));
  errors.sort((a, b) => a.host.localeCompare(b.host));
  return { hosts, errors };
}

const FORBIDDEN_APPROVAL_KEYS = new Set([
  'skipPermissions',
  'skipPermissionsEnabled',
  'yoloEnabled',
  'skipToolApprovals',
  'skipToolApprovalsEnabled',
]);

const FORBIDDEN_SECRET_KEYS = new Set([
  'apiKey',
  'botToken',
  'secret',
  'token',
  'embeddingApiKey',
  'webSearchApiKey',
  'urlFetchApiKey',
  'bearerToken',
  'headerValue',
]);

function rejectForbiddenPatchKeys(patch: Record<string, unknown>, toolName: string): void {
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN_APPROVAL_KEYS.has(key)) {
      throw new Error(
        `Refusing: ${key} cannot be changed through ${toolName}. A human must flip that switch from the Settings page.`,
      );
    }
    if (FORBIDDEN_SECRET_KEYS.has(key)) {
      throw new Error(
        `Refusing: ${key} is a secret field and cannot be set, changed or read through ${toolName}. Re-enter it from the Settings page.`,
      );
    }
  }
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
            // PA-169: a bound host whose dispatch token was never minted gets
            // one on first use, so it is as ready as one that has it.
            dispatch:
              row.enabled !== 1
                ? 'disabled'
                : tokenState === 'ok' || (tokenState === 'missing' && deps.ensureDispatchToken)
                  ? 'ready'
                  : tokenState,
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
      const target = await targetFor(deps, args.host);
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
        capabilitiesVersion: typeof caps?.capabilitiesVersion === 'number' ? caps.capabilitiesVersion : 1,
        platform: caps?.platform ?? host.platform ?? null,
        arch: caps?.arch ?? host.arch ?? null,
        osVersion: caps?.osVersion ?? null,
        version: host.version ?? null,
        description: caps?.description ?? '',
        tags: Array.isArray(caps?.tags) ? caps.tags : [],
        executables: Array.isArray(caps?.executables) ? caps.executables : [],
        agents: Array.isArray(caps?.agents) ? caps.agents : [],
        hasWorkspaceIndex: typeof caps?.hasWorkspaceIndex === 'boolean' ? caps.hasWorkspaceIndex : false,
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
      const target = await targetFor(deps, args.host);
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
      const target = await targetFor(deps, args.host);
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
      const target = await targetFor(deps, args.host);
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
            target = await targetFor(deps, row.id);
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

  // ---- Tier 1: read-only fleet views (PA-135) ------------------------------
  {
    name: 'fleet_versions',
    title: 'Fleet versions and protocol drift',
    description:
      'Read-only version and protocol summary across hosts: each host’s version, protocol range, compatibility with ' +
      'this Hub, and the semver drift verdict from hostVersionStatus against the Hub’s configured latestRelease.',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      const { hosts: rawHosts, errors } = await fanOutRead(deps, ctx, args.hosts, async (row, target) => {
        const info = await deps.client.call(target, 'get_host_info', {}, {
          depth: ctx.depth,
          signal: ctx.signal,
          timeoutMs: FAN_OUT_TIMEOUT_MS,
        });
        const hostObj = (info.host ?? {}) as { version?: unknown; protocol?: unknown };
        const health = deps.registry.healthFor(row.id);
        const version =
          typeof hostObj.version === 'string' && hostObj.version.length > 0
            ? hostObj.version
            : health.version;
        const rawRange = (hostObj.protocol ?? health.protocol) as ProtocolRange | null | undefined;
        const protocolRange: ProtocolRange | null =
          rawRange && typeof rawRange.min === 'number' && typeof rawRange.max === 'number'
            ? { min: rawRange.min, max: rawRange.max }
            : null;
        const verdict = negotiateProtocol(PROTOCOL_VERSION, protocolRange);
        return {
          version,
          protocol: protocolRange,
          verdict,
          protocolCompatible: verdict.compatible,
          protocolProblem: describeIncompatibility(row.label, verdict),
          mcpProtocol: info.protocol ?? null,
        };
      });
      const latestRelease =
        deps.latestRelease ?? latestKnownVersion(rawHosts.map((h) => h.version as string | null));
      const hosts = rawHosts.map(({ verdict, ...rest }) => {
        const drift = detectVersionDrift(rest.version as string | null, latestRelease);
        return {
          ...rest,
          drift,
          versionStatus: hostVersionStatus(verdict, drift),
          driftMessage: describeVersionDrift(rest.label, drift),
        };
      });
      return {
        latestRelease,
        hosts,
        errors,
      };
    },
  },
  {
    name: 'fleet_drain_state',
    title: 'Fleet drain state (who is mid-turn)',
    description:
      'Read-only drain state across hosts (GET /api/admin/drain-state per host): whether each host has any coding ' +
      'session or Pocket Agent chat currently mid-turn or waiting on an approval, plus deep links to any blockers.',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      const { hosts, errors } = await fanOutRead(deps, ctx, args.hosts, async (row, target) => {
        const state = await deps.client.call(target, 'get_drain_state', {}, {
          depth: ctx.depth,
          signal: ctx.signal,
          timeoutMs: FAN_OUT_TIMEOUT_MS,
        });
        const rawBlockers = Array.isArray(state.blockers) ? (state.blockers as Record<string, unknown>[]) : [];
        const blockers = rawBlockers.map((b) => {
          const kind = typeof b.kind === 'string' ? b.kind : 'session';
          const id = typeof b.id === 'string' ? b.id : '';
          const title = typeof b.title === 'string' && b.title.length > 0 ? fenceHostText(row.id, b.title) : id;
          return {
            ...b,
            title,
            deepLink:
              kind === 'session' && id
                ? deepLinkSession(row.id, id)
                : (kind === 'planner_chat' || kind === 'planner') && id
                  ? deepLinkChat(row.id, id)
                  : `/#/h/${encodeURIComponent(row.id)}/`,
          };
        });
        return {
          restartSupported: Boolean(state.restartSupported),
          drained: blockers.length === 0,
          blockers,
          hubDeepLink: '/#/hub',
        };
      });
      return {
        hosts,
        errors,
        hubDeepLink: '/#/hub',
        notice: FENCE_NOTICE,
      };
    },
  },
  {
    name: 'fleet_agent_status',
    title: 'Fleet coding-agent status',
    description:
      'Read-only coding-agent status across hosts: catalog agents with their setupState, officialInstall state, ' +
      'otherCopies on PATH, and the update-available hint (hasUpdate, installedVersion, latestVersion).',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      const { hosts, errors } = await fanOutRead(deps, ctx, args.hosts, async (_row, target) => {
        const res = await deps.client.call(target, 'list_agents', {}, {
          depth: ctx.depth,
          signal: ctx.signal,
          timeoutMs: FAN_OUT_TIMEOUT_MS,
        });
        const list = Array.isArray(res.agents) ? (res.agents as Record<string, unknown>[]) : [];
        return {
          agents: list.map((a) => ({
            id: a.id,
            displayName: a.displayName,
            available: a.available,
            setupState: a.setupState,
            structured: a.structured,
            installedVersion: a.installedVersion ?? null,
            latestVersion: a.latestVersion ?? null,
            hasUpdate: a.hasUpdate ?? false,
            resolvedPath: a.resolvedPath ?? null,
            officialInstall: a.officialInstall ?? null,
            otherCopies: Array.isArray(a.otherCopies) ? a.otherCopies : [],
          })),
          hubDeepLink: '/#/hub',
        };
      });
      return {
        hosts,
        errors,
        hubDeepLink: '/#/hub',
      };
    },
  },
  {
    name: 'fleet_health',
    title: 'Fleet reachability, push relay, and credential state',
    description:
      'Read-only health summary across hosts: live reachability, Web Push notification relay status, and Hub / MCP ' +
      'credential state per host.',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      const { rows, initialErrors } = selectRows(deps, args.hosts);
      const pushStatuses = deps.pushRelay?.getStatus() ?? {};
      const hosts: Record<string, unknown>[] = [];
      const errors: { host: string; label: string; error: string }[] = [...initialErrors];
      await Promise.all(
        rows.map(async (row) => {
          const health = deps.registry.healthFor(row.id);
          const bound = deps.registry.credentialFor(row) !== null;
          const hubBindState = row.credential_enc === null ? 'unbound' : bound ? 'ok' : 'unreadable';
          const dispatchTokenState = deps.registry.mcpTokenState(row);
          const adminTokenState = deps.registry.mcpAdminTokenState(row);
          const pushRelay = pushStatuses[row.id] ?? { ok: false, status: 'disconnected' };
          let reachable = false;
          let probeError: string | null = null;
          try {
            const target = await targetFor(deps, row.id);
            await withTimeout(
              deps.client.call(target, 'get_host_info', {}, {
                depth: ctx.depth,
                signal: ctx.signal,
                timeoutMs: FAN_OUT_TIMEOUT_MS,
              }),
              FAN_OUT_TIMEOUT_MS,
              row.label,
            );
            reachable = true;
          } catch (err) {
            probeError = errorText(err);
            errors.push({ host: row.id, label: row.label, error: probeError });
          }
          const credentialState = {
            bound,
            hubBind: hubBindState,
            dispatchToken: dispatchTokenState,
            adminToken: adminTokenState,
          };
          hosts.push({
            host: row.id,
            label: row.label,
            reachable,
            pollerOnline: health.lastCheckedAt === null ? null : health.online,
            lastCheckedAt: health.lastCheckedAt,
            pushRelay,
            credentialState,
            credentials: credentialState,
            ...(probeError ? { error: probeError } : {}),
          });
        }),
      );
      hosts.sort((a, b) => String(a.host).localeCompare(String(b.host)));
      errors.sort((a, b) => a.host.localeCompare(b.host));
      return { hosts, errors };
    },
  },
  {
    name: 'fleet_attention',
    title: 'Fleet items needing human attention',
    description:
      'Read-only attention view across hosts: pending approvals, failed or throttled webhook deliveries, stalled ' +
      'working-tree queues, and failed scheduled-job runs, each with a deep link on this Hub.',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      const items: Record<string, unknown>[] = [];
      const { hosts, errors } = await fanOutRead(deps, ctx, args.hosts, async (row, target) => {
        const snap = await deps.client.call(target, 'get_attention_snapshot', {}, {
          depth: ctx.depth,
          signal: ctx.signal,
          timeoutMs: FAN_OUT_TIMEOUT_MS,
        });
        const pendingApprovals = ((snap.pendingApprovals as Record<string, unknown>[] | undefined) ?? []).map((item) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId : null;
          const chatId = typeof item.chatId === 'string' ? item.chatId : null;
          const deepLink = sessionId
            ? deepLinkSession(row.id, sessionId)
            : chatId
              ? deepLinkChat(row.id, chatId)
              : `/#/h/${encodeURIComponent(row.id)}/`;
          const entry = {
            category: 'pending_approval',
            host: row.id,
            ...(fenceApproval(row.id, item) as Record<string, unknown>),
            deepLink,
          };
          items.push(entry);
          return entry;
        });

        const webhookDeliveries = ((snap.webhookDeliveries as Record<string, unknown>[] | undefined) ?? []).map((item) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId : null;
          const chatId = typeof item.plannerChatId === 'string' ? item.plannerChatId : null;
          const webhookId = typeof item.webhookId === 'string' ? item.webhookId : null;
          const deepLink = sessionId
            ? deepLinkSession(row.id, sessionId)
            : chatId
              ? deepLinkChat(row.id, chatId)
              : webhookId
                ? `/#/h/${encodeURIComponent(row.id)}/webhooks/${encodeURIComponent(webhookId)}`
                : `/#/h/${encodeURIComponent(row.id)}/`;
          const entry = {
            category: 'webhook_delivery',
            host: row.id,
            id: item.id,
            webhookId,
            webhookName: typeof item.webhookName === 'string' ? fenceHostText(row.id, item.webhookName) : null,
            status: item.status,
            issueKey: item.issueKey ?? null,
            reason: typeof item.reason === 'string' ? fenceHostText(row.id, item.reason) : null,
            receivedAt: item.receivedAt ?? null,
            deepLink,
          };
          items.push(entry);
          return entry;
        });

        const stalledQueues = ((snap.queued as Record<string, unknown>[] | undefined) ?? []).map((item) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId : null;
          const webhookId = typeof item.webhookId === 'string' ? item.webhookId : null;
          const deepLink = sessionId
            ? deepLinkSession(row.id, sessionId)
            : webhookId
              ? `/#/h/${encodeURIComponent(row.id)}/webhooks/${encodeURIComponent(webhookId)}`
              : `/#/h/${encodeURIComponent(row.id)}/`;
          const entry = {
            category: 'stalled_queue',
            host: row.id,
            id: item.id,
            kind: item.kind,
            tree: item.tree ?? null,
            title: typeof item.title === 'string' ? fenceHostText(row.id, item.title) : null,
            position: item.position ?? null,
            queuedAt: item.queuedAt ?? null,
            deepLink,
          };
          items.push(entry);
          return entry;
        });

        const failedCronRuns = ((snap.failedCronRuns as Record<string, unknown>[] | undefined) ?? []).map((item) => {
          const sessionId = typeof item.sessionId === 'string' ? item.sessionId : null;
          const jobId = typeof item.jobId === 'string' ? item.jobId : null;
          const deepLink = sessionId
            ? deepLinkSession(row.id, sessionId)
            : jobId
              ? `/#/h/${encodeURIComponent(row.id)}/cron/${encodeURIComponent(jobId)}`
              : `/#/h/${encodeURIComponent(row.id)}/`;
          const entry = {
            category: 'failed_cron_run',
            host: row.id,
            id: item.id,
            jobId,
            jobName: typeof item.jobName === 'string' ? fenceHostText(row.id, item.jobName) : null,
            status: item.status,
            error: typeof item.error === 'string' ? fenceHostText(row.id, item.error) : null,
            startedAt: item.startedAt ?? null,
            finishedAt: item.finishedAt ?? null,
            deepLink,
          };
          items.push(entry);
          return entry;
        });

        return {
          pendingApprovals,
          webhookDeliveries,
          stalledQueues,
          failedCronRuns,
        };
      });
      items.sort((a, b) => String(a.host).localeCompare(String(b.host)));
      return {
        hosts,
        items,
        errors,
        notice: FENCE_NOTICE,
      };
    },
  },
  {
    name: 'fleet_usage',
    title: 'Fleet rate-limit and usage windows',
    description:
      'Read-only provider usage and rate-limit windows across hosts, to decide which host has headroom for new work.',
    inputSchema: optionalHostsSchema,
    readOnly: true,
    async handler(deps, ctx, args) {
      return fanOutRead(deps, ctx, args.hosts, async (_row, target) => {
        const res = await deps.client.call(target, 'get_usage', {}, {
          depth: ctx.depth,
          signal: ctx.signal,
          timeoutMs: FAN_OUT_TIMEOUT_MS,
        });
        return { usage: Array.isArray(res.usage) ? res.usage : [] };
      });
    },
  },

  // ---- Tier 2: gated, audited config changes (PA-135) -----------------------
  {
    name: 'update_webhook',
    title: 'Update an inbound webhook on a host',
    description:
      'Modify or enable/disable an existing inbound webhook on a host (PATCH /api/webhooks/:id) using the host’s ' +
      'admin-scoped token. Requires coordinator approval per host.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        id: { type: 'string', minLength: 1, maxLength: 200, description: 'Webhook id on that host.' },
        enabled: { type: 'boolean', description: 'Optional shorthand to enable or disable the webhook.' },
        patch: {
          type: 'object',
          description:
            'Partial webhook fields (such as enabled, name, slug, config, cwd, agent, model, effort, promptTemplate, conversationMode, overlapPolicy, directoryPolicy, or maxConcurrent).',
          additionalProperties: true,
        },
      },
      required: ['host', 'id'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const rawPatch =
        args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
          ? { ...(args.patch as Record<string, unknown>) }
          : {};
      if (typeof args.enabled === 'boolean') {
        rawPatch.enabled = args.enabled;
      }
      rejectForbiddenPatchKeys(rawPatch, 'update_webhook');
      if (Object.keys(rawPatch).length === 0) {
        throw new Error('Provide at least one field in patch (or enabled) to update the webhook.');
      }
      const target = await adminTargetFor(deps, args.host);
      const webhook = await deps.client.call(
        target,
        'update_webhook',
        { id: String(args.id), patch: rawPatch },
        { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
      );
      return { host: target.hostId, webhook };
    },
  },
  {
    name: 'update_cron_job',
    title: 'Update a scheduled job on a host',
    description:
      'Modify or enable/disable an existing scheduled job on a host (PATCH /api/cron/jobs/:id) using the host’s ' +
      'admin-scoped token. Requires coordinator approval per host.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        id: { type: 'string', minLength: 1, maxLength: 200, description: 'Scheduled job id on that host.' },
        enabled: { type: 'boolean', description: 'Optional shorthand to enable or disable the scheduled job.' },
        patch: {
          type: 'object',
          description:
            'Partial scheduled-job fields (such as enabled, name, preset, cronExpr, timeZone, cwd, agent, worktreeMode, model, effort, prompt, overlapPolicy, or retentionDays).',
          additionalProperties: true,
        },
      },
      required: ['host', 'id'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const rawPatch =
        args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
          ? { ...(args.patch as Record<string, unknown>) }
          : {};
      if (typeof args.enabled === 'boolean') {
        rawPatch.enabled = args.enabled;
      }
      rejectForbiddenPatchKeys(rawPatch, 'update_cron_job');
      if (Object.keys(rawPatch).length === 0) {
        throw new Error('Provide at least one field in patch (or enabled) to update the scheduled job.');
      }
      const target = await adminTargetFor(deps, args.host);
      const job = await deps.client.call(
        target,
        'update_cron_job',
        { id: String(args.id), patch: rawPatch },
        { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
      );
      return { host: target.hostId, job };
    },
  },
  {
    name: 'update_custom_claude_provider',
    title: 'Update a custom Claude provider on a host',
    description:
      'Modify an existing custom Claude provider on a host (PATCH /api/custom-claude-providers/:id) using the ' +
      'host’s admin-scoped token. Requires coordinator approval per host.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        id: { type: 'string', minLength: 1, maxLength: 200, description: 'Provider id on that host.' },
        patch: {
          type: 'object',
          description: 'Partial provider fields (name, providerKind, baseUrl, models, defaultModel, smallModel, allowUnattended).',
          additionalProperties: true,
        },
      },
      required: ['host', 'id', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const rawPatch =
        args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
          ? (args.patch as Record<string, unknown>)
          : {};
      rejectForbiddenPatchKeys(rawPatch, 'update_custom_claude_provider');
      const target = await adminTargetFor(deps, args.host);
      const provider = await deps.client.call(
        target,
        'update_custom_claude_provider',
        { id: String(args.id), patch: rawPatch },
        { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
      );
      return { host: target.hostId, provider };
    },
  },
  {
    name: 'update_planner_settings',
    title: 'Update Pocket Agent planner settings on a host',
    description:
      'Modify Pocket Agent planner settings on a host (PATCH /api/planner/settings) using the host’s admin-scoped ' +
      'token. Requires coordinator approval per host.',
    inputSchema: {
      type: 'object',
      properties: {
        host: hostArg,
        patch: {
          type: 'object',
          description:
            'Partial planner settings fields (baseUrl, embeddingBaseUrl, embeddingModelId, webSearchEnabled, urlFetchEnabled, mcpEnabled, meInstruction, toolsInstruction, or compaction settings).',
          additionalProperties: true,
        },
      },
      required: ['host', 'patch'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOST,
    targetOf: (args) => (typeof args.host === 'string' ? args.host : null),
    async handler(deps, ctx, args) {
      const rawPatch =
        args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)
          ? (args.patch as Record<string, unknown>)
          : {};
      rejectForbiddenPatchKeys(rawPatch, 'update_planner_settings');
      const target = await adminTargetFor(deps, args.host);
      const settings = await deps.client.call(
        target,
        'update_planner_settings',
        { patch: rawPatch },
        { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
      );
      return { host: target.hostId, settings };
    },
  },
  {
    name: 'provision_template',
    title: 'Provision a Hub template onto hosts',
    description:
      'Provision a Hub configuration template onto one or more hosts using the PA-70 provisioner and each host’s ' +
      'admin-scoped token. Requires coordinator approval per host.',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', minLength: 1, maxLength: 200, description: 'Template id on this Hub.' },
        hosts: {
          type: 'array',
          items: hostArg,
          minItems: 1,
          maxItems: 50,
          description: 'Host ids to provision the template onto.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to replace an existing resource previously provisioned from this template. Default false.',
        },
      },
      required: ['templateId', 'hosts'],
      additionalProperties: false,
    },
    readOnly: false,
    meta: SCOPED_BY_HOSTS,
    targetOf: (args) => (Array.isArray(args.hosts) ? args.hosts.map(String).join(',') : null),
    async handler(deps, ctx, args) {
      if (!deps.templates) {
        throw new Error('Template store is not available on this Hub.');
      }
      const templateId = String(args.templateId ?? '').trim();
      if (!templateId) throw new Error('Name a templateId.');
      if (isSystemTemplateId(templateId)) {
        throw new Error(`Template "${templateId}" is a Hub system template and cannot be provisioned directly.`);
      }
      const template = deps.templates.resolve(templateId);
      if (!template) throw new Error(`No template "${templateId}" on this Hub.`);
      const requiredHoles = secretHolesFor(template.spec).filter((h) => h.required);
      if (requiredHoles.length > 0) {
        throw new Error(
          `Refusing: template "${template.row.name}" requires secret fields (${requiredHoles.map((h) => h.key).join(', ')}), which cannot be set or provisioned through an agent tool. Provision it from the Hub page (#/hub) instead.`,
        );
      }
      const rawHosts = Array.isArray(args.hosts) ? args.hosts.map((h) => String(h).trim()).filter(Boolean) : [];
      if (rawHosts.length === 0) throw new Error('Name at least one host in hosts.');
      const overwrite = args.overwrite === true;

      const byBaseUrl = new Map<string, HubHostRow>();
      for (const hostId of rawHosts) {
        const row = deps.registry.getRow(hostId);
        if (row) {
          byBaseUrl.set(row.base_url.replace(/\/$/, ''), row);
        }
      }

      const mcpAdminFetch: typeof fetch = async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        let matchedRow: HubHostRow | null = null;
        let reqPath = '/';
        for (const [base, row] of byBaseUrl.entries()) {
          if (urlStr === base || urlStr.startsWith(`${base}/`)) {
            matchedRow = row;
            reqPath = urlStr.slice(base.length) || '/';
            break;
          }
        }
        if (!matchedRow) {
          throw new Error(`No host matched URL ${urlStr}`);
        }
        const adminTarget = await adminTargetFor(deps, matchedRow.id);
        const method = (init?.method ?? 'GET').toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'DELETE';
        let parsedBody: Record<string, unknown> | undefined;
        if (typeof init?.body === 'string' && init.body.length > 0) {
          parsedBody = JSON.parse(init.body) as Record<string, unknown>;
        }
        const res = await deps.client.call(
          adminTarget,
          'provision_request',
          {
            method,
            path: reqPath,
            ...(parsedBody !== undefined ? { body: parsedBody } : {}),
          },
          { depth: ctx.depth, signal: ctx.signal, timeoutMs: 20_000 },
        );
        const status = typeof res.status === 'number' ? res.status : 200;
        const bodyText = res.body !== undefined && res.body !== null ? JSON.stringify(res.body) : '';
        return new Response(status === 204 ? null : bodyText, {
          status,
          headers: status === 204 ? {} : { 'content-type': 'application/json' },
        });
      };

      const noopLog = {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        fatal: () => undefined,
        trace: () => undefined,
        silent: () => undefined,
        child: () => noopLog,
        level: 'info',
      } as unknown as FastifyBaseLogger;

      const adminProvisioner = new Provisioner({
        registry: deps.registry,
        store: deps.templates,
        fetchImpl: mcpAdminFetch,
        log: deps.log ?? noopLog,
      });

      const results = await adminProvisioner.instantiate({
        template,
        hostIds: rawHosts,
        secrets: {},
        overwrite,
      });
      return {
        templateId: template.row.id,
        templateName: template.row.name,
        results,
      };
    },
  },
];
