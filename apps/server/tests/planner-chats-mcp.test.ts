import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_MCP_TOOL_NAME } from '@pocketagent/protocol';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';
import { startStreamableHttpTestServer, type TestMcpServerHandle } from './helpers-mcp-server.js';

/**
 * PA-37: the dynamic approval-gating special case for `call_mcp_tool`
 * (`PlannerChatService.effectiveMcpToolIdentity`) exercised end to end
 * through the real HTTP chat routes, against a real MCP test server — this is
 * the single trickiest correctness requirement in the feature (see PA-37's
 * posted plan, §4): a wrapper tool's *own* static `readOnly` must never be
 * what gates it, and a remembered decision must key off the real underlying
 * MCP tool, never the wrapper's name, or one "always allow" would silently
 * cover every MCP tool behind it.
 */

function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeCompletionResponse(content: string): Response {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

function fakeToolCallResponse(name: string, args: Record<string, unknown>, callId = 'call_1'): Response {
  return sseResponse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: callId, function: { name, arguments: JSON.stringify(args) } }] } }],
    }),
  ]);
}

function parseEvents(res: { payload: string }): Array<{ kind: string; [key: string]: unknown }> {
  return res.payload
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}

function findEvent(
  events: Array<{ kind: string; [key: string]: unknown }>,
  kind: string,
): { kind: string; [key: string]: unknown } | undefined {
  return events.find((e) => e.kind === kind);
}

