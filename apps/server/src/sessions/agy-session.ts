import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequestEvent,
  PromptImage,
  SessionStatus,
} from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import {
  extractAgyPath,
  isAgyQuotaError,
  normalizeAgyAcpModels,
  normalizeAgyAcpUpdate,
  summarizeAgyTool,
} from './normalize.js';
import type { StructuredSessionEvents } from './structured-session.js';

export interface AgySessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  env: Record<string, string>;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** agy's own conversation UUID, to continue via ACP `session/resume`. */
  resumeAgentSessionId?: string;
  /** Absolute path to the `agy` executable, when not on PATH. */
  executablePath?: string;
  /** Initial model to switch to right after handshake, or absent for default. */
  model?: string;
  /**
   * Explicit, off-by-default opt-in to `--dangerously-skip-permissions`.
   * When false/absent, `agy acp` routes approval requests over ACP
   * `session/request_permission` into the browser approval sheet.
   */
  skipPermissions?: boolean;
  /**
   * PA-75: the Pocket Agent chat that created this session via
   * `start_subagent_session`, or null for human/trigger sessions.
   */
  plannerChatId?: string | null;
}

interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

interface PendingAcpPermission {
  event: PermissionRequestEvent;
  rpcId: string | number;
  options: AcpPermissionOption[];
}

interface PendingRpc {
  method: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface QueuedPrompt {
  text: string;
  image?: PromptImage;
}

interface ActiveTurn {
  readonly prompt: QueuedPrompt;
  readonly attempt: number;
  readonly startedAt: number;
  interrupted: boolean;
}

/**
 * An agent driven by Google's `agy` CLI over its Agent Client Protocol stdio
 * server (`agy acp`): **one long-lived process per session**, speaking
 * newline-delimited JSON-RPC 2.0 over stdin/stdout.
 *
 * Compared to the old headless `--input-format stream-json` driver, ACP gives
 * PocketAgent:
 *  - A real, synchronous approval gate (`session/request_permission`), parked
 *    with no timeout until a human responds in the browser.
 *  - Automatic AI-generated session titles (`session_info_update`, plus
 *    on-disk `annotations/<id>.pbtxt` and `conversation_summaries.db`).
 *  - Live model switching (`session/set_model`), model catalog (`session/new`),
 *    slash command discovery (`available_commands_update`), and per-turn token
 *    usage directly in `session/prompt` responses — eliminating the extra
 *    `agy models` and `agy -p /help` probe subprocesses and `makeStatsPerTurn`.
 *  - Background `run_command` survival across turns because the `agy acp`
 *    process stays alive; reactive `session/update` notifications pushed after
 *    `end_turn` continue streaming to the client while idle.
 *
 * Note on global skip-permissions: `agy acp` exposes `default`, `accept-edits`,
 * `auto`, and `plan` modes, but no live "bypass all" mode — `--dangerously-skip-permissions`
 * is spawn-time only. `applyGlobalSkipPermissions` is therefore a no-op (same
 * posture as terminal sessions); new sessions inherit the global switch at
 * creation via `SessionManager.create`.
 */
export class AgySession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: AgySessionSpec;
  readonly plannerChatId: string | null;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRpcId = 1;
  private readonly pendingRpc = new Map<number, PendingRpc>();
  private readonly pending = new Map<string, PendingAcpPermission>();
  private stderrTail = '';

  private readonly queue: QueuedPrompt[] = [];
  private draining = false;
  private closed = false;
  private activeTurn: ActiveTurn | null = null;
  private cancelPendingRetry: (() => void) | null = null;

  private _desiredModel: string | null = null;
  private _status: SessionStatus = 'starting';
  private _agentSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;
  private _busySince: number | null = null;
  private _derivedTitle: string | null = null;

  /**
   * Streamed prose and reasoning accumulators. The web client's `dropStreaming`
   * discards unfinalized `text_delta`/`thinking_delta` blocks when a turn ends
   * or a new block starts, so we flush these into finalized `text`/`thinking`
   * events before each `tool_call` and before `turn_complete`.
   */
  private streamedText = '';
  private streamedThought = '';
  private messageSeq = 0;
  private thoughtSeq = 0;
  private idleFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private static readonly MAX_TURN_RETRIES = 2;
  private static readonly RETRY_BACKOFF_MS = [1000, 3000];
  private static readonly TRANSIENT_ERROR_PATTERN =
    /\btimed?\s*out\b|deadline exceeded|context canceled|context cancelled|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network error|connection reset|\bunavailable\b|stream (?:was )?interrupted/i;

