import type { FastifyPluginAsync } from 'fastify';
import { CreateWorktreeRequest } from '@pocketagent/protocol';
import { WorktreeError } from '../git/worktree.js';
import { resolveWorkspaceCwdOrReply } from './shared.js';

export const worktreeRoutes: FastifyPluginAsync = async (app) => {
  const { workspaces, worktrees } = app.pocket;

  /**
   * Create a git worktree for an existing project, on its own branch.
   *
   * Deliberately separate from `POST /api/sessions`: this is the one place a
   * request mutates the project's git state on disk, so it gets its own audit
   * point the same way adding a workspace folder does. The browser follows up
   * with an ordinary `POST /api/sessions` using the `cwd` this returns.
   */
  app.post('/api/projects/worktree', async (request, reply) => {
    const parsed = CreateWorktreeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    const body = parsed.data;

    const projectCwd = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
    if (projectCwd === null) return reply;

    try {
      const result = await worktrees.create({
        projectCwd,
        branchMode: body.branchMode,
        ...(body.branchName !== undefined ? { branchName: body.branchName } : {}),
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof WorktreeError) {
        const status =
          err.code === 'branch_exists' || err.code === 'already_exists'
            ? 409
            : err.code === 'git_failed'
              ? 500
              : 400;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
};
