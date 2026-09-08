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
  // Which workspace's "..." menu is open, keyed by workspace id — same
  // one-at-a-time, keyed-by-owner pattern `ProjectList`'s `menuFor` uses.
  const [menuFor, setMenuFor] = useState<string | null>(null);

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

  // Same dismiss-on-Escape as `ProjectMenu` — only wired while a menu is
  // actually open, so this section doesn't eat every Escape keypress on the
  // page.
  useEffect(() => {
    if (menuFor === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuFor(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuFor]);

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

  /** Drop one chat from the list — the "X" on a chat row. Hard-deletes the
   * DB row; the transcript file on disk is left alone (see
   * `PlannerChatService.remove`'s doc comment), same "removing a chat never
   * deletes a transcript" discipline the project-chat tree's own "Remove"
   * follows. */
  const removeChat = (chatId: string): void => {
    void (async () => {
      try {
        await api.deletePlannerChat(chatId);
      } catch (err) {
        onApiError(err);
      } finally {
        await load();
      }
    })();
  };

  /** PA-35: "Delete N finished chats" from a workspace's "..." menu. A
   * planner chat has no `live` field to exclude (see
   * `DeleteAllPlannerChatsResponse`'s doc comment), so this clears every chat
   * in the workspace. */
  const deleteAllChats = (workspaceId: string): void => {
    setMenuFor(null);
    setBusy((prev) => new Set(prev).add(workspaceId));
    void (async () => {
      try {
        await api.deleteAllPlannerChats(workspaceId);
      } catch (err) {
        onApiError(err);
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(workspaceId);
          return next;
        });
        await load();
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
              <button
                type="button"
                className="round-btn plain"
                onClick={() => setMenuFor(menuFor === ws.id ? null : ws.id)}
                aria-label={`Options for ${ws.name}`}
                aria-expanded={menuFor === ws.id}
              >
                <Icon name="ellipsis" size={18} />
              </button>
              {menuFor === ws.id && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuFor(null)} role="presentation" />
                  <div className="menu project-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={wsChats.length === 0 || busy.has(ws.id)}
                      onClick={() => deleteAllChats(ws.id)}
                    >
                      {wsChats.length === 0
                        ? 'Nothing finished to clear'
                        : `Clear ${wsChats.length} finished chat${wsChats.length === 1 ? '' : 's'}`}
                    </button>
                  </div>
                </>
              )}
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
                  <button
                    type="button"
                    className="chat-remove"
                    onClick={() => removeChat(chat.id)}
                    aria-label={`Delete ${chat.title ?? 'Untitled chat'}`}
                    title="Delete chat"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
