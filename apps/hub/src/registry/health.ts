import {
  HealthResponse,
  HostCapabilities,
  HostListResponse,
  type HubHostCapabilities,
} from '@pocketagent/protocol';
import type { HostRegistry } from './store.js';

/** How often each enabled host is probed. */
export const HEALTH_INTERVAL_MS = 30_000;

/** Per-probe ceiling. A host that has gone away must not hold a slot open. */
export const HEALTH_TIMEOUT_MS = 8_000;

export interface HealthPollerOptions {
  readonly registry: HostRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly intervalMs?: number;
  readonly log?: { warn: (obj: unknown, msg: string) => void };
}

/**
 * Polls every enabled backend's `/health`, feeding `online`, `version` and
 * `protocol` into the host list.
 *
 * Shaped like `TelegramPollerService` — one self-rescheduling loop per host —
 * rather than like `CronService`'s single shared tick, for the reason
 * acceptance criterion 5 states: "a backend that is down shows as offline
 * without affecting the others." A shared tick that awaited each host in turn
 * would make one unresponsive machine delay every other machine's dot by up to
 * its own timeout.
 *
 * The probe is **unauthenticated**, which is what makes the two-step "add a
 * backend by base URL, then bind it" flow possible at all: a host that has not
 * been bound yet still has to be reachable enough to tell the operator whether
 * the URL they typed is right. `/health` being public is exactly the affordance
 * PA-61 documented for this.
 */
export class HealthPoller {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  /**
   * Starts *stopped*, so nothing probes until `start()` is called.
   *
   * Not merely tidy: registry mutations call `reconcile()` so a newly added
   * host is probed at once rather than sitting blank for 30 s, and if that
   * worked before `start()` then "construct a Hub with the poller off" would
   * still make outbound calls — which a test asserting "the backend was never
   * contacted" cannot distinguish from a proxy leak.
   */
  private stopped = true;

  constructor(private readonly options: HealthPollerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? HEALTH_INTERVAL_MS;
  }

  /**
   * Probe every enabled host now, then keep each on its own schedule.
   *
   * Returns the first sweep so a caller can await it. `app.ts` deliberately
   * does not — boot must not block on a host that is down — but a test has to
   * be able to, or it races the sweep `start()` would otherwise fire and
   * forget.
   */
  async start(): Promise<void> {
    this.stopped = false;
    await this.reconcile();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Bring the set of running loops in line with the registry.
   *
   * Called at boot and after every registry mutation, so adding a host probes
   * it immediately rather than leaving its row blank for up to 30 s — which
   * would read as "the host I just added is broken" at precisely the moment an
   * operator is checking whether they typed the URL correctly.
   */
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    const rows = this.options.registry.listRows().filter((row) => row.enabled === 1);
    const wanted = new Set(rows.map((row) => row.id));
    for (const [id, timer] of this.timers) {
      if (!wanted.has(id)) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }
    await Promise.all(rows.filter((row) => !this.timers.has(row.id)).map((row) => this.tick(row.id)));
  }

