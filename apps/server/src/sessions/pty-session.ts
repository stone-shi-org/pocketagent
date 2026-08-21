import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SessionStatus, TerminalHintKind } from '@pocketagent/protocol';
import { OutputBuffer } from '../terminal/output-buffer.js';
import { HeuristicTerminalClassifier } from '../terminal/classifier.js';
import type { ProcessBackend, ProcessHandle } from '../backends/index.js';

export interface PtySessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Names of adapter-supplied overrides. Values are never persisted. */
  envOverrideKeys: string[];
  cols: number;
  rows: number;
  workspaceLabel: string;
  outputBufferBytes: number;
  createdAt: number;
  /**
   * True when this session attached to a pane someone else started. The client
   * must not auto-resize it: the size is shared with the other viewer.
   */
  adopted?: boolean;
  /**
   * Stable id of the adopted tmux pane (`AdoptableTarget.id`), persisted so a
   * later attach to the same pane can be recognized as the same chat. Null
   * for a session that is not adopted.
   */
  adoptTargetId?: string | null;
  /**
   * The ephemeral "session group" view `AdoptionService.attachCommand`
   * created for this attach, if any — passed back to
   * `AdoptionService.cleanupView` once this session's process exits (see
   * `SessionManager.wire`). Null for a session that is not adopted.
   */
  adoptViewSession?: { socket: string; name: string } | null;
  /**
   * True when `args` already includes the adapter's auto-approve flag. Pure
   * metadata for display (`SessionInfo.skipPermissionsEnabled`) — the flag
   * itself was baked into `args` by the adapter's `buildCommand`, not applied
   * here.
   */
  skipPermissions?: boolean;
}

export interface PtySessionEvents {
  output: [seq: number, data: string];
  status: [status: SessionStatus];
  exit: [exitCode: number | null, exitSignal: number | null];
  hint: [hints: TerminalHintKind[]];
}

/**
 * Output is coalesced over a short window before being assigned a sequence
 * number. A CLI redrawing a spinner can emit hundreds of tiny writes per
 * second; one WebSocket frame per write would be pure overhead on a phone. The
 * delay is short enough to be imperceptible while typing.
 */
const FLUSH_INTERVAL_MS = 8;
const FLUSH_THRESHOLD_BYTES = 64 * 1024;

/** How long a terminated process gets to exit before SIGKILL. */
const KILL_GRACE_MS = 5_000;

export class PtySession extends EventEmitter<PtySessionEvents> {
  readonly transport = 'terminal' as const;
  /** Terminal sessions have no agent-side conversation to resume. */
  readonly agentSessionId: string | null = null;
  readonly id: string;
  readonly spec: PtySessionSpec;
  readonly buffer: OutputBuffer;

  /**
   * Identifies this run of the output stream.
   *
   * Sequence numbers are only meaningful within an epoch. When a session is
   * re-adopted after a server restart the buffer starts empty and numbering
   * restarts, so a client holding `seq=500` from the previous epoch must be
   * told to resynchronise rather than silently resuming into a fresh stream.
   */
  readonly epoch: string;

  private backend: ProcessBackend;
  private handle: ProcessHandle | null = null;
  private classifier = new HeuristicTerminalClassifier();

  private _status: SessionStatus = 'starting';
  private _pid: number | null = null;
  private _cols: number;
  private _rows: number;
  private _exitCode: number | null = null;
  private _exitSignal: number | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _startError: string | null = null;
  private _externalId: string | null = null;
  /**
   * Advisory only, same spirit as the `hint` events it is derived from: true
   * once the classifier's current state includes `working`, false once it
   * settles on `idle` or a state that is blocking on the human
   * (`waiting_for_input`/`possible_approval_prompt`) rather than generating.
   * Read via `currentHints()`, not the `hint` event payload — see that
   * method's doc comment for why (the event is dedup-gated and would leave
   * this stuck on a stale value).
   */
  private _busy = false;
  /** See `busySince` getter. */
  private _busySince: number | null = null;

  private pending: string[] = [];
  private pendingBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  /**
   * Set when we ask the process to die. Status stays `running` until the
   * process actually exits — a terminating session is still attached, still
   * draining output, and still able to receive input during the grace period.
   */
  private killRequested = false;

  constructor(spec: PtySessionSpec, backend: ProcessBackend, epoch?: string) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.backend = backend;
    this._cols = spec.cols;
    this._rows = spec.rows;
    this.buffer = new OutputBuffer(spec.outputBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
  }

