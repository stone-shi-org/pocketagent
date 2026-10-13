import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HealthResponse,
  HostListResponse,
  HubHostListResponse,
  type HubHostCapabilities,
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
  generateHostId,
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
  /**
   * The id `add` would give a host with this name right now (PA-107): a slug
   * of the name, suffixed past whatever this directory already holds. A
   * preview only — local mode derives the default path prefix from it, and
   * the dialog shows it — because `add` itself re-derives on a Hub conflict.
   */
  readonly proposeId: (label: string) => string;
  /**
   * Adds a host under `id` (normally `proposeId(label)`). Resolves to the id
   * it was actually stored under — which differs from the one passed only when
   * another browser took that id on the Hub first — or to an error message.
   */
  readonly add: (entry: {
    id: string;
    label: string;
    basePath: string;
  }) => Promise<{ id: string; error: null } | { id: null; error: string }>;
  /**
   * The Hub's own build version, from its `/health` (PA-107) — null in local
   * mode, where there is no Hub, and until the Hub has answered. The bundle
   * this page runs is the Hub's too, but reading the process says which
   * build is *running* rather than which one was once shipped to this tab.
   */
  readonly hubVersion: string | null;
  readonly remove: (hostId: string) => Promise<string | null>;
  /**
   * Exchanges a backend's master token for a scoped `pah_` credential.
   * Resolves to an error message, or null on success. Meaningless in local
   * mode (there is no separate credential to hold), so it refuses rather
   * than silently doing nothing — the caller should not be offering this at
   * all when `source !== 'hub'`, per each host's `hubBound` (null there).
   */
  readonly bind: (hostId: string, token: string) => Promise<string | null>;
  /**
   * Edits a host's name and address in place — `PATCH /api/hub/hosts/:id` in
   * hub mode, or (since `addLocalHost` already upserts by id) re-adding a
   * local one under the same id. Resolves to an error message, or null.
   */
  readonly update: (
    hostId: string,
    patch: { label?: string; basePath?: string },
  ) => Promise<string | null>;
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
  /** See `hostRecordFor`'s `labelIsPlaceholder`. */
  readonly labelIsPlaceholder?: boolean;
  readonly isDefault: boolean;
  readonly canRemove: boolean;
  /** Set when the Hub says this host is registered but switched off. */
  readonly disabledReason?: string;
  /** `HubHostEntry.boundAt !== null`. Omitted in local mode, where it does not apply. */
  readonly hubBound?: boolean;
  /**
   * The Hub's own row id, distinct from `endpoint.id` for the default host
   * (see `HostRecord.hubHostId`'s own comment) — omitted in local mode.
   */
  readonly hubHostId?: string;
  /** The address the Hub dials for this host. Omitted in local mode. */
  readonly hubBaseUrl?: string;
  /** Cached capability card from the Hub registry. Omitted in local mode. */
  readonly capabilities?: HubHostCapabilities | null;
}

