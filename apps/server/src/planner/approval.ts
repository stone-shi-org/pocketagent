import type { Db } from '../db/index.js';
import { readPlannerSettings, readPlannerToolApproval, writePlannerToolApproval } from './store.js';

export type PlannerToolApprovalChoice = 'allow_once' | 'allow_workspace' | 'allow_global' | 'deny';

/**
 * PA-6: the planner's mutating-tool approval gate.
 *
 * Deliberately not a live, blocking round-trip like
 * `StructuredSession.requestPermission` — that channel exists because a
 * genuinely bidirectional WebSocket is already open and can push a question
 * to the browser mid-turn and wait, in place, for the answer. The planner's
 * turn is streamed down to the browser (`PlannerChatService`'s generators),
 * but only one way — there is no channel back up except a fresh HTTP
 * request — so instead of holding a connection open, `PlannerChatService`
 * *pauses* the turn: it yields a `permission_request` event and ends that
 * leg of the stream the moment a mutating tool call has no remembered
 * decision (phase 4) and yolo mode is off (phase 5); a separate
 * `POST .../approvals/:id` call (itself another streamed response) resumes
 * it.
 *
 * The base invariant — an unanswered approval never decays into an allow —
 * still holds exactly, just via a different mechanism: nothing runs until
 * that second request arrives, and there is no timeout anywhere in this
 * path. "Remember" persists to `planner_tool_approvals`, the granularity
 * (per tool, per workspace or global) nothing else in this codebase has —
 * every existing approval channel is coarser (see the migration's own doc
 * comment in `db/index.ts`).
 *
 * `plannerYoloEnabled` is this feature's fourth documented override of
 * CLAUDE.md's "never answer a prompt for the user" invariant (after the
 * global switch, cron's inverted default, and webhooks). Checked live on
 * every call rather than cached, so flipping it off takes effect on the very
 * next tool call — the same "read the flag fresh" discipline
 * `SessionManager.setGlobalSkipPermissions` uses. It short-circuits *before*
 * the remembered-decision lookup and never writes one: yolo is a standing
 * operator-level override, not a decision to persist, and switching it back
 * off must not retroactively look like every tool call while it was on had
 * been individually approved.
 */

/**
 * Checked before ever pausing a turn. Yolo wins outright; otherwise a
 * workspace-scoped remembered row wins over a global one.
 */
export function resolveApprovalStatus(
  db: Db,
  toolName: string,
  workspaceId: string | null,
  /**
   * PA-10: this chat's tool calls are pre-approved because an unattended
   * trigger created it with its own skip-permissions decision already made
   * (`PlannerChat.skipToolApprovalsEnabled`).
   *
   * Sits beside `yoloEnabled` rather than replacing it, and behaves exactly
   * like it in the two ways that matter: it short-circuits *before* the
   * remembered-decision lookup, and it never writes one. Where it differs is
   * blast radius — yolo is a standing operator switch over every chat, this is
   * one chat whose provenance is a webhook that was explicitly configured to
   * bypass approval. Turning that webhook's toggle off later must not
   * retroactively make the calls it already ran look individually reviewed,
   * which is why nothing is persisted here either.
   *
   * A human chat never sets it: there is no HTTP field that can.
   */
  chatSkipsApprovals = false,
): 'allow' | 'deny' | null {
  if (chatSkipsApprovals) return 'allow';
  if (readPlannerSettings(db).yoloEnabled) return 'allow';
  if (workspaceId) {
    const scoped = readPlannerToolApproval(db, 'workspace', workspaceId, toolName);
    if (scoped) return scoped;
  }
  return readPlannerToolApproval(db, 'global', null, toolName);
}

/** A no-op for `allow_once` / `deny` — there is nothing to persist for a one-off decision. */
export function rememberDecisionIfAsked(
  db: Db,
  choice: PlannerToolApprovalChoice,
  toolName: string,
  workspaceId: string | null,
): void {
  if (choice === 'allow_workspace') {
    if (!workspaceId) {
      throw new Error('Cannot remember a workspace-scoped decision: this chat has no workspace.');
    }
    writePlannerToolApproval(db, 'workspace', workspaceId, toolName, 'allow');
  } else if (choice === 'allow_global') {
    writePlannerToolApproval(db, 'global', null, toolName, 'allow');
  }
}
