#!/usr/bin/env node
/**
 * PA-118's acceptance criteria, against a real process.
 *
 * Needs no running server: it starts a scratch backend with a throwaway data
 * root and workspace (never the real database), then drives `/mcp` as an
 * external agent would — over real HTTP, with the SDK's real client.
 *
 * `pnpm build` first. Run with: pnpm demo:mcp
 *
 * Two optional steps use real agents, so they are opt-in:
 *   PA_MCP_REAL_AGENT=1   run_coding_task against a real `claude` CLI (uses your
 *                         real HOME for its sign-in, and files one transcript).
 *   PA_MCP_CLAUDE_CLIENT=1  a real Claude Code as the MCP *client*, calling
 *                         get_host_info through `--mcp-config`.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let step = 0;
let failures = 0;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const heading = (title) => console.log(`\n[${++step}] ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mcp-demo-')));
const MASTER = crypto.randomBytes(32).toString('base64url');
const PORT = 18_000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const realAgent = process.env.PA_MCP_REAL_AGENT === '1';

const dataDir = path.join(scratch, 'data');
const workspace = path.join(scratch, 'workspace');
const project = path.join(workspace, 'demo-project');
const home = realAgent ? os.homedir() : path.join(scratch, 'home');
for (const dir of [dataDir, project, home]) fs.mkdirSync(dir, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: project });
fs.writeFileSync(path.join(project, 'README.md'), '# demo\n');

// Killed by its own pid, never by pattern — see CLAUDE.md's 2026-09-17 note.
const server = spawn(process.execPath, ['apps/server/dist/server.js'], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    HOME: home,
    HOST: '127.0.0.1',
    PORT: String(PORT),
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    POCKETAGENT_AUTH_TOKEN: MASTER,
    POCKETAGENT_WORKSPACE_ROOTS: workspace,
    POCKETAGENT_DATA_DIR: dataDir,
    POCKETAGENT_BACKEND: 'direct',
    POCKETAGENT_COOKIE_SECURE: 'false',
    POCKETAGENT_ADOPT_TMUX_SOCKET: '',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (chunk) => {
  if (/error|fatal/i.test(String(chunk))) process.stderr.write(`[server] ${chunk}`);
});
process.on('exit', () => {
  try {
    server.kill('SIGKILL');
  } catch {
    /* gone */
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function waitForHealth() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(150);
  }
  return false;
}

async function connect(token) {
  const client = new Client({ name: 'mcp-demo', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  return { isError: result.isError === true, text, data: result.isError ? null : JSON.parse(text) };
}

try {
  heading('A scratch backend boots');
  check(await waitForHealth(), 'healthy', BASE);

  heading('/mcp is closed without a token');
  const anon = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  check(anon.status === 401, 'no token → 401', String(anon.status));
  const masterAsBearer = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' },
    body: '{}',
  });
  check(masterAsBearer.status === 401, 'the master token is not an MCP credential', String(masterAsBearer.status));

  heading('Mint a token from a browser session');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ token: MASTER }),
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const minted = await (
    await fetch(`${BASE}/api/mcp/tokens`, {
      method: 'POST',
      headers: { cookie, origin: BASE, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'demo-agent', scopes: ['read', 'sessions', 'planner'] }),
    })
  ).json();
  check(typeof minted.token === 'string' && minted.token.startsWith('pam_'), 'token minted', minted.client?.tokenPrefix);
  const rest = await fetch(`${BASE}/api/projects`, { headers: { authorization: `Bearer ${minted.token}` } });
  check(rest.status === 401, 'the MCP token is refused on the REST API', String(rest.status));

  heading('An MCP client sees the catalog its scopes allow');
  const client = await connect(minted.token);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.includes('run_coding_task') && tools.includes('wait_for_turn'), 'session tools listed', `${tools.length} tools`);
  check(!tools.includes('add_workspace'), 'no admin tools without the admin scope');
  check(!tools.some((n) => /approve|deny|exec|bash/.test(n)), 'no tool can answer an approval or run a command');
  const host = await call(client, 'get_host_info');
  check(host.data?.client?.label === 'demo-agent', 'get_host_info names the client', host.data?.host?.name);
  const workspaces = await call(client, 'list_workspaces');
  check(workspaces.data?.workspaces?.some((w) => w.path === workspace), 'list_workspaces shows the scratch folder');
  const resources = await client.listResourceTemplates();
  check(resources.resourceTemplates.length === 2, 'two transcript resource templates');

  heading('Work-starting refusals');
  const shell = await call(client, 'start_session', { cwd: project, agent: 'shell', prompt: 'ls' });
  check(shell.isError, 'a terminal-only agent is refused', shell.text.slice(0, 80));
  const outside = await call(client, 'start_session', { cwd: '/', agent: 'claude', prompt: 'hi' });
  check(outside.isError, 'a directory outside every project folder is refused');

  if (realAgent) {
    heading('A real coding agent answers through run_coding_task');
    const run = await call(client, 'run_coding_task', {
      cwd: project,
      agent: 'claude',
      prompt: 'Reply with exactly the word pong and nothing else. Do not use any tools.',
      timeoutSeconds: 240,
    });
    check(!run.isError && run.data.state === 'complete', 'turn completed', run.isError ? run.text : run.data.state);
    check(/pong/i.test(run.data?.finalText ?? ''), 'final answer returned', run.data?.finalText);
    if (run.data?.sessionId) await call(client, 'stop_session', { sessionId: run.data.sessionId });
  }

  if (process.env.PA_MCP_CLAUDE_CLIENT === '1') {
    heading('A real Claude Code uses PocketAgent as an MCP server');
    const config = path.join(scratch, 'mcp.json');
    fs.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          pocketagent: { type: 'http', url: `${BASE}/mcp`, headers: { Authorization: `Bearer ${minted.token}` } },
        },
      }),
    );
    try {
      const out = execFileSync(
        'claude',
        [
          '-p',
          'Call the pocketagent get_host_info tool and reply with only the client label it reports.',
          '--mcp-config',
          config,
          '--strict-mcp-config',
          '--allowedTools',
          'mcp__pocketagent__get_host_info',
        ],
        { cwd: os.tmpdir(), encoding: 'utf8', timeout: 180_000 },
      );
      check(out.includes('demo-agent'), 'Claude Code called get_host_info', out.trim().slice(0, 80));
    } catch (err) {
      bad('claude -p with --mcp-config failed', String(err.message).split('\n')[0]);
    }
  }

  heading('Revocation takes effect on the next call');
  const del = await fetch(`${BASE}/api/mcp/tokens/${minted.client.id}`, {
    method: 'DELETE',
    headers: { cookie, origin: BASE },
  });
  check(del.status === 204, 'revoked');
  let refused = false;
  try {
    await client.callTool({ name: 'list_workspaces', arguments: {} });
  } catch {
    refused = true;
  }
  check(refused, 'the open MCP session stops working');
} catch (err) {
  bad('demo crashed', err instanceof Error ? err.stack : String(err));
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
server.kill('SIGTERM');
process.exit(failures === 0 ? 0 : 1);
