import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PROTOCOL_VERSION,
  negotiateProtocol,
  type DocWorkspace,
  type HostInfo,
  type PlannerChat,
  type PlannerWorkspace,
  type ProjectInfo,
  type ShellSessionSummary,
} from '@pocketagent/protocol';
import { ApiError } from '../api/client.js';
import { compatibilityState, type HostCompatibilityState } from '../api/negotiate.js';
import {
  projectActions,
  type OpenChatOptions,
  type ProjectsState,
} from '../components/ProjectList.js';
import { fetchPlannerChats, type PlannerChatsState } from '../agent/planner-chats.js';
import { clientFor } from './HostContext.js';
import type { HostRecord } from './host-status.js';
import { backoffMs, isDue, pollIntervalFor, type PollInputs } from './poll-policy.js';

/**
 * The home screen's data, for every host at once (PA-67).
 *
 * ## Why one hook and not N
 *
 * React hooks cannot be called in a loop whose length is a runtime value, and
 * the number of registered hosts is exactly that. So this holds a map of
 * per-host slices behind *one* set of timers and hands each host a
 * `ProjectsState` façade built from `projectActions` — which means
 * `ProjectList`, `ShellSection` and `PocketAgentsSection` are consumed
 * unmodified, by the same props they already took, and the rule that those
 * three stay shared between the two layouts survives a feature that could
 * easily have forked them.
 *
 * ## What is deliberately *not* here
 *
 * No WebSocket. The ticket is explicit — "do not open a WebSocket per
 * registered host" — and the shape of this hook is what enforces it: sockets
 * belong to a mounted session pane, so they exist only for hosts with an open
 * tab, and a host that is merely registered costs HTTP polls or nothing at all.
 *
 * ## Failure is per host, by construction
 *
 * Every slice keeps its own `error` and its own last-good data, so one dead
 * host degrades exactly its own rows (acceptance criterion 4). The keep-last-
 * good-on-failure behaviour is inherited deliberately from the single-host
 * hook this replaces: blanking a list on a transient 5 s poll failure also
 * wiped every open desktop tab's title, since those are looked up in it.
 */
export interface HostSlice {
  projects: ProjectInfo[] | null;
  shells: ShellSessionSummary[] | null;
  host: HostInfo | null;
  hostCompatibility: HostCompatibilityState | null;
  error: string | null;
  plannerWorkspaces: PlannerWorkspace[] | null;
  plannerChats: PlannerChat[];
  docWorkspaces: DocWorkspace[];
}

const EMPTY_SLICE: HostSlice = {
  projects: null,
  shells: null,
  host: null,
  hostCompatibility: null,
  error: null,
  plannerWorkspaces: null,
  plannerChats: [],
  docWorkspaces: [],
};

export interface UseHostFleetOptions {
  /** Every registered host, in display order. */
  hosts: readonly HostRecord[];
  /** Which hosts to poll, and how often — see `hosts/poll-policy.ts`. */
  poll: PollInputs;
  /** Opens a session on a host. The host id is first: a session id alone is
      ambiguous across machines, which is the whole of PA-67's tab-identity
      problem in one signature. */
  onOpen: (hostId: string, sessionId: string, opts?: OpenChatOptions) => void;
  onOpenChat: (hostId: string, conversationId: string, opts?: OpenChatOptions) => void;
  onApiError: (error: unknown) => void;
  onReplaceSession?: (hostId: string, oldSessionId: string, newSessionId: string) => void;
}

export interface HostFleet {
  /** This host's chat list and actions, ready to hand to `ProjectList`. */
  stateFor: (hostId: string) => ProjectsState;
  /** This host's Pocket Agents data, ready for `PocketAgentsSection`. */
  plannerFor: (hostId: string) => PlannerChatsState;
  /** Re-reads one host now, regardless of its tier or backoff. */
  refreshHost: (hostId: string) => Promise<void>;
  /** Re-reads every host currently being polled. */
  refreshAll: () => Promise<void>;
}

interface PollMeta {
  lastAttemptAt: number;
  failures: number;
}

