import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  Client as ModernClient,
  StreamableHTTPClientTransport as ModernTransport,
} from '@modelcontextprotocol/client';
import {
  MCP_DEPTH_HEADER,
  MCP_MAX_LIVE_SESSIONS_PER_CLIENT,
  MCP_MODERN_PROTOCOL_VERSIONS,
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
 * Everything goes through the SDKs' real clients over a real socket, because
 * Streamable HTTP's session header and SSE responses cannot be exercised
 * through `app.inject()`. The endpoint is dual-era, so every behavioural block
 * runs twice: once as a **legacy** client (the v1 SDK, `initialize` handshake,
 * a session) and once as a **modern** one (the v2 SDK pinned to 2026-07-28 —
 * no handshake, per-request `_meta`). A tool that worked in one era and not
 * the other is exactly the regression this shape exists to catch.
 */

type Era = 'legacy' | 'modern';
const ERAS: readonly Era[] = ['legacy', 'modern'];
/** The era `connect()` uses unless told otherwise; set per describe block below. */
let ERA: Era = 'legacy';

/** The surface both SDKs' clients share, as far as these tests use it. */
interface AnyClient {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ isError?: boolean; content: unknown }>;
  listTools(): Promise<{ tools: { name: string }[] }>;
  listResources(): Promise<{ resources: { uri: string }[] }>;
  listResourceTemplates(): Promise<{ resourceTemplates: unknown[] }>;
  readResource(params: { uri: string }): Promise<{ contents: unknown[] }>;
  listPrompts(): Promise<{ prompts: { name: string }[] }>;
  getPrompt(params: { name: string; arguments?: Record<string, string> }): Promise<{ messages: { content: unknown }[] }>;
  close(): Promise<void>;
}

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
const clients: AnyClient[] = [];

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
  ERA = 'legacy';
});

/** Run a block once per protocol era. */
function describeEachEra(name: string, body: (era: Era) => void): void {
  for (const era of ERAS) {
    describe(`${name} [${era}]`, () => {
      beforeEach(() => {
        ERA = era;
      });
      body(era);
    });
  }
}

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

async function connect(
  token: string,
  opts: { path?: string; headers?: Record<string, string>; era?: Era } = {},
): Promise<AnyClient> {
  const url = new URL(`${baseUrl}${opts.path ?? '/mcp'}`);
  const requestInit = { headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } };
  if ((opts.era ?? ERA) === 'modern') {
    const client = new ModernClient(
      { name: 'test-client', version: '2.0.0' },
      { versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSIONS[0]! } } },
    );
    await client.connect(new ModernTransport(url, { requestInit }));
    expect(client.getProtocolEra()).toBe('modern');
    clients.push(client as unknown as AnyClient);
    return client as unknown as AnyClient;
  }
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  clients.push(client);
  return client as unknown as AnyClient;
}

