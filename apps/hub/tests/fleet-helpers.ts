import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { vi } from 'vitest';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client as ModernClient, StreamableHTTPClientTransport as ModernTransport } from '@modelcontextprotocol/client';
import { MCP_MODERN_PROTOCOL_VERSIONS } from '@pocketagent/protocol';
import { authHeaders, createTestApp, TEST_TOKEN, type TestApp } from '../../server/tests/helpers.js';
import { createTestHub, type TestHub } from './helpers.js';

/**
 * PA-134: real backends behind a real Hub, for the Fleet suites.
 *
 * Real rather than the stub or `fake-backend.ts`, because what these suites
 * check is the contract end to end: a `pam_` token minted on each backend by
 * its own route and verified by asking it, a coordinator whose own MCP
 * registry dials the Hub's `/mcp`, and dispatch that is the backend's own
 * `create_pocket_chat` / `start_session` with its own caps and approval gate.
 * Each backend's Pocket Agent LLM is a scripted fetch, so no model is called.
 */

export type LlmScript = ReturnType<typeof vi.fn>;

export interface FleetBackend {
  id: string;
  app: TestApp;
  url: string;
  llm: LlmScript;
  logs: string[];
}

export interface Fleet {
  hub: TestHub;
  backends: FleetBackend[];
  cleanup: () => Promise<void>;
}

export function sse(dataLines: string[]): Response {
  const body = dataLines.map((line) => `data: ${line}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function llmText(content: string): Response {
  return sse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

export function llmToolCall(name: string, args: Record<string, unknown>, id = 'call_1'): Response {
  return sse([
    JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }],
    }),
  ]);
}

/** Point a backend's Pocket Agents at a (scripted) LLM and give it one model. */
export async function configureLlm(backend: TestApp): Promise<void> {
  await backend.app.inject({
    method: 'PATCH',
    url: '/api/planner/settings',
    headers: authHeaders(backend.cookie),
    payload: { baseUrl: 'https://llm.example.com' },
  });
  await backend.app.inject({
    method: 'POST',
    url: '/api/planner/models',
    headers: authHeaders(backend.cookie),
    payload: { modelId: 'gpt-4o', label: 'GPT-4o' },
  });
  // A host someone has used has a model its Pocket Agent starts with; without
  // one a chat created over MCP has nothing to call (the backend's own rule).
  const list = await backend.app.inject({ method: 'GET', url: '/api/planner/workspaces', headers: authHeaders(backend.cookie) });
  for (const w of (list.json() as { workspaces: { id: string }[] }).workspaces) {
    await backend.app.inject({
      method: 'PATCH',
      url: `/api/planner/workspaces/${w.id}`,
      headers: authHeaders(backend.cookie),
      payload: { defaultModelId: 'gpt-4o' },
    });
  }
}

export async function startFleet(ids: string[], opts: { llm?: boolean } = {}): Promise<Fleet> {
  const hub = await createTestHub();
  const backends: FleetBackend[] = [];
  for (const id of ids) {
    const llm = vi.fn(async () => llmText('ok'));
    const logs: string[] = [];
    const loggerStream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    // An encryption key, because a bearer-auth MCP registry (the
    // coordinator's route to the Hub) is refused on a backend without one.
    const app = await createTestApp(
      { LOG_LEVEL: 'info', POCKETAGENT_SETTINGS_ENC_KEY: crypto.randomBytes(32).toString('base64') },
      undefined,
      undefined,
      undefined,
      llm as unknown as typeof fetch,
      undefined,
      undefined,
      loggerStream,
    );
    await app.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${(app.app.server.address() as AddressInfo).port}`;
    if (opts.llm !== false) await configureLlm(app);
    await hubRequest(hub, 'POST', '/api/hub/hosts', { id, label: id, baseUrl: url });
    const bound = await hubRequest(hub, 'POST', `/api/hub/hosts/${id}/bind`, { token: TEST_TOKEN, label: 'test hub' });
    if (bound.status !== 200) throw new Error(`bind ${id} failed: ${bound.status} ${JSON.stringify(bound.body)}`);
    backends.push({ id, app, url, llm, logs });
  }
  return {
    hub,
    backends,
    cleanup: async () => {
      await hub.cleanup();
      for (const b of backends) await b.app.cleanup();
    },
  };
}

export async function hubRequest(
  hub: TestHub,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Parsed }> {
  const res = await fetch(`${hub.baseUrl}${path}`, {
    method,
    headers: { cookie: hub.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: Parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Every `pam_` token a backend lists, by label. */
export async function backendTokens(backend: TestApp): Promise<{ id: string; label: string; scopes: string[] }[]> {
  const res = await backend.app.inject({ method: 'GET', url: '/api/mcp/tokens', headers: authHeaders(backend.cookie) });
  return (res.json() as { clients: { id: string; label: string; scopes: string[] }[] }).clients;
}

export type Era = 'legacy' | 'modern';

/** A parsed JSON body, read loosely by assertions (as `JSON.parse` returns it). */
type Parsed = ReturnType<typeof JSON.parse>;

export interface AnyClient {
  callTool(params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> }): Promise<{
    isError?: boolean;
    content: unknown;
  }>;
  listTools(): Promise<{ tools: { name: string; inputSchema: unknown; annotations?: { readOnlyHint?: boolean }; _meta?: Record<string, unknown> }[] }>;
  close(): Promise<void>;
}

/** An MCP client of the Hub's `/mcp`, in either era. */
export async function connectHub(hub: TestHub, token: string, era: Era): Promise<AnyClient> {
  const url = new URL(`${hub.baseUrl}/mcp`);
  const requestInit = { headers: { authorization: `Bearer ${token}` } };
  if (era === 'modern') {
    const client = new ModernClient(
      { name: 'fleet-test', version: '2.0.0' },
      { versionNegotiation: { mode: { pin: MCP_MODERN_PROTOCOL_VERSIONS[0]! } } },
    );
    await client.connect(new ModernTransport(url, { requestInit }));
    return client as unknown as AnyClient;
  }
  const client = new LegacyClient({ name: 'fleet-test', version: '1.0.0' });
  await client.connect(new LegacyTransport(url, { requestInit }));
  return client as unknown as AnyClient;
}

export async function callHub(
  client: AnyClient,
  name: string,
  args: Record<string, unknown> = {},
  meta?: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; data: Parsed }> {
  const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
  return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
}
