import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import {
  normalizePiEvent,
  normalizePiModels,
  normalizePiModelValue,
  normalizeSlashCommands,
  piHistoryEvents,
} from './normalize.js';
import type { StructuredSessionEvents } from './structured-session.js';

export interface PiSessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  env: Record<string, string>;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** pi's own session id (a UUID pi assigns, or `--session-id` mints), to resume via `--session-id`. */
  resumeAgentSessionId?: string;
  /** Absolute path to the `pi` executable, when not on PATH. */
  executablePath?: string;
  /**
   * Always `true` — see `agents/pi.ts` for why. pi has no approval concept
   * anywhere, in any mode, by explicit design ("does not include a built-in
   * sandbox"), so unlike `OpencodeSessionSpec`/`CodexSessionSpec` this is not
   * a choice PocketAgent is making on the user's behalf.
   */
  skipPermissions: true;
}

interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * An agent driven through `pi --mode rpc`'s JSON protocol over stdin/stdout.
 *
 * Unlike the other three structured engines, `pi`'s RPC mode is a genuinely
 * persistent per-session process — closer in shape to `StructuredSession`
 * (one process, fed prompts for the session's whole life) than to
 * `AgySession` (fresh process per turn) or `OpencodeSession`/`CodexSession`
 * (one process shared across many sessions). There is no daemon to share, so
 * this class owns its child directly.
 *
 * Framing is newline-delimited JSON, split on bare `\n` only — pi's own RPC
 * docs call out that U+2028/U+2029 are valid inside JSON strings and a
 * generic line reader (including Node's `readline`) would wrongly split on
 * them, so this reads `stdout` manually instead of using `readline`.
 */
export class PiSession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: PiSessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  /** Generated once at construction — `--session-id` both creates (fresh) and attaches (resume) by that same id. */
  private readonly piSessionId: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<string, (response: CommandResponse) => void>();
  private messageSeq = 0;
  private lastAssistant: { input: number | null; output: number | null; cost: number | null; stopReason: string | null } | null = null;

  private _status: SessionStatus = 'starting';
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _exitCode: number | null = null;
  private _exitSignal: number | null = null;
  private _startError: string | null = null;
  private _busy = false;
  /** See `busySince` getter. */
  private _busySince: number | null = null;

  constructor(spec: PiSessionSpec, epoch?: string) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this.piSessionId = spec.resumeAgentSessionId ?? crypto.randomUUID();
  }

  // ---- Shared session surface ---------------------------------------------

  get status(): SessionStatus {
    return this._status;
  }
  // Unlike the other three structured engines, this one owns one real,
  // persistent process for the session's whole life, so — like `PtySession`
  // — it has an honest pid/exit status to report instead of a fixed `null`.
  get pid(): number | null {
    return this.child?.pid ?? null;
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
    return this._exitSignal;
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
    return 'pi-rpc';
  }
  get survivesServerRestart(): boolean {
    // The process does not survive, but pi persists the session file itself,
    // so a new session can resume from `agentSessionId`.
    return false;
  }
  get agentSessionId(): string | null {
    return this.piSessionId;
  }
  get busy(): boolean {
    return this._busy;
  }
  /** See `StructuredSession.busySince`'s doc comment. */
  get busySince(): number | null {
    return this._busySince;
  }
  /** No bypass concept here: every session is already maximally (and permanently) bypassed. */
  get globalBypassActive(): boolean {
    return false;
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
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(
        this.spec.executablePath ?? 'pi',
        ['--mode', 'rpc', '--session-id', this.piSessionId],
        { cwd: this.spec.cwd, env: this.spec.env },
      );
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    // pi's RPC mode has no readiness handshake — the documented client
    // pattern just spawns and starts sending commands. This only waits long
    // enough to catch an immediate spawn failure (e.g. ENOENT), which Node
    // reports asynchronously via `error` rather than by throwing.
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onError = (err: Error): void => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        child.once('error', onError);
        setImmediate(() => {
          if (settled) return;
          settled = true;
          child.off('error', onError);
          resolve();
        });
      });
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.handleChunk(chunk));
    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      const failure: CommandResponse = { success: false, error: 'pi exited before this command completed.' };
      for (const resolve of this.pending.values()) resolve(failure);
      this.pending.clear();
      if (!this.isAlive()) return; // Already ended via terminate().
      this._exitCode = code;
      this._exitSignal = signal ? 1 : null;
      this._endedAt = Date.now();
      this.setBusy(false);
      if (signal) {
        this.setStatus('killed');
      } else if (code === 0) {
        this.setStatus('exited');
      } else {
        this._startError = stderrTail.trim() || `pi exited with code ${code}`;
        this.emitEvent({ kind: 'notice', level: 'error', text: this._startError });
        this.setStatus('error');
      }
      this.emit('exit', this._exitCode, this._exitSignal);
    });

    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');

    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this.piSessionId,
      model: null,
      cwd: this.spec.cwd,
      tools: [],
      // Always bypassed — see `agents/pi.ts` — but "default" reads more
      // honestly here than "bypassPermissions": pi never had a permission
      // mode to bypass in the first place.
      permissionMode: null,
    });

    if (this.spec.resumeAgentSessionId) {
      await this.fetchHistory();
    }

    void this.fetchInitialCommands();
    void this.fetchInitialModels();
    void this.reportCurrentModelAndEffort();
  }

  /**
   * Backfill this resumed session's own prior conversation into its buffer,
   * via pi's own `get_messages` RPC (docs/rpc.md: "Get all messages in the
   * conversation") — see normalize.ts's `piHistoryEvents` doc comment for the
   * shape and what it does and does not reconstruct. Awaited — unlike
   * `fetchInitialCommands`/`fetchInitialModels`/`reportCurrentModelAndEffort`
   * below — so every history event lands in the buffer, in order, before this
   * session is usable: the WebSocket layer replays the buffer in append
   * order, and a live turn's own events must never interleave with
   * backfilled ones.
   */
  private async fetchHistory(): Promise<void> {
    const res = await this.sendCommand('get_messages');
    if (!res.success || !isRecord(res.data)) return;
    try {
      for (const event of piHistoryEvents(res.data.messages)) this.emitEvent(event);
    } catch {
      // A resumed session without its backstory still works.
    }
  }

  /**
   * Learn pi's command list for the picker via its own `get_commands` RPC
   * (docs/rpc.md: "Get available commands (extension commands, prompt
   * templates, and skills). These can be invoked via the `prompt` command by
   * prefixing with `/`.") — a genuine side-channel query, not a prompt, so
   * unlike `AgySession`'s `/help` probe this has no conversation-visible
   * shape to suppress in the first place. Best-effort: a failure here just
   * means no picker, never a broken session.
   *
   * Deliberately excludes pi's built-in TUI commands (`/model`, `/settings`,
   * `/login`, `/new`, `/tree`, `/resume`, `/compact`, `/reload`, ... — pi's
   * own docs list plenty more) — and this is not a gap to close later, it is
   * what pi's docs say `get_commands` is *for*: "Built-in TUI commands
   * (`/settings`, `/hotkeys`, etc.) are not included. They are handled only
   * in interactive mode **and would not execute if sent via `prompt`**"
   * (docs/rpc.md, verbatim; docs/extensions.md says the same). That last
   * clause is the reason this class never hand-lists the *TUI slash command*
   * the way one might be tempted to: pi's own maintainers confirm sending one
   * through this session's `prompt()` would not do the thing its name
   * suggests, so a picker entry for one would render but lie. What
   * `get_commands` *does* return (extension commands, prompt templates,
   * skills) is genuinely invocable via `prompt` and is exactly what this
   * reports.
   *
   * `/model` specifically is a different story from the RPC side, not the
   * `prompt` side: `get_available_models`/`set_model`/`set_thinking_level`
   * (confirmed live, v0.84.1) are genuine, scriptable, non-TUI RPC methods —
   * see `fetchInitialModels`/`setModel`/`setEffort` below. Nothing above
   * contradicts that; it only ever ruled out reaching the *TUI command* by
   * typing `/model` as a message, which was never the channel those use.
   */
  private async fetchInitialCommands(): Promise<void> {
    const res = await this.sendCommand('get_commands');
    if (!res.success || !isRecord(res.data)) return;
    this.emitEvent({ kind: 'commands_available', commands: normalizeSlashCommands(res.data.commands) });
  }

  /** Fetch the model catalog for the picker, via pi's own `get_available_models` RPC (docs/rpc.md). Best-effort, same discipline as `fetchInitialCommands`. */
  private async fetchInitialModels(): Promise<void> {
    const res = await this.sendCommand('get_available_models');
    if (!res.success || !isRecord(res.data)) return;
    const models = normalizePiModels(res.data.models);
    if (models.length > 0) this.emitEvent({ kind: 'models_available', models });
  }

  /**
   * Report the model/effort pi actually started with, via `get_state`
   * (docs/rpc.md) — unlike the other three structured sessions, this is not
   * folded into `session_started`: that event already fired synchronously in
   * `start()` before this RPC round trip could resolve, and every other field
   * on it comes from the spawn args, not a query. Reusing `model_changed`/
   * `effort_changed` to report it is not quite literal ("changed" from what?)
   * but is exactly the update the composer needs to apply, and both events
   * are already REPLACE-semantics in the UI reducer either way.
   */
  private async reportCurrentModelAndEffort(): Promise<void> {
    const res = await this.sendCommand('get_state');
    if (!res.success || !isRecord(res.data)) return;
    const model = normalizePiModelValue(res.data.model);
    if (model) this.emitEvent({ kind: 'model_changed', model });
    if (typeof res.data.thinkingLevel === 'string' && res.data.thinkingLevel) {
      this.emitEvent({ kind: 'effort_changed', effort: res.data.thinkingLevel });
    }
  }

  /**
   * Switch the model this session uses, via pi's own `set_model` RPC
   * (docs/rpc.md: `{type: 'set_model', provider, modelId}`, confirmed live
   * v0.84.1) — effective immediately in practice (pi applies it to the live
   * session state), but reported with the same "next prompt" framing as
   * every other backend's live switch since a turn already in flight is not
   * retried against it. `model` is the composite `provider/id` value
   * `normalizePiModel` produces; anything else is a caller bug, not a pi
   * failure, so it is reported the same way as a real RPC error.
   */
  async setModel(model: string): Promise<void> {
    if (!this.isAlive()) return;
    const slash = model.indexOf('/');
    if (slash < 0) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch model: expected "provider/id", got "${model}".`,
      });
      return;
    }
    const res = await this.sendCommand('set_model', {
      provider: model.slice(0, slash),
      modelId: model.slice(slash + 1),
    });
    if (!res.success) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch model: ${res.error ?? 'unknown error'}`,
      });
      return;
    }
    this.emitEvent({ kind: 'model_changed', model });
  }

  /**
   * Switch the reasoning/thinking level, via pi's own `set_thinking_level`
   * RPC (docs/rpc.md, confirmed live v0.84.1). `null` (the composer's
   * "Default" option) has nothing to map onto: pi's levels are `"off"`,
   * `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, and there
   * is no documented "clear the override" call — `"off"` is a real, distinct
   * level (no reasoning at all), not a synonym for "whatever the model
   * defaults to". Rather than silently guess one, this reports that there is
   * nothing to do, the same way a real RPC failure would be reported.
   */
  async setEffort(effort: string | null): Promise<void> {
    if (!this.isAlive()) return;
    if (effort === null) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: 'pi has no "reset to default" effort — pick an explicit level instead.',
      });
      return;
    }
    const res = await this.sendCommand('set_thinking_level', { level: effort });
    if (!res.success) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch effort: ${res.error ?? 'unknown error'}`,
      });
      return;
    }
    this.emitEvent({ kind: 'effort_changed', effort });
  }

  private handleChunk(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      let line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // Never let one malformed line take down the session.
    }
    if (!isRecord(message)) return;
    this._lastActivityAt = Date.now();

    if (message.type === 'response' && typeof message.id === 'string') {
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message as unknown as CommandResponse);
      }
      return;
    }

    if (message.type === 'message_start') this.messageSeq++;
    if (message.type === 'message_end') this.captureAssistantUsage(message);

    for (const event of normalizePiEventSafe(message, this.messageSeq)) {
      if (event.kind === 'turn_complete') {
        this.setBusy(false);
        this.emitEvent(this.lastAssistant ? { ...event, ...this.usageFields() } : event);
        this.lastAssistant = null;
        continue;
      }
      this.emitEvent(event);
    }
  }

  private captureAssistantUsage(message: Record<string, unknown>): void {
    const inner = message.message;
    if (!isRecord(inner) || inner.role !== 'assistant') return;
    const usage = isRecord(inner.usage) ? inner.usage : {};
    const cost = isRecord(usage.cost) ? usage.cost : {};
    this.lastAssistant = {
      input: typeof usage.input === 'number' ? usage.input : null,
      output: typeof usage.output === 'number' ? usage.output : null,
      cost: typeof cost.total === 'number' ? cost.total : null,
      stopReason: typeof inner.stopReason === 'string' ? inner.stopReason : null,
    };
  }

  private usageFields(): { costUsd: number | null; inputTokens: number | null; outputTokens: number | null; isError: boolean; stopReason: string | null } {
    const a = this.lastAssistant;
    const stopReason = a?.stopReason ?? null;
    return {
      costUsd: a?.cost ?? null,
      inputTokens: a?.input ?? null,
      outputTokens: a?.output ?? null,
      isError: stopReason === 'error' || stopReason === 'aborted',
      stopReason,
    };
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

  /** Stamps `busySince` only on an actual false->true transition. */
  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._busySince = busy ? Date.now() : null;
  }

  private sendCommand(type: string, params: Record<string, unknown> = {}): Promise<CommandResponse> {
    const id = `pa_${this.nextRequestId++}`;
    return new Promise((resolve) => {
      if (!this.child) {
        resolve({ success: false, error: 'pi is not running.' });
        return;
      }
      this.pending.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n');
    });
  }

  // ---- Conversation ------------------------------------------------------------

  prompt(text: string): boolean {
    if (!this.isAlive()) return false;
    this._lastActivityAt = Date.now();
    this.setBusy(true);
    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    void this.sendCommand('prompt', { message: text }).then((res) => {
      if (!res.success) {
        this.setBusy(false);
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: `Failed to send the prompt: ${res.error ?? 'unknown error'}`,
        });
      }
    });
    return true;
  }

  async interrupt(): Promise<void> {
    const res = await this.sendCommand('abort');
    if (res.success) {
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
    } else {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Interrupt failed: ${res.error ?? 'unknown error'}`,
      });
    }
  }

  /** No-op: there has never been anything pending to drain — see `pendingPermissions`. */
  applyGlobalSkipPermissions(_enabled: boolean): Promise<void> {
    return Promise.resolve();
  }

  // ---- Approvals -----------------------------------------------------------------
  //
  // pi has no approval concept anywhere (see `agents/pi.ts`), so there is
  // never anything pending here. These exist only so `PiSession` is
  // structurally interchangeable with the other three wherever the manager
  // and the WebSocket layer narrow on `transport === 'structured'`.

  pendingPermissions(): PermissionRequestEvent[] {
    return [];
  }

  resolvePermission(): boolean {
    return false;
  }

  // ---- Teardown --------------------------------------------------------------------

  terminate(graceMs?: number): void {
    if (!this.isAlive()) return;
    this._endedAt = Date.now();
    this.setStatus('killed');

    const child = this.child;
    if (!child) return;
    child.kill('SIGTERM');
    if (graceMs && graceMs > 0) {
      const killer = setTimeout(() => {
        if (this.child === child) child.kill('SIGKILL');
      }, graceMs);
      killer.unref?.();
    }
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    this.pending.clear();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never let one malformed pi payload kill the session's event handling. */
function normalizePiEventSafe(message: unknown, messageSeq: number): AgentEvent[] {
  try {
    return normalizePiEvent(message, messageSeq);
  } catch {
    return [];
  }
}
