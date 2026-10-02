import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_DEPTH_HEADER,
  MCP_MAX_LIVE_SESSIONS_PER_CLIENT,
  MCP_SESSION_RESOURCE_PREFIX,
  MCP_TOKEN_PREFIX_LENGTH,
  MCP_TOKEN_SCHEME_PREFIX,
  type AgentEvent,
  type McpScope,
  type PermissionRequestEvent,
} from '@pocketagent/protocol';
import type { StructuredLikeSession } from '../src/sessions/manager.js';
import { MCP_TOOLS } from '../src/mcp-server/tools.js';
import { INTERNAL_CALL_HEADER } from '../src/mcp-server/internal-api.js';
import { authHeaders, createTestApp, TEST_TOKEN, waitFor, type TestApp } from './helpers.js';

/**
 * PA-118: PocketAgent as an MCP server.
 *
 * The suite is shaped like `hub-credentials.test.ts` because the riskiest part
 * is the same: a new credential, and a new path outside `/api/` that the gate
 * has to name explicitly. After that come the properties the ticket's review
 * settled — an MCP caller can see an approval and can never answer one; a wait
 * times out but a turn never does; work is owned, capped and depth-limited.
 *
 * Everything goes through the SDK's real `Client` over a real socket, because
 * Streamable HTTP's session header and SSE responses cannot be exercised
 * through `app.inject()`.
 */

const prompts: unknown[] = [];

// A Claude SDK that starts, reports a session id, and then stays open — so a
// session exists and is "running", and a test drives its turns by hand.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: unknown }) => {
    prompts.push(prompt);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: `conv-${prompts.length}` };
        await new Promise(() => {});
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      supportedModels: async () => [],
      supportedCommands: async () => [],
      setModel: async () => {},
      applyFlagSettings: async () => {},
    };
  },
}));

let t: TestApp;
let baseUrl: string;
let logLines: string[];
const clients: Client[] = [];

