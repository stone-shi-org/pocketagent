import crypto from 'node:crypto';
import path from 'node:path';
import type { SessionInfo, SessionStatus, SessionTransport } from '@pocketagent/protocol';
import type { Db, SessionRow } from '../db/index.js';
import {
  GLOBAL_SKIP_PERMISSIONS_KEY,
  markStaleSessionsInterrupted,
  pruneOldSessions,
  readSetting,
  writeSetting,
} from '../db/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import { resolveExecutable } from '../agents/registry.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { ProcessBackend } from '../backends/index.js';
import { PtySession } from './pty-session.js';
import { StructuredSession } from './structured-session.js';
import { AgySession } from './agy-session.js';
import { OpencodeSession } from './opencode-session.js';
import { OpencodeServerManager } from './opencode-server.js';
import { CodexSession } from './codex-session.js';
import { CodexServerManager } from './codex-server.js';
import { PiSession } from './pi-session.js';
import { buildChildEnv } from './env.js';

/**
 * Any engine behind the `structured` transport. `StructuredSession` holds the
 * Claude Agent SDK's query open for the session's whole life; `AgySession`
 * spawns the `agy` CLI fresh per turn; `OpencodeSession` and `CodexSession`
 * each talk to a shared daemon (HTTP + SSE for opencode, JSON-RPC over stdio
 * for codex); `PiSession` owns one persistent `pi --mode rpc` process per
 * session, no daemon to share. All five normalize into the same `AgentEvent`
 * union and expose the same approval-adjacent surface (empty for `AgySession`
 * and `PiSession` — see their own docs), so everything below that only
 * checks `transport === 'structured'` can treat them interchangeably.
 */
export type StructuredLikeSession = StructuredSession | AgySession | OpencodeSession | CodexSession | PiSession;

/**
 * Either flavour of session. They share the metadata surface the manager,
 * routes, and persistence need; the WebSocket layer narrows on `transport`
 * for the operations that only make sense for one of them.
 */
export type ManagedSession = PtySession | StructuredLikeSession;

