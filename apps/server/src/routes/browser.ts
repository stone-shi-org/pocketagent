import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  BROWSER_CLOSE_FORBIDDEN,
  BROWSER_CLOSE_NOT_FOUND,
  BROWSER_CLOSE_PROTOCOL,
  BROWSER_CLOSE_UNAVAILABLE,
  BROWSER_ID_PATTERN,
  BROWSER_PROTOCOL_VERSION,
  BrowserClientMessage,
  ResolveBrowserHelpRequest,
  type BrowserScopeResponse,
  type BrowserSuggestResponse,
  type BrowserServerMessage,
} from '@pocketagent/protocol';
import { isOriginAllowed } from '../auth/index.js';
import { BrowserError } from '../browser/service.js';
import { ViewerSession } from '../browser/viewer-session.js';
import { PlannerChatError } from '../planner/chats.js';

/**
 * PA-178: the live browser view.
 *
 * Who may use it is the whole security story. The viewer streams a logged-in
 * browser and carries keystrokes — passwords included — so it is open to a
 * cookie session (a person) or a hub credential (the operator's own Hub,
 * proxying that person) and to nothing else. `app.ts`'s gate already refuses
 * a `pam_` MCP token off `/mcp`; what it lets through that this route must
 * refuse itself is an MCP tool's in-process call (`request.mcpPrincipal` set
 * by the internal-API nonce). No MCP tool reaches any of this, and the
 * catalogs are grepped to keep it so.
 *
 * Frames and input are terminal I/O: nothing here logs a frame, a key, typed
 * text or a URL. Open and close are logged with the browser id and the kind
 * of principal only.
 */

function principalKind(request: FastifyRequest): 'session' | 'hub' {
  return request.hubPrincipal ? 'hub' : 'session';
}

/** An MCP principal — including an in-process tool call — never reaches a browser. */
function refuseMcp(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.mcpPrincipal === undefined) return false;
  void reply.code(403).send({
    error: { code: 'forbidden', message: 'The live browser view is for a person, not an MCP client.' },
  });
  return true;
}

function sendBrowserError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BrowserError) {
    const status =
      err.code === 'not_found' ? 404 : err.code === 'invalid' ? 400 : err.code === 'running' ? 409 : err.code === 'unavailable' ? 503 : 502;
    return reply.code(status).send({ error: { code: `browser_${err.code}`, message: err.message } });
  }
  throw err;
}

const MAX_MESSAGES_PER_SECOND = 400;

