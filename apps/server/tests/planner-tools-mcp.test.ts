import { afterEach, describe, expect, it } from 'vitest';
import { LIST_MCP_TOOLS_NAME, CALL_MCP_TOOL_NAME } from '@pocketagent/protocol';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { startStreamableHttpTestServer, type TestMcpServerHandle } from './helpers-mcp-server.js';
import { findPlannerTool, TOOL_INTEGRATION_DISABLED, type PlannerToolDeps } from '../src/planner/tools.js';

/**
 * PA-37: `list_mcp_tools`/`call_mcp_tool`, the two meta-tools that stand in
 * for every MCP registry's tools so a turn's own `tools` array never grows
 * with the number of configured registries — see PA-37's posted plan, §4.
 *
 * `list_mcp_tools` is two-tiered (follow-up: a no-argument call used to dump
 * the first 50 tools' full schemas across *every* enabled registry combined,
 * so one chatty registry — many tools, verbose per-tool descriptions — could
 * exhaust the whole truncation budget before any other registry's tools
 * appeared at all). A no-argument call now returns the cheap registry
 * directory (id/name/description/toolCount, no schemas); a `registry`-scoped
 * call returns that one registry's own tools with full schemas, with its own
 * truncation budget rather than sharing one across every registry.
 *
 * Exercised directly against `execute()` (same posture `planner-tools.test.ts`
 * already takes for the rest of the catalog) with a *real*
 * `McpRegistryService` pointed at a real test MCP server, not a mock —
 * proving the whole path (registry -> cache -> tool dispatch -> truncation)
 * actually works end to end.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../src/planner/mcp/client.js';
import { McpRegistryService } from '../src/planner/mcp/registry-service.js';

function depsFor(t: TestApp, workspaceId?: string | null, customMcpRegistry?: McpRegistryService): PlannerToolDeps {
  const { workspaces, plannerWorkspaces, sessions, worktrees, conversations, agyTranscripts, piTranscripts } =
    t.context;
  return {
    workspaces,
    plannerWorkspaces,
    sessions,
    worktrees,
    historyDeps: { sessions, conversations, agyTranscripts, piTranscripts },
    shell: t.context.config.shell,
    memory: t.context.plannerMemory,
    mcpRegistry: customMcpRegistry ?? t.context.mcpRegistry,
    skills: t.context.skills,
    workspaceId: workspaceId === undefined ? (t.context.plannerWorkspaces.getDefault()?.id ?? null) : workspaceId,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
  };
}

describe('list_mcp_tools / call_mcp_tool', () => {
  let t: TestApp;
  let mcpServer: TestMcpServerHandle | undefined;
  let mcpServer2: TestMcpServerHandle | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    await mcpServer2?.close();
    mcpServer = undefined;
    mcpServer2 = undefined;
    if (t) await t.cleanup();
  });

  async function registerRegistry(name = 'Test Registry', description?: string): Promise<string> {
    mcpServer = await startStreamableHttpTestServer();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers: authHeaders(t.cookie),
      payload: {
        name,
        transport: 'streamable_http',
        url: mcpServer.url,
        authKind: 'none',
        ...(description !== undefined ? { description } : {}),
      },
    });
    const id = created.json().id as string;
    const tested = await t.app.inject({
      method: 'POST',
      url: `/api/mcp-registries/${encodeURIComponent(id)}/test`,
      headers: authHeaders(t.cookie),
    });
    expect(tested.json().ok).toBe(true);
    return id;
  }

  /** A second, independent registry — for tests proving per-registry
      filtering rather than only the whole-MCP switch. */
  async function registerSecondRegistry(name = 'Second Registry'): Promise<string> {
    mcpServer2 = await startStreamableHttpTestServer();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers: authHeaders(t.cookie),
      payload: { name, transport: 'streamable_http', url: mcpServer2.url, authKind: 'none' },
    });
    const id = created.json().id as string;
    const tested = await t.app.inject({
      method: 'POST',
      url: `/api/mcp-registries/${encodeURIComponent(id)}/test`,
      headers: authHeaders(t.cookie),
    });
    expect(tested.json().ok).toBe(true);
    return id;
  }

  it('list_mcp_tools reports nothing when no registry is configured', async () => {
    t = await createTestApp();
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toMatch(/no mcp registries are currently enabled/i);
  });

  it('list_mcp_tools with no arguments returns the registry directory, never a tool schema', async () => {
    t = await createTestApp();
    const id = await registerRegistry('Arr MCP', 'Manages the *arr stack — TV, movie, and music downloads.');
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    const parsed = JSON.parse(result) as { id: string; name: string; host: string; description: string | null; toolCount: number }[];
    expect(parsed).toEqual([
      {
        id,
        name: 'Arr MCP',
        host: expect.any(String),
        description: 'Manages the *arr stack — TV, movie, and music downloads.',
        toolCount: 2,
      },
    ]);
    // Never a tool schema or qualified tool name at this tier.
    expect(result).not.toContain('mcp__');
    expect(result).not.toContain('inputSchema');
  });

  it('list_mcp_tools registry directory lists a registry with no description as null, not omitted', async () => {
    t = await createTestApp();
    await registerRegistry();
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const parsed = JSON.parse(await tool.execute(depsFor(t), {})) as { description: string | null }[];
    expect(parsed[0]!.description).toBeNull();
  });

  // A server's own reported `instructions` (most don't set one; arr-mcp does
  // in production) fills the directory tier's `description` only when no
  // human has written one — the model gets the best available text either
  // way, without needing to know which source it came from.
  it('list_mcp_tools registry directory falls back to the server\'s reported instructions when no description is set', async () => {
    t = await createTestApp();
    mcpServer = await startStreamableHttpTestServer({ instructions: 'Read the tool list before calling anything.' });
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers: authHeaders(t.cookie),
      payload: { name: 'Self-describing', transport: 'streamable_http', url: mcpServer.url, authKind: 'none' },
    });
    const id = created.json().id as string;

    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const parsed = JSON.parse(await tool.execute(depsFor(t), {})) as { id: string; description: string | null }[];
    expect(parsed.find((r) => r.id === id)?.description).toBe('Read the tool list before calling anything.');

    // A user-authored description still wins over it.
    await t.app.inject({
      method: 'PATCH',
      url: `/api/mcp-registries/${encodeURIComponent(id)}`,
      headers: authHeaders(t.cookie),
      payload: { description: 'Human-written summary.' },
    });
    const afterDescription = JSON.parse(await tool.execute(depsFor(t), {})) as { id: string; description: string | null }[];
    expect(afterDescription.find((r) => r.id === id)?.description).toBe('Human-written summary.');
  });

  it('list_mcp_tools scoped to a registry returns name, description, and schema for its tools', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), { registry: id });
    const parsed = JSON.parse(result) as { tool: string; description: string; parameters: unknown }[];
    const names = parsed.map((p) => p.tool);
    expect(names).toContain(`mcp__${id}__echo`);
    expect(names).toContain(`mcp__${id}__delete_thing`);
    const echo = parsed.find((p) => p.tool === `mcp__${id}__echo`)!;
    expect(echo.description).toContain('Echoes back');
    expect(echo.parameters).toMatchObject({ type: 'object' });
  });

  it('list_mcp_tools scoped to a registry accepts its display name, not only its id', async () => {
    t = await createTestApp();
    const id = await registerRegistry('Jira MCP');
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const parsed = JSON.parse(await tool.execute(depsFor(t), { registry: 'Jira MCP' })) as { tool: string }[];
    expect(parsed.map((p) => p.tool)).toContain(`mcp__${id}__echo`);
  });

  it('list_mcp_tools scoped to one registry never returns another registry\'s tools', async () => {
    t = await createTestApp();
    const jiraId = await registerRegistry('Jira MCP');
    const bambooId = await registerSecondRegistry('Bamboo MCP');
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const parsed = JSON.parse(await tool.execute(depsFor(t), { registry: jiraId })) as { tool: string }[];
    const names = parsed.map((p) => p.tool);
    expect(names).toContain(`mcp__${jiraId}__echo`);
    expect(names).not.toContain(`mcp__${bambooId}__echo`);
  });

  it('list_mcp_tools refuses an unknown registry ref and names what is actually available', async () => {
    t = await createTestApp();
    await registerRegistry('Jira MCP');
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), { registry: 'not-a-real-registry' });
    expect(result).toMatch(/no enabled mcp registry matched/i);
    expect(result).toContain('Jira MCP');
  });

  it('list_mcp_tools filters by query against name and description, across every registry when none is specified', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), { query: 'echo' });
    const parsed = JSON.parse(result) as { tool: string }[];
    expect(parsed.map((p) => p.tool)).toEqual([`mcp__${id}__echo`]);
  });

  // PA-37 follow-up (reporter: "Let's not list the mcp tool as separate
  // tools to allow/disallow. Let's just enable/disable mcp as whole for
  // global or each agent."): enablement is no longer per-tool — these two
  // tests cover the whole-MCP switch at both layers instead of the retired
  // per-tool-name PATCH routes.

  it('list_mcp_tools reports nothing when MCP is disabled globally, even with a registered, reachable registry', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { mcpEnabled: false },
    });
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toMatch(/no mcp registries are currently enabled/i);

    // Turning it back on restores the registry (directory tier) and its
    // tools (registry-scoped tier), with no re-connect needed — the cache
    // was never touched by the switch.
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { mcpEnabled: true },
    });
    const directory = JSON.parse(await tool.execute(depsFor(t), {})) as { id: string }[];
    expect(directory.map((r) => r.id)).toContain(id);
    const restored = JSON.parse(await tool.execute(depsFor(t), { registry: id })) as { tool: string }[];
    expect(restored.map((p) => p.tool)).toContain(`mcp__${id}__echo`);
  });

  it('list_mcp_tools reports nothing for one agent with MCP disabled, but is unaffected for another agent in the same workspace default', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.app.inject({
      method: 'PATCH',
      url: `/api/planner/workspaces/${workspaceId}`,
      headers: authHeaders(t.cookie),
      payload: { mcpEnabled: false },
    });
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t, workspaceId), {});
    expect(result).toMatch(/no mcp registries are currently enabled/i);

    // An orphaned chat (no workspace) only answers to the global switch,
    // which is still on, so it still sees the registry's tools.
    const orphanResult = JSON.parse(await tool.execute(depsFor(t, null), { registry: id })) as { tool: string }[];
    expect(orphanResult.map((p) => p.tool)).toContain(`mcp__${id}__echo`);
  });

  it('call_mcp_tool dispatches a real call and returns the tool result text', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), {
      tool: `mcp__${id}__echo`,
      arguments: { text: 'hello there' },
    });
    expect(result).toEqual({ content: 'echo: hello there', isError: false });
  });

  it('call_mcp_tool refuses an unknown tool name', async () => {
    t = await createTestApp();
    await registerRegistry();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), { tool: 'mcp__nope__nothing' });
    expect(result).toMatchObject({
      content: expect.stringMatching(/unknown mcp tool/i),
      isError: true,
    });
  });

  it('call_mcp_tool refuses every tool for an agent with MCP disabled, even though the registry itself is fine', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.app.inject({
      method: 'PATCH',
      url: `/api/planner/workspaces/${workspaceId}`,
      headers: authHeaders(t.cookie),
      payload: { mcpEnabled: false },
    });
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t, workspaceId), {
      tool: `mcp__${id}__delete_thing`,
      arguments: { id: 'x' },
    });
    expect(result).toMatchObject({
      content: expect.stringMatching(/is disabled/i),
      isError: true,
    });
    // An orphaned chat (no workspace) is unaffected — only the global switch
    // (still on) governs it.
    const okResult = await tool.execute(depsFor(t, null), { tool: `mcp__${id}__echo`, arguments: { text: 'hi' } });
    expect(okResult).toEqual({ content: 'echo: hi', isError: false });
  });

  it('call_mcp_tool with no tool name asks the model to call list_mcp_tools first', async () => {
    t = await createTestApp();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toMatchObject({
      content: expect.stringMatching(/no mcp tool name provided/i),
      isError: true,
    });
  });

  // PA-37 follow-up round two: disabling one registry for an agent hides
  // only *that* registry's tools — a second, still-enabled registry is
  // unaffected, proving this is genuinely per-registry filtering and not
  // just the whole-MCP switch from the round-one follow-up.
  it('disabling one registry for an agent hides only that registry, leaving a second registry fully usable', async () => {
    t = await createTestApp();
    const jiraId = await registerRegistry('Jira MCP');
    const bambooId = await registerSecondRegistry('Bamboo MCP');
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;

    await t.app.inject({
      method: 'POST',
      url: `/api/planner/workspaces/${workspaceId}/mcp-registries`,
      headers: authHeaders(t.cookie),
      payload: { registryId: bambooId, enabled: false },
    });

    const listTool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    // The directory tier itself no longer lists the disabled registry at all.
    const directory = JSON.parse(await listTool.execute(depsFor(t, workspaceId), {})) as { id: string }[];
    expect(directory.map((r) => r.id)).toContain(jiraId);
    expect(directory.map((r) => r.id)).not.toContain(bambooId);

    // Jira's own tools are listed scoped by id; Bamboo's registry ref no
    // longer resolves for this agent at all.
    const jiraTools = JSON.parse(await listTool.execute(depsFor(t, workspaceId), { registry: jiraId })) as {
      tool: string;
    }[];
    expect(jiraTools.map((p) => p.tool)).toContain(`mcp__${jiraId}__echo`);
    const bambooAttempt = await listTool.execute(depsFor(t, workspaceId), { registry: bambooId });
    expect(bambooAttempt).toMatch(/no enabled mcp registry matched/i);

    const callTool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    expect(
      await callTool.execute(depsFor(t, workspaceId), { tool: `mcp__${jiraId}__echo`, arguments: { text: 'hi' } }),
    ).toEqual({ content: 'echo: hi', isError: false });
    expect(
      await callTool.execute(depsFor(t, workspaceId), { tool: `mcp__${bambooId}__echo`, arguments: { text: 'hi' } }),
    ).toMatchObject({ content: expect.stringMatching(/is disabled/i), isError: true });

    // A second, unrelated agent never touched the per-agent setting, so it
    // still sees Bamboo's tools — this is per-agent, not global.
    const otherAgent = await t.app.inject({
      method: 'POST',
      url: '/api/planner/workspaces',
      headers: authHeaders(t.cookie),
      payload: { name: 'Other agent' },
    });
    const otherId = otherAgent.json().id as string;
    const otherTools = JSON.parse(
      await listTool.execute(depsFor(t, otherId), { registry: bambooId }),
    ) as { tool: string }[];
    expect(otherTools.map((p) => p.tool)).toContain(`mcp__${bambooId}__echo`);
  });

  // PA-101: Error reporting and backoff cooldown

  it('call_mcp_tool marks server-reported errors as isError: true', async () => {
    t = await createTestApp();
    mcpServer = await startStreamableHttpTestServer({ includeFailTool: true });
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers: authHeaders(t.cookie),
      payload: { name: 'Failing Registry', transport: 'streamable_http', url: mcpServer.url, authKind: 'none' },
    });
    const id = created.json().id as string;
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), {
      tool: `mcp__${id}__fail_tool`,
      arguments: { message: 'database locked' },
    });
    expect(result).toEqual({
      content: `Error from mcp__${id}__fail_tool: Tool error: database locked`,
      isError: true,
    });
  });

  it('call_mcp_tool backs off from unreachable servers after connect timeout without redialing', async () => {
    t = await createTestApp({
      POCKETAGENT_SETTINGS_ENC_KEY: Buffer.alloc(32, 1).toString('base64'),
    });

    class ControllableFakeTransport implements Transport {
      public startCalls = 0;
      public hang = false;

      async start(): Promise<void> {
        this.startCalls++;
        if (this.hang) {
          return new Promise(() => {});
        }
      }

      async send(message: JSONRPCMessage): Promise<void> {
        if (this.hang) return;
        if ('method' in message) {
          if (message.method === 'initialize') {
            this.onmessage?.({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'controllable-server', version: '1.0.0' },
              },
            });
          } else if (message.method === 'tools/list') {
            this.onmessage?.({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                tools: [
                  {
                    name: 'fetch_and_process_unread',
                    description: 'Fetches emails',
                    inputSchema: { type: 'object', properties: {} },
                    annotations: { readOnlyHint: true },
                  },
                ],
              },
            });
          } else if (message.method === 'tools/call') {
            this.onmessage?.({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                content: [{ type: 'text', text: 'email processed' }],
              },
            });
          } else if ('id' in message) {
            // A 2025-era server answers anything it does not know — including
            // the 2026-07-28 client's `server/discover` probe — with "method
            // not found", which is what sends a dual-era client to `initialize`.
            this.onmessage?.({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32601, message: 'Method not found' },
            } as JSONRPCMessage);
          }
        }
      }

      async close(): Promise<void> {}
      onclose?: () => void;
      onerror?: (error: Error) => void;
      onmessage?: (message: JSONRPCMessage) => void;
    }

    const fakeTransport = new ControllableFakeTransport();
    let mockTime = 1_700_000_000_000;

    const customMcpRegistry = new McpRegistryService({
      db: t.context.db,
      encKey: t.context.config.settingsEncKey,
      logger: t.app.log,
      now: () => mockTime,
      clientFactory: (cfg) => new McpClient(cfg, { customTransport: fakeTransport, connectTimeoutMs: 50, callTimeoutMs: 50 }),
    });

    // 1. Initial healthy creation caches tools
    const summary = customMcpRegistry.create({
      name: 'Email Triage',
      transport: 'streamable_http',
      url: 'http://10.100.0.50:4003/mcp?token=leakme#frag',
      authKind: 'bearer',
      bearerToken: 'secret-bearer-token-12345',
    });
    const tested = await customMcpRegistry.checkConnection(summary.id);
    expect(tested.ok).toBe(true);
    expect(fakeTransport.startCalls).toBe(1);

    const callTool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const toolName = `mcp__${summary.id}__fetch_and_process_unread`;

    // 2. The server freezes: fake transport now hangs on connect
    fakeTransport.hang = true;

    // First call: connect times out
    const failResult1 = await callTool.execute(depsFor(t, undefined, customMcpRegistry), {
      tool: toolName,
      arguments: {},
    });
    expect(fakeTransport.startCalls).toBe(2);
    expect(failResult1).toMatchObject({
      isError: true,
      content: expect.stringContaining('MCP server "Email Triage" (10.100.0.50:4003, streamable_http)'),
    });
    // Ensure sensitive tokens/query/path/headers are NEVER leaked into error text
    const content1 = typeof failResult1 === 'string' ? failResult1 : failResult1.content;
    expect(content1).not.toContain('secret-bearer-token-12345');
    expect(content1).not.toContain('leakme');
    expect(content1).not.toContain('Bearer');

    // 3. Second call immediately within cooldown window (cooldown is 30s):
    // Must return immediately WITHOUT redialing (startCalls must remain 2)
    mockTime += 5_000; // 5s later
    const failResult2 = await callTool.execute(depsFor(t, undefined, customMcpRegistry), {
      tool: toolName,
      arguments: {},
    });
    expect(fakeTransport.startCalls).toBe(2); // Dial did not happen!
    expect(failResult2).toMatchObject({
      isError: true,
      content: expect.stringMatching(/MCP server "Email Triage" \(10\.100\.0\.50:4003\) is unreachable \(last error 5s ago: .*\)\. Not retrying until .*/),
    });

    // 4. Advance time past the 30s cooldown:
    mockTime += 26_000; // now 31s since failure
    const failResult3 = await callTool.execute(depsFor(t, undefined, customMcpRegistry), {
      tool: toolName,
      arguments: {},
    });
    // Cooldown expired, so it attempts to connect again!
    expect(fakeTransport.startCalls).toBe(3);
    expect(failResult3).toMatchObject({
      isError: true,
      content: expect.stringContaining('MCP server "Email Triage" (10.100.0.50:4003, streamable_http)'),
    });

    // 5. Restore server health:
    fakeTransport.hang = false;
    mockTime += 61_000; // wait past exponential backoff cooldown (streak 2 = 60s)
    const successResult = await callTool.execute(depsFor(t, undefined, customMcpRegistry), {
      tool: toolName,
      arguments: {},
    });
    expect(fakeTransport.startCalls).toBe(4);
    expect(successResult).toEqual({
      content: 'email processed',
      isError: false,
    });

    // Verify streak and cooldown are reset
    const refreshedSummary = customMcpRegistry.get(summary.id);
    expect(refreshedSummary.cooldownUntil).toBeNull();
  });
});

