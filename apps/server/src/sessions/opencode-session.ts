import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AgentEvent, PermissionDecision, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizeOpencodeCommands, normalizeOpencodeEvent, normalizeOpencodeModels } from './normalize.js';
import type { OpencodeServerManager } from './opencode-server.js';
import type { StructuredSessionEvents } from './structured-session.js';

export interface OpencodeSessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** opencode's own session id, to attach to an existing conversation instead of creating one. */
  resumeAgentSessionId?: string;
  /**
   * Explicit, off-by-default opt-in to auto-approving every tool call.
   *
   * Unlike agy, opencode has a genuine synchronous permission gate
   * (`permission.updated` over SSE, replied to with `POST
   * /permission/{id}/reply`) — so unlike `AgySession`, this is a real choice,
   * not a fixed fact about the CLI. When true, `OpencodeSession` auto-replies
   * "always" to every permission itself instead of forwarding it to the
   * browser, the same shape as `StructuredSession`'s `bypassPermissions`.
   */
  skipPermissions?: boolean;
}

interface CreatedSession {
  id: string;
}

/**
 * An agent driven through `opencode serve`'s HTTP + SSE API.
 *
 * Third shape of "structured" in this codebase, alongside `StructuredSession`
 * (one long-lived SDK query) and `AgySession` (one subprocess per turn):
 * opencode's server is a genuine multi-session daemon, shared across every
 * `OpencodeSession` via one `OpencodeServerManager` (see that class). This
 * object owns exactly one opencode-side session id and the PocketAgent-facing
 * event surface for it; it does not own the process.
 */
