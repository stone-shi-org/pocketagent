import { useCallback, useEffect, useState } from 'react';
import type { PlannerChat, PlannerWorkspace } from '@pocketagent/protocol';
import { api } from '../api/client.js';
import { Icon } from './Icon.js';

interface Props {
  onOpenChat: (chatId: string) => void;
  onApiError: (error: unknown) => void;
  activeChatId?: string | null;
}

const REFRESH_MS = 5000;

/**
 * PA-6: "Pocket Agents" — parallel to "Projects", one section per named
 * agent (a planner workspace) with its chats nested underneath, exactly the
 * grouping `ProjectSection` already gives project folders. Was missing
 * entirely before this fix and reachable only from the overflow menu, which
 * the reporter flagged as a bug in its own right: an agent's chats are just
 * as much "what was I doing" content as a project's, and deserve the same
 * home-screen presence, not a menu item.
 *
 * Read/navigate only — adding, renaming, or removing an agent lives on the
 * settings page (`PlannerPage`, reachable from the same overflow menu this
 * section's rows replace the sole purpose of), the same split "Projects"
 * itself draws between browsing chats here and managing folders elsewhere.
 */
export function PocketAgentsSection({ onOpenChat, onApiError, activeChatId }: Props): JSX.Element | null {
  const [workspaces, setWorkspaces] = useState<PlannerWorkspace[] | null>(null);
  const [chats, setChats] = useState<PlannerChat[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const [ws, ch] = await Promise.all([api.listPlannerWorkspaces(), api.listPlannerChats()]);
      setWorkspaces(ws.workspaces);
      setChats(ch.chats);
    } catch (err) {
      onApiError(err);
    }
  }, [onApiError]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const newChat = (workspaceId: string): void => {
    setBusy((prev) => new Set(prev).add(workspaceId));
    void (async () => {
      try {
        const chat = await api.createPlannerChat({ workspaceId });
        onOpenChat(chat.id);
        await load();
      } catch (err) {
        onApiError(err);
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
      }
    })();
  };

  // Loading and "no agents at all" (should not happen post-seeding, but a
  // fresh boot racing this request is possible) both render nothing rather
  // than an empty section header — same "don't flash an empty state" choice
  // `ProjectList` makes while `projects === null`.
  if (workspaces === null || workspaces.length === 0) return null;

  return (
    <div className="agents-section">
      <h2 className="section-heading">Pocket Agents</h2>
      {workspaces.map((ws) => {
        const isCollapsed = collapsed.has(ws.id);
        const wsChats = chats.filter((c) => c.workspaceId === ws.id);
        return (
          <div key={ws.id}>
            <div className="project-head">
              <button
                type="button"
                className="project-name"
                onClick={() => toggle(ws.id)}
                aria-expanded={!isCollapsed}
                title={ws.name}
              >
                <span className="project-icon">
                  <Icon name="agent-generic" className="folder" />
                </span>
                <span className="project-label">{ws.name}</span>
                <Icon name="chevron-down" className={`project-caret${isCollapsed ? ' closed' : ''}`} />
                {isCollapsed && <span className="project-count">{wsChats.length}</span>}
              </button>
              <button
                type="button"
                className="round-btn plain"
                disabled={busy.has(ws.id)}
                onClick={() => newChat(ws.id)}
                aria-label={`New chat with ${ws.name}`}
                title={`New chat with ${ws.name}`}
              >
                <Icon name="compose" size={19} />
              </button>
            </div>
            {!isCollapsed && wsChats.length === 0 && (
              <div className="project-empty">No chats yet</div>
            )}
            {!isCollapsed &&
              wsChats.map((chat) => (
                <div key={chat.id} className="chat-line">
                  <button
                    type="button"
                    className={`chat-row${activeChatId === chat.id ? ' active' : ''}`}
                    onClick={() => onOpenChat(chat.id)}
                    title={chat.title ?? 'Untitled chat'}
                  >
                    <span className="chat-title">{chat.title ?? 'Untitled chat'}</span>
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
