import type { FastifyPluginAsync } from 'fastify';
import type { WebSocket } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  WsCloseCode,
  parseClientMessage,
  type AgentEvent,
  type ErrorCode,
  type ServerMessage,
  type SessionStatus,
  type TerminalHintKind,
} from '@pocketagent/protocol';
import { isOriginAllowed } from '../auth/index.js';
import type { ManagedSession, StructuredLikeSession } from '../sessions/manager.js';
import { StructuredSession } from '../sessions/structured-session.js';
import type { PtySession } from '../sessions/pty-session.js';
import { saveAttachmentToWorkspace } from '../sessions/attachments.js';

/**
 * Only some structured backends can switch model/effort live (today: the
 * Claude Agent SDK, codex, agy and pi for model; the same four minus agy for
 * effort — opencode has neither). `StructuredLikeSession` is a bare union
 * with no shared interface for either (see `manager.ts`), so this checks for
 * the method at runtime instead of growing an `instanceof` chain that would
 * need editing every time a backend gains the feature.
 */
function canSetModel(
  session: StructuredLikeSession,
): session is StructuredLikeSession & { setModel: (model: string) => Promise<void> } {
  return typeof (session as { setModel?: unknown }).setModel === 'function';
}
function canSetEffort(
  session: StructuredLikeSession,
): session is StructuredLikeSession & { setEffort: (effort: string | null) => Promise<void> } {
  return typeof (session as { setEffort?: unknown }).setEffort === 'function';
}

/**
 * Authoritative half of "adopted panes are not resized unless the user
 * explicitly opts in" — the browser is expected to already withhold `resize`/
 * `attach`-with-size for an adopted session it has not been told to take over
 * (see `TerminalPage.tsx`'s `knowsAdoptedRef`), but that is one client's
 * discipline, not a guarantee. tmux sizes a shared window to its most
 * recently active client, so a resize this server actually applies reaches
 * every other client of that pane too — including a real terminal on
 * someone's desktop, not just whoever asked. `force` is the wire-level
 * evidence that a human actually chose to do that (the "Fit to this screen
 * anyway" opt-in), not a client's own guess; a non-adopted session has
 * nothing to protect and is always allowed through unconditionally.
 */
function mayResize(session: PtySession, force: boolean): boolean {
  return session.spec.adopted !== true || force;
}

/**
 * Close codes. 4000+ is the application-defined range. Shared with the client
 * via `WsCloseCode` in the protocol package — see that export's doc comment
 * for why this must not be a private, server-only enum.
 */
const CLOSE_PROTOCOL_MISMATCH = WsCloseCode.PROTOCOL_MISMATCH;
const CLOSE_UNAUTHORIZED = WsCloseCode.UNAUTHORIZED;
const CLOSE_FLOOD = WsCloseCode.FLOOD;
const CLOSE_BACKPRESSURE = WsCloseCode.BACKPRESSURE;

/**
 * If a client stops reading (phone asleep, tunnel wedged) the kernel buffer
 * grows without bound. Past this point we drop the socket; the client will
 * reconnect and replay, which is cheaper than holding the data forever.
 */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Crude flood guard: a human cannot type 300 messages a second. */
const MAX_MESSAGES_PER_SECOND = 300;

const HEARTBEAT_MS = 30_000;

interface Attachment {
  session: ManagedSession;
  detach: () => void;
  /** See `attachTo`'s `peek` parameter. */
  peek: boolean;
  /** Unregisters this attachment from `attachmentsBySession` below. */
  unregisterForgotten: () => void;
}

