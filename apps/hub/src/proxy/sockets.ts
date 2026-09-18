import type { Duplex } from 'node:stream';

/**
 * Live spliced connections, indexed by host id.
 *
 * This is the **only** per-connection state the Hub keeps, and it is
 * deliberately the socket handle and nothing else — no buffer, no counter of
 * bytes, no last-frame timestamp. Anything richer would be a foothold for
 * exactly the inspection the dumb-pipe constraint forbids, and there is no
 * feature here that wants it.
 *
 * It exists because "removing a host stops all proxying to it immediately"
 * cannot be satisfied by the registry alone. An HTTP request re-reads the row
 * every time, so a deleted host stops being routable on the next request; a
 * spliced WebSocket, by construction, outlives the request that created it and
 * would otherwise keep streaming a terminal from a machine the operator
 * believes they just disconnected.
 */
export class SocketRegistry {
  private readonly byHost = new Map<string, Set<Duplex>>();

  /** Track a pair of sockets for one proxied connection. Returns a detach fn. */
  track(hostId: string, ...sockets: Duplex[]): () => void {
    let set = this.byHost.get(hostId);
    if (set === undefined) {
      set = new Set();
      this.byHost.set(hostId, set);
    }
    for (const socket of sockets) set.add(socket);
    return () => {
      const current = this.byHost.get(hostId);
      if (current === undefined) return;
      for (const socket of sockets) current.delete(socket);
      if (current.size === 0) this.byHost.delete(hostId);
    };
  }

  countFor(hostId: string): number {
    return this.byHost.get(hostId)?.size ?? 0;
  }

  /**
   * Destroy every live connection to one host.
   *
   * `destroy()` rather than a graceful WebSocket close frame, because sending
   * one would mean composing a frame — the Hub does not have, and must not
   * acquire, a frame encoder. A hard close presents to the browser as a
   * dropped connection, which its existing reconnect logic already handles and
   * which is the honest description of what happened.
   */
  closeHost(hostId: string): number {
    const set = this.byHost.get(hostId);
    if (set === undefined) return 0;
    const count = set.size;
    for (const socket of set) socket.destroy();
    this.byHost.delete(hostId);
    return count;
  }

  closeAll(): void {
    for (const hostId of [...this.byHost.keys()]) this.closeHost(hostId);
  }
}
