import type { AgentEvent, EffortLevel, McpTurnState, PermissionRequestEvent } from '@pocketagent/protocol';
import {
  MAX_MCP_ATTACHMENT_BYTES,
  MAX_MCP_CALL_DEPTH,
  MCP_MAX_LIVE_SESSIONS_PER_CLIENT,
  type PromptAttachment,
  type UploadAttachmentResponse,
} from '@pocketagent/protocol';
import { Readable } from 'node:stream';
import {
  AttachmentError,
  removeLandedAttachments,
  type AttachmentStaging,
  type StagedAttachment,
} from '../attachments/index.js';
import { landSessionAttachments } from '../attachments/session-landing.js';
import type { McpClientIdentity } from '../auth/mcp-tokens.js';
import {
  readMcpOwnedTargets,
  readMcpOwnedWork,
  recordMcpOwnedWork,
  type Db,
} from '../db/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { SessionManager, StructuredLikeSession } from '../sessions/manager.js';
import { SessionError } from '../sessions/manager.js';
import type { PromptQueueService } from '../sessions/prompt-queue.js';
import type { WorkspaceRegistry } from '../workspaces/index.js';
import { WorkspaceError } from '../workspaces/index.js';
import type { WorktreeService } from '../git/worktree.js';
import { WorktreeError } from '../git/worktree.js';
import type { PlannerChatService } from '../planner/chats.js';
import { PlannerChatError } from '../planner/chats.js';
import { readSessionHistory, type SessionHistoryDeps } from '../sessions/history.js';
import { structuredAgentProblem } from '../routes/shared.js';
import { mintBranchName } from '../runs/executor.js';
import { summarizeEvents, truncateTail } from '../planner/tools.js';

/**
 * PA-118: the work-starting half of the MCP server — start, prompt, wait,
 * interrupt, stop — for coding-agent sessions and Pocket Agent chats.
 *
 * Everything here is a composition of services that already exist, and the
 * subtle orderings are the existing ones: `RunExecutor`'s "watch before
 * prompt", `startPocketAgent`'s "observe before the first `next()`", and the
 * prompt queue's "defer, never drop". Three rules are this file's own:
 *
 * - **Nothing here answers an approval.** A turn that parks on one reports
 *   `awaiting_approval` with what it is waiting for, and stays parked — no
 *   timeout, no decay. The human answers in PocketAgent (web, push, Telegram);
 *   the MCP caller's next `wait_for_turn` sees the turn carry on. This is the
 *   first invariant, applied to a caller that is another agent.
 * - **The wait has a timeout; the turn never does.** `wait_for_turn` returning
 *   `still_running` ends the *wait*. The turn is untouched.
 * - **Nothing here passes `skipPermissions` or `force`.** An MCP-started
 *   session obeys exactly the approval gate a human-started one does
 *   (including the operator's own global switch, which `SessionManager`
 *   applies on its own), and a prompt into a busy tree queues behind it.
 */

/** How long a single wait may block before it reports `still_running`. */
export const MAX_WAIT_SECONDS = 300;
export const DEFAULT_WAIT_SECONDS = 60;
/** Cap on the final-answer text a turn result carries. */
const MAX_RESULT_CHARS = 20_000;
/** How often a long wait emits an MCP progress notification. */
const PROGRESS_INTERVAL_MS = 10_000;

export class McpWorkError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'McpWorkError';
  }
}

export interface PendingApprovalSummary {
  requestId: string;
  toolName: string;
  title: string;
  filePath: string | null;
}

export interface TurnResult {
  state: McpTurnState;
  sessionId?: string;
  chatId?: string;
  status?: string;
  /** The final assistant text of the most recent turn, when there is one. */
  finalText?: string | null;
  isError?: boolean;
  durationMs?: number | null;
  costUsd?: number | null;
  /** Present when `state` is `awaiting_approval`. The caller can see; it cannot answer. */
  pendingApprovals?: PendingApprovalSummary[];
  /** Present when `state` is `queued`. */
  queuePosition?: number;
  note?: string;
}

export interface StartSessionInput {
  cwd: string;
  agent: string;
  prompt: string;
  title?: string;
  model?: string;
  effort?: EffortLevel | null;
  worktree?: 'none' | 'new-branch';
  branchBase?: string;
  resumeConversationId?: string;
  /** PA-137: ids from `upload_attachment`, claimed by this client only. */
  attachments?: string[];
}