export function useHostFleet({
  hosts,
  poll,
  onOpen,
  onOpenChat,
  onApiError,
  onReplaceSession,
}: UseHostFleetOptions): HostFleet {
  const [slices, setSlices] = useState<Record<string, HostSlice>>({});

  // Refs, not state: the poll bookkeeping must never itself cause a render,
  // and `refreshHost` has to read the *current* value rather than whatever a
  // closure captured — two ticks in the same second would otherwise both see
  // "never attempted" and double-fetch.
  const metaRef = useRef<Record<string, PollMeta>>({});
  const endpointsRef = useRef(new Map<string, HostRecord>());
  endpointsRef.current = new Map(hosts.map((record) => [record.endpoint.id, record]));

  const refreshHost = useCallback(
    async (hostId: string) => {
      const record = endpointsRef.current.get(hostId);
      if (!record) return;
      const client = clientFor(record.endpoint);
      metaRef.current[hostId] = {
        lastAttemptAt: Date.now(),
        failures: metaRef.current[hostId]?.failures ?? 0,
      };
      try {
        const [list, planner] = await Promise.all([
          client.listProjects(),
          fetchPlannerChats(client),
        ]);
        metaRef.current[hostId] = { lastAttemptAt: Date.now(), failures: 0 };
        setSlices((prev) => ({
          ...prev,
          [hostId]: {
            projects: list.projects,
            shells: list.shells,
            host: list.host,
            hostCompatibility: compatibilityState(
              list.host.name,
              negotiateProtocol(PROTOCOL_VERSION, list.host.protocol),
            ),
            error: null,
            plannerWorkspaces: planner.workspaces,
            plannerChats: planner.chats,
            docWorkspaces: planner.docWorkspaces,
          },
        }));
      } catch (err) {
        onApiError(err);
        metaRef.current[hostId] = {
          lastAttemptAt: Date.now(),
          failures: (metaRef.current[hostId]?.failures ?? 0) + 1,
        };
        setSlices((prev) => {
          const previous = prev[hostId] ?? EMPTY_SLICE;
          return {
            ...prev,
            [hostId]: {
              ...previous,
              // Keep whatever last loaded; only fall back to empty when
              // nothing ever has, so a sidebar gated on `projects === null`
              // stops spinning after a first failure instead of forever.
              projects: previous.projects ?? [],
              shells: previous.shells ?? [],
              error: err instanceof ApiError ? err.message : 'Could not load projects.',
            },
          };
        });
      }
    },
    [onApiError],
  );

  // One timer per polled host rather than a single shared tick, so a host on
  // the 15 s background tier does not force the selected host's 5 s cadence to
  // be re-derived on every fire. The key below is what stops this effect from
  // tearing every timer down on unrelated re-renders: only an actual change to
  // *which* hosts are polled, or at what rate, should restart them.
  const scheduleKey = hosts
    .map((record) => `${record.endpoint.id}:${pollIntervalFor(record.endpoint.id, poll) ?? 0}`)
    .join('|');

  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const entry of scheduleKey.split('|')) {
      if (entry === '') continue;
      const separator = entry.lastIndexOf(':');
      const hostId = entry.slice(0, separator);
      const interval = Number(entry.slice(separator + 1));
      if (!Number.isFinite(interval) || interval <= 0) continue;

      const tick = (): void => {
        const meta = metaRef.current[hostId];
        // A host whose last fetches failed waits out its own backoff instead
        // of costing a request every interval forever — one switched-off
        // machine in the registry should not drain a phone's battery.
        const wait = backoffMs(interval, meta?.failures ?? 0);
        if (!isDue(Date.now(), meta?.lastAttemptAt, wait)) return;
        void refreshHost(hostId);
      };

      tick();
      timers.push(setInterval(tick, interval));
    }
    return () => {
      for (const timer of timers) clearInterval(timer);
    };
  }, [scheduleKey, refreshHost]);

  // Forget slices for hosts that are no longer registered, so removing a host
  // does not leave its chats in memory to reappear if the id is reused.
  useEffect(() => {
    const live = new Set(hosts.map((record) => record.endpoint.id));
    setSlices((prev) => {
      const stale = Object.keys(prev).filter((id) => !live.has(id));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const id of stale) {
        delete next[id];
        delete metaRef.current[id];
      }
      return next;
    });
  }, [hosts]);

  const states = useMemo(() => {
    const out: Record<string, ProjectsState> = {};
    for (const record of hosts) {
      const hostId = record.endpoint.id;
      const slice = slices[hostId] ?? EMPTY_SLICE;
      const refresh = (): Promise<void> => refreshHost(hostId);
      const setError = (message: string | null): void =>
        setSlices((prev) => ({ ...prev, [hostId]: { ...(prev[hostId] ?? EMPTY_SLICE), error: message } }));
      out[hostId] = {
        projects: slice.projects,
        shells: slice.shells,
        host: slice.host,
        hostCompatibility: slice.hostCompatibility,
        error: slice.error,
        refresh,
        ...projectActions({
          client: clientFor(record.endpoint),
          refresh,
          setError,
          onApiError,
          onOpen: (sessionId, opts) => onOpen(hostId, sessionId, opts),
          onOpenChat: (conversationId, opts) => onOpenChat(hostId, conversationId, opts),
          onReplaceSession: onReplaceSession
            ? (oldId, newId) => onReplaceSession(hostId, oldId, newId)
            : undefined,
          projects: slice.projects,
        }),
      };
    }
    return out;
  }, [hosts, slices, refreshHost, onApiError, onOpen, onOpenChat, onReplaceSession]);

  const planners = useMemo(() => {
    const out: Record<string, PlannerChatsState> = {};
    for (const record of hosts) {
      const hostId = record.endpoint.id;
      const slice = slices[hostId] ?? EMPTY_SLICE;
      out[hostId] = {
        workspaces: slice.plannerWorkspaces,
        chats: slice.plannerChats,
        docWorkspaces: slice.docWorkspaces,
        refresh: () => refreshHost(hostId),
      };
    }
    return out;
  }, [hosts, slices, refreshHost]);

  /**
   * A façade for a host that is not registered.
   *
   * Reached only in the frame between a host being removed and the tree
   * re-rendering without it, so it is an inert shape rather than an error:
   * empty lists, and actions that do nothing but resolve.
   */
  const stateFor = useCallback(
    (hostId: string): ProjectsState =>
      states[hostId] ?? {
        ...EMPTY_SLICE,
        projects: [],
        shells: [],
        refresh: () => Promise.resolve(),
        ...projectActions({
          client: clientFor({ id: hostId, basePath: '' }),
          refresh: () => Promise.resolve(),
          setError: () => undefined,
          onApiError,
          onOpen: () => undefined,
          onOpenChat: () => undefined,
          projects: [],
        }),
      },
    [states, onApiError],
  );

  const plannerFor = useCallback(
    (hostId: string): PlannerChatsState =>
      planners[hostId] ?? { workspaces: null, chats: [], docWorkspaces: [], refresh: () => Promise.resolve() },
    [planners],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all(
      hosts
        .filter((record) => pollIntervalFor(record.endpoint.id, poll) !== null)
        .map((record) => refreshHost(record.endpoint.id)),
    );
  }, [hosts, poll, refreshHost]);

  return { stateFor, plannerFor, refreshHost, refreshAll };
}