export const websocketRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, config, promptQueue } = app.pocket;

  /**
   * Every live attachment, across every connection, indexed by session id —
   * unlike a connection's own `attachments` map (keyed by session id but
   * scoped to that one socket), this is process-wide and lets `forget()`'s
   * and `terminate()`'s notifications below reach a tab that is attached but
   * idle, in a *different* connection than the one that closed the session
   * (PA-40). The callback takes the error to send rather than being
   * forget-specific, since `terminate()` needs the same fan-out with a
   * different, milder code (see `onTerminated` below) — one registry, two
   * possible reasons a session stops being worth staying attached to.
   */
  const attachmentsBySession = new Map<string, Set<(code: ErrorCode, message: string) => void>>();

  const registerAttachment = (
    sessionId: string,
    onClosedElsewhere: (code: ErrorCode, message: string) => void,
  ): (() => void) => {
    let set = attachmentsBySession.get(sessionId);
    if (!set) {
      set = new Set();
      attachmentsBySession.set(sessionId, set);
    }
    set.add(onClosedElsewhere);
    return () => {
      set!.delete(onClosedElsewhere);
      if (set!.size === 0) attachmentsBySession.delete(sessionId);
    };
  };

  // Subscribed once, at plugin setup, not per connection — see
  // `SessionManager.onForgotten`'s own doc comment for why.
  sessions.onForgotten((sessionId) => {
    const set = attachmentsBySession.get(sessionId);
    if (!set) return;
    for (const onClosedElsewhere of [...set]) {
      onClosedElsewhere('not_found', 'Session is no longer available on this server.');
    }
  });

  // Same fan-out, for an explicit `terminate()` rather than a `forget()` —
  // see `SessionManager.onTerminated`'s own doc comment for why this is a
  // different code than the one above. Sent to *every* attachment, including
  // one on the same tab that requested the stop; that tab's own page already
  // knows it asked for this and ignores the redundant push (see
  // `AgentPage`/`TerminalPage`'s `stoppedHereRef`) rather than the server
  // trying to guess which connection issued the `DELETE` — there is no
  // reliable way to correlate an HTTP request with a WS connection here, and
  // guessing wrong would either leave a stale tab open or close the wrong one.
  sessions.onTerminated((sessionId) => {
    const set = attachmentsBySession.get(sessionId);
    if (!set) return;
    for (const onClosedElsewhere of [...set]) {
      onClosedElsewhere('terminated', 'This session was stopped from elsewhere.');
    }
  });

  app.get('/api/ws', { websocket: true }, (socket, request) => {
    const ws = socket as unknown as WebSocket;

    if (!isOriginAllowed(request.headers.origin, config.allowedOrigins, request.headers.host)) {
      ws.close(CLOSE_UNAUTHORIZED, 'origin not allowed');
      return;
    }

    const requestedVersion = Number(
      (request.query as Record<string, string | undefined>)?.v ?? PROTOCOL_VERSION,
    );
    if (requestedVersion !== PROTOCOL_VERSION) {
      ws.close(CLOSE_PROTOCOL_MISMATCH, `server speaks protocol v${PROTOCOL_VERSION}`);
      return;
    }

    const attachments = new Map<string, Attachment>();
    let alive = true;
    let messageCount = 0;
    let windowStart = Date.now();

    const send = (message: ServerMessage): void => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        request.log.warn({ buffered: ws.bufferedAmount }, 'ws backpressure, closing');
        ws.close(CLOSE_BACKPRESSURE, 'backpressure');
        return;
      }
      ws.send(JSON.stringify(message));
    };

    const sendError = (code: ErrorCode, message: string, sessionId?: string): void => {
      send({ type: 'error', code, message, ...(sessionId ? { sessionId } : {}) });
    };

    // PA-11: tell this client when one of its prompts is parked on a busy
    // working tree, and again when it is finally sent or cancelled. Filtered to
    // sessions this socket is attached to, so an unrelated chat's queue does not
    // arrive here — and unsubscribed on close alongside every other listener.
    const unsubscribeQueue = promptQueue.subscribe({
      onQueued: (sessionId, promptId, position, treeRoot) => {
        if (!attachments.has(sessionId)) return;
        send({ type: 'prompt_queued', sessionId, promptId, position, treeRoot });
      },
      onReleased: (sessionId, promptId, reason) => {
        if (!attachments.has(sessionId)) return;
        send({ type: 'prompt_released', sessionId, promptId, reason });
      },
    });

    const detachFrom = (sessionId: string): void => {
      const attachment = attachments.get(sessionId);
      if (!attachment) return;
      attachment.detach();
      attachment.unregisterForgotten();
      attachments.delete(sessionId);
      // Peek attaches never incremented the count in the first place — see
      // `attachTo`'s `peek` parameter.
      if (!attachment.peek) sessions.detach(sessionId);
    };

    /**
     * `peek` is for a background "just watching" attach (a fleet-overview
     * card, say): it still gets full replay and live frames, but must not
     * count as a real viewer. Without this, `SessionInfo.attachedClients` —
     * already shown to a user as "N viewer(s)" on an adopted pane — would
     * read as inflated by clients nobody watching the session would call
     * "attached".
     */
    const attachTo = (sessionId: string, afterSeq: number, epoch?: string, peek = false): void => {
      const session = sessions.get(sessionId);
      if (!session) {
        // A session the database remembers but this process does not: it ran
        // under a previous server. That is an ordinary end-of-life, not a
        // missing id, and saying "not found" about a session the user can see
        // in their list reads as a bug. Its output is gone — buffers are in
        // memory only — so there is nothing to attach to either way.
        const persisted = sessions.find(sessionId);
        if (persisted) {
          send({ type: 'status', sessionId, status: persisted.status, session: persisted });
          sendError(
            'session_ended',
            'This session ended when the server restarted. Its output was not kept.',
            sessionId,
          );
          return;
        }
        sendError('not_found', 'Session is no longer available on this server.', sessionId);
        return;
      }

      // Re-attaching over an existing attachment is normal after a flaky
      // reconnect where the server has not yet noticed the old socket died.
      detachFrom(sessionId);

      const onStatus = (status: SessionStatus): void =>
        send({ type: 'status', sessionId, status, session: sessions.toInfo(session) });
      const onExit = (exitCode: number | null, exitSignal: number | null): void =>
        send({ type: 'exit', sessionId, exitCode, exitSignal });

      // A resume is only valid within the epoch its sequence number came from.
      // After a restart-and-recover the stream is new, so an old `afterSeq`
      // must not be honoured: replay everything and tell the client to clear,
      // otherwise it would splice new output onto a stale screen.
      const epochMatches = epoch === undefined || epoch === session.epoch;
      const resumeFrom = epochMatches ? afterSeq : 0;
      const forceTruncated = !epochMatches && afterSeq > 0;

      const unsubscribers: (() => void)[] = [];
      session.on('status', onStatus);
      session.on('exit', onExit);
      unsubscribers.push(() => {
        session.off('status', onStatus);
        session.off('exit', onExit);
      });

      // Snapshot the buffer, then subscribe. Doing it in this order can duplicate
      // an item that lands in between; the client de-duplicates on `seq`.
      let attached: Extract<ServerMessage, { type: 'attached' }>;

      if (session.transport === 'structured') {
        const buffered = session.buffer.replayAfter(resumeFrom);
        const onEvent = (seq: number, event: AgentEvent): void =>
          send({ type: 'agent_event', sessionId, seq, event });
        session.on('event', onEvent);
        unsubscribers.push(() => session.off('event', onEvent));

        attached = {
          type: 'attached',
          session: sessions.toInfo(session),
          // Structured sessions carry no terminal bytes.
          replay: { data: '', fromSeq: 0, toSeq: 0, truncated: false },
          agentReplay: forceTruncated ? { ...buffered, truncated: true } : buffered,
          // Re-surface approvals still waiting, so a phone that reconnects mid
          // prompt is not staring at a session that looks stuck.
          pendingPermissions: session.pendingPermissions(),
        };
      } else {
        const buffered = session.buffer.replayAfter(resumeFrom);
        const onOutput = (seq: number, data: string): void =>
          send({ type: 'output', sessionId, seq, data });
        const onHint = (hints: TerminalHintKind[]): void =>
          send({ type: 'hint', sessionId, hints });
        // A resize this client did not ask for — see `ResizedMessage`. Sent
        // unconditionally rather than only for adopted sessions: the client
        // already has to decide whether to act on it (a session that fits the
        // viewport must keep fitting it), and gating here would just be a
        // second, drift-prone copy of that rule.
        const onResized = (cols: number, rows: number): void =>
          send({ type: 'resized', sessionId, cols, rows });
        session.on('output', onOutput);
        session.on('hint', onHint);
        session.on('resized', onResized);
        unsubscribers.push(() => {
          session.off('output', onOutput);
          session.off('hint', onHint);
          session.off('resized', onResized);
        });

        attached = {
          type: 'attached',
          session: sessions.toInfo(session),
          replay: forceTruncated ? { ...buffered, truncated: true } : buffered,
        };
      }

      // If this session is closed elsewhere while this attachment is still
      // live and idle — its record forgotten ("Remove chat" tapped from a
      // different tab/view) or the session explicitly stopped (a fleet
      // card's X, another tab's own Stop button, ...) — tell this connection
      // the same way a fresh `attach` to an already-closed session would,
      // then force it to detach (PA-40).
      const unregisterForgotten = registerAttachment(sessionId, (code, message) => {
        sendError(code, message, sessionId);
        detachFrom(sessionId);
      });

      attachments.set(sessionId, {
        session,
        peek,
        detach: () => {
          for (const off of unsubscribers) off();
        },
        unregisterForgotten,
      });
      if (!peek) sessions.attach(sessionId);

      send(attached);

      // Re-surface prompts of this session still parked on a busy working tree,
      // for the same reason `pendingPermissions` is replayed above: a phone that
      // reconnects must not be left looking at a message that seems to have
      // vanished.
      for (const parked of promptQueue.forSession(sessionId)) {
        send({
          type: 'prompt_queued',
          sessionId,
          promptId: parked.promptId,
          position: parked.position,
          treeRoot: parked.treeRoot,
        });
      }

      if (!session.isAlive()) {
        send({
          type: 'exit',
          sessionId,
          exitCode: session.exitCode,
          exitSignal: session.exitSignal,
        });
      }
    };

    const requireAttached = (sessionId: string): ManagedSession | null => {
      const attachment = attachments.get(sessionId);
      if (!attachment) {
        sendError('not_attached', 'Attach to the session before sending to it.', sessionId);
        return null;
      }
      return attachment.session;
    };

    /** Narrow to a live structured session, reporting the mismatch otherwise. */
    const requireStructured = (sessionId: string): StructuredLikeSession | null => {
      const session = requireAttached(sessionId);
      if (!session) return null;
      if (session.transport !== 'structured') {
        sendError('bad_message', 'This session is a terminal, not a structured agent.', sessionId);
        return null;
      }
      if (!session.isAlive()) {
        sendError('session_not_running', 'Session is not running.', sessionId);
        return null;
      }
      return session;
    };

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // Rate window
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        messageCount = 0;
      }
      if (++messageCount > MAX_MESSAGES_PER_SECOND) {
        sendError('rate_limited', 'Too many messages.');
        ws.close(CLOSE_FLOOD, 'message flood');
        return;
      }

      if (isBinary) {
        sendError('bad_message', 'Binary frames are not supported.');
        return;
      }

      const text = raw.toString();
      if (Buffer.byteLength(text) > LIMITS.maxMessageBytes) {
        sendError('too_large', 'Message exceeds the size limit.');
        return;
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        sendError('bad_message', 'Message is not valid JSON.');
        return;
      }

      const message = parseClientMessage(json);
      if (!message) {
        // Unknown types and malformed payloads are rejected identically; we
        // never act on a frame we could not fully validate.
        sendError('bad_message', 'Message failed schema validation.');
        return;
      }

      switch (message.type) {
        case 'ping':
          send({ type: 'pong' });
          break;

        case 'attach': {
          attachTo(message.sessionId, message.afterSeq ?? 0, message.epoch, message.peek === true);
          const attached = attachments.get(message.sessionId);
          if (
            attached?.session.transport === 'terminal' &&
            message.cols &&
            message.rows &&
            mayResize(attached.session, message.force === true)
          ) {
            attached.session.resize(message.cols, message.rows);
          }
          break;
        }

        case 'detach':
          detachFrom(message.sessionId);
          break;

        case 'input': {
          const session = requireAttached(message.sessionId);
          if (!session) break;
          if (session.transport !== 'terminal') {
            sendError('bad_message', 'Structured sessions take prompts, not keystrokes.', message.sessionId);
            break;
          }
          if (!session.isAlive()) {
            sendError('session_not_running', 'Session is not running.', message.sessionId);
            break;
          }
          session.write(message.data);
          break;
        }

        case 'resize': {
          const session = requireAttached(message.sessionId);
          if (!session) break;
          // A structured session has no grid to resize; ignore rather than error
          // so a client that resizes indiscriminately is not punished.
          if (session.transport !== 'terminal') break;
          const terminal = session;
          if (!mayResize(terminal, message.force === true)) break;
          if (terminal.resize(message.cols, message.rows)) {
            app.pocket.sessions.persist(terminal);
          }
          break;
        }

        case 'signal': {
          const session = requireAttached(message.sessionId);
          if (!session) break;
          if (!session.isAlive()) {
            sendError('session_not_running', 'Session is not running.', message.sessionId);
            break;
          }
          if (session.transport !== 'terminal') {
            // The structured equivalent of Ctrl+C is an explicit interrupt.
            void session.interrupt();
            break;
          }
          session.signal(message.signal);
          break;
        }

        case 'prompt': {
          const session = requireStructured(message.sessionId);
          if (!session) break;
          if (message.text.length === 0 && !message.image) {
            sendError('bad_message', 'A prompt needs text, an image, or both.', message.sessionId);
            break;
          }

          let promptText = message.text;
          if (message.image) {
            try {
              const relPath = saveAttachmentToWorkspace(session.spec.cwd, message.image);
              const fileNote = `[Attached image saved to: ${relPath}]`;
              promptText = promptText ? `${promptText}\n\n${fileNote}` : fileNote;
            } catch (err) {
              app.log.warn({ err }, 'failed to save attachment to workspace');
            }
          }

          // The directory gate for a human's own message. Only ever *defers* it
          // — the prompt is persisted, the client is told, and it goes in as
          // soon as whoever is working in the same tree concludes. An attached
          // image has already been written into the workspace and named in
          // `promptText` above, which is why deferring does not lose it.
          const parked = promptQueue.submit(session, promptText);
          if (parked.queued) break;

          if (session instanceof StructuredSession) {
            session.prompt(promptText, message.image);
          } else {
            session.prompt(promptText);
          }
          break;
        }

        case 'queued_prompt': {
          // No `requireStructured` here: cancelling a message that is waiting
          // must keep working even if the session has since died, or the row
          // and its tree claim would be unreachable.
          if (!promptQueue.resolve(message.promptId, message.action)) {
            sendError(
              'not_found',
              'That queued message is no longer waiting.',
              message.sessionId,
            );
          }
          break;
        }

        case 'permission': {
          const session = requireStructured(message.sessionId);
          if (!session) break;
          const ok = session.resolvePermission(
            message.requestId,
            message.decision,
            message.message,
            message.answer,
          );
          if (!ok) {
            // Two phones can race to answer the same approval; the loser gets a
            // clear message rather than silence.
            sendError('not_found', 'That approval is no longer pending.', message.sessionId);
          }
          break;
        }

        case 'interrupt': {
          const session = requireStructured(message.sessionId);
          if (!session) break;
          void session.interrupt();
          break;
        }

        case 'model': {
          const session = requireStructured(message.sessionId);
          if (!session) break;
          if (!canSetModel(session)) {
            sendError('bad_message', 'This agent does not support switching models.', message.sessionId);
            break;
          }
          void session.setModel(message.model);
          break;
        }

        case 'effort': {
          const session = requireStructured(message.sessionId);
          if (!session) break;
          if (!canSetEffort(session)) {
            sendError('bad_message', 'This agent does not support switching effort.', message.sessionId);
            break;
          }
          void session.setEffort(message.effort);
          break;
        }
      }
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* socket already closing */
      }
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    ws.on('pong', () => {
      alive = true;
    });

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribeQueue();
      // Detach only. The PTY keeps running: that is the whole point.
      for (const sessionId of [...attachments.keys()]) detachFrom(sessionId);
    };

    ws.on('close', cleanup);
    ws.on('error', (err) => {
      request.log.debug({ err }, 'websocket error');
      cleanup();
    });
  });
};
