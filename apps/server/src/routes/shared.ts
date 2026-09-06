import type { FastifyReply } from 'fastify';
import { WorkspaceError, type WorkspaceRegistry } from '../workspaces/index.js';
import type { AgentRegistry } from '../agents/registry.js';
import { parsePocketAgentId } from '@pocketagent/protocol';

/**
 * Resolve a browser-supplied `cwd` through workspace containment, writing the
 * error response itself on failure.
 *
 * Pulled out of `routes/sessions.ts` so every route that accepts a directory —
 * session creation, the `/api/projects/*` actions, and worktree creation —
 * maps `WorkspaceError` to a status code exactly one way. Returns `null` once
 * the reply has already been sent; callers should `return reply` in that case.
 */
export async function resolveWorkspaceCwdOrReply(
  workspaces: WorkspaceRegistry,
  cwd: string,
  reply: FastifyReply,
): Promise<string | null> {
  try {
    return await workspaces.resolveWorkspacePath(cwd);
  } catch (err) {
    if (err instanceof WorkspaceError) {
      const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
      void reply.code(status).send({ error: { code: err.code, message: err.message } });
      return null;
    }
    throw err;
  }
}

/**
 * Refuse an agent that cannot run unattended, returning a message or `null`.
 *
 * Shared by scheduled jobs and inbound webhooks because the rule and its reason
 * are identical: delivering a prompt to a terminal session means writing
 * keystrokes into a TUI with no readiness signal and no way to tell a finished
 * turn from a hung one, which is exactly the judgement `terminal/classifier.ts`
 * must never make. Refused at the route rather than silently downgraded.
 *
 * `noun` names the thing being created so the message reads naturally in both
 * callers ("cannot be scheduled" / "cannot be triggered by a webhook").
 */
export function structuredAgentProblem(
  agents: AgentRegistry,
  id: string,
  noun: 'scheduled' | 'triggered by a webhook',
): string | null {
  const adapter = agents.get(id);
  if (adapter === undefined) return `No such agent "${id}".`;
  if (!adapter.transports.includes('structured')) {
    return `${adapter.displayName} cannot be ${noun}: it has no structured mode, and an unattended run has nobody to type at a terminal.`;
  }
  return null;
}

/**
 * PA-10: the same check, widened to the one place a *Pocket Agent* is also a
 * legal answer — an inbound webhook's `agent`.
 *
 * A Pocket Agent takes a different branch entirely rather than a relaxed
 * version of the same one: the structured-transport requirement is about
 * driving a coding-agent CLI and has no meaning for a planner chat, which is
 * always "structured" in the only sense that matters (a turn with a completion
 * signal, never keystrokes into a TUI). What replaces it is the check that
 * matters here — that the planner workspace the id names still exists — so a
 * webhook cannot be saved pointing at an agent someone deleted.
 *
 * Not applied to cron: `CreateCronJobRequest` still only accepts a coding
 * agent, and `structuredAgentProblem` stays its checker. Widening that is a
 * separate decision with its own disclosure work, not a side effect of this one.
 */
export function webhookAgentProblem(
  agents: AgentRegistry,
  plannerWorkspaces: { get(id: string): unknown },
  id: string,
): string | null {
  const plannerWorkspaceId = parsePocketAgentId(id);
  if (plannerWorkspaceId !== null) {
    return plannerWorkspaces.get(plannerWorkspaceId) === undefined
      ? `No such Pocket Agent. It may have been deleted.`
      : null;
  }
  return structuredAgentProblem(agents, id, 'triggered by a webhook');
}
