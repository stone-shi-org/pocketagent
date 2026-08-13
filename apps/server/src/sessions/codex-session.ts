import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import type { AgentEvent, PermissionDecision, PermissionRequestEvent, SessionStatus } from '@pocketagent/protocol';
import { EventBuffer } from '../terminal/event-buffer.js';
import { normalizeCodexEvent, type CodexIncoming } from './normalize.js';
import type { CodexServerManager } from './codex-server.js';
import type { StructuredSessionEvents } from './structured-session.js';

const execFileAsync = promisify(execFile);

export interface CodexSessionSpec {
  id: string;
  title: string;
  agent: string;
  agentDisplayName: string;
  cwd: string;
  workspaceLabel: string;
  eventBufferBytes: number;
  createdAt: number;
  /** codex's own thread id, to resume via `thread/resume` instead of `thread/start`. */
  resumeAgentSessionId?: string;
  /**
   * Explicit, off-by-default opt-in to auto-approving every command/file
   * change. Real per-session choice, same reasoning as `OpencodeSessionSpec`:
   * `codex app-server` has a genuine synchronous approval gate, so this is
   * PocketAgent choosing not to use it — not a limit of the CLI.
   */
  skipPermissions?: boolean;
}

interface PendingApproval {
  event: PermissionRequestEvent;
  requestId: number;
}

/**
 * An agent driven through `codex app-server`'s JSON-RPC protocol.
 *
 * One `thread` (codex's term) per `CodexSession`, all sharing one
 * `codex app-server` process via `CodexServerManager` — see that class for
 * why. Approval requests (`item/commandExecution/requestApproval`,
 * `item/fileChange/requestApproval`) are genuine server->client JSON-RPC
 * requests that block the tool call until replied to; this is the one of the
 * three structured engines in this codebase where that is actually true
 * (`AgySession`'s headless mode has no such gate; `StructuredSession` and
 * `OpencodeSession` do).
 *
 * Slash commands: unlike `StructuredSession`/`AgySession`/`PiSession`, there
 * is no `supportedCommands()`-style call to ask the app-server for a live
 * list — confirmed via `codex app-server generate-json-schema --out <dir>
 * --experimental` (real, installed v0.147.0) that the protocol has no
 * command-list method and no text-based `/name` convention on `turn/start`'s
 * input; every equivalent feature (`thread/compact/start`, `model/list`,
 * `skills/list`, ...) is its own distinct JSON-RPC method. That parsing
 * normally lives in the TUI, which this class bypasses entirely, so
 * `CODEX_SLASH_COMMANDS` below is a hand-authored table (read off a live
 * `codex` TUI's own `/` picker, not guessed) mapping the subset of those
 * commands that make sense for a headless remote client onto their RPC
 * calls. `prompt()` intercepts a match before it ever reaches `turn/start`;
 * see `dispatchSlashCommand` for the mapping and for which of the TUI's ~40
 * entries were deliberately left out.
 */
export class CodexSession extends EventEmitter<StructuredSessionEvents> {
  readonly transport = 'structured' as const;
  readonly id: string;
  readonly spec: CodexSessionSpec;
  readonly buffer: EventBuffer;
  readonly epoch: string;

  private readonly pending = new Map<string, PendingApproval>();

  private _status: SessionStatus = 'starting';
  private _threadId: string | null = null;
  private _startedAt: number | null = null;
  private _endedAt: number | null = null;
  private _lastActivityAt: number | null = null;
  private _busy = false;
  private _globalBypass = false;
  private _startError: string | null = null;
  /** Cached from the latest `thread/tokenUsage/updated` — `turn/completed` carries none of its own. */
  private _lastUsage: { input: number | null; output: number | null } | null = null;