describe('call_mcp_tool approval gating', () => {
  let t: TestApp;
  let mcpServer: TestMcpServerHandle | undefined;

  afterEach(async () => {
    await mcpServer?.close();
    mcpServer = undefined;
    if (t) await t.cleanup();
  });

  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: authHeaders(t.cookie) });
  const post = (url: string, payload?: unknown) =>
    t.app.inject({ method: 'POST', url, headers: authHeaders(t.cookie), ...(payload !== undefined ? { payload } : {}) });
  const patch = (url: string, payload: unknown) =>
    t.app.inject({ method: 'PATCH', url, headers: authHeaders(t.cookie), payload });

  const sendMessage = async (chatId: string, content: string, modelId?: string) => {
    const res = await post(`/api/planner/chats/${chatId}/messages`, { content, ...(modelId ? { modelId } : {}) });
    return { res, events: parseEvents(res) };
  };
  const resolve = async (chatId: string, approvalId: string, decision: string) => {
    const res = await post(`/api/planner/chats/${chatId}/approvals/${approvalId}`, { decision });
    return { res, events: parseEvents(res) };
  };

  /** Registers a real MCP registry against a real test server and populates
      its tool cache, returning the registry id. */
  async function registerRegistry(name = 'Jira MCP'): Promise<string> {
    mcpServer = await startStreamableHttpTestServer();
    const created = (
      await post('/api/mcp-registries', { name, transport: 'streamable_http', url: mcpServer.url, authKind: 'none' })
    ).json();
    const tested = await post(`/api/mcp-registries/${encodeURIComponent(created.id)}/test`);
    expect(tested.json().ok).toBe(true);
    return created.id as string;
  }

  it('a mutating MCP tool pauses for approval, showing the real tool and registry — never the wrapper', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const registryId = await registerRegistry();
    const qualified = `mcp__${registryId}__delete_thing`;
    fetchImpl.mockResolvedValueOnce(
      fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: qualified, arguments: { id: 'issue-1' } }),
    );

    const chat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events } = await sendMessage(chat.id, 'delete issue-1');

    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_use', 'permission_request']);
    const pending = findEvent(events, 'permission_request')!;
    // Keyed by the *real* MCP tool, not the literal wrapper name.
    expect(pending.toolName).toBe(qualified);
    expect(pending.toolName).not.toBe(CALL_MCP_TOOL_NAME);
    expect(pending.title).toContain('delete_thing');
    expect(pending.title).toContain('Jira MCP');
    expect(pending.displayName).toContain('delete_thing');
  });

  it('a read-only MCP tool called via call_mcp_tool runs immediately, no pause', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const registryId = await registerRegistry();
    fetchImpl
      .mockResolvedValueOnce(
        fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: `mcp__${registryId}__echo`, arguments: { text: 'hi' } }),
      )
      .mockResolvedValueOnce(fakeCompletionResponse('Echoed it.'));

    const chat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events } = await sendMessage(chat.id, 'echo hi');

    expect(events.map((e) => e.kind)).toEqual(['user_prompt', 'tool_use', 'tool_result', 'text_delta', 'text', 'turn_complete']);
    expect(findEvent(events, 'tool_result')).toMatchObject({ content: 'echo: hi', isError: false });
    expect(findEvent(events, 'text')?.text).toBe('Echoed it.');
  });

  it('allow_workspace on one MCP tool does not leak to a different MCP tool behind the same wrapper', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const registryId = await registerRegistry();
    const deleteQualified = `mcp__${registryId}__delete_thing`;

    fetchImpl.mockResolvedValueOnce(fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: deleteQualified, arguments: { id: 'a' } }));
    const chat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events } = await sendMessage(chat.id, 'delete a');
    const pending = findEvent(events, 'permission_request')!;

    fetchImpl.mockResolvedValueOnce(fakeCompletionResponse('Deleted a.'));
    const { events: resumedEvents } = await resolve(chat.id, pending.id as string, 'allow_workspace');
    expect(findEvent(resumedEvents, 'turn_complete')).toMatchObject({ isError: false });

    // "Remembered" now exists for `delete_thing`, keyed by its real name —
    // never for `call_mcp_tool` itself.
    const approvals = (await get('/api/planner/tool-approvals')).json().approvals as {
      toolName: string;
    }[];
    expect(approvals.map((a) => a.toolName)).toContain(deleteQualified);
    expect(approvals.map((a) => a.toolName)).not.toContain(CALL_MCP_TOOL_NAME);

    // A *different* mutating tool on the very same registry — never asked
    // about — still has to pause. If the remembered decision had wrongly
    // been keyed on the wrapper, this would run straight through instead.
    if (mcpServer) await mcpServer.close();
    mcpServer = await startStreamableHttpTestServer();
    await patch(`/api/mcp-registries/${encodeURIComponent(registryId)}`, { url: mcpServer.url });
    await post(`/api/mcp-registries/${encodeURIComponent(registryId)}/test`);

    // `delete_thing` itself, on a *second* chat in the same workspace, runs
    // straight through — proving the remembered decision *did* take effect
    // for the tool it was actually granted for.
    fetchImpl.mockResolvedValueOnce(fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: deleteQualified, arguments: { id: 'b' } }));
    fetchImpl.mockResolvedValueOnce(fakeCompletionResponse('Deleted b too.'));
    const secondChat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events: secondEvents } = await sendMessage(secondChat.id, 'delete b');
    expect(findEvent(secondEvents, 'permission_request')).toBeUndefined();
    expect(findEvent(secondEvents, 'text')?.text).toBe('Deleted b too.');
  });

  // PA-37 round three: a prod deployment reported an agent with MCP fully
  // enabled (globally, per-agent, and the registry itself connected) still
  // showing zero MCP tools. Root cause: `list_mcp_tools`/`call_mcp_tool`
  // were plain `PLANNER_TOOLS` rows subject to the *ordinary* global/
  // per-agent tool deny-list — the same one `write_file`/`exec_command` go
  // through — so a stale or accidental row there silently disabled all of
  // MCP with no indication why. This proves the fix: even with such a row
  // present (simulating a pre-fix mistake, or one carried over from before
  // this round), a chat can still discover and call an MCP tool, because
  // `toolsFor` now exempts both meta-tools from that deny-list entirely —
  // the whole-MCP switches are their one and only gate.
  it('a stale global disable row for the MCP meta-tools does not hide MCP from a chat', async () => {
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const registryId = await registerRegistry();

    // Simulate the exact footgun: both meta-tools individually "disabled"
    // via the same table `PATCH /api/planner/tools/:name` used to write to
    // before this round excluded them from that route entirely.
    const insertDisabled = t.context.db.prepare(
      'INSERT INTO planner_global_disabled_tools (tool_name, created_at) VALUES (?, ?)',
    );
    insertDisabled.run('list_mcp_tools', Date.now());
    insertDisabled.run('call_mcp_tool', Date.now());

    fetchImpl
      .mockResolvedValueOnce(
        fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: `mcp__${registryId}__echo`, arguments: { text: 'hi' } }),
      )
      .mockResolvedValueOnce(fakeCompletionResponse('Echoed it.'));

    const chat = (await post('/api/planner/chats', { modelId: 'gpt-4o' })).json();
    const { events } = await sendMessage(chat.id, 'echo hi');

    expect(findEvent(events, 'tool_result')).toMatchObject({ content: 'echo: hi', isError: false });
    expect(findEvent(events, 'text')?.text).toBe('Echoed it.');
  });

  it('skipToolApprovalsEnabled (an unattended-trigger chat) bypasses the pause for a mutating MCP tool exactly as it does for a native one', async () => {
    // No HTTP field can set this — it is only ever set server-side (PA-10).
    // Exercised via the service directly, the same way `PlannerChat`'s own
    // doc comment says a webhook-originated chat gets one.
    const fetchImpl = vi.fn();
    t = await createTestApp({}, undefined, undefined, undefined, fetchImpl as unknown as typeof fetch);
    await patch('/api/planner/settings', { baseUrl: 'https://api.example.com' });
    const registryId = await registerRegistry();

    const chat = t.context.plannerChats.create({ skipToolApprovals: true });
    fetchImpl
      .mockResolvedValueOnce(
        fakeToolCallResponse(CALL_MCP_TOOL_NAME, { tool: `mcp__${registryId}__delete_thing`, arguments: { id: 'z' } }),
      )
      .mockResolvedValueOnce(fakeCompletionResponse('Deleted z.'));

    const { res, events } = await sendMessage(chat.id, 'delete z', 'gpt-4o');
    expect(res.statusCode, res.body).toBe(200);
    expect(findEvent(events, 'permission_request')).toBeUndefined();
    expect(findEvent(events, 'text')?.text).toBe('Deleted z.');
  });
});
