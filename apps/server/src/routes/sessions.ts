import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateSessionRequest,
  ProjectRequest,
  RemoveChatRequest,
  WorkspaceRequest,
} from '@pocketagent/protocol';
import os from 'node:os';
import path from 'node:path';
import { browseDirectory, discoverFolders } from '../discover/index.js';
import { SessionError } from '../sessions/manager.js';
import { WorkspaceError } from '../workspaces/index.js';
import { hideChat } from '../db/index.js';
import { VIRTUAL_SHELL_CWD } from '../projects/index.js';
import { resolveWorkspaceCwdOrReply } from './shared.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, workspaces, agents, conversations, adoption, projects } = app.pocket;

  app.get('/api/agents', async () => ({ agents: agents.list() }));

  /** The home screen: every directory with activity, and the chats inside it. */
  app.get<{ Querystring: { includeHidden?: string } }>('/api/projects', async (request) => ({
    host: projects.host(),
    projects: await projects.list(sessions.list(), request.query.includeHidden === '1'),
  }));

  /**
   * Remove a chat from the list.
   *
   * Nothing on disk is deleted. The session record goes, and a conversation is
   * remembered as removed so the next scan of the transcript directory does not
   * quietly put it back. It stays resumable from a terminal.
   */
  app.post('/api/chats/remove', async (request, reply) => {
    const parsed = RemoveChatRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    if (parsed.data.sessionId) {
      try {
        sessions.forget(parsed.data.sessionId);
      } catch (err) {
        if (err instanceof SessionError) {
          // A missing record is the desired end state, so only a *running*
          // session is worth refusing over.
          if (err.code !== 'not_found') {
            return reply
              .code(err.statusCode)
              .send({ error: { code: err.code, message: err.message } });
          }
        } else throw err;
      }
    }
    if (parsed.data.conversationId) hideChat(app.pocket.db, parsed.data.conversationId);

    return reply.send({ ok: true });
  });

  /**
   * Forget every finished chat in a directory. Running ones are left alone.
   *
   * The Shell virtual project is a special case: `VIRTUAL_SHELL_CWD` is a
   * display-only label `ProjectService` computes for adopted sessions and
   * never persists — the row's own `cwd` column is always the pane's real
   * directory (see `forgetFinishedAdopted`'s doc comment) — so it cannot go
   * through the normal `resolveWorkspaceCwdOrReply` path at all: that
   * resolves `cwd` as a real filesystem path, and `'virtual:shell'` is not
   * one. Before this check, clicking "Clear finished chats" on the Shell
   * card 404'd (`ENOENT` resolving it as a directory) without clearing
   * anything, even though the button was shown and enabled the same as any
   * other project.
   */
  app.post('/api/projects/clear-finished', async (request, reply) => {
    const parsed = ProjectRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    const isShell = parsed.data.cwd === VIRTUAL_SHELL_CWD;
    let cwd: string;
    if (isShell) {
      cwd = VIRTUAL_SHELL_CWD;
    } else {
      const resolved = await resolveWorkspaceCwdOrReply(workspaces, parsed.data.cwd, reply);
      if (resolved === null) return reply;
      cwd = resolved;
    }

    const removedSessions = isShell ? sessions.forgetFinishedAdopted() : sessions.forgetFinishedIn(cwd);
    let removedConversations = 0;
    for (const project of await projects.list(sessions.list(), true)) {
      if (project.cwd !== cwd) continue;
      for (const chat of project.chats) {
        if (chat.live || !chat.conversationId) continue;
        hideChat(app.pocket.db, chat.conversationId);
        removedConversations++;
      }
    }
    return reply.send({ ok: true, removedSessions, removedConversations });
  });

  app.post('/api/projects/hide', async (request, reply) => {
    const cwd = await resolveProjectCwd(request.body, reply);
    if (cwd === null) return reply;
    projects.setHidden(cwd, true);
    return reply.send({ ok: true });
  });

  app.post('/api/projects/unhide', async (request, reply) => {
    const cwd = await resolveProjectCwd(request.body, reply);
    if (cwd === null) return reply;
    projects.setHidden(cwd, false);
    return reply.send({ ok: true });
  });

  /**
   * Validate a directory from the browser the same way session creation does.
   * Returns null once it has already written the error response.
   */
  async function resolveProjectCwd(body: unknown, reply: FastifyReply): Promise<string | null> {
    const parsed = ProjectRequest.safeParse(body);
    if (!parsed.success) {
      void reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
      return null;
    }
    return resolveWorkspaceCwdOrReply(workspaces, parsed.data.cwd, reply);
  }

  /** One entry until a front server can register others. */
  app.get('/api/hosts', async () => ({ hosts: [projects.host()] }));

  app.get('/api/workspaces', async () => ({ workspaces: await workspaces.list() }));

  /**
   * Add a project folder.
   *
   * Any absolute directory on this host, which is the point of the feature —
   * but note what it means: from here on, sessions may be started inside it.
   * The check at session creation has not gone away, it now consults a list the
   * user curates rather than one fixed in the environment.
   */
  app.post('/api/workspaces/add', async (request, reply) => {
    const parsed = WorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      const added = await workspaces.add(parsed.data.path);
      app.log.warn({ path: added }, 'project folder added; sessions may now run here');
      return reply.send({ ok: true, path: added, label: workspaces.labelFor(added) });
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  /** Forget a folder. Sessions already running in it keep running. */
  app.post('/api/workspaces/remove', async (request, reply) => {
    const parsed = WorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    return reply.send({ ok: workspaces.remove(parsed.data.path) });
  });

  /** Folders the agents have run in before, minus the ones already added. */
  app.get('/api/discovered', async () => {
    const added = new Set(workspaces.getRoots());
    const folders = await discoverFolders();
    return {
      folders: folders
        .filter((f) => !added.has(f.path))
        .map((f) => ({ ...f, label: workspaces.labelFor(f.path) })),
    };
  });

  /**
   * List subdirectories, for picking a folder to add.
   *
   * A browser cannot offer an OS directory picker for a path on a *different*
   * machine: `showDirectoryPicker` hands back a handle to the phone's own
   * storage, and a file input never exposes an absolute path. So the host does
   * the listing and the browser navigates it.
   *
   * Read-only, and it can see anything the server's user can. That is a real
   * widening of what the browser learns about this filesystem, and it is the
   * cost of letting you pick any folder rather than a preconfigured one.
   */
  app.get<{ Querystring: { path?: string } }>('/api/browse', async (request, reply) => {
    const requested = request.query.path?.trim() || os.homedir();
    let dir: string;
    try {
      dir = await workspaces.canonicalDirectory(requested);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        const status = err.code === 'not_found' ? 404 : 403;
        return reply.code(status).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    const added = new Set(workspaces.getRoots());
    let entries;
    try {
      entries = await browseDirectory(dir);
    } catch {
      return reply
        .code(403)
        .send({ error: { code: 'forbidden', message: 'Directory is not readable.' } });
    }

    const parent = path.dirname(dir);
    return reply.send({
      path: dir,
      label: workspaces.labelFor(dir),
      parent: parent === dir ? null : parent,
      added: added.has(dir),
      entries: entries.map((e) => ({ ...e, added: added.has(e.path) })),
    });
  });

  app.get('/api/sessions', async () => ({ sessions: sessions.list() }));

  /** Conversations already on disk that can be resumed. */
  app.get('/api/conversations', async () => ({
    conversations: await conversations.list(),
  }));

  /**
   * A conversation's own messages and metadata, with no session involved.
   *
   * Opening a finished chat from the home screen used to resume it into a
   * live session immediately, before anyone had typed a word — a real agent
   * process for every idle tap. This is what that tap hits instead: the
   * transcript read straight off disk, the same way `/api/sessions/:id/history`
   * does for an already-resumed session, just keyed on the conversation
   * itself because there is no session yet to key off of. Creating one is
   * deferred to `POST /api/sessions` with `resumeAgentSessionId`, fired only
   * when a prompt is actually sent from this view.
   */
  app.get<{ Params: { id: string } }>('/api/conversations/:id/history', async (request, reply) => {
    const info = await conversations.find(request.params.id);
    if (!info) {
      return reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'No such conversation.' } });
    }
    const events = await conversations.historyForConversation(info);
    return reply.send({ conversation: info, events });
  });

  /** Existing tmux panes that could be adopted. Empty unless enabled. */
  app.get<{ Querystring: { all?: string } }>('/api/adoptable', async (request) => {
    const includeUnrestricted = request.query.all === '1' || request.query.all === 'true';
    const targets = await adoption.list(includeUnrestricted);
    return {
      enabled: adoption.isEnabled() || includeUnrestricted,
      targets,
    };
  });

  /**
   * The conversation a session was resumed from, as renderable events.
   *
   * Keyed on the session rather than the conversation so the *server* decides
   * which transcript is in play; the browser never names a file. A session that
   * is not a resume has no history to show — its events are being streamed
   * live, and replaying them from disk would double every message.
   */
  app.get<{ Params: { id: string } }>('/api/sessions/:id/history', async (request, reply) => {
    const resumedFrom = sessions.resumedConversationId(request.params.id);
    if (!resumedFrom) return reply.send({ events: [] });

    const events = await conversations.history(resumedFrom);
    if (events === null) {
      // The transcript is gone or outside a workspace root. Not fatal: the
      // session still works, it just opens without its backstory.
      return reply.send({ events: [] });
    }
    return reply.send({ conversationId: resumedFrom, events });
  });

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
      const target = await adoption.resolve(body.adoptTargetId, true);
      if (!target && !adoption.isEnabled()) {
        return reply.code(400).send({
          error: {
            code: 'adoption_disabled',
            message: 'Adopting existing tmux sessions is not enabled on this server.',
          },
        });
      }
      if (!target) {
        return reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'That pane is gone, or is no longer available for adoption.',
          },
        });
      }
      const attach = await adoption.attachCommand(target);
      adopt = {
        command: attach.command,
        args: attach.args,
        // Not `target.cols`/`rows` — see `attachCommand`'s doc comment on
        // `sizeToAttachAt` for why spawning at the window's own listed
        // (content-area) size makes it shrink by one row on every attach.
        cols: attach.clientCols,
        rows: attach.clientRows,
        label: `${target.command} · ${target.sessionName}`,
        // Persisted on the session row (not just used to resolve `target`
        // above) so a later attach to this same pane can be recognized as
        // the same chat — see `ProjectService`'s grouping.
        targetId: target.id,
        // Torn down once this session's process exits — see
        // `AdoptionService.attachCommand`'s doc comment and
        // `SessionManager`'s wiring of `adoption.cleanupView`.
        viewSession: attach.viewSession,
      };
      body.cwd = target.cwd;
    }

    let cwd: string | null;
    if (adopt) {
      try {
        cwd = await workspaces.canonicalDirectory(body.cwd);
      } catch {
        cwd = body.cwd;
      }
    } else {
      cwd = await resolveWorkspaceCwdOrReply(workspaces, body.cwd, reply);
      if (cwd === null) return reply;
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
        skipPermissions: body.skipPermissions,
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
