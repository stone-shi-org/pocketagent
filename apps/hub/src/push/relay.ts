import type { HostPushStatus, PushPayload } from '@pocketagent/protocol';
import type { HostRegistry } from '../registry/store.js';
import type { HubPushService } from './service.js';

export interface PushNotificationRelayOptions {
  readonly registry: HostRegistry;
  readonly pushService: HubPushService;
  readonly fetchImpl?: typeof fetch;
  readonly reconnectIntervalMs?: number;
  readonly log?: {
    info: (o: object, m?: string) => void;
    warn: (o: object, m?: string) => void;
    error: (o: object, m?: string) => void;
  };
}

/**
 * PA-73: Connects to each bound host's /api/push/events SSE stream.
 *
 * Forwards notifications from bound backends to the Hub's push service.
 * Rewrites notification deep links to carry the host ID (`/#/h/<hostId>/s/<sessionId>`),
 * tags notifications with the host label, and namespaces notification tags so events
 * from different hosts do not collide.
 *
 * Tracks connection health per host, ensuring any host whose notifications cannot
 * be delivered is legible in the UI rather than silently dropped.
 */
export class PushNotificationRelay {
  private readonly controllers = new Map<string, AbortController>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly hostStatus = new Map<string, HostPushStatus>();
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectIntervalMs: number;
  private stopped = true;

  constructor(private readonly options: PushNotificationRelayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5_000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.hostStatus.clear();
  }

  getStatus(): Record<string, HostPushStatus> {
    const result: Record<string, HostPushStatus> = {};
    for (const [id, status] of this.hostStatus.entries()) {
      result[id] = status;
    }
    return result;
  }

  /** Bring active streams in line with the registry. */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    const rows = this.options.registry.listRows();
    const wanted = new Set(rows.map((row) => row.id));

    // Remove streams for hosts that no longer exist.
    for (const [id, controller] of this.controllers) {
      if (!wanted.has(id)) {
        controller.abort();
        this.controllers.delete(id);
        const timer = this.reconnectTimers.get(id);
        if (timer) clearTimeout(timer);
        this.reconnectTimers.delete(id);
        this.hostStatus.delete(id);
      }
    }

    for (const row of rows) {
      if (row.enabled !== 1) {
        this.disconnect(row.id);
        this.hostStatus.set(row.id, { ok: false, status: 'disabled' });
        continue;
      }
      const credential = this.options.registry.credentialFor(row);
      if (!credential) {
        this.disconnect(row.id);
        this.hostStatus.set(row.id, {
          ok: false,
          status: 'unbound',
          reason: 'Host is not bound or credential undecryptable',
        });
        continue;
      }

      if (!this.controllers.has(row.id) && !this.reconnectTimers.has(row.id)) {
        void this.connectHost(row.id);
      }
    }
  }

  private disconnect(hostId: string): void {
    const timer = this.reconnectTimers.get(hostId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(hostId);
    }
    const controller = this.controllers.get(hostId);
    if (controller) {
      controller.abort();
      this.controllers.delete(hostId);
    }
  }

  private scheduleReconnect(hostId: string): void {
    if (this.stopped) return;
    if (this.reconnectTimers.has(hostId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(hostId);
      void this.connectHost(hostId);
    }, this.reconnectIntervalMs);
    timer.unref?.();
    this.reconnectTimers.set(hostId, timer);
  }

  private async connectHost(hostId: string): Promise<void> {
    if (this.stopped) return;
    const row = this.options.registry.getRow(hostId);
    if (!row || row.enabled !== 1) return;
    const credential = this.options.registry.credentialFor(row);
    if (!credential) return;

    this.disconnect(hostId);
    const controller = new AbortController();
    this.controllers.set(hostId, controller);

    const url = `${row.base_url.replace(/\/$/, '')}/api/push/events`;
    try {
      const response = await this.fetchImpl(url, {
        headers: {
          accept: 'text/event-stream',
          authorization: `Bearer ${credential}`,
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'unsupported',
          reason: 'Host build does not support push event streaming',
        });
        this.options.log?.warn({ hostId }, 'host push events route not found (unsupported build)');
        return;
      }

      if (response.status === 401 || response.status === 403) {
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'unauthorized',
          reason: 'Hub credential rejected by host',
        });
        this.options.log?.warn({ hostId, status: response.status }, 'hub credential rejected for push events');
        return;
      }

      if (!response.ok) {
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'reconnecting',
          reason: `Host answered HTTP ${response.status}`,
        });
        this.scheduleReconnect(hostId);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'reconnecting',
          reason: 'No response stream body',
        });
        this.scheduleReconnect(hostId);
        return;
      }

      this.hostStatus.set(hostId, { ok: true, status: 'connected' });
      this.options.log?.info({ hostId }, 'connected to host push events stream');

      const decoder = new TextDecoder();
      let buffer = '';

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            if (frame.length > 0 && frame.startsWith('data:')) {
              const jsonText = frame.slice(5).trim();
              try {
                const payload = JSON.parse(jsonText) as PushPayload;
                void this.dispatchPayload(row, payload);
              } catch (err) {
                this.options.log?.warn({ err, hostId }, 'malformed push event frame');
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
        }
      } finally {
        reader.releaseLock();
        try {
          await response.body?.cancel();
        } catch {
          /* best effort */
        }
      }

      if (!controller.signal.aborted) {
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'reconnecting',
          reason: 'Stream closed by host',
        });
        this.scheduleReconnect(hostId);
      }
    } catch (err) {
      if (!controller.signal.aborted && !this.stopped) {
        const msg = err instanceof Error ? err.message : 'Push event stream error';
        this.hostStatus.set(hostId, {
          ok: false,
          status: 'reconnecting',
          reason: msg,
        });
        this.scheduleReconnect(hostId);
      }
    } finally {
      if (this.controllers.get(hostId) === controller) {
        this.controllers.delete(hostId);
      }
    }
  }

  private async dispatchPayload(
    row: { id: string; label: string; is_default: number },
    payload: PushPayload,
  ): Promise<void> {
    const isDefault = row.is_default === 1;

    // Rewrite deep-link URL so tapping the notification opens the session on
    // the machine it actually belongs to.
    let url = payload.url;
    if (!isDefault) {
      if (url.startsWith('/#/s/')) {
        url = `/#/h/${encodeURIComponent(row.id)}${url.slice(2)}`;
      } else if (url === '/' || url === '/#/') {
        url = `/#/h/${encodeURIComponent(row.id)}/`;
      } else if (url.startsWith('/#/')) {
        url = `/#/h/${encodeURIComponent(row.id)}${url.slice(2)}`;
      } else {
        url = `/#/h/${encodeURIComponent(row.id)}${url.startsWith('/') ? '' : '/'}${url}`;
      }
    }

    const title = isDefault ? payload.title : `[${row.label}] ${payload.title}`;
    const tag = payload.tag ? `${row.id}-${payload.tag}` : `push-${row.id}`;

    await this.options.pushService.send({
      title,
      body: payload.body,
      url,
      tag,
    });
  }
}
