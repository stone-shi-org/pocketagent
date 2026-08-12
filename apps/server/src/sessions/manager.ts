import crypto from 'node:crypto';
import path from 'node:path';
import type { SessionInfo, SessionStatus, SessionTransport } from '@pocketagent/protocol';
import type { Db, SessionRow } from '../db/index.js';
import { markStaleSessionsInterrupted, pruneOldSessions } from '../db/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import { resolveExecutable } from '../agents/registry.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import type { ProcessBackend } from '../backends/index.js';
import { PtySession } from './pty-session.js';
import { StructuredSession } from './structured-session.js';
import { buildChildEnv } from './env.js';

/**
 * Either flavour of session. They share the metadata surface the manager,
 * routes, and persistence need; the WebSocket layer narrows on `transport`
 * for the operations that only make sense for one of them.
 */
export type ManagedSession = PtySession | StructuredSession;

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

  constructor(private readonly opts: ManagerOptions) {}

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
    const skipPermissions = input.skipPermissions === true && adapter.supportsSkipPermissions === true;

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
      return this.startStructured({
        id,
        title,
        adapter,
        cwd: input.cwd,
        workspaceLabel,
        createdAt,
        executable,
        env: buildChildEnv({ cwd: input.cwd, overrides: built.env }),
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
    // so a restart can offer to resume the conversation.
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
      { sessionId: args.id, agent: args.adapter.id, transport: 'structured' },
      'session started',
    );
    return session;
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

  toInfo(session: ManagedSession): SessionInfo {
    return {
      id: session.id,
      title: session.spec.title,
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
      skipPermissionsEnabled: session.spec.skipPermissions === true,
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
                agent_session_id = ?
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