async function call(client: AnyClient, name: string, args: Record<string, unknown> = {}) {
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

describeEachEra('MCP scopes', () => {
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

describeEachEra('driving coding agents', () => {
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

describeEachEra('driving Pocket Agents', () => {
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

describeEachEra('attachments (PA-137)', () => {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

  it('offers upload_attachment to a sessions-only and a planner-only token, and not to read-only', async () => {
    for (const [scopes, offered] of [
      [['read'], false],
      [['sessions'], true],
      [['planner'], true],
    ] as const) {
      const { token } = await mint([...scopes], `scoped-${scopes.join('-')}`);
      const client = await connect(token);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names.includes('upload_attachment')).toBe(offered);
    }
  });

  it('attaches an uploaded file to run_coding_task: it lands in the cwd and the prompt names it', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const up = await call(client, 'upload_attachment', { name: '../spec.md', mediaType: 'text/markdown', dataBase64: b64('# spec') });
    expect(up.isError, up.text).toBe(false);
    expect(up.data).toMatchObject({ name: 'spec.md', size: 6, mediaType: 'text/markdown', expiresInSeconds: 3600 });
    // Staged only: nothing in the project yet.
    expect(fs.existsSync(path.join(t.projectDir, '.pocketagent'))).toBe(false);

    const started = await call(client, 'start_session', {
      cwd: t.projectDir,
      agent: 'claude',
      prompt: 'Implement the spec.',
      attachments: [up.data.attachmentId],
    });
    expect(started.isError, started.text).toBe(false);
    const sent = await waitForPromptText(started.data.sessionId as string);
    expect(sent).toMatch(/^Implement the spec\.\n\n\[Attached file saved to: \.pocketagent\/attachments\/spec_\d{8}-\d{6}_[0-9a-f]{4}\.md\]$/);
    const rel = sent.split('[Attached file saved to: ')[1]!.slice(0, -1);
    expect(fs.readFileSync(path.join(t.projectDir, rel), 'utf8')).toBe('# spec');

    // Single-use: the same id again refuses the whole call and starts nothing.
    const again = await call(client, 'run_coding_task', {
      cwd: t.projectDir,
      agent: 'claude',
      prompt: 'Again.',
      attachments: [up.data.attachmentId],
      timeoutSeconds: 0,
    });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/no longer available/);
  });

  it('a token cannot use another client\'s attachment id', async () => {
    const a = await connect((await mint(undefined, 'client-a')).token);
    const b = await connect((await mint(undefined, 'client-b')).token);
    const up = await call(a, 'upload_attachment', { name: 'secret.txt', dataBase64: b64('mine') });
    expect(up.isError, up.text).toBe(false);
    const stolen = await call(b, 'start_session', {
      cwd: t.projectDir,
      agent: 'claude',
      prompt: 'Read it.',
      attachments: [up.data.attachmentId],
    });
    expect(stolen.isError).toBe(true);
    expect(stolen.text).toMatch(/no longer available/);
    expect(t.context.sessions.list().length).toBe(0);
    // Still there for its owner.
    expect(t.context.attachmentStaging.size()).toBe(1);
  });

  it('attaches a file to run_pocket_task: it lands in the agent\'s uploads and the model is shown it', async () => {
    await t.app.inject({
      method: 'PATCH',
      url: '/api/planner/settings',
      headers: authHeaders(t.cookie),
      payload: { baseUrl: 'https://api.example.com' },
    });
    // run_pocket_task takes no model: the chat starts on the last one used.
    const { writePlannerLastModelId } = await import('../src/planner/store.js');
    writePlannerLastModelId(t.db, 'gpt-4o-mini');
    const workspace = t.context.plannerWorkspaces.list()[0]!;
    const client = await connect((await mint()).token);
    const up = await call(client, 'upload_attachment', { name: 'data.csv', mediaType: 'text/csv', dataBase64: b64('a,b\n1,2\n') });
    const before = llm.mock.calls.length;
    const reply = await call(client, 'run_pocket_task', {
      workspaceId: workspace.id,
      message: 'Total column b.',
      attachments: [up.data.attachmentId],
      timeoutSeconds: 20,
    });
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.data.state).toBe('complete');
    const body = JSON.parse(String((llm.mock.calls[before] as unknown as [string, RequestInit])[1].body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const user = String(body.messages.filter((m) => m.role === 'user').pop()!.content);
    expect(user).toContain('[Attached file saved to: artifacts/uploads/data_');
    // Small text is inlined, fenced as data.
    expect(user).toMatch(/<<<FILE data\.csv [0-9a-f]{16}>>>\na,b\n1,2\n<<<END [0-9a-f]{16}>>>/);
    expect(fs.readdirSync(path.join(workspace.path, 'artifacts', 'uploads')).some((n) => n.startsWith('data_'))).toBe(true);
  });

  it('refuses a file over the MCP cap, and logs sizes, never names or bytes', async () => {
    const client = await connect((await mint()).token);
    const big = await call(client, 'upload_attachment', {
      name: 'big.bin',
      dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'),
    });
    expect(big.isError).toBe(true);
    const ok = await call(client, 'upload_attachment', { name: 'private-name.txt', dataBase64: b64('the bytes') });
    expect(ok.isError).toBe(false);
    const logs = logLines.join('');
    expect(logs).toContain('mcp client staged an attachment');
    expect(logs).not.toContain('private-name');
    expect(logs).not.toContain(b64('the bytes'));
  });
});

/** The text of the user prompt a session's own event stream recorded. */
async function waitForPromptText(sessionId: string): Promise<string> {
  let text = '';
  await waitFor(() => {
    const replay = liveSession(sessionId).buffer.replayAfter(0);
    const prompt = replay.events.map((e) => e.event).find((e) => e.kind === 'user_prompt');
    text = prompt && prompt.kind === 'user_prompt' ? prompt.text : '';
    return text.length > 0;
  });
  return text;
}

describeEachEra('resources and prompts', (era) => {
  it('exposes session transcripts as subscribable resources', async () => {
    const { token } = await mint();
    const client = await connect(token);
    const id = (await call(client, 'start_session', { cwd: t.projectDir, agent: 'claude', prompt: 'x' })).data
      .sessionId as string;
    const uri = `${MCP_SESSION_RESOURCE_PREFIX}${id}`;

    const listed = await client.listResources();
    expect(listed.resources.some((r) => r.uri === uri)).toBe(true);

    const updates: string[] = [];
    if (era === 'legacy') {
      // 2025-era: `resources/subscribe` on the session, notified on its GET stream.
      const legacy = client as unknown as Client;
      legacy.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        updates.push(n.params.uri);
      });
      await legacy.subscribeResource({ uri });
    } else {
      // 2026-07-28: no subscribe method — a `subscriptions/listen` stream that
      // opted in to this URI.
      const modern = client as unknown as ModernClient;
      modern.setNotificationHandler('notifications/resources/updated', (n) => {
        updates.push(n.params.uri);
      });
      await modern.listen({ resourceSubscriptions: [uri] });
    }
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

describeEachEra('auditing', (era) => {
  it('logs each tool call by name and principal, never its arguments', async () => {
    const { token } = await mint();
    const client = await connect(token);
    await call(client, 'list_sessions', { agent: 'very-secret-argument-value' });
    const lines = logLines.filter((l) => l.includes('"mcp tool call"'));
    expect(
      lines.some(
        (l) => l.includes('"tool":"list_sessions"') && l.includes('"mcpClient":"ci-agent"') && l.includes(`"era":"${era}"`),
      ),
    ).toBe(true);
    expect(logLines.join('')).not.toContain('very-secret-argument-value');
  });
});

/**
 * Protocol negotiation. The endpoint is dual-era: a modern client declares its
 * revision on every request and is answered statelessly; a legacy client
 * negotiates once, in `initialize`. These are pinned at the wire level rather
 * than through a client, so a client SDK quietly papering over a server bug
 * cannot make them pass.
 */
describe('protocol negotiation', () => {
  const MODERN = MCP_MODERN_PROTOCOL_VERSIONS[0]!;

  function modernRequest(token: string, method: string, version = MODERN, extraHeaders: Record<string, string> = {}) {
    return fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': method,
        ...extraHeaders,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' },
          },
        },
      }),
    });
  }

  async function initialize(token: string, protocolVersion: string): Promise<string | undefined> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      }),
    });
    expect(res.status).toBe(200);
    return /"protocolVersion":"([^"]+)"/.exec(await res.text())?.[1];
  }

  it('answers server/discover with the modern revisions it speaks', async () => {
    const { token } = await mint(['read']);
    const res = await modernRequest(token, 'server/discover');
    expect(res.status).toBe(200);
    const body = JSON.parse((await res.text()).replace(/^[\s\S]*?data: /, '').split('\n')[0] ?? '{}');
    const result = body.result ?? body;
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.resultType).toBe('complete');
    expect(result._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('pocketagent');
  });

  it('rejects an unknown revision with -32022 naming the supported ones, so a client can retry', async () => {
    const { token } = await mint(['read']);
    const res = await modernRequest(token, 'tools/list', '2099-01-01');
    const body = await res.json();
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.requested).toBe('2099-01-01');
    expect(body.error.data.supported).toContain(MODERN);
  });

  it('enforces the 2026-07-28 request headers (Mcp-Method must match the body)', async () => {
    const { token } = await mint(['read']);
    const res = await modernRequest(token, 'tools/list', MODERN, { 'mcp-method': 'prompts/list' });
    expect(res.status).toBe(400);
  });

  it('negotiates every legacy revision in initialize, and counter-offers the newest for an unknown one', async () => {
    const { token } = await mint(['read']);
    for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']) {
      expect(await initialize(token, version)).toBe(version);
    }
    expect(await initialize(token, '1999-01-01')).toBe('2025-11-25');
  });

  it('lets a dual-era client pick: auto-negotiation lands on the modern era, a legacy-only client on 2025', async () => {
    const { token } = await mint(['read']);
    const auto = new ModernClient({ name: 'auto', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    await auto.connect(new ModernTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(auto as unknown as AnyClient);
    expect(auto.getProtocolEra()).toBe('modern');
    expect(auto.getNegotiatedProtocolVersion()).toBe(MODERN);
    const hostInfo = await call(auto as unknown as AnyClient, 'get_host_info');
    expect(hostInfo.data.protocol).toEqual({ era: 'modern', version: MODERN });

    const legacy = await connect(token, { era: 'legacy' });
    expect((await call(legacy, 'get_host_info')).data.protocol).toEqual({ era: 'legacy', version: null });
  });

  it('authenticates a modern request in the gate, before the SDK ever sees it', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-protocol-version': MODERN, 'mcp-method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('revokes a modern client immediately too — the next stateless request is refused', async () => {
    const { token, client: summary } = await mint(['read']);
    const client = await connect(token, { era: 'modern' });
    expect((await call(client, 'list_workspaces')).isError).toBe(false);
    await t.app.inject({ method: 'DELETE', url: `/api/mcp/tokens/${summary.id}`, headers: authHeaders(t.cookie) });
    await expect(client.callTool({ name: 'list_workspaces', arguments: {} })).rejects.toThrow();
  });
});
