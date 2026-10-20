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
  /** Initial model to use on the first turn, or null/absent for default. */
  model?: string;
  /**
   * Always `true`. Unlike `StructuredSessionSpec.skipPermissions` this is not
   * a per-session choice — see `agents/agy.ts` for why headless agy has no
   * approval gate to opt out of bypassing. Kept as a field (rather than a
   * hardcoded constant read at each call site) purely so this struct has the
   * same shape as `StructuredSessionSpec` for `SessionInfo.skipPermissionsEnabled`
   * and the persistent UI banner that reads it.
   */
  skipPermissions: true;
  /**
   * PA-75: the Pocket Agent chat that created this session via
   * `start_subagent_session`, or null for human/trigger sessions.
   */
  plannerChatId?: string | null;
}

/**
 * One in-flight turn on the session's long-lived child.
 *
 * Every field here was a closure variable in the per-turn-process version;
 * they are a struct now only because the child's stdout handler is installed
 * once per *process* and so cannot close over the turn it happens to be
 * serving. `settled` guards the two independent ways a turn can end — its
 * own `result` line, or the child dying under it — from both resolving it.
 */
interface ActiveTurn {
  readonly text: string;
  readonly attempt: number;
  readonly conversationResetTried: boolean;
  /**
   * Whether the child serving this turn was spawned with `--conversation`,
   * i.e. bound to a conversation it did not create.
   *
   * This — not "is `_agentSessionId` set?" — is what gates the wedged-
   * conversation reset, and the distinction is load-bearing now that one
   * child serves many turns: the child announces a conversation id in its own
   * `init` line the moment it starts, so after the first turn of a *brand
   * new* session `_agentSessionId` is populated too. Resetting on that would
   * throw away a conversation this process just minted, which is the "already
   * fresh attempt is a genuine dead end" case the reset deliberately excludes.
   */
  readonly resumedConversation: boolean;
  /** Wall clock at the moment this attempt's prompt was written — see `AgySession.cumulative`. */
  readonly startedAt: number;
  settled: boolean;
  /** See `AgySession.suppressCloseNotice` — set from this turn's `result` line. */
  resultErrorShown: boolean;
  /** agy's own error text, when this turn's failure looks worth retrying silently. */
  pendingRetryText: string | null;
  /** Distinguishes "resend to the same conversation" from "drop it and start fresh". */
  pendingWedgedReset: boolean;
  resolve: () => void;
}

