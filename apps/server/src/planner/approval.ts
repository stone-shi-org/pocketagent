import type { Db } from '../db/index.js';
import { readPlannerToolApproval, writePlannerToolApproval } from './store.js';

export type PlannerToolApprovalChoice = 'allow_once' | 'allow_workspace' | 'allow_global' | 'deny';

/**
 * PA-6, phase 4: the planner's mutating-tool approval gate.
 *
 * Deliberately not a live, blocking round-trip like
 * `StructuredSession.requestPermission` — that channel exists because a
 * WebSocket is already open and can push a question to the browser mid-turn.
 * The planner chat is still request/response (see `llm-client.ts`'s doc
 * comment on why streaming is deferred), so instead of blocking an HTTP
 * request indefinitely, `PlannerChatService` *pauses* the turn and returns an
 * `approval_required` result the moment a mutating tool call has no
 * remembered decision; a separate `POST .../approvals/:id` call resumes it.
 *
 * The base invariant — an unanswered approval never decays into an allow —
 * still holds exactly, just via a different mechanism: nothing runs until
 * that second request arrives, and there is no timeout anywhere in this
 * path. "Remember" persists to `planner_tool_approvals`, the granularity
 * (per tool, per workspace or global) nothing else in this codebase has —
 * every existing approval channel is coarser (see the migration's own doc
 * comment in `db/index.ts`).
 */

/** Checked before ever pausing a turn. A workspace-scoped row wins over a global one. */
export function rememberedDecision(
  db: Db,
  toolName: string,
  workspaceId: string | null,
): 'allow' | 'deny' | null {
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
