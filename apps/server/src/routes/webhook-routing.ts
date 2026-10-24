import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SetWebhookRoutingRequest, type WebhookRoutingState } from '@pocketagent/protocol';
import { WebhookRoutingError } from '../webhooks/routing-store.js';
import { auditConfigChange } from './shared.js';

/**
 * PA-171: where this backend's webhooks dispatch remote runs, and the token
 * they do it with.
 *
 * Written by the Hub (with its `pah_` credential) when an operator turns
 * webhook routing on for this host, or by a cookie session. **Never by an MCP
 * principal**: an MCP client that could repoint this backend's webhooks at an
 * MCP server of its choosing could receive every Jira prompt and answer for
 * every target. The token is never returned; the state carries a prefix.
 *
 * `GET` is readable by anyone already authenticated here (the editor's host
 * picker reads it), and carries no secret.
 */
export const webhookRoutingRoutes: FastifyPluginAsync = async (app) => {
  const { webhookRouting } = app.pocket;

  app.get('/api/webhook-routing', async (): Promise<WebhookRoutingState> => webhookRouting.state());

  app.post('/api/webhook-routing', async (request, reply) => {
    if (request.mcpPrincipal) return refuse(reply);
    const parsed = SetWebhookRoutingRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      const state = webhookRouting.set(parsed.data);
      // The URL, the prefix and the host ids — never the token.
      auditConfigChange(request, 'webhook routing configured', {
        url: state.url,
        tokenPrefix: state.tokenPrefix,
        selfHostId: state.selfHostId,
        hosts: state.hosts.map((h) => h.id),
      });
      return state;
    } catch (err) {
      if (err instanceof WebhookRoutingError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.delete('/api/webhook-routing', async (request, reply) => {
    if (request.mcpPrincipal) return refuse(reply);
    const before = webhookRouting.state();
    const state = webhookRouting.clear();
    auditConfigChange(request, 'webhook routing cleared', { tokenPrefix: before.tokenPrefix });
    return state;
  });
};

function refuse(reply: FastifyReply) {
  return reply.code(403).send({
    error: {
      code: 'forbidden',
      message: 'An MCP client cannot change where this host’s webhooks dispatch remote runs.',
    },
  });
}
