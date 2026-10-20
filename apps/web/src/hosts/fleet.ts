import { useCallback, useEffect, useState } from 'react';
import type { HubFleetState } from '@pocketagent/protocol';
import { createApiClient } from '../api/client.js';
import { getHubFleet } from '../api/hub.js';
import type { HostEndpoint } from '../api/host.js';
import type { HostDirectory } from './directory.js';
import { findHostByManageId } from './host-status.js';
import type { HostRecord } from './host-status.js';

/**
 * PA-134: the "Fleet" entry in the Hub sidebar and the host sheet.
 *
 * The Fleet agent is an ordinary Pocket Agent on the coordinator, so opening
 * it is opening an ordinary `PlannerChatPage` on that host, through the
 * existing `/h/<coordinator>/` proxy — nothing here is a second chat UI. The
 * only work is picking the chat: the newest one in the Fleet agent, or a new
 * one if it has none yet.
 */

const POLL_MS = 30_000;

export interface FleetEntry {
  readonly state: HubFleetState;
  /** The coordinator's directory record, for its routing id and status. */
  readonly coordinator: HostRecord | null;
  /** Set when the entry cannot open the chat; the sentence to show instead. */
  readonly problem: string | null;
}

/** The Fleet state for the entry, or null when there is no Hub or no fleet. */
export function useFleetEntry(directory: HostDirectory): FleetEntry | null {
  const [state, setState] = useState<HubFleetState | null>(null);
  const isHub = directory.source === 'hub';

  useEffect(() => {
    if (!isHub) return;
    let cancelled = false;
    const load = (): void => {
      void getHubFleet()
        .then((next) => {
          if (!cancelled) setState(next);
        })
        .catch(() => undefined);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    // Fleet changes are made on the Hub page, which dispatches this event so
    // the sidebar does not lag a poll behind the card the user just used.
    window.addEventListener(FLEET_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(FLEET_CHANGED_EVENT, load);
    };
  }, [isHub]);

  if (!isHub || state === null || !state.enabled || state.coordinatorHostId === null) return null;
  const coordinator = findHostByManageId(directory.hosts, state.coordinatorHostId);
  const label = state.coordinatorLabel ?? state.coordinatorHostId;
  const problem =
    coordinator === null
      ? `Coordinator ${label} is no longer registered — move the role?`
      : coordinator.status === 'offline' || coordinator.status === 'unknown' || state.coordinatorOnline === false
        ? `Coordinator ${label} unreachable — move role?`
        : coordinator.status === 'incompatible'
          ? `Coordinator ${label} is incompatible with this UI — ${coordinator.message ?? 'upgrade it'}`
          : null;
  return { state, coordinator, problem };
}

export const FLEET_CHANGED_EVENT = 'pocketagent:fleet-changed';

export function announceFleetChanged(): void {
  window.dispatchEvent(new Event(FLEET_CHANGED_EVENT));
}

/**
 * The chat to open: the most recently active one in the Fleet agent, else a
 * new one. Through a client bound to the coordinator's own endpoint, because
 * that is the machine the chat lives on.
 */
export const fleetChatFor = async (endpoint: HostEndpoint, pocketAgentId: string): Promise<string> => {
  const client = createApiClient(endpoint);
  const { chats } = await client.listPlannerChats(pocketAgentId);
  // A person's chat only: not a subagent's, a scheduled job's, one attached to
  // a document workspace, or one an MCP client started, which would open
  // someone else's conversation.
  const newest = [...chats]
    .filter(
      (chat) =>
        chat.workspaceId === pocketAgentId &&
        !chat.docWorkspaceId &&
        !chat.parentChatId &&
        !chat.cronJobId &&
        !chat.mcpClient,
    )
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  if (newest) return newest.id;
  const created = await client.createPlannerChat({ workspaceId: pocketAgentId, title: 'Fleet' });
  return created.id;
};

/** One callback for every entry point: resolve the chat, then route to it. */
export function useOpenFleetChat(
  entry: FleetEntry | null,
  openOn: (hostId: string, chatId: string) => void,
  onError: (error: unknown) => void,
): () => void {
  return useCallback(() => {
    if (!entry?.coordinator || !entry.state.pocketAgentId) return;
    const { endpoint } = entry.coordinator;
    void fleetChatFor(endpoint, entry.state.pocketAgentId)
      .then((chatId) => openOn(endpoint.id, chatId))
      .catch(onError);
  }, [entry, openOn, onError]);
}
