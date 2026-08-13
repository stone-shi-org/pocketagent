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
 * Events arrive over one shared `GET /event` SSE stream (opencode's own
 * per-session `/session/{id}/event` exists too, but one connection demuxed by
 * `properties.sessionID` is cheaper than N, and global events — plugin
 * loading, catalog updates — have no session at all to attach to anyway).
 */
export class OpencodeServerManager extends EventEmitter<{ crashed: [] }> {
  private child: ChildProcessWithoutNullStreams | null = null;
  private baseUrl: string | null = null;
  private starting: Promise<string> | null = null;
  private ready = false;
  private sseAbort: AbortController | null = null;
  private readonly handlers = new Map<string, (raw: unknown) => void>();

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
          this.startEventStream(url);
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
        this.sseAbort?.abort();
        this.sseAbort = null;
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

  private startEventStream(baseUrl: string): void {
    const abort = new AbortController();
    this.sseAbort = abort;
    void this.readEventStream(baseUrl, abort.signal);
  }

  /** Reconnects on a transient drop; gives up once `dispose()` aborts the signal. */
  private async readEventStream(baseUrl: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      try {
        const res = await fetch(`${baseUrl}/event`, { signal });
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
        this.opts.logger?.warn({}, 'opencode event stream dropped, reconnecting');
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
      this.handlers.get(sessionID)?.(parsed);
    }
  }

  /** One opencode session id maps to at most one live `OpencodeSession` handler. */
  register(sessionId: string, handler: (raw: unknown) => void): void {
    this.handlers.set(sessionId, handler);
  }

  unregister(sessionId: string): void {
    this.handlers.delete(sessionId);
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
    this.sseAbort?.abort();
    this.sseAbort = null;
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
