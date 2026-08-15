import type { FastifyReply } from 'fastify';
import { WorkspaceError, type WorkspaceRegistry } from '../workspaces/index.js';

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