export interface StartSessionResult {
  sessionId: string;
  cwd: string;
  state: 'running' | 'queued';
  queuePosition?: number;
}

export interface McpWorkServiceOptions {
  db: Db;
  sessions: SessionManager;
  agents: AgentRegistry;
  workspaces: WorkspaceRegistry;
  worktrees: WorktreeService;
  promptQueue: PromptQueueService;
  plannerChats: PlannerChatService;
  historyDeps: SessionHistoryDeps;
  maxSessions: number;
  /** PA-137: where `upload_attachment` stages files. */
  attachmentStaging?: AttachmentStaging;
  logger?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

/** Slots kept free for a human, matching the webhook caps (`RESERVED_HUMAN_SESSIONS`). */
const RESERVED_HUMAN_SESSIONS = 2;

export class McpWorkService {
  constructor(private readonly opts: McpWorkServiceOptions) {}

  // ---- Provenance and caps --------------------------------------------------

  /** Live coding-agent sessions `clientId` started. */
  liveSessionsFor(clientId: string): number {
    return readMcpOwnedTargets(this.opts.db, 'session', clientId).filter((row) => this.isLive(row.target_id))
      .length;
  }

  private liveMcpSessions(): number {
    return readMcpOwnedTargets(this.opts.db, 'session').filter((row) => this.isLive(row.target_id)).length;
  }

  private isLive(sessionId: string): boolean {
    const info = this.opts.sessions.find(sessionId);
    return info !== null && (info.status === 'starting' || info.status === 'running');
  }

  ownerOf(kind: 'session' | 'planner_chat', id: string): string | null {
    return readMcpOwnedWork(this.opts.db, kind, id)?.client_id ?? null;
  }

  private assertOwned(kind: 'session' | 'planner_chat', id: string, principal: McpClientIdentity): void {
    if (this.ownerOf(kind, id) !== principal.id) {
      throw new McpWorkError(
        kind === 'session'
          ? `Session ${id} was not started by this MCP client, so it cannot be stopped or interrupted from here.`
          : `Pocket Agent chat ${id} was not created by this MCP client, so it cannot be interrupted from here.`,
        'not_owner',
      );
    }
  }

  /**
   * The gate every work-starting call passes. Two bounds, each for its own
   * runaway: the depth guard stops PocketAgent calling itself through its own
   * MCP registry in a loop, and the session caps stop one caller (or all of
   * them together) taking the machine — the same "slots stay free for you"
   * posture webhook caps take.
   */
  private assertMayStart(principal: McpClientIdentity, depth: number): void {
    if (depth >= MAX_MCP_CALL_DEPTH) {
      throw new McpWorkError(
        `Refusing to start work ${depth} PocketAgent hops deep (the limit is ${MAX_MCP_CALL_DEPTH}), to stop agents calling agents in a loop.`,
        'too_deep',
      );
    }
    if (this.liveSessionsFor(principal.id) >= MCP_MAX_LIVE_SESSIONS_PER_CLIENT) {
      throw new McpWorkError(
        `This MCP client already has ${MCP_MAX_LIVE_SESSIONS_PER_CLIENT} live sessions. Stop one (stop_session) before starting another.`,
        'client_cap',
      );
    }
    const budget = Math.max(1, this.opts.maxSessions - RESERVED_HUMAN_SESSIONS);
    if (this.liveMcpSessions() >= budget) {
      throw new McpWorkError(
        `MCP-started sessions are capped at ${budget} so ${RESERVED_HUMAN_SESSIONS} session slots stay free for a human.`,
        'global_cap',
      );
    }
  }

  // ---- Coding-agent sessions -----------------------------------------------

