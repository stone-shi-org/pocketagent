import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query, type Options, type PermissionResult, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequestEvent,
  SessionStatus,
} from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizeSdkMessage, summarizeToolUse } from './normalize.js';

export interface StructuredSessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  env: Record<string, string>;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** Resume a prior agent conversation instead of starting fresh. */
  resumeAgentSessionId?: string;
  /**
   * Branch onto a new conversation id when resuming.
   *
   * Without this, two processes resuming the same id append to one transcript
   * and neither sees the other's turns. Forking keeps the original intact.
   */
  forkSession?: boolean;
  /** Hard ceiling on spend for one session. Undefined means no limit. */
  maxBudgetUsd?: number;
  /** Absolute path to the agent executable, when not on PATH. */
  executablePath?: string;
}

export interface StructuredSessionEvents {
  event: [seq: number, event: AgentEvent];
  status: [status: SessionStatus];
  exit: [exitCode: number | null, exitSignal: number | null];
  /** Raised when an approval starts or stops waiting, for push notifications. */
  permission: [pending: PermissionRequestEvent[]];
}

interface PendingPermission {
  event: PermissionRequestEvent;
  suggestions: unknown[];
  resolve: (result: PermissionResult) => void;
}

/**
 * An agent driven through the Claude Agent SDK rather than a pseudo-terminal.
 *
 * The trade against PtySession is deliberate: this gives up universality (only
 * agents with a structured mode work) and exact fidelity (we render the UI, so
 * new agent-side affordances need UI work here) in exchange for a native
 * interface — real markdown, foldable reasoning, tool cards, and approvals as
 * buttons instead of keystrokes.
 */
