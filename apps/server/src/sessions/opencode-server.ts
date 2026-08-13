import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

/**
 * One `opencode serve` process, shared by every `OpencodeSession` on this
 * server.
 *
 * This is a different shape from Claude's `StructuredSession` (one Agent SDK
 * query per chat) and `AgySession` (one `agy` process per turn): opencode's
 * server is a genuine multi-session daemon — `POST /session?directory=<cwd>`
 * takes the working directory per request, not at spawn time — so spawning
 * one per chat would waste the ~1-2s plugin/provider/LSP boot sequence for no
 * reason. Lazily started on the first opencode session, kept running for the
 * life of this process, torn down in `SessionManager.shutdown()`.
 *
 * Events arrive over `GET /event` SSE streams demuxed by `properties.sessionID`
 * (opencode's own per-session `/session/{id}/event` exists too, but one
 * connection per directory covers every session in it). This is *not* one
 * single global stream, even though the daemon itself is: `/event` only
 * delivers session/message events when called with a matching `directory`
 * query param (confirmed against its own OpenAPI doc and by observation —
 * without it you get `server.connected`/`server.heartbeat` and nothing else,
 * silently, forever). So one SSE connection is kept per distinct directory
 * that has a registered session, ref-counted as sessions for that directory
 * come and go, rather than one connection for the whole process.
 */