  async startSession(
    principal: McpClientIdentity,
    depth: number,
    input: StartSessionInput,
  ): Promise<StartSessionResult> {
    this.assertMayStart(principal, depth);

    // Structured only, and never a provider an operator has marked
    // attended-only: the same check cron and webhooks use, so an MCP caller
    // cannot route a repository to a third-party gateway that a human has not
    // opted in to unattended use of.
    const problem = structuredAgentProblem(this.opts.agents, input.agent, 'started over MCP');
    if (problem) throw new McpWorkError(problem, 'agent_not_allowed');

    let cwd: string;
    try {
      cwd = await this.opts.workspaces.resolveWorkspacePath(input.cwd);
    } catch (err) {
      if (err instanceof WorkspaceError) throw new McpWorkError(err.message, err.code);
      throw err;
    }

    // PA-137: claimed before anything is created, so an expired or foreign id
    // refuses the call with nothing started; landed into the tree the
    // session will run in, and removed again if it never starts.
    const staged = this.claimAttachments(principal, input.attachments);

    if (input.worktree === 'new-branch') {
      // Minted, never literal — the repeating-job invariant's reason applies to
      // any caller that can ask twice.
      const base = (input.branchBase ?? input.title ?? 'mcp').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const branchName = mintBranchName(base.replace(/^-+|-+$/g, '') || 'mcp', 'UTC', Date.now());
      try {
        const created = await this.opts.worktrees.create({ projectCwd: cwd, branchMode: 'new', branchName });
        cwd = created.cwd;
      } catch (err) {
        this.opts.attachmentStaging?.release(staged);
        if (err instanceof WorktreeError) throw new McpWorkError(`Could not create a worktree: ${err.message}`, err.code);
        throw err;
      }
    }

    let landed: { attachments: PromptAttachment[]; notes: string[] } = { attachments: [], notes: [] };
    if (staged.length > 0) {
      try {
        landed = await landSessionAttachments(this.opts.attachmentStaging!, cwd, input.agent, staged, this.opts.logger, this.opts.db);
      } catch (err) {
        this.opts.attachmentStaging!.release(staged);
        throw attachmentWorkError(err);
      }
    }

    let session: StructuredLikeSession;
    try {
      const created = await this.opts.sessions.create({
        agent: input.agent,
        cwd,
        cols: 0,
        rows: 0,
        transport: 'structured',
        title: input.title ?? `MCP · ${principal.label}`,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.resumeConversationId !== undefined
          ? { resumeAgentSessionId: input.resumeConversationId, forkSession: false }
          : {}),
      });
      if (created.transport !== 'structured') {
        throw new McpWorkError('This agent produced a terminal session; MCP can only drive structured ones.', 'not_structured');
      }
      session = created as StructuredLikeSession;
    } catch (err) {
      removeLandedAttachments(cwd, landed.attachments);
      if (err instanceof SessionError) throw new McpWorkError(err.message, err.code);
      throw err;
    }

    recordMcpOwnedWork(this.opts.db, {
      kind: 'session',
      target_id: session.id,
      client_id: principal.id,
      client_label: principal.label,
      depth,
    });
    this.opts.logger?.info(
      { mcpClient: principal.label, mcpClientId: principal.id, sessionId: session.id, agent: input.agent, cwd },
      'mcp client started a session',
    );

    const sent = this.deliverPrompt(session, withNotes(input.prompt, landed.notes));
    return { sessionId: session.id, cwd, ...sent };
  }

  /**
   * PA-137: an MCP client's upload ids, claimed under its own principal —
   * the same `mcp:<id>` the REST upload route would use — so one token can
   * never claim another's file. All or none, as for a browser's prompt.
   */
  private claimAttachments(principal: McpClientIdentity, ids: readonly string[] | undefined): StagedAttachment[] {
    if (!ids || ids.length === 0) return [];
    const staging = this.opts.attachmentStaging;
    if (!staging) throw new McpWorkError('This server does not accept attachments over MCP.', 'attachments_unavailable');
    try {
      return staging.take(ids, mcpAttachmentPrincipal(principal));
    } catch (err) {
      throw attachmentWorkError(err);
    }
  }

  /** PA-137: `upload_attachment`. Staged only; a file lands when a prompt names it. */
  async uploadAttachment(
    principal: McpClientIdentity,
    input: { name: string; mediaType?: string; data: Buffer },
  ): Promise<UploadAttachmentResponse> {
    const staging = this.opts.attachmentStaging;
    if (!staging) throw new McpWorkError('This server does not accept attachments over MCP.', 'attachments_unavailable');
    if (input.data.length > MAX_MCP_ATTACHMENT_BYTES) {
      throw new McpWorkError(
        `Files sent over MCP can be at most ${MAX_MCP_ATTACHMENT_BYTES / (1024 * 1024)} MB.`,
        'too_large',
      );
    }
    try {
      const staged = await staging.stage(Readable.from([input.data]), {
        name: input.name,
        mediaType: input.mediaType ?? 'application/octet-stream',
        principal: mcpAttachmentPrincipal(principal),
      });
      // Size and type only — never the name or the bytes.
      this.opts.logger?.info(
        { mcpClient: principal.label, size: staged.size, mediaType: staged.mediaType },
        'mcp client staged an attachment',
      );
      return staged;
    } catch (err) {
      throw attachmentWorkError(err);
    }
  }