export const browserRoutes: FastifyPluginAsync = async (app) => {
  const { browsers, plannerChats, sessions, config } = app.pocket;

  /** Live viewers per browser id, to tell them when a handoff appears or is answered. */
  const viewersByBrowser = new Map<string, Set<(message: BrowserServerMessage) => void>>();
  const broadcastHelp = (browserId: string): void => {
    const set = viewersByBrowser.get(browserId);
    if (!set) return;
    const pending = plannerChats.pendingBrowserHelp(browserId).map(({ helpId, chatId, chatTitle, reason }) => ({
      helpId,
      chatId,
      chatTitle,
      reason,
    }));
    for (const send of set) send({ type: 'help', pending });
  };
  const unobserve = plannerChats.observeAll((_chatId, event) => {
    if (event.kind === 'browser_help_request') broadcastHelp(event.browserId);
    else if (event.kind === 'browser_help_resolved') for (const id of viewersByBrowser.keys()) broadcastHelp(id);
  });
  app.addHook('onClose', async () => unobserve());

  app.get('/api/browsers', async (request, reply) => {
    if (refuseMcp(request, reply)) return reply;
    return browsers.list();
  });

  /** Which browser a coding session or a Pocket Agent chat would use. */
  app.get('/api/browsers/scope', async (request, reply): Promise<BrowserScopeResponse | FastifyReply> => {
    if (refuseMcp(request, reply)) return reply;
    const q = request.query as { sessionId?: string; plannerChatId?: string };
    let id: string | null = null;
    if (typeof q.sessionId === 'string') {
      const info = sessions.find(q.sessionId);
      id = info ? browsers.scopeForCwd(info.cwd) : null;
    } else if (typeof q.plannerChatId === 'string') {
      id = browsers.scopeForPlannerWorkspace(plannerChats.get(q.plannerChatId)?.workspaceId ?? null);
    }
    if (!browsers.available().available || id === null) return { browser: null };
    return { browser: browsers.info(id) };
  });

  /** The address bar's suggestions, from this browser's own history. Never logged: a URL can carry a token. */
  app.get('/api/browsers/:id/suggest', async (request, reply): Promise<BrowserSuggestResponse | FastifyReply> => {
    if (refuseMcp(request, reply)) return reply;
    const { id } = request.params as { id: string };
    const q = (request.query as { q?: unknown }).q;
    try {
      return { suggestions: browsers.suggest(id, typeof q === 'string' ? q : '') };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  app.post('/api/browsers/:id/start', async (request, reply) => {
    if (refuseMcp(request, reply)) return reply;
    const { id } = request.params as { id: string };
    try {
      await browsers.ensure(id);
      return browsers.info(id);
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  app.post('/api/browsers/:id/stop', async (request, reply) => {
    if (refuseMcp(request, reply)) return reply;
    const { id } = request.params as { id: string };
    if (!BROWSER_ID_PATTERN.test(id)) return reply.code(400).send({ error: { code: 'invalid', message: 'Invalid browser id.' } });
    if (browsers.pendingHelpCount(id) > 0) {
      return reply
        .code(409)
        .send({ error: { code: 'browser_help_pending', message: 'An agent is waiting for help in this browser. Answer it first.' } });
    }
    await browsers.stop(id, 'stopped by a person');
    request.log.info({ browserId: id, principal: principalKind(request) }, 'shared browser stopped by request');
    return browsers.info(id) ?? { ok: true };
  });

  /** Delete the profile — every login in it. Confirmed in the UI first. */
  app.post('/api/browsers/:id/clear-data', async (request, reply) => {
    if (refuseMcp(request, reply)) return reply;
    const { id } = request.params as { id: string };
    try {
      await browsers.clearData(id);
      request.log.info({ browserId: id, principal: principalKind(request) }, 'shared browser data cleared by request');
      return browsers.info(id) ?? { ok: true };
    } catch (err) {
      return sendBrowserError(reply, err);
    }
  });

  /**
   * Done / Cancel from the viewer. The resumed turn is driven here, in the
   * background — the person may close the viewer the moment they press it,
   * and the turn must carry on regardless.
   */
  app.post('/api/browsers/:id/help/:helpId', async (request, reply) => {
    if (refuseMcp(request, reply)) return reply;
    const { helpId } = request.params as { id: string; helpId: string };
    const parsed = ResolveBrowserHelpRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'invalid', message: 'outcome must be done or cancel.' } });
    const chatId = plannerChats.browserHelpChatId(helpId);
    if (!chatId) return reply.code(404).send({ error: { code: 'not_found', message: 'That request was already answered.' } });
    const generator = plannerChats.resolveBrowserHelp(chatId, helpId, parsed.data.outcome);
    try {
      await generator.next();
    } catch (err) {
      if (err instanceof PlannerChatError) {
        return reply.code(404).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
    void (async () => {
      for await (const _event of generator) {
        // drained: the chat's own observers and transcript carry the events
      }
    })().catch((err) => request.log.warn({ err, chatId }, 'resumed browser-help turn failed'));
    return reply.code(202).send({ ok: true, chatId });
  });

  app.get('/api/browser/:id/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;
    const { id } = request.params as { id: string };

    if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
      ws.close(BROWSER_CLOSE_FORBIDDEN, 'origin not allowed');
      return;
    }
    if (request.mcpPrincipal !== undefined) {
      ws.close(BROWSER_CLOSE_FORBIDDEN, 'not for MCP clients');
      return;
    }
    const version = Number((request.query as Record<string, string | undefined>)?.v ?? BROWSER_PROTOCOL_VERSION);
    if (version !== BROWSER_PROTOCOL_VERSION) {
      ws.close(BROWSER_CLOSE_PROTOCOL, `browser viewer protocol ${BROWSER_PROTOCOL_VERSION} required; reload the page`);
      return;
    }
    if (!browsers.describe(id)) {
      ws.close(BROWSER_CLOSE_NOT_FOUND, 'no such browser');
      return;
    }

    const send = (message: BrowserServerMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message));
    };
    let viewer: ViewerSession | null = null;
    let closed = false;
    const queue: BrowserClientMessage[] = [];
    let windowStart = Date.now();
    let messageCount = 0;
    request.log.info({ browserId: id, principal: principalKind(request) }, 'browser viewer opened');

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      viewer?.dispose();
      viewersByBrowser.get(id)?.delete(send);
      if (viewersByBrowser.get(id)?.size === 0) viewersByBrowser.delete(id);
      request.log.info({ browserId: id }, 'browser viewer closed');
    };
    ws.on('close', cleanup);

    // Messages are handled strictly in order — a key-up must never overtake its key-down.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        messageCount = 0;
      }
      if (++messageCount > MAX_MESSAGES_PER_SECOND) return;
      let parsed: ReturnType<typeof BrowserClientMessage.safeParse>;
      try {
        parsed = BrowserClientMessage.safeParse(JSON.parse(raw.toString()));
      } catch {
        send({ type: 'error', message: 'Malformed message.' });
        return;
      }
      if (!parsed.success) {
        send({ type: 'error', message: parsed.error.issues[0]?.message ?? 'Invalid message.' });
        return;
      }
      const message = parsed.data;
      if (!viewer) {
        queue.push(message);
        return;
      }
      const v = viewer;
      chain = chain.then(() =>
        v.handle(message).catch((err: Error) => send({ type: 'error', message: err.message })),
      );
    });

    void (async () => {
      let instance;
      try {
        instance = await browsers.ensure(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'The browser could not start.';
        send({ type: 'error', message });
        ws.close(BROWSER_CLOSE_UNAVAILABLE, 'browser unavailable');
        return;
      }
      if (closed) return;
      viewer = new ViewerSession({
        service: browsers,
        instance,
        send,
        bufferedAmount: () => ws.bufferedAmount,
        onClosed: (reason) => ws.close(1000, reason.slice(0, 100)),
      });
      let set = viewersByBrowser.get(id);
      if (!set) viewersByBrowser.set(id, (set = new Set()));
      set.add(send);
      const info = browsers.info(id);
      if (info) send({ type: 'hello', version: BROWSER_PROTOCOL_VERSION, browser: info, sandbox: browsers.sandboxAvailable() });
      broadcastHelp(id);
      const v = viewer;
      chain = chain.then(async () => {
        try {
          await v.start();
        } catch (err) {
          send({ type: 'error', message: (err as Error).message });
        }
        for (const message of queue.splice(0)) {
          await v.handle(message).catch((err: Error) => send({ type: 'error', message: err.message }));
        }
      });
    })();
  });
};
