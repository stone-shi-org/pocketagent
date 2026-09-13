import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateTelegramBotRequest,
  CreateTelegramLinkRequest,
  UpdateTelegramBotRequest,
  UpdateTelegramLinkRequest,
  type TelegramBotListResponse,
  type TelegramBotTestResult,
  type TelegramLinkListResponse,
} from '@pocketagent/protocol';
import { TelegramBotError } from '../telegram/bots-store.js';
import { TelegramLinkError } from '../telegram/links-store.js';
import { TelegramClient, TelegramApiError } from '../telegram/client.js';

/**
 * PA-53: CRUD for Telegram bots and their pairings.
 *
 * Follows `routes/custom-claude-providers.ts`'s exact shape for the bot half
 * (a secret-backed row with no reveal endpoint), and nests pairings under
 * their owning bot the way `routes/mcp-registries.ts` nests nothing — a
 * pairing has no independent existence outside a bot, so
 * `/api/telegram/bots/:botId/links` rather than a flat `/api/telegram/links`.
 */
export const telegramRoutes: FastifyPluginAsync = async (app) => {
  const { telegramBots: bots, telegramLinks: links, telegramFetch } = app.pocket;

  const mapBotError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof TelegramBotError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };
  const mapLinkError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof TelegramLinkError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };

  // ---- bots -----------------------------------------------------------------

  app.get('/api/telegram/bots', async () => {
    const body: TelegramBotListResponse = { bots: bots.list(), encryptionAvailable: bots.encryptionAvailable };
    return body;
  });

  app.post('/api/telegram/bots', async (request, reply) => {
    const parsed = CreateTelegramBotRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.code(201).send(bots.create(parsed.data));
    } catch (err) {
      return mapBotError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/telegram/bots/:id', async (request, reply) => {
    const parsed = UpdateTelegramBotRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.send(bots.update(request.params.id, parsed.data));
    } catch (err) {
      return mapBotError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/telegram/bots/:id', async (request, reply) => {
    if (!bots.remove(request.params.id)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such Telegram bot.' } });
    }
    return reply.code(204).send();
  });

  /**
   * Calls the Bot API's `getMe` with the token already stored for this bot —
   * confirms a saved token still works (e.g. after a rotation) and refreshes
   * the resolved `@username`. Never carries a token in the request body: an
   * already-created bot's token can only be re-entered wholesale via
   * `PATCH`, per the "no reveal endpoint" rule.
   */
  app.post<{ Params: { id: string } }>('/api/telegram/bots/:id/test', async (request, reply) => {
    let token: string | null;
    try {
      token = bots.revealToken(request.params.id);
    } catch (err) {
      return mapBotError(reply, err);
    }
    if (token === null) {
      const body: TelegramBotTestResult = {
        ok: false,
        message: 'This bot\'s token could not be decrypted. Re-enter it and save before testing.',
        username: null,
      };
      return reply.send(body);
    }
    const result = await testToken(token, telegramFetch);
    if (result.ok && result.username) bots.setUsername(request.params.id, result.username);
    return reply.send(result);
  });

  /**
   * The create-form equivalent: tests a token that has not been saved yet, so
   * an operator finds out it is wrong before it is persisted. Nothing is
   * written here — a bot is only ever encrypted at rest by `create`/`update`.
   */
  app.post('/api/telegram/bots/test-token', async (request, reply) => {
    const body = request.body as { botToken?: unknown };
    const token = typeof body?.botToken === 'string' ? body.botToken.trim() : '';
    if (!token) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'botToken is required.' } });
    }
    return reply.send(await testToken(token, telegramFetch));
  });

  // ---- pairings ---------------------------------------------------------------

  app.get<{ Params: { botId: string } }>('/api/telegram/bots/:botId/links', async (request) => {
    const body: TelegramLinkListResponse = { links: links.listForBot(request.params.botId) };
    return body;
  });

  app.post<{ Params: { botId: string } }>('/api/telegram/bots/:botId/links', async (request, reply) => {
    const parsed = CreateTelegramLinkRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.code(201).send(links.create(request.params.botId, parsed.data));
    } catch (err) {
      return mapLinkError(reply, err);
    }
  });

  app.patch<{ Params: { botId: string; chatId: string } }>(
    '/api/telegram/bots/:botId/links/:chatId',
    async (request, reply) => {
      const parsed = UpdateTelegramLinkRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
        });
      }
      try {
        return reply.send(links.update(request.params.botId, request.params.chatId, parsed.data));
      } catch (err) {
        return mapLinkError(reply, err);
      }
    },
  );

  app.delete<{ Params: { botId: string; chatId: string } }>(
    '/api/telegram/bots/:botId/links/:chatId',
    async (request, reply) => {
      if (!links.remove(request.params.botId, request.params.chatId)) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'No such pairing.' } });
      }
      return reply.code(204).send();
    },
  );
};

async function testToken(token: string, fetchImpl?: typeof fetch): Promise<TelegramBotTestResult> {
  try {
    const client = new TelegramClient({ token, ...(fetchImpl ? { fetchImpl } : {}) });
    const me = await client.getMe();
    return { ok: true, message: `Connected as @${me.username ?? me.id}.`, username: me.username };
  } catch (err) {
    const message = err instanceof TelegramApiError ? err.message : (err as Error).message;
    return { ok: false, message, username: null };
  }
}