  /**
   * Prompt a session — any live structured session, including one a human is
   * using (decided on the ticket). A finished one is resumed into a new
   * session that this client then owns.
   */
  async sendPrompt(
    principal: McpClientIdentity,
    depth: number,
    sessionId: string,
    prompt: string,
    attachmentIds: readonly string[] = [],
  ): Promise<StartSessionResult & { resumedFrom?: string }> {
    const info = this.opts.sessions.find(sessionId);
    if (!info) throw new McpWorkError(`No session ${sessionId}.`, 'not_found');
    if (info.transport !== 'structured') {
      throw new McpWorkError(
        'That is a terminal session. MCP can only prompt structured sessions — writing keystrokes into a TUI has no readiness signal.',
        'not_structured',
      );
    }
    const live = this.opts.sessions.get(sessionId);
    if (live && live.transport === 'structured' && (info.status === 'running' || info.status === 'starting')) {
      const staged = this.claimAttachments(principal, attachmentIds);
      let notes: string[] = [];
      if (staged.length > 0) {
        try {
          notes = (await landSessionAttachments(this.opts.attachmentStaging!, info.cwd, info.agent, staged, this.opts.logger, this.opts.db))
            .notes;
        } catch (err) {
          this.opts.attachmentStaging!.release(staged);
          throw attachmentWorkError(err);
        }
      }
      const sent = this.deliverPrompt(live as StructuredLikeSession, withNotes(prompt, notes));
      this.opts.logger?.info({ mcpClient: principal.label, sessionId }, 'mcp client prompted a session');
      return { sessionId, cwd: info.cwd, ...sent };
    }
    if (!info.agentSessionId) {
      throw new McpWorkError(`Session ${sessionId} has finished and has no conversation to resume.`, 'not_resumable');
    }
    const resumed = await this.startSession(principal, depth, {
      cwd: info.cwd,
      agent: info.agent,
      prompt,
      title: info.title,
      resumeConversationId: info.agentSessionId,
      ...(attachmentIds.length > 0 ? { attachments: [...attachmentIds] } : {}),
    });
    return { ...resumed, resumedFrom: sessionId };
  }

  /**
   * Through the human prompt queue, so a prompt into a tree some *other*
   * session is mid-turn in waits its turn (visible in the project tree,
   * cancellable there) rather than two agents editing one checkout. There is
   * no `force` here: that override exists only where a person is present.
   */
  private deliverPrompt(
    session: StructuredLikeSession,
    prompt: string,
  ): { state: 'running' | 'queued'; queuePosition?: number } {
    const parked = this.opts.promptQueue.submit(session, prompt);
    if (parked.queued) return { state: 'queued', queuePosition: parked.position };
    if (!session.prompt(prompt)) {
      throw new McpWorkError('The session ended before its prompt could be sent.', 'session_ended');
    }
    return { state: 'running' };
  }

  async interruptSession(principal: McpClientIdentity, sessionId: string): Promise<boolean> {
    this.assertOwned('session', sessionId, principal);
    const live = this.opts.sessions.get(sessionId);
    if (!live || live.transport !== 'structured') return false;
    await (live as StructuredLikeSession).interrupt();
    return true;
  }

  stopSession(principal: McpClientIdentity, sessionId: string): void {
    this.assertOwned('session', sessionId, principal);
    try {
      this.opts.sessions.terminate(sessionId);
    } catch (err) {
      if (err instanceof SessionError) throw new McpWorkError(err.message, err.code);
      throw err;
    }
  }

  /** Every event this session has, prior transcript first — the same merge `read_session_output` uses. */
  async sessionEvents(sessionId: string): Promise<{ events: AgentEvent[]; conversationId: string | null }> {
    const live = this.opts.sessions.get(sessionId);
    const { conversationId, events } = await readSessionHistory(this.opts.historyDeps, sessionId);
    if (live && live.transport === 'structured') {
      const buffered = live.buffer.replayAfter(0).events.map((e) => e.event);
      return { events: [...events, ...buffered], conversationId };
    }
    return { events, conversationId };
  }

