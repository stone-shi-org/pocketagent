import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

/**
 * One `codex app-server` process, shared by every `CodexSession` on this
 * server.
 *
 * Third shape of "structured" in this codebase: `StructuredSession` holds an
 * SDK query open, `AgySession` spawns a subprocess per turn, `OpencodeSession`
 * talks HTTP + SSE to a shared daemon. This one talks newline-delimited
 * JSON-RPC 2.0 over the child's stdin/stdout (confirmed empirically against
 * the real, installed CLI v0.147.0 — the protocol's own schema says nothing
 * about wire framing, only payload shapes). `codex app-server` is bidirectional:
 * it sends *us* requests too — a real approval gate (`item/commandExecution/
 * requestApproval`, `item/fileChange/requestApproval`) that genuinely blocks
 * the tool call until answered, unlike `agy`'s headless mode. One `initialize`
 * handshake per process; every session after that is a `thread/start` over
 * the same connection, demuxed by `threadId`.
 */
export class CodexServerManager extends EventEmitter<{ crashed: [] }> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private nextRequestId = 1;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, (message: JsonRpcIncoming) => void>();

  constructor(
    private readonly opts: {
      executablePath: string;
      env: Record<string, string>;
      cwd: string;
    },
  ) {
    super();
  }

  async ensureStarted(): Promise<void> {
    if (this.ready) return;
    if (!this.starting) this.starting = this.spawnAndInitialize();
    return this.starting;
  }

  private spawnAndInitialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGTERM');
        reject(new Error('codex app-server did not respond to initialize in time.'));
      }, 15_000);
      timeout.unref?.();

      // Default transport is stdio:// — explicit here so a future default
      // change upstream cannot silently switch this to something else.
      const child = spawn(this.opts.executablePath, ['app-server', '--stdio'], {
        cwd: this.opts.cwd,
        env: this.opts.env,
      });
      this.child = child;

      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4000);
      });

      readline.createInterface({ input: child.stdout }).on('line', (line) => this.handleLine(line));

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code) => {
        const wasReady = this.ready;
        this.child = null;
        this.ready = false;
        this.rejectAllPending(new Error('codex app-server exited.'));
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(
            new Error(
              stderrTail.trim() || `codex app-server exited with code ${code} before it was ready.`,
            ),
          );
        }
        if (wasReady) this.emit('crashed');
      });

      // `clientInfo` is required by the real server; version/title are
      // cosmetic (shown in its own diagnostics), not load-bearing.
      //
      // `capabilities.experimentalApi: true` opts every session sharing this
      // one process into codex's experimental RPC surface — confirmed live
      // (v0.147.0) that `thread/settings/update` (the only call that lets
      // `CodexSession` switch a thread's model/effort live — see
      // `CodexSession.setModel`/`setEffort`) is otherwise rejected outright
      // with "requires experimentalApi capability", not a soft no-op. This is
      // a deliberate, process-wide opt-in into an API codex's own schema
      // marks unstable, made once here rather than per-session, since the
      // capability is negotiated at `initialize` and there is only one of
      // those per shared process.
      this.sendRequestOn(child, 'initialize', {
        clientInfo: { name: 'pocketagent', title: 'PocketAgent', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      }).then(
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.ready = true;
          resolve();
        },
        (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(err);
        },
      );
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return; // Never let one malformed line take down the connection.
    }
    if (!isRecord(message)) return;

    // A response to one of *our* outgoing requests: has our own string id,
    // no `method`. See `sendRequestOn` — we mint string ids specifically so
    // they can never collide with the plain integers the server uses for its
    // own requests to us, which matters because both directions share one
    // connection.
    if (typeof message.id === 'string' && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if ('error' in message) {
        entry.reject(new Error(describeJsonRpcError(message.error)));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // Everything else is either a notification (`method`, no `id`) or a
    // genuine server->client request (`method` + `id`, reply owed). Both are
    // scoped to a thread via `params.threadId` where there is one to attach
    // to; global, thread-less messages (rate limits, account updates, mcp
    // startup) have no session to reach.
    if (typeof message.method === 'string') {
      const params = isRecord(message.params) ? message.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      if (!threadId) return;
      this.handlers.get(threadId)?.({
        method: message.method,
        params,
        id: typeof message.id === 'number' ? message.id : undefined,
      });
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  private sendRequestOn(child: ChildProcessWithoutNullStreams, method: string, params: unknown): Promise<unknown> {
    const id = `pa_${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async sendRequest<T = unknown>(method: string, params: unknown): Promise<T> {
    await this.ensureStarted();
    const child = this.child;
    if (!child) throw new Error('codex app-server is not running.');
    return this.sendRequestOn(child, method, params) as Promise<T>;
  }

  /** Answers a server-initiated request (an approval, most importantly). No response-to-our-response is expected. */
  replyToServerRequest(id: number, result: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  register(threadId: string, handler: (message: JsonRpcIncoming) => void): void {
    this.handlers.set(threadId, handler);
  }

  unregister(threadId: string): void {
    this.handlers.delete(threadId);
  }

  dispose(): void {
    this.handlers.clear();
    this.rejectAllPending(new Error('codex app-server is shutting down.'));
    this.removeAllListeners();
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.ready = false;
  }
}

/** A notification (`id` undefined) or a server request awaiting a reply (`id` set). */
export interface JsonRpcIncoming {
  method: string;
  params: Record<string, unknown>;
  id?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeJsonRpcError(error: unknown): string {
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return 'codex app-server request failed.';
}
