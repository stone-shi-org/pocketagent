import type { PushPayload } from '@pocketagent/protocol';
import { readMcpOwnedWork, type Db } from '../db/index.js';
import type { PlannerChatService } from '../planner/chats.js';
import type { PushService } from './index.js';

/**
 * PA-134: a push notification for an approval in a Pocket Agent chat that an
 * MCP client started.
 *
 * Coding sessions have pushed their approvals since push existed; Pocket Agent
 * chats never did, because a planner turn is driven from an open browser tab
 * whose card shows the approval anyway. A chat an MCP client created — a Fleet
 * dispatch from the Hub, or any PA-118 client's `run_pocket_task` — has no
 * such tab, and the client can see the approval but never answer it. So the
 * human has to be told, and through a Hub this arrives as
 * `/#/h/<host>/planner/<chatId>` (the relay rewrites the link), which is the
 * deep link `wait` reports.
 *
 * Scoped to MCP-started chats on purpose: a human's own chat would otherwise
 * buzz the phone for the approval card they are already looking at. Same
 * payload discipline as every other push: it says "approval needed", never the
 * tool or its arguments, since the push relay sees the timing.
 */
export function plannerApprovalPayload(chatId: string, title: string): PushPayload {
  return {
    title: 'PocketAgent — approval needed',
    body: `${title} is waiting for your decision.`,
    url: `/#/planner/${encodeURIComponent(chatId)}`,
    tag: `approval-planner-${chatId}`,
  };
}

export function wirePlannerApprovalPush(db: Db, plannerChats: PlannerChatService, push: PushService): () => void {
  return plannerChats.observeAll((chatId, event) => {
    if (event.kind !== 'permission_request') return;
    if (!readMcpOwnedWork(db, 'planner_chat', chatId)) return;
    const chat = plannerChats.get(chatId);
    void push.send(plannerApprovalPayload(chatId, chat?.title ?? 'A Pocket Agent chat')).catch(() => undefined);
  });
}

/** The same payloads for approvals still parked, replayed to a Hub on connect. */
export function pendingPlannerApprovalPayloads(db: Db, plannerChats: PlannerChatService): PushPayload[] {
  return plannerChats
    .inFlightTurns()
    .filter((turn) => turn.reason === 'awaiting_approval' && readMcpOwnedWork(db, 'planner_chat', turn.chatId) !== null)
    .map((turn) => plannerApprovalPayload(turn.chatId, turn.title));
}

/**
 * PA-178: a Pocket Agent asked a person to operate its shared browser. Pushed
 * for *every* chat, unlike an approval above: the person is rarely looking at
 * the browser when the agent hits a login, and the card in the chat is not
 * where they act — the viewer is, so that is where the link goes. Through a
 * Hub the PA-73 relay rewrites it to `/#/h/<host>/browser/<id>`. Same payload
 * discipline: it never carries the agent's reason or the page's address.
 */
export function browserHelpPayload(browserId: string, chatTitle: string): PushPayload {
  return {
    title: 'PocketAgent — your help is needed in a browser',
    body: `${chatTitle} is waiting for you to finish something in its browser.`,
    url: `/#/browser/${encodeURIComponent(browserId)}`,
    tag: `browser-help-${browserId}`,
  };
}

export function wireBrowserHelpPush(plannerChats: PlannerChatService, push: PushService): () => void {
  return plannerChats.observeAll((chatId, event) => {
    if (event.kind !== 'browser_help_request') return;
    const chat = plannerChats.get(chatId);
    void push.send(browserHelpPayload(event.browserId, chat?.title ?? 'A Pocket Agent chat')).catch(() => undefined);
  });
}

/** The same payloads for handoffs still parked, replayed to a Hub on connect. */
export function pendingBrowserHelpPayloads(plannerChats: PlannerChatService): PushPayload[] {
  return plannerChats.pendingBrowserHelp().map((p) => browserHelpPayload(p.browserId, p.chatTitle));
}
