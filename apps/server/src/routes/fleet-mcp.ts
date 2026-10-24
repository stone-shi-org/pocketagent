import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { SetFleetMcpAttachRequest, type FleetMcpAttachState } from '@pocketagent/protocol';
import { FleetMcpAttachError } from '../mcp-server/fleet-attach.js';
import { auditConfigChange } from './shared.js';

/**
 * PA-169 Phase 3: the Hub's `/mcp` address and the token this backend's
 * sessions attach it with.
 *
 * Written by the Hub (with its `pah_` credential) when an operator turns
 * "attach Fleet MCP" on, or by a cookie session. **Never by an MCP principal**,
 * in-process or not: an MCP client that could point this backend's sessions
 * at an MCP server of its choosing would be handing tools to every session a
 * human starts here. The token is never returned; the state carries a prefix.
 */
export const fleetMcpRoutes: FastifyPluginAsync = async (app) => {
  const { fleetMcp } = app.pocket;

  app.get('/api/fleet-mcp', async (): Promise<FleetMcpAttachState> => fleetMcp.state());

  app.post('/api/fleet-mcp', async (request, reply) => {
    if (request.mcpPrincipal) return refuse(reply);
    const parsed = SetFleetMcpAttachRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      const state = fleetMcp.set(parsed.data.url, parsed.data.token);
      // The URL and the prefix, never the token.
      auditConfigChange(request, 'fleet mcp attach configured', { url: state.url, tokenPrefix: state.tokenPrefix });
      return state;
    } catch (err) {
      if (err instanceof FleetMcpAttachError) {
        return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  app.delete('/api/fleet-mcp', async (request, reply) => {
    if (request.mcpPrincipal) return refuse(reply);
    const before = fleetMcp.state();
    const state = fleetMcp.clear();
    auditConfigChange(request, 'fleet mcp attach cleared', { tokenPrefix: before.tokenPrefix });
    return state;
  });
};

function refuse(reply: FastifyReply) {
  return reply.code(403).send({
    error: { code: 'forbidden', message: 'An MCP client cannot change where this host’s sessions attach MCP servers.' },
  });
}
