import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentEvent, PermissionDecision, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizeCodexEvent, type CodexIncoming } from './normalize.js';
import type { CodexServerManager } from './codex-server.js';
import type { StructuredSessionEvents } from './structured-session.js';

export interface CodexSessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** codex's own thread id, to resume via `thread/resume` instead of `thread/start`. */
  resumeAgentSessionId?: string;
  /**
   * Explicit, off-by-default opt-in to auto-approving every command/file
   * change. Real per-session choice, same reasoning as `OpencodeSessionSpec`:
   * `codex app-server` has a genuine synchronous approval gate, so this is
   * PocketAgent choosing not to use it — not a limit of the CLI.
   */
  skipPermissions?: boolean;
}

interface PendingApproval {
  event: PermissionRequestEvent;
  requestId: number;
}

/**
 * An agent driven through `codex app-server`'s JSON-RPC protocol.
 *
 * One `thread` (codex's term) per `CodexSession`, all sharing one
 * `codex app-server` process via `CodexServerManager` — see that class for
 * why. Approval requests (`item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`) are genuine server->client JSON-RPC
 * requests that block the tool call until replied to; this is the one of the
 * three structured engines in this codebase where that is actually true
 * (`AgySession`'s headless mode has no such gate; `StructuredSession` and
 * `OpencodeSession` do).
 *
 * No slash-command picker here, unlike `StructuredSession`/`AgySession`/
 * `PiSession`: confirmed via `codex app-server generate-json-schema --out
 * <dir> --experimental` (real, installed v0.147.0) that the app-server
 * protocol has no command-list method and no text-based `/name` convention
 * on `turn/start`'s input — every equivalent feature (`thread/compact/start`,
 * `model/list`, `skills/list`, ...) is its own distinct JSON-RPC method, not
 * something a human types. That parsing lives in the TUI, which this class
 * bypasses entirely, so there is nothing here to build a uniform picker on
 * top of without hand-mapping each command name to its own RPC call — a
 * materially bigger, separate feature, not this one.
 */
