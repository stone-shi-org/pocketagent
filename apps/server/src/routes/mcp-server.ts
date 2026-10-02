import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateMcpClientTokenRequest,
  MCP_SERVER_API_ALIAS,
  MCP_SERVER_PATH,
  type CreateMcpClientTokenResponse,
  type McpClientTokenListResponse,
} from '@pocketagent/protocol';
import { auditConfigChange } from './shared.js';

/**
 * PA-118: the MCP endpoint, and the management API for its tokens.
 *
 * The endpoint is mounted at `/mcp` and `/api/mcp`. Both are exact paths the
 * auth gate in `app.ts` names, and the gate is where authentication happens:
 * by the time a request reaches this handler, `request.mcpPrincipal` is set or
 * the request has already been answered 401.
 *
 * Token management lives under `/api/mcp/tokens` and is reachable by a cookie
 * session or a Hub — never by an MCP client itself, so a leaked token cannot
 * mint a successor that survives its own revocation (the same "cannot mint"
 * property PA-63 gives hub credentials).
 */
export const mcpServerRoutes: FastifyPluginAsync = async (app) => {
  const { mcpServer, mcpTokens, mcpWork } = app.pocket;

  for (const url of [MCP_SERVER_PATH, MCP_SERVER_API_ALIAS]) {
    app.route({
      method: ['GET', 'POST', 'DELETE'],
      url,
      handler: async (request, reply) => {
        await mcpServer.handle(request, reply);
        return reply;
      },
    });
  }

  app.get('/api/mcp/tokens', async (request, reply) => {
    if (request.mcpPrincipal) return refuseMcpPrincipal(reply);
    const response: McpClientTokenListResponse = {
      clients: mcpTokens.list((id) => mcpWork.liveSessionsFor(id)),
      path: MCP_SERVER_PATH,
    };
    return response;
  });

  app.post('/api/mcp/tokens', async (request, reply) => {
    if (request.mcpPrincipal) return refuseMcpPrincipal(reply);
    const parsed = CreateMcpClientTokenRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    const minted = mcpTokens.mint(parsed.data.label, parsed.data.scopes);
    // `warn` when `admin` is granted, whoever asked: that scope can add a
    // project folder, which grants every agent on this machine access to it.
    auditConfigChange(request, 'mcp client token minted', {
      mcpClientId: minted.id,
      label: minted.label,
      scopes: minted.scopes,
    });
    if (minted.scopes.includes('admin')) {
      request.log.warn({ mcpClientId: minted.id, label: minted.label }, 'mcp client token granted the admin scope');
    }
    const summary = mcpTokens.summary(minted.id, 0);
    if (!summary) throw new Error('A just-minted token could not be read back.');
    const response: CreateMcpClientTokenResponse = { client: summary, token: minted.token };
    return reply.code(201).send(response);
  });

  app.delete<{ Params: { id: string } }>('/api/mcp/tokens/:id', async (request, reply) => {
    if (request.mcpPrincipal) return refuseMcpPrincipal(reply);
    const removed = mcpTokens.revoke(request.params.id);
    if (!removed) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such MCP client token.' } });
    }
    auditConfigChange(request, 'mcp client token revoked', { mcpClientId: request.params.id });
    return reply.code(204).send();
  });
};

function refuseMcpPrincipal(reply: FastifyReply) {
  return reply.code(403).send({
    error: { code: 'forbidden', message: 'MCP clients cannot manage MCP client tokens.' },
  });
}