export class OpencodeSession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: OpencodeSessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private readonly pending = new Map<string, PermissionRequestEvent>();
  /** Names from the last `commands_available` fetch, so `prompt()` knows which leading `/name` to route to the command endpoint instead of sending as chat text. */
  private readonly knownCommands = new Set<string>();

  private _status: SessionStatus = 'starting';
  private _opencodeSessionId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;
  /** See `busySince` getter. */
  private _busySince: number | null = null;
  private _globalBypass = false;
  private _startError: string | null = null;
  /** Cached from the latest `message.updated` for the assistant, since `session.idle` carries no usage of its own. */
  private _lastUsage: { cost: number | null; input: number | null; output: number | null } | null = null;

  constructor(
    spec: OpencodeSessionSpec,
    private readonly server: OpencodeServerManager,
    epoch?: string,
  ) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this._opencodeSessionId = spec.resumeAgentSessionId ?? null;
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
    return 'opencode-server';
  }
  get survivesServerRestart(): boolean {
    // Same reasoning as the other two structured engines: the wrapper does
    // not survive, but opencode persists the conversation itself, so a new
    // session can attach to `agentSessionId` after a restart.
    return false;
  }
  get agentSessionId(): string | null {
    return this._opencodeSessionId;
  }
  get busy(): boolean {
    return this._busy;
  }
  /** See `StructuredSession.busySince`'s doc comment. */
  get busySince(): number | null {
    return this._busySince;
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
      if (!this._opencodeSessionId) {
        const created = await this.server.request<CreatedSession>('/session', {
          method: 'POST',
          query: { directory: this.spec.cwd },
          body: { title: this.spec.title },
        });
        this._opencodeSessionId = created.id;
      }
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    this.server.register(this._opencodeSessionId, this.spec.cwd, (raw) => this.handleRaw(raw));

    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');

    // Unlike the Agent SDK's own "system init" message or agy's `init` line,
    // opencode's session-created confirmation is the synchronous HTTP
    // response above, not something that arrives over the event stream — so
    // this is emitted directly rather than waited for.
    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this._opencodeSessionId,
      model: null,
      cwd: this.spec.cwd,
      tools: [],
      permissionMode: this.spec.skipPermissions ? 'bypassPermissions' : 'default',
    });

    void this.fetchInitialCommands();
    void this.fetchInitialModels();
  }

  /**
   * Learn opencode's model catalog for the picker, via its newer `/api/model`
   * endpoint (`v2.model.list`, confirmed live against a real, running
   * `opencode serve` instance — v1.18.18). Every other call in this class
   * uses the legacy, unprefixed endpoints (`/session`, `/command`,
   * `/session/{id}/prompt_async`, ...) since those are the ones this class
   * was originally built against; `/api/model` and `setModel`'s `/api/session/
   * {id}/model` are the one exception, reached only because there is no
   * model-catalog/switch endpoint on the legacy surface at all — confirmed by
   * enumerating the real server's own OpenAPI document, not assumed. The two
   * surfaces share the same underlying session store (also confirmed live: a
   * session created via legacy `POST /session` switches model successfully
   * through the `/api/*` endpoint), so mixing them for just this one feature
   * is safe rather than a half-migration.
   *
   * `location[directory]` uses PHP/OpenAPI "deepObject" query style — a
   * literal `[directory]` in the key, not a nested object `URLSearchParams`
   * could express any other way; `OpencodeServerManager.request`'s query
   * type is a plain string map, so this passes the bracketed key through
   * as-is rather than needing new plumbing.
   */
  private async fetchInitialModels(): Promise<void> {
    try {
      const res = await this.server.request<{ data?: unknown[] }>('/api/model', {
        method: 'GET',
        query: { 'location[directory]': this.spec.cwd },
      });
      if (!this.isAlive()) return;
      this.emitEvent({ kind: 'models_available', models: normalizeOpencodeModels(res.data) });
    } catch {
      // Best-effort, same discipline as `fetchInitialCommands` above.
    }
  }

  /**
   * Learn opencode's command list for the picker via its own `GET /command`
   * — confirmed live (v1.17.18) as a plain HTTP response, not an SSE event,
   * hence `normalizeOpencodeCommands` rather than `normalizeOpencodeEvent`.
   * Also records the names in `knownCommands`, since unlike the Claude SDK,
   * agy, and pi — where sending `/name` as plain chat text is itself enough,
   * confirmed for agy and documented for pi — opencode has no such text
   * convention: running a command is a distinct endpoint
   * (`POST /session/{id}/command`), which `prompt()` below routes to only
   * for a name this fetch actually returned. Best-effort: a failure here
   * just means no picker, never a broken session.
   *
   * Deliberately incomplete, and confirmed as such rather than assumed: this
   * only ever returns opencode's *custom* commands — its own docs
   * (https://opencode.ai/docs/commands/) draw a hard line between these and
   * "built-in commands like `/init`, `/undo`, `/redo`, `/share`, `/help`"
   * (that list is illustrative, not exhaustive — a live TUI session's
   * rotating tips surfaced `/unshare` too, which the docs never even name).
   * None of those built-ins appear in a live `GET /command` response
   * (checked against this exact repo), and there is no other documented
   * endpoint that lists them. They also do not look reachable through either
   * endpoint this class uses: the keybinds doc
   * (https://opencode.ai/docs/keybinds/) shows most TUI actions are
   * keybinding-driven, not text — the same architecture that ruled out a
   * picker for codex. Adding guessed names for these here would repeat
   * exactly the mistake `CodexSession`'s doc comment explains avoiding: a
   * picker entry that renders but silently does nothing real when picked,
   * because there is no confirmed way to invoke it headlessly. If opencode
   * ever documents a real one, wire it in then — not by guessing now.
   */
  private async fetchInitialCommands(): Promise<void> {
    if (!this._opencodeSessionId) return;
    try {
      const raw = await this.server.request<unknown>('/command', {
        method: 'GET',
        query: { directory: this.spec.cwd },
      });
      const commands = normalizeOpencodeCommands(raw);
      this.knownCommands.clear();
      for (const c of commands) this.knownCommands.add(c.name);
      this.emitEvent({ kind: 'commands_available', commands });
    } catch {
      /* best-effort — see the doc comment above */
    }
  }

  private handleRaw(raw: unknown): void {
    this._lastActivityAt = Date.now();

    // Cache the assistant's running cost/tokens — `session.idle` (mapped to
    // `turn_complete`) carries none of its own; see `normalizeOpencodeEvent`.
    if (isRecord(raw) && raw.type === 'message.updated') {
      const properties = isRecord(raw.properties) ? raw.properties : {};
      const info = isRecord(properties.info) ? properties.info : null;
      if (info && info.role === 'assistant') {
        const tokens = isRecord(info.tokens) ? info.tokens : {};
        this._lastUsage = {
          cost: typeof info.cost === 'number' ? info.cost : null,
          input: typeof tokens.input === 'number' ? tokens.input : null,
          output: typeof tokens.output === 'number' ? tokens.output : null,
        };
      }
    }

    for (const event of normalizeOpencodeEventSafe(raw)) {
      if (event.kind === 'permission_request') {
        this.handlePermissionRequest(event);
        continue;
      }
      if (event.kind === 'turn_complete') {
        this.setBusy(false);
        this.emitEvent(this._lastUsage ? { ...event, ...usageFields(this._lastUsage) } : event);
        this._lastUsage = null;
        continue;
      }
      if (isRecord(raw) && raw.type === 'session.error') this.setBusy(false);
      this.emitEvent(event);
    }
  }

  private handlePermissionRequest(event: PermissionRequestEvent): void {
    if (this.spec.skipPermissions || this._globalBypass) {
      // The bypass is realized here, not by any opencode-side flag: there is
      // no spawn-time "skip permissions" switch for `serve` mode (that only
      // exists on `opencode run`'s `--auto`), so PocketAgent auto-replies
      // itself instead of ever surfacing the request.
      void this.replyPermissionHttp(event.id, 'always');
      return;
    }
    this.pending.set(event.id, event);
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

  /** Stamps `busySince` only on an actual false->true transition. */
  private setBusy(busy: boolean): void {
    if (this._busy === busy) return;
    this._busy = busy;
    this._busySince = busy ? Date.now() : null;
  }

  // ---- Conversation ------------------------------------------------------------

  prompt(text: string): boolean {
    if (!this.isAlive() || !this._opencodeSessionId) return false;
    this._lastActivityAt = Date.now();
    this.setBusy(true);
    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    // A leading `/name` only routes to the dedicated command endpoint when
    // `name` is one this session actually fetched — anything else (including
    // a bare `/` a user typed as ordinary punctuation) is just chat text, the
    // same as it would be for every other agent. See `fetchInitialCommands`.
    const command = matchKnownCommand(text, this.knownCommands);
    const endpoint = command
      ? `/session/${this._opencodeSessionId}/command`
      : `/session/${this._opencodeSessionId}/prompt_async`;
    const body = command
      ? { command: command.name, arguments: command.args }
      : { parts: [{ type: 'text', text }] };

    void this.server
      .request(endpoint, {
        method: 'POST',
        query: { directory: this.spec.cwd },
        body,
      })
      .catch((err) => {
        this.setBusy(false);
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: `Failed to send the prompt: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this._opencodeSessionId) return;
    try {
      await this.server.request(`/session/${this._opencodeSessionId}/abort`, {
        method: 'POST',
        query: { directory: this.spec.cwd },
      });
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
   * Switch this session's model, effective on the next prompt — opencode's
   * own `v2.session.switchModel` doc string: "Switch the model used by
   * subsequent provider turns." Confirmed live (v1.18.18) that this
   * `/api/*`-surface call succeeds against a session id minted by the legacy
   * `POST /session` this class actually creates sessions through — see
   * `fetchInitialModels`'s doc comment for why the two surfaces are mixed
   * just for this feature. `model` is the composite `providerID/id` value
   * `normalizeOpencodeModels` produces; split back apart here since
   * `ModelRef` (the request body's shape) wants them separate.
   */
  async setModel(model: string): Promise<void> {
    if (!this.isAlive() || !this._opencodeSessionId) return;
    const slash = model.indexOf('/');
    if (slash < 0) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to switch model: expected "providerID/id", got "${model}".`,
      });
      return;
    }
    try {
      await this.server.request(`/api/session/${this._opencodeSessionId}/model`, {
        method: 'POST',
        body: { model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) } },
      });
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

  /** See `StructuredSession.applyGlobalSkipPermissions` — same override, same reasoning. */
  async applyGlobalSkipPermissions(enabled: boolean): Promise<void> {
    this._globalBypass = enabled;
    if (!enabled) return;
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, 'allow_session');
  }

  // ---- Approvals -----------------------------------------------------------------

  pendingPermissions(): PermissionRequestEvent[] {
    return [...this.pending.values()];
  }

  /**
   * Answer a pending approval.
   *
   * Stays synchronous, like every other `resolvePermission` in this codebase
   * (the WebSocket layer calls it without awaiting) even though replying
   * actually means an HTTP round trip: the pending-map check that decides
   * "found vs already resolved" is synchronous and in-memory, and the reply
   * itself fires as a tracked side effect — a failure there surfaces as a
   * notice rather than an exception nobody is awaiting for.
   */
  resolvePermission(id: string, decision: PermissionDecision, message?: string): boolean {
    const event = this.pending.get(id);
    if (!event) return false;
    this.pending.delete(id);
    this._lastActivityAt = Date.now();

    const reply = decision === 'deny' ? 'reject' : decision === 'allow_session' ? 'always' : 'once';
    void this.replyPermissionHttp(id, reply, message);

    this.emitEvent({
      kind: 'permission_resolved',
      id,
      decision,
      message: message?.trim() || null,
    });
    this.emit('permission', this.pendingPermissions());
    return true;
  }

  private async replyPermissionHttp(
    id: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void> {
    try {
      await this.server.request(`/permission/${id}/reply`, {
        method: 'POST',
        query: { directory: this.spec.cwd },
        body: { reply, ...(message?.trim() ? { message: message.trim() } : {}) },
      });
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Failed to reply to a permission request: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ---- Teardown --------------------------------------------------------------------

  /**
   * Stops this chat's own view of things and asks opencode to abort any
   * in-flight turn. Deliberately does not delete the opencode-side session —
   * same reasoning as `StructuredSession`: the process/wrapper ends, but the
   * conversation is opencode's to keep, resumable later via `agentSessionId`.
   */
  terminate(_graceMs?: number): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this._endedAt = Date.now();
    this.setStatus('killed');

    if (this._opencodeSessionId) {
      this.server.unregister(this._opencodeSessionId);
      void this.server
        .request(`/session/${this._opencodeSessionId}/abort`, {
          method: 'POST',
          query: { directory: this.spec.cwd },
        })
        .catch(() => undefined);
    }
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    if (this._opencodeSessionId) this.server.unregister(this._opencodeSessionId);
    this.pending.clear();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}

  /** Called by `SessionManager` when the shared `opencode serve` process dies mid-session. */
  markServerCrashed(): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this.setBusy(false);
    this._startError = 'The opencode server process exited unexpectedly.';
    this._endedAt = Date.now();
    this.setStatus('error');
    this.emitEvent({ kind: 'notice', level: 'error', text: this._startError });
    this.emit('exit', null, null);
  }
}

function usageFields(usage: { cost: number | null; input: number | null; output: number | null }): {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  return { costUsd: usage.cost, inputTokens: usage.input, outputTokens: usage.output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a leading `/name [args]` and checks `name` against the session's own
 * fetched command list. Returns null for anything else, including a `/name`
 * that *looks* like a command but was never actually reported by `GET
 * /command` — better to send it as plain chat text (which is exactly what
 * happens today, with no picker at all) than guess at a command that does
 * not exist and get a 404 back.
 *
 * Unverified against a live turn: this environment could not reach a working
 * model provider (see `summarizeOpencodeTool`'s doc comment for the same
 * caveat), so `POST /session/{id}/command` is confirmed correct against the
 * real, installed server's own OpenAPI schema, but not against an actual
 * assistant response.
 */
export function matchKnownCommand(
  text: string,
  known: ReadonlySet<string>,
): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const name = match[1];
  if (!name || !known.has(name)) return null;
  return { name, args: match[2] ?? '' };
}

/** Never let one malformed opencode payload kill this session's event handling. */
function normalizeOpencodeEventSafe(message: unknown): AgentEvent[] {
  try {
    return normalizeOpencodeEvent(message);
  } catch {
    return [];
  }
}