  constructor(
    spec: CodexSessionSpec,
    private readonly server: CodexServerManager,
    epoch?: string,
  ) {
    super();
    this.id = spec.id;
    this.spec = spec;
    this.buffer = new EventBuffer(spec.eventBufferBytes);
    this.epoch = epoch ?? crypto.randomBytes(8).toString('base64url');
    this._threadId = spec.resumeAgentSessionId ?? null;
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
    return 'codex-app-server';
  }
  get survivesServerRestart(): boolean {
    // Same reasoning as the other two: the wrapper does not survive, but
    // codex persists the thread itself, resumable via `agentSessionId`.
    return false;
  }
  get agentSessionId(): string | null {
    return this._threadId;
  }
  get busy(): boolean {
    return this._busy;
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
      if (this._threadId) {
        await this.server.sendRequest('thread/resume', { threadId: this._threadId });
      } else {
        const result = await this.server.sendRequest<{ thread: { id: string } }>('thread/start', {
          cwd: this.spec.cwd,
        });
        this._threadId = result.thread.id;
      }
    } catch (err) {
      this._startError = err instanceof Error ? err.message : String(err);
      this._endedAt = Date.now();
      this.setStatus('error');
      throw err;
    }

    this.server.register(this._threadId, (message) => this.handleMessage(message));

    this._startedAt = Date.now();
    this._lastActivityAt = this._startedAt;
    this.setStatus('running');

    this.emitEvent({
      kind: 'session_started',
      agentSessionId: this._threadId,
      model: null,
      cwd: this.spec.cwd,
      tools: [],
      permissionMode: this.spec.skipPermissions ? 'bypassPermissions' : 'default',
    });

