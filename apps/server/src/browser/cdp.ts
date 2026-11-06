import { WebSocket } from 'ws';

/**
 * PA-178: the smallest Chrome DevTools Protocol client the viewer needs —
 * request/response by id, events, and flattened per-target sessions
 * (`Target.attachToTarget({ flatten: true })`, where a command carries its
 * `sessionId` on the same socket).
 *
 * Nothing here logs a message: screencast frames and `Input.*` parameters are
 * the person's screen and keystrokes.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export class CdpError extends Error {}

const COMMAND_TIMEOUT_MS = 30_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('close', () => this.handleClose());
    ws.on('error', () => this.handleClose());
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      // No per-message deflate: frames are JPEG, which does not compress.
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new CdpError('Timed out connecting to the browser.'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(new CdpError(`Could not connect to the browser: ${err.message}`));
      });
    });
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError('The browser connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out.`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (v: Record<string, unknown>) => void, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError('The browser connection closed.'));
    }
    this.pending.clear();
    for (const l of this.closeListeners) l();
    this.closeListeners.clear();
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closing
    }
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? 'CDP error'));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) };
      for (const l of this.listeners) {
        try {
          l(event);
        } catch {
          // a listener's bug must not stop the others
        }
      }
    }
  }
}
