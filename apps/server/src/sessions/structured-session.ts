import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  query,
  type EffortLevel as SdkEffortLevel,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AskUserQuestionItem,
  type AgentEvent,
  type AskUserQuestionAnswer,
  type EffortLevel,
  type PermissionDecision,
  type PermissionRequestEvent,
  type PromptImage,
  type SessionStatus,
} from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import {
  createBackgroundTaskState,
  normalizeModels,
  normalizeSdkMessage,
  normalizeSlashCommands,
  reconcileBackgroundTasks,
  summarizeToolUse,
  type BackgroundTaskState,
} from './normalize.js';

/** The exact tool name the SDK's built-in interactive question uses. */
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/** The exact tool name the SDK calls when the agent wants to leave plan mode. */
const EXIT_PLAN_MODE_TOOL = 'ExitPlanMode';

/**
 * Parse `AskUserQuestion`'s own input into typed questions, defensively.
 *
 * The SDK hands this tool call through the same generic `canUseTool` channel
 * as every other one, with no separate message type or schema guarantee at
 * that layer — so this only trusts the shape once it has actually checked it,
 * and returns null (never throws) if a future SDK version changes it. A null
 * here just means the UI falls back to a generic approval instead of a real
 * question form; it must never crash the session.
 */
function parseAskUserQuestion(input: Record<string, unknown>): AskUserQuestionItem[] | null {
  const parsed = z.array(AskUserQuestionItem).safeParse(input.questions);
  return parsed.success ? parsed.data : null;
}

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
  /**
   * Explicit, off-by-default opt-in to the SDK's `bypassPermissions` mode.
   * Undefined/false preserves the invariant below: every tool call is routed
   * to the browser and nothing is auto-approved server-side.
   */
  skipPermissions?: boolean;
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
  /** See `reconcileBackgroundTasks`'s doc comment in `normalize.ts`. */
  private readonly backgroundTasks: BackgroundTaskState = createBackgroundTaskState();

  private _status: SessionStatus = 'starting';
  private _agentSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _exitCode: number | null = null;
  private _startError: string | null = null;
  /** True while the agent is mid-turn, as opposed to idle awaiting a prompt. */
  private _busy = false;
  /** True while the operator's global skip-permissions switch is applied here. */
  private _globalBypass = false;
  /**
   * Claude Code's own generated title for this conversation, once looked up.
   * Null until `SessionManager` finds one — `spec.title` stays the honest,
   * fixed creation-time name (`Claude Code · <folder>` for a fresh chat, or
   * whatever a resume was given) and is never mutated, same reasoning as
   * `_globalBypass` above.
   */
  private _derivedTitle: string | null = null;

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
  /** True while the operator's global skip-permissions switch is applied here. */
  get globalBypassActive(): boolean {
    return this._globalBypass;
  }
  /** Claude Code's own generated title for this conversation, if found yet. */
  get derivedTitle(): string | null {
    return this._derivedTitle;
  }
  /** Called by `SessionManager` once it has looked one up. See `_derivedTitle`. */
  setDerivedTitle(title: string): void {
    this._derivedTitle = title;
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  // ---- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    if (this.queryHandle) throw new Error('session already started');

    // By default every tool call comes back to us; nothing is auto-approved
    // server-side. `skipPermissions` is the one explicit, per-session escape
    // hatch: the user opted in at creation time, so we hand the SDK its own
    // bypass mode instead of faking approval through `canUseTool`. Both
    // fields are required together — `bypassPermissions` alone is refused by
    // the SDK. `canUseTool` stays wired either way: the SDK simply never
    // calls it once permissions are bypassed.
    const options: Options = {
      cwd: this.spec.cwd,
      env: this.spec.env,
      abortController: this.abort,
      permissionMode: this.spec.skipPermissions ? 'bypassPermissions' : 'default',
      ...(this.spec.skipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
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
    void this.fetchInitialCommands();
    void this.fetchInitialModels();
  }

  /**
   * Fetch the slash-command list once at startup, for the picker.
   *
   * `commands_changed` (handled in `pump()` via `normalizeSdkMessage`) covers
   * every *later* change; this covers the list that already exists at
   * connect time, which nothing would otherwise push. Best-effort — a session
   * that cannot report its commands still works fine without a picker, so a
   * failure here must never fail startup or surface as a user-facing error.
   */
  private async fetchInitialCommands(): Promise<void> {
    const handle = this.queryHandle;
    if (!handle) return;
    try {
      const commands = await handle.supportedCommands();
      if (!this.isAlive()) return;
      this.emitEvent({ kind: 'commands_available', commands: normalizeSlashCommands(commands) });
    } catch {
      // Older CLI builds or an already-torn-down query may not support this;
      // silently do without the picker rather than emit a notice for
      // something the user never asked for.
    }
  }

  /**
   * Fetch the model list once at startup, for the picker.
   *
   * Same shape as `fetchInitialCommands` and for the same reason: best-effort,
   * since an older CLI build without `supportedModels()` should lose nothing
   * beyond the picker itself. The *current* model comes from `session_started`
   * (the SDK's own `init` message), not from here — this only supplies the
   * choices.
   */
  private async fetchInitialModels(): Promise<void> {
    const handle = this.queryHandle;
    if (!handle) return;
    try {
      const models = await handle.supportedModels();
      if (!this.isAlive()) return;
      this.emitEvent({ kind: 'models_available', models: normalizeModels(models) });
    } catch {
      // Older CLI builds or an already-torn-down query may not support this;
      // the composer just has no model picker.
    }
  }

  /**
   * Switch the model this session uses, effective on the next prompt — the
   * SDK's `setModel` only changes what a subsequent turn requests, never one
   * already streaming.
   *
   * Mirrors `applyGlobalSkipPermissions`'s shape: call straight into the live
   * `Query` handle and turn a failure into a notice instead of a thrown error,
   * since this is a user-facing convenience, not something correctness
   * depends on. `setModel` is documented as available only in streaming input
   * mode, which every structured session already uses (see `inputStream()`).
   */
  async setModel(model: string): Promise<void> {
    if (!this.queryHandle || !this.isAlive()) return;
    try {
      await this.queryHandle.setModel(model);
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.emitEvent({ kind: 'model_changed', model });
  }

  /**
   * Switch the effort level the current model applies, effective on the next
   * prompt — same caveat as `setModel`. `null` resets to the model's own
   * default rather than pinning a specific level.
   *
   * Routed through `applyFlagSettings` rather than a dedicated `setEffort`:
   * the SDK has no such method, and effort lives in the same flag-settings
   * layer as everything else `Options`/`--settings` would configure at
   * startup. Same failure handling as `setModel` — a notice, not a throw.
   *
   * `effort` is the protocol's own `EffortLevel` (a free-form string, since
   * other structured backends use a different vocabulary than Claude's — see
   * that type's doc comment) but the SDK's own `applyFlagSettings` only
   * accepts its five known values. The cast below hands off to `catch`
   * instead of the type checker for anything else: an unrecognized string
   * reaches the real API call and comes back as a rejected promise, exactly
   * like any other failure this method already turns into a notice.
   */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    if (!this.queryHandle || !this.isAlive()) return;
    try {
      await this.queryHandle.applyFlagSettings({ effortLevel: effort as SdkEffortLevel | null });
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch effort: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    this.emitEvent({ kind: 'effort_changed', effort });
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
        const events = reconcileBackgroundTasks(
          message,
          normalizeSdkMessageSafe(message),
          this.backgroundTasks,
        );
        for (const event of events) {
          if (event.kind === 'session_started' && event.agentSessionId) {
            this._agentSessionId = event.agentSessionId;
          }
          // `/clear` (and the other conversation_reset triggers) hand the SDK
          // a fresh conversation id mid-session, without a matching
          // `session_started` — miss this and `agentSessionId` (and the
          // `session_id` `prompt()` stamps on the next turn, above) keeps
          // pointing at the conversation that no longer exists.
          if (event.kind === 'conversation_reset' && event.newConversationId) {
            this._agentSessionId = event.newConversationId;
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
    // A background sub-agent (see `reconcileBackgroundTasks`) has its real
    // `tool_result` withheld until it actually finishes. If the session ends
    // first, nothing else will ever supply that result — a tool card, or a
    // fleet-view sub-agent chip, would otherwise sit "awaiting" forever.
    for (const [toolUseId, taskId] of this.backgroundTasks.pending) {
      this.emitEvent({
        kind: 'tool_result',
        id: `bgtask_end_${taskId}`,
        toolUseId,
        content: 'Session ended before this sub-agent finished.',
        truncated: false,
        isError: true,
      });
    }
    this.backgroundTasks.pending.clear();
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

  /**
   * Queue a user turn. Safe to call while the agent is still working.
   *
   * `image` rides as a leading content block alongside `text` — the SDK's own
   * `MessageParam.content` accepts an array of blocks, not just a string, so
   * this is the same request shape a multimodal turn from any Anthropic
   * client would use. `text` may be empty when `image` is set (an image-only
   * send); `ws/index.ts` is what actually guarantees at least one is present.
   */
  prompt(text: string, image?: PromptImage): boolean {
    if (!this.isAlive()) return false;
    this._lastActivityAt = Date.now();
    this._busy = true;

    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text, image });

    const content = image
      ? [
          {
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
          },
          ...(text ? [{ type: 'text' as const, text }] : []),
        ]
      : text;

    this.inbox.push({
      type: 'user',
      message: { role: 'user', content },
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

  /**
   * Apply or release the operator's server-wide skip-permissions switch.
   *
   * Unlike the per-session `spec.skipPermissions` opt-in (fixed for the life of
   * the session), this can reach a session that is already running: the SDK's
   * `setPermissionMode` takes effect on the query in flight, and turning the
   * switch on drains every approval already parked waiting for a human, so it
   * does not sit forever behind a switch that says nothing should be asked.
   * Turning the switch back off restores whatever mode this session actually
   * started with — its own opt-in, if any, otherwise back to asking.
   *
   * Called only by `SessionManager.setGlobalSkipPermissions`, which is the one
   * deliberate, operator-level override of "never answer a prompt for the
   * user" (see CLAUDE.md). It has no effect on a session that has already
   * ended, and it never touches `spec` — that stays the honest record of what
   * this session was actually created with.
   */
  async applyGlobalSkipPermissions(enabled: boolean): Promise<void> {
    this._globalBypass = enabled;
    if (!this.queryHandle || !this.isAlive()) return;

    const mode: PermissionMode = enabled || this.spec.skipPermissions ? 'bypassPermissions' : 'default';
    try {
      await this.queryHandle.setPermissionMode(mode);
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to apply the global approval switch: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    if (enabled) {
      // A bare allow with no answer is exactly the bug this class of tool
      // needs *not* to hit (see `resolvePermission`) — bypassing approval
      // does not mean inventing an answer on the human's behalf, so a
      // pending question is left for them rather than drained here.
      for (const [id, pending] of [...this.pending]) {
        if (pending.event.toolName === ASK_USER_QUESTION_TOOL) continue;
        this.resolvePermission(id, 'allow');
      }
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
      // cards use, which reads far better than a bare tool name. `ExitPlanMode`
      // gets its own phrasing since "Allow: Review plan?" reads like every
      // other tool call when this one is actually the plan-review moment.
      title:
        opts.title ??
        (toolName === EXIT_PLAN_MODE_TOOL
          ? 'Ready to code?'
          : `Allow: ${summarizeToolUse(toolName, input)}?`),
      displayName: opts.displayName ?? null,
      filePath: opts.blockedPath ?? extractPathSafe(input),
      reason: opts.decisionReason ?? null,
      canAllowForSession: suggestions.length > 0,
      questions: toolName === ASK_USER_QUESTION_TOOL ? parseAskUserQuestion(input) : null,
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
  resolvePermission(
    id: string,
    decision: PermissionDecision,
    message?: string,
    answer?: AskUserQuestionAnswer,
  ): boolean {
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
    } else if (answer) {
      // `AskUserQuestion` (and anything else shaped like it) does not read a
      // bare allow as "proceed" — the tool's whole output IS the human's
      // answer. A plain `{behavior: 'allow'}` here runs the call with nothing
      // to report, which the agent sees as a failed tool call and falls back
      // to asking the same question again in plain text. Handing back the
      // original input plus the chosen answer as `updatedInput` is what the
      // SDK actually reads as the tool's result.
      entry.resolve({
        behavior: 'allow',
        updatedInput: {
          ...entry.event.input,
          answers: answer.answers,
          ...(answer.response !== undefined ? { response: answer.response } : {}),
        },
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