export class CodexSession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: CodexSessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private readonly pending = new Map<string, PendingApproval>();

  private _status: SessionStatus = 'starting';
  private _threadId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;
  private _globalBypass = false;
  private _startError: string | null = null;
  /** Cached from the latest `thread/tokenUsage/updated` — `turn/completed` carries none of its own. */
  private _lastUsage: { input: number | null; output: number | null } | null = null;

  constructor(
    spec: CodexSessionSpec,
    private readonly server: CodexServerManager,
    epoch?: string,
  ) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this._threadId = spec.resumeAgentSessionId ?? null;
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
    return null;
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
    return 'codex-app-server';
  }
  get survivesServerRestart(): boolean {
    // Same reasoning as the other two: the wrapper does not survive, but
    // codex persists the thread itself, resumable via `agentSessionId`.
    return false;
  }
  get agentSessionId(): string | null {
    return this._threadId;
  }
  get busy(): boolean {
    return this._busy;
  }
  get globalBypassActive(): boolean {
    return this._globalBypass;
  }
  /** No transcript store this server knows how to read; the fixed creation-time title stands. */
  get derivedTitle(): string | null {
    return null;
  }
  setDerivedTitle(_title: string): void {
    // No-op: see `derivedTitle`.
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  // ---- Lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    try {
      if (this._threadId) {
        await this.server.sendRequest('thread/resume', { threadId: this._threadId });
      } else {
        const result = await this.server.sendRequest<{ thread: { id: string } }>('thread/start', {
          cwd: this.spec.cwd,
        });
        this._threadId = result.thread.id;
      }
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    this.server.register(this._threadId, (message) => this.handleMessage(message));

    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');

    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this._threadId,
      model: null,
      cwd: this.spec.cwd,
      tools: [],
      permissionMode: this.spec.skipPermissions ? 'bypassPermissions' : 'default',
    });
  }

  private handleMessage(message: CodexIncoming): void {
    this._lastActivityAt = Date.now();

    // `thread/tokenUsage/updated` carries no renderable event of its own —
    // it exists purely to enrich the `turn_complete` that `turn/completed`
    // produces, the same two-step pattern `OpencodeSession` uses for cost.
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = isRecord(message.params.tokenUsage) ? message.params.tokenUsage : {};
      const last = isRecord(usage.last) ? usage.last : {};
      this._lastUsage = {
        input: typeof last.inputTokens === 'number' ? last.inputTokens : null,
        output: typeof last.outputTokens === 'number' ? last.outputTokens : null,
      };
      return;
    }

    for (const event of normalizeCodexEventSafe(message)) {
      if (event.kind === 'permission_request') {
        if (message.id === undefined) continue; // Cannot happen in practice; normalizeCodexEvent already checks this.
        this.handlePermissionRequest(event, message.id);
        continue;
      }
      if (event.kind === 'turn_complete') {
        this._busy = false;
        this.emitEvent(this._lastUsage ? { ...event, ...usageFields(this._lastUsage) } : event);
        this._lastUsage = null;
        continue;
      }
      this.emitEvent(event);
    }
  }

  private handlePermissionRequest(event: PermissionRequestEvent, requestId: number): void {
    if (this.spec.skipPermissions || this._globalBypass) {
      // Realized here, the same way as `OpencodeSession`: there is no
      // spawn-time bypass flag for `app-server` mode, so PocketAgent replies
      // for the user instead of ever surfacing the request. `acceptForSession`
      // (not a bare `accept`) so it actually stops asking for the rest of
      // this thread, matching "skip approvals for this session".
      this.server.replyToServerRequest(requestId, { decision: 'acceptForSession' });
      return;
    }
    this.pending.set(event.id, { event, requestId });
    this.emitEvent(event);
    this.emit('permission', this.pendingPermissions());
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

  // ---- Conversation ------------------------------------------------------------

  prompt(text: string): boolean {
    if (!this.isAlive() || !this._threadId) return false;
    this._lastActivityAt = Date.now();
    this._busy = true;
    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    void this.server
      .sendRequest('turn/start', { threadId: this._threadId, input: [{ type: 'text', text }] })
      .catch((err: unknown) => {
        this._busy = false;
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: `Failed to send the prompt: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this._threadId) return;
    try {
      await this.server.sendRequest('turn/interrupt', { threadId: this._threadId });
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** See `StructuredSession.applyGlobalSkipPermissions` — same override, same reasoning. */
  async applyGlobalSkipPermissions(enabled: boolean): Promise<void> {
    this._globalBypass = enabled;
    if (!enabled) return;
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, 'allow_session');
  }

  // ---- Approvals -----------------------------------------------------------------

  pendingPermissions(): PermissionRequestEvent[] {
    return [...this.pending.values()].map((p) => p.event);
  }

  resolvePermission(id: string, decision: PermissionDecision, message?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this._lastActivityAt = Date.now();

    // "decline" (not "cancel"): the turn continues, the same way denying one
    // tool call in Claude's flow does not end the conversation.
    const jsonDecision = decision === 'deny' ? 'decline' : decision === 'allow_session' ? 'acceptForSession' : 'accept';
    this.server.replyToServerRequest(entry.requestId, { decision: jsonDecision });

    this.emitEvent({
      kind: 'permission_resolved',
      id,
      decision,
      message: message?.trim() || null,
    });
    this.emit('permission', this.pendingPermissions());
    return true;
  }

  // ---- Teardown --------------------------------------------------------------------

  /**
   * Stops this chat's own view of things and interrupts any in-flight turn.
   * Deliberately does not archive/delete the codex-side thread — same
   * reasoning as `StructuredSession`/`OpencodeSession`: the wrapper ends, the
   * conversation is codex's to keep, resumable later via `agentSessionId`.
   */
  terminate(_graceMs?: number): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this._endedAt = Date.now();
    this.setStatus('killed');

    if (this._threadId) {
      this.server.unregister(this._threadId);
      this.server.sendRequest('turn/interrupt', { threadId: this._threadId }).catch(() => undefined);
    }
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    if (this._threadId) this.server.unregister(this._threadId);
    this.pending.clear();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}

  /** Called by `SessionManager` when the shared `codex app-server` process dies mid-session. */
  markServerCrashed(): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this._busy = false;
    this._startError = 'The codex app-server process exited unexpectedly.';
    this._endedAt = Date.now();
    this.setStatus('error');
    this.emitEvent({ kind: 'notice', level: 'error', text: this._startError });
    this.emit('exit', null, null);
  }
}

function usageFields(usage: { input: number | null; output: number | null }): {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  return { costUsd: null, inputTokens: usage.input, outputTokens: usage.output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never let one malformed codex payload kill this session's event handling. */
function normalizeCodexEventSafe(message: CodexIncoming): AgentEvent[] {
  try {
    return normalizeCodexEvent(message);
  } catch {
    return [];
  }
}