export class OpencodeServerManager extends EventEmitter<{ crashed: [] }> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private baseUrl: string | null = null;
  private starting: Promise<string> | null = null;
  private ready = false;
  private readonly eventStreams = new Map<string, { abort: AbortController; refCount: number }>();
  private readonly handlers = new Map<string, { directory: string; handler: (raw: unknown) => void }>();

  constructor(
    private readonly opts: {
      executablePath: string;
      env: Record<string, string>;
      cwd: string;
      logger?: { warn: (o: object, m?: string) => void };
    },
  ) {
    super();
  }

  /** Spawns the server on first call; every later call reuses it. */
  async ensureStarted(): Promise<string> {
    if (this.baseUrl) return this.baseUrl;
    if (!this.starting) this.starting = this.spawnAndWait();
    return this.starting;
  }

  private spawnAndWait(): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };

      const child = spawn(
        this.opts.executablePath,
        ['serve', '--port', '0', '--hostname', '127.0.0.1'],
        { cwd: this.opts.cwd, env: this.opts.env },
      );
      this.child = child;

      const timeout = setTimeout(() => {
        settle(() => {
          child.kill('SIGTERM');
          reject(new Error('opencode serve did not report a listening address in time.'));
        });
      }, 15_000);
      timeout.unref?.();

      let stderrTail = '';
      const onLine = (line: string): void => {
        // Observed against the real CLI (v1.17.18): `opencode server
        // listening on http://127.0.0.1:PORT`. `--port 0` means the actual
        // port is only knowable by reading this line.
        const match = /opencode server listening on (http:\/\/\S+)/.exec(line);
        const url = match?.[1];
        if (!url) return;
        settle(() => {
          this.baseUrl = url;
          this.ready = true;
          resolve(url);
        });
      };

      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        stderrTail = (stderrTail + line + '\n').slice(-4000);
        onLine(line);
      });
      readline.createInterface({ input: child.stderr }).on('line', (line) => {
        stderrTail = (stderrTail + line + '\n').slice(-4000);
        onLine(line);
      });

      child.on('error', (err) => {
        settle(() => reject(err));
      });

      child.on('exit', (code) => {
        const wasReady = this.ready;
        this.child = null;
        this.baseUrl = null;
        this.ready = false;
        for (const { abort } of this.eventStreams.values()) abort.abort();
        this.eventStreams.clear();
        // `starting` must be cleared too, not just `baseUrl`: it is a settled
        // promise at this point (resolved if `wasReady`, rejected otherwise),
        // and a settled promise is still truthy, so leaving it in place would
        // make every future `ensureStarted()` return that same dead promise
        // forever instead of spawning a replacement — the shared server would
        // never recover from one crash for the rest of this process's life.
        this.starting = null;
        settle(() =>
          reject(
            new Error(
              stderrTail.trim() || `opencode serve exited with code ${code} before it was ready.`,
            ),
          ),
        );
        // A crash *after* startup is a different situation from a bad spawn:
        // every live OpencodeSession's HTTP calls are now talking to nothing,
        // and their opencode-side state is gone with the process. The manager
        // owning this instance is responsible for surfacing that to them.
        if (wasReady) this.emit('crashed');
      });
    });
  }

  /**
   * Opens (or joins) the one event stream for `directory`, ref-counted so it
   * closes once the last session using it unregisters. Safe to call before
   * the server has finished spawning — a resumed session can call `register`
   * without ever calling `request` first (no `POST /session` needed when
   * `resumeAgentSessionId` is already known), so this cannot assume
   * `this.baseUrl` is set yet.
   */
  private ensureEventStreamFor(directory: string): void {
    const existing = this.eventStreams.get(directory);
    if (existing) {
      existing.refCount++;
      return;
    }
    const abort = new AbortController();
    this.eventStreams.set(directory, { abort, refCount: 1 });
    this.ensureStarted()
      .then((url) => {
        if (abort.signal.aborted) return;
        void this.readEventStream(url, directory, abort.signal);
      })
      .catch(() => {
        // `ensureStarted` rejecting means the spawn itself failed; whatever
        // triggered `register` is already surfacing that failure through its
        // own `request` call, so just stop tracking a stream for a server
        // that never came up.
        this.eventStreams.delete(directory);
      });
  }

  /** Reconnects on a transient drop; gives up once the directory's last session unregisters. */
  private async readEventStream(baseUrl: string, directory: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      try {
        const url = new URL('/event', baseUrl);
        // Required, not cosmetic: without a `directory` query param, `/event`
        // delivers only session-less bookkeeping (`server.connected`,
        // `server.heartbeat`) and silently omits every `message.*`/`session.*`
        // event — every turn would hang forever with no error anywhere.
        url.searchParams.set('directory', directory);
        const res = await fetch(url, { signal });
        const body = res.body;
        if (!body) return;
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.dispatchSseChunk(chunk);
          }
        }
      } catch {
        if (signal.aborted) return;
        this.opts.logger?.warn({ directory }, 'opencode event stream dropped, reconnecting');
      }
      if (signal.aborted) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private dispatchSseChunk(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const properties = (parsed as Record<string, unknown>).properties;
      const sessionID =
        typeof properties === 'object' &&
        properties !== null &&
        typeof (properties as Record<string, unknown>).sessionID === 'string'
          ? ((properties as Record<string, unknown>).sessionID as string)
          : null;
      // Session-less events (plugin/catalog/provider bookkeeping) have no
      // handler to reach and are not part of any chat's transcript.
      if (!sessionID) continue;
      this.handlers.get(sessionID)?.handler(parsed);
    }
  }

  /**
   * One opencode session id maps to at most one live `OpencodeSession`
   * handler. `directory` is the session's own cwd — it opens (or joins) that
   * directory's event stream, since that is what `/event` requires to
   * deliver anything for this session at all.
   */
  register(sessionId: string, directory: string, handler: (raw: unknown) => void): void {
    this.handlers.set(sessionId, { directory, handler });
    this.ensureEventStreamFor(directory);
  }

  unregister(sessionId: string): void {
    const entry = this.handlers.get(sessionId);
    this.handlers.delete(sessionId);
    if (!entry) return;
    const stream = this.eventStreams.get(entry.directory);
    if (!stream) return;
    stream.refCount--;
    if (stream.refCount <= 0) {
      stream.abort.abort();
      this.eventStreams.delete(entry.directory);
    }
  }

  async request<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | undefined>;
    } = {},
  ): Promise<T> {
    const baseUrl = await this.ensureStarted();
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(init.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `opencode server ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** Kills the shared process. Every registered session must have already stopped using it. */
  dispose(): void {
    for (const { abort } of this.eventStreams.values()) abort.abort();
    this.eventStreams.clear();
    this.handlers.clear();
    this.removeAllListeners();
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.baseUrl = null;
    this.ready = false;
  }
}
