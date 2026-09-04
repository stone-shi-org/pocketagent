import type { FastifyPluginAsync } from 'fastify';
import { CreateWorktreeRequest, DeleteRemoteBranchRequest, DeleteWorktreeRequest } from '@pocketagent/protocol';
import { WorktreeError } from '../git/worktree.js';
import { resolveWorkspaceCwdOrReply } from './shared.js';

export const worktreeRoutes: FastifyPluginAsync = async (app) => {
  const { workspaces, worktrees, sessions } = app.pocket;

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

  /**
   * Delete a linked git worktree and its local branch (three-dot menu,
   * worktree rows only).
   *
   * A live session rooted in this exact `cwd` refuses the request outright —
   * the same "never disturb a running session" posture `sessions.forget()`
   * already has for a single session, extended here to a whole directory,
   * since deleting a worktree out from under a running agent/terminal would
   * orphan its working directory mid-turn.
   */
  app.post('/api/projects/worktree/delete', async (request, reply) => {
    const parsed = DeleteWorktreeRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const worktreeCwd = await resolveWorkspaceCwdOrReply(workspaces, parsed.data.cwd, reply);
    if (worktreeCwd === null) return reply;

    if (sessions.hasAliveSessionIn(worktreeCwd)) {
      return reply.code(409).send({
        error: { code: 'worktree_busy', message: 'Stop sessions running in this worktree first.' },
      });
    }

    try {
      const result = await worktrees.remove({ worktreeCwd });
      return reply.code(200).send({ ok: true, ...result });
    } catch (err) {
      if (err instanceof WorktreeError) {
        const status =
          err.code === 'not_a_worktree' ? 400 : err.code === 'dirty' || err.code === 'unmerged' ? 409 : 500;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /**
   * Delete a branch on a remote — only ever the exact
   * `{ remoteName, remoteBranch }` pair `POST /api/projects/worktree/delete`
   * itself returned moments earlier, after the user opts in to a follow-up
   * prompt. The worktree and local branch are already gone by this point;
   * `cwd` here is the main checkout, not the (now-removed) worktree.
   */
  app.post('/api/projects/worktree/delete-remote', async (request, reply) => {
    const parsed = DeleteRemoteBranchRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const mainCwd = await resolveWorkspaceCwdOrReply(workspaces, parsed.data.cwd, reply);
    if (mainCwd === null) return reply;

    try {
      await worktrees.deleteRemoteBranch({
        mainCwd,
        remoteName: parsed.data.remoteName,
        remoteBranch: parsed.data.remoteBranch,
      });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      if (err instanceof WorktreeError) {
        return reply.code(500).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });
};
