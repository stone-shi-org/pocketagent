import { z } from 'zod';

/**
 * PA-165: the status dot a chat row carries, for coding-agent chats and
 * Pocket Agent chats alike.
 *
 * Four states plus "nothing", in precedence order:
 *
 * - `approval` — a tool call is parked on a human. Wins over everything,
 *   because it is the one state in which nothing happens until you act; a
 *   turn waiting on an approval is technically still "running", and folding
 *   it into `running` is what hid it before.
 * - `running` — a turn is in flight.
 * - `unread` — the last turn finished after you last looked at the chat.
 * - `idle` — a coding session that is alive, idle, and already read. Steady
 *   rather than pulsing: most live sessions sit here, and a flashing dot on
 *   each of them would bury the three states that do want attention. A Pocket
 *   Agent chat has no process, so it has no `idle` state — "alive but idle"
 *   would describe every chat it has ever had.
 * - `null` — no dot (a finished coding chat, an idle Pocket Agent chat).
 *
 * The rule lives in the protocol package for the reason `cron-expr.ts` does:
 * the facts (`unread`, `awaitingApproval`) are the server's, the rendering is
 * the browser's, and every surface that draws a dot — project tree, Pocket
 * Agents section, Shell category, desktop tab strip — must agree on it.
 */
export type ChatDotState = 'approval' | 'running' | 'unread' | 'idle';

/** A coding-agent chat or shell row (`ChatSummary`'s relevant fields). */
export function chatDotState(chat: {
  live: boolean;
  busySince: number | null;
  awaitingApproval?: boolean | undefined;
  unread?: boolean | undefined;
}): ChatDotState | null {
  if (!chat.live) return null;
  if (chat.awaitingApproval) return 'approval';
  if (chat.busySince !== null) return 'running';
  if (chat.unread) return 'unread';
  return 'idle';
}

/** A Pocket Agent chat (`PlannerChat`'s relevant fields). */
export function plannerChatDotState(chat: {
  busy?: boolean | undefined;
  awaitingApproval?: boolean | undefined;
  unread?: boolean | undefined;
}): ChatDotState | null {
  if (chat.awaitingApproval) return 'approval';
  if (chat.busy) return 'running';
  if (chat.unread) return 'unread';
  return null;
}

/** The words a dot stands for — its `aria-label` and tooltip, so colour is
    never the only signal. */
export const CHAT_DOT_LABELS: Record<ChatDotState, string> = {
  approval: 'Waiting for your approval',
  running: 'Running',
  unread: 'Finished — not read yet',
  idle: 'Live — idle',
};

/**
 * PA-165: `POST /api/chats/read`. A chat is identified by what its dot is
 * computed from: a coding session by its session id (the dot belongs to the
 * live session, which is the representative a chat row is built from), a
 * Pocket Agent chat by its chat id.
 */
export const ChatReadKind = z.enum(['session', 'planner']);
export type ChatReadKind = z.infer<typeof ChatReadKind>;

export const MarkChatReadRequest = z.object({
  kind: ChatReadKind,
  id: z.string().min(1).max(200),
});
export type MarkChatReadRequest = z.infer<typeof MarkChatReadRequest>;
