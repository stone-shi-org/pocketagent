import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { AgentEvent, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizeAgyMessage, normalizeAgyModelList } from './normalize.js';
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
  /** agy's own `conversation_id`, to continue via `--conversation`. */
  resumeAgentSessionId?: string;
  /** Absolute path to the `agy` executable, when not on PATH. */
  executablePath?: string;
  /**
   * Always `true`. Unlike `StructuredSessionSpec.skipPermissions` this is not
   * a per-session choice — see `agents/agy.ts` for why headless agy has no
   * approval gate to opt out of bypassing. Kept as a field (rather than a
   * hardcoded constant read at each call site) purely so this struct has the
   * same shape as `StructuredSessionSpec` for `SessionInfo.skipPermissionsEnabled`
   * and the persistent UI banner that reads it.
   */
  skipPermissions: true;
}

/**
 * An agent driven by spawning Google's `agy` CLI in headless
 * `--output-format stream-json` mode, once per turn.
 *
 * This is a different process shape from `StructuredSession`: the Claude
 * Agent SDK holds one long-lived query open and is fed prompts through an
 * async generator, because it *is* the agent process. `agy`'s print mode is
 * fire-and-forget — one prompt in, one NDJSON stream out, then the process
 * exits — so a multi-turn PocketAgent session here means idle-between-turns
 * with no child process at all, and a fresh `agy` invocation per prompt,
 * continued across turns with `--conversation <id>`. `isAlive()` therefore
 * reflects whether this session has been terminated, not whether a process
 * is currently running — there usually isn't one.
 *
 * There is no approval flow: `pendingPermissions()` is always empty and
 * `resolvePermission()` always reports nothing pending, because there is
 * nothing upstream that would ever call `emitEvent` with a
 * `permission_request` — see `agents/agy.ts` for why.
 */
