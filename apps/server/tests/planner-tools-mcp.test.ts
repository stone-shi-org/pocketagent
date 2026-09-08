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
 * Exercised directly against `execute()` (same posture `planner-tools.test.ts`
 * already takes for the rest of the catalog) with a *real*
 * `McpRegistryService` pointed at a real test MCP server, not a mock —
 * proving the whole path (registry -> cache -> tool dispatch -> truncation)
 * actually works end to end.
 */

function depsFor(t: TestApp, workspaceId?: string | null): PlannerToolDeps {
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
    mcpRegistry: t.context.mcpRegistry,
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

  async function registerRegistry(name = 'Test Registry'): Promise<string> {
    mcpServer = await startStreamableHttpTestServer();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/mcp-registries',
      headers: authHeaders(t.cookie),
      payload: { name, transport: 'streamable_http', url: mcpServer.url, authKind: 'none' },
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
    expect(result).toMatch(/no mcp tools are currently enabled/i);
  });

  it('list_mcp_tools returns name, description, and schema for a real registered tool', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    const parsed = JSON.parse(result) as { tool: string; description: string; parameters: unknown }[];
    const names = parsed.map((p) => p.tool);
    expect(names).toContain(`mcp__${id}__echo`);
    expect(names).toContain(`mcp__${id}__delete_thing`);
    const echo = parsed.find((p) => p.tool === `mcp__${id}__echo`)!;
    expect(echo.description).toContain('Echoes back');
    expect(echo.parameters).toMatchObject({ type: 'object' });
  });

  it('list_mcp_tools filters by query against name and description', async () => {
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
    expect(result).toMatch(/no mcp tools are currently enabled/i);

    // Turning it back on restores every tool from that registry, with no
    // re-connect needed — the cache was never touched by the switch.
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { mcpEnabled: true },
    });
    const restored = JSON.parse(await tool.execute(depsFor(t), {})) as { tool: string }[];
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
    expect(result).toMatch(/no mcp tools are currently enabled/i);

    // An orphaned chat (no workspace) only answers to the global switch,
    // which is still on, so it still sees the registry's tools.
    const orphanResult = JSON.parse(await tool.execute(depsFor(t, null), {})) as { tool: string }[];
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
    expect(result).toBe('echo: hello there');
  });

  it('call_mcp_tool refuses an unknown tool name', async () => {
    t = await createTestApp();
    await registerRegistry();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), { tool: 'mcp__nope__nothing' });
    expect(result).toMatch(/unknown mcp tool/i);
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
    expect(result).toMatch(/is disabled/i);
    // An orphaned chat (no workspace) is unaffected — only the global switch
    // (still on) governs it.
    const okResult = await tool.execute(depsFor(t, null), { tool: `mcp__${id}__echo`, arguments: { text: 'hi' } });
    expect(okResult).toBe('echo: hi');
  });

  it('call_mcp_tool with no tool name asks the model to call list_mcp_tools first', async () => {
    t = await createTestApp();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toMatch(/no mcp tool name provided/i);
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
    const parsed = JSON.parse(await listTool.execute(depsFor(t, workspaceId), {})) as { tool: string }[];
    const names = parsed.map((p) => p.tool);
    expect(names).toContain(`mcp__${jiraId}__echo`);
    expect(names).not.toContain(`mcp__${bambooId}__echo`);

    const callTool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    expect(
      await callTool.execute(depsFor(t, workspaceId), { tool: `mcp__${jiraId}__echo`, arguments: { text: 'hi' } }),
    ).toBe('echo: hi');
    expect(
      await callTool.execute(depsFor(t, workspaceId), { tool: `mcp__${bambooId}__echo`, arguments: { text: 'hi' } }),
    ).toMatch(/is disabled/i);

    // A second, unrelated agent never touched the per-agent setting, so it
    // still sees Bamboo's tools — this is per-agent, not global.
    const otherAgent = await t.app.inject({
      method: 'POST',
      url: '/api/planner/workspaces',
      headers: authHeaders(t.cookie),
      payload: { name: 'Other agent' },
    });
    const otherId = otherAgent.json().id as string;
    const otherParsed = JSON.parse(await listTool.execute(depsFor(t, otherId), {})) as { tool: string }[];
    expect(otherParsed.map((p) => p.tool)).toContain(`mcp__${bambooId}__echo`);
  });
});
