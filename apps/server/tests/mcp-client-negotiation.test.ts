import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_MODERN_PROTOCOL_VERSIONS, mcpQualifiedToolName } from '@pocketagent/protocol';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { startSseTestServer, startStreamableHttpTestServer, type TestMcpServerHandle } from './helpers-mcp-server.js';
import { SECRET_KEY_BYTES } from '../src/crypto/secret-box.js';
import { LEGACY_ERA_VERDICT_TTL_MS, McpRegistryService } from '../src/planner/mcp/registry-service.js';

/**
 * PA-118: the Pocket Agent's own MCP *client* negotiates the protocol era.
 *
 * The server half (`mcp-server.test.ts`) proves `/mcp` speaks both eras; this
 * proves the client that MCP registries use does too — and, just as important,
 * that it does not pay for negotiation on every call. It connects once per
 * tool call, so the era is probed once per registry and cached on the row; the
 * cache is re-probed when an operator presses Test/Refresh, when a cached
 * modern verdict stops working, and when a cached legacy one is a day old.
 *
 * Two real servers make the eras concrete: this app's own dual-era `/mcp`
 * (modern-capable), and the SDK-v1 test server in `helpers-mcp-server.ts`,
 * which is a genuine 2025-era server that answers `server/discover` with
 * "method not found".
 */

const ENC_KEY = crypto.randomBytes(SECRET_KEY_BYTES).toString('base64');
const MODERN = MCP_MODERN_PROTOCOL_VERSIONS[0]!;

let t: TestApp;
let baseUrl: string;
const servers: TestMcpServerHandle[] = [];

beforeEach(async () => {
  t = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: ENC_KEY });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  await t.cleanup();
});

async function mintMcpToken(): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/mcp/tokens',
    headers: authHeaders(t.cookie),
    payload: { label: 'self', scopes: ['read', 'sessions'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

/** A registry pointing at this very server's `/mcp` — dual-era, so modern-capable. */
async function selfRegistry(registries: McpRegistryService = t.context.mcpRegistry) {
  const token = await mintMcpToken();
  return registries.create({
    name: 'Self',
    transport: 'streamable_http',
    url: `${baseUrl}/mcp`,
    authKind: 'bearer',
    bearerToken: token,
  });
}

/** Count the `server/discover` probes the client sends, whichever server it talks to. */
function countDiscoverProbes(): { count: () => number } {
  const original = globalThis.fetch;
  let probes = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    if (body.includes('"server/discover"')) probes += 1;
    return original(input, init);
  });
  return { count: () => probes };
}

