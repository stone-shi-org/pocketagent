import type { FastifyReply } from 'fastify';
import { WorkspaceError, type WorkspaceRegistry } from '../workspaces/index.js';
import type { AgentRegistry } from '../agents/registry.js';

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