  private schedule(id: string): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.tick(id);
    }, this.intervalMs);
    // Never hold the event loop open for a poll: the process should be able to
    // exit on SIGTERM without waiting out a 30 s timer.
    timer.unref?.();
    this.timers.set(id, timer);
  }

  private async tick(id: string): Promise<void> {
    if (this.stopped) return;
    // Mark the slot before awaiting, so a concurrent `reconcile` does not start
    // a second loop for the same host.
    this.timers.set(id, setTimeout(() => undefined, 0));
    const row = this.options.registry.getRow(id);
    if (row === null || row.enabled !== 1) {
      this.timers.delete(id);
      return;
    }
    const health = await this.probe(row.base_url);
    this.options.registry.recordHealth(id, health);
    if (health.error !== null) {
      this.options.log?.warn({ hostId: id, error: health.error }, 'host health probe failed');
    }
    // PA-133: fetch the capability card on the same tick, only for bound hosts
    // that hold a credential. An older backend without `GET /api/capabilities`
    // answers 404 → recorded as `unavailable`, never an error.
    const credential = this.options.registry.credentialFor(row);
    if (credential === null) {
      this.options.registry.recordCapabilities(id, null);
    } else if (health.online) {
      const capabilities = await probeBackendCapabilities(
        row.base_url,
        credential,
        this.fetchImpl,
      );
      if (capabilities !== null) {
        this.options.registry.recordCapabilities(id, capabilities);
      }
    }
    this.schedule(id);
  }

  private async probe(baseUrl: string): Promise<{
    online: boolean;
    version: string | null;
    protocol: { min: number; max: number } | null;
    lastCheckedAt: number;
    error: string | null;
    observedHostId: string | null;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}/health`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          ...offline(`answered ${response.status}`),
          observedHostId: null,
        };
      }
      // Parsed, not cast. This response is the *usability decision* for a
      // machine that may be running a different build entirely, so a missing
      // or renamed field has to read as "cannot be negotiated with" rather
      // than propagate `undefined` into the host list.
      //
      // The body read gets its own try: a host that answers 200 with HTML —
      // a login portal, a misconfigured proxy — is *reachable but unusable*,
      // which is a different thing to tell an operator than "could not be
      // reached", and letting `.json()` throw into the outer catch would
      // conflate the two.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ...offline('answered something this Hub could not read; probably an older build'),
          observedHostId: null,
        };
      }
      const parsed = HealthResponse.safeParse(body);
      if (!parsed.success) {
        return {
          ...offline('answered something this Hub could not read; probably an older build'),
          observedHostId: null,
        };
      }
      return {
        online: true,
        version: parsed.data.version,
        protocol: parsed.data.protocol,
        lastCheckedAt: Date.now(),
        error: null,
        // `/health` deliberately does not carry a host id — it is the only
        // unauthenticated read and its field list is pinned by a test — so
        // identity reconciliation is a separate, credentialed call.
        observedHostId: null,
      };
    } catch (error) {
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `did not answer within ${HEALTH_TIMEOUT_MS / 1000}s`
          : 'could not be reached';
      return { ...offline(reason), observedHostId: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

function offline(reason: string): {
  online: false;
  version: null;
  protocol: null;
  lastCheckedAt: number;
  error: string;
} {
  return { online: false, version: null, protocol: null, lastCheckedAt: Date.now(), error: reason };
}

/**
 * Read the backend's own `HostInfo.id`, for the identity-drift check.
 *
 * Separate from the health probe because it needs a credential: `/api/hosts`
 * is behind the gate, while `/health` is not. Called at bind time and on
 * demand rather than on the 30 s tick, since a machine's identity changes when
 * an operator changes its workspace roots, not continuously.
 */
export async function readBackendHostId(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/hosts`, {
      headers: { accept: 'application/json', authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = HostListResponse.safeParse(await response.json());
    return parsed.success ? (parsed.data.hosts[0]?.id ?? null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PA-133: probe a bound backend's `GET /api/capabilities`.
 *
 * Detected by probing rather than by version comparison (the same rule PA-70
 * uses): a backend without the route answers 404, which is recorded as
 * `{ status: 'unavailable' }` so the UI can show "capabilities unavailable
 * (upgrade host)" rather than an error.
 */
export async function probeBackendCapabilities(
  baseUrl: string,
  credential: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubHostCapabilities | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/capabilities`, {
      headers: { accept: 'application/json', authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { status: 'unavailable', fetchedAt: Date.now() };
    }
    if (!response.ok) return null;
    const parsed = HostCapabilities.safeParse(await response.json());
    if (!parsed.success) {
      return { status: 'unavailable', fetchedAt: Date.now() };
    }
    return { status: 'ok', card: parsed.data, fetchedAt: Date.now() };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
