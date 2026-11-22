import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import {
  SPOKEN_SUMMARY_INSTRUCTION,
  appendSpokenSummaryInstruction,
  isAutoApprovingAgentMode,
  type AgentEvent,
  type AgentModeInfo,
  type PermissionDecision,
  type PermissionRequestEvent,
  type PromptImage,
  type SessionStatus,
} from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { formatAgySettingsAutoApproveNotice, readAgySettingsAutoApprove } from '../agents/agy.js';
import {
  extractAgyPath,
  isAgyQuotaError,
  normalizeAgyAcpModels,
  normalizeAgyAcpModes,
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
  /** Initial operating mode (`default`, `plan`, `accept-edits`, `auto`) to apply right after handshake. */
  mode?: string;
  /**
   * Explicit, off-by-default opt-in to `--dangerously-skip-permissions`.
   * Controls the CLI flag ONLY. When false/absent, `agy acp` is spawned
   * without `--dangerously-skip-permissions`.
   */
  skipPermissions?: boolean;
  /**
   * True when host-level `~/.gemini/antigravity-cli/settings.json` sets a
   * non-supervised `toolPermission` value while `skipPermissions` was false.
   * Kept separate from `skipPermissions` so disclosure (`skipPermissionsEnabled`
   * and persisted `skip_permissions`) is honest WITHOUT escalating agy's argv
   * to `--dangerously-skip-permissions` (which would strip sandbox bounds from
   * `proceed-in-sandbox`, etc.).
   */
  bypassedBySettings?: boolean;
  /**
   * Optional warning notice emitted at session start when agy's host-level
   * `settings.json` sets a non-supervised `toolPermission` value.
   */
  settingsAutoApproveNotice?: string;
  /**
   * Optional bound (ms) for the ACP `initialize` + `session/new|resume`
   * handshake. Defaults to 15_000ms.
   */
  handshakeTimeoutMs?: number;
  /**
   * PA-75: the Pocket Agent chat that created this session via
   * `start_subagent_session`, or null for human/trigger sessions.
   */
  plannerChatId?: string | null;
  /**
   * PA-185: resolves whether the next turn should request a spoken `<speak>`
   * summary via ACP `_meta.antigravity.systemPrompt.append` instead of
   * appending `SPOKEN_SUMMARY_INSTRUCTION` to the prompt text. Evaluated live
   * at handshake and right before each `session/prompt` so mid-session voice
   * toggles and `voiceSpokenSummaryEnabled` setting changes take effect on the
   * next turn (including prompts delivered later via `PromptQueueService`).
   */
  shouldAppendSpokenSummary?: () => boolean;
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
  /**
   * Tool calls started via `tool_call` that have not yet reached a terminal
   * `tool_call_update` (`completed` / `failed` / `cancelled`), mapped to their
   * ACP `kind` (`execute`, `edit`, `read`, …) and human-readable `title`.
   * Because `agy acp` resolves `session/prompt` with `end_turn` while a
   * background `run_command` is still running, tracking in-flight `execute`
   * calls keeps `busy` honest and lets the UI and drain-state blockers name
   * which background command is holding the checkout so a human can interrupt
   * it knowingly. Non-`execute` calls are pruned at `end_turn`, and all entries
   * are cleared on turn error/retry so a missing terminal update can never
   * strand `busy === true`.
   */
  private readonly inFlightToolCalls = new Map<string, { kind: string | null; title: string | null }>();
  private lastNotifiedBackgroundCommands = '';
  private _bypassedBySettings = false;
  /**
   * Sticky latch: once this session has ever run bypassed via `settings.json`,
   * stays `true` for the session's lifetime so persisted `sessions.skip_permissions`
   * never flips back from `1 -> 0` if the operator changes `toolPermission`
   * mid-session (PA-183).
   */
  private _everBypassedBySettings = false;

  private _desiredModel: string | null = null;
  private _availableModes: AgentModeInfo[] = [];
  private _desiredMode: string | null = null;
  private _currentMode: string | null = null;
  /**
   * Sticky latch (PA-184): once this session has ever entered an
   * auto-approving mode (`auto`, `accept-edits`, or any mode outside
   * `default`/`plan`), stays `true` so persisted `sessions.skip_permissions`
   * never reverts `1 -> 0` if the user later switches back to `default`/`plan`.
   */
  private _everAutoApprovedByMode = false;
  /**
   * PA-185: true when `initialize` advertised
   * `agentCapabilities._meta.antigravity.systemPrompt.append: true`.
   */
  private _supportsSystemPromptAppend = false;
  /**
   * The `systemPrompt.append` string currently applied to the active ACP
   * session handle, or `null` when none is applied. Reconciled against
   * `desiredSystemPromptAppend()` right before each `session/prompt`.
   */
  private appliedSystemPromptAppend: string | null = null;
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

  private static readonly DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
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
    this._desiredMode = spec.mode ?? null;
    this._bypassedBySettings = spec.bypassedBySettings === true;
    this._everBypassedBySettings = this._bypassedBySettings;
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
  /** True when host `settings.json` may currently auto-approve commands without `--dangerously-skip-permissions`. */
  get bypassedBySettings(): boolean {
    return this._bypassedBySettings;
  }
  /** Sticky: true if this session has ever run bypassed via host `settings.json`. */
  get everBypassedBySettings(): boolean {
    return this._everBypassedBySettings;
  }
  /** Active ACP operating mode (`default`, `plan`, `accept-edits`, `auto`), or null before handshake. */
  get currentMode(): string | null {
    return this._currentMode;
  }
  /** True when the currently active ACP mode auto-approves beyond `default` (fails closed). */
  get autoApprovedByMode(): boolean {
    return isAutoApprovingAgentMode(this._currentMode);
  }
  /** Sticky: true if this session has ever run in an auto-approving ACP mode. */
  get everAutoApprovedByMode(): boolean {
    return this._everAutoApprovedByMode;
  }
  /** True when the running `agy acp` process advertised `_meta.antigravity.systemPrompt.append: true` (PA-185). */
  get supportsSystemPromptAppend(): boolean {
    return this._supportsSystemPromptAppend;
  }
  /**
   * Titles of in-flight `execute` tool calls keeping this session busy after a
   * turn has ended (e.g. a dev server or watcher running in the background).
   * Empty while a prompt turn is active or when idle.
   */
  get backgroundCommands(): string[] {
    if (this.closed || this.activeTurn !== null) return [];
    const titles: string[] = [];
    for (const entry of this.inFlightToolCalls.values()) {
      if (entry.kind === 'execute') {
        titles.push(entry.title ?? 'background command');
      }
    }
    return titles;
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
      if (this.spec.settingsAutoApproveNotice) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: this.spec.settingsAutoApproveNotice,
        });
      }
    }
  }

  /**
   * Spawn `agy acp`, perform the bounded ACP `initialize` handshake, and open
   * or resume the session. Kills the spawned child and throws if the process
   * cannot start, hangs past `handshakeTimeoutMs`, or fails handshake.
   */
  private async spawnAndHandshake(isRespawn = false): Promise<void> {
    if (this.child) {
      this.killChildNow(this.child);
    }

    if (isRespawn && !this.spec.skipPermissions) {
      const check = readAgySettingsAutoApprove({ homeDir: this.spec.env.HOME });
      const prev = this._bypassedBySettings;
      this._bypassedBySettings = check.autoApproves;
      if (check.autoApproves) {
        this._everBypassedBySettings = true;
      }
      if (check.autoApproves && !prev) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: formatAgySettingsAutoApproveNotice(check),
        });
      }
      if (this._bypassedBySettings !== prev && this._status === 'running') {
        this.emit('status', this._status);
      }
    }

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

    const handshakeTimeoutMs =
      this.spec.handshakeTimeoutMs ?? AgySession.DEFAULT_HANDSHAKE_TIMEOUT_MS;

    let sessionRes: Record<string, unknown> | null;
    let desiredAppend: string | null = null;
    try {
      const initRes = await this.rpcWithTimeout(
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'pocketagent', version: '1.0.0' },
        },
        handshakeTimeoutMs,
      );
      this._supportsSystemPromptAppend = hasAgySystemPromptAppendCapability(initRes);
      desiredAppend = this.desiredSystemPromptAppend();

      const isResume = this._agentSessionId !== null;
      const openParams: Record<string, unknown> = isResume
        ? { sessionId: this._agentSessionId, cwd: this.spec.cwd, mcpServers: [] }
        : { cwd: this.spec.cwd, mcpServers: [] };
      if (desiredAppend !== null) {
        openParams._meta = buildSystemPromptAppendMeta(desiredAppend);
      }

      sessionRes = (await this.rpcWithTimeout(
        isResume ? 'session/resume' : 'session/new',
        openParams,
        handshakeTimeoutMs,
      )) as Record<string, unknown> | null;
    } catch (err) {
      this.killChildNow(child);
      throw err;
    }
    this.appliedSystemPromptAppend = desiredAppend;

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

    const modes = isRecord(sessionRes) ? normalizeAgyAcpModes(sessionRes.modes) : [];
    if (modes.length > 0) {
      this._availableModes = modes;
      this.emitEvent({ kind: 'modes_available', modes });
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

    if (this._desiredMode && this._agentSessionId && this._desiredMode !== currentModeId) {
      try {
        await this.rpcWithTimeout(
          'session/set_mode',
          {
            sessionId: this._agentSessionId,
            modeId: this._desiredMode,
          },
          handshakeTimeoutMs,
        );
        this.applyModeState(this._desiredMode, false);
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to set initial mode (${this._desiredMode}): ${errText(err)}`,
        });
        this._desiredMode = currentModeId;
        if (currentModeId) {
          this.applyModeState(currentModeId, isRespawn);
        }
      }
    } else if (currentModeId) {
      this.applyModeState(currentModeId, false);
    }

    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this._agentSessionId,
      model: this._desiredModel ?? currentModelId,
      cwd: this.spec.cwd,
      tools: [],
      permissionMode: this.spec.skipPermissions
        ? 'always-proceed'
        : (this._currentMode ?? currentModeId ?? 'default'),
    });
  }

  private desiredSystemPromptAppend(): string | null {
    if (!this._supportsSystemPromptAppend) return null;
    return this.spec.shouldAppendSpokenSummary?.() ? SPOKEN_SUMMARY_INSTRUCTION : null;
  }

  /**
   * Re-apply `_meta.antigravity.systemPrompt.append` on the existing `agy acp`
   * process between turns (PA-185).
   *
   * Verified live against `agy acp` v1.5.14:
   * - OFF → ON: same-process `session/resume` with `_meta` (~3 ms, no
   *   `session/close`) activates the append immediately and preserves running
   *   background `run_command` processes.
   * - ON → OFF: same-process `session/resume` without `session/close` leaves
   *   the prior append active (even with `append: ""`), so clearing requires
   *   `session/close` + `session/resume` omitting `_meta` (~3–4 ms, no process
   *   respawn, no server-restart `SYSTEM_MESSAGE` in `transcript.jsonl`). The
   *   caller must only pass `closeFirst = true` when `inFlightToolCalls.size === 0`
   *   so background commands are never terminated.
   */
  private async reopenSessionForSystemPrompt(
    append: string | null,
    closeFirst: boolean,
  ): Promise<void> {
    if (!this.child || !this._agentSessionId) return;
    const handshakeTimeoutMs =
      this.spec.handshakeTimeoutMs ?? AgySession.DEFAULT_HANDSHAKE_TIMEOUT_MS;

    if (closeFirst) {
      await this.rpcWithTimeout(
        'session/close',
        { sessionId: this._agentSessionId },
        handshakeTimeoutMs,
      );
    }

    const resumeParams: Record<string, unknown> = {
      sessionId: this._agentSessionId,
      cwd: this.spec.cwd,
      mcpServers: [],
    };
    if (append !== null) {
      resumeParams._meta = buildSystemPromptAppendMeta(append);
    }

    const resumeRes = (await this.rpcWithTimeout(
      'session/resume',
      resumeParams,
      handshakeTimeoutMs,
    )) as Record<string, unknown> | null;
    this.appliedSystemPromptAppend = append;

    const currentModelId =
      isRecord(resumeRes) && isRecord(resumeRes.models) && typeof resumeRes.models.currentModelId === 'string'
        ? resumeRes.models.currentModelId
        : null;
    if (this._desiredModel && this._agentSessionId && this._desiredModel !== currentModelId) {
      try {
        await this.rpcWithTimeout(
          'session/set_model',
          { sessionId: this._agentSessionId, modelId: this._desiredModel },
          handshakeTimeoutMs,
        );
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to restore model (${this._desiredModel}): ${errText(err)}`,
        });
      }
    }

    const currentModeId =
      isRecord(resumeRes) && isRecord(resumeRes.modes) && typeof resumeRes.modes.currentModeId === 'string'
        ? resumeRes.modes.currentModeId
        : null;
    if (this._desiredMode && this._agentSessionId && this._desiredMode !== currentModeId) {
      try {
        await this.rpcWithTimeout(
          'session/set_mode',
          { sessionId: this._agentSessionId, modeId: this._desiredMode },
          handshakeTimeoutMs,
        );
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to restore mode (${this._desiredMode}): ${errText(err)}`,
        });
      }
    }
  }

  /**
   * Commit a confirmed mode transition, latching `_everAutoApprovedByMode`
   * when the mode auto-approves beyond `default` and deduplicating against
   * `current_mode_update` notifications that race with `session/set_mode`.
   */
  private applyModeState(mode: string, notifyStatus: boolean): void {
    const trimmed = mode.trim();
    if (!trimmed) return;
    if (isAutoApprovingAgentMode(trimmed)) {
      this._everAutoApprovedByMode = true;
    }
    if (this._currentMode === trimmed) return;
    this._currentMode = trimmed;
    this._desiredMode = trimmed;
    this.emitEvent({ kind: 'mode_changed', mode: trimmed });
    if (notifyStatus && this._status === 'running') {
      this.emit('status', this._status);
    }
  }

  /**
   * Switch the active operating mode live via ACP `session/set_mode` — no
   * process recycle needed, so any background tasks remain untouched.
   */
  async setMode(mode: string): Promise<void> {
    if (!this.isAlive()) return;
    const trimmed = mode.trim();
    if (!trimmed) return;
    if (
      this._availableModes.length > 0 &&
      !this._availableModes.some((m) => m.id === trimmed)
    ) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Unknown agy mode: ${trimmed}`,
      });
      return;
    }
    if (this.child && this._agentSessionId) {
      try {
        await this.rpc('session/set_mode', {
          sessionId: this._agentSessionId,
          modeId: trimmed,
        });
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text: `Failed to switch mode to ${trimmed}: ${errText(err)}`,
        });
        return;
      }
    }
    this.applyModeState(trimmed, true);
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

  private emitBackgroundCommandsIfChanged(): void {
    const key = this.backgroundCommands.join('\0');
    if (key === this.lastNotifiedBackgroundCommands) return;
    this.lastNotifiedBackgroundCommands = key;
    if (!this.closed && this._status === 'running') {
      this.emit('status', this._status);
    }
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
    if (!busy) {
      this.emit('idle');
    }
  }

  /**
   * Recompute `busy` from every active signal: a draining prompt queue, an
   * active prompt RPC, an in-flight background tool call, a parked permission
   * request, or reactive idle output still streaming.
   */
  private updateBusy(): void {
    const busy =
      !this.closed &&
      (this.draining ||
        this.activeTurn !== null ||
        this.inFlightToolCalls.size > 0 ||
        this.pending.size > 0 ||
        this.idleFlushTimer !== null);
    this.setBusy(busy);
  }

  private killChildNow(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) {
      this.child = null;
    }
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 1000);
    killer.unref?.();
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

  private rpcWithTimeout(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.child) {
        reject(new Error('agy ACP process is not running'));
        return;
      }
      const id = this.nextRpcId++;
      const timer = setTimeout(() => {
        if (this.pendingRpc.delete(id)) {
          reject(new Error(`Timed out waiting for agy ACP ${method} after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pendingRpc.set(id, {
        method,
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.writeJson({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
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

    if (kind === 'current_mode_update') {
      const events = normalizeAgyAcpUpdate(update);
      for (const ev of events) {
        if (ev.kind === 'mode_changed') {
          this.applyModeState(ev.mode, true);
        }
      }
      return;
    }

    // Track in-flight tool calls so `busy` stays honest when a background
    // `run_command` outlives `session/prompt`'s `end_turn` and the UI / drain
    // blockers can name which background command is holding the session.
    if (kind === 'tool_call') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      const callKind = typeof update.kind === 'string' ? update.kind : null;
      const rawTitle =
        typeof update.title === 'string' && update.title.trim() ? update.title.trim() : null;
      const toolName = typeof update.name === 'string' && update.name ? update.name : null;
      const rawInput = isRecord(update.rawInput)
        ? update.rawInput
        : isRecord(update.args)
          ? update.args
          : {};
      const callTitle = rawTitle ?? (toolName ? summarizeAgyTool(toolName, rawInput) : null);
      if (callId) this.inFlightToolCalls.set(callId, { kind: callKind, title: callTitle });
      this.flushStreamedThought();
      this.flushStreamedText();
      if (!this.activeTurn) this.emitBackgroundCommandsIfChanged();
      this.updateBusy();
    } else if (kind === 'tool_call_update') {
      const callId = typeof update.toolCallId === 'string' ? update.toolCallId : '';
      const status = typeof update.status === 'string' ? update.status : '';
      if (callId) {
        if (status === 'completed' || status === 'failed' || status === 'cancelled') {
          this.inFlightToolCalls.delete(callId);
          if (!this.activeTurn) {
            this.scheduleIdleFlush();
            this.emitBackgroundCommandsIfChanged();
          }
          this.updateBusy();
        } else {
          const existing = this.inFlightToolCalls.get(callId);
          const nextTitle =
            typeof update.title === 'string' && update.title.trim() ? update.title.trim() : null;
          if (existing && nextTitle && !existing.title) {
            existing.title = nextTitle;
            if (!this.activeTurn) this.emitBackgroundCommandsIfChanged();
          }
        }
      }
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
        if (!this.activeTurn) {
          this.scheduleIdleFlush();
        }
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
      this.updateBusy();
    }, 500);
    this.idleFlushTimer.unref?.();
    this.updateBusy();
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
    this.appliedSystemPromptAppend = null;
    this.clearIdleFlush();
    this.inFlightToolCalls.clear();
    this.emitBackgroundCommandsIfChanged();

    // Clear any parked permission sheets so the browser never keeps stale approvals.
    this.clearPendingPermissions();
    this.updateBusy();

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
      this.updateBusy();
    }
  }

  private async runTurn(prompt: QueuedPrompt, attempt: number): Promise<void> {
    if (this.closed) return;

    const emitStartFailure = (err: unknown): void => {
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
    };

    // Respawn and resume if the child died between turns (or has no session id).
    if (!this.child || !this._agentSessionId) {
      if (this.child) this.killChildNow(this.child);
      try {
        await this.spawnAndHandshake(true);
      } catch (err) {
        emitStartFailure(err);
        return;
      }
    }

    // PA-185: reconcile `_meta.antigravity.systemPrompt.append` between turns
    // whenever voice mode or `voiceSpokenSummaryEnabled` changed since the
    // session handle was opened. Older `agy` binaries that do not advertise
    // the capability fall back to idempotent per-prompt injection.
    let fallbackPromptAppend = false;
    if (this._supportsSystemPromptAppend && this.child && this._agentSessionId) {
      const desired = this.desiredSystemPromptAppend();
      if (desired !== this.appliedSystemPromptAppend) {
        if (desired !== null) {
          try {
            await this.reopenSessionForSystemPrompt(desired, false);
          } catch {
            if (this.inFlightToolCalls.size === 0 && !this.closed) {
              try {
                if (this.child) this.killChildNow(this.child);
                await this.spawnAndHandshake(true);
              } catch (err) {
                emitStartFailure(err);
                return;
              }
            } else {
              fallbackPromptAppend = true;
            }
          }
        } else if (this.inFlightToolCalls.size === 0) {
          try {
            await this.reopenSessionForSystemPrompt(null, true);
          } catch {
            if (!this.closed) {
              try {
                if (this.child) this.killChildNow(this.child);
                await this.spawnAndHandshake(true);
              } catch (err) {
                emitStartFailure(err);
                return;
              }
            }
          }
        }
        // When `desired === null` and `inFlightToolCalls.size > 0`, defer
        // `session/close` + `session/resume` until the background command
        // drains so we never terminate it. `VoiceTtsService` is already off
        // and `Transcript.tsx` strips `<speak>` unconditionally.
      }
    } else if (!this._supportsSystemPromptAppend && this.spec.shouldAppendSpokenSummary?.()) {
      fallbackPromptAppend = true;
    }

    if (this.closed) return;

    const turn: ActiveTurn = {
      prompt,
      attempt,
      startedAt: Date.now(),
      interrupted: false,
    };
    this.activeTurn = turn;
    this.emitBackgroundCommandsIfChanged();

    const contentBlocks: unknown[] = [];
    if (prompt.image) {
      contentBlocks.push({
        type: 'image',
        data: prompt.image.data,
        mimeType: prompt.image.mediaType,
      });
    }
    const textToSend = fallbackPromptAppend
      ? appendSpokenSummaryInstruction(prompt.text)
      : prompt.text;
    if (textToSend || contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: textToSend });
    }

    try {
      const res = (await this.rpc('session/prompt', {
        sessionId: this._agentSessionId,
        prompt: contentBlocks,
      })) as Record<string, unknown> | null;

      if (this.activeTurn === turn) this.activeTurn = null;
      // Only command-type calls (`kind: "execute"`) can genuinely outlive
      // `end_turn` as background tasks; prune everything else so a missing
      // terminal update on a read/edit/search tool can never strand `busy`.
      for (const [callId, entry] of [...this.inFlightToolCalls]) {
        if (entry.kind !== 'execute') this.inFlightToolCalls.delete(callId);
      }
      this.emitBackgroundCommandsIfChanged();
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
      // Clear any in-flight tool calls on error/retry so stale ids from a
      // failed attempt can never strand `busy === true`.
      this.inFlightToolCalls.clear();
      this.emitBackgroundCommandsIfChanged();
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
    if (!this.child || !this._agentSessionId || (!this.activeTurn && !this._busy)) return;
    if (this.activeTurn) {
      this.activeTurn.interrupted = true;
    }

    // Cancel any parked permission requests and close their transcript cards cleanly.
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
      this.emitEvent({
        kind: 'permission_resolved',
        id,
        decision: 'deny',
        message: 'Interrupted.',
      });
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
    this.inFlightToolCalls.clear();
    this.clearIdleFlush();
    this.emitBackgroundCommandsIfChanged();
    this.updateBusy();
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
    this.updateBusy();
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
    this.updateBusy();

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
    this.inFlightToolCalls.clear();
    this.clearIdleFlush();
    this.clearPendingPermissions();
    this.updateBusy();
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

function hasAgySystemPromptAppendCapability(initRes: unknown): boolean {
  if (!isRecord(initRes)) return false;
  const caps = initRes.agentCapabilities;
  if (!isRecord(caps)) return false;
  const meta = caps._meta;
  if (!isRecord(meta)) return false;
  const antigravity = meta.antigravity;
  if (!isRecord(antigravity)) return false;
  const systemPrompt = antigravity.systemPrompt;
  if (!isRecord(systemPrompt)) return false;
  return systemPrompt.append === true;
}

function buildSystemPromptAppendMeta(append: string): Record<string, unknown> {
  return { antigravity: { systemPrompt: { append } } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
