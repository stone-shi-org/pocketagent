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
    workspaceId: workspaceId === undefined ? (t.context.plannerWorkspaces.getDefault()?.id ?? null) : workspaceId,
    webSearch: TOOL_INTEGRATION_DISABLED,
    urlFetch: TOOL_INTEGRATION_DISABLED,
  };
}

describe('list_mcp_tools / call_mcp_tool', () => {
  let t: TestApp;
  let mcpServer: TestMcpServerHandle | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    mcpServer = undefined;
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

  it('list_mcp_tools omits a tool disabled globally', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    await t.app.inject({
      method: 'PATCH',
      url: `/api/planner/tools/${encodeURIComponent(`mcp__${id}__echo`)}`,
      headers: authHeaders(t.cookie),
      payload: { enabled: false },
    });
    const tool = findPlannerTool(LIST_MCP_TOOLS_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    const parsed = JSON.parse(result) as { tool: string }[];
    expect(parsed.map((p) => p.tool)).not.toContain(`mcp__${id}__echo`);
    expect(parsed.map((p) => p.tool)).toContain(`mcp__${id}__delete_thing`);
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

  it('call_mcp_tool refuses a tool disabled for this specific agent, even though the wrapper is enabled', async () => {
    t = await createTestApp();
    const id = await registerRegistry();
    const workspaceId = t.context.plannerWorkspaces.getDefault()!.id;
    await t.app.inject({
      method: 'POST',
      url: `/api/planner/workspaces/${workspaceId}/tools`,
      headers: authHeaders(t.cookie),
      payload: { toolName: `mcp__${id}__delete_thing`, enabled: false },
    });
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), { tool: `mcp__${id}__delete_thing`, arguments: { id: 'x' } });
    expect(result).toMatch(/is disabled/i);
    // The registry's other tool is unaffected.
    const okResult = await tool.execute(depsFor(t), { tool: `mcp__${id}__echo`, arguments: { text: 'hi' } });
    expect(okResult).toBe('echo: hi');
  });

  it('call_mcp_tool with no tool name asks the model to call list_mcp_tools first', async () => {
    t = await createTestApp();
    const tool = findPlannerTool(CALL_MCP_TOOL_NAME)!;
    const result = await tool.execute(depsFor(t), {});
    expect(result).toMatch(/no mcp tool name provided/i);
  });
});
