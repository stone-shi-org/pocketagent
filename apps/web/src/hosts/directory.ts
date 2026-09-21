import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HostListResponse,
  HubHostListResponse,
  type HubHostEntry,
} from '@pocketagent/protocol';
import {
  DEFAULT_HOST,
  DEFAULT_HOST_ID,
  hostEndpoint,
  hostUrl,
  publishKnownHosts,
  type HostEndpoint,
} from '../api/host.js';
import {
  hostRecordFor,
  withVersionDrift,
  type HostProbe,
  type HostRecord,
} from './host-status.js';
import { backoffMs, isDue, PROBE_TIMEOUT_MS, STATUS_MS } from './poll-policy.js';
import {
  addLocalHost,
  defaultBasePathFor,
  loadLocalHosts,
  localHostProblem,
  removeLocalHost,
  type LocalHostEntry,
} from './registry.js';

/**
 * Where the host list comes from (PA-67).
 *
 * Exactly one source is live, chosen once at boot and never merged: two
 * registries disagreeing about which hosts exist is the confusion this avoids,
 * and "which list am I editing" is not a question a user should have to ask.
 *
 * - `hub` — a PocketAgent Hub is answering `GET /api/hub/hosts`. It owns the
 *   registry, holds the scoped credentials and polls health; adding or removing
 *   a host is a request to it.
 * - `local` — no Hub. The list is the host that served this bundle plus
 *   whatever same-origin path prefixes this browser has been told about, in
 *   `localStorage`. See `registry.ts` for why that is a real, if modest,
 *   capability rather than a stub.
 */
export type HostSource = 'hub' | 'local';

export interface HostDirectory {
  readonly source: HostSource;
  /**
   * False until the source has been decided and the list is addressable.
   *
   * `App` holds host-scoped children back until this is true, which is what
   * makes `resolveHostEndpoint`'s "unknown id falls back to the default host"
   * safe: nothing fetches anything until the real list is published, so a
   * `#/h/dev02/...` deep link cannot spend its first render talking to the
   * wrong machine.
   */
  readonly ready: boolean;
  readonly hosts: readonly HostRecord[];
  /** True when this source supports add/remove at all. */
  readonly canManage: boolean;
  /** Disclosure shown in the add dialog — the two sources promise different things. */
  readonly manageHint: string;
  /** Adds a host. Resolves to an error message, or null on success. */
  readonly add: (entry: {
    id: string;
    label: string;
    basePath: string;
  }) => Promise<string | null>;
  readonly remove: (hostId: string) => Promise<string | null>;
  /**
   * Exchanges a backend's master token for a scoped `pah_` credential.
   * Resolves to an error message, or null on success. Meaningless in local
   * mode (there is no separate credential to hold), so it refuses rather
   * than silently doing nothing — the caller should not be offering this at
   * all when `source !== 'hub'`, per each host's `hubBound` (null there).
   */
  readonly bind: (hostId: string, token: string) => Promise<string | null>;
  /** Re-probes every host now, ignoring backoff. */
  readonly refresh: () => void;
  readonly defaultBasePathFor: (id: string) => string;
}

/**
 * Asks one host what it is, for the status tier.
 *
 * `GET /api/hosts` rather than `/health`, even though PA-61's `probeHost`
 * already exists for the latter, because this needs three things `/health`
 * cannot give: the host's display *name*, its `runningSessions` count (so a
 * collapsed group's heading can still say "3 running" without the far more
 * expensive project-list poll), and `online`. It carries `protocol` too, so the
 * compatibility verdict is computed from the same response — one request per
 * host per 30 s for every dot in the UI.
 *
 * The body is **parsed, not cast**, which is the one place this app does that
 * to an API response. Everywhere else the client casts because both sides ship
 * together; here the whole premise is that they might not — a host behind a Hub
 * can be an older build, and a response missing `protocol` has to read as
 * "cannot be negotiated with" rather than crash a map over `hosts`.
 */