  get status(): SessionStatus {
    return this._status;
  }
  get pid(): number | null {
    return this._pid;
  }
  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
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
    return this._externalId;
  }
  get backendId(): string {
    return this.backend.id;
  }
  get survivesServerRestart(): boolean {
    return this.backend.survivesServerRestart;
  }
  get busy(): boolean {
    return this._busy;
  }
  /** See `StructuredSession.busySince`'s doc comment. */
  get busySince(): number | null {
    return this._busySince;
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  /** Launch the process. Rejects if it could not be started. */
  async start(): Promise<void> {
    if (this.handle) throw new Error('session already started');
    try {
      const handle = await this.backend.start({
        sessionId: this.id,
        command: this.spec.command,
        args: this.spec.args,
        cwd: this.spec.cwd,
        env: this.spec.env,
        cols: this._cols,
        rows: this._rows,
      });
      this.adopt(handle, Date.now());
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }
  }

  /**
   * Take ownership of a process that is already running — either one we just
   * started, or one recovered from a previous server.
   */
  adopt(handle: ProcessHandle, startedAt: number): void {
    this.handle = handle;
    this._pid = handle.pid;
    this._externalId = handle.externalId;
    this._startedAt = startedAt;
    this._lastActivityAt = Date.now();
    this.setStatus('running');

    handle.onData((data) => this.handleData(data));
    handle.onExit((exitCode, signal) => this.handleExit(exitCode, signal));
  }

  private handleData(data: string): void {
    if (data.length === 0) return;
    this._lastActivityAt = Date.now();
    this.pending.push(data);
    this.pendingBytes += data.length;

    if (this.pendingBytes >= FLUSH_THRESHOLD_BYTES) {
      this.flush();
      return;
    }
    if (this.flushTimer === null) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  private flush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.length === 0) return;

    const data = this.pending.join('');
    this.pending = [];
    this.pendingBytes = 0;

    const seq = this.buffer.append(data);
    this.emit('output', seq, data);

    const hints = this.classifier.process(data);
    this.updateBusy();
    if (hints.length > 0) this.emit('hint', hints);
  }

  /** See `_busy`'s doc comment for why this reads `currentHints()`, not `hints`. */
  private updateBusy(): void {
    const hints = this.classifier.currentHints();
    if (hints.includes('working')) this.setBusy(true);
    else if (hints.length > 0) this.setBusy(false);
    // No hint at all yet (brand new session): leave the initial `false` rather
    // than guessing from silence.
  }

  /**
   * Stamps `busySince` only on an actual false->true transition. Guarding here
   * matters more than in the structured backends: `updateBusy()` runs on every
   * flush regardless of whether the hint actually changed, and an unguarded
   * write would restamp `busySince` continuously while `working` persists —
   * exactly the churn this field exists to avoid.
   */
  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._busySince = busy ? Date.now() : null;
  }

  private handleExit(exitCode: number | null, signal: number | null): void {
    this.flush();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    this._exitCode = exitCode;
    this._exitSignal = signal;
    this._endedAt = Date.now();
    this.handle = null;
    // A process we asked to die is `killed`; one that finished on its own is
    // `exited`. The distinction matters in the session list.
    this.setStatus(this.killRequested || signal ? 'killed' : 'exited');
    this.emit('exit', exitCode, signal);
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  write(data: string): void {
    if (!this.handle) return;
    this._lastActivityAt = Date.now();
    this.handle.write(data);
  }

  resize(cols: number, rows: number): boolean {
    if (cols === this._cols && rows === this._rows) return false;
    this._cols = cols;
    this._rows = rows;
    this.handle?.resize(cols, rows);
    return true;
  }

  /**
   * Deliver a signal the way a terminal would.
   *
   * SIGINT and SIGQUIT are written as the control characters ^C and ^\ so the
   * tty line discipline delivers them to the *foreground process group* — that
   * is what happens when a human presses Ctrl+C, and it is what interrupts a
   * running command rather than killing the shell hosting it.
   *
   * The rest go to the process leader directly, because there is no keystroke
   * for them.
   */
  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'): void {
    if (!this.handle) return;
    if (sig === 'SIGINT') {
      this.write('\x03');
      return;
    }
    if (sig === 'SIGQUIT') {
      this.write('\x1c');
      return;
    }
    if (sig === 'SIGKILL' || sig === 'SIGTERM') this.killRequested = true;
    this.handle.kill(sig);
  }

  /**
   * Terminate: SIGTERM, then SIGKILL if it has not exited in time.
   *
   * The escalation is not optional. An interactive shell ignores SIGTERM
   * outright, so without the follow-up SIGKILL "Stop" would appear to do
   * nothing.
   */
  terminate(graceMs = KILL_GRACE_MS): void {
    if (!this.handle) return;
    this.killRequested = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    this.handle.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      this.handle?.kill('SIGKILL');
    }, graceMs);
    this.killTimer.unref?.();
  }

  /**
   * Stop watching without stopping the process. Only meaningful on a backend
   * whose processes outlive us; the manager checks before calling.
   */
  detachProcess(): void {
    this.handle?.detach();
    this.handle = null;
  }

  /** Advisory idle check, driven by the manager's sweep timer. */
  pollIdleHint(): void {
    const hints = this.classifier.checkIdle();
    this.updateBusy();
    if (hints.length > 0) this.emit('hint', hints);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.flushTimer = null;
    this.killTimer = null;
    this.removeAllListeners();
  }
}