  constructor(spec: AgySessionSpec, epoch?: string) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.plannerChatId = spec.plannerChatId ?? null;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this._agentSessionId = spec.resumeAgentSessionId ?? null;
    this._desiredModel = spec.model ?? null;
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
    return null;
  }
  get externalId(): string | null {
    return null;
  }
  get backendId(): string {
    return 'agy-cli';
  }
  get survivesServerRestart(): boolean {
    // No process survives, but the conversation does via ACP `session/resume`.
    return false;
  }
  get agentSessionId(): string | null {
    return this._agentSessionId;
  }
  get busy(): boolean {
    return this._busy;
  }
  get busySince(): number | null {
    return this._busySince;
  }
  /** `--dangerously-skip-permissions` is spawn-time only in `agy acp`. */
  get globalBypassActive(): boolean {
    return false;
  }
  get derivedTitle(): string | null {
    return this._derivedTitle;
  }
  setDerivedTitle(title: string): void {
    this._derivedTitle = title;
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  // ---- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    await this.spawnAndHandshake();
    if (!this.closed) {
      this.setStatus('running');
    }
  }

  /**
   * Spawn `agy acp`, perform the ACP `initialize` handshake, and open or
   * resume the session. Throws if the process cannot start or fails handshake.
   */
  private async spawnAndHandshake(): Promise<void> {
    const args = ['acp', '--add-dir', this.spec.cwd];
    if (this.spec.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }

    const bin = this.spec.executablePath ?? 'agy';
    const child = spawn(bin, args, { cwd: this.spec.cwd, env: this.spec.env });
    this.child = child;
    this.stderrTail = '';

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleLine(child, line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => this.onChildClose(child, null, null, `agy failed to start: ${err.message}`));
    child.on('close', (code, signal) => this.onChildClose(child, code, signal, null));

    await this.rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'pocketagent', version: '1.0.0' },
    });

    const isResume = this._agentSessionId !== null;
    const sessionRes = (await this.rpc(
      isResume ? 'session/resume' : 'session/new',
      isResume
        ? { sessionId: this._agentSessionId, cwd: this.spec.cwd, mcpServers: [] }
        : { cwd: this.spec.cwd, mcpServers: [] },
    )) as Record<string, unknown> | null;

    const sessionId =
      isRecord(sessionRes) && typeof sessionRes.sessionId === 'string'
        ? sessionRes.sessionId
        : this._agentSessionId;
    if (sessionId) {
      this._agentSessionId = sessionId;
    }

    const models = isRecord(sessionRes) ? normalizeAgyAcpModels(sessionRes.models) : [];
    if (models.length > 0) {
      this.emitEvent({ kind: 'models_available', models });
    }

    const currentModelId =
      isRecord(sessionRes) && isRecord(sessionRes.models) && typeof sessionRes.models.currentModelId === 'string'
        ? sessionRes.models.currentModelId
        : null;
    const currentModeId =
      isRecord(sessionRes) && isRecord(sessionRes.modes) && typeof sessionRes.modes.currentModeId === 'string'
        ? sessionRes.modes.currentModeId
        : null;

    if (this._desiredModel && this._agentSessionId && this._desiredModel !== currentModelId) {
      try {
        await this.rpc('session/set_model', {
          sessionId: this._agentSessionId,
          modelId: this._desiredModel,
        });
        this.emitEvent({ kind: 'model_changed', model: this._desiredModel });
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to set initial model (${this._desiredModel}): ${errText(err)}`,
        });
      }
    } else if (this._desiredModel) {
      this.emitEvent({ kind: 'model_changed', model: this._desiredModel });
    }

    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this._agentSessionId,
      model: this._desiredModel ?? currentModelId,
      cwd: this.spec.cwd,
      tools: [],
      permissionMode: this.spec.skipPermissions ? 'always-proceed' : (currentModeId ?? 'default'),
    });
  }

  /**
   * Switch the active model live via ACP `session/set_model` — no process
   * recycle needed, so any background tasks remain untouched.
   */
  async setModel(model: string): Promise<void> {
    if (!this.isAlive()) return;
    this._desiredModel = model;
    if (this.child && this._agentSessionId) {
      try {
        await this.rpc('session/set_model', {
          sessionId: this._agentSessionId,
          modelId: model,
        });
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to switch model to ${model}: ${errText(err)}`,
        });
        return;
      }
    }
    this.emitEvent({ kind: 'model_changed', model });
  }

  /**
   * No-op: `agy acp` has no live "bypass all" mode — `--dangerously-skip-permissions`
   * is a spawn-time flag only (same posture as terminal sessions).
   */
  applyGlobalSkipPermissions(_enabled: boolean): Promise<void> {
    return Promise.resolve();
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._busySince = busy ? Date.now() : null;
  }

  private emitEvent(event: AgentEvent): void {
    const entry = this.buffer.append(event);
    this.emit('event', entry.seq, entry.event);
  }

  // ---- JSON-RPC transport ---------------------------------------------------

  private writeJson(payload: unknown): void {
    if (!this.child) throw new Error('agy ACP process is not running');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('agy ACP process is not running'));
        return;
      }
      const id = this.nextRpcId++;
      this.pendingRpc.set(id, { method, resolve, reject });
      try {
        this.writeJson({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pendingRpc.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.closed || child !== this.child) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    this._lastActivityAt = Date.now();

    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // Never let one malformed line take down the session.
    }
    if (!isRecord(msg)) return;

    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === 'string' ? msg.method : null;

    // 1. Server-initiated JSON-RPC request (e.g. `session/request_permission`).
    if (hasId && method !== null) {
      const rpcId = typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : String(msg.id);
      if (method === 'session/request_permission') {
        this.handlePermissionRequest(rpcId, msg.params);
      } else {
        try {
          this.writeJson({
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32601, message: `Unsupported client method: ${method}` },
          });
        } catch {
          /* pipe already closed */
        }
      }
      return;
    }

    // 2. Response to one of our JSON-RPC requests.
    if (hasId && typeof msg.id === 'number') {
      const pending = this.pendingRpc.get(msg.id);
      if (!pending) return;
      this.pendingRpc.delete(msg.id);
      if (isRecord(msg.error)) {
        const errMsg =
          typeof msg.error.message === 'string' && msg.error.message.trim()
            ? msg.error.message.trim()
            : `ACP ${pending.method} error`;
        pending.reject(new Error(errMsg));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 3. Server notification (e.g. `session/update`).
    if (method === 'session/update' && isRecord(msg.params)) {
      this.handleSessionUpdate(msg.params.update);
    }
  }

  private handleSessionUpdate(update: unknown): void {
    if (!isRecord(update)) return;
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';

    if (kind === 'session_info_update') {
      const title = typeof update.title === 'string' ? update.title.trim() : '';
      if (title && title !== this._derivedTitle) {
        this._derivedTitle = title;
        this.emit('title', title);
      }
      return;
    }

    // Flush any accumulated thought/prose before a tool call so the transcript
    // preserves chronological order instead of dropping streaming text.
    if (kind === 'tool_call') {
      this.flushStreamedThought();
      this.flushStreamedText();
    }

    const messageId = `agy_msg_${this.id}_${this.messageSeq}`;
    const thoughtId = `agy_thought_${this.id}_${this.thoughtSeq}`;

    let events: AgentEvent[];
    try {
      events = normalizeAgyAcpUpdate(update, { messageId, thoughtId });
    } catch {
      return;
    }

    for (const event of events) {
      if (event.kind === 'thinking_delta') {
        this.streamedThought += event.text;
      } else if (event.kind === 'text_delta') {
        this.flushStreamedThought();
        this.streamedText += event.text;
        if (!this.activeTurn) {
          this.scheduleIdleFlush();
        }
      }
      this.emitEvent(event);
    }
  }

  private scheduleIdleFlush(): void {
    if (this.idleFlushTimer) clearTimeout(this.idleFlushTimer);
    this.idleFlushTimer = setTimeout(() => {
      this.idleFlushTimer = null;
      if (!this.activeTurn && !this.closed) {
        this.flushStreamedThought();
        this.flushStreamedText();
      }
    }, 500);
    this.idleFlushTimer.unref?.();
  }

  private clearIdleFlush(): void {
    if (this.idleFlushTimer) {
      clearTimeout(this.idleFlushTimer);
      this.idleFlushTimer = null;
    }
  }

  private flushStreamedThought(): void {
    if (!this.streamedThought) return;
    const text = this.streamedThought;
    const id = `agy_thought_${this.id}_${this.thoughtSeq++}`;
    this.streamedThought = '';
    this.emitEvent({ kind: 'thinking', id, text });
  }

  private flushStreamedText(): void {
    if (!this.streamedText) return;
    const text = this.streamedText;
    const id = `agy_msg_${this.id}_${this.messageSeq++}`;
    this.streamedText = '';
    this.emitEvent({ kind: 'text', id, text });
  }

  private onChildClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    startError: string | null,
  ): void {
    if (child !== this.child) return;
    this.child = null;
    this.clearIdleFlush();

    // Clear any parked permission sheets so the browser never keeps stale approvals.
    this.clearPendingPermissions();

    const reason =
      startError ??
      (this.stderrTail.trim() ||
        (signal ? `agy exited on signal ${signal}` : `agy exited with code ${code ?? 'unknown'}`));

    for (const [id, pending] of this.pendingRpc) {
      this.pendingRpc.delete(id);
      pending.reject(new Error(reason));
    }

    if (!this.activeTurn && !this.closed && this._status === 'running') {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text:
          startError ??
          'agy stopped between turns, so any background task it was still running has ended. The next prompt resumes the conversation.',
      });
    }
  }

  // ---- Conversation ---------------------------------------------------------

  /** Queue a user turn. Safe to call while a previous turn is still running. */
  prompt(text: string, image?: PromptImage): boolean {
    if (!this.isAlive()) return false;
    this._lastActivityAt = Date.now();
    this.setBusy(true);

    this.clearIdleFlush();
    this.flushStreamedThought();
    this.flushStreamedText();

    this.emitEvent({
      kind: 'user_prompt',
      id: crypto.randomBytes(6).toString('hex'),
      text,
      ...(image ? { image } : {}),
    });
    this.queue.push({ text, ...(image ? { image } : {}) });
    void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) continue;
        await this.runTurn(next, 0);
      }
    } finally {
      this.draining = false;
      if (!this.closed) this.setBusy(false);
    }
  }

  private async runTurn(prompt: QueuedPrompt, attempt: number): Promise<void> {
    if (this.closed) return;

    // Respawn and resume if the child died between turns.
    if (!this.child || !this._agentSessionId) {
      try {
        await this.spawnAndHandshake();
      } catch (err) {
        this.emitEvent({ kind: 'notice', level: 'error', text: `Failed to run agy: ${errText(err)}` });
        this.emitEvent({
          kind: 'turn_complete',
          stopReason: 'ERROR',
          isError: true,
          numTurns: null,
          durationMs: null,
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          completedAt: Date.now(),
        });
        return;
      }
    }

    const turn: ActiveTurn = {
      prompt,
      attempt,
      startedAt: Date.now(),
      interrupted: false,
    };
    this.activeTurn = turn;

    const contentBlocks: unknown[] = [];
    if (prompt.image) {
      contentBlocks.push({
        type: 'image',
        data: prompt.image.data,
        mimeType: prompt.image.mediaType,
      });
    }
    if (prompt.text || contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: prompt.text });
    }

    try {
      const res = (await this.rpc('session/prompt', {
        sessionId: this._agentSessionId,
        prompt: contentBlocks,
      })) as Record<string, unknown> | null;

      if (this.activeTurn === turn) this.activeTurn = null;
      this.flushStreamedThought();
      this.flushStreamedText();

      const stopReason =
        isRecord(res) && typeof res.stopReason === 'string' ? res.stopReason : 'end_turn';
      const usage = isRecord(res) && isRecord(res.usage) ? res.usage : null;
      const inputTokens = usage && typeof usage.inputTokens === 'number' ? usage.inputTokens : null;
      const outputTokens = usage && typeof usage.outputTokens === 'number' ? usage.outputTokens : null;
      const cacheReadTokens =
        usage && typeof usage.cachedReadTokens === 'number' && usage.cachedReadTokens > 0
          ? usage.cachedReadTokens
          : null;
      const cacheWriteTokens =
        usage && typeof usage.cachedWriteTokens === 'number' && usage.cachedWriteTokens > 0
          ? usage.cachedWriteTokens
          : null;

      this.emitEvent({
        kind: 'turn_complete',
        stopReason,
        isError: false,
        numTurns: 1,
        durationMs: Date.now() - turn.startedAt,
        costUsd: null,
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== null ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
        completedAt: Date.now(),
      });
    } catch (err) {
      if (this.activeTurn === turn) this.activeTurn = null;
      if (this.closed) return;

      const errorText = errText(err);
      const isRetryable =
        !turn.interrupted &&
        attempt < AgySession.MAX_TURN_RETRIES &&
        AgySession.TRANSIENT_ERROR_PATTERN.test(errorText);

      if (isRetryable) {
        // Discard partial output from the failed attempt before retrying.
        this.streamedThought = '';
        this.streamedText = '';
        const backoffMs =
          AgySession.RETRY_BACKOFF_MS[Math.min(attempt, AgySession.RETRY_BACKOFF_MS.length - 1)] ?? 1000;
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `agy hit a transient error (${errorText}) — retrying (${attempt + 1}/${AgySession.MAX_TURN_RETRIES})…`,
        });
        const continued = await this.waitRetryBackoff(backoffMs);
        if (continued && !this.closed) {
          await this.runTurn(prompt, attempt + 1);
        }
        return;
      }

      this.flushStreamedThought();
      this.flushStreamedText();

      if (isAgyQuotaError(errorText)) {
        this.emitEvent({
          kind: 'rate_limit',
          provider: 'agy',
          resetsAt: null,
          limitType: null,
          resetsAtLabel: null,
        });
      }
      if (!turn.interrupted) {
        this.emitEvent({ kind: 'notice', level: 'error', text: errorText });
      }
      this.emitEvent({
        kind: 'turn_complete',
        stopReason: turn.interrupted ? 'cancelled' : 'ERROR',
        isError: !turn.interrupted,
        numTurns: null,
        durationMs: Date.now() - turn.startedAt,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        completedAt: Date.now(),
      });
    }
  }

  private waitRetryBackoff(backoffMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancelPendingRetry = null;
        resolve(true);
      }, backoffMs);
      timer.unref?.();
      this.cancelPendingRetry = () => {
        clearTimeout(timer);
        this.cancelPendingRetry = null;
        resolve(false);
      };
    });
  }

  async interrupt(): Promise<void> {
    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
      return;
    }
    if (!this.child || !this.activeTurn || !this._agentSessionId) return;
    this.activeTurn.interrupted = true;

    // Cancel any parked permission requests so the server can unwind cleanly.
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      try {
        this.writeJson({
          jsonrpc: '2.0',
          id: entry.rpcId,
          result: { outcome: { outcome: 'cancelled' } },
        });
      } catch {
        /* pipe already closed */
      }
    }
    this.emit('permission', this.pendingPermissions());

    try {
      this.writeJson({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: this._agentSessionId },
      });
    } catch {
      /* pipe already closed */
    }
    this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
  }

  // ---- Approvals ------------------------------------------------------------

  /**
   * Handle an incoming ACP `session/request_permission` request.
   *
   * Parks indefinitely until a human answers via `resolvePermission` — there is
   * no timeout by design, preserving PocketAgent's core invariant.
   */
  private handlePermissionRequest(rpcId: string | number, params: unknown): void {
    const p = isRecord(params) ? params : {};
    const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
    const toolName = typeof toolCall.name === 'string' && toolCall.name ? toolCall.name : 'tool';
    const input = isRecord(toolCall.rawInput)
      ? toolCall.rawInput
      : isRecord(toolCall.args)
        ? toolCall.args
        : {};

    let filePath = extractAgyPath(input);
    if (!filePath && Array.isArray(toolCall.locations)) {
      for (const loc of toolCall.locations) {
        if (isRecord(loc) && typeof loc.path === 'string' && loc.path) {
          filePath = loc.path;
          break;
        }
      }
    }

    const rawOptions = Array.isArray(p.options) ? p.options : [];
    const options: AcpPermissionOption[] = [];
    for (const raw of rawOptions) {
      if (isRecord(raw) && typeof raw.optionId === 'string' && raw.optionId) {
        options.push({
          optionId: raw.optionId,
          ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
          ...(typeof raw.kind === 'string' ? { kind: raw.kind } : {}),
        });
      }
    }

    const toolTitle = typeof toolCall.title === 'string' && toolCall.title.trim() ? toolCall.title.trim() : null;
    const id = crypto.randomBytes(8).toString('base64url');
    const event: PermissionRequestEvent = {
      kind: 'permission_request',
      id,
      toolName,
      input,
      title: toolTitle ? `Allow: ${toolTitle}?` : `Allow: ${summarizeAgyTool(toolName, input)}?`,
      displayName: null,
      filePath,
      reason: null,
      canAllowForSession: options.some((o) => o.kind === 'allow_always'),
      questions: null,
    };

    this.pending.set(id, { event, rpcId, options });
    this.emitEvent(event);
    this.emit('permission', this.pendingPermissions());
  }

  pendingPermissions(): PermissionRequestEvent[] {
    return [...this.pending.values()].map((entry) => entry.event);
  }

  /** Answer a pending approval. Returns false if the id is unknown or stale. */
  resolvePermission(id: string, decision: PermissionDecision, message?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this._lastActivityAt = Date.now();

    const outcome = selectAcpPermissionOutcome(entry.options, decision);
    try {
      this.writeJson({
        jsonrpc: '2.0',
        id: entry.rpcId,
        result: { outcome },
      });
    } catch {
      /* child already exited */
    }

    this.emitEvent({
      kind: 'permission_resolved',
      id,
      decision,
      message: message ?? null,
    });
    this.emit('permission', this.pendingPermissions());
    return true;
  }

  private clearPendingPermissions(): void {
    if (this.pending.size === 0) return;
    this.pending.clear();
    this.emit('permission', []);
  }

  // ---- Teardown -------------------------------------------------------------

  terminate(graceMs?: number): void {
    if (!this.isAlive()) return;
    this.closed = true;
    this.queue.length = 0;
    this.clearIdleFlush();
    this.clearPendingPermissions();
    this.setStatus('killed');
    this._endedAt = Date.now();

    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
    }

    for (const [id, pending] of this.pendingRpc) {
      this.pendingRpc.delete(id);
      pending.reject(new Error('Session terminated'));
    }

    const child = this.child;
    if (!child) return;

    // Best-effort ACP `session/close` before closing stdin.
    if (this._agentSessionId) {
      try {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: this.nextRpcId++,
            method: 'session/close',
            params: { sessionId: this._agentSessionId },
          })}\n`,
        );
      } catch {
        /* already gone */
      }
    }

    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }

    const effectiveGrace = graceMs && graceMs > 0 ? graceMs : 1500;
    if (this.activeTurn) {
      child.kill('SIGTERM');
      const killer = setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
      }, effectiveGrace);
      killer.unref?.();
    } else {
      const termTimer = setTimeout(() => {
        if (this.child === child) {
          child.kill('SIGTERM');
          const killer = setTimeout(() => {
            if (this.child === child) child.kill('SIGKILL');
          }, effectiveGrace);
          killer.unref?.();
        }
      }, effectiveGrace);
      termTimer.unref?.();
    }
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    this.closed = true;
    this.queue.length = 0;
    this.clearIdleFlush();
    this.clearPendingPermissions();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}
}

function selectAcpPermissionOutcome(
  options: AcpPermissionOption[],
  decision: PermissionDecision,
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  if (decision === 'deny') {
    const opt =
      options.find((o) => o.kind === 'reject_once') ??
      options.find((o) => o.kind?.startsWith('reject')) ??
      options.find((o) => o.optionId === 'deny');
    return opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
  }

  if (decision === 'allow_session') {
    const opt =
      options.find((o) => o.kind === 'allow_always') ??
      options.find((o) => o.kind === 'allow_once') ??
      options.find((o) => o.kind?.startsWith('allow')) ??
      options.find((o) => o.optionId === 'allow');
    return opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
  }

  const opt =
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind?.startsWith('allow')) ??
    options.find((o) => o.optionId === 'allow');
  return opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
