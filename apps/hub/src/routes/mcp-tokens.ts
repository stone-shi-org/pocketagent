import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateHubMcpClientTokenRequest,
  EnableHubMcpAttachRequest,
  type HubMcpAttachState,
  MCP_SERVER_PATH,
  UpdateHubMcpClientTokenRequest,
  type CreateHubMcpClientTokenResponse,
  type HubMcpClientToken,
  type HubMcpClientTokenListResponse,
} from '@pocketagent/protocol';
import { toClientTokenSummary } from '../mcp/tokens.js';

/**
 * PA-169: Hub MCP client tokens — `phm_` tokens an operator mints for a coding
 * agent, so one MCP entry (the Hub's `/mcp`) reaches every host behind it.
 *
 * Behind the Hub session cookie like every other `/api/hub/*` route. The gate
 * in `app.ts` never looks at a `phm_` bearer off `/mcp`, so no MCP principal
 * can reach these routes: a leaked token cannot mint its successor, widen
 * itself, or revoke a sibling. Mutations are POST/PATCH/DELETE, so the Origin
 * check covers them.
 *
 * Audit lines carry the label, the kind and the clear prefix — never the
 * token, which exists in plaintext only in the create response.
 *
 * A `coordinator` token is listed (so the operator sees every credential that
 * can reach `/mcp`) but cannot be edited or revoked here: its lifecycle is the
 * Fleet card's, and revoking it out from under the coordinator would leave a
 * Fleet agent whose registry silently 401s.
 */
export const hubMcpTokenRoutes: FastifyPluginAsync = async (app) => {
  const { mcpTokens, mcpServer, registry, mcpAttach } = app.hub;

  // ---- Phase 3: offer /mcp to the sessions a human starts on each backend --
  app.get('/api/hub/mcp/attach', async (): Promise<HubMcpAttachState> => mcpAttach.state());

  app.post('/api/hub/mcp/attach/enable', async (request, reply) => {
    const parsed = EnableHubMcpAttachRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message);
    return mcpAttach.enable(parsed.data.hubUrl);
  });

  app.post('/api/hub/mcp/attach/disable', async () => mcpAttach.disable());

  app.get('/api/hub/mcp/tokens', async (): Promise<HubMcpClientTokenListResponse> => ({
    tokens: mcpTokens.list().map(toClientTokenSummary),
    path: MCP_SERVER_PATH,
  }));

  app.post('/api/hub/mcp/tokens', async (request, reply) => {
    const parsed = CreateHubMcpClientTokenRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message);
    const hosts = parsed.data.hosts ?? null;
    const unknown = unknownHosts(hosts);
    if (unknown.length > 0) return badRequest(reply, `No host ${unknown.map((h) => `"${h}"`).join(', ')} on this Hub.`);
    const minted = mcpTokens.mintClient(parsed.data.label, parsed.data.scopes, hosts);
    const row = mcpTokens.get(minted.id);
    if (!row) throw new Error('minted token row vanished');
    const client = toClientTokenSummary(row);
    request.log.warn(
      { hubMcpTokenId: client.id, label: client.label, tokenPrefix: client.tokenPrefix, scopes: client.scopes, hosts: client.hosts },
      'hub mcp client token created',
    );
    const body: CreateHubMcpClientTokenResponse = { client, token: minted.token };
    return reply.code(201).send(body);
  });

  app.patch<{ Params: { id: string } }>('/api/hub/mcp/tokens/:id', async (request, reply) => {
    const parsed = UpdateHubMcpClientTokenRequest.safeParse(request.body);
    if (!parsed.success) return badRequest(reply, parsed.error.issues[0]?.message);
    const existing = mcpTokens.get(request.params.id);
    if (!existing) return notFound(reply);
    if (existing.kind !== 'client') return coordinatorRefusal(reply);
    if (parsed.data.hosts !== undefined) {
      const unknown = unknownHosts(parsed.data.hosts);
      if (unknown.length > 0) return badRequest(reply, `No host ${unknown.map((h) => `"${h}"`).join(', ')} on this Hub.`);
    }
    const row = mcpTokens.updateClient(request.params.id, {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(parsed.data.scopes !== undefined ? { scopes: parsed.data.scopes } : {}),
      ...(parsed.data.hosts !== undefined ? { hosts: parsed.data.hosts } : {}),
    });
    if (!row) return notFound(reply);
    const client: HubMcpClientToken = toClientTokenSummary(row);
    request.log.warn(
      {
        hubMcpTokenId: client.id,
        label: client.label,
        tokenPrefix: client.tokenPrefix,
        fields: Object.keys(parsed.data),
        scopes: client.scopes,
        hosts: client.hosts,
      },
      'hub mcp client token updated',
    );
    return { client };
  });

  app.delete<{ Params: { id: string } }>('/api/hub/mcp/tokens/:id', async (request, reply) => {
    const existing = mcpTokens.get(request.params.id);
    if (!existing) return notFound(reply);
    if (existing.kind !== 'client') return coordinatorRefusal(reply);
    mcpTokens.revoke(existing.id);
    // The row is gone, so the gate refuses its next request; this also closes
    // any MCP session or listen stream it already holds.
    await mcpServer.revoke(existing.id);
    request.log.warn(
      { hubMcpTokenId: existing.id, label: existing.label, tokenPrefix: existing.token_prefix },
      'hub mcp client token revoked',
    );
    return reply.code(204).send();
  });

  function unknownHosts(hosts: readonly string[] | null): string[] {
    if (hosts === null) return [];
    return hosts.filter((id) => registry.getRow(id) === null);
  }
};

function badRequest(reply: FastifyReply, message: string | undefined) {
  return reply.code(400).send({ error: { code: 'bad_request', message: message ?? 'Invalid body.' } });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: { code: 'not_found', message: 'No such Hub MCP token.' } });
}

function coordinatorRefusal(reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: 'coordinator_token',
      message: 'This is the Fleet agent’s coordinator token. Move or disable the Fleet agent to replace it.',
    },
  });
}