export class AgySession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: AgySessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly queue: string[] = [];
  private draining = false;
  private closed = false;
  /** Set by `setModel`; included in the next (and every later) turn's argv. */
  private _desiredModel: string | null = null;

  private _status: SessionStatus = 'starting';
  private _agentSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;

  constructor(spec: AgySessionSpec, epoch?: string) {
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
    // Same reasoning as StructuredSession: no process to survive, but the
    // conversation does, via `--conversation <id>`.
    return false;
  }
  get agentSessionId(): string | null {
    return this._agentSessionId;
  }
  get busy(): boolean {
    return this._busy;
  }
  /** No global-bypass concept here: every session is already maximally bypassed. */
  get globalBypassActive(): boolean {
    return false;
  }
  /** No transcript store to derive a title from; the fixed creation-time title stands. */
  get derivedTitle(): string | null {
    return null;
  }
  setDerivedTitle(_title: string): void {
    // No-op: see `derivedTitle`.
  }

  isAlive(): boolean {
    return this._status === 'starting' || this._status === 'running';
  }

  // ---- Lifecycle -----------------------------------------------------------

  /** Not `async` despite matching `StructuredSession.start()`'s signature: there is nothing to await — each turn's process is spawned lazily by `prompt()`. */
  start(): Promise<void> {
    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');
    this.fetchInitialCommands();
    this.fetchInitialModels();
    return Promise.resolve();
  }

  /**
   * Learn agy's model catalog for the picker, via its own `models`
   * subcommand — confirmed live (v1.1.12): plain text, one `<id>\t<label>`
   * pair per line on stdout (its "Fetching available models..." status line
   * goes to stderr), not the `stream-json`/`-p` shape `fetchInitialCommands`
   * uses, since `models` is a genuine top-level subcommand rather than an
   * in-conversation slash command. Same best-effort discipline: a failure
   * here costs the picker, never the session.
   *
   * `child.stdin.end()` matters here specifically: unlike `-p` mode (used by
   * `fetchInitialCommands`/`runTurn`, neither of which need this), `models`
   * was confirmed live to hang forever reading an open, unclosed stdin pipe
   * — with zero output, not even its own status line — when spawned exactly
   * the way Node's default `stdio` leaves it. Closing stdin immediately
   * (rather than passing `stdio: ['ignore', ...]` to `spawn`) keeps the
   * result typed as `ChildProcessWithoutNullStreams`, since nothing else
   * here needs `stdio` to change.
   */
  private fetchInitialModels(): void {
    const bin = this.spec.executablePath ?? 'agy';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, ['models'], { cwd: this.spec.cwd, env: this.spec.env });
    } catch {
      return;
    }
    child.stdin.end();

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', () => {
      // Nothing here is worth surfacing — see the doc comment above.
    });
    child.on('error', () => {});
    child.on('close', (code) => {
      if (code !== 0) return;
      const models = normalizeAgyModelList(stdout);
      if (models.length > 0) this.emitEvent({ kind: 'models_available', models });
    });

    // Same defensive backstop as `fetchInitialCommands`'s probe.
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 10_000);
    child.on('exit', () => clearTimeout(killer));
  }

  /**
   * Switch the model agy uses starting with the *next* turn, by adding
   * `--model <value>` to that turn's spawn argv — confirmed empirically that
   * continuing a conversation (`--conversation <id>`) with a different
   * `--model` on a later invocation actually changes the effective model for
   * that and later turns. There is no live process between turns to call a
   * switch on (see the class doc comment), so this is the "next prompt"
   * contract every other backend confirms over a live channel, achieved
   * instead by respawning — which means there is also no round trip to wait
   * for: `model_changed` fires immediately rather than after a confirmation
   * that will only ever arrive once that next turn actually starts.
   */
  setModel(model: string): Promise<void> {
    if (this.isAlive()) {
      this._desiredModel = model;
      this.emitEvent({ kind: 'model_changed', model });
    }
    return Promise.resolve();
  }

  /**
   * Learn agy's built-in command list for the picker, via its own `/help` —
   * confirmed live (v1.1.12) to resolve locally with zero tokens, zero
   * duration, and no model turn, so this costs nothing and has no
   * conversation-visible side effect worth suppressing beyond not queuing it
   * like a real prompt. No `--conversation` is passed: the built-in list is
   * fixed and does not depend on any session's history. Best-effort and
   * silent — a failure here just means no picker, never a broken session, so
   * every error is swallowed rather than surfaced as a notice.
   */
  private fetchInitialCommands(): void {
    const bin = this.spec.executablePath ?? 'agy';
    const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions', '-p', '/help'];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { cwd: this.spec.cwd, env: this.spec.env });
    } catch {
      return;
    }

    // Never tracked as `this.child`: this probe is fully independent of the
    // real turn queue, so it must not be visible to interrupt()/terminate()'s
    // bookkeeping for the actual conversation.
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      for (const event of normalizeAgyMessageSafe(parsed)) {
        if (event.kind === 'commands_available') this.emitEvent(event);
      }
    });
    child.stderr.on('data', () => {
      // Nothing here is worth surfacing — see the doc comment above.
    });
    child.on('error', () => {});

    // A defensive backstop, not an expected path: real `/help` resolves
    // instantly (observed duration_seconds: 0). Guards against an orphaned
    // process if a future agy version ever makes this a real, slow turn.
    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 10_000);
    child.on('exit', () => clearTimeout(killer));
  }

  /** No-op: nothing here ever asks the operator's global switch to apply. */
  applyGlobalSkipPermissions(_enabled: boolean): Promise<void> {
    return Promise.resolve();
  }

  private setStatus(status: SessionStatus): void {
    if (this._status === status) return;
    this._status = status;
    this.emit('status', status);
  }

  private emitEvent(event: AgentEvent): void {
    const entry = this.buffer.append(event);
    this.emit('event', entry.seq, entry.event);
  }

  // ---- Conversation ----------------------------------------------------------

  /** Queue a user turn. Safe to call while a previous turn is still running. */
  prompt(text: string): boolean {
    if (!this.isAlive()) return false;
    this._lastActivityAt = Date.now();
    this._busy = true;

    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });
    this.queue.push(text);
    void this.drain();
    return true;
  }

  /** Runs queued turns one at a time — `agy` print mode is one prompt per process. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const text = this.queue.shift();
        if (text === undefined) continue;
        await this.runTurn(text);
      }
    } finally {
      this.draining = false;
      if (!this.closed) this._busy = false;
    }
  }

  private runTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions', '-p', text];
      if (this._agentSessionId) args.push('--conversation', this._agentSessionId);
      if (this._desiredModel) args.push('--model', this._desiredModel);

      const bin = this.spec.executablePath ?? 'agy';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, args, { cwd: this.spec.cwd, env: this.spec.env });
      } catch (err) {
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: `Failed to run agy: ${err instanceof Error ? err.message : String(err)}`,
        });
        resolve();
        return;
      }
      this.child = child;

      let stderrTail = '';

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this._lastActivityAt = Date.now();

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return; // Never let one malformed line take down the turn.
        }

        // Finalize any streamed text *before* the `turn_complete` that the
        // `result` line below normalizes to. The client drops a still-
        // "streaming" text block wholesale when a turn ends (it has no way to
        // match a delta stream to a completed block by id — see
        // `transcript.ts`'s `dropStreaming`), so an agy answer that only ever
        // arrived as `text_delta` chunks would render, then vanish the
        // instant the turn finished. `result.response` carries the same text
        // the deltas already streamed (observed against the real CLI,
        // v1.1.12), so it doubles as the closing block whether or not deltas
        // arrived — not just the fallback for when they didn't.
        if (isRecord(parsed) && parsed.event === 'result') {
          const result = isRecord(parsed.result) ? parsed.result : {};
          const response = typeof result.response === 'string' ? result.response.trim() : '';
          if (response) {
            this.emitEvent({ kind: 'text', id: `agy_final_${this.id}_${Date.now()}`, text: response });
          }
        }

        for (const event of normalizeAgyMessageSafe(parsed)) {
          if (event.kind === 'session_started' && event.agentSessionId) {
            this._agentSessionId = event.agentSessionId;
          }
          this.emitEvent(event);
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });

      const finish = (notice: string | null): void => {
        this.child = null;
        if (notice) this.emitEvent({ kind: 'notice', level: 'error', text: notice });
        // Busy is not reset here: `drain()` clears it once the whole queue is
        // empty, not after each individual turn, so two prompts sent back to
        // back read as one continuous "working" state rather than flickering
        // idle between them.
        resolve();
      };

      child.on('error', (err) => {
        finish(`agy failed to start: ${err.message}`);
      });

      child.on('close', (code, signal) => {
        if (signal) {
          // Our own interrupt()/terminate() already emitted a notice.
          finish(null);
          return;
        }
        if (code !== 0 && code !== null) {
          finish(stderrTail.trim() || `agy exited with code ${code}`);
          return;
        }
        finish(null);
      });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.child) return;
    this.child.kill('SIGINT');
    this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
  }

  // ---- Approvals -------------------------------------------------------------
  //
  // Headless agy has no synchronous approval channel (see agents/agy.ts), so
  // there is never anything pending here. These exist only so AgySession is
  // structurally interchangeable with StructuredSession wherever the manager
  // and the WebSocket layer narrow on `transport === 'structured'`.

  pendingPermissions(): PermissionRequestEvent[] {
    return [];
  }

  resolvePermission(): boolean {
    return false;
  }

  // ---- Teardown ----------------------------------------------------------------

  terminate(graceMs?: number): void {
    if (!this.isAlive()) return;
    this.closed = true;
    this.queue.length = 0;
    this.setStatus('killed');
    this._endedAt = Date.now();

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
    this.closed = true;
    this.queue.length = 0;
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Never let one malformed agy payload kill the pump loop. */
function normalizeAgyMessageSafe(message: unknown): AgentEvent[] {
  try {
    return normalizeAgyMessage(message);
  } catch {
    return [];
  }
}
