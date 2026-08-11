import type { FastifyPluginAsync } from 'fastify';
import { CreateSessionRequest } from '@pocketagent/protocol';
import { SessionError } from '../sessions/manager.js';
import { WorkspaceError } from '../workspaces/index.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, workspaces, agents, conversations, adoption } = app.pocket;

  app.get('/api/agents', async () => ({ agents: agents.list() }));

  app.get('/api/workspaces', async () => ({ workspaces: await workspaces.list() }));

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  /** Conversations already on disk that can be resumed. */
  app.get('/api/conversations', async () => ({
    conversations: await conversations.list(),
  }));

  /** Existing tmux panes that could be adopted. Empty unless enabled. */
  app.get('/api/adoptable', async () => ({
    enabled: adoption.isEnabled(),
    targets: await adoption.list(),
  }));

  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    const info = sessions.find(request.params.id);
    if (!info) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such session.' } });
    }
    return reply.send(info);
  });

  app.post('/api/sessions', async (request, reply) => {
    const parsed = CreateSessionRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    const body = parsed.data;

    // Adopting a pane takes its working directory from the validated target,
    // not from the request body.
    let adopt: Parameters<typeof sessions.create>[0]['adopt'];
    if (body.adoptTargetId) {
      if (!adoption.isEnabled()) {
        return reply.code(400).send({
          error: {
            code: 'adoption_disabled',
            message: 'Adopting existing tmux sessions is not enabled on this server.',
          },
        });
      }
      const target = await adoption.resolve(body.adoptTargetId);
      if (!target) {
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'That pane is gone, or is no longer inside a workspace root.',
          },
        });
      }
      const attach = adoption.attachCommand(target);
      adopt = {
        command: attach.command,
        args: attach.args,
        cols: target.cols,
        rows: target.rows,
        label: `${target.command} · ${target.sessionName}`,
      };
      body.cwd = target.cwd;
    }

    let cwd: string;
    try {
      cwd = await workspaces.resolveWorkspacePath(body.cwd);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    try {
      const session = await sessions.create({
        agent: body.agent,
        cwd,
        cols: body.cols,
        rows: body.rows,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.transport !== undefined ? { transport: body.transport } : {}),
        ...(body.resumeAgentSessionId !== undefined
          ? { resumeAgentSessionId: body.resumeAgentSessionId }
          : {}),
        forkSession: body.forkSession,
        ...(adopt ? { adopt } : {}),
      });
      return reply.code(201).send(sessions.toInfo(session));
    } catch (err) {
      if (err instanceof SessionError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (request, reply) => {
    try {
      sessions.terminate(request.params.id);
    } catch (err) {
      if (err instanceof SessionError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
    const info = sessions.find(request.params.id);
    return reply.send(info ?? { ok: true });
  });
};
