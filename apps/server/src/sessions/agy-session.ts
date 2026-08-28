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
  /**
   * Set only while waiting out a transient-error backoff between retries
   * (see `MAX_TURN_RETRIES`), i.e. exactly when `child` is null but a turn
   * is still logically in flight. `interrupt()` checks this first: without
   * it, hitting stop during that window found no `child` to kill, did
   * nothing visible, and the scheduled retry fired anyway right after —
   * indistinguishable from interrupt being silently ignored.
   */
  private cancelPendingRetry: (() => void) | null = null;
  /** Set by `setModel`; included in the next (and every later) turn's argv. */
  private _desiredModel: string | null = null;

  private _status: SessionStatus = 'starting';
  private _agentSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;
  /** See `busySince` getter. */
  private _busySince: number | null = null;
  /**
   * `tool_use` ids of `invoke_subagent` calls still awaiting resolution.
   * agy's own step lifecycle for that tool call marks itself `DONE` almost
   * immediately — confirmed live not to mean the background sub-agent
   * actually finished (see `normalizeAgyStepUpdate`'s doc comment) — and
   * pushes nothing else when it really does. The one boundary that *is*
   * trustworthy, confirmed against the same live run, is the turn's own
   * `result` line: resolved here in `runTurn`, and defensively in `finish()`
   * too, so a turn that errors or gets killed mid-flight cannot leave a
   * fleet-view chip stuck open forever either.
   */
  private readonly pendingSubagents = new Set<string>();

  /**
   * How many times a turn is silently re-run before its error is finally
   * shown to the user, when that error looks transient (see
   * `TRANSIENT_ERROR_PATTERN`). Kept small: a *persistent* problem (the host
   * genuinely cannot reach the Antigravity backend) should still surface
   * within a few seconds rather than stall the turn indefinitely behind
   * silent retries.
   */
  private static readonly MAX_TURN_RETRIES = 2;

  /**
   * Backoff before each retry, indexed by attempt number (0-based); the last
   * entry repeats for any attempt beyond its length.
   */
  private static readonly RETRY_BACKOFF_MS = [1000, 3000];

  /**
   * Backoff before the one conversation-reset retry described on
   * `runTurn`'s `conversationResetTried` parameter. Deliberately the same as
   * the first normal retry's backoff — this is not a slower path, just a
   * different one.
   */
  private static readonly CONVERSATION_RESET_BACKOFF_MS = AgySession.RETRY_BACKOFF_MS[0];

  /**
   * Matches agy's own `result.error` text for a turn that failed for an
   * infrastructure reason — a network hiccup or a timeout talking to the
   * Antigravity backend — rather than something a retry can never fix (a
   * quota error, a bad prompt, an auth failure; see the `QUOTA` case
   * `normalizeAgyResult` already surfaces verbatim, which must NOT match
   * this). Confirmed live on a prod host: "timeout waiting for response"
   * surfaced from an otherwise healthy conversation, and a plain re-run of
   * the same turn succeeded — so retrying automatically here trades a few
   * seconds of silent delay for not dropping the user's prompt on a hiccup
   * that had nothing to do with what they asked.
   */
  private static readonly TRANSIENT_ERROR_PATTERN =
    /\btimed?\s*out\b|deadline exceeded|context canceled|context cancelled|econnreset|etimedout|eai_again|enotfound|econnrefused|socket hang up|network error|connection reset|\bunavailable\b/i;

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
  /** See `StructuredSession.busySince`'s doc comment. */
  get busySince(): number | null {
    return this._busySince;
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
   * The flags every `-p` invocation needs, including `--add-dir <cwd>`.
   *
   * **`--add-dir` is load-bearing, not a hint.** Spawning agy with
   * `{ cwd }` is not enough to make it work in that directory: agy resolves
   * its *workspace* from its own project registry
   * (`~/.gemini/antigravity-cli/cache/projects.json`), entirely
   * independently of the OS-level cwd of the process. Its own changelog
   * calls this out at 1.0.12 — "updated the project resolution logic to
   * default regardless of the active workspace" — so with no `--add-dir`
   * and no `--project`, every session silently lands in the default
   * project, whose workspace is agy's own scratch directory
   * (`~/.gemini/antigravity-cli/scratch`).
   *
   * Reproduced outside PocketAgent against v1.1.22: spawned with cwd
   * `/tmp/agyprobe/testA` and asked to write a file "in your current
   * working directory", agy wrote it to
   * `~/.gemini/antigravity-cli/scratch/` instead. Adding `--add-dir <cwd>`
   * put the same write in the intended directory, on a fresh conversation
   * *and* on a resumed one (`--conversation <id>`), and did not add an
   * entry to `projects.json` — so this is a per-invocation workspace
   * override with no persistent side effect. It must be passed on **every**
   * turn, since each turn is a fresh process (see the class doc comment).
   *
   * Note what is *not* checkable here: agy's `init` line reports only
   * `cwd`, `tools` and `permission_mode` — never the workspace it actually
   * resolved — and its `cwd` field faithfully echoes the OS cwd we spawned
   * with even when the workspace is wrong. There is therefore no signal in
   * the event stream to verify this against; passing the flag is the whole
   * of the guarantee.
   */
  private baseArgs(): string[] {
    return [
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--add-dir',
      this.spec.cwd,
    ];
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
    // `--add-dir` matters even for this probe: workspace-local slash commands
    // and skills live under the workspace, so asking the default (scratch)
    // project for `/help` would list a different set than the session's own
    // directory actually has.
    const args = [...this.baseArgs(), '-p', '/help'];

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

  /** Stamps `busySince` only on an actual false->true transition. */
  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._busySince = busy ? Date.now() : null;
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
    this.setBusy(true);

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
      if (!this.closed) this.setBusy(false);
    }
  }

  /**
   * `attempt` is 0 for the user's original request and increments on each
   * silent retry of a transient failure (see `TRANSIENT_ERROR_PATTERN`) —
   * `drain()` and `child.on('close')`'s retry branch below are the only two
   * regular callers, and both always pass the same `text`, so the whole
   * retry chain is one logical turn from the outside: one `user_prompt`, one
   * eventual `turn_complete`.
   *
   * `conversationResetTried` guards a separate, one-shot escape hatch: some
   * `--conversation <id>` gets permanently wedged server-side and returns a
   * transient-*looking* error (see `TRANSIENT_ERROR_PATTERN`) on every turn
   * forever, not just this one — confirmed live by replaying a turn against
   * such a conversation twice outside PocketAgent: both replays finished in
   * a few seconds with the model's answer already in `result.response`, yet
   * `result.status` was still `ERROR`/`"context canceled"` and
   * `result.duration_seconds` (600+, climbing by wall-clock between the two
   * replays rather than by either replay's own runtime) pointed at a
   * deadline attached to the conversation itself, not to any one process.
   * Retrying that conversation, however many times, can never succeed. Once
   * the normal retry budget above is exhausted *and* this attempt was
   * continuing an existing conversation, the `close` handler below drops
   * `_agentSessionId` and spends this one extra attempt on a brand-new
   * conversation instead of surfacing the error — set here (not left to
   * default) precisely so that fresh attempt can never trigger a second
   * reset if it also happens to fail.
   */
  private runTurn(text: string, attempt = 0, conversationResetTried = false): Promise<void> {
    return new Promise((resolve) => {
      // Captured once per attempt: `this._agentSessionId` only changes when
      // this attempt's own `init` line reports one (see the `!pendingRetryText`
      // branch below), so every retry of the *same* wedged conversation still
      // sees the id it started with, and a post-reset fresh attempt correctly
      // sees `null`.
      const resumedConversationId = this._agentSessionId;
      const args = [...this.baseArgs(), '-p', text];
      if (resumedConversationId) args.push('--conversation', resumedConversationId);
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
      // Set when the `result` line itself already surfaced agy's own error
      // text as a notice (see `normalizeAgyResult`) — e.g. a quota-exhausted
      // "Eligibility check failed: RESOURCE_EXHAUSTED..." from the
      // Antigravity backend, which reliably exits non-zero with an *empty*
      // stderr right after printing that JSON. Without this flag, `close`
      // below would follow the real reason with a second, useless "agy
      // exited with code 1" notice.
      let resultErrorShown = false;
      // Set instead of `resultErrorShown` when this `result` line's error
      // looks transient and either there is retry budget left, or this is
      // the one-shot conversation-reset case (see `pendingWedgedReset`) —
      // see `TRANSIENT_ERROR_PATTERN`. `close` below reads this to respawn
      // rather than surfacing the error.
      let pendingRetryText: string | null = null;
      // Set alongside `pendingRetryText` specifically for the wedged-
      // conversation case (`runTurn`'s `conversationResetTried` doc comment):
      // distinguishes "respawn against the same conversation" from "drop the
      // conversation id and respawn fresh" in the `close` handler below.
      let pendingWedgedReset = false;

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
          const status = typeof result.status === 'string' ? result.status : undefined;
          const errorText = typeof result.error === 'string' ? result.error.trim() : '';
          const looksTransient =
            status !== undefined &&
            status !== 'SUCCESS' &&
            errorText.length > 0 &&
            AgySession.TRANSIENT_ERROR_PATTERN.test(errorText);
          const isRetryable = looksTransient && attempt < AgySession.MAX_TURN_RETRIES;
          // The normal retry budget is spent, but this still looks like the
          // infrastructure-error pattern rather than something a retry can
          // never fix, and this attempt was continuing a real conversation
          // (a already-fresh attempt failing this way is a genuine dead
          // end — see `runTurn`'s `conversationResetTried` doc comment).
          const looksWedged =
            looksTransient && !isRetryable && resumedConversationId !== null && !conversationResetTried;

          if (isRetryable || looksWedged) {
            // Don't show the response or count this as the shown error: a
            // retry is coming, and the generic normalizer below is skipped
            // entirely for this line so no premature `turn_complete` fires
            // either. See `pendingRetryText`'s doc comment.
            pendingRetryText = errorText;
            pendingWedgedReset = looksWedged;
          } else {
            const response = typeof result.response === 'string' ? result.response.trim() : '';
            if (response) {
              this.emitEvent({ kind: 'text', id: `agy_final_${this.id}_${Date.now()}`, text: response });
            }
            if (status !== undefined && status !== 'SUCCESS' && errorText) {
              resultErrorShown = true;
            }
          }

          // See `pendingSubagents`'s doc comment: the turn's own `result`
          // line is the one point trusted as "the sub-agent is actually
          // done" — the step's own `DONE` moments after it started is not.
          // A retry restarts the whole turn, so any sub-agent tool card left
          // open by this attempt closes as ended-early rather than
          // "finished", the same distinction `finish()`'s defensive flush
          // below draws for a hard crash mid-flight.
          for (const toolUseId of this.pendingSubagents) {
            this.emitEvent({
              kind: 'tool_result',
              id: `agy_sub_end_${toolUseId}`,
              toolUseId,
              content:
                isRetryable || looksWedged
                  ? 'The turn hit a transient error and is being retried.'
                  : 'Subagent finished.',
              truncated: false,
              isError: isRetryable || looksWedged,
            });
          }
          this.pendingSubagents.clear();
        }

        // Skipped when retrying: the generic normalizer would turn this same
        // `result` line into a user-visible `notice`/`turn_complete` for an
        // error the retry may well erase a moment later.
        if (!pendingRetryText) {
          for (const event of normalizeAgyMessageSafe(parsed)) {
            if (event.kind === 'session_started' && event.agentSessionId) {
              this._agentSessionId = event.agentSessionId;
            }
            if (event.kind === 'tool_use' && event.name === 'invoke_subagent') {
              this.pendingSubagents.add(event.id);
            }
            this.emitEvent(event);
          }
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });

      const finish = (notice: string | null): void => {
        this.child = null;
        if (notice) this.emitEvent({ kind: 'notice', level: 'error', text: notice });
        // Defensive twin of the flush above: this only does anything if the
        // process ended (crashed, got killed) without ever producing a
        // `result` line — the normal case already cleared the set.
        for (const toolUseId of this.pendingSubagents) {
          this.emitEvent({
            kind: 'tool_result',
            id: `agy_sub_end_${toolUseId}`,
            toolUseId,
            content: 'The turn ended before this sub-agent finished.',
            truncated: false,
            isError: true,
          });
        }
        this.pendingSubagents.clear();
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
        if (signal || this.closed) {
          // Our own interrupt()/terminate() already emitted a notice, or the
          // session was torn down mid-turn — never schedule a retry either
          // way.
          finish(null);
          return;
        }
        if (pendingRetryText && pendingWedgedReset) {
          // See `runTurn`'s `conversationResetTried` doc comment: the normal
          // retry budget is spent and this conversation still looks wedged,
          // so drop it and spend one extra attempt on a brand-new one rather
          // than surface an error a retry against the *same* conversation
          // could never fix.
          this.child = null;
          this._agentSessionId = null;
          this.emitEvent({
            kind: 'notice',
            level: 'warn',
            text: `agy's conversation looks stuck (${pendingRetryText}) — starting a new conversation and retrying…`,
          });
          const retryTimer = setTimeout(() => {
            this.cancelPendingRetry = null;
            if (this.closed) {
              resolve();
              return;
            }
            this.runTurn(text, 0, true).then(resolve);
          }, AgySession.CONVERSATION_RESET_BACKOFF_MS);
          retryTimer.unref?.();
          this.cancelPendingRetry = () => {
            clearTimeout(retryTimer);
            this.cancelPendingRetry = null;
            resolve();
          };
          return;
        }
        if (pendingRetryText) {
          this.child = null;
          const backoffMs =
            AgySession.RETRY_BACKOFF_MS[Math.min(attempt, AgySession.RETRY_BACKOFF_MS.length - 1)];
          this.emitEvent({
            kind: 'notice',
            level: 'warn',
            text: `agy hit a transient error (${pendingRetryText}) — retrying (${attempt + 1}/${AgySession.MAX_TURN_RETRIES})…`,
          });
          const retryTimer = setTimeout(() => {
            this.cancelPendingRetry = null;
            if (this.closed) {
              resolve();
              return;
            }
            this.runTurn(text, attempt + 1).then(resolve);
          }, backoffMs);
          retryTimer.unref?.();
          // See `cancelPendingRetry`'s doc comment — `interrupt()` calls this
          // instead of killing a `child` that does not exist right now.
          this.cancelPendingRetry = () => {
            clearTimeout(retryTimer);
            this.cancelPendingRetry = null;
            resolve();
          };
          return;
        }
        if (code !== 0 && code !== null) {
          finish(resultErrorShown ? null : stderrTail.trim() || `agy exited with code ${code}`);
          return;
        }
        finish(null);
      });
    });
  }

  async interrupt(): Promise<void> {
    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
      return;
    }
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

    // Otherwise this would sit out the rest of the backoff window before the
    // retryTimer callback notices `closed` on its own — harmless, but pointless
    // to wait for.
    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
      return;
    }

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
