import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateCustomClaudeProviderRequest,
  UpdateCustomClaudeProviderRequest,
  type CustomClaudeProviderListResponse,
} from '@pocketagent/protocol';
import { CustomClaudeProviderError } from '../agents/custom-providers-store.js';

/**
 * PA-28: CRUD for user-managed Claude Code provider variants.
 *
 * Every mutation goes through `CustomClaudeProviderStore`, which writes the row
 * *and* re-registers the adapter in `AgentRegistry` before this handler
 * responds — so the next `GET /api/agents` already sees the change and the
 * composer, the "Continue as…" picker and the cron/webhook agent selectors all
 * pick it up with no code of their own.
 *
 * **No response on any of these routes carries the API key**, in plaintext or
 * ciphertext, and there is deliberately no reveal endpoint: unlike a webhook's
 * HMAC secret, which the sender must also hold, nothing outside this server
 * ever needs to read this key back. Editing re-enters it, or leaves the field
 * blank to keep what is stored.
 */
export const customClaudeProviderRoutes: FastifyPluginAsync = async (app) => {
  const { customClaudeProviders: store } = app.pocket;

  const mapError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof CustomClaudeProviderError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };

  app.get('/api/custom-claude-providers', async () => {
    const body: CustomClaudeProviderListResponse = {
      providers: store.list(),
      encryptionAvailable: store.encryptionAvailable,
    };
    return body;
  });

  app.post('/api/custom-claude-providers', async (request, reply) => {
    const parsed = CreateCustomClaudeProviderRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.code(201).send(store.create(parsed.data));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/custom-claude-providers/:id',
    async (request, reply) => {
      const parsed = UpdateCustomClaudeProviderRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: {
            code: 'bad_request',
            message: parsed.error.issues[0]?.message ?? 'Invalid body.',
          },
        });
      }
      try {
        return reply.send(store.update(request.params.id, parsed.data));
      } catch (err) {
        return mapError(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/custom-claude-providers/:id',
    async (request, reply) => {
      if (!store.remove(request.params.id)) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'No such custom Claude provider.' } });
      }
      return reply.code(204).send();
    },
  );
};
