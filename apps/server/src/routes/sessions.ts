import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateAdoptableSessionRequest,
  CreateSessionRequest,
  ProjectRequest,
  RemoveChatRequest,
  WorkspaceRequest,
  type AgentEvent,
  type ModelInfo,
} from '@pocketagent/protocol';
import os from 'node:os';
import path from 'node:path';
import { browseDirectory, discoverFolders } from '../discover/index.js';
import { SessionError } from '../sessions/manager.js';
import { WorkspaceError } from '../workspaces/index.js';
import { hideChat, readAgentDefaults } from '../db/index.js';
import { VIRTUAL_SHELL_CWD } from '../projects/index.js';
import { resolveWorkspaceCwdOrReply } from './shared.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, workspaces, agents, conversations, agyTranscripts, piTranscripts, adoption, projects, db } =
    app.pocket;

  // Merges in the per-agent "last observed live" cache (see `agent_defaults`
  // in db/index.ts) so a brand-new chat's composer can pre-select a model
  // and effort even though nothing about model choice is knowable before a
  // session exists to ask. Composed at the route rather than inside
  // `AgentRegistry.list()`, which has no `db` reference and stays that way —
  // this is the only consumer of a DB-backed fact about an otherwise static
  // registry.
  app.get('/api/agents', async () => ({
    agents: agents.list().map((agent) => {
      const cached = readAgentDefaults(db, agent.id);
      let cachedModels: ModelInfo[] = [];
      if (cached?.models_json) {
        try {
          cachedModels = JSON.parse(cached.models_json) as ModelInfo[];
        } catch {
          // A malformed cache row must never break the agent list.
        }
      }
      return {
        ...agent,
        defaultModel: cached?.model ?? null,
        defaultEffort: cached?.effort ?? null,
        cachedModels,
      };
    }),
  }));

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

  /**
   * Hiding a project is not deletion — but `ProjectService.list` excludes a
   * hidden directory unconditionally (no live-session exception, unlike a
   * removed workspace root, which at least leaves a running session visible
   * under its old cwd until it finishes). A chat with an open desktop tab
   * would drop out of every future `/api/projects` poll with no way back
   * short of un-hiding blind — see `DesktopShell`'s tab-title fallback,
   * which otherwise has nothing left to show but the session's raw id.
   * Refused the same way `SessionManager.forget` already refuses to remove a
   * single running chat: stop it first, or wait for it to finish.
   */
  app.post('/api/projects/hide', async (request, reply) => {
    const cwd = await resolveProjectCwd(request.body, reply);
    if (cwd === null) return reply;
    if (await hasLiveChatAt(cwd)) {
      return reply.code(409).send({
        error: {
          code: 'session_running',
          message: 'Stop the session running here before hiding this project.',
        },
      });
    }
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
   * Validate a directory from the browser for hide/unhide, which only ever
   * write a `project_visibility` row keyed by this string — unlike session
   * creation, nothing here touches the filesystem.
   *
   * The normal path is the same containment check session creation uses:
   * `resolveWorkspacePath` realpaths the directory so a client cannot point
   * at an arbitrary string. But a project's own directory can vanish out from
   * under it — deleting a git worktree removes the folder while its
   * transcripts (and therefore its card on the home screen) live on, and
   * `ProjectService.list` then shows it as an orphaned, no-longer-folded
   * top-level project rather than dropping it. `fs.realpath` throws `ENOENT`
   * for a directory in that state, which used to 404 before `setHidden` ever
   * ran — the button looked broken because the one directory you'd actually
   * want to hide is exactly the one that can no longer resolve. A `not_found`
   * here instead falls back to checking the cwd against the project list the
   * server itself just computed (containment-checked already, not
   * user-supplied), so hiding an orphaned row still works while an arbitrary
   * path a client invents is still rejected.
   */
  async function resolveProjectCwd(body: unknown, reply: FastifyReply): Promise<string | null> {
    const parsed = ProjectRequest.safeParse(body);
    if (!parsed.success) {
      void reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
      return null;
    }
    const cwd = parsed.data.cwd;
    try {
      return await workspaces.resolveWorkspacePath(cwd);
    } catch (err) {
      if (err instanceof WorkspaceError && err.code === 'not_found' && (await isKnownProjectCwd(cwd))) {
        return cwd;
      }
      if (err instanceof WorkspaceError) {
        const status = err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
        void reply.code(status).send({ error: { code: err.code, message: err.message } });
        return null;
      }
      throw err;
    }
  }

  /** Whether `cwd` is a project or folded worktree the home screen already shows (or would, with hidden ones included). */
  async function isKnownProjectCwd(cwd: string): Promise<boolean> {
    const known = await projects.list(sessions.list(), true);
    return known.some((p) => p.cwd === cwd || p.worktrees.some((w) => w.cwd === cwd));
  }

  /** Whether `cwd` (or a worktree folded under it) currently has a live chat. */
  async function hasLiveChatAt(cwd: string): Promise<boolean> {
    const known = await projects.list(sessions.list(), true);
    const match = known.find((p) => p.cwd === cwd) ?? known.flatMap((p) => p.worktrees).find((w) => w.cwd === cwd);
    return match?.chats.some((chat) => chat.live) ?? false;
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
   *
   * `create: true` in the body lets the folder not exist yet — the picker uses
   * this to offer "new folder" alongside picking an existing one, still as one
   * explicit, logged act rather than a silent mkdir.
   */
  app.post('/api/workspaces/add', async (request, reply) => {
    const parsed = WorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      const added = await workspaces.add(parsed.data.path, { create: parsed.data.create });
      app.log.warn(
        { path: added, created: !!parsed.data.create },
        'project folder added; sessions may now run here',
      );
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
   * Start a brand-new named tmux session on the adoption socket and hand back
   * the target for it, the same shape `GET /api/adoptable` returns for one
   * that already existed. The "Shell" dialog immediately follows this with
   * `POST /api/sessions` + `adoptTargetId` to attach — this endpoint only
   * creates, it never attaches, so the two failure modes (tmux rejected the
   * name vs. the attach itself failed) stay distinguishable to the caller.
   *
   * No `adoption.isEnabled()` gate: `GET /api/adoptable?all=1` (what the
   * Shell dialog always polls) already reads this same socket unconditionally
   * — see its own comment — so refusing to *create* there while happily
   * listing and attaching would be a gate with nothing behind it.
   */
  app.post('/api/adoptable', async (request, reply) => {
    const parsed = CreateAdoptableSessionRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }

    // A caller-supplied cwd (a project row's "New tmux session") is
    // validated the same way `POST /api/sessions` validates one; omitting it
    // (the Shell dialog's free-form create) keeps the old fallback.
    let cwd: string;
    if (parsed.data.cwd !== undefined) {
      const resolved = await resolveWorkspaceCwdOrReply(workspaces, parsed.data.cwd, reply);
      if (resolved === null) return reply;
      cwd = resolved;
    } else {
      cwd = workspaces.getRoots()[0] ?? process.cwd();
    }

    try {
      const target = await adoption.create(parsed.data.name, cwd);
      return reply.code(201).send(target);
    } catch (err) {
      return reply.code(409).send({
        error: {
          code: 'create_failed',
          message: err instanceof Error ? err.message : 'Could not create tmux session.',
        },
      });
    }
  });

  /**
   * The conversation behind a session, as renderable events.
   *
   * Keyed on the session rather than the conversation so the *server* decides
   * which transcript is in play; the browser never names a file. A *live*
   * session that is not itself a resume has no history to show here — its
   * events are being streamed live, and replaying them from disk would
   * double every message (see `resumedConversationId`'s doc comment). A
   * session no longer live has no such buffer to double: whatever its own
   * conversation was, this is the only place left to find it, which is what
   * lets reopening an old, already-finished chat show anything instead of
   * looking empty.
   *
   * Which store reads it back depends on the agent, since each keeps its own
   * transcript in a different place and shape: `ConversationStore` only ever
   * finds Claude's `~/.claude/projects/**.jsonl`; agy and pi each mirror
   * conversations locally too, agy under
   * `~/.gemini/antigravity-cli/brain/<id>/...` and pi under
   * `~/.pi/agent/sessions/<encoded-cwd>/...`, in formats `ConversationStore`
   * cannot parse (`AgyTranscriptStore`/`PiTranscriptStore` doc comments).
   * codex and opencode have no on-disk format worth reading directly (codex's
   * own rollout format is an internal, unstable implementation detail; see
   * `SessionManager.codexHistory`'s doc comment) — those two instead read
   * back through the same shared daemon process a live session would talk
   * to, lazily started if needed.
   */
  app.get<{ Params: { id: string } }>('/api/sessions/:id/history', async (request, reply) => {
    const resumedFrom = sessions.resumedConversationId(request.params.id);
    if (!resumedFrom) return reply.send({ events: [] });

    const info = sessions.find(request.params.id);
    const events = await historyForAgent(info?.agent, resumedFrom, info?.cwd);
    // The transcript is gone, unreadable, or (for `conversations`) outside a
    // workspace root. Not fatal either way: the session still works, it just
    // opens without its backstory.
    return reply.send({ conversationId: resumedFrom, events });
  });

  /** See the `/api/sessions/:id/history` route above for why the store differs per agent. */
  async function historyForAgent(
    agent: string | undefined,
    conversationId: string,
    cwd: string | undefined,
  ): Promise<AgentEvent[]> {
    switch (agent) {
      case 'agy':
        return agyTranscripts.history(conversationId);
      case 'pi':
        return cwd ? piTranscripts.history(conversationId, cwd) : [];
      case 'codex':
        return sessions.codexHistory(conversationId);
      case 'opencode':
        return sessions.opencodeHistory(conversationId);
      default:
        return (await conversations.history(conversationId)) ?? [];
    }
  }

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
        ...(body.model !== undefined ? { model: body.model } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
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