function sseResponse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const llm = vi.fn(async () => sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Pocket reply.' } }] })]));

beforeEach(async () => {
  logLines = [];
  const loggerStream = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  t = await createTestApp(
    { LOG_LEVEL: 'info', MAX_SESSIONS: '20' },
    undefined,
    undefined,
    undefined,
    llm as unknown as typeof fetch,
    undefined,
    undefined,
    loggerStream,
  );
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await t.cleanup();
});

async function mint(scopes: McpScope[] = ['read', 'sessions', 'planner'], label = 'ci-agent') {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/mcp/tokens',
    headers: authHeaders(t.cookie),
    payload: { label, scopes },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { client: { id: string; tokenPrefix: string; scopes: McpScope[] }; token: string };
}

async function connect(token: string, opts: { path?: string; headers?: Record<string, string> } = {}): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}${opts.path ?? '/mcp'}`), {
    requestInit: { headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
  return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
}

function liveSession(id: string): StructuredLikeSession {
  const session = t.context.sessions.get(id);
  if (!session || session.transport !== 'structured') throw new Error(`no live structured session ${id}`);
  return session as StructuredLikeSession;
}

/** Put an event in the session's replay buffer and emit it, as a backend does. */
function emitEvent(session: StructuredLikeSession, event: AgentEvent): void {
  const { seq } = session.buffer.append(event);
  session.emit('event', seq, event);
}

function completeTurn(session: StructuredLikeSession, text: string): void {
  emitEvent(session, { kind: 'text', id: `t-${Date.now()}`, text });
  emitEvent(session, {
    kind: 'turn_complete',
    stopReason: 'end_turn',
    isError: false,
    numTurns: 1,
    durationMs: 1200,
    costUsd: 0.01,
    inputTokens: 10,
    outputTokens: 20,
  } as AgentEvent);
}

const initializeBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
};

describe('MCP endpoint authentication', () => {
  it('refuses /mcp with no credential, and never serves the SPA shell there', async () => {
    for (const url of ['/mcp', '/api/mcp']) {
      const res = await t.app.inject({ method: 'POST', url, payload: initializeBody });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain('Bearer');
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('gates /mcp by exact match: neighbouring paths are still the public shell', async () => {
    for (const url of ['/mcpx', '/mcp/x']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).not.toBe(401);
    }
  });

  it('accepts neither the master token, nor a cookie session, on /mcp', async () => {
    const master = await t.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
      payload: initializeBody,
    });
    expect(master.statusCode).toBe(401);
    const cookie = await t.app.inject({ method: 'POST', url: '/mcp', headers: authHeaders(t.cookie), payload: initializeBody });
    expect(cookie.statusCode).toBe(401);
  });

  it('accepts an MCP token on the MCP endpoint only — never on the REST API', async () => {
    const { token } = await mint();
    const client = await connect(token);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);

    const rest = await t.app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(rest.statusCode).toBe(401);
  });

  it('reaches the /api/mcp alias the same way', async () => {
    const { token } = await mint();
    const client = await connect(token, { path: '/api/mcp' });
    expect((await call(client, 'get_host_info')).data.client.label).toBe('ci-agent');
  });

  it('shows a minted token once, and only its prefix afterwards', async () => {
    const { token, client } = await mint();
    expect(token.startsWith(MCP_TOKEN_SCHEME_PREFIX)).toBe(true);
    expect(client.tokenPrefix).toBe(token.slice(0, MCP_TOKEN_PREFIX_LENGTH));
    const list = await t.app.inject({ method: 'GET', url: '/api/mcp/tokens', headers: authHeaders(t.cookie) });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(token);
    expect(list.json().path).toBe('/mcp');
    // And the stored form is a digest: nothing in the table is the token.
    const rows = t.db.prepare('SELECT * FROM mcp_client_tokens').all();
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('cannot mint tokens without a session', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/mcp/tokens', payload: { label: 'x', scopes: ['read'] } });
    expect(res.statusCode).toBe(401);
  });

  it('ignores the internal-call header on a real network request', async () => {
    // Only `app.inject()` may use it; from a socket it is just a header.
    const res = await fetch(`${baseUrl}/api/projects`, { headers: { [INTERNAL_CALL_HEADER]: 'anything-at-all' } });
    expect(res.status).toBe(401);
  });

  it('revokes immediately: the open MCP session stops working on its next call', async () => {
    const { token, client: summary } = await mint();
    const client = await connect(token);
    expect((await call(client, 'list_workspaces')).isError).toBe(false);

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/mcp/tokens/${summary.id}`,
      headers: authHeaders(t.cookie),
    });
    expect(del.statusCode).toBe(204);
    await expect(client.callTool({ name: 'list_workspaces', arguments: {} })).rejects.toThrow();

    const fresh = await t.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: initializeBody,
    });
    expect(fresh.statusCode).toBe(401);
  });

  it('will not hand another principal’s MCP session to a different token', async () => {
    const a = await mint(['read'], 'a');
    const b = await mint(['read'], 'b');
    const client = await connect(a.token);
    await client.listTools();
    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId!;
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${b.token}`,
        'mcp-session-id': sessionId,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe('MCP scopes', () => {
  it('lists only the tools a token’s scopes allow', async () => {
    const { token } = await mint(['read']);
    const names = (await (await connect(token)).listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_sessions');
    expect(names).not.toContain('start_session');
    expect(names).not.toContain('create_pocket_chat');
    expect(names).not.toContain('add_workspace');
  });

  it('offers admin tools only to an admin token, and those go through the route (and its audit line)', async () => {
    const { token } = await mint(['read', 'admin'], 'admin-bot');
    const client = await connect(token);
    const res = await call(client, 'create_worktree', { cwd: '/definitely/not/a/project', branchMode: 'current' });
    expect(res.isError).toBe(true);
    const add = await call(client, 'list_workspaces');
    expect(add.isError).toBe(false);
  });
});

describe('the tool catalog', () => {
  it('never offers to answer an approval, skip permissions, force a queue, or run a command', () => {
    const banned = /approve|deny|decision|resolve_permission|exec|bash|shell|install|restart/i;
    for (const tool of MCP_TOOLS) {
      expect(tool.name).not.toMatch(banned);
      for (const key of Object.keys(tool.input)) {
        expect(['skipPermissions', 'force', 'decision', 'argv', 'args', 'command', 'executable', 'skipToolApprovals']).not.toContain(key);
      }
    }
  });
});

describe('driving coding agents', () => {
  it('refuses an agent without a structured transport', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const res = await call(client, 'start_session', { cwd: t.projectDir, agent: 'test-agent', prompt: 'hi' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/structured/);
  });

  it('refuses a directory outside every project folder', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const res = await call(client, 'start_session', { cwd: '/', agent: 'claude', prompt: 'hi' });
    expect(res.isError).toBe(true);
  });

  it('starts a session, records who started it, and returns the final answer once the turn completes', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const started = await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'Write tests.' });
    expect(started.isError, started.text).toBe(false);
    expect(started.data.state).toBe('running');
    const id = started.data.sessionId as string;

    const got = await call(client, 'get_session', { sessionId: id });
    expect(got.data.session.startedByMcpClient).toBe('ci-agent');

    const waiting = call(client, 'wait_for_turn', { sessionId: id, timeoutSeconds: 30 });
    await new Promise((r) => setTimeout(r, 100));
    completeTurn(liveSession(id), 'All tests pass.');
    const result = await waiting;
    expect(result.data.state).toBe('complete');
    expect(result.data.finalText).toBe('All tests pass.');
    expect(result.data.durationMs).toBe(1200);

    // The home screen badges it.
    const projects = (await t.app.inject({ method: 'GET', url: '/api/projects', headers: authHeaders(t.cookie) })).json();
    const chats = projects.projects.flatMap((p: { chats: { sessionId: string; mcpClient?: string }[] }) => p.chats);
    expect(chats.find((c: { sessionId: string }) => c.sessionId === id)?.mcpClient).toBe('ci-agent');
  });

  it('reports a pending approval, cannot answer it, and leaves it pending after the wait times out', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const id = (await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'rm things' })).data
      .sessionId as string;
    const session = liveSession(id);
    const pending: PermissionRequestEvent = {
      kind: 'permission_request',
      id: 'perm-1',
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      title: 'Run rm -rf build',
      displayName: null,
      filePath: null,
      reason: null,
      canAllowForSession: true,
      questions: null,
    } as PermissionRequestEvent;
    vi.spyOn(session, 'pendingPermissions').mockReturnValue([pending]);
    const resolve = vi.spyOn(session, 'resolvePermission');

    const result = await call(client, 'wait_for_turn', { sessionId: id, timeoutSeconds: 1 });
    expect(result.data.state).toBe('awaiting_approval');
    expect(result.data.pendingApprovals[0].toolName).toBe('Bash');
    expect(result.data.note).toMatch(/cannot approve/);
    // No decay: nothing answered it, and it is still there.
    expect(resolve).not.toHaveBeenCalled();
    expect(session.pendingPermissions()).toHaveLength(1);
  });

  it('times out the wait, never the turn', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const id = (await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'long task' })).data
      .sessionId as string;
    const result = await call(client, 'wait_for_turn', { sessionId: id, timeoutSeconds: 0 });
    expect(result.data.state).toBe('still_running');
    expect(t.context.sessions.find(id)?.status).toBe('running');
  });

  it('lets only the starting client stop or interrupt a session', async () => {
    const a = await mint(['read', 'sessions'], 'a');
    const b = await mint(['read', 'sessions'], 'b');
    const clientA = await connect(a.token);
    const clientB = await connect(b.token);
    const id = (await call(clientA, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'x' })).data
      .sessionId as string;

    const denied = await call(clientB, 'stop_session', { sessionId: id });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/not started by this MCP client/);
    expect((await call(clientB, 'interrupt_session', { sessionId: id })).isError).toBe(true);

    // But prompting a session someone else is using is allowed (decided on PA-118).
    expect((await call(clientB, 'send_prompt', { sessionId: id, prompt: 'and this' })).isError).toBe(false);

    expect((await call(clientA, 'stop_session', { sessionId: id })).isError).toBe(false);
  });

  it('caps the live sessions one client may hold', async () => {
    const { token } = await mint();
    const client = await connect(token);
    for (let i = 0; i < MCP_MAX_LIVE_SESSIONS_PER_CLIENT; i++) {
      const dir = `${t.workspaceRoot}/p${i}`;
      (await import('node:fs')).mkdirSync(dir);
      expect((await call(client, 'start_session', { cwd: dir, agent: 'claude', prompt: 'x' })).isError).toBe(false);
    }
    const over = await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'one more' });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/live sessions/);
  });

  it('refuses to start work too many PocketAgent hops deep', async () => {
    const { token } = await mint();
    const client = await connect(token, { headers: { [MCP_DEPTH_HEADER]: '3' } });
    const res = await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'loop' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/hops deep/);
  });

  it('queues a prompt behind another session mid-turn in the same tree', async () => {
    const human = await t.context.sessions.create({
      agent: 'claude',
      cwd: t.projectDir,
      cols: 0,
      rows: 0,
      transport: 'structured',
      title: 'human',
    });
    expect((human as StructuredLikeSession).prompt('busy work')).toBe(true);
    const { token } = await mint();
    const client = await connect(token);
    const started = await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'mine' });
    expect(started.data.state).toBe('queued');
    expect(started.data.queuePosition).toBe(1);
  });
});

describe('driving Pocket Agents', () => {
  it('runs a Pocket Agent task and returns its reply, without pre-approving its tools', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://api.example.com' },
    });
    const workspace = t.context.plannerWorkspaces.list()[0]!;
    const { token } = await mint();
    const client = await connect(token);
    const created = await call(client, 'create_pocket_chat', { workspaceId: workspace.id, modelId: 'gpt-4o-mini' });
    expect(created.isError, created.text).toBe(false);
    const chatId = created.data.chatId as string;
    expect(t.context.plannerChats.get(chatId)?.skipToolApprovalsEnabled).toBe(false);
    expect(t.context.plannerChats.get(chatId)?.mcpClient).toBe('ci-agent');

    const reply = await call(client, 'send_pocket_message', { chatId, message: 'Summarise.', timeoutSeconds: 20 });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data.state).toBe('complete');
    expect(reply.data.finalText).toBe('Pocket reply.');
  });
});

describe('resources and prompts', () => {
  it('exposes session transcripts as subscribable resources', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const id = (await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'x' })).data
      .sessionId as string;
    const uri = `${MCP_SESSION_RESOURCE_PREFIX}${id}`;

    const listed = await client.listResources();
    expect(listed.resources.some((r) => r.uri === uri)).toBe(true);

    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      updates.push(n.params.uri);
    });
    await client.subscribeResource({ uri });
    completeTurn(liveSession(id), 'Done here.');
    await waitFor(() => updates.includes(uri));

    const read = await client.readResource({ uri });
    expect((read.contents[0] as { text: string }).text).toContain('Done here.');
  });

  it('offers global skills as prompts', async () => {
    const { token } = await mint(['read']);
    const client = await connect(token);
    const listed = await client.listPrompts();
    const skills = t.context.skills.listGlobalSkills();
    expect(listed.prompts.length).toBe(skills.filter((s) => !t.context.skills.disabledGlobally(s.id)).length);
    const first = listed.prompts[0];
    if (first) {
      const prompt = await client.getPrompt({ name: first.name, arguments: { task: 'the README' } });
      expect((prompt.messages[0]!.content as { text: string }).text).toContain('Task: the README');
    }
  });
});

describe('auditing', () => {
  it('logs each tool call by name and principal, never its arguments', async () => {
    const { token } = await mint();
    const client = await connect(token);
    await call(client, 'list_sessions', { agent: 'very-secret-argument-value' });
    const lines = logLines.filter((l) => l.includes('"mcp tool call"'));
    expect(lines.some((l) => l.includes('"tool":"list_sessions"') && l.includes('"mcpClient":"ci-agent"'))).toBe(true);
    expect(logLines.join('')).not.toContain('very-secret-argument-value');
  });
});
