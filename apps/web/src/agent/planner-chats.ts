import type { DocWorkspace, PlannerChat, PlannerWorkspace } from '@pocketagent/protocol';
import type { ApiClient } from '../api/client.js';

/**
 * Pocket Agent workspaces and chats for one host.
 *
 * Was `usePlannerChats`, a hook with its own 5 s timer, itself lifted out of
 * `PocketAgentsSection` in PA-36 so `DesktopShell`'s tab titles could share one
 * poller rather than running a second alongside the section's. PA-67 finishes
 * that direction of travel: the home screen now shows this category *per host*,
 * so the timer has to live where the decision about which hosts to poll is made
 * (`hosts/useHostFleet.ts`, per `hosts/poll-policy.ts`), and what is left here
 * is the fetch itself plus the shape the section consumes.
 *
 * Fetched alongside `/api/projects` in one `Promise.all` per host, which is
 * also why it is not a hook any more: three requests on one schedule per host
 * is the unit the poll policy reasons about, not three independent timers.
 */
export interface PlannerChatsState {
  /** `null` while the first load for this host is still in flight. */
  workspaces: PlannerWorkspace[] | null;
  chats: PlannerChat[];
  /** PA-142: host-folder document workspaces on this host. */
  docWorkspaces: DocWorkspace[];
  /** Re-fetches both lists — called after every mutation the section makes. */
  refresh: () => Promise<void>;
}

export interface PlannerChatsData {
  workspaces: PlannerWorkspace[];
  chats: PlannerChat[];
  docWorkspaces: DocWorkspace[];
}

export async function fetchPlannerChats(client: ApiClient): Promise<PlannerChatsData> {
  const [workspaces, chats, docWorkspaces] = await Promise.all([
    client.listPlannerWorkspaces(),
    client.listPlannerChats(),
    typeof client.listDocWorkspaces === 'function'
      ? client.listDocWorkspaces().catch(() => ({ workspaces: [] }))
      : Promise.resolve({ workspaces: [] }),
  ]);
  return {
    workspaces: workspaces.workspaces,
    chats: chats.chats,
    docWorkspaces: docWorkspaces.workspaces,
  };
}

