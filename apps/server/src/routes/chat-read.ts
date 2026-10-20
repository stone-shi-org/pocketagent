import type { FastifyPluginAsync } from 'fastify';
import { MarkChatReadRequest } from '@pocketagent/protocol';
import { markChatRead } from '../chats/read-marks.js';

/**
 * PA-165: `POST /api/chats/read` — "someone is looking at this chat now",
 * which clears its status dot's unread state on every device.
 *
 * Sent by a chat page while it is visible: on open, when the tab or window
 * comes back into view, and when a turn finishes while it is on screen. The
 * mark is stamped with the server's clock (see `read-marks.ts`). The target
 * must exist, so the table cannot be filled with ids nothing will ever sweep;
 * an unknown id is a 404 the page ignores.
 */
export const chatReadRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/chats/read', async (request, reply) => {
    const parsed = MarkChatReadRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' } });
    }
    const { kind, id } = parsed.data;
    const exists =
      kind === 'session' ? app.pocket.sessions.find(id) !== null : app.pocket.plannerChats.get(id) !== null;
    if (!exists) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such chat.' } });
    }
    markChatRead(app.pocket.db, kind, id);
    return reply.code(204).send();
  });
};
