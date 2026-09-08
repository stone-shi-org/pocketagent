import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  CreateMcpRegistryRequest,
  UpdateMcpRegistryRequest,
  type McpRegistryListResponse,
} from '@pocketagent/protocol';
import { McpRegistryError } from '../planner/mcp/registry-service.js';

/**
 * PA-37: CRUD for MCP registries, plus the "Test connection" / "Refresh
 * tools" buttons — both just `McpRegistryService.checkConnection`, named
 * twice on the wire because a settings-page user reaches for them for two
 * different reasons even though the operation is identical.
 *
 * Follows `customClaudeProviderRoutes` exactly: every mutation goes through
 * the service, which writes the row and updates its own live state in the
 * same call, so the very next `GET` already reflects it. **No response here
 * ever carries a bearer token or header value**, in plaintext or ciphertext,
 * and there is deliberately no reveal endpoint — same reasoning as a custom
 * Claude provider's API key.
 */
export const mcpRegistryRoutes: FastifyPluginAsync = async (app) => {
  const { mcpRegistry: service } = app.pocket;

  const mapError = (reply: FastifyReply, err: unknown): FastifyReply | never => {
    if (err instanceof McpRegistryError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    throw err;
  };

  app.get('/api/mcp-registries', async () => {
    const body: McpRegistryListResponse = {
      registries: service.list(),
      encryptionAvailable: service.encryptionAvailable,
    };
    return body;
  });

  app.post('/api/mcp-registries', async (request, reply) => {
    const parsed = CreateMcpRegistryRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.code(201).send(service.create(parsed.data));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.patch<{ Params: { id: string } }>('/api/mcp-registries/:id', async (request, reply) => {
    const parsed = UpdateMcpRegistryRequest.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: parsed.error.issues[0]?.message ?? 'Invalid body.' },
      });
    }
    try {
      return reply.send(service.update(request.params.id, parsed.data));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/mcp-registries/:id', async (request, reply) => {
    if (!service.remove(request.params.id)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'No such MCP registry.' } });
    }
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/mcp-registries/:id/test', async (request, reply) => {
    try {
      return reply.header('cache-control', 'no-store').send(await service.checkConnection(request.params.id));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/mcp-registries/:id/refresh-tools', async (request, reply) => {
    try {
      return reply.header('cache-control', 'no-store').send(await service.checkConnection(request.params.id));
    } catch (err) {
      return mapError(reply, err);
    }
  });
};