export class StructuredSession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: StructuredSessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private queryHandle: Query | null = null;
  private abort = new AbortController();
  private inbox: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  private readonly pending = new Map<string, PendingPermission>();

  private _status: SessionStatus = 'starting';
  private _agentSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _exitCode: number | null = null;
  private _startError: string | null = null;
  /** True while the agent is mid-turn, as opposed to idle awaiting a prompt. */
  private _busy = false;

  constructor(spec: StructuredSessionSpec, epoch?: string) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this._agentSessionId = spec.resumeAgentSessionId ?? null;
  }

  // ---- Shared session surface ---------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }
  get pid(): number | null {
    return null;
  }
  get cols(): number {
    return 0;
  }
  get rows(): number {
    return 0;
  }
  get exitCode(): number | null {
    return this._exitCode;
  }
  get exitSignal(): number | null {
    return null;
  }
  get startedAt(): number | null {
    return this._startedAt;
  }
  get endedAt(): number | null {
    return this._endedAt;
  }
  get lastActivityAt(): number | null {
    return this._lastActivityAt;
  }
  get startError(): string | null {
    return this._startError;
  }
  get externalId(): string | null {
    return null;
  }
  get backendId(): string {
    return 'agent-sdk';
  }
  get survivesServerRestart(): boolean {
    // The process does not survive, but the *conversation* does: the agent
    // persists its own history, so a new session can resume from the id.
    return false;
  }
  get agentSessionId(): string | null {
    return this._agentSessionId;
  }
  get busy(): boolean {
    return this._busy;
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  // ---- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.queryHandle) throw new Error('session already started');

    const options: Options = {
      cwd: this.spec.cwd,
      env: this.spec.env,
      abortController: this.abort,
      // Every tool call comes back to us; nothing is auto-approved server-side.
      permissionMode: 'default',
      canUseTool: (toolName, input, opts) => this.requestPermission(toolName, input, opts),
      includePartialMessages: true,
      ...(this.spec.resumeAgentSessionId ? { resume: this.spec.resumeAgentSessionId } : {}),
      ...(this.spec.resumeAgentSessionId && this.spec.forkSession === true
        ? { forkSession: true }
        : {}),
      ...(this.spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.spec.maxBudgetUsd } : {}),
      ...(this.spec.executablePath ? { pathToClaudeCodeExecutable: this.spec.executablePath } : {}),
    };

    try {
      this.queryHandle = query({ prompt: this.inputStream(), options });
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');
    void this.pump();
  }

  /**
   * The SDK consumes prompts as an async iterable. This turns it into a queue
   * we can push into whenever the user sends a turn, which is what makes the
   * session multi-turn rather than one-shot.
   */
  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      if (this.inbox.length === 0) {
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        continue;
      }
      const next = this.inbox.shift();
      if (next) yield next;
    }
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.();
  }

  private async pump(): Promise<void> {
    const handle = this.queryHandle;
    if (!handle) return;

    try {
      for await (const message of handle) {
        this._lastActivityAt = Date.now();
        for (const event of normalizeSdkMessageSafe(message)) {
          if (event.kind === 'session_started' && event.agentSessionId) {
            this._agentSessionId = event.agentSessionId;
          }
          if (event.kind === 'turn_complete') this._busy = false;
          this.emitEvent(event);
        }
      }
    } catch (err) {
      if (!this.abort.signal.aborted) {
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
        this._startError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.finish();
    }
  }

  private finish(): void {
    if (!this.isAlive()) return;
    this.rejectAllPending('Session ended before this request was answered.');
    this._endedAt = Date.now();
    this._busy = false;
    this.setStatus(this.abort.signal.aborted ? 'killed' : 'exited');
    this.emit('exit', this._exitCode, null);
  }

  private emitEvent(event: AgentEvent): void {
    const entry = this.buffer.append(event);
    this.emit('event', entry.seq, entry.event);
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  // ---- Conversation --------------------------------------------------------

  /** Queue a user turn. Safe to call while the agent is still working. */
  prompt(text: string): boolean {
    if (!this.isAlive()) return false;
    this._lastActivityAt = Date.now();
    this._busy = true;

    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this._agentSessionId ?? '',
    } as SDKUserMessage);
    this.wake();
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.queryHandle || !this.isAlive()) return;
    try {
      await this.queryHandle.interrupt();
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---- Approvals -----------------------------------------------------------

  /**
   * Called by the SDK when the agent wants to use a tool that needs consent.
   *
   * Returning a promise parks the agent until a human answers. There is no
   * timeout by design — an unanswered approval must never silently become an
   * allow, and turning it into a deny would lose work the user may have simply
   * not looked at yet.
   */
  private requestPermission(
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal;
      suggestions?: unknown[];
      blockedPath?: string;
      decisionReason?: string;
      title?: string;
      displayName?: string;
    },
  ): Promise<PermissionResult> {
    const id = crypto.randomBytes(8).toString('base64url');
    const suggestions = opts.suggestions ?? [];

    const event: PermissionRequestEvent = {
      kind: 'permission_request',
      id,
      toolName,
      input,
      // Prefer the SDK's own rendered sentence so the phone shows exactly what
      // the terminal would have shown; fall back to the same summary the tool
      // cards use, which reads far better than a bare tool name.
      title: opts.title ?? `Allow: ${summarizeToolUse(toolName, input)}?`,
      displayName: opts.displayName ?? null,
      filePath: opts.blockedPath ?? extractPathSafe(input),
      reason: opts.decisionReason ?? null,
      canAllowForSession: suggestions.length > 0,
    };

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { event, suggestions, resolve });
      this.emitEvent(event);
      this.emit('permission', this.pendingPermissions());

      const onAbort = (): void => {
        if (!this.pending.delete(id)) return;
        this.emit('permission', this.pendingPermissions());
        resolve({ behavior: 'deny', message: 'Cancelled.' });
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Answer a pending approval. Returns false if the id is unknown or stale. */
  resolvePermission(id: string, decision: PermissionDecision, message?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this._lastActivityAt = Date.now();

    if (decision === 'deny') {
      entry.resolve({
        behavior: 'deny',
        message: message?.trim() || 'The user declined this action.',
      });
    } else if (decision === 'allow_session' && entry.suggestions.length > 0) {
      // Adopt the SDK's own suggested rules so it stops asking for this class
      // of action — the equivalent of "don't ask again" in the terminal.
      entry.resolve({
        behavior: 'allow',
        updatedPermissions: entry.suggestions as never,
      });
    } else {
      entry.resolve({ behavior: 'allow' });
    }

    this.emitEvent({
      kind: 'permission_resolved',
      id,
      decision,
      message: message?.trim() || null,
    });
    this.emit('permission', this.pendingPermissions());
    return true;
  }

  pendingPermissions(): PermissionRequestEvent[] {
    return [...this.pending.values()].map((p) => p.event);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      entry.resolve({ behavior: 'deny', message: reason });
      this.pending.delete(id);
    }
    this.emit('permission', []);
  }

  // ---- Teardown ------------------------------------------------------------

  terminate(_graceMs?: number): void {
    if (!this.isAlive()) return;
    this.rejectAllPending('Session terminated.');
    this.closed = true;
    this.wake();
    this.abort.abort();
    this.setStatus('killed');
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    this.closed = true;
    this.wake();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}
}

function extractPathSafe(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = input[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** Never let one malformed SDK payload kill the pump loop. */
function normalizeSdkMessageSafe(message: unknown): AgentEvent[] {
  try {
    return normalizeSdkMessage(message);
  } catch {
    return [];
  }
}

