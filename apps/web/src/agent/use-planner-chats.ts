import { useCallback, useEffect, useState } from 'react';
import type { PlannerChat, PlannerWorkspace } from '@pocketagent/protocol';
import { api } from '../api/client.js';

const REFRESH_MS = 5000;

export interface PlannerChatsState {
  workspaces: PlannerWorkspace[] | null;
  chats: PlannerChat[];
  refresh: () => Promise<void>;
}

/**
 * Polls Pocket Agent workspaces + chats on a fixed cadence — the same data
 * `PocketAgentsSection` used to fetch and poll entirely on its own before
 * PA-36. Lifted out into a hook so a page that needs the same data for a
 * second purpose (`DesktopShell`'s tab titles, once Pocket Agent chats
 * became tabbable) can share one poller instead of opening a second one
 * alongside `PocketAgentsSection`'s — the same split `useProjects`/
 * `ProjectList` already draws for project chats. `ProjectsPage` (the phone
 * layout) and `DesktopShell` each call this once and hand the result to
 * `PocketAgentsSection` as props; the component itself no longer fetches.
 */
export function usePlannerChats(onApiError: (error: unknown) => void): PlannerChatsState {
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [chats, setChats] = useState<PlannerChat[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [ws, ch] = await Promise.all([api.listPlannerWorkspaces(), api.listPlannerChats()]);
      setWorkspaces(ws.workspaces);
      setChats(ch.chats);
    } catch (err) {
      onApiError(err);
    }
  }, [onApiError]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { workspaces, chats, refresh };
}
