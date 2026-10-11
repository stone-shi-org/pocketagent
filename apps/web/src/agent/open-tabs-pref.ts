/**
 * The desktop tab strip's open tabs, remembered across a reload.
 *
 * `DesktopShell` keeps every open session/chat mounted at once so switching
 * tabs doesn't drop a WebSocket — see its own doc comment for why. Losing that
 * whole layout on every refresh (back to the one tab the URL hash encodes)
 * would make the strip feel like it was never really there, so the ordered
 * list is mirrored to `localStorage` too, same as `terminal-font-pref.ts` and
 * `adopted-size-prefs.ts`.
 *
 * Deliberately protocol-agnostic (no `Route` import here): this only ever
 * stores the fields each tabbable route kind needs, and every read is
 * validated rather than trusted, so a future shape change or a
 * hand-edited/corrupted value degrades to "no tabs restored" instead of
 * crashing the shell on boot.
 *
 * `localStorage` can be unavailable (private browsing, disabled storage) or,
 * outside a real browser, simply not exist as a global at all — every call is
 * wrapped so that degrades to "nothing remembered" rather than throwing.
 */
const KEY = 'pocketagent:open-tabs';

/** A stored tab's route, without the host — see `StoredTabRoute`. */
export type StoredRouteShape =
  | { name: 'terminal'; sessionId: string }
  | { name: 'chat'; conversationId: string }
  | { name: 'planner-chat'; chatId: string }
  | { name: 'settings' }
  | { name: 'providers' }
  | { name: 'cron' }
  | { name: 'cron-job'; jobId: string }
  | { name: 'webhooks' }
  | { name: 'webhook'; webhookId: string }
  | { name: 'planner' }
  | { name: 'planner-agent'; agentId: string };

/**
 * A stored tab: its route, plus which host it was open on (PA-67).
 *
 * `hostId` is required here and *optional on disk*, which is the whole
 * migration. Tabs written before PA-67 carry no host, and dropping them would
 * mean every existing user losing their tab strip on upgrade for no reason a
 * user could see — so a missing one is read as the default host, which is the
 * only host those tabs could possibly have been open on. This validator is
 * already the designated place where a shape change degrades gracefully rather
 * than crashing the shell on boot, so the migration lives here rather than in
 * `DesktopShell`.
 */
export type StoredTabRoute = StoredRouteShape & { hostId: string };

function isStoredRouteShape(value: unknown): value is StoredRouteShape {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  if (entry.name === 'terminal') return typeof entry.sessionId === 'string' && entry.sessionId.length > 0;
  if (entry.name === 'chat') return typeof entry.conversationId === 'string' && entry.conversationId.length > 0;
  if (entry.name === 'planner-chat') return typeof entry.chatId === 'string' && entry.chatId.length > 0;
  if (entry.name === 'settings') return true;
  if (entry.name === 'providers') return true;
  if (entry.name === 'cron') return true;
  if (entry.name === 'cron-job') return typeof entry.jobId === 'string' && entry.jobId.length > 0;
  if (entry.name === 'webhooks') return true;
  if (entry.name === 'webhook') return typeof entry.webhookId === 'string' && entry.webhookId.length > 0;
  if (entry.name === 'planner') return true;
  if (entry.name === 'planner-agent') return typeof entry.agentId === 'string' && entry.agentId.length > 0;
  return false;
}

export function loadOpenTabRoutes(defaultHostId: string): StoredTabRoute[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredRouteShape).map((route) => {
      const hostId = (route as { hostId?: unknown }).hostId;
      return {
        ...route,
        hostId: typeof hostId === 'string' && hostId.length > 0 ? hostId : defaultHostId,
      };
    });
  } catch {
    return [];
  }
}

export function saveOpenTabRoutes(routes: StoredTabRoute[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(routes));
  } catch {
    /* private browsing, or no storage at all — best effort only */
  }
}