export class SessionError extends Error {
  override readonly name = 'SessionError';
  constructor(
    message: string,
    readonly code:
      | 'unknown_agent'
      | 'agent_unavailable'
      | 'too_many_sessions'
      | 'not_found'
      | 'not_running'
      | 'session_running'
      | 'spawn_failed'
      | 'unsupported_transport',
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface CreateSessionInput {
  agent: string;
  /** Must already be canonicalized and workspace-validated. */
  cwd: string;
  cols: number;
  rows: number;
  title?: string;
  /** Defaults to the adapter's preferred transport. */
  transport?: SessionTransport;
  /** Resume a prior agent conversation (structured transport only). */
  resumeAgentSessionId?: string;
  /** Branch rather than append when resuming. Defaults to true. */
  forkSession?: boolean;
  /**
   * Explicit, off-by-default opt-in to run this session with approvals
   * bypassed. Only has any effect on an adapter that reports
   * `supportsSkipPermissions`; every other adapter ignores it.
   */
  skipPermissions?: boolean;
  /** Attach to an already-running tmux pane instead of starting a process. */
  adopt?: {
    command: string;
    args: string[];
    /** Attach at the pane's current size so the other client is not resized. */
    cols: number;
    rows: number;
    label: string;
  };
}

export interface ManagerOptions {
  db: Db;
  agents: AgentRegistry;
  workspaces: WorkspaceRegistry;
  backend: ProcessBackend;
  /**
   * Always-available direct backend. Adopted sessions use this regardless of
   * the configured backend, because the process we own is a tmux client that
   * must die with us rather than outlive us.
   */
  directBackend: ProcessBackend;
  maxSessions: number;
  outputBufferBytes: number;
  idleTimeoutSeconds: number;
  /** Optional per-session spend ceiling for structured agents. */
  maxBudgetUsd?: number;
  /** Delivers approval notifications. Optional so tests can omit it. */
  push?: { isEnabled(): boolean; send(p: { title: string; body: string; url: string; tag?: string }): Promise<unknown> };
  /** Rows of finished sessions kept in the history table. */
  historyLimit?: number;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  /** Boot-time seed for the global skip-permissions switch; the database wins after that. */
  globalSkipPermissionsDefault?: boolean;
  /**
   * Looks up Claude Code's own generated title for one conversation. Optional
   * so tests can omit it — without it, a structured session simply keeps its
   * fixed creation-time title forever, which is the pre-existing behaviour.
   */
  titleFor?: (cwd: string, agentSessionId: string) => Promise<string | null>;
}

const SWEEP_INTERVAL_MS = 15_000;

/**
 * Owns every PTY on the box.
 *
 * The lifecycle is deliberately decoupled from any WebSocket: `attach`/`detach`
 * only move a reference count. Closing a browser tab, losing signal on a train,
 * or force-quitting Safari has no effect on the running process.
 */
export class SessionManager {
  private readonly live = new Map<string, ManagedSession>();
  private readonly attachCounts = new Map<string, number>();
  private sweepTimer: NodeJS.Timeout | null = null;
  /**
   * The operator's server-wide "skip all approvals" switch. See CLAUDE.md —
   * this is a deliberate override of the per-session, off-by-default
   * `skipPermissions` invariant, not a config knob like any other.
   */
  private globalSkipPermissions: boolean;
  /**
   * Lazily started on the first opencode session and shared by every one
   * after that — see `OpencodeServerManager`'s own docs for why one process
   * serves every directory rather than one per chat.
   */
  private opencodeServer: OpencodeServerManager | null = null;
  /** Same idea as `opencodeServer`, for `codex app-server` — see `CodexServerManager`. */
  private codexServer: CodexServerManager | null = null;

  constructor(private readonly opts: ManagerOptions) {
    const stored = readSetting(opts.db, GLOBAL_SKIP_PERMISSIONS_KEY);
    if (stored === null) {
      // First boot: seed from configuration, same as `workspaces` does, so a
      // later restart with a *different* env var does not fight whatever gets
      // toggled at runtime from here on.
      this.globalSkipPermissions = opts.globalSkipPermissionsDefault === true;
      writeSetting(
        opts.db,
        GLOBAL_SKIP_PERMISSIONS_KEY,
        this.globalSkipPermissions ? '1' : '0',
      );
    } else {
      this.globalSkipPermissions = stored === '1';
    }
  }

  getGlobalSkipPermissions(): boolean {
    return this.globalSkipPermissions;
  }

  /**
   * Flip the global "skip all approvals" switch.
   *
   * Persists immediately so a restart does not revert it, and reaches into
   * every currently live *structured* session so the effect is immediate
   * rather than "starting with the next session". Terminal/PTY sessions
   * already running are left alone: `--dangerously-skip-permissions` is baked
   * into argv at spawn, there is no way to change it for a running process
   * short of killing it, and `terminal/classifier.ts` must never grow an
   * answerable approval channel to fake one. New sessions of either transport
   * pick up the switch automatically via the gate in `create()` below.
   */
  async setGlobalSkipPermissions(enabled: boolean): Promise<void> {
    this.globalSkipPermissions = enabled;
    writeSetting(this.opts.db, GLOBAL_SKIP_PERMISSIONS_KEY, enabled ? '1' : '0');
    this.opts.logger?.[enabled ? 'warn' : 'info'](
      { enabled },
      'global skip-permissions switch changed',
    );
    await Promise.all(
      [...this.live.values()]
        .filter((s): s is StructuredLikeSession => s.transport === 'structured')
        .map((s) => s.applyGlobalSkipPermissions(enabled)),
    );
  }

  /**
   * Reconcile the database with reality.
   *
   * With the direct backend that is simple: nothing survived, so everything
   * still marked running becomes `interrupted`. With a durable backend we first
   * try to re-adopt the processes that are genuinely still there, and only mark
   * the rest interrupted.
   */
  async init(): Promise<{ interrupted: number; recovered: number }> {
    const recovered = await this.recoverSessions();
    // Anything not re-adopted above is genuinely gone.
    const interrupted = markStaleSessionsInterrupted(this.opts.db, [...this.live.keys()]);
    pruneOldSessions(this.opts.db, this.opts.historyLimit ?? 200);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    return { interrupted, recovered };
  }

  /**
   * Re-adopt processes left running by a previous server.
   *
   * Each recovered session gets a fresh epoch, because its output buffer starts
   * empty: any client still holding a sequence number from the old stream must
   * resynchronise rather than resume.
   */
  private async recoverSessions(): Promise<number> {
    const backend = this.opts.backend;
    if (!backend.survivesServerRestart || !backend.recover || !backend.listRecoverable) return 0;

    const available = await backend.listRecoverable();
    if (available.length === 0) return 0;
    const availableSet = new Set(available);

    const rows = this.opts.db
      .prepare(
        `SELECT * FROM sessions
          WHERE status IN ('starting', 'running')
            AND backend = ?
            AND external_id IS NOT NULL`,
      )
      .all(backend.id) as SessionRow[];

    let recovered = 0;
    for (const row of rows) {
      if (!row.external_id || !availableSet.has(row.external_id)) continue;

      const session = new PtySession(
        {
          id: row.id,
          title: row.title,
          agent: row.agent,
          agentDisplayName: this.opts.agents.get(row.agent)?.displayName ?? row.agent,
          command: row.command,
          args: safeParseArgs(row.args_json),
          cwd: row.cwd,
          env: {},
          envOverrideKeys: [],
          cols: row.cols,
          rows: row.rows,
          workspaceLabel: this.opts.workspaces.labelFor(row.cwd),
          outputBufferBytes: this.opts.outputBufferBytes,
          createdAt: row.created_at,
          skipPermissions: row.skip_permissions === 1,
        },
        backend,
      );

      let handle;
      try {
        handle = await backend.recover(row.external_id, {
          sessionId: row.id,
          command: row.command,
          args: safeParseArgs(row.args_json),
          cwd: row.cwd,
          env: {},
          cols: row.cols,
          rows: row.rows,
        });
      } catch (err) {
        this.opts.logger?.warn({ sessionId: row.id, err }, 'failed to recover session');
        continue;
      }
      if (!handle) continue;

      session.adopt(handle, row.started_at ?? row.created_at);
      this.wire(session);
      this.live.set(row.id, session);
      this.persist(session);
      recovered++;
    }

    if (recovered > 0) {
      this.opts.logger?.info({ recovered, backend: backend.id }, 'recovered running sessions');
    }
    return recovered;
  }

  /**
   * Grace period before an unanswered approval turns into a push.
   *
   * A phone that is awake and looking at the session should answer from the
   * sheet, not get buzzed. Zero delay when nothing is attached at all.
   */
  private static readonly APPROVAL_NOTIFY_DELAY_MS = 15_000;

  private readonly approvalTimers = new Map<string, NodeJS.Timeout>();

  /** Attach the manager's own listeners to a session. */
  private wire(session: ManagedSession): void {
    session.on('status', () => this.persist(session));
    session.on('exit', () => {
      this.persist(session);
      // Keep the object (and its output buffer) around so the user can read the
      // final screen after the process dies. The sweep evicts it later.
      this.opts.logger?.info(
        { sessionId: session.id, exitCode: session.exitCode, signal: session.exitSignal },
        'session exited',
      );
      this.clearApprovalTimer(session.id);
    });

    if (session.transport === 'structured') {
      session.on('permission', (pending) => this.onPermissionChange(session.id, pending.length));
    }
  }

  /**
   * Notify when an approval is left hanging.
   *
   * The payload deliberately says only that a decision is needed — the push
   * relay is a third party, so the tool, the file, and the diff stay on the
   * device where the user can read them behind authentication.
   */
  private onPermissionChange(sessionId: string, pendingCount: number): void {
    this.clearApprovalTimer(sessionId);
    if (pendingCount === 0) return;

    const push = this.opts.push;
    if (!push?.isEnabled()) return;

    const fire = (): void => {
      this.approvalTimers.delete(sessionId);
      const session = this.live.get(sessionId);
      if (!session || session.transport !== 'structured') return;
      if (session.pendingPermissions().length === 0) return;

      void push
        .send({
          title: 'PocketAgent — approval needed',
          body: `${session.spec.title} is waiting for your decision.`,
          url: `/#/s/${encodeURIComponent(sessionId)}`,
          tag: `approval-${sessionId}`,
        })
        .catch(() => undefined);
    };

    if (this.attachedCount(sessionId) === 0) {
      fire();
      return;
    }
    const timer = setTimeout(fire, SessionManager.APPROVAL_NOTIFY_DELAY_MS);
    timer.unref?.();
    this.approvalTimers.set(sessionId, timer);
  }

  private clearApprovalTimer(sessionId: string): void {
    const timer = this.approvalTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.approvalTimers.delete(sessionId);
  }

  async create(input: CreateSessionInput): Promise<ManagedSession> {
    const adapter = this.opts.agents.get(input.agent);
    if (!adapter) {
      throw new SessionError(`Unknown agent: ${input.agent}`, 'unknown_agent', 400);
    }

    const transport = input.transport ?? adapter.defaultTransport;
    if (!adapter.transports.includes(transport)) {
      throw new SessionError(
        `${adapter.displayName} cannot be driven over the "${transport}" transport ` +
          `(supported: ${adapter.transports.join(', ')}).`,
        'unsupported_transport',
        400,
      );
    }

    // Only honour the opt-in on an adapter that actually declares support for
    // it; anything else silently ignores it rather than erroring, since the
    // client is expected to gate the control on `supportsSkipPermissions` too.
    // The global switch ORs in here rather than being applied after the fact,
    // so a session created while it is on is honest about it from birth —
    // `spec.skipPermissions` (and therefore what gets persisted and shown)
    // reflects reality instead of needing a second source of truth.
    //
    // `forcesSkipPermissions` overrides all of that unconditionally: an
    // adapter that sets it (only `agy`, so far — see `agents/agy.ts`) has no
    // synchronous approval channel at all in its structured mode, so there is
    // no "off" state to honour an opt-out into. This is the one case where
    // `skipPermissions` is not actually a choice made per session.
    const skipPermissions =
      adapter.forcesSkipPermissions === true ||
      ((input.skipPermissions === true || this.globalSkipPermissions) &&
        adapter.supportsSkipPermissions === true);

    // Adoption replaces the adapter's argv with an attach command the server
    // built from a validated target. The browser never supplies argv.
    const built = input.adopt
      ? { command: input.adopt.command, args: input.adopt.args, env: undefined }
      : adapter.buildCommand({ cwd: input.cwd, cols: input.cols, rows: input.rows, skipPermissions });
    const executable = resolveExecutable(built.command);

    if (executable === null) {
      throw new SessionError(
        `The "${adapter.displayName}" executable (${built.command}) was not found on PATH.`,
        'agent_unavailable',
        503,
      );
    }

    if (this.countAlive() >= this.opts.maxSessions) {
      throw new SessionError(
        `Session limit reached (${this.opts.maxSessions}). Terminate a session first.`,
        'too_many_sessions',
        429,
      );
    }

    const id = crypto.randomBytes(9).toString('base64url');
    const workspaceLabel = this.opts.workspaces.labelFor(input.cwd);
    const title =
      input.title?.trim() ||
      input.adopt?.label ||
      `${adapter.displayName} · ${path.basename(input.cwd)}`;
    const createdAt = Date.now();

    if (input.adopt) {
      // Attaching to someone else's session is a terminal operation by nature.
      if (transport !== 'terminal') {
        throw new SessionError(
          'An existing tmux pane can only be adopted over the terminal transport.',
          'unsupported_transport',
          400,
        );
      }
    }

    if (transport === 'structured') {
      const env = buildChildEnv({ cwd: input.cwd, overrides: built.env });

      if (adapter.structuredKind === 'agy-cli') {
        return this.startAgy({
          id,
          title,
          adapter,
          cwd: input.cwd,
          workspaceLabel,
          createdAt,
          executable,
          env,
          ...(input.resumeAgentSessionId
            ? { resumeAgentSessionId: input.resumeAgentSessionId }
            : {}),
        });
      }

      if (adapter.structuredKind === 'opencode-server') {
        return this.startOpencode({
          id,
          title,
          adapter,
          cwd: input.cwd,
          workspaceLabel,
          createdAt,
          executable,
          env,
          ...(input.resumeAgentSessionId
            ? { resumeAgentSessionId: input.resumeAgentSessionId }
            : {}),
          skipPermissions,
        });
      }

      if (adapter.structuredKind === 'codex-app-server') {
        return this.startCodex({
          id,
          title,
          adapter,
          cwd: input.cwd,
          workspaceLabel,
          createdAt,
          executable,
          env,
          ...(input.resumeAgentSessionId
            ? { resumeAgentSessionId: input.resumeAgentSessionId }
            : {}),
          skipPermissions,
        });
      }

      if (adapter.structuredKind === 'pi-rpc') {
        return this.startPi({
          id,
          title,
          adapter,
          cwd: input.cwd,
          workspaceLabel,
          createdAt,
          executable,
          env,
          ...(input.resumeAgentSessionId
            ? { resumeAgentSessionId: input.resumeAgentSessionId }
            : {}),
        });
      }

      return this.startStructured({
        id,
        title,
        adapter,
        cwd: input.cwd,
        workspaceLabel,
        createdAt,
        executable,
        env,
        ...(input.resumeAgentSessionId
          ? { resumeAgentSessionId: input.resumeAgentSessionId }
          : {}),
        ...(input.forkSession !== undefined ? { forkSession: input.forkSession } : {}),
        skipPermissions,
      });
    }

    const session = new PtySession(
      {
        createdAt,
        id,
        title,
        agent: adapter.id,
        agentDisplayName: adapter.displayName,
        command: built.command,
        args: built.args,
        cwd: input.cwd,
        env: buildChildEnv({ cwd: input.cwd, overrides: built.env }),
        envOverrideKeys: Object.keys(built.env ?? {}),
        // An adopted pane keeps the size it already has; resizing it here
        // would shrink whatever terminal is also looking at it.
        cols: input.adopt?.cols ?? input.cols,
        rows: input.adopt?.rows ?? input.rows,
        workspaceLabel,
        outputBufferBytes: this.opts.outputBufferBytes,
        adopted: input.adopt !== undefined,
        skipPermissions,
      },
      // Adoption always runs the attach client as our own child: the thing we
      // spawn is a tmux *client*, and killing it must only detach.
      input.adopt ? this.opts.directBackend : this.opts.backend,
    );

    this.insertRow(session, createdAt);
    this.live.set(id, session);
    this.wire(session);

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(id);
      throw new SessionError(
        `Failed to start ${adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: id, agent: adapter.id, pid: session.pid, backend: this.opts.backend.id },
      'session started',
    );
    return session;
  }

  /**
   * Structured sessions bypass the process backend entirely: the Agent SDK
   * owns the child process, so there is no PTY and no tmux to adopt. What is
   * durable here is the *conversation* — the agent persists its own history,
   * so a new session can resume from `agentSessionId` after a restart.
   */
  private async startStructured(args: {
    id: string;
    title: string;
    adapter: { id: string; displayName: string };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
    skipPermissions?: boolean;
  }): Promise<StructuredSession> {
    const session = new StructuredSession({
      id: args.id,
      title: args.title,
      agent: args.adapter.id,
      agentDisplayName: args.adapter.displayName,
      cwd: args.cwd,
      env: args.env,
      workspaceLabel: args.workspaceLabel,
      eventBufferBytes: this.opts.outputBufferBytes,
      createdAt: args.createdAt,
      executablePath: args.executable,
      ...(args.resumeAgentSessionId
        ? { resumeAgentSessionId: args.resumeAgentSessionId }
        : {}),
      ...(this.opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.opts.maxBudgetUsd } : {}),
      skipPermissions: args.skipPermissions === true,
    });

    this.insertRow(session, args.createdAt);
    this.live.set(args.id, session);
    this.wire(session);
    // The agent id arrives asynchronously in the first event; persist it then
    // so a restart can offer to resume the conversation. Each completed turn
    // is also a cheap opportunity to pick up Claude Code's own generated
    // title for the conversation, once it exists.
    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started') this.persist(session);
      if (event.kind === 'turn_complete') void this.refreshDerivedTitle(session);
    });

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(args.id);
      throw new SessionError(
        `Failed to start ${args.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured' },
      'session started',
    );
    return session;
  }

  /**
   * Structured, but via `AgySession` instead of the Claude Agent SDK — see
   * that class for why it is a distinct code path rather than a flag on
   * `startStructured`. `skipPermissions` is not a parameter here: it is
   * always `true`, enforced in `create()` via `adapter.forcesSkipPermissions`
   * before this is ever called.
   */
  private async startAgy(args: {
    id: string;
    title: string;
    adapter: { id: string; displayName: string };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
  }): Promise<AgySession> {
    const session = new AgySession({
      id: args.id,
      title: args.title,
      agent: args.adapter.id,
      agentDisplayName: args.adapter.displayName,
      cwd: args.cwd,
      env: args.env,
      workspaceLabel: args.workspaceLabel,
      eventBufferBytes: this.opts.outputBufferBytes,
      createdAt: args.createdAt,
      executablePath: args.executable,
      ...(args.resumeAgentSessionId
        ? { resumeAgentSessionId: args.resumeAgentSessionId }
        : {}),
      skipPermissions: true,
    });

    this.insertRow(session, args.createdAt);
    this.live.set(args.id, session);
    this.wire(session);
    // Unlike `startStructured`, there is no derived-title lookup: agy keeps no
    // transcript store this server knows how to read, so the fixed
    // creation-time title stands for the life of the session.
    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started') this.persist(session);
    });

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(args.id);
      throw new SessionError(
        `Failed to start ${args.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured', backend: 'agy-cli' },
      'session started',
    );
    return session;
  }

  /**
   * Structured, but via `PiSession` — a persistent per-session `pi --mode
   * rpc` process, not a per-turn subprocess like `AgySession` or a shared
   * daemon like opencode/codex. `skipPermissions` is not a parameter here
   * for the same reason as `startAgy`: it is always `true`, enforced in
   * `create()` via `adapter.forcesSkipPermissions`.
   */
  private async startPi(args: {
    id: string;
    title: string;
    adapter: { id: string; displayName: string };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
  }): Promise<PiSession> {
    const session = new PiSession({
      id: args.id,
      title: args.title,
      agent: args.adapter.id,
      agentDisplayName: args.adapter.displayName,
      cwd: args.cwd,
      env: args.env,
      workspaceLabel: args.workspaceLabel,
      eventBufferBytes: this.opts.outputBufferBytes,
      createdAt: args.createdAt,
      executablePath: args.executable,
      ...(args.resumeAgentSessionId
        ? { resumeAgentSessionId: args.resumeAgentSessionId }
        : {}),
      skipPermissions: true,
    });

    this.insertRow(session, args.createdAt);
    this.live.set(args.id, session);
    this.wire(session);
    // No derived-title lookup, same reasoning as agy: pi keeps its own
    // session store, not one this server knows how to read.
    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started') this.persist(session);
    });

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(args.id);
      throw new SessionError(
        `Failed to start ${args.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured', backend: 'pi-rpc' },
      'session started',
    );
    return session;
  }

  /**
   * The one `opencode serve` process shared by every `OpencodeSession`.
   * Spawned on first use; `executable`/`env` come from whichever session
   * happens to trigger that, but every opencode session uses the same
   * adapter and therefore the same resolved binary, so this is stable.
   */
  private getOrCreateOpencodeServer(executable: string, env: Record<string, string>): OpencodeServerManager {
    if (this.opencodeServer) return this.opencodeServer;

    const server = new OpencodeServerManager({
      executablePath: executable,
      env,
      cwd: this.opts.workspaces.getRoots()[0] ?? process.cwd(),
      logger: this.opts.logger,
    });
    // A crash after startup takes every live opencode session's server-side
    // state with it — there is nothing left to reconnect to, so each one is
    // told directly rather than left to time out silently.
    server.on('crashed', () => {
      for (const session of this.live.values()) {
        if (session instanceof OpencodeSession) session.markServerCrashed();
      }
    });
    this.opencodeServer = server;
    return server;
  }

  /**
   * Structured, but via `OpencodeSession` talking to a shared
   * `opencode serve` process instead of the Claude Agent SDK or a per-turn
   * `agy` subprocess. See `OpencodeSession`/`OpencodeServerManager` for why
   * this is its own code path.
   */
  private async startOpencode(args: {
    id: string;
    title: string;
    adapter: { id: string; displayName: string };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
    skipPermissions?: boolean;
  }): Promise<OpencodeSession> {
    const server = this.getOrCreateOpencodeServer(args.executable, args.env);
    const session = new OpencodeSession(
      {
        id: args.id,
        title: args.title,
        agent: args.adapter.id,
        agentDisplayName: args.adapter.displayName,
        cwd: args.cwd,
        workspaceLabel: args.workspaceLabel,
        eventBufferBytes: this.opts.outputBufferBytes,
        createdAt: args.createdAt,
        ...(args.resumeAgentSessionId
          ? { resumeAgentSessionId: args.resumeAgentSessionId }
          : {}),
        skipPermissions: args.skipPermissions === true,
      },
      server,
    );

    this.insertRow(session, args.createdAt);
    this.live.set(args.id, session);
    this.wire(session);
    // No derived-title lookup, same reasoning as agy: opencode keeps its own
    // conversation store, not one this server knows how to read.
    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started') this.persist(session);
    });

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(args.id);
      throw new SessionError(
        `Failed to start ${args.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured', backend: 'opencode-server' },
      'session started',
    );
    return session;
  }

  /**
   * The one `codex app-server` process shared by every `CodexSession`. Same
   * reasoning as `getOrCreateOpencodeServer`.
   */
  private getOrCreateCodexServer(executable: string, env: Record<string, string>): CodexServerManager {
    if (this.codexServer) return this.codexServer;

    const server = new CodexServerManager({
      executablePath: executable,
      env,
      cwd: this.opts.workspaces.getRoots()[0] ?? process.cwd(),
    });
    server.on('crashed', () => {
      for (const session of this.live.values()) {
        if (session instanceof CodexSession) session.markServerCrashed();
      }
    });
    this.codexServer = server;
    return server;
  }

  /**
   * The same shared `codex app-server` process a real Codex session would
   * use, for reading account-level data (rate limits) that has nothing to do
   * with any one session. Started on first call, same as
   * `getOrCreateCodexServer` — a usage poll pays the one-time cost of
   * spawning the process, not a fresh one every time. Null when the `codex`
   * binary is not configured or not on PATH, mirroring `AgentInfo.available`.
   */
  getCodexServerForUsage(): CodexServerManager | null {
    const adapter = this.opts.agents.get('codex');
    if (!adapter) return null;

    const cwd = this.opts.workspaces.getRoots()[0] ?? process.cwd();
    const built = adapter.buildCommand({ cwd, cols: 80, rows: 24, skipPermissions: false });
    const executable = resolveExecutable(built.command);
    if (!executable) return null;

    const env = buildChildEnv({ cwd, overrides: built.env });
    return this.getOrCreateCodexServer(executable, env);
  }

  /**
   * Structured, but via `CodexSession` talking to a shared
   * `codex app-server` process instead of the Claude Agent SDK, a per-turn
   * `agy` subprocess, or opencode's HTTP server. See `CodexSession`/
   * `CodexServerManager` for why this is its own code path.
   */
  private async startCodex(args: {
    id: string;
    title: string;
    adapter: { id: string; displayName: string };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
    skipPermissions?: boolean;
  }): Promise<CodexSession> {
    const server = this.getOrCreateCodexServer(args.executable, args.env);
    const session = new CodexSession(
      {
        id: args.id,
        title: args.title,
        agent: args.adapter.id,
        agentDisplayName: args.adapter.displayName,
        cwd: args.cwd,
        workspaceLabel: args.workspaceLabel,
        eventBufferBytes: this.opts.outputBufferBytes,
        createdAt: args.createdAt,
        ...(args.resumeAgentSessionId
          ? { resumeAgentSessionId: args.resumeAgentSessionId }
          : {}),
        skipPermissions: args.skipPermissions === true,
      },
      server,
    );

    this.insertRow(session, args.createdAt);
    this.live.set(args.id, session);
    this.wire(session);
    // No derived-title lookup, same reasoning as agy/opencode: codex keeps
    // its own conversation store, not one this server knows how to read.
    session.on('event', (_seq, event) => {
      if (event.kind === 'session_started') this.persist(session);
    });

    try {
      await session.start();
    } catch (err) {
      this.persist(session);
      this.live.delete(args.id);
      throw new SessionError(
        `Failed to start ${args.adapter.displayName}: ${err instanceof Error ? err.message : String(err)}`,
        'spawn_failed',
        500,
      );
    }

    this.persist(session);
    this.opts.logger?.info(
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured', backend: 'codex-app-server' },
      'session started',
    );
    return session;
  }

  /**
   * Pick up Claude Code's own generated title for a conversation.
   *
   * A session's own `spec.title` is fixed at creation and never updated —
   * but the CLI process behind a structured session writes a real,
   * content-derived title into its own transcript almost as soon as the
   * conversation starts, the same one `ProjectService` already surfaces for
   * the home-screen list. This is what keeps an *open* session's own title
   * (its `AgentPage` header, not just the list row) in sync with that,
   * without the cost of `ConversationStore.find()`'s full directory scan on
   * every turn — `titleFor` goes straight to the one file it needs.
   */
  private async refreshDerivedTitle(session: StructuredSession): Promise<void> {
    const agentSessionId = session.agentSessionId;
    if (!agentSessionId || !this.opts.titleFor) return;

    let title: string | null;
    try {
      title = await this.opts.titleFor(session.spec.cwd, agentSessionId);
    } catch {
      return; // Best-effort: the fixed creation-time title still shows.
    }
    if (!title || title === session.derivedTitle) return;

    session.setDerivedTitle(title);
    this.persist(session);
  }

  get(id: string): ManagedSession | undefined {
    return this.live.get(id);
  }

  getOrThrow(id: string): ManagedSession {
    const session = this.live.get(id);
    if (!session) throw new SessionError(`No such session: ${id}`, 'not_found', 404);
    return session;
  }

  /**
   * Forget a finished session.
   *
   * Only the record: there is no process left to stop, and nothing on disk is
   * touched. A running session is refused rather than silently killed —
   * removing a row for a live process would orphan it, still running with no
   * way back to it.
   */
  forget(id: string): void {
    const live = this.live.get(id);
    if (live?.isAlive()) {
      throw new SessionError(
        'Stop this session before removing it.',
        'session_running',
        409,
      );
    }
    this.live.delete(id);
    const changes = this.opts.db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes;
    if (changes === 0 && !live) {
      throw new SessionError(`No such session: ${id}`, 'not_found', 404);
    }
  }

  /** Forget every finished session in a directory. Running ones are left. */
  forgetFinishedIn(cwd: string): number {
    for (const [id, session] of this.live) {
      if (session.spec.cwd === cwd && !session.isAlive()) this.live.delete(id);
    }
    return this.opts.db
      .prepare(
        `DELETE FROM sessions
          WHERE cwd = ? AND status NOT IN ('starting', 'running')`,
      )
      .run(cwd).changes;
  }

  /**
   * The conversation this session was asked to continue, if any.
   *
   * Note this is the id it *resumed from*, not the id it is writing to — a
   * forked resume writes elsewhere, and the history worth showing is the one
   * that already existed.
   */
  resumedConversationId(id: string): string | null {
    const session = this.live.get(id);
    if (!session || session.transport !== 'structured') return null;
    return session.spec.resumeAgentSessionId ?? null;
  }

  countAlive(): number {
    let n = 0;
    for (const s of this.live.values()) if (s.isAlive()) n++;
    return n;
  }

  terminate(id: string): void {
    const session = this.live.get(id);
    if (session) {
      if (session.isAlive()) session.terminate();
      return;
    }
    const row = this.opts.db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
    if (!row) throw new SessionError(`No such session: ${id}`, 'not_found', 404);
    // Already finished; terminating is a no-op rather than an error.
  }

  attach(id: string): void {
    this.attachCounts.set(id, (this.attachCounts.get(id) ?? 0) + 1);
  }

  detach(id: string): void {
    const next = (this.attachCounts.get(id) ?? 1) - 1;
    if (next <= 0) this.attachCounts.delete(id);
    else this.attachCounts.set(id, next);
  }

  attachedCount(id: string): number {
    return this.attachCounts.get(id) ?? 0;
  }

  /** Live sessions first, then recent history from SQLite. */
  list(limit = 50): SessionInfo[] {
    const infos: SessionInfo[] = [];
    const seen = new Set<string>();

    for (const session of this.live.values()) {
      infos.push(this.toInfo(session));
      seen.add(session.id);
    }

    const rows = this.opts.db
      .prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?')
      .all(limit) as SessionRow[];

    for (const row of rows) {
      if (seen.has(row.id)) continue;
      infos.push(this.rowToInfo(row));
    }

    return infos.sort((a, b) => {
      const aAlive = a.status === 'running' || a.status === 'starting';
      const bAlive = b.status === 'running' || b.status === 'starting';
      if (aAlive !== bAlive) return aAlive ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
  }

  find(id: string): SessionInfo | null {
    const session = this.live.get(id);
    if (session) return this.toInfo(session);
    const row = this.opts.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | SessionRow
      | undefined;
    return row ? this.rowToInfo(row) : null;
  }

  /**
   * The title actually worth showing right now.
   *
   * `spec.title` is fixed at creation and deliberately never mutated (history
   * and persistence should always show what a session was actually started
   * with — see the skip-permissions overrides above for the same reasoning).
   * A structured session's *derived* title is the one exception worth
   * preferring for display: it only ever improves on the generic fallback,
   * and the point of it existing is to be shown.
   */
  private displayTitle(session: ManagedSession): string {
    if (session.transport === 'structured' && session.derivedTitle) return session.derivedTitle;
    return session.spec.title;
  }

  toInfo(session: ManagedSession): SessionInfo {
    return {
      id: session.id,
      title: this.displayTitle(session),
      agent: session.spec.agent,
      agentDisplayName: session.spec.agentDisplayName,
      cwd: session.spec.cwd,
      workspaceLabel: session.spec.workspaceLabel,
      status: session.status,
      cols: session.cols,
      rows: session.rows,
      pid: session.pid,
      exitCode: session.exitCode,
      exitSignal: session.exitSignal,
      createdAt: session.spec.createdAt,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      lastActivityAt: session.lastActivityAt,
      attachedClients: this.attachedCount(session.id),
      epoch: session.epoch,
      backend: session.backendId,
      transport: session.transport,
      agentSessionId: session.agentSessionId,
      durable: session.survivesServerRestart,
      adopted: session.transport === 'terminal' && session.spec.adopted === true,
      // `spec.skipPermissions` is the honest record of what this session was
      // created with; a structured session can additionally have the global
      // switch applied to it live after the fact (see
      // `setGlobalSkipPermissions`), which `spec` deliberately never mutates
      // to reflect. OR them so the badge stays true to what is actually
      // happening right now, not just what was chosen at creation.
      skipPermissionsEnabled:
        session.spec.skipPermissions === true ||
        (session.transport === 'structured' && session.globalBypassActive),
    };
  }

  private rowToInfo(row: SessionRow): SessionInfo {
    return {
      id: row.id,
      title: row.title,
      agent: row.agent,
      agentDisplayName: this.opts.agents.get(row.agent)?.displayName ?? row.agent,
      cwd: row.cwd,
      workspaceLabel: this.opts.workspaces.labelFor(row.cwd),
      status: row.status,
      cols: row.cols,
      rows: row.rows,
      pid: row.pid,
      exitCode: row.exit_code,
      exitSignal: row.exit_signal,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      lastActivityAt: row.last_activity_at,
      attachedClients: 0,
      // History rows have no live stream, so no epoch to resume from.
      epoch: null,
      backend: row.backend,
      transport: row.transport === 'structured' ? 'structured' : 'terminal',
      agentSessionId: row.agent_session_id,
      durable: false,
      adopted: false,
      skipPermissionsEnabled: row.skip_permissions === 1,
    };
  }

  private insertRow(session: ManagedSession, createdAt: number): void {
    this.opts.db
      .prepare(
        `INSERT INTO sessions
           (id, title, agent, command, args_json, cwd, env_keys_json, status, pid,
            cols, rows, exit_code, exit_signal, created_at, started_at, ended_at,
            last_activity_at, backend, external_id, transport, agent_session_id,
            skip_permissions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.spec.title,
        session.spec.agent,
        session.transport === 'terminal' ? session.spec.command : '',
        JSON.stringify(session.transport === 'terminal' ? session.spec.args : []),
        session.spec.cwd,
        // Names only. Values are never persisted.
        JSON.stringify(session.transport === 'terminal' ? session.spec.envOverrideKeys : []),
        session.status,
        session.pid,
        session.cols,
        session.rows,
        null,
        null,
        createdAt,
        session.startedAt,
        session.endedAt,
        session.lastActivityAt,
        session.backendId,
        session.externalId,
        session.transport,
        session.agentSessionId,
        session.spec.skipPermissions === true ? 1 : 0,
      );
  }

  persist(session: ManagedSession): void {
    this.opts.db
      .prepare(
        `UPDATE sessions
            SET status = ?, pid = ?, cols = ?, rows = ?, exit_code = ?, exit_signal = ?,
                started_at = ?, ended_at = ?, last_activity_at = ?, external_id = ?,
                agent_session_id = ?, title = ?
          WHERE id = ?`,
      )
      .run(
        session.status,
        session.pid,
        session.cols,
        session.rows,
        session.exitCode,
        session.exitSignal,
        session.startedAt,
        session.endedAt,
        session.lastActivityAt,
        session.externalId,
        session.agentSessionId,
        // Written through here (not just `insertRow`) so a session evicted
        // from memory, or read back after a restart, still shows the derived
        // title once one was found rather than reverting to the generic
        // creation-time name.
        this.displayTitle(session),
        session.id,
      );
  }

  /**
   * Periodic housekeeping: flush activity timestamps, emit idle hints, enforce
   * the idle timeout, and evict long-dead sessions from memory.
   */
  private sweep(now = Date.now()): void {
    const idleMs = this.opts.idleTimeoutSeconds * 1000;

    for (const [id, session] of this.live) {
      if (session.isAlive()) {
        session.pollIdleHint();
        this.persist(session);

        if (idleMs > 0 && this.attachedCount(id) === 0) {
          const last = session.lastActivityAt ?? session.startedAt ?? now;
          if (now - last > idleMs) {
            this.opts.logger?.warn({ sessionId: id }, 'terminating idle session');
            session.terminate();
          }
        }
        continue;
      }

      // Dead: keep the final screen readable for a while, then release memory.
      const endedAt = session.endedAt ?? 0;
      if (this.attachedCount(id) === 0 && now - endedAt > 10 * 60_000) {
        session.dispose();
        this.live.delete(id);
      }
    }
  }

  /**
   * Stop managing sessions and stop timers.
   *
   * On a durable backend we *detach* and leave the agents running — that is the
   * whole point of using tmux, and it is what lets `systemctl restart` be a
   * non-event. On the direct backend the processes are our children and cannot
   * survive, so we terminate them cleanly rather than orphaning them.
   */
  async shutdown(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;

    const durable = this.opts.backend.survivesServerRestart;

    if (durable) {
      for (const session of this.live.values()) {
        // The row stays `running` with its external id, so the next boot can
        // find and re-adopt it.
        this.persist(session);
        session.detachProcess();
        session.dispose();
      }
    } else {
      const alive = [...this.live.values()].filter((s) => s.isAlive());
      // A short grace at shutdown: the server is going away regardless, and an
      // interactive shell ignores SIGTERM, so waiting the full 5s just delays
      // exit for every session.
      for (const session of alive) session.terminate(500);

      // Wait for real exits so the database records them accurately.
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && alive.some((s) => s.isAlive())) {
        await new Promise((r) => setTimeout(r, 25));
      }

      for (const session of this.live.values()) {
        this.persist(session);
        session.dispose();
      }
    }

    for (const timer of this.approvalTimers.values()) clearTimeout(timer);
    this.approvalTimers.clear();
    this.opts.backend.dispose?.();
    // Every opencode/codex session above has already been asked to stop; the
    // shared process outlives any one of them, so it is only killed here.
    this.opencodeServer?.dispose();
    this.opencodeServer = null;
    this.codexServer?.dispose();
    this.codexServer = null;
    this.live.clear();
    this.attachCounts.clear();
  }

  /** Terminate every running session regardless of backend. Used by tests. */
  async terminateAll(): Promise<void> {
    const alive = [...this.live.values()].filter((s) => s.isAlive());
    for (const session of alive) session.terminate(500);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && alive.some((s) => s.isAlive())) {
      await new Promise((r) => setTimeout(r, 25));
    }
    for (const session of alive) this.persist(session);
  }

  /** Test seam: statuses currently held in memory. */
  debugStatuses(): Record<string, SessionStatus> {
    return Object.fromEntries([...this.live].map(([id, s]) => [id, s.status]));
  }
}

function safeParseArgs(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}
