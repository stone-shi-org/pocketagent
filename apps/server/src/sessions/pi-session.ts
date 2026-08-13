import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizePiEvent } from './normalize.js';
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
      this._busy = false;
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
        this._busy = false;
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
    this._busy = true;
    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    void this.sendCommand('prompt', { message: text }).then((res) => {
      if (!res.success) {
        this._busy = false;
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
