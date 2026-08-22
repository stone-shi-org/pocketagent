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
}

export const websocketRoutes: FastifyPluginAsync = async (app) => {
  const { sessions, config } = app.pocket;

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

    const detachFrom = (sessionId: string): void => {
      const attachment = attachments.get(sessionId);
      if (!attachment) return;
      attachment.detach();
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
        session.on('output', onOutput);
        session.on('hint', onHint);
        unsubscribers.push(() => {
          session.off('output', onOutput);
          session.off('hint', onHint);
        });

        attached = {
          type: 'attached',
          session: sessions.toInfo(session),
          replay: forceTruncated ? { ...buffered, truncated: true } : buffered,
        };
      }

      attachments.set(sessionId, {
        session,
        peek,
        detach: () => {
          for (const off of unsubscribers) off();
        },
      });
      if (!peek) sessions.attach(sessionId);

      send(attached);

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

          if (session instanceof StructuredSession) {
            session.prompt(promptText, message.image);
          } else {
            session.prompt(promptText);
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
