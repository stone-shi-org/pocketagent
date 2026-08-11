#!/usr/bin/env node
/**
 * End-to-end verification of the PocketAgent MVP flow against a running server.
 * Speaks the same HTTP + WebSocket protocol the browser does, including the
 * HttpOnly cookie. Run with: node e2e-demo.mjs
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';
import fs from 'node:fs';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const TOKEN = fs
  .readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  .match(/^POCKETAGENT_AUTH_TOKEN=(.+)$/m)[1]
  .trim();

let step = 0;
let failures = 0;
const ok = (label, detail = '') => console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures++;
  console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
};
const check = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail));
const heading = (title) => console.log(`\n[${++step}] ${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';

async function call(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Browser-equivalent WebSocket client with sequence tracking. */
function openSocket() {
  const ws = new WebSocket(`${WS_BASE}/api/ws?v=${PROTOCOL_VERSION}`, { headers: { cookie } });
  const state = { output: '', lastSeq: 0, messages: [], truncated: null };

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    state.messages.push(m);
    if (m.type === 'attached') {
      state.output += m.replay.data;
      state.lastSeq = Math.max(state.lastSeq, m.replay.toSeq);
      state.truncated = m.replay.truncated;
    } else if (m.type === 'output' && m.seq > state.lastSeq) {
      state.lastSeq = m.seq;
      state.output += m.data;
    }
  });

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    ws,
    state,
    ready,
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: async (predicate, timeout = 10_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await sleep(30);
      }
      return false;
    },
    close: () => new Promise((r) => (ws.once('close', r), ws.close(), setTimeout(r, 500))),
  };
}

// ---------------------------------------------------------------------------

console.log('PocketAgent end-to-end demo\n' + '='.repeat(60));

heading('Server is running');
{
  const { status, body } = await call('/health');
  check(status === 200 && body.status === 'ok', 'GET /health', `v${body?.version}`);
}

heading('Browser UI is served by the same process');
{
  const res = await fetch(BASE + '/');
  const html = await res.text();
  check(res.status === 200 && html.includes('PocketAgent'), 'GET / returns the SPA shell');
}

/**
 * Log in, tolerating the login rate limiter.
 *
 * The limiter allows 8 attempts a minute. Running this demo several times in
 * quick succession legitimately trips it, so wait the window out rather than
 * reporting the security control as a failure.
 */
async function login(token, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    if (res.status !== 429) return res;
    console.log('     (rate limited — waiting for the window to reset)');
    await sleep(62_000);
  }
  return { status: 429, body: null };
}

heading('Log in');
{
  const wrong = await login('definitely-the-wrong-token-value');
  check(wrong.status === 401, 'wrong token rejected', `HTTP ${wrong.status}`);

  const good = await login(TOKEN);
  check(good.status === 200, 'correct token accepted', `HTTP ${good.status}`);
  check(cookie.startsWith('pocketagent_sid='), 'received session cookie');
  check(!cookie.includes(TOKEN), 'cookie does not contain the master token');
}

let workspace;
heading('Choose a project directory');
{
  const { body } = await call('/api/workspaces');
  const names = body.workspaces.map((w) => w.name);
  // Use whatever is configured rather than assuming a fixture directory, so
  // this runs against a real deployment too.
  workspace = (body.workspaces.find((w) => !w.isRoot) ?? body.workspaces[0]).path;
  check(body.workspaces.length > 0, 'workspace listing', names.join(', '));

  const escape = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd: '/etc' }),
  });
  check(escape.status === 403, 'directory outside workspace roots rejected', `HTTP ${escape.status}`);
}

let shellId;
heading('Create a shell session');
{
  const { status, body } = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd: workspace, cols: 90, rows: 26 }),
  });
  shellId = body.id;
  check(status === 201 && body.status === 'running', 'session created', `id=${body.id} pid=${body.pid}`);
}

let sock = openSocket();
/** Remove OSC then CSI so we can assert on rendered text. */
const plainText = (raw) =>
  raw.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

heading('See the shell prompt in the terminal stream');
{
  await sock.ready;
  sock.send({ type: 'attach', sessionId: shellId, afterSeq: 0 });
  // Do not assume a `$` sigil: the configured $SHELL may be zsh with a themed
  // prompt. A prompt mentioning the working directory is the portable signal.
  const leaf = workspace.split('/').pop();
  const got = await sock.waitFor((s) => plainText(s.output).includes(leaf));
  check(got, 'shell prompt received', plainText(sock.state.output).trim().split('\n').pop()?.slice(-60));
}

heading('Type `echo hello` and see `hello`');
{
  sock.send({ type: 'input', sessionId: shellId, data: 'echo hello\n' });
  const got = await sock.waitFor((s) => (s.output.match(/hello/g) ?? []).length >= 2);
  check(got, 'command echoed and output returned');
}

const seqBeforeDrop = sock.state.lastSeq;
heading('Disconnect the browser');
{
  await sock.close();
  await sleep(300);
  const { body } = await call(`/api/sessions/${shellId}`);
  check(body.status === 'running', 'PTY survived the disconnect', `status=${body.status}`);
  check(body.attachedClients === 0, 'server released the client reference');
}

heading('Work continues while nobody is watching');
{
  // Nothing is attached; drive the PTY from a second short-lived connection to
  // prove the session is genuinely still interactive.
  const tmp = openSocket();
  await tmp.ready;
  tmp.send({ type: 'attach', sessionId: shellId, afterSeq: seqBeforeDrop });
  await tmp.waitFor((s) => s.messages.some((m) => m.type === 'attached'));
  tmp.send({ type: 'input', sessionId: shellId, data: 'echo while-you-were-away\n' });
  const got = await tmp.waitFor((s) => s.output.includes('while-you-were-away'));
  check(got, 'session still accepts input');
  await tmp.close();
  await sleep(200);
}