describe('MCP client protocol negotiation', () => {
  it('negotiates 2026-07-28 with a modern server, and reports it on the registry', async () => {
    const reg = await selfRegistry();
    const tested = await t.context.mcpRegistry.checkConnection(reg.id);
    expect(tested.ok, tested.message).toBe(true);
    const summary = t.context.mcpRegistry.get(reg.id);
    expect(summary.protocolEra).toBe('modern');
    expect(summary.protocolVersion).toBe(MODERN);

    // And the server agrees it was spoken to as modern.
    const result = await t.context.mcpRegistry.callTool(mcpQualifiedToolName(reg.id, 'get_host_info'), {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).protocol).toEqual({ era: 'modern', version: MODERN });
  });

  it('falls back to the legacy handshake with a 2025-era server, exactly as before', async () => {
    const legacy = await startStreamableHttpTestServer();
    servers.push(legacy);
    const reg = t.context.mcpRegistry.create({ name: 'Old', transport: 'streamable_http', url: legacy.url, authKind: 'none' });
    const tested = await t.context.mcpRegistry.checkConnection(reg.id);
    expect(tested.ok, tested.message).toBe(true);
    expect(t.context.mcpRegistry.get(reg.id).protocolEra).toBe('legacy');
    const result = await t.context.mcpRegistry.callTool(mcpQualifiedToolName(reg.id, 'echo'), { text: 'hi' });
    expect(result.text).toBe('echo: hi');
  });

  it('probes once per registry, then reuses the cached verdict for every call', async () => {
    const reg = await selfRegistry();
    const probes = countDiscoverProbes();
    await t.context.mcpRegistry.checkConnection(reg.id);
    expect(probes.count()).toBe(1);
    const tool = mcpQualifiedToolName(reg.id, 'list_workspaces');
    for (let i = 0; i < 3; i++) {
      expect((await t.context.mcpRegistry.callTool(tool, {})).isError).toBe(false);
    }
    // Zero round trips for era selection on the calls: the cached
    // DiscoverResult was adopted rather than re-probed.
    expect(probes.count()).toBe(1);
  });

  it('caches a legacy verdict too, and re-probes it once it is a day old', async () => {
    const legacy = await startStreamableHttpTestServer();
    servers.push(legacy);
    let now = Date.now();
    const registries = new McpRegistryService({
      db: t.context.db,
      encKey: t.context.config.settingsEncKey,
      logger: t.app.log,
      now: () => now,
    });
    const reg = registries.create({ name: 'Old', transport: 'streamable_http', url: legacy.url, authKind: 'none' });
    const probes = countDiscoverProbes();
    await registries.checkConnection(reg.id);
    expect(probes.count()).toBe(1);
    const echo = mcpQualifiedToolName(reg.id, 'echo');
    await registries.callTool(echo, { text: 'a' });
    expect(probes.count()).toBe(1);

    now += LEGACY_ERA_VERDICT_TTL_MS + 1;
    await registries.callTool(echo, { text: 'b' });
    expect(probes.count()).toBe(2);
  });

  it('drops a stale modern verdict and re-probes, without failing the call', async () => {
    // A registry that once spoke 2026-07-28 now points at a server that does
    // not (downgraded, or replaced behind the same URL). Simulated by planting
    // a modern verdict on a registry whose server is legacy-only.
    const legacy = await startStreamableHttpTestServer();
    servers.push(legacy);
    const registries = t.context.mcpRegistry;
    const reg = registries.create({ name: 'Swapped', transport: 'streamable_http', url: legacy.url, authKind: 'none' });
    await registries.checkConnection(reg.id);
    const discover = {
      supportedVersions: [MODERN],
      capabilities: { tools: {} },
      serverInfo: { name: 'gone', version: '1' },
      resultType: 'complete',
    };
    const stale = {
      protocol_era: 'modern',
      protocol_version: MODERN,
      protocol_discover_json: JSON.stringify(discover),
      protocol_checked_at: Date.now(),
    };
    // The in-memory row is what a call reads; plant the verdict there (as if
    // hydrated after a restart) and on disk to match.
    const live = (registries as unknown as { live: Map<string, { row: Record<string, unknown> }> }).live.get(reg.id)!;
    live.row = { ...live.row, ...stale };
    t.context.db
      .prepare(
        'UPDATE mcp_registries SET protocol_era = ?, protocol_version = ?, protocol_discover_json = ?, protocol_checked_at = ? WHERE id = ?',
      )
      .run(stale.protocol_era, stale.protocol_version, stale.protocol_discover_json, stale.protocol_checked_at, reg.id);

    const probes = countDiscoverProbes();
    const result = await registries.callTool(mcpQualifiedToolName(reg.id, 'echo'), { text: 'still works' });
    expect(result.text).toBe('echo: still works');
    expect(probes.count()).toBe(1);
    expect(registries.get(reg.id).protocolEra).toBe('legacy');
  });

  it('never probes over the legacy-only HTTP+SSE transport', async () => {
    const sse = await startSseTestServer();
    servers.push(sse);
    const probes = countDiscoverProbes();
    const reg = t.context.mcpRegistry.create({ name: 'SSE', transport: 'sse', url: sse.url, authKind: 'none' });
    const tested = await t.context.mcpRegistry.checkConnection(reg.id);
    expect(tested.ok, tested.message).toBe(true);
    expect(probes.count()).toBe(0);
    expect(t.context.mcpRegistry.get(reg.id).protocolEra).toBe('legacy');
  });

  it('forgets the verdict when the registry is pointed somewhere else', async () => {
    const reg = await selfRegistry();
    await t.context.mcpRegistry.checkConnection(reg.id);
    expect(t.context.mcpRegistry.get(reg.id).protocolEra).toBe('modern');
    t.context.mcpRegistry.update(reg.id, { url: `${baseUrl}/api/mcp` });
    expect(t.context.mcpRegistry.get(reg.id).protocolEra).toBeNull();
  });

  it('carries the PocketAgent call depth through a modern request’s _meta', async () => {
    const reg = await selfRegistry();
    await t.context.mcpRegistry.checkConnection(reg.id);
    const result = await t.context.mcpRegistry.callTool(
      mcpQualifiedToolName(reg.id, 'start_session'),
      { cwd: t.projectDir, agent: 'claude', prompt: 'loop' },
      { depth: 3 },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/hops deep/);
  });
});
