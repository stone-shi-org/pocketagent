import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_DISPATCH_ORIGIN_META_KEY } from '@pocketagent/protocol';
import { MCP_TOOLS } from '../src/mcp-server/tools.js';
import { authHeaders, createTestApp, TEST_TOKEN, type TestApp } from './helpers.js';

/**
 * PA-171, the *target* half: the eighth override of the approval rule.
 *
 * A webhook run another server dispatched here through the Hub skips approvals
 * only when all of these hold — the Hub stated it is a webhook run (the
 * dispatch origin in `_meta`), the principal carrying that statement is one a
 * Hub stands behind, and *this* host's own `webhookDispatchSkipApprovals` is
 * on. Each test below removes one of them.
 */

// A Claude SDK that starts and stays open, as `mcp-server.test.ts` uses, so a
// structured session exists and its spec can be read back.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: 'conv-1' };
      await new Promise(() => {});
    },
    interrupt: async () => {},
    setPermissionMode: async () => {},
    supportedModels: async () => [],
    supportedCommands: async () => [],
    setModel: async () => {},
    applyFlagSettings: async () => {},
  }),
}));

let t: TestApp;
let baseUrl: string;
const clients: Client[] = [];

const ORIGIN = { kind: 'webhook', sourceHostId: 'dev01', sourceLabel: 'Dev 01' } as const;

beforeEach(async () => {
  t = await createTestApp({ MAX_SESSIONS: '20' });
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await t.cleanup();
});

async function hubCredential(): Promise<string> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/auth/hub-bind',
    payload: { token: TEST_TOKEN, label: 'the hub' },
  });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().token as string;
}

/** A `pam_` token, minted by a Hub (`via: 'hub'`) or by a browser session. */
async function mint(via: 'hub' | 'session'): Promise<string> {
  const headers = via === 'hub' ? { authorization: `Bearer ${await hubCredential()}` } : authHeaders(t.cookie);
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/mcp/tokens',
    headers,
    payload: { label: `fleet-${via}`, scopes: ['read', 'sessions', 'planner'] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().token as string;
}

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'hub', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

async function startSession(client: Client, meta: Record<string, unknown> | undefined) {
  const result = await client.callTool({
    name: 'start_session',
    arguments: { cwd: t.projectDir, agent: 'claude', prompt: 'hi' },
    ...(meta ? { _meta: meta } : {}),
  });
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  expect(result.isError, text).not.toBe(true);
  const data = JSON.parse(text) as { sessionId: string; skipPermissionsEnabled?: boolean };
  return { data, info: t.context.sessions.find(data.sessionId) };
}

async function setSwitch(on: boolean): Promise<void> {
  const res = await t.app.inject({
    method: 'PATCH',
    url: '/api/settings',
    headers: authHeaders(t.cookie),
    payload: { webhookDispatchSkipApprovals: on },
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().settings.webhookDispatchSkipApprovals).toBe(on);
}

describe('webhookDispatchSkipApprovals (PA-171)', () => {
  it('is off by default and reported in the settings resource', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/settings', headers: authHeaders(t.cookie) });
    expect(res.json().settings.webhookDispatchSkipApprovals).toBe(false);
  });

  it('skips approvals for a Hub-stated webhook run on a Hub-minted token, with the switch on', async () => {
    await setSwitch(true);
    const client = await connect(await mint('hub'));
    const { data, info } = await startSession(client, { [MCP_DISPATCH_ORIGIN_META_KEY]: ORIGIN });
    expect(data.skipPermissionsEnabled).toBe(true);
    expect(info?.skipPermissionsEnabled).toBe(true);
  });

  it('asks as usual with the switch off — the source webhook does not decide', async () => {
    const client = await connect(await mint('hub'));
    const { data, info } = await startSession(client, { [MCP_DISPATCH_ORIGIN_META_KEY]: ORIGIN });
    expect(data.skipPermissionsEnabled).toBe(false);
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('asks as usual when there is no origin, even with the switch on (Fleet and client dispatches)', async () => {
    await setSwitch(true);
    const client = await connect(await mint('hub'));
    const { info } = await startSession(client, undefined);
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('ignores an origin from a token no Hub minted', async () => {
    await setSwitch(true);
    const client = await connect(await mint('session'));
    const { info } = await startSession(client, { [MCP_DISPATCH_ORIGIN_META_KEY]: ORIGIN });
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('ignores a malformed origin', async () => {
    await setSwitch(true);
    const client = await connect(await mint('hub'));
    const { info } = await startSession(client, { [MCP_DISPATCH_ORIGIN_META_KEY]: { kind: 'cron', sourceHostId: 'x' } });
    expect(info?.skipPermissionsEnabled).toBe(false);
  });

  it('pre-approves a dispatched Pocket Agent chat only under the same rule', async () => {
    await setSwitch(true);
    const workspaceId = t.context.plannerWorkspaces.list()[0]!.id;
    const client = await connect(await mint('hub'));
    const create = async (meta?: Record<string, unknown>) => {
      const res = await client.callTool({
        name: 'create_pocket_chat',
        arguments: { workspaceId },
        ...(meta ? { _meta: meta } : {}),
      });
      const chatId = JSON.parse((res.content as { text: string }[])[0]!.text).chatId as string;
      return t.context.plannerChats.get(chatId);
    };
    expect((await create({ [MCP_DISPATCH_ORIGIN_META_KEY]: ORIGIN }))?.skipToolApprovalsEnabled).toBe(true);
    expect((await create())?.skipToolApprovalsEnabled).toBe(false);
  });

  it('is never a tool input', () => {
    for (const tool of MCP_TOOLS) {
      for (const key of Object.keys(tool.input)) {
        expect(key, tool.name).not.toMatch(/skip|origin|dispatch/i);
      }
    }
  });

  it('cannot be flipped by an MCP principal or the planner’s update_settings tool', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/planner/tools.ts', import.meta.url), 'utf8'),
    );
    expect(source).toContain("if ('webhookDispatchSkipApprovals' in rawPatch)");
    const route = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/routes/settings.ts', import.meta.url), 'utf8'),
    );
    expect(route).toContain('patch.webhookDispatchSkipApprovals !== undefined && request.mcpPrincipal');
  });
});
