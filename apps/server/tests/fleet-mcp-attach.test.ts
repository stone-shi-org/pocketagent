import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLEET_MCP_SERVER_NAME } from '@pocketagent/protocol';
import { authHeaders, createTestApp, type TestApp } from './helpers.js';

/**
 * PA-169 Phase 3: "attach Fleet MCP" on a backend — the Hub's `/mcp` handed
 * to a structured Claude session a human started with the toggle on.
 *
 * The SDK is mocked (as `structured-session.test.ts` does) so the options a
 * session hands to `query()` can be inspected: that is where the token goes,
 * and the only place it may go.
 */

const seenOptions: Record<string, unknown>[] = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    seenOptions.push(options);
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'sess_fleet' };
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

const { StructuredSession } = await import('../src/sessions/structured-session.js');
const { MCP_TOOLS } = await import('../src/mcp-server/tools.js');

const TOKEN = `phm_${'a'.repeat(43)}`;
const URL = 'http://hub.example:8788/mcp';

let app: TestApp | null = null;
afterEach(async () => {
  await app?.cleanup();
  app = null;
  seenOptions.length = 0;
});

function spec(extra: Record<string, unknown> = {}) {
  return {
    id: 's1',
    title: 'T',
    agent: 'claude',
    agentDisplayName: 'Claude Code',
    cwd: '/tmp',
    env: { HOME: '/tmp' },
    workspaceLabel: 'tmp',
    eventBufferBytes: 64 * 1024,
    createdAt: Date.now(),
    ...extra,
  };
}

describe('StructuredSession with Fleet MCP', () => {
  it('hands the Hub /mcp to the SDK as an http mcpServers entry, and nowhere else', async () => {
    const session = new StructuredSession(spec({ fleetMcp: { url: URL, token: TOKEN } }));
    await session.start();
    const options = seenOptions.at(-1)!;
    expect(options.mcpServers).toEqual({
      [FLEET_MCP_SERVER_NAME]: { type: 'http', url: URL, headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    expect(JSON.stringify(options.env)).not.toContain(TOKEN);
    expect(session.fleetMcpAttached).toBe(true);
    session.terminate();
  });

  it('attaches nothing by default', async () => {
    const session = new StructuredSession(spec());
    await session.start();
    expect(seenOptions.at(-1)!.mcpServers).toBeUndefined();
    expect(session.fleetMcpAttached).toBe(false);
    session.terminate();
  });
});

describe('/api/fleet-mcp', () => {
  it('stores the token encrypted, never returns it, and clears', async () => {
    app = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: crypto.randomBytes(32).toString('base64') });
    const get0 = await app.app.inject({ method: 'GET', url: '/api/fleet-mcp', headers: authHeaders(app.cookie) });
    expect(get0.json()).toMatchObject({ configured: false, url: null });

    const set = await app.app.inject({
      method: 'POST',
      url: '/api/fleet-mcp',
      headers: authHeaders(app.cookie),
      payload: { url: URL, token: TOKEN },
    });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain(TOKEN);
    expect(set.json()).toMatchObject({ configured: true, url: URL, tokenPrefix: TOKEN.slice(0, 12) });
    const rows = app.db.prepare("SELECT * FROM settings WHERE key LIKE 'fleet_mcp_%'").all();
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
    expect(app.context.fleetMcp.credential()).toEqual({ url: URL, token: TOKEN });

    const get1 = await app.app.inject({ method: 'GET', url: '/api/fleet-mcp', headers: authHeaders(app.cookie) });
    expect(get1.body).not.toContain(TOKEN);

    const del = await app.app.inject({ method: 'DELETE', url: '/api/fleet-mcp', headers: authHeaders(app.cookie) });
    expect(del.json()).toMatchObject({ configured: false });
    expect(app.context.fleetMcp.credential()).toBeNull();
  });

  it('is unavailable without an encryption key, and refuses a non-phm_ token', async () => {
    app = await createTestApp();
    const noKey = await app.app.inject({
      method: 'POST',
      url: '/api/fleet-mcp',
      headers: authHeaders(app.cookie),
      payload: { url: URL, token: TOKEN },
    });
    expect(noKey.statusCode).toBe(409);
    const wrong = await app.app.inject({
      method: 'POST',
      url: '/api/fleet-mcp',
      headers: authHeaders(app.cookie),
      payload: { url: URL, token: `pam_${'a'.repeat(40)}` },
    });
    expect(wrong.statusCode).toBe(400);
  });
});

describe('POST /api/sessions with attachFleetMcp', () => {
  it('is refused for a non-Claude or terminal session, and when the host has nothing to attach', async () => {
    app = await createTestApp({ POCKETAGENT_SETTINGS_ENC_KEY: crypto.randomBytes(32).toString('base64') });
    const base = { cwd: app.projectDir, cols: 80, rows: 24, attachFleetMcp: true };
    const terminal = await app.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(app.cookie),
      payload: { ...base, agent: 'claude', transport: 'terminal' },
    });
    expect(terminal.statusCode).toBe(400);
    expect(terminal.json().error.code).toBe('fleet_mcp_unsupported');

    const unconfigured = await app.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: authHeaders(app.cookie),
      payload: { ...base, agent: 'claude', transport: 'structured' },
    });
    expect(unconfigured.statusCode).toBe(409);
    expect(unconfigured.json().error.code).toBe('fleet_mcp_unavailable');
  });

  it('is not a field any MCP tool accepts — a session the Hub dispatches can never attach it', () => {
    const fields = MCP_TOOLS.flatMap((t) => Object.keys(t.input));
    expect(fields).toContain('prompt');
    expect(fields.filter((f) => /fleet|mcpServers/i.test(f))).toEqual([]);
  });
});