async function probeHostInfo(endpoint: HostEndpoint): Promise<HostProbe> {
  const controller = new AbortController();
  // Without this an unanswering host hangs the fetch for as long as the browser
  // feels like, which is exactly the "spinner that never resolves" the
  // acceptance criteria forbid. `request()` itself stays timeout-free: a real
  // API call may legitimately take minutes.
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(hostUrl(endpoint, '/api/hosts'), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401) {
      return {
        info: null,
        error: 'Not signed in to this host.',
        checkedAt: Date.now(),
      };
    }
    if (!response.ok) {
      return {
        info: null,
        error: `${endpoint.id} answered ${response.status} — check what is proxied at ${
          endpoint.basePath === '' ? '/' : `${endpoint.basePath}/`
        }.`,
        checkedAt: Date.now(),
      };
    }
    const parsed = HostListResponse.safeParse(await response.json());
    const info = parsed.success ? parsed.data.hosts[0] : undefined;
    if (!info) {
      return {
        info: null,
        error: `${endpoint.id} answered something this app could not read. It is probably an older build.`,
        checkedAt: Date.now(),
      };
    }
    return { info, error: null, checkedAt: Date.now() };
  } catch {
    // Abort, DNS failure, connection refused, non-JSON body: indistinguishable
    // from here and identical to a human — `hostMessageFor` words it.
    return { info: null, error: null, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/** One probe of the Hub's registry, to decide which source is live. */
async function probeHubRegistry(): Promise<{
  hosts: HubHostEntry[];
  latestRelease: string | null;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch('/api/hub/hosts', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = HubHostListResponse.safeParse(await response.json());
    if (!parsed.success) return null;
    // PA-69: a Hub that tracks releases tells us the newest one, which beats
    // inferring it from the hosts we happen to see. Optional on the wire, so
    // absent simply means we fall back to that inference.
    return { hosts: parsed.data.hosts, latestRelease: parsed.data.latestRelease ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Entry {
  readonly endpoint: HostEndpoint;
  readonly label: string;
  readonly isDefault: boolean;
  readonly canRemove: boolean;
  /** Set when the Hub says this host is registered but switched off. */
  readonly disabledReason?: string;
  /** `HubHostEntry.boundAt !== null`. Omitted in local mode, where it does not apply. */
  readonly hubBound?: boolean;
}

function entriesFromLocal(local: readonly LocalHostEntry[], defaultLabel: string): Entry[] {
  return [
    { endpoint: DEFAULT_HOST, label: defaultLabel, isDefault: true, canRemove: false },
    ...local.map((row) => ({
      endpoint: hostEndpoint(row.id, row.basePath),
      label: row.label,
      isDefault: false,
      canRemove: true,
    })),
  ];
}

function entriesFromHub(hosts: readonly HubHostEntry[]): Entry[] {
  return hosts.map((host) => ({
    // A Hub mounts its default host at the bare root as well as under
    // `/h/<id>/` (PA-66 D6b), and the bare form is what every unconverted code
    // path still uses — so the default host keeps the empty prefix here too.
    endpoint: host.isDefault ? DEFAULT_HOST : hostEndpoint(host.id, defaultBasePathFor(host.id)),
    label: host.label,
    isDefault: host.isDefault,
    canRemove: !host.isDefault,
    hubBound: host.boundAt !== null,
    ...(host.enabled
      ? {}
      : { disabledReason: `${host.label} is registered but disabled in the Hub.` }),
  }));
}

const LOCAL_HINT =
  'Hosts added here are remembered in this browser only, and must already be reverse-proxied on this origin at the path you give. A PocketAgent Hub replaces this list with a real registry.';
const HUB_HINT = 'Added to the Hub registry, for every browser that signs in to it.';

export function useHostDirectory(): HostDirectory {
  const [source, setSource] = useState<HostSource | null>(null);
  const [local, setLocal] = useState<LocalHostEntry[]>(() => loadLocalHosts());
  const [hubHosts, setHubHosts] = useState<HubHostEntry[]>([]);
  const [hubLatestRelease, setHubLatestRelease] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, HostProbe>>({});
  const metaRef = useRef<Record<string, { lastAttemptAt: number; failures: number }>>({});

  /**
   * Stores a registry read. One helper rather than four call sites setting two
   * pieces of state each, so a future third field cannot be picked up by some
   * of them and missed by the rest.
   */
  const applyRegistry = useCallback(
    (registry: { hosts: HubHostEntry[]; latestRelease: string | null } | null): boolean => {
      if (!registry) return false;
      setHubHosts(registry.hosts);
      setHubLatestRelease(registry.latestRelease);
      return true;
    },
    [],
  );

  // Decide the source once. A backend answers `/api/hub/hosts` with a JSON 404
  // (the not-found handler only serves the SPA shell *outside* `/api/`), so
  // "did not parse" is the same as "no Hub" and needs no version sniffing.
  useEffect(() => {
    let cancelled = false;
    void probeHubRegistry().then((registry) => {
      if (cancelled) return;
      setSource(applyRegistry(registry) ? 'hub' : 'local');
    });
    return () => {
      cancelled = true;
    };
  }, [applyRegistry]);

  const entries = useMemo<Entry[]>(() => {
    if (source === 'hub') return entriesFromHub(hubHosts);
    // Before the source is known the default host is still addressable and
    // still the one serving this page, so the list is never empty — the `ready`
    // gate is about *other* hosts, not about showing a blank screen.
    return entriesFromLocal(source === null ? [] : local, DEFAULT_HOST_ID);
  }, [source, hubHosts, local]);

  const entryKey = entries.map((entry) => `${entry.endpoint.id}@${entry.endpoint.basePath}`).join('|');

  const probeAll = useCallback(
    (force: boolean) => {
      for (const entry of entries) {
        if (entry.disabledReason !== undefined) continue;
        const id = entry.endpoint.id;
        const meta = metaRef.current[id];
        const wait = backoffMs(STATUS_MS, meta?.failures ?? 0);
        if (!force && !isDue(Date.now(), meta?.lastAttemptAt, wait)) continue;
        metaRef.current[id] = {
          lastAttemptAt: Date.now(),
          failures: meta?.failures ?? 0,
        };
        void probeHostInfo(entry.endpoint).then((probe) => {
          metaRef.current[id] = {
            lastAttemptAt: Date.now(),
            failures: probe.info === null ? (metaRef.current[id]?.failures ?? 0) + 1 : 0,
          };
          setProbes((prev) => ({ ...prev, [id]: probe }));
        });
      }
    },
    [entries],
  );

  useEffect(() => {
    if (source === null) return;
    probeAll(true);
    const timer = setInterval(() => probeAll(false), STATUS_MS);
    return () => clearInterval(timer);
    // Keyed on `entryKey`, a string, rather than on `entries`, whose array
    // identity changes on every render: restarting the status timer that often
    // would mean a probe storm on an otherwise idle screen. `probeAll` is
    // deliberately left out of the deps for the same reason — it closes over
    // `entries` and so changes just as often, and the version captured here is
    // only ever stale about hosts that `entryKey` would have changed for.
  }, [source, entryKey]);

  // In hub mode the registry itself can change (another browser adds a host),
  // so re-read it on the same cadence as the status tier. In local mode there
  // is nothing to re-read — `localStorage` only changes through `add`/`remove`
  // here, which update state directly.
  useEffect(() => {
    if (source !== 'hub') return;
    const timer = setInterval(() => {
      void probeHubRegistry().then(applyRegistry);
    }, STATUS_MS);
    return () => clearInterval(timer);
  }, [source, applyRegistry]);

  const hosts = useMemo<HostRecord[]>(
    () =>
      // PA-69: drift is a property of the list, not of one host, so it is
      // filled in a second pass over records that already exist. One place
      // computes it and all three surfaces read `record.drift`.
      withVersionDrift(
        entries.map((entry) =>
          hostRecordFor({
            endpoint: entry.endpoint,
            label: entry.label,
            probe: probes[entry.endpoint.id],
            isDefault: entry.isDefault,
            canRemove: entry.canRemove,
            ...(entry.hubBound === undefined ? {} : { hubBound: entry.hubBound }),
            ...(entry.disabledReason === undefined
              ? {}
              : { forced: { status: 'offline' as const, message: entry.disabledReason } }),
          }),
        ),
        hubLatestRelease,
      ),
    [entries, probes, hubLatestRelease],
  );

  // Publish for the router, which resolves `#/h/<id>/...` synchronously during
  // render and so cannot await any of the above.
  useEffect(() => {
    const aliases = new Map<string, string>();
    for (const record of hosts) {
      for (const alias of record.aliases) aliases.set(alias, record.endpoint.id);
    }
    publishKnownHosts(
      hosts.map((record) => record.endpoint),
      aliases,
    );
  }, [hosts]);

  const add = useCallback(
    async (entry: { id: string; label: string; basePath: string }): Promise<string | null> => {
      if (source === 'hub') {
        try {
          const response = await fetch('/api/hub/hosts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: entry.id, label: entry.label, baseUrl: entry.basePath }),
          });
          if (!response.ok) return 'The Hub refused that host.';
          applyRegistry(await probeHubRegistry());
          return null;
        } catch {
          return 'Could not reach the Hub.';
        }
      }
      const problem = localHostProblem(entry, local, [DEFAULT_HOST_ID]);
      if (problem) return problem;
      setLocal(addLocalHost(entry, local));
      return null;
    },
    [source, local, applyRegistry],
  );

  const remove = useCallback(
    async (hostId: string): Promise<string | null> => {
      if (source === 'hub') {
        try {
          const response = await fetch(`/api/hub/hosts/${encodeURIComponent(hostId)}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          if (!response.ok) return 'The Hub refused to remove that host.';
          applyRegistry(await probeHubRegistry());
          return null;
        } catch {
          return 'Could not reach the Hub.';
        }
      }
      setLocal(removeLocalHost(hostId, local));
      return null;
    },
    [source, local, applyRegistry],
  );

  const bind = useCallback(
    async (hostId: string, token: string): Promise<string | null> => {
      if (source !== 'hub') return 'Only a Hub-registered host can be bound.';
      try {
        const response = await fetch(`/api/hub/hosts/${encodeURIComponent(hostId)}/bind`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          return body?.error?.message ?? 'The Hub could not bind that host.';
        }
        applyRegistry(await probeHubRegistry());
        return null;
      } catch {
        return 'Could not reach the Hub.';
      }
    },
    [source, applyRegistry],
  );

  return {
    source: source ?? 'local',
    ready: source !== null,
    hosts,
    // Both sources can manage, for different values of "manage" — see the two
    // hints. What would *not* be honest is offering nothing until PA-66 lands.
    canManage: true,
    manageHint: source === 'hub' ? HUB_HINT : LOCAL_HINT,
    add,
    remove,
    bind,
    refresh: () => probeAll(true),
    defaultBasePathFor,
  };
}