/**
 * An agent driven by Google's `agy` CLI in headless
 * `--input-format stream-json --output-format stream-json` mode: **one
 * long-lived process per session**, fed one NDJSON prompt per line on stdin
 * and answering one `result` line per turn.
 *
 * This is the same process shape as `StructuredSession` — the Claude Agent
 * SDK holds one long-lived query open and is fed prompts through an async
 * generator, because it *is* the agent process — and agy's changelog
 * introduced this input format (1.1.15) for exactly that: "so a driver can
 * keep a session open." PocketAgent is that driver.
 *
 * **It used to be one `agy -p <prompt>` process per turn, and that silently
 * destroyed work.** agy's `run_command` hands the model a
 * `WaitMsBeforeAsync` budget (the model routinely passes 10s) and *converts
 * any command still running past it into a background task* the model then
 * polls with `manage_task`. A turn ends the moment the model answers without
 * a tool call — which it will happily do while a background task is still
 * `RUNNING`, saying something like "waiting for the tests to finish". In
 * per-turn `-p` mode, the process then exited and took the task with it;
 * confirmed live in agy's own log:
 *
 *     conversation_manager.go:1426] Cancelling steps [614] in conversation <id>
 *     manager.go:789] CLI store manager shutting down
 *
 * A 2-minute `pnpm test` was killed 71s in, the session went idle with the
 * agent's last words claiming it was waiting, and nothing was left running
 * to ever wake it. Holding one process open fixes it at the root, and does
 * more than merely not-killing the task: confirmed empirically against
 * v1.2.6, agy *defers the turn's own `result` line* until its background
 * tasks drain (a 150s task held the turn open 152.7s), where the same probe
 * under `-p` ended the turn in 5.8s and cancelled the task. So the session
 * now stays honestly `busy` for as long as work is actually outstanding.
 *
 * Two consequences of the mode worth knowing. `isAlive()` still reflects
 * whether this session has been *terminated*, not whether the child is up:
 * the child is spawned lazily by the first `prompt()` (an idle session that
 * is never prompted never spawns one) and is respawned, resuming with
 * `--conversation <id>`, if it ever dies. And agy answers its own slash
 * commands locally and refuses them on this stream — "`/x` is answered by
 * the CLI itself and is unavailable with --input-format stream-json; run it
 * as its own --print /x invocation" — so `runSlashTurn` does exactly that,
 * the same one-shot shape `fetchInitialCommands` already used for `/help`.
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
  readonly plannerChatId: string | null;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  /**
   * The session's one long-lived `agy` process, or null before the first
   * prompt has spawned it and after it has died or been killed. Unlike the
   * per-turn process this replaced, a *turn* ending does not clear this —
   * `activeTurn` tracks the turn, `child` tracks the process, and keeping
   * the two separate is the whole point (see the class doc comment).
   */
  private child: ChildProcessWithoutNullStreams | null = null;
  /**
   * The turn currently awaiting a `result` line from `child`, holding the
   * per-turn decisions that used to live as closure variables inside the
   * per-turn spawn. One child now serves many turns, so its line handler is
   * installed once and has to find the turn in flight here rather than
   * closing over it.
   */
  private activeTurn: ActiveTurn | null = null;
  /**
   * Set when the live child must be recycled before the next turn because a
   * spawn-time flag changed under it — today only `--model` (see
   * `setModel`). Deliberately deferred rather than acted on immediately: a
   * model switch must not kill a background task belonging to the turn that
   * is still running.
   */
  private respawnBeforeNextTurn = false;
  /**
   * Running totals from the last `result` line, for turning agy's figures
   * into per-turn ones.
   *
   * In per-turn `-p` mode every `result` described exactly one turn, because
   * the process *was* one turn. On a long-lived child they are
   * **conversation-cumulative** instead — confirmed live against v1.2.6: two
   * trivial consecutive turns reported `input_tokens` 15047 then 30176,
   * `num_turns` 1 then 2, and `duration_seconds` 63.7 then 64.9 for a turn
   * that actually took two seconds. Emitting those straight through would
   * make the transcript's per-turn footer (duration, `N↑ M↓`, tok/s — see
   * `Transcript.tsx`) grow without bound and read as nonsense on every turn
   * after the first.
   */
  private cumulative = { inputTokens: 0, outputTokens: 0, numTurns: 0 };
  /** Whether the live child was spawned with `--conversation` — see `ActiveTurn.resumedConversation`. */
  private childResumedConversation = false;
  /** Last 4 KB of the live child's stderr, for a death with no `result` line to explain it. */
  private stderrTail = '';
  /**
   * Set when a `result` line has already surfaced agy's own error text, so
   * the child dying moments later does not follow the real reason with a
   * useless "agy exited with code 1". The per-turn equivalent was a closure
   * variable; it outlives the turn here because the death it guards against
   * happens after the turn has been settled.
   */
  private suppressCloseNotice = false;
  private readonly queue: string[] = [];
  private draining = false;
  private closed = false;
  /**
   * Set only while waiting out a transient-error backoff between retries
   * (see `MAX_TURN_RETRIES`), i.e. exactly when no turn is in flight but one
   * is still logically outstanding. `interrupt()` checks this first:
   * without it, hitting stop during that window found nothing to interrupt,
   * did nothing visible, and the scheduled retry fired anyway right after —
   * indistinguishable from interrupt being silently ignored.
   */
  private cancelPendingRetry: (() => void) | null = null;
  /** Set by `setModel`; included in the next (and every later) child's argv. */
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
  private _derivedTitle: string | null = null;
  /**
   * The conversation's own title from agy's on-disk annotations or summaries
   * database, once `SessionManager` has read it. Supersedes `spec.title` for
   * display without mutating `spec` itself.
   */
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

  /** Not `async` despite matching `StructuredSession.start()`'s signature: there is nothing to await — each turn's process is spawned lazily by `prompt()`. */
  start(): Promise<void> {
    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');
    this.fetchInitialCommands();
    this.fetchInitialModels();
    if (this._desiredModel) {
      this.emitEvent({ kind: 'model_changed', model: this._desiredModel });
    }
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
   * `--model <value>` to the *next child's* spawn argv — confirmed
   * empirically that continuing a conversation (`--conversation <id>`) with a
   * different `--model` on a later invocation actually changes the effective
   * model for that and later turns.
   *
   * `--model` is a spawn-time flag and agy's stream input has no message that
   * changes it mid-process, so honouring this means replacing the live child.
   * That is deferred to `ensureChild` via `respawnBeforeNextTurn` rather than
   * done here, for the reason the whole class exists: recycling the process
   * *now* would kill whatever the current turn still has running in the
   * background. So this stays the same "next prompt" contract every other
   * backend confirms over a live channel, with no round trip to wait for —
   * `model_changed` fires immediately rather than after a confirmation that
   * will only ever arrive once that next turn actually starts.
   */
  setModel(model: string): Promise<void> {
    if (this.isAlive()) {
      this._desiredModel = model;
      this.respawnBeforeNextTurn = true;
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

  /**
   * Runs queued turns one at a time.
   *
   * Still strictly serial even though the child could accept a second `user`
   * frame while the first turn runs (agy queues them — "Auto-flush: sending
   * %d queued input(s)"): a turn is only recognizable as finished by its own
   * `result` line, and with two in flight there is no way to tell which
   * `result` belongs to which prompt, which is what `activeTurn` depends on.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const text = this.queue.shift();
        if (text === undefined) continue;
        await (isSlashCommand(text) ? this.runSlashTurn(text) : this.runTurn(text));
      }
    } finally {
      this.draining = false;
      if (!this.closed) this.setBusy(false);
    }
  }

  /**
   * The flags that turn print mode into a driver-held stream.
   *
   * `--print=` must carry an (empty) value *attached* to the flag: a
   * valueless `--print` swallows the next flag as its prompt, which agy
   * itself rejects ("--print took \"--input-format\" as its prompt"), and
   * passing a real prompt here is an error too ("--input-format stream-json
   * reads prompts from stdin, so a prompt given on the command line would be
   * ignored"). `--output-format stream-json` is already in `baseArgs()`, and
   * agy requires the pair — it refuses `--input-format stream-json` without
   * it.
   */
  private static readonly STREAM_INPUT_ARGS = ['--print=', '--input-format', 'stream-json'];

  /**
   * The session's long-lived child, spawned on demand and resumed against
   * the existing conversation whenever it has to be replaced.
   *
   * Returns null only when the spawn itself threw, having already surfaced
   * why — callers treat that as "this turn cannot run" rather than retrying.
   */
  private ensureChild(): ChildProcessWithoutNullStreams | null {
    // A deferred recycle (see `respawnBeforeNextTurn`) happens here, between
    // turns, rather than at the moment the flag was set — which is what
    // keeps a model switch from killing the running turn's background work.
    if (this.child && this.respawnBeforeNextTurn) this.discardChild();
    this.respawnBeforeNextTurn = false;
    if (this.child) return this.child;

    const args = [...this.baseArgs(), ...AgySession.STREAM_INPUT_ARGS];
    this.childResumedConversation = this._agentSessionId !== null;
    if (this._agentSessionId) args.push('--conversation', this._agentSessionId);
    if (this._desiredModel) args.push('--model', this._desiredModel);

    const bin = this.spec.executablePath ?? 'agy';
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, args, { cwd: this.spec.cwd, env: this.spec.env });
    } catch (err) {
      this.emitEvent({ kind: 'notice', level: 'error', text: `Failed to run agy: ${errText(err)}` });
      return null;
    }
    this.child = child;
    this.stderrTail = '';
    this.suppressCloseNotice = false;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.handleChildLine(child, line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    child.on('error', (err) => this.onChildClose(child, null, null, `agy failed to start: ${err.message}`));
    child.on('close', (code, signal) => this.onChildClose(child, code, signal, null));
    return child;
  }

  /**
   * Drop the current child because *we* are replacing it — a model change,
   * or a wedged conversation whose id is baked into this child's own argv.
   *
   * Clearing `this.child` first is what makes the death silent: every path
   * in `onChildClose` is guarded on the child still being the current one,
   * so a discarded child's `close` settles no turn and surfaces no notice.
   */
  private discardChild(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    child.kill('SIGTERM');
  }

  /** One NDJSON line from the long-lived child. */
  private handleChildLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.closed || child !== this.child) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    this._lastActivityAt = Date.now();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // Never let one malformed line take down the session.
    }

    const turn = this.activeTurn;
    // Held as a narrowed local rather than re-tested inline: a `const
    // isResult = isRecord(parsed) && ...` boolean does not carry the
    // narrowing into the blocks below.
    const record = isRecord(parsed) ? parsed : null;
    const isResult = record !== null && record.event === 'result';

    // Finalize any streamed text *before* the `turn_complete` that the
    // `result` line below normalizes to. The client drops a still-
    // "streaming" text block wholesale when a turn ends (it has no way to
    // match a delta stream to a completed block by id — see `transcript.ts`'s
    // `dropStreaming`), so an agy answer that only ever arrived as
    // `text_delta` chunks would render, then vanish the instant the turn
    // finished. `result.response` carries the same text the deltas already
    // streamed (observed against the real CLI), so it doubles as the closing
    // block whether or not deltas arrived — not just the fallback for when
    // they didn't.
    if (isResult && record) {
      const result = isRecord(record.result) ? record.result : {};
      const status = typeof result.status === 'string' ? result.status : undefined;
      const errorText = typeof result.error === 'string' ? result.error.trim() : '';
      const looksTransient =
        status !== undefined &&
        status !== 'SUCCESS' &&
        errorText.length > 0 &&
        AgySession.TRANSIENT_ERROR_PATTERN.test(errorText);
      const isRetryable = looksTransient && (turn?.attempt ?? 0) < AgySession.MAX_TURN_RETRIES;
      // The normal retry budget is spent, but this still looks like the
      // infrastructure-error pattern rather than something a retry can never
      // fix, and this attempt was continuing a real conversation (an
      // already-fresh attempt failing this way is a genuine dead end — see
      // `runTurn`'s `conversationResetTried` doc comment).
      const looksWedged =
        looksTransient &&
        !isRetryable &&
        (turn?.resumedConversation ?? false) &&
        !(turn?.conversationResetTried ?? false);

      if (turn && (isRetryable || looksWedged)) {
        // Don't show the response or count this as the shown error: a retry
        // is coming, and the generic normalizer below is skipped entirely
        // for this line so no premature `turn_complete` fires either.
        turn.pendingRetryText = errorText;
        turn.pendingWedgedReset = looksWedged;
      } else {
        const response = typeof result.response === 'string' ? result.response.trim() : '';
        if (response) {
          this.emitEvent({ kind: 'text', id: `agy_final_${this.id}_${Date.now()}`, text: response });
        }
        if (status !== undefined && status !== 'SUCCESS' && errorText) {
          if (turn) turn.resultErrorShown = true;
          this.suppressCloseNotice = true;
        }
      }

      // See `pendingSubagents`'s doc comment: the turn's own `result` line is
      // the one point trusted as "the sub-agent is actually done" — the
      // step's own `DONE` moments after it started is not. A retry restarts
      // the whole turn, so any sub-agent tool card left open by this attempt
      // closes as ended-early rather than "finished", the same distinction
      // `onChildClose`'s defensive flush draws for a death mid-flight.
      const retrying = Boolean(turn?.pendingRetryText);
      this.flushPendingSubagents(
        retrying ? 'The turn hit a transient error and is being retried.' : 'Subagent finished.',
        retrying,
      );
    }

    // Skipped when retrying: the generic normalizer would turn this same
    // `result` line into a user-visible `notice`/`turn_complete` for an error
    // the retry may well erase a moment later.
    if (!turn?.pendingRetryText) {
      for (const event of normalizeAgyMessageSafe(parsed)) {
        if (event.kind === 'session_started') {
          if (event.agentSessionId) {
            this._agentSessionId = event.agentSessionId;
          }
          if (this._desiredModel && !event.model) {
            event.model = this._desiredModel;
          }
        }
        if (event.kind === 'tool_use' && event.name === 'invoke_subagent') {
          this.pendingSubagents.add(event.id);
        }
        if (event.kind === 'turn_complete') this.makeStatsPerTurn(event, turn);
        this.emitEvent(event);
      }
    }

    if (isResult) this.completeTurn();
  }

  /**
   * The long-lived child died.
   *
   * In the per-turn version this was the normal end of every turn; here it is
   * always either our own teardown or an anomaly, because a healthy child
   * outlives the turn that spawned it.
   */
  private onChildClose(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
    startError: string | null,
  ): void {
    // A child we already replaced or deliberately discarded: its death is
    // ours, and settles nothing. See `discardChild`.
    if (child !== this.child) return;
    this.child = null;

    const turn = this.activeTurn;

    // Defensive twin of the `result` handler's flush: this only does anything
    // if the process ended without ever producing a `result` line — the
    // normal case already cleared the set.
    this.flushPendingSubagents('The turn ended before this sub-agent finished.', true);

    if (!turn) {
      // Died between turns. The next prompt respawns and resumes the
      // conversation, so this is recoverable — but it must still be said out
      // loud, because whatever agy was running in the background died with
      // it, and an unreported death there is exactly the silence this class
      // is shaped to prevent.
      if (!this.closed && !this.suppressCloseNotice) {
        this.emitEvent({
          kind: 'notice',
          level: 'warn',
          text:
            startError ??
            'agy stopped between turns, so any background task it was still running has ended. The next prompt resumes the conversation.',
        });
      }
      this.suppressCloseNotice = false;
      return;
    }

    if (startError) {
      this.settleTurn(turn, startError);
      return;
    }
    if (signal || this.closed) {
      // Our own interrupt()/terminate() already emitted a notice, or the
      // session was torn down mid-turn — never schedule a retry either way.
      this.settleTurn(turn, null);
      return;
    }
    this.settleTurn(
      turn,
      turn.resultErrorShown || code === 0 || code === null
        ? null
        : this.stderrTail.trim() || `agy exited with code ${code}`,
    );
  }

  /**
   * End a turn that never got its own `result` line — the child crashed, was
   * killed, or would not accept the write.
   *
   * Emits a synthetic `turn_complete` alongside the notice. A `result` line
   * is normally the *only* thing that produces one (see `normalizeAgyResult`),
   * so without this the transcript would keep a turn open forever on exactly
   * the paths where something already went wrong.
   */
  private settleTurn(turn: ActiveTurn, notice: string | null): void {
    if (turn.settled) return;
    turn.settled = true;
    if (this.activeTurn === turn) this.activeTurn = null;
    if (notice) this.emitEvent({ kind: 'notice', level: 'error', text: notice });
    this.emitEvent({
      kind: 'turn_complete',
      stopReason: 'ERROR',
      isError: true,
      numTurns: null,
      durationMs: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
    });
    turn.resolve();
  }

  /**
   * This turn's `result` line has been processed: resolve it, or start the
   * one retry it asked for.
   */
  private completeTurn(): void {
    const turn = this.activeTurn;
    if (!turn || turn.settled) return;
    turn.settled = true;
    this.activeTurn = null;

    if (turn.pendingWedgedReset) {
      // See `runTurn`'s `conversationResetTried` doc comment. The child
      // carries the wedged conversation id in its own argv, so it has to go
      // with it — this is the one retry that cannot reuse the live process.
      this._agentSessionId = null;
      this.discardChild();
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `agy's conversation looks stuck (${turn.pendingRetryText}) — starting a new conversation and retrying…`,
      });
      this.scheduleRetry(turn, AgySession.CONVERSATION_RESET_BACKOFF_MS, 0, true);
      return;
    }
    if (turn.pendingRetryText) {
      const backoffMs =
        AgySession.RETRY_BACKOFF_MS[Math.min(turn.attempt, AgySession.RETRY_BACKOFF_MS.length - 1)];
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `agy hit a transient error (${turn.pendingRetryText}) — retrying (${turn.attempt + 1}/${AgySession.MAX_TURN_RETRIES})…`,
      });
      // Deliberately reuses the live child: what the retry needs is the same
      // conversation, and recycling a healthy process would kill whatever it
      // still has running in the background for no reason.
      this.scheduleRetry(turn, backoffMs, turn.attempt + 1, turn.conversationResetTried);
      return;
    }
    turn.resolve();
  }

  private scheduleRetry(
    turn: ActiveTurn,
    // `number | undefined` rather than `number`: both backoff constants are
    // array lookups, which `noUncheckedIndexedAccess` widens, and setTimeout
    // itself accepts undefined (treating it as 0). Narrowing here would only
    // add a `?? fallback` that no caller can actually reach.
    backoffMs: number | undefined,
    attempt: number,
    conversationResetTried: boolean,
  ): void {
    const retryTimer = setTimeout(() => {
      this.cancelPendingRetry = null;
      if (this.closed) {
        turn.resolve();
        return;
      }
      void this.runTurn(turn.text, attempt, conversationResetTried).then(turn.resolve);
    }, backoffMs);
    retryTimer.unref?.();
    // See `cancelPendingRetry`'s doc comment — `interrupt()` calls this
    // instead of looking for a turn that is not in flight right now.
    this.cancelPendingRetry = () => {
      clearTimeout(retryTimer);
      this.cancelPendingRetry = null;
      turn.resolve();
    };
  }

  /**
   * `attempt` is 0 for the user's original request and increments on each
   * silent retry of a transient failure (see `TRANSIENT_ERROR_PATTERN`) —
   * `drain()` and `scheduleRetry()` are the only two callers, and both always
   * pass the same `text`, so the whole retry chain is one logical turn from
   * the outside: one `user_prompt`, one eventual `turn_complete`.
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
   * continuing an existing conversation, `completeTurn` drops
   * `_agentSessionId`, discards the child bound to it, and spends this one
   * extra attempt on a brand-new conversation instead of surfacing the error
   * — set here (not left to default) precisely so that fresh attempt can
   * never trigger a second reset if it also happens to fail.
   */
  private runTurn(text: string, attempt = 0, conversationResetTried = false): Promise<void> {
    return new Promise((resolve) => {
      const child = this.ensureChild();
      if (!child) {
        // `ensureChild` already surfaced why as a notice.
        resolve();
        return;
      }

      const turn: ActiveTurn = {
        text,
        attempt,
        conversationResetTried,
        resumedConversation: this.childResumedConversation,
        startedAt: Date.now(),
        settled: false,
        resultErrorShown: false,
        pendingRetryText: null,
        pendingWedgedReset: false,
        resolve,
      };
      this.activeTurn = turn;

      // The only frame agy's stream input accepts for a prompt: its own
      // validator rejects a message with no `event` field ("stream input
      // message is missing the \"event\" field") and a `user` event with no
      // `message` field.
      const frame = JSON.stringify({
        event: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      try {
        child.stdin.write(`${frame}\n`);
      } catch (err) {
        // A write to a pipe whose far end has already gone. Settle through
        // the same path a death mid-turn takes, so the prompt surfaces an
        // error rather than vanishing.
        this.settleTurn(turn, `agy is not accepting input: ${errText(err)}`);
      }
    });
  }

  /**
   * Run one `/slash` prompt as its own `--print` invocation.
   *
   * agy answers its own slash commands inside the CLI rather than through the
   * model, and refuses them on the stream-json input path outright: "/x is
   * answered by the CLI itself and is unavailable with --input-format
   * stream-json; run it as its own --print /x invocation". This is that
   * invocation — the same one-shot shape `fetchInitialCommands` already uses
   * for `/help`, but against the session's own conversation and with its
   * events surfaced, so typing `/model` in a chat still works.
   *
   * No retry budget and no `ActiveTurn`: a slash command resolves locally and
   * instantly (observed `duration_seconds: 0`), so there is no transient
   * backend failure for `TRANSIENT_ERROR_PATTERN` to be recognizing, and
   * nothing here may touch `this.child` — the long-lived process and its
   * background tasks have to survive a slash command, and `interrupt()`
   * must not mistake this for the conversation's own child.
   */
  private runSlashTurn(text: string): Promise<void> {
    return new Promise((resolve) => {
      const args = [...this.baseArgs(), '-p', text];
      if (this._agentSessionId) args.push('--conversation', this._agentSessionId);
      if (this._desiredModel) args.push('--model', this._desiredModel);

      const bin = this.spec.executablePath ?? 'agy';
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(bin, args, { cwd: this.spec.cwd, env: this.spec.env });
      } catch (err) {
        this.emitEvent({ kind: 'notice', level: 'error', text: `Failed to run agy: ${errText(err)}` });
        resolve();
        return;
      }

      let stderrTail = '';
      let done = false;
      const settle = (notice: string | null): void => {
        if (done) return;
        done = true;
        if (notice) this.emitEvent({ kind: 'notice', level: 'error', text: notice });
        resolve();
      };

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        this._lastActivityAt = Date.now();
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return;
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
      child.on('error', (err) => settle(`agy failed to start: ${err.message}`));
      child.on('close', (code, signal) => {
        if (signal || this.closed) {
          settle(null);
          return;
        }
        settle(code !== 0 && code !== null ? stderrTail.trim() || `agy exited with code ${code}` : null);
      });
    });
  }

  /**
   * Rewrite a `turn_complete`'s stats from conversation totals to this turn's
   * own share. See `cumulative` for why they are totals at all.
   *
   * `durationMs` is measured here rather than derived from
   * `result.duration_seconds`, because agy's own figure is wall-clock for the
   * whole conversation and a subtraction of it would silently include the
   * time the user spent reading the previous answer.
   */
  private makeStatsPerTurn(event: Extract<AgentEvent, { kind: 'turn_complete' }>, turn: ActiveTurn | null): void {
    if (turn) event.durationMs = Date.now() - turn.startedAt;

    // A value *below* the running total means the counter restarted — a new
    // conversation after a wedged-conversation reset, or a replacement child
    // that reports only its own work — in which case what arrived is already
    // this turn's figure rather than a total.
    const share = (reported: number | null, total: number): [number | null, number] => {
      if (reported === null) return [null, total];
      if (reported < total) return [reported, reported];
      return [reported - total, reported];
    };

    [event.inputTokens, this.cumulative.inputTokens] = share(event.inputTokens, this.cumulative.inputTokens);
    [event.outputTokens, this.cumulative.outputTokens] = share(event.outputTokens, this.cumulative.outputTokens);
    [event.numTurns, this.cumulative.numTurns] = share(event.numTurns, this.cumulative.numTurns);
  }

  private flushPendingSubagents(content: string, isError: boolean): void {
    for (const toolUseId of this.pendingSubagents) {
      this.emitEvent({
        kind: 'tool_result',
        id: `agy_sub_end_${toolUseId}`,
        toolUseId,
        content,
        truncated: false,
        isError,
      });
    }
    this.pendingSubagents.clear();
  }

  async interrupt(): Promise<void> {
    if (this.cancelPendingRetry) {
      this.cancelPendingRetry();
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
      return;
    }
    // Only a turn actually in flight is interruptible. The child now outlives
    // the turn that spawned it, so killing it while idle would destroy
    // background tasks nobody asked to stop — and would read as "interrupt
    // silently broke my dev server".
    if (!this.child || !this.activeTurn) return;
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
    // agy exits cleanly (exit code 0, no error) on stdin EOF when idle —
    // confirmed live (~700ms to close conversation and state). If we hit it with
    // SIGTERM while idle, Go's context cancellation triggers "stream input
    // cancelled: context canceled" with exit code 1.
    //
    // So on idle, close stdin and give agy a grace period to exit cleanly.
    // Only if a turn is actively in-flight (which won't read stdin until it
    // finishes) do we send SIGTERM immediately to abort in-flight execution.
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
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Does this prompt name one of agy's own slash commands?
 *
 * The trailing `(\s|$)` is load-bearing: it requires the command word to end,
 * so an absolute path typed as a prompt ("/data/homes/x — please review
 * this") is *not* mistaken for one. Without it every such prompt would be
 * routed to a one-shot `-p` process and silently lose the background-task
 * guarantee this class exists to provide, which is the same class of bug as
 * the one it replaced.
 */
function isSlashCommand(text: string): boolean {
  return /^\s*\/[A-Za-z][A-Za-z0-9_-]*(\s|$)/.test(text);
}

/** Never let one malformed agy payload kill the pump loop. */
function normalizeAgyMessageSafe(message: unknown): AgentEvent[] {
  try {
    return normalizeAgyMessage(message);
  } catch {
    return [];
  }
}