  /**
   * Wait for the session's current turn to settle, at most `timeoutSec`.
   *
   * Listening happens *before* the state is first evaluated, so a turn that
   * completes between the two cannot be missed — `RunExecutor.watch`'s rule.
   */
  async waitForTurn(
    sessionId: string,
    timeoutSec: number,
    opts: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void } = {},
  ): Promise<TurnResult> {
    const info = this.opts.sessions.find(sessionId);
    if (!info) throw new McpWorkError(`No session ${sessionId}.`, 'not_found');
    const live = this.opts.sessions.get(sessionId);
    if (!live || (info.status !== 'running' && info.status !== 'starting')) {
      return this.sessionResult(sessionId, 'ended', { status: info.status });
    }
    if (live.transport !== 'structured') {
      throw new McpWorkError('That is a terminal session; it has no end-of-turn signal to wait for.', 'not_structured');
    }
    const session = live as StructuredLikeSession;
    const timeoutMs = clampSeconds(timeoutSec) * 1000;

    const outcome = await new Promise<{ state: McpTurnState; turn?: AgentEvent }>((resolve) => {
      const started = Date.now();
      let done = false;
      const finish = (value: { state: McpTurnState; turn?: AgentEvent }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(progress);
        session.off('event', onEvent);
        session.off('permission', onPermission);
        session.off('exit', onExit);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onEvent = (_seq: number, event: AgentEvent): void => {
        if (event.kind !== 'turn_complete') return;
        // A prompt this session has waiting in the queue means the *caller's*
        // turn has not started yet; the turn that just ended was someone else's.
        if (this.opts.promptQueue.forSession(sessionId).length > 0) return;
        finish({ state: 'complete', turn: event });
      };
      const onPermission = (pending: PermissionRequestEvent[]): void => {
        if (pending.length > 0) finish({ state: 'awaiting_approval' });
      };
      const onExit = (): void => finish({ state: 'ended' });
      const onAbort = (): void => finish({ state: 'still_running' });
      const timer = setTimeout(() => finish({ state: 'still_running' }), timeoutMs);
      const progress = setInterval(() => opts.onProgress?.(Date.now() - started), PROGRESS_INTERVAL_MS);
      session.on('event', onEvent);
      session.on('permission', onPermission);
      session.on('exit', onExit);
      opts.signal?.addEventListener('abort', onAbort);

      // Now evaluate what is already true.
      if (session.pendingPermissions().length > 0) return finish({ state: 'awaiting_approval' });
      const queued = this.opts.promptQueue.forSession(sessionId);
      if (queued.length > 0) return; // waits for the queued prompt's own turn
      if (session.busySince === null) finish({ state: 'complete' });
    });

    let state = outcome.state;
    if (state === 'still_running' && this.opts.promptQueue.forSession(sessionId).length > 0) state = 'queued';
    return this.sessionResult(sessionId, state, { turn: outcome.turn });
  }

  /** What `start_session`/`send_prompt` report without waiting. */
  async sessionResult(
    sessionId: string,
    state: McpTurnState,
    extra: { turn?: AgentEvent; status?: string } = {},
  ): Promise<TurnResult> {
    const result: TurnResult = { state, sessionId };
    const info = this.opts.sessions.find(sessionId);
    if (info) result.status = extra.status ?? info.status;
    const live = this.opts.sessions.get(sessionId);
    if (state === 'awaiting_approval' && live && live.transport === 'structured') {
      result.pendingApprovals = (live as StructuredLikeSession).pendingPermissions().map(approvalSummary);
      result.note =
        'A human must answer this approval in PocketAgent. MCP clients cannot approve or deny tool calls. ' +
        'Call wait_for_turn again later; the turn resumes as soon as it is answered.';
    }
    if (state === 'queued') {
      const queued = this.opts.promptQueue.forSession(sessionId)[0];
      if (queued) result.queuePosition = queued.position;
      result.note = 'Another session is mid-turn in the same working tree; this prompt goes in when it finishes.';
    }
    if (state === 'complete' || state === 'ended') {
      const { events } = await this.sessionEvents(sessionId);
      result.finalText = lastTurnText(events);
      const turn = extra.turn ?? [...events].reverse().find((e) => e.kind === 'turn_complete');
      if (turn && turn.kind === 'turn_complete') {
        result.isError = turn.isError;
        result.durationMs = turn.durationMs;
        result.costUsd = turn.costUsd;
      }
    }
    return result;
  }

  // ---- Pocket Agent chats ---------------------------------------------------

  createPocketChat(
    principal: McpClientIdentity,
    depth: number,
    input: { workspaceId: string; title?: string; modelId?: string },
  ): string {
    if (depth >= MAX_MCP_CALL_DEPTH) {
      throw new McpWorkError(
        `Refusing to start work ${depth} PocketAgent hops deep (the limit is ${MAX_MCP_CALL_DEPTH}).`,
        'too_deep',
      );
    }
    try {
      // `skipToolApprovals` is deliberately never passed: it is a server-only
      // field (the fifth override) that only an unattended trigger with its
      // own skip decision may set, and an MCP caller has no such decision.
      const chat = this.opts.plannerChats.create({
        workspaceId: input.workspaceId,
        title: input.title ?? `MCP · ${principal.label}`,
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
      });
      recordMcpOwnedWork(this.opts.db, {
        kind: 'planner_chat',
        target_id: chat.id,
        client_id: principal.id,
        client_label: principal.label,
        depth,
      });
      this.opts.logger?.info({ mcpClient: principal.label, chatId: chat.id }, 'mcp client created a pocket agent chat');
      return chat.id;
    } catch (err) {
      if (err instanceof PlannerChatError) throw new McpWorkError(err.message, err.code);
      throw err;
    }
  }

  /**
   * Send a message and drive the turn — `startPocketAgent`'s shape: observe
   * before the generator's first `next()`, await that first step so a
   * precondition failure is an error the caller sees, then pump the rest in
   * the background. The observer, not the drain, is what settles a wait,
   * because a turn parked on an approval ends its generator while still
   * genuinely running.
   */
  async sendPocketMessage(
    principal: McpClientIdentity,
    chatId: string,
    content: string,
    attachmentIds: readonly string[] = [],
  ): Promise<void> {
    const planner = this.opts.plannerChats;
    if (!planner.get(chatId)) throw new McpWorkError(`No Pocket Agent chat ${chatId}.`, 'not_found');
    // PA-137: the web chat's order — preconditions, claim, land — so a
    // refused message lands nothing.
    let attachments: PromptAttachment[] = [];
    if (attachmentIds.length > 0) {
      try {
        planner.assertCanAcceptFiles(chatId, 'send');
      } catch (err) {
        if (err instanceof PlannerChatError) throw new McpWorkError(err.message, err.code);
        throw err;
      }
      const staged = this.claimAttachments(principal, attachmentIds);
      try {
        attachments = await planner.landAttachments(chatId, this.opts.attachmentStaging!, staged);
      } catch (err) {
        throw attachmentWorkError(err);
      }
    }
    const turn = planner.sendMessage(chatId, content, attachments.length > 0 ? { attachments } : {});
    try {
      const first = await turn.next();
      if (first.done === true) throw new McpWorkError('The Pocket Agent turn ended without producing anything.', 'empty_turn');
    } catch (err) {
      if (!(err instanceof McpWorkError)) planner.removeAttachments(chatId, attachments);
      if (err instanceof PlannerChatError) throw new McpWorkError(err.message, err.code);
      throw err;
    }
    this.opts.logger?.info({ mcpClient: principal.label, chatId }, 'mcp client messaged a pocket agent chat');
    void (async () => {
      try {
        while (!(await turn.next()).done) {
          /* pump */
        }
      } catch (err) {
        this.opts.logger?.warn({ err, chatId }, 'mcp-driven pocket agent turn failed while streaming');
      }
    })();
  }

  async waitForPocketTurn(
    chatId: string,
    timeoutSec: number,
    opts: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void } = {},
  ): Promise<TurnResult> {
    const planner = this.opts.plannerChats;
    if (!planner.get(chatId)) throw new McpWorkError(`No Pocket Agent chat ${chatId}.`, 'not_found');
    const timeoutMs = clampSeconds(timeoutSec) * 1000;
    // A turn already parked on an approval produces no further events until a
    // human answers, so waiting on it would only burn the caller's timeout.
    const parked =
      planner.isBusy(chatId) && hasOpenApproval(await planner.history(chatId).catch(() => [] as AgentEvent[]));

    const outcome = await new Promise<{ state: McpTurnState; pending?: PermissionRequestEvent }>((resolve) => {
      const started = Date.now();
      let done = false;
      const finish = (value: { state: McpTurnState; pending?: PermissionRequestEvent }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(progress);
        unsubscribe();
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const unsubscribe = planner.observe(chatId, (event) => {
        if (event.kind === 'turn_complete') finish({ state: 'complete' });
        if (event.kind === 'permission_request') finish({ state: 'awaiting_approval', pending: event });
      });
      const onAbort = (): void => finish({ state: 'still_running' });
      const timer = setTimeout(() => finish({ state: 'still_running' }), timeoutMs);
      const progress = setInterval(() => opts.onProgress?.(Date.now() - started), PROGRESS_INTERVAL_MS);
      opts.signal?.addEventListener('abort', onAbort);
      if (parked) finish({ state: 'awaiting_approval' });
      else if (!planner.isBusy(chatId)) finish({ state: 'complete' });
    });

    const result: TurnResult = { state: outcome.state, chatId };
    const events = await planner.history(chatId).catch(() => [] as AgentEvent[]);
    if (outcome.state === 'awaiting_approval' || (outcome.state === 'still_running' && hasOpenApproval(events))) {
      result.state = 'awaiting_approval';
      const pending = outcome.pending ?? lastOpenApproval(events);
      if (pending) result.pendingApprovals = [approvalSummary(pending)];
      result.note =
        'A human must answer this approval in PocketAgent. MCP clients cannot approve or deny tool calls.';
    }
    if (result.state === 'complete') {
      result.finalText = lastTurnText(events);
      const turn = [...events].reverse().find((e) => e.kind === 'turn_complete');
      if (turn && turn.kind === 'turn_complete') {
        result.isError = turn.isError;
        result.durationMs = turn.durationMs;
      }
    }
    return result;
  }

  async interruptPocketChat(principal: McpClientIdentity, chatId: string): Promise<boolean> {
    this.assertOwned('planner_chat', chatId, principal);
    return this.opts.plannerChats.interrupt(chatId);
  }
}

function clampSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(0, Math.floor(value)));
}

function approvalSummary(event: PermissionRequestEvent): PendingApprovalSummary {
  return { requestId: event.id, toolName: event.toolName, title: event.title, filePath: event.filePath };
}

/**
 * The assistant text of the most recent turn: every `text` event after the
 * last `user_prompt`. Falls back to the readable summary when a turn produced
 * no text at all (all tool calls), so a caller never gets an empty answer it
 * cannot interpret.
 */
export function lastTurnText(events: readonly AgentEvent[]): string | null {
  const texts: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'user_prompt') break;
    // PA-121: a Pocket Agent turn's `interim` narration is not its answer.
    if (event.kind === 'text' && !event.interim && event.text.trim().length > 0) texts.unshift(event.text);
  }
  if (texts.length > 0) return truncateTail(texts.join('\n\n'), MAX_RESULT_CHARS);
  if (events.length === 0) return null;
  return truncateTail(summarizeEvents(events), MAX_RESULT_CHARS);
}

function lastOpenApproval(events: readonly AgentEvent[]): PermissionRequestEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'turn_complete' || event.kind === 'permission_resolved') return null;
    if (event.kind === 'permission_request') return event;
  }
  return null;
}

function hasOpenApproval(events: readonly AgentEvent[]): boolean {
  return lastOpenApproval(events) !== null;
}

/** PA-137: the staging principal of an MCP client — `attachmentPrincipal`'s `mcp:<id>`. */
function mcpAttachmentPrincipal(principal: McpClientIdentity): string {
  return `mcp:${principal.id}`;
}

function attachmentWorkError(err: unknown): McpWorkError | Error {
  if (err instanceof AttachmentError) return new McpWorkError(err.message, `attachment_${err.code}`);
  if (err instanceof PlannerChatError) return new McpWorkError(err.message, err.code);
  return err instanceof Error ? err : new Error(String(err));
}

function withNotes(prompt: string, notes: readonly string[]): string {
  if (notes.length === 0) return prompt;
  const block = notes.join('\n');
  return prompt ? `${prompt}\n\n${block}` : block;
}