function entriesFromLocal(local: readonly LocalHostEntry[], defaultLabel: string): Entry[] {
  return [
    {
      endpoint: DEFAULT_HOST,
      label: defaultLabel,
      labelIsPlaceholder: true,
      isDefault: true,
      canRemove: false,
    },
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
    // The backend's own `remove()` reassigns the default to whichever host
    // survives (or leaves none, if this was the last one — the next `create`
    // re-defaults), so there is no structural reason to forbid removing this
    // one specifically. Forbidding it anyway would strand a Hub whose only
    // host is misconfigured: it is auto-promoted to default the moment it is
    // the first one added, with no "make default" affordance on another to
    // demote it first.
    canRemove: true,
    hubBound: host.boundAt !== null,
    hubHostId: host.id,
    hubBaseUrl: host.baseUrl,
    capabilities: host.capabilities ?? null,
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
  /** Bumped to force an immediate re-probe of every host — see `bind`. */
  const [probeNonce, setProbeNonce] = useState(0);
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
    // `probeNonce` restarts it on purpose, for an immediate forced round.
  }, [source, entryKey, probeNonce]);

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
            ...(entry.labelIsPlaceholder ? { labelIsPlaceholder: true } : {}),
            probe: probes[entry.endpoint.id],
            isDefault: entry.isDefault,
            canRemove: entry.canRemove,
            ...(entry.hubBound === undefined ? {} : { hubBound: entry.hubBound }),
            ...(entry.hubHostId === undefined ? {} : { hubHostId: entry.hubHostId }),
            ...(entry.hubBaseUrl === undefined ? {} : { hubBaseUrl: entry.hubBaseUrl }),
            ...(entry.capabilities === undefined ? {} : { capabilities: entry.capabilities }),
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

  // Every id this directory already routes, plus the reserved default one. In
  // hub mode the registry's own row ids too: the default host is aliased to
  // `local` there, so its real id would otherwise look free.
  const takenIds = useMemo<string[]>(
    () => [
      DEFAULT_HOST_ID,
      ...entries.map((entry) => entry.endpoint.id),
      ...entries.flatMap((entry) => (entry.hubHostId ? [entry.hubHostId] : [])),
    ],
    [entries],
  );

  const proposeId = useCallback(
    (label: string): string => generateHostId(label, takenIds),
    [takenIds],
  );

  const add = useCallback(
    async (entry: {
      id: string;
      label: string;
      basePath: string;
    }): Promise<{ id: string; error: null } | { id: null; error: string }> => {
      if (source === 'hub') {
        const post = (id: string): Promise<Response> =>
          fetch('/api/hub/hosts', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, label: entry.label, baseUrl: entry.basePath }),
          });
        const refusal = async (response: Response): Promise<string> => {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          return body?.error?.message ?? 'The Hub refused that host.';
        };
        try {
          let id = entry.id;
          let response = await post(id);
          if (response.status === 409) {
            // Someone else took the proposed id between our last registry read
            // and this POST. Re-derive against the fresh list, once — a second
            // clash in the same instant is not worth a loop.
            const fresh = await probeHubRegistry();
            applyRegistry(fresh);
            id = generateHostId(entry.label, [
              ...takenIds,
              ...(fresh?.hosts.map((host) => host.id) ?? []),
              id,
            ]);
            response = await post(id);
          }
          if (!response.ok) return { id: null, error: await refusal(response) };
          applyRegistry(await probeHubRegistry());
          return { id, error: null };
        } catch {
          return { id: null, error: 'Could not reach the Hub.' };
        }
      }
      const problem = localHostProblem(entry, local, [DEFAULT_HOST_ID]);
      if (problem) return { id: null, error: problem };
      setLocal(addLocalHost(entry, local));
      return { id: entry.id, error: null };
    },
    [source, local, applyRegistry, takenIds],
  );

  // The Hub's own version (PA-107), read once the source is known to be a Hub.
  // In hub mode the bare `/health` is the Hub's — the default host is mounted
  // at `/api/*` only — so this is unambiguous; in local mode the same URL is
  // the backend's, which is exactly why it is not read there.
  const [hubVersion, setHubVersion] = useState<string | null>(null);
  useEffect(() => {
    if (source !== 'hub') return;
    let cancelled = false;
    void fetch('/health', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        const parsed = HealthResponse.safeParse(body);
        if (!cancelled && parsed.success) setHubVersion(parsed.data.version);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [source]);

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
        // PA-110: re-probe now. A host added and then bound has usually
        // already failed its first probe (it had no credential yet) and backed
        // off, and binding does not change `entryKey`, so without this its card
        // reads "unknown" for up to a minute after a bind that worked. A bump
        // rather than calling `probeAll` here: the caller typically holds the
        // `bind` from the render *before* its own `add`, whose `probeAll` does
        // not know the new host exists (the demo caught exactly that).
        setProbeNonce((n) => n + 1);
        return null;
      } catch {
        return 'Could not reach the Hub.';
      }
    },
    [source, applyRegistry],
  );

  const update = useCallback(
    async (
      hostId: string,
      patch: { label?: string; basePath?: string },
    ): Promise<string | null> => {
      if (source === 'hub') {
        try {
          const response = await fetch(`/api/hub/hosts/${encodeURIComponent(hostId)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            // `baseUrl` is the Hub's own field name for what this dialog
            // calls `basePath` everywhere else — the same one value, two
            // names, `AddHostDialog`'s own doc comment already explains why.
            body: JSON.stringify({ label: patch.label, baseUrl: patch.basePath }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            return body?.error?.message ?? 'The Hub refused that change.';
          }
          applyRegistry(await probeHubRegistry());
          return null;
        } catch {
          return 'Could not reach the Hub.';
        }
      }
      if (hostId === DEFAULT_HOST_ID) {
        return 'This is the host serving this page, and cannot be edited.';
      }
      const existing = local.find((row) => row.id === hostId);
      if (!existing) return 'No such host.';
      const problem = localHostProblem(
        { id: hostId, label: patch.label ?? existing.label, basePath: patch.basePath ?? existing.basePath },
        local.filter((row) => row.id !== hostId),
        [DEFAULT_HOST_ID],
      );
      if (problem) return problem;
      // `addLocalHost` upserts by id, so re-adding under the same id is the
      // edit.
      setLocal(
        addLocalHost(
          { id: hostId, label: patch.label ?? existing.label, basePath: patch.basePath ?? existing.basePath },
          local,
        ),
      );
      return null;
    },
    [source, local, applyRegistry],
  );

  return {
    source: source ?? 'local',
    ready: source !== null,
    hosts,
    // Both sources can manage, for different values of "manage" — see the two
    // hints. What would *not* be honest is offering nothing until PA-66 lands.
    canManage: true,
    manageHint: source === 'hub' ? HUB_HINT : LOCAL_HINT,
    proposeId,
    add,
    hubVersion: source === 'hub' ? hubVersion : null,
    remove,
    bind,
    update,
    refresh: () => probeAll(true),
    defaultBasePathFor,
  };
}