    // Static, not fetched: see the class doc comment above for why there is
    // no RPC call to ask codex for this list the way the other structured
    // sessions do.
    this.emitEvent({
      kind: 'commands_available',
      commands: CODEX_SLASH_COMMANDS.map((c) => ({ ...c, aliases: [] })),
    });
  }

  private handleMessage(message: CodexIncoming): void {
    this._lastActivityAt = Date.now();

    // `thread/tokenUsage/updated` carries no renderable event of its own —
    // it exists purely to enrich the `turn_complete` that `turn/completed`
    // produces, the same two-step pattern `OpencodeSession` uses for cost.
    if (message.method === 'thread/tokenUsage/updated') {
      const usage = isRecord(message.params.tokenUsage) ? message.params.tokenUsage : {};
      const last = isRecord(usage.last) ? usage.last : {};
      this._lastUsage = {
        input: typeof last.inputTokens === 'number' ? last.inputTokens : null,
        output: typeof last.outputTokens === 'number' ? last.outputTokens : null,
      };
      return;
    }

    for (const event of normalizeCodexEventSafe(message)) {
      if (event.kind === 'permission_request') {
        if (message.id === undefined) continue; // Cannot happen in practice; normalizeCodexEvent already checks this.
        this.handlePermissionRequest(event, message.id);
        continue;
      }
      if (event.kind === 'turn_complete') {
        this._busy = false;
        this.emitEvent(this._lastUsage ? { ...event, ...usageFields(this._lastUsage) } : event);
        this._lastUsage = null;
        continue;
      }
      this.emitEvent(event);
    }
  }

  private handlePermissionRequest(event: PermissionRequestEvent, requestId: number): void {
    if (this.spec.skipPermissions || this._globalBypass) {
      // Realized here, the same way as `OpencodeSession`: there is no
      // spawn-time bypass flag for `app-server` mode, so PocketAgent replies
      // for the user instead of ever surfacing the request. `acceptForSession`
      // (not a bare `accept`) so it actually stops asking for the rest of
      // this thread, matching "skip approvals for this session".
      this.server.replyToServerRequest(requestId, { decision: 'acceptForSession' });
      return;
    }
    this.pending.set(event.id, { event, requestId });
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

  // ---- Conversation ------------------------------------------------------------

  prompt(text: string): boolean {
    if (!this.isAlive() || !this._threadId) return false;
    this._lastActivityAt = Date.now();
    this.emitEvent({ kind: 'user_prompt', id: crypto.randomBytes(6).toString('hex'), text });

    // Slash commands never reach `turn/start` — see the class doc comment.
    // Anything typed that does not match `CODEX_SLASH_COMMANDS` (including
    // codex's own composer-only commands like `/vim`) falls through to the
    // plain-text turn below, exactly like before this table existed.
    const slash = parseCodexSlashCommand(text);
    if (slash) {
      if (slash.name === 'review') {
        this.startReview(slash.args);
      } else {
        void this.runSlashCommand(slash.name, slash.args);
      }
      return true;
    }

    this._busy = true;
    void this.server
      .sendRequest('turn/start', { threadId: this._threadId, input: [{ type: 'text', text }] })
      .catch((err: unknown) => {
        this._busy = false;
        this.emitEvent({
          kind: 'notice',
          level: 'error',
          text: `Failed to send the prompt: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return true;
  }

  /**
   * `review/start` runs the review as a real turn on this same thread
   * (`delivery` defaults to inline) — its own response is just an ack, the
   * actual findings arrive the same way any other turn's output does, via
   * `handleMessage`/`turn/completed`. So this mirrors `prompt()`'s own
   * fire-and-forget shape exactly, `_busy` included, rather than going
   * through `runSlashCommand`'s "one RPC call, then done" wrapper.
   */
  private startReview(args: string): void {
    if (!this._threadId) return;
    this._busy = true;
    const target = args.trim() ? { type: 'baseBranch' as const, branch: args.trim() } : { type: 'uncommittedChanges' as const };
    void this.server.sendRequest('review/start', { threadId: this._threadId, target }).catch((err: unknown) => {
      this._busy = false;
      this.emitEvent({
        kind: 'notice',
        level: 'error',
        text: `Failed to start the review: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }

  /**
   * Every slash command *except* `/review` resolves with a single RPC
   * round-trip (list/read/set), so `_busy` brackets exactly that call —
   * unlike a real turn, nothing async follows it.
   */
  private async runSlashCommand(name: string, args: string): Promise<void> {
    this._busy = true;
    try {
      const outcome = await this.dispatchSlashCommand(name, args);
      this.emitEvent(
        outcome.display === 'output'
          ? { kind: 'command_output', id: crypto.randomBytes(6).toString('hex'), text: outcome.text }
          : { kind: 'notice', level: 'info', text: outcome.text },
      );
      if (outcome.display === 'notice' && outcome.endsSession) this.terminate();
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'error',
        text: `/${name} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this._busy = false;
    }
  }

  /**
   * The actual command table, hand-mapped from the real codex TUI's `/`
   * picker onto the app-server JSON-RPC methods confirmed to exist via
   * `codex app-server generate-json-schema --experimental` (v0.147.0). Only
   * a subset of the ~40 entries the TUI shows are here; the rest are
   * deliberately excluded:
   *
   *  - Composer/paint settings with no analog in this browser UI: `/vim`,
   *    `/keymap`, `/theme`, `/pets`, `/raw`, `/statusline`, `/title`,
   *    `/ide`, `/fast`. These configure the *ink* TUI's own rendering, which
   *    PocketAgent never runs.
   *  - `/exit` — this session's lifecycle belongs to `SessionManager`, not
   *    something a chat message should trigger.
   *  - `/new`, `/resume`, `/fork`, `/side`, `/agent`, `/approve` — each
   *    implies creating or switching to a *different* thread/session, which
   *    is a `SessionManager`-level operation (new DB row, new WS routing)
   *    a single `CodexSession` has no authority to perform on its own.
   *  - `/import`, `/plan`, `/init`, `/experimental`, `/copy`, `/mention`,
   *    `/feedback` — real RPCs exist for some of these, but each either
   *    mutates local project config, needs a second round-trip UI the
   *    picker does not have yet (`/mention`'s fuzzy file search), or (`/copy`)
   *    is purely a browser clipboard action with no server endpoint at all.
   *
   * `/diff` is the one exception that is not an RPC at all: there is no
   * `git/*` method in the schema, so the real TUI must be shelling out to
   * `git` itself. This server already runs on the same machine as the
   * working tree, so `dispatchSlashCommand` does the same thing directly.
   */
  private async dispatchSlashCommand(name: string, args: string): Promise<SlashCommandOutcome> {
    const threadId = this._threadId;
    if (!threadId) throw new Error('No active thread.');

    switch (name) {
      case 'status': {
        const { thread } = await this.server.sendRequest<{ thread: Record<string, unknown> }>('thread/read', {
          threadId,
          includeTurns: false,
        });
        const lines = [
          `thread:     ${str(thread.name) ?? '(unnamed)'} (${threadId})`,
          `cwd:        ${str(thread.cwd) ?? this.spec.cwd}`,
          `status:     ${str(thread.status) ?? 'unknown'}`,
          `cliVersion: ${str(thread.cliVersion) ?? 'unknown'}`,
        ];
        const git = isRecord(thread.gitInfo) ? thread.gitInfo : null;
        if (git && str(git.branch)) lines.push(`git branch: ${str(git.branch)}`);
        if (this._lastUsage) {
          lines.push(`last turn:  ${this._lastUsage.input ?? '?'} in / ${this._lastUsage.output ?? '?'} out tokens`);
        }
        return { display: 'output', text: lines.join('\n') };
      }
      case 'model': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('model/list', {});
        const models = Array.isArray(res.data) ? res.data.filter(isRecord) : [];
        if (models.length === 0) return { display: 'output', text: 'No models reported.' };
        const lines = models.map((m) => {
          const id = str(m.id) ?? '?';
          const label = str(m.displayName) ?? id;
          const desc = str(m.description);
          return `${id}${m.isDefault ? ' (default)' : ''} — ${label}${desc ? `: ${desc}` : ''}`;
        });
        return { display: 'output', text: lines.join('\n') };
      }
      case 'skills': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('skills/list', { cwds: [] });
        const lines = flattenListedEntries(res.data, 'skills', (s) => {
          const label = str(s.name) ?? '?';
          const state = s.enabled === false ? 'disabled' : 'enabled';
          const desc = str(s.description) ?? str(s.shortDescription) ?? '';
          return `${label} [${state}]${desc ? ` — ${desc}` : ''}`;
        });
        return { display: 'output', text: lines.length ? lines.join('\n') : 'No skills found for this project.' };
      }
      case 'hooks': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('hooks/list', { cwds: [] });
        const lines = flattenListedEntries(res.data, 'hooks', (h) => {
          const key = str(h.key) ?? '?';
          const event = str(h.eventName) ?? '?';
          const state = h.enabled === false ? 'disabled' : 'enabled';
          return `${key} on ${event} [${state}]`;
        });
        return { display: 'output', text: lines.length ? lines.join('\n') : 'No hooks configured for this project.' };
      }
      case 'mcp': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('mcpServerStatus/list', { threadId });
        const servers = Array.isArray(res.data) ? res.data.filter(isRecord) : [];
        if (servers.length === 0) return { display: 'output', text: 'No MCP servers configured.' };
        const lines = servers.map((s) => {
          const toolCount = isRecord(s.tools) ? Object.keys(s.tools).length : 0;
          return `${str(s.name) ?? '?'} [${str(s.authStatus) ?? 'unknown'}] — ${toolCount} tool(s)`;
        });
        return { display: 'output', text: lines.join('\n') };
      }
      case 'permissions': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('permissionProfile/list', {});
        const profiles = Array.isArray(res.data) ? res.data.filter(isRecord) : [];
        if (profiles.length === 0) return { display: 'output', text: 'No permission profiles reported.' };
        const lines = profiles.map((p) => {
          const desc = str(p.description);
          return `${str(p.id) ?? '?'}${p.allowed === false ? ' (not selectable)' : ''}${desc ? ` — ${desc}` : ''}`;
        });
        return { display: 'output', text: lines.join('\n') };
      }
      case 'ps': {
        const res = await this.server.sendRequest<{ data?: unknown[] }>('thread/backgroundTerminals/list', { threadId });
        const terms = Array.isArray(res.data) ? res.data.filter(isRecord) : [];
        if (terms.length === 0) return { display: 'output', text: 'No background terminals.' };
        const lines = terms.map((t) => {
          const pid = num(t.osPid);
          return `${str(t.command) ?? '?'}${pid !== null ? ` (pid ${pid})` : ''} in ${str(t.cwd) ?? '?'}`;
        });
        return { display: 'output', text: lines.join('\n') };
      }
      case 'usage': {
        const res = await this.server.sendRequest<{ summary?: unknown }>('account/usage/read', {});
        const summary = isRecord(res.summary) ? res.summary : {};
        const lines = [
          `lifetime tokens:   ${num(summary.lifetimeTokens) ?? 'unknown'}`,
          `current streak:    ${num(summary.currentStreakDays) ?? 0} day(s)`,
          `longest streak:    ${num(summary.longestStreakDays) ?? 0} day(s)`,
          `peak daily tokens: ${num(summary.peakDailyTokens) ?? 'unknown'}`,
        ];
        return { display: 'output', text: lines.join('\n') };
      }
      case 'plugins': {
        const res = await this.server.sendRequest<{ marketplaces?: unknown[] }>('plugin/list', {});
        const marketplaces = Array.isArray(res.marketplaces) ? res.marketplaces.filter(isRecord) : [];
        if (marketplaces.length === 0) return { display: 'output', text: 'No plugin marketplaces configured.' };
        const lines = marketplaces.map((m) => {
          const count = Array.isArray(m.plugins) ? m.plugins.length : 0;
          return `${str(m.name) ?? '?'}: ${count} plugin(s)`;
        });
        return { display: 'output', text: lines.join('\n') };
      }
      case 'diff': {
        const text = await gitDiffIncludingUntracked(this.spec.cwd);
        return { display: 'output', text: text || 'No changes.' };
      }
      case 'compact': {
        await this.server.sendRequest('thread/compact/start', { threadId });
        return { display: 'notice', text: 'Compacting the conversation to free up context…' };
      }
      case 'rename': {
        const newName = args.trim();
        if (!newName) return { display: 'notice', text: 'Usage: /rename <name>' };
        await this.server.sendRequest('thread/name/set', { threadId, name: newName });
        return { display: 'notice', text: `Renamed thread to "${newName}".` };
      }
      case 'goal': {
        const trimmed = args.trim();
        if (trimmed.toLowerCase() === 'clear') {
          await this.server.sendRequest('thread/goal/clear', { threadId });
          return { display: 'notice', text: 'Cleared the goal for this thread.' };
        }
        if (trimmed.toLowerCase().startsWith('set ')) {
          const objective = trimmed.slice(4).trim();
          if (!objective) return { display: 'notice', text: 'Usage: /goal set <text>' };
          await this.server.sendRequest('thread/goal/set', { threadId, objective, status: null, tokenBudget: null });
          return { display: 'notice', text: `Goal set: ${objective}` };
        }
        const res = await this.server.sendRequest<Record<string, unknown>>('thread/goal/get', { threadId });
        const objective = str(res.objective);
        if (!objective) return { display: 'output', text: 'No goal set for this thread. Use "/goal set <text>".' };
        const budget = num(res.tokenBudget);
        const lines = [
          `objective:   ${objective}`,
          `status:      ${str(res.status) ?? 'unknown'}`,
          `tokens used: ${num(res.tokensUsed) ?? 0}${budget !== null ? ` / ${budget}` : ''}`,
        ];
        return { display: 'output', text: lines.join('\n') };
      }
      case 'memories': {
        const mode = args.trim().toLowerCase();
        if (mode === 'reset') {
          await this.server.sendRequest('memory/reset', null);
          return { display: 'notice', text: 'Memory reset.' };
        }
        if (mode === 'enabled' || mode === 'disabled') {
          await this.server.sendRequest('thread/memoryMode/set', { threadId, mode });
          return { display: 'notice', text: `Memory ${mode} for this thread.` };
        }
        return { display: 'notice', text: 'Usage: /memories enabled|disabled|reset' };
      }
      case 'archive': {
        await this.server.sendRequest('thread/archive', { threadId });
        return { display: 'notice', text: 'Thread archived. Ending this session.', endsSession: true };
      }
      case 'delete': {
        await this.server.sendRequest('thread/delete', { threadId });
        return { display: 'notice', text: 'Thread deleted. Ending this session.', endsSession: true };
      }
      case 'logout': {
        await this.server.sendRequest('account/logout', null);
        return { display: 'notice', text: 'Logged out of Codex. This affects every session sharing this server process.' };
      }
      default:
        // Unreachable: `parseCodexSlashCommand` only returns names present in
        // `CODEX_SLASH_COMMANDS`, all of which are handled above.
        throw new Error(`Unhandled slash command: /${name}`);
    }
  }

  async interrupt(): Promise<void> {
    if (!this._threadId) return;
    try {
      await this.server.sendRequest('turn/interrupt', { threadId: this._threadId });
      this.emitEvent({ kind: 'notice', level: 'info', text: 'Interrupted.' });
    } catch (err) {
      this.emitEvent({
        kind: 'notice',
        level: 'warn',
        text: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** See `StructuredSession.applyGlobalSkipPermissions` — same override, same reasoning. */
  async applyGlobalSkipPermissions(enabled: boolean): Promise<void> {
    this._globalBypass = enabled;
    if (!enabled) return;
    for (const id of [...this.pending.keys()]) this.resolvePermission(id, 'allow_session');
  }

  // ---- Approvals -----------------------------------------------------------------

  pendingPermissions(): PermissionRequestEvent[] {
    return [...this.pending.values()].map((p) => p.event);
  }

  resolvePermission(id: string, decision: PermissionDecision, message?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    this._lastActivityAt = Date.now();

    // "decline" (not "cancel"): the turn continues, the same way denying one
    // tool call in Claude's flow does not end the conversation.
    const jsonDecision = decision === 'deny' ? 'decline' : decision === 'allow_session' ? 'acceptForSession' : 'accept';
    this.server.replyToServerRequest(entry.requestId, { decision: jsonDecision });

    this.emitEvent({
      kind: 'permission_resolved',
      id,
      decision,
      message: message?.trim() || null,
    });
    this.emit('permission', this.pendingPermissions());
    return true;
  }

  // ---- Teardown --------------------------------------------------------------------

  /**
   * Stops this chat's own view of things and interrupts any in-flight turn.
   * Deliberately does not archive/delete the codex-side thread — same
   * reasoning as `StructuredSession`/`OpencodeSession`: the wrapper ends, the
   * conversation is codex's to keep, resumable later via `agentSessionId`.
   */
  terminate(_graceMs?: number): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this._endedAt = Date.now();
    this.setStatus('killed');

    if (this._threadId) {
      this.server.unregister(this._threadId);
      this.server.sendRequest('turn/interrupt', { threadId: this._threadId }).catch(() => undefined);
    }
  }

  detachProcess(): void {
    this.terminate();
  }

  dispose(): void {
    if (this._threadId) this.server.unregister(this._threadId);
    this.pending.clear();
    this.removeAllListeners();
  }

  /** No-op: idle hints are a terminal-only heuristic. */
  pollIdleHint(): void {}

  /** Called by `SessionManager` when the shared `codex app-server` process dies mid-session. */
  markServerCrashed(): void {
    if (!this.isAlive()) return;
    this.pending.clear();
    this.emit('permission', []);
    this._busy = false;
    this._startError = 'The codex app-server process exited unexpectedly.';
    this._endedAt = Date.now();
    this.setStatus('error');
    this.emitEvent({ kind: 'notice', level: 'error', text: this._startError });
    this.emit('exit', null, null);
  }
}

function usageFields(usage: { input: number | null; output: number | null }): {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
} {
  return { costUsd: null, inputTokens: usage.input, outputTokens: usage.output };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** See `dispatchSlashCommand`'s doc comment for what is and is not in this table, and why. */
const CODEX_SLASH_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint: string }> = [
  { name: 'status', description: 'Show current session configuration and token usage', argumentHint: '' },
  { name: 'model', description: 'List available models and reasoning efforts', argumentHint: '' },
  { name: 'skills', description: 'Use skills to improve how Codex performs specific tasks', argumentHint: '' },
  { name: 'hooks', description: 'View configured lifecycle hooks', argumentHint: '' },
  { name: 'mcp', description: 'List configured MCP servers and their tools', argumentHint: '' },
  { name: 'permissions', description: 'List available permission profiles', argumentHint: '' },
  { name: 'ps', description: 'List background terminals for this thread', argumentHint: '' },
  { name: 'usage', description: 'View account token usage', argumentHint: '' },
  { name: 'plugins', description: 'Browse plugins', argumentHint: '' },
  { name: 'diff', description: 'Show git diff (including untracked files)', argumentHint: '' },
  { name: 'compact', description: 'Summarize conversation to prevent hitting the context limit', argumentHint: '' },
  { name: 'rename', description: 'Rename the current thread', argumentHint: '<name>' },
  { name: 'review', description: 'Review my current changes and find issues', argumentHint: '[base-branch]' },
  { name: 'goal', description: 'Set, clear, or view the goal for a long-running task', argumentHint: '[set <text> | clear]' },
  { name: 'memories', description: 'Configure memory use and generation', argumentHint: 'enabled | disabled | reset' },
  { name: 'archive', description: 'Archive this thread and end this session', argumentHint: '' },
  { name: 'delete', description: 'Permanently delete this thread and end this session', argumentHint: '' },
  { name: 'logout', description: 'Log out of Codex (ends every session on this server)', argumentHint: '' },
];

const CODEX_SLASH_COMMAND_NAMES = new Set(CODEX_SLASH_COMMANDS.map((c) => c.name));

function parseCodexSlashCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
  if (!CODEX_SLASH_COMMAND_NAMES.has(name)) return null;
  return { name, args: spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim() };
}

type SlashCommandOutcome =
  | { display: 'output'; text: string }
  | { display: 'notice'; text: string; endsSession?: boolean };

/**
 * `data` is always an array of per-cwd entries (`skills/list`, `hooks/list`
 * both shape their response this way: `{ cwd, errors, <itemsKey>: [...] }`),
 * since a project can have skills/hooks defined at more than one root.
 */
function flattenListedEntries(
  data: unknown,
  itemsKey: 'skills' | 'hooks',
  format: (item: Record<string, unknown>) => string,
): string[] {
  if (!Array.isArray(data)) return [];
  const lines: string[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) continue;
    const items = entry[itemsKey];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (isRecord(item)) lines.push(format(item));
    }
  }
  return lines;
}

const MAX_DIFF_CHARS = 8000;

/**
 * `/diff` in the real TUI runs `git` locally and renders the result itself —
 * confirmed there is no `git/*` app-server RPC in the generated schema, so
 * this server (which already runs on the same machine as the working tree)
 * does the same thing directly rather than inventing a round-trip through
 * codex for something codex's own TUI does not use one for either.
 *
 * Untracked files are diffed one at a time against `/dev/null` instead of
 * running `git add -N` first, so this never touches the user's index.
 */
async function gitDiffIncludingUntracked(cwd: string): Promise<string> {
  const tracked = await runGit(cwd, ['diff', '--no-color', 'HEAD']);
  const untrackedList = await runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  const untrackedFiles = untrackedList
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const untrackedDiffs = await Promise.all(
    untrackedFiles.map((file) =>
      runGit(cwd, ['diff', '--no-color', '--no-index', '/dev/null', file]).catch((err: unknown) => {
        // `--no-index` exits 1 when the two sides differ — the expected case
        // for a brand-new file — which `execFile` treats as a rejection even
        // though stdout already has the diff. Recover it here instead of
        // dropping the file; anything else (no stdout at all) really is a
        // failure and should still propagate.
        if (isRecord(err) && typeof err.stdout === 'string') return err.stdout;
        throw err;
      }),
    ),
  );

  const combined = [tracked, ...untrackedDiffs].filter((s) => s.trim().length > 0).join('\n');
  return combined.length > MAX_DIFF_CHARS ? `${combined.slice(0, MAX_DIFF_CHARS)}\n… (truncated)` : combined;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Never let one malformed codex payload kill this session's event handling. */
function normalizeCodexEventSafe(message: CodexIncoming): AgentEvent[] {
  try {
    return normalizeCodexEvent(message);
  } catch {
    return [];
  }
}