heading('Reconnect and resume the same session with buffered history');
{
  sock = openSocket();
  await sock.ready;
  sock.send({ type: 'attach', sessionId: shellId, afterSeq: seqBeforeDrop });
  const attached = await sock.waitFor((s) => s.messages.some((m) => m.type === 'attached'));
  check(attached, 'reattached to the same session');

  const replay = sock.state.messages.find((m) => m.type === 'attached').replay;
  check(replay.data.includes('while-you-were-away'), 'missed output replayed');
  check(!replay.truncated, 'replay is contiguous with what was already rendered');
  // Assert the sequence boundary rather than searching the text for old
  // commands: an interactive shell with autosuggestions happily reprints
  // history into the live stream, which would make a content check lie.
  check(
    replay.fromSeq === seqBeforeDrop,
    'replay starts exactly where the client left off',
    `fromSeq=${replay.fromSeq} lastRendered=${seqBeforeDrop}`,
  );
}

heading('Send another command after reconnecting');
{
  sock.send({ type: 'input', sessionId: shellId, data: 'echo after-reconnect\n' });
  const got = await sock.waitFor((s) => s.output.includes('after-reconnect'));
  check(got, 'input works after reconnect');
}

heading('Resize the terminal and verify the PTY resized');
{
  sock.send({ type: 'resize', sessionId: shellId, cols: 132, rows: 43 });
  await sleep(250);
  sock.send({ type: 'input', sessionId: shellId, data: 'echo SIZE=$(tput cols)x$(tput lines)\n' });
  const got = await sock.waitFor((s) => s.output.includes('SIZE=132x43'));
  check(got, 'child process observed the new size', '132x43');

  const { body } = await call(`/api/sessions/${shellId}`);
  check(body.cols === 132 && body.rows === 43, 'new size persisted');
}

heading('Verify the master token did not leak into the session environment');
{
  sock.send({ type: 'input', sessionId: shellId, data: 'echo LEAKS=$(env | grep -c POCKETAGENT)\n' });
  const got = await sock.waitFor((s) => s.output.includes('LEAKS=0'));
  check(got, 'no POCKETAGENT_* variables in the child environment');
}

heading('Kill the session through the API');
{
  const { status } = await call(`/api/sessions/${shellId}`, { method: 'DELETE' });
  check(status === 200, 'DELETE accepted');

  const exited = await sock.waitFor((s) => s.messages.some((m) => m.type === 'exit'), 12_000);
  check(exited, 'client notified of exit');

  const { body } = await call(`/api/sessions/${shellId}`);
  check(body.status === 'killed', 'session recorded as killed', `status=${body.status}`);
  await sock.close();
}

heading('Create a Claude Code session through the same API');
let claudeId;
{
  const agents = await call('/api/agents');
  const claude = agents.body.agents.find((a) => a.id === 'claude');
  check(claude?.available === true, 'claude CLI detected on PATH');

  const { status, body } = await call('/api/sessions', {
    method: 'POST',
    // Explicit: Claude now defaults to the structured transport, and this
    // demo is specifically exercising the raw-terminal path.
    body: JSON.stringify({
      agent: 'claude',
      cwd: workspace,
      cols: 100,
      rows: 30,
      transport: 'terminal',
    }),
  });
  claudeId = body.id;
  check(status === 201 && body.status === 'running', 'claude session created', `pid=${body.pid}`);
}

heading('Confirm Claude Code is running interactively in the terminal');
{
  const claudeSock = openSocket();
  await claudeSock.ready;
  claudeSock.send({ type: 'attach', sessionId: claudeId, afterSeq: 0, cols: 100, rows: 30 });
  await claudeSock.waitFor((s) => s.messages.some((m) => m.type === 'attached'));

  // Claude Code paints a full-screen TUI. Wait for recognisable *rendered text*,
  // not a byte count: under tmux the attach handshake alone is ~600 bytes of
  // terminal negotiation that arrives long before the app draws anything.
  const CLAUDE_UI = /claude|anthropic|trust this folder|\/help|welcome/i;
  const drew = await claudeSock.waitFor((s) => CLAUDE_UI.test(plainText(s.output)), 45_000);

  const raw = claudeSock.state.output;
  const plain = plainText(raw);

  check(raw.length > 200, 'Claude Code produced terminal output', `${raw.length} bytes`);
  check(/\x1b\[/.test(raw), 'output contains ANSI control sequences (a real TUI)');
  check(drew, 'output looks like the Claude Code interface');

  const alive = await call(`/api/sessions/${claudeId}`);
  check(alive.body.status === 'running', 'claude session still running and attached');

  console.log('\n  ---- first 400 chars of rendered Claude output ----');
  console.log(
    plain
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 12)
      .map((l) => '  | ' + l.slice(0, 100))
      .join('\n'),
  );
  console.log('  ---------------------------------------------------');

  await claudeSock.close();
  await call(`/api/sessions/${claudeId}`, { method: 'DELETE' });
}

heading('Session list shows both sessions with final states');
{
  const { body } = await call('/api/sessions');
  const shell = body.sessions.find((s) => s.id === shellId);
  const claude = body.sessions.find((s) => s.id === claudeId);
  check(!!shell && !!claude, 'both sessions listed', `${body.sessions.length} total`);
  check(shell.agent === 'shell' && claude.agent === 'claude', 'agent types recorded');
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
