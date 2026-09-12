import crypto from 'node:crypto';
import path from 'node:path';
import type {
  AgentEvent,
  EffortLevel,
  ModelInfo,
  SessionInfo,
  SessionStatus,
  SessionTransport,
} from '@pocketagent/protocol';
import { isCustomClaudeProviderId } from '@pocketagent/protocol';
import type { Db, SessionRow } from '../db/index.js';
import {
  GLOBAL_SKIP_PERMISSIONS_KEY,
  hideChat,
  markStaleSessionsInterrupted,
  pruneOldSessions,
  readAgentDefaults,
  readSetting,
  recordAgentRefresh,
  writeAgentDefaults,
  writeSetting,
} from '../db/index.js';
import type { AgentAdapter } from '../agents/types.js';
import type { AgentRegistry } from '../agents/registry.js';
import { resolveExecutable } from '../agents/registry.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { treeRootOf } from '../git/worktree-paths.js';
import type { AdoptionService } from '../adopt/index.js';
import type { ProcessBackend } from '../backends/index.js';
import { usageProbeCwd } from '../usage/probe-cwd.js';
import { PtySession } from './pty-session.js';
import { StructuredSession } from './structured-session.js';
import { AgySession } from './agy-session.js';
import { OpencodeSession } from './opencode-session.js';
import { OpencodeServerManager } from './opencode-server.js';
import { CodexSession } from './codex-session.js';
import { CodexServerManager } from './codex-server.js';
import { PiSession } from './pi-session.js';
import { buildChildEnv } from './env.js';
import { codexHistoryEvents, normalizeCodexModels, normalizeOpencodeModels, opencodeHistoryEvents } from './normalize.js';
import { probeAgyModels, probeClaudeModels, probePiModels } from './agent-probe.js';

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
  /** Branch rather than append when resuming. Defaults to false. */
  forkSession?: boolean;
  /**
   * Explicit, off-by-default opt-in to run this session with approvals
   * bypassed. Only has any effect on an adapter that reports
   * `supportsSkipPermissions`; every other adapter ignores it.
   */
  skipPermissions?: boolean;
  /**
   * Explicit model/effort for this session. Only honoured on a brand-new
   * `claude` conversation (see `create()`'s guard below) — a resume already
   * carries its own conversation's model in the SDK's own state, and forcing
   * a different agent's cached value onto it would silently switch a
   * conversation that never asked to change.
   */
  model?: string;
  effort?: EffortLevel | null;
  /** Attach to an already-running tmux pane instead of starting a process. */
  adopt?: {
    command: string;
    args: string[];
    /** Attach at the pane's current size so the other client is not resized. */
    cols: number;
    rows: number;
    label: string;
    /** The tmux session name being adopted. */
    sessionName?: string;
    /**
     * The pane's stable `AdoptableTarget.id`, persisted onto the session row.
     * Distinct from using it to resolve the target (that already happened in
     * the route handler): this is what lets a later attach to the same pane
     * be recognized as the same chat rather than a new one.
     */
    targetId: string;
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
  /**
   * Optional so tests can omit it. Without it, an adopted session's `cols`/
   * `rows` are simply whatever they were at attach time forever — see
   * `reconcileAdoptedSize`'s doc comment for what that costs.
   */
  adoption?: AdoptionService;
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

  /**
   * Called when a working tree may have just come free.
   *
   * The run queue subscribes here so a directory released by *any* session —
   * a webhook run, a cron run, or a human's own chat — starts whatever was
   * waiting on it. Without this the queue would only notice on its 30s sweep.
   */
  private readonly treeIdleListeners = new Set<(treeRoot: string) => void>();

  /** Subscribe to "a working tree may be free now". Returns an unsubscribe. */
  onTreeIdle(listener: (treeRoot: string) => void): () => void {
    this.treeIdleListeners.add(listener);
    return () => this.treeIdleListeners.delete(listener);
  }

  private notifyTreeIdle(cwd: string): void {
    const root = treeRootOf(cwd);
    for (const listener of this.treeIdleListeners) {
      try {
        listener(root);
      } catch (err) {
        this.opts.logger?.warn({ err, root }, 'tree-idle listener threw');
      }
    }
  }

  /**
   * Called when `forget()` actually removes a session's record.
   *
   * The WS layer subscribes here, once, at server setup — not per connection
   * — so a tab already attached to a session that gets removed from a
   * *different* tab/view (PA-40) is told the same way a fresh `attach` to a
   * since-forgotten session already is, rather than sitting idle forever
   * believing the session still exists.
   */
  private readonly forgottenListeners = new Set<(id: string) => void>();

  /** Subscribe to "a session's record was just forgotten". Returns an unsubscribe. */
  onForgotten(listener: (id: string) => void): () => void {
    this.forgottenListeners.add(listener);
    return () => this.forgottenListeners.delete(listener);
  }

  private notifyForgotten(id: string): void {
    for (const listener of this.forgottenListeners) {
      try {
        listener(id);
      } catch (err) {
        this.opts.logger?.warn({ err, id }, 'forgotten listener threw');
      }
    }
  }

  /**
   * Called when `terminate()` actually stops a live session — a deliberate
   * "close this session" action (a fleet card's X, a session header's Stop
   * button, the Active Sessions dialog, ...), not a session finishing on its
   * own. That distinction matters: an agent that simply completes its turn
   * must not chase away a tab someone is reading the result in, but a session
   * someone explicitly closed elsewhere should not go on looking live in a
   * tab that never heard about it (PA-40). Separate from `onForgotten`
   * because `terminate()` leaves the record behind — still resumable, still
   * a 200 from `GET /api/sessions/:id` — so the WS push it drives is a
   * different, milder error code than `forget()`'s `not_found`.
   */
  private readonly terminatedListeners = new Set<(id: string) => void>();

  /** Subscribe to "a live session was just explicitly stopped". Returns an unsubscribe. */
  onTerminated(listener: (id: string) => void): () => void {
    this.terminatedListeners.add(listener);
    return () => this.terminatedListeners.delete(listener);
  }

  private notifyTerminated(id: string): void {
    for (const listener of this.terminatedListeners) {
      try {
        listener(id);
      } catch (err) {
        this.opts.logger?.warn({ err, id }, 'terminated listener threw');
      }
    }
  }

  /**
   * Called when `hideChat()` above actually removes a conversation from the
   * list (PA-40 round 3, reporter: double-click a finished chat to open it
   * read-only in `ChatPreviewPage`, click that same row's "Remove from
   * list", and the open tab never closed). `forgottenListeners`/
   * `terminatedListeners` above both fire only for a *session* id, reaching
   * a tab that `attach`ed to one — `ChatPreviewPage` never does, since it
   * reads a finished transcript once over plain HTTP and has no process to
   * observe. This is the conversation-id counterpart the ws layer's
   * `watch_conversation` subscribes to instead.
   */
  private readonly chatHiddenListeners = new Set<(conversationId: string) => void>();

  /** Subscribe to "a conversation was just removed from the list". Returns an unsubscribe. */
  onChatHidden(listener: (conversationId: string) => void): () => void {
    this.chatHiddenListeners.add(listener);
    return () => this.chatHiddenListeners.delete(listener);
  }

  private notifyChatHidden(conversationId: string): void {
    for (const listener of this.chatHiddenListeners) {
      try {
        listener(conversationId);
      } catch (err) {
        this.opts.logger?.warn({ err, conversationId }, 'chat-hidden listener threw');
      }
    }
  }

  /**
   * Working trees with a live session mid-turn right now.
   *
   * This is the run queue's whole notion of "occupied", and it is derived on
   * every call rather than cached: a stale answer either blocks a free tree
   * forever or hands out one that is still busy. `busySince` is stamped when a
   * prompt goes in and cleared on `turn_complete`, so a session that is alive
   * but waiting for its next prompt is *not* counted — which is exactly the
   * "until previous one concludes (waiting for user)" boundary.
   *
   * Terminal sessions are excluded deliberately. A PTY has no end-of-turn
   * signal, only the classifier's advisory idle hint, so counting one would
   * mean a queue that never drains — the same judgement `terminal/classifier.ts`
   * is forbidden from making.
   *
   * `exceptSessionId` answers the *other* question one caller has — "is anyone
   * **else** working here" — and exists so that caller cannot answer it with a
   * different rule than this one. A second prompt into a session already
   * mid-turn is the agent's business, not the queue's.
   */
  busyTreeRoots(exceptSessionId?: string): string[] {
    const roots: string[] = [];
    for (const session of this.live.values()) {
      if (exceptSessionId !== undefined && session.id === exceptSessionId) continue;
      if (session.transport !== 'structured') continue;
      if (session.busySince === null) continue;
      if (session.status !== 'running' && session.status !== 'starting') continue;
      roots.push(treeRootOf(session.spec.cwd));
    }
    return roots;
  }

  /** Attach the manager's own listeners to a session. */
  private wire(session: ManagedSession): void {
    session.on('status', () => {
      this.persist(session);
      // A session that is no longer running holds no working tree. This is a
      // separate signal from `exit` on purpose: `StructuredSession.terminate`
      // sets `killed` without ever emitting one, so without this a killed
      // session's tree would stay blocked until the 30s sweep noticed.
      if (session.status !== 'running' && session.status !== 'starting') {
        this.notifyTreeIdle(session.spec.cwd);
      }
    });
    session.on('exit', () => {
      this.persist(session);
      // A dead session holds nothing, so its tree may now be free.
      this.notifyTreeIdle(session.spec.cwd);
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
      session.on('event', (_seq, event) => {
        if (event.kind === 'turn_complete') this.onTurnComplete(session);
        // Write-through cache of "what did a live session actually run with",
        // keyed by agent id — see `agent_defaults` in db/index.ts. This is
        // the one shared subscription point for every structured backend
        // (agy/opencode/codex/pi as well as the SDK), so any of them reporting
        // these event kinds gets cached the same way, with no per-backend
        // wiring needed. Only the SDK-backed `claude` sessions currently read
        // this cache back at spawn time (see `create()`), but caching it here
        // for every backend costs nothing and is ready for that to extend.
        if (event.kind === 'session_started' && event.model) {
          writeAgentDefaults(this.opts.db, session.spec.agent, { model: event.model });
        }
        if (event.kind === 'model_changed') {
          writeAgentDefaults(this.opts.db, session.spec.agent, { model: event.model });
        }
        if (event.kind === 'effort_changed') {
          writeAgentDefaults(this.opts.db, session.spec.agent, { effort: event.effort });
        }
        if (event.kind === 'models_available') {
          writeAgentDefaults(this.opts.db, session.spec.agent, {
            modelsJson: JSON.stringify(event.models),
          });
        }
      });
    } else {
      session.on('hint', (hints) => {
        if (hints.includes('idle')) this.onIdleHint(session);
      });
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

  /**
   * Notify when a structured turn finishes and nobody is attached.
   *
   * Unlike an approval, a finished turn does not block the agent, so there is
   * no "still deciding" window worth waiting out — if a client is attached at
   * all, the transcript already shows the turn ending live, and a
   * backgrounded tab covers itself with its own local notification (see
   * `notifyTurnComplete` on the client). This only fires the one case neither
   * of those reach: nobody attached whatsoever, e.g. the browser is closed.
   * `turn_complete` itself is emitted at most once per turn (including the
   * synthesized one on a pump-loop error — see `structured-session.ts`), so
   * no debouncing is needed here the way `onPermissionChange` needs it.
   */
  private onTurnComplete(session: StructuredLikeSession): void {
    // First, regardless of notification settings: the turn is over, so this
    // session no longer holds its working tree. The early returns below are
    // about *push notifications*, and letting them skip this would make the
    // queue depend on whether notifications happen to be configured.
    this.notifyTreeIdle(session.spec.cwd);

    const push = this.opts.push;
    if (!push?.isEnabled()) return;
    if (this.attachedCount(session.id) !== 0) return;

    void push
      .send({
        title: 'PocketAgent — turn complete',
        body: `${this.displayTitle(session)} finished and is waiting for your next prompt.`,
        url: `/#/s/${encodeURIComponent(session.id)}`,
        tag: `turn-complete-${session.id}`,
      })
      .catch(() => undefined);
  }

  /**
   * Notify when a terminal session goes quiet and nobody is attached.
   *
   * There is no structured end-of-turn signal for a raw PTY, only the
   * classifier's advisory `idle` hint (30s of no output — see
   * `terminal/classifier.ts`). That hint is heuristic and must never gate a
   * decision, but a push notification doesn't decide anything either; it just
   * tells someone who has walked away that the pane looks done. The
   * classifier only emits `idle` once per quiet period (`checkIdle`
   * deduplicates against the last emitted hint set), so this fires at most
   * once per idle stretch, not on every sweep tick.
   */
  private onIdleHint(session: PtySession): void {
    const push = this.opts.push;
    if (!push?.isEnabled()) return;
    if (this.attachedCount(session.id) !== 0) return;

    void push
      .send({
        title: 'PocketAgent — session idle',
        body: `${this.displayTitle(session)} looks like it's waiting for you.`,
        url: `/#/s/${encodeURIComponent(session.id)}`,
        tag: `idle-${session.id}`,
      })
      .catch(() => undefined);
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

      // Only a brand-new conversation gets an auto-applied model/effort
      // default — a resume already carries its own conversation's model in
      // that agent's own state (the SDK's, agy's `--conversation`, codex's
      // thread, opencode's session, pi's session file), and forcing this
      // agent's most-recently-seen value onto it could silently switch a
      // conversation that never asked to change. Shared across every
      // structured backend below (previously computed only for `claude`) —
      // `AgentDefaultsRow` is keyed by agent id and caches whatever any of
      // the five backends last reported, via `SessionManager.wire`.
      const cachedDefaults = input.resumeAgentSessionId
        ? null
        : readAgentDefaults(this.opts.db, input.agent);
      const model = input.model ?? cachedDefaults?.model ?? undefined;
      const effort = input.effort !== undefined ? input.effort : (cachedDefaults?.effort ?? undefined);

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
          ...(model !== undefined ? { model } : {}),
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
          ...(model !== undefined ? { model } : {}),
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
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
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
          ...(model !== undefined ? { model } : {}),
          ...(effort !== undefined ? { effort } : {}),
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
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
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
        adoptTargetId: input.adopt?.targetId ?? null,
        adoptSessionName: input.adopt?.sessionName ?? null,
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
    adapter: { id: string; displayName: string; staticModels?: ModelInfo[] };
    cwd: string;
    workspaceLabel: string;
    createdAt: number;
    executable: string;
    env: Record<string, string>;
    resumeAgentSessionId?: string;
    forkSession?: boolean;
    skipPermissions?: boolean;
    model?: string;
    effort?: EffortLevel | null;
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
      // Only forwarded when the adapter actually declares one; absent leaves
      // `StructuredSession` asking the SDK exactly as it always has.
      ...(args.adapter.staticModels && args.adapter.staticModels.length > 0
        ? { staticModels: args.adapter.staticModels }
        : {}),
      ...(args.resumeAgentSessionId
        ? { resumeAgentSessionId: args.resumeAgentSessionId }
        : {}),
      ...(args.forkSession !== undefined ? { forkSession: args.forkSession } : {}),
      ...(this.opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.opts.maxBudgetUsd } : {}),
      skipPermissions: args.skipPermissions === true,
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
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
    model?: string;
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
      ...(args.model !== undefined ? { model: args.model } : {}),
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
    model?: string;
    effort?: EffortLevel | null;
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
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.effort !== undefined ? { effort: args.effort } : {}),
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
    model?: string;
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
        ...(args.model !== undefined ? { model: args.model } : {}),
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
   * The same shared `opencode serve` process a real `OpencodeSession` would
   * use, for reading a session's history when it has none of its own left —
   * see `opencodeHistory` below. Same "started on first call, null when the
   * binary is not configured" contract as `getCodexServerForUsage`.
   */
  private getOpencodeServerForHistory(): OpencodeServerManager | null {
    const adapter = this.opts.agents.get('opencode');
    if (!adapter) return null;

    const cwd = this.opts.workspaces.getRoots()[0] ?? process.cwd();
    const built = adapter.buildCommand({ cwd, cols: 80, rows: 24, skipPermissions: false });
    const executable = resolveExecutable(built.command);
    if (!executable) return null;

    const env = buildChildEnv({ cwd, overrides: built.env });
    return this.getOrCreateOpencodeServer(executable, env);
  }

  /**
   * Prior conversation for a codex thread that has no live `EventBuffer`
   * left to read — evicted after the idle grace window (`sweep()`), or lost
   * across a server restart (`this.live` starts empty on boot). This is a
   * *different* gap from `CodexSession.start()`'s own history backfill: that
   * one only fires while a resumed session is actually being created; this
   * one is for reopening a session that already exists and is not being
   * resumed by anyone right now — `routes/sessions.ts`'s `/history` route is
   * the only caller.
   *
   * codex's own on-disk rollout format is an internal, explicitly
   * "[UNSTABLE]" implementation detail (confirmed against the real,
   * installed app-server's own generated JSON schema: `Thread.path`'s doc
   * string) and an entirely different, lower-level shape than the
   * `ThreadItem`s `codexHistoryEvents` already knows how to read — so rather
   * than parse that file directly, this reads codex's history the same way
   * a live resume does, over `thread/resume`'s own RPC, via the same shared
   * process `getCodexServerForUsage` already uses for account-level reads.
   * `[]` on any failure (binary not configured, unknown thread, RPC error) —
   * same "no history, still works" contract as every other transcript
   * source in this codebase.
   */
  async codexHistory(threadId: string): Promise<AgentEvent[]> {
    const server = this.getCodexServerForUsage();
    if (!server) return [];
    try {
      const result = await server.sendRequest<{ thread?: { turns?: unknown } }>('thread/resume', { threadId });
      return codexHistoryEvents(result.thread?.turns ?? null);
    } catch {
      return [];
    }
  }

  /**
   * Prior conversation for an opencode session with no live `EventBuffer`
   * left — same reasoning and same distinction from `OpencodeSession.start()`'s
   * own backfill as `codexHistory`'s doc comment above. Reads via
   * `GET /session/{id}/message` on the shared `opencode serve` process,
   * confirmed to be scoped purely by session id — unlike `/event`'s SSE
   * stream, no `directory` query param is needed to get a real answer back.
   */
  async opencodeHistory(sessionId: string): Promise<AgentEvent[]> {
    const server = this.getOpencodeServerForHistory();
    if (!server) return [];
    try {
      const raw = await server.request<unknown>(`/session/${sessionId}/message`, { method: 'GET' });
      return opencodeHistoryEvents(raw);
    } catch {
      return [];
    }
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
    model?: string;
    effort?: EffortLevel | null;
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
        ...(args.model !== undefined ? { model: args.model } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
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
    this.notifyForgotten(id);
  }

  /**
   * Remove one conversation from the list (PA-40 round 3).
   *
   * A thin wrapper around the db-level `hideChat`, kept here — rather than
   * called directly from a route — for the same reason `forget()` fires its
   * own notification instead of leaving the caller to remember to: a route
   * that hid a chat and forgot to notify would silently reintroduce this bug
   * for the next caller. Unlike `forget()`, there is no session to check for
   * "still running" — a conversation is a transcript, not a process, and
   * removing it never touches whatever session row happens to reference it.
   */
  hideChat(conversationId: string): void {
    hideChat(this.opts.db, conversationId);
    this.notifyChatHidden(conversationId);
  }

  /**
   * Forget every finished session that belongs to a specific conversation id
   * (e.g. after hiding or deleting the conversation).
   */
  forgetByConversationId(conversationId: string): number {
    for (const [id, session] of this.live) {
      if (session.agentSessionId === conversationId && !session.isAlive()) {
        this.live.delete(id);
      }
    }
    return this.opts.db
      .prepare(
        `DELETE FROM sessions
          WHERE agent_session_id = ? AND status NOT IN ('starting', 'running')`,
      )
      .run(conversationId).changes;
  }

  /**
   * True if any session, of any transport or backend, is currently alive
   * with this exact `cwd`. Used to refuse deleting a worktree out from under
   * a running process — the same "never disturb a running session" posture
   * as `forget()` above, extended to a directory-level action.
   */
  hasAliveSessionIn(cwd: string): boolean {
    for (const session of this.live.values()) {
      if (session.spec.cwd === cwd && session.isAlive()) return true;
    }
    return false;
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
   * Forget every finished shell session, regardless of which real directory it
   * ran in. Running ones are left.
   *
   * Backs the "Shell" category's own clear action (PA-25). It cannot go
   * through `forgetFinishedIn`: that matches on the literal `cwd` column, and
   * the whole point of the category is that its rows are *not* grouped by
   * directory — a shell's `cwd` is wherever it happens to be, and there is no
   * one path that names all of them.
   *
   * The two clauses mirror `isShellSession` in `projects/index.ts`, and must
   * keep mirroring it: a row the category lists but this cannot delete is a
   * "Clear finished" that silently leaves rows behind. `adopt_target_id` (not
   * `adopted`, which is not a column) is what is true of an adopted session
   * after its process is gone — see `toSessionInfo`'s row fallback.
   */
  forgetFinishedShells(): number {
    for (const [id, session] of this.live) {
      // The `transport` check has to come first for `spec.adopted` to narrow —
      // only a `PtySessionSpec` has that field at all.
      if (session.transport !== 'terminal' || session.isAlive()) continue;
      if (session.spec.adopted === true || session.spec.agent === 'shell') this.live.delete(id);
    }
    return this.opts.db
      .prepare(
        `DELETE FROM sessions
          WHERE (adopt_target_id IS NOT NULL OR agent = 'shell')
            AND status NOT IN ('starting', 'running')`,
      )
      .run().changes;
  }

  /**
   * The conversation worth showing backstory for, if any.
   *
   * A *live* session in `this.live` uses the id it *resumed from*, not the
   * id it is writing to — a forked resume writes elsewhere, and prepending
   * anything but the conversation that already existed would duplicate what
   * the live `EventBuffer` is about to replay over the same socket.
   *
   * A session no longer in `this.live` (evicted, or the process ended before
   * a server restart — see `AgySession`'s `survivesServerRestart`) has no
   * `EventBuffer` left to duplicate, live or otherwise: whatever it once held
   * is gone. Falling back to the DB row's own `agent_session_id` — the
   * conversation this session *was*, not just one it resumed from — is what
   * makes reopening an old, already-finished chat show anything at all
   * instead of looking silently empty. Confirmed live: an agy chat several
   * restarts old reported `resumedConversationId() === null` unconditionally
   * before this fallback existed, even though its own conversation was still
   * sitting on disk the whole time (`AgyTranscriptStore`) — the row was never
   * consulted at all once the session left memory.
   */
  resumedConversationId(id: string): string | null {
    const session = this.live.get(id);
    if (session) {
      return session.transport === 'structured' ? (session.spec.resumeAgentSessionId ?? null) : null;
    }
    const row = this.opts.db.prepare('SELECT agent_session_id FROM sessions WHERE id = ?').get(id) as
      | { agent_session_id: string | null }
      | undefined;
    return row?.agent_session_id ?? null;
  }

  countAlive(): number {
    let n = 0;
    for (const s of this.live.values()) if (s.isAlive()) n++;
    return n;
  }

  terminate(id: string): void {
    const session = this.live.get(id);
    if (session) {
      if (session.isAlive()) {
        session.terminate();
        // Fires unconditionally, not from the session's own `exit` event:
        // this is specifically "someone just asked to stop it", which an
        // agent finishing its own turn must not be confused with (PA-40).
        this.notifyTerminated(id);
      }
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
      busy: session.busy,
      busySince: session.busySince,
      // Keep this in the in-memory event buffer only: terminal output and
      // normalized agent events deliberately are not persisted. A live row
      // still needs the same actionable signal as the open transcript.
      rateLimit:
        session.transport === 'structured'
          ? session.buffer.findByKind('rate_limit').at(-1) ?? null
          : null,
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
      adoptTargetId: session.transport === 'terminal' ? session.spec.adoptTargetId ?? null : null,
      adoptSessionName:
        session.transport === 'terminal'
          ? session.spec.adoptSessionName ??
            (session.spec.args ? extractSessionNameFromArgs(session.spec.args) : null)
          : null,
      // `spec.skipPermissions` is the honest record of what this session was
      // created with; a structured session can additionally have the global
      // switch applied to it live after the fact (see
      // `setGlobalSkipPermissions`), which `spec` deliberately never mutates
      // to reflect. OR them so the badge stays true to what is actually
      // happening right now, not just what was chosen at creation.
      skipPermissionsEnabled:
        session.spec.skipPermissions === true ||
        (session.transport === 'structured' && session.globalBypassActive),
      // Read off the adapter rather than persisted with the session: it is a
      // property of *how this agent runs*, not of a choice made at creation,
      // so it must follow the adapter's current configuration. Nothing is
      // stored, which also means a variant that is later reconfigured or
      // removed cannot leave a stale claim on an old row.
      providerDisclosure: this.opts.agents.get(session.spec.agent)?.providerDisclosure ?? null,
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
      // History rows are dead by definition; nothing to be busy about.
      busy: false,
      busySince: null,
      rateLimit: null,
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
      // Was unconditionally `false` here: a history row has no live `spec` to
      // read `adopted` off of, so this used to forget that a finished shell
      // session had ever been adopted the moment it was evicted from memory
      // (`sweep()`, ~10 minutes after it ends) — it would then leak out of the
      // "Shell" virtual project into whatever `cwd` the pane happened to be
      // in, permanently, since nothing else ever deletes the row. Deriving it
      // from the persisted `adopt_target_id` instead keeps a dead adopted
      // session classified as a shell chat for as long as the row exists.
      adopted: row.adopt_target_id !== null,
      adoptTargetId: row.adopt_target_id,
      adoptSessionName: row.adopt_target_id ? extractSessionNameFromArgsJson(row.args_json) : null,
      skipPermissionsEnabled: row.skip_permissions === 1,
      providerDisclosure: this.opts.agents.get(row.agent)?.providerDisclosure ?? null,
    };
  }

  private insertRow(session: ManagedSession, createdAt: number): void {
    this.opts.db
      .prepare(
        `INSERT INTO sessions
           (id, title, agent, command, args_json, cwd, env_keys_json, status, pid,
            cols, rows, exit_code, exit_signal, created_at, started_at, ended_at,
            last_activity_at, backend, external_id, transport, agent_session_id,
            skip_permissions, adopt_target_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        session.transport === 'terminal' ? session.spec.adoptTargetId ?? null : null,
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

        if (session.transport === 'terminal' && session.spec.adopted) {
          // Fire-and-forget: a tmux exec failure here must only skip this
          // round's reconciliation, never affect the session itself.
          void this.reconcileAdoptedSize(session);
        }

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
   * Catch an adopted session's cached `cols`/`rows` back up to tmux's live
   * window size.
   *
   * Those dimensions are otherwise fixed once, at attach time
   * (`sizeToAttachAt`), and nothing revisits them afterward: a WebSocket
   * `resize` is refused for an adopted session unless the user opted into
   * "take over size" (`mayResize` in `ws/index.ts`), and a fresh `attached`
   * message is built straight from this same cached value. But tmux's own
   * `window-size=latest` policy means the *live* shared window can change
   * size at any time because of a client this session never saw — a real
   * desktop terminal resizing, or another attach entirely. Once that drift
   * happens, this session's frozen size permanently disagrees with where
   * tmux actually paints its status line: it settles one or more rows above
   * this client's true last row, with whatever was on screen before left
   * untouched underneath it.
   *
   * Safe to run unconditionally on every sweep tick: `PtySession.resize`
   * only touches the underlying PTY when the value actually changed, and
   * this never *sets* the shared window size — `AdoptionService.liveClientSize`
   * only ever reports what it already is, so a session that took over its
   * own size (which itself already changed the real shared window to match)
   * reads back the same value it already has and this is a no-op.
   *
   * That "safe" argument used to stop there, and it was reasoning about the
   * tmux server only. It is silent on the *attached browser*, which for an
   * adopted pane does not fit its own viewport but mirrors this exact size
   * (see `TerminalPage.tsx`'s `onAttached`) — so an unannounced resize here
   * left the client rendering the grid it mirrored at attach time while tmux
   * generated bytes for the new one, reintroducing on the client precisely the
   * misplaced-cursor, stale-rows-below-the-status-line corruption described
   * above. `PtySession.resize` now emits `resized` and `ws/index.ts` forwards
   * it; this must keep going through `session.resize` for that to hold.
   */
  private async reconcileAdoptedSize(session: PtySession): Promise<void> {
    const adoption = this.opts.adoption;
    const targetId = session.spec.adoptTargetId;
    if (!adoption || !targetId) return;
    try {
      const target = await adoption.resolve(targetId, true);
      if (!target) return; // Pane is gone; nothing to reconcile against.
      const expected = await adoption.liveClientSize(target);
      if (session.resize(expected.cols, expected.rows)) {
        this.persist(session);
      }
    } catch {
      // Best-effort — see the fire-and-forget call site in `sweep`.
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

  /**
   * PA-50: Settings' "Coding Agents" section's explicit "Refresh" action.
   * Re-runs every structured agent's own model discovery — the same
   * `fetchInitialModels`-style call its session class already makes on
   * start — with no session created, so none of this counts against
   * `maxSessions` and nothing here is a "real" session at all. Custom Claude
   * providers (`custom-claude:*`) are excluded: they declare their own fixed
   * catalog (`staticModels`) rather than discovering one, and have their own
   * management page (`CustomClaudeProvidersSection`) already.
   *
   * Best-effort and independent per agent — `Promise.allSettled` rather than
   * `Promise.all`, since one agent's binary being missing or one CLI hanging
   * must never stop the others from reporting their own outcome.
   */
  async refreshAgentCatalogs(): Promise<void> {
    const ids = this.opts.agents
      .list()
      .filter((a) => a.transports.includes('structured') && !isCustomClaudeProviderId(a.id))
      .map((a) => a.id);
    await Promise.allSettled(ids.map((id) => this.refreshAgentCatalog(id)));
  }

  private async refreshAgentCatalog(agentId: string): Promise<void> {
    const adapter = this.opts.agents.get(agentId);
    if (!adapter) return;
    try {
      const models = await this.discoverModels(adapter);
      writeAgentDefaults(this.opts.db, agentId, { modelsJson: JSON.stringify(models) });
      recordAgentRefresh(this.opts.db, agentId, { ok: true });
    } catch (err) {
      recordAgentRefresh(this.opts.db, agentId, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Dispatch one agent's standalone model probe by `structuredKind` — see
   * `agent-probe.ts` for why `agy`/`pi`/`claude` (and any `custom-claude:*`
   * variant, though those short-circuit below) each need their own
   * throwaway process, while `codex`/`opencode` reuse the same shared daemon
   * `getOrCreateCodexServer`/`getOrCreateOpencodeServer` already hand a real
   * session — one more request on a connection that already exists, not a
   * new process. `usageProbeCwd()` (never a workspace root) for the same
   * reason `usage/probe-cwd.ts` documents: any headless CLI invocation with
   * no session of its own to inherit a real cwd from must run outside every
   * workspace, or a probe leaves a phantom chat behind for a poller to find.
   */
  private async discoverModels(adapter: AgentAdapter): Promise<ModelInfo[]> {
    // A declared catalog *is* the answer — nothing to probe, and probing
    // anyway (asking the CLI itself) would risk resurrecting the wrong
    // catalog `staticModels` exists specifically to override. See
    // `AgentAdapter.staticModels`'s doc comment.
    if (adapter.staticModels && adapter.staticModels.length > 0) return adapter.staticModels;

    const cwd = usageProbeCwd();
    const built = adapter.buildCommand({ cwd, cols: 80, rows: 24, skipPermissions: false });
    const executable = resolveExecutable(built.command);
    if (!executable) {
      throw new Error(`${adapter.displayName} (${built.command}) was not found on PATH.`);
    }
    const env = buildChildEnv({ cwd, overrides: built.env });

    switch (adapter.structuredKind) {
      case 'agy-cli':
        return probeAgyModels(executable, cwd, env);
      case 'pi-rpc':
        return probePiModels(executable, cwd, env);
      case 'codex-app-server': {
        const server = this.getOrCreateCodexServer(executable, env);
        const res = await server.sendRequest<{ data?: unknown[] }>('model/list', {});
        return normalizeCodexModels(res.data);
      }
      case 'opencode-server': {
        const server = this.getOrCreateOpencodeServer(executable, env);
        // `requestModelCatalog` (not a raw `request('/api/model', ...)`)
        // because a freshly-spawned server's very first answer races its own
        // provider-catalog warm-up and comes back empty — see that method's
        // doc comment. Without the retry it does, a "Refresh" click against
        // a shared server nobody has used yet always won this race and
        // silently cached an empty catalog as `last_refresh_ok: true`.
        const data = await server.requestModelCatalog(cwd);
        return normalizeOpencodeModels(data);
      }
      default:
        return probeClaudeModels(executable, cwd, env);
    }
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

function extractSessionNameFromArgs(args: string[]): string | null {
  const tIdx = args.indexOf('-t');
  if (tIdx !== -1) {
    const target = args[tIdx + 1];
    if (typeof target === 'string') {
      return target.startsWith('=') ? target.slice(1) : target;
    }
  }
  return null;
}

function extractSessionNameFromArgsJson(argsJson: string): string | null {
  return extractSessionNameFromArgs(safeParseArgs(argsJson));
}


