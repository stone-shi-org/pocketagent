#!/usr/bin/env node
/**
 * PA-66's acceptance criteria, against real processes.
 *
 * Needs no running server and no PA_BASE: it starts two real backends and a
 * real Hub itself, each with a throwaway data root, binds the backends through
 * the actual `hub-bind` handshake, and then drives a terminal session through
 * the proxy exactly as the browser would — same HTTP, same cookie, same
 * WebSocket frames.
 *
 * `pnpm build` first. Run with: pnpm demo:hub
 *
 * Why a demo rather than more unit tests: the hub suite uses a stub backend so
 * it can assert on raw bytes and on "was this even dialed". What it cannot
 * cover is a real PTY streaming through a real splice, a real reconnect with
 * replay across it, and a real backend dying underneath one — which is the
 * whole of criteria 2, 4 and 5.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';

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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-hub-demo-'));
const children = [];

const token = () => crypto.randomBytes(32).toString('base64url');
const HUB_TOKEN = token();
const HUB_ENC_KEY = crypto.randomBytes(32).toString('base64');
const BACKEND_TOKENS = { dev01: token(), dev02: token() };

function cleanup() {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.on('exit', cleanup);

async function waitForHealth(baseUrl, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  bad(`${label} never became healthy`);
  return false;
}

function startBackend(id, port) {
  // A throwaway data root and workspace, outside every real one — the
  // standing "never point a demo at the real database" rule.
  const dataDir = path.join(scratch, id, 'data');
  const workspace = path.join(scratch, id, 'workspace');
  const home = path.join(scratch, id, 'home');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const child = spawn(process.execPath, ['apps/server/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_AUTH_TOKEN: BACKEND_TOKENS[id],
      POCKETAGENT_WORKSPACE_ROOTS: workspace,
      POCKETAGENT_DATA_DIR: dataDir,
      POCKETAGENT_BACKEND: 'direct',
      POCKETAGENT_COOKIE_SECURE: 'false',
      POCKETAGENT_ADOPT_TMUX_SOCKET: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|fatal/i.test(text)) process.stderr.write(`[${id}] ${text}`);
  });
  children.push(child);
  return { id, port, baseUrl: `http://127.0.0.1:${port}`, workspace, child };
}

function startHub(port) {
  const dataDir = path.join(scratch, 'hub');
  fs.mkdirSync(dataDir, { recursive: true });
  const child = spawn(process.execPath, ['apps/hub/dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      LOG_LEVEL: 'warn',
      POCKETAGENT_HUB_HOST: '127.0.0.1',
      POCKETAGENT_HUB_PORT: String(port),
      POCKETAGENT_HUB_AUTH_TOKEN: HUB_TOKEN,
      POCKETAGENT_HUB_DATA_DIR: dataDir,
      POCKETAGENT_SETTINGS_ENC_KEY: HUB_ENC_KEY,
      POCKETAGENT_COOKIE_SECURE: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (/error|fatal/i.test(text)) process.stderr.write(`[hub] ${text}`);
  });
  children.push(child);
  return { baseUrl: `http://127.0.0.1:${port}`, child };
}

let hubCookie = '';
let hubBase = '';

async function hub(path, init = {}) {
  const response = await fetch(hubBase + path, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(hubCookie ? { cookie: hubCookie } : {}),
      ...init.headers,
    },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) hubCookie = setCookie.split(';')[0];
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** A browser-equivalent socket through the Hub, tracking replay sequence. */
function connect(hostPath) {
  const url = `${hubBase.replace(/^http/, 'ws')}${hostPath}/api/ws?v=${PROTOCOL_VERSION}`;
  const socket = new WebSocket(url, { headers: { cookie: hubCookie } });
  const state = { messages: [], output: '', lastSeq: 0, closed: false, closeCode: null };
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    state.messages.push(message);
    // `OutputMessage.data` is a plain string, not base64 — the replay buffer
    // is byte-oriented but the frame carries it as text.
    if (message.type === 'attached' && message.replay) {
      state.output += message.replay.data;
      state.lastSeq = Math.max(state.lastSeq, message.replay.toSeq);
    } else if (message.type === 'output' && message.seq > state.lastSeq) {
      state.lastSeq = message.seq;
      state.output += message.data;
    }
  });
  socket.on('close', (code) => {
    state.closed = true;
    state.closeCode = code;
  });
  return {
    state,
    open: () => new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(state)) return true;
        await sleep(50);
      }
      return false;
    },
  };
}

async function main() {
  console.log('PocketAgent Hub — PA-66 acceptance demo');
  console.log(`scratch: ${scratch}`);

  if (!fs.existsSync(path.join(REPO_ROOT, 'apps/hub/dist/server.js'))) {
    console.error('\napps/hub/dist is missing. Run `pnpm build` first.\n');
    process.exit(1);
  }

  heading('Start two backends and a Hub, all with throwaway state');
  const dev01 = startBackend('dev01', 18801);
  const dev02 = startBackend('dev02', 18802);
  const hubProc = startHub(18888);
  hubBase = hubProc.baseUrl;
  check(await waitForHealth(dev01.baseUrl, 'dev01'), 'dev01 up');
  check(await waitForHealth(dev02.baseUrl, 'dev02'), 'dev02 up');
  check(await waitForHealth(hubBase, 'hub'), 'hub up');

  heading('One login to the Hub (acceptance criterion 1)');
  const login = await hub('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token: HUB_TOKEN }),
  });
  check(login.status === 200, 'logged in to the Hub');
  const me = await hub('/api/auth/me');
  check(me.body?.authenticated === true, 'session established');

  heading('Register and bind both backends');
  for (const backend of [dev01, dev02]) {
    const created = await hub('/api/hub/hosts', {
      method: 'POST',
      body: JSON.stringify({ id: backend.id, label: backend.id, baseUrl: backend.baseUrl }),
    });
    check(created.status === 200, `${backend.id} registered`);
    const bound = await hub(`/api/hub/hosts/${backend.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({ token: BACKEND_TOKENS[backend.id], label: 'demo hub' }),
    });
    check(bound.status === 200, `${backend.id} bound`, bound.body?.host?.credentialPrefix ?? '');
  }

  heading('No per-host login prompt: both hosts answer from the one session');
  for (const backend of [dev01, dev02]) {
    const hosts = await hub(`/h/${backend.id}/api/hosts`);
    check(hosts.status === 200, `${backend.id} reachable through the proxy`);
  }

  heading('The hooks route is not routable through the Hub (criterion 3)');
  const hooks = await hub('/h/dev01/api/hooks/anything', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  check(hooks.status === 404, 'POST /h/dev01/api/hooks/anything refused', `status ${hooks.status}`);
  const encoded = await hub('/h/dev01/api/%68ooks/anything', { method: 'POST', body: '{}' });
  check(encoded.status === 404, 'the encoded spelling is refused too', `status ${encoded.status}`);

  heading('A terminal session end to end through the proxy (criterion 2)');
  const created = await hub('/h/dev01/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd: dev01.workspace, transport: 'terminal' }),
  });
  check(created.status === 200 || created.status === 201, 'session created through the proxy');
  const sessionId = created.body?.id;
  if (!sessionId) {
    bad('no session id returned', JSON.stringify(created.body).slice(0, 200));
  } else {
    const sock = connect('/h/dev01');
    await sock.open();
    sock.send({ type: 'attach', sessionId, afterSeq: 0, cols: 80, rows: 24 });
    check(
      await sock.waitFor((s) => s.messages.some((m) => m.type === 'attached')),
      'attached over the spliced WebSocket',
    );
    const marker = `hub-demo-${Date.now()}`;
    sock.send({ type: 'input', sessionId, data: `echo ${marker}\n` });
    check(
      await sock.waitFor((s) => s.output.includes(marker)),
      'PTY output streamed back through the splice',
    );

    heading('Reconnect and replay across the proxy');
    const seqBefore = sock.state.lastSeq;
    sock.close();
    await sleep(300);
    const again = connect('/h/dev01');
    await again.open();
    again.send({ type: 'attach', sessionId, afterSeq: seqBefore, cols: 80, rows: 24 });
    check(
      await again.waitFor((s) => s.messages.some((m) => m.type === 'attached')),
      'reattached to the same session through the Hub',
    );
    const marker2 = `hub-replay-${Date.now()}`;
    again.send({ type: 'input', sessionId, data: `echo ${marker2}\n` });
    check(
      await again.waitFor((s) => s.output.includes(marker2)),
      'session still live after the reconnect',
    );
    again.close();
  }

  heading('Health polling reports each host (criterion 5, first half)');
  await sleep(1200);
  const listed = await hub('/api/hub/hosts');
  const byId = Object.fromEntries((listed.body?.hosts ?? []).map((h) => [h.id, h]));
  check(byId.dev01?.status?.online === true, 'dev01 online', byId.dev01?.status?.version ?? '');
  check(byId.dev02?.status?.online === true, 'dev02 online', byId.dev02?.status?.version ?? '');
  check(byId.dev01?.isDefault === true, 'the first host registered is the default');

  heading('A backend that is down does not affect the others (criterion 4/5)');
  dev02.child.kill('SIGKILL');
  await sleep(1500);
  const afterKill = await hub('/api/hub/hosts');
  const killed = (afterKill.body?.hosts ?? []).find((h) => h.id === 'dev02');
  // The poller runs on a 30s cadence, so the row may still be reporting its
  // last good probe; what must be true immediately is that dev01 is unharmed.
  const survivor = await hub('/h/dev01/api/hosts');
  check(survivor.status === 200, 'dev01 unaffected by dev02 dying');
  const dead = await hub('/h/dev02/api/hosts');
  check(dead.status === 502, 'dev02 answers 502, not a hang', `status ${dead.status}`);
  check(killed !== undefined, 'dev02 still listed rather than disappearing');

  heading('Removing a host stops proxying immediately');
  const removed = await hub('/api/hub/hosts/dev02', { method: 'DELETE' });
  check(removed.status === 200, 'dev02 removed');
  const gone = await hub('/h/dev02/api/hosts');
  check(gone.status === 404, 'dev02 no longer routable', `status ${gone.status}`);

  heading('The bare root serves the default host (D6b)');
  // What makes the unmodified single-host bundle work through the Hub.
  const bare = await hub('/api/hosts');
  check(bare.status === 200, 'GET /api/hosts proxies to the default host');

  heading('Standalone still works: a backend reached directly (criterion 6)');
  const direct = await fetch(`${dev01.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: BACKEND_TOKENS.dev01 }),
  });
  const directCookie = (direct.headers.get('set-cookie') ?? '').split(';')[0];
  check(direct.status === 200, 'logged in to dev01 directly, with no Hub involved');
  const directHosts = await fetch(`${dev01.baseUrl}/api/hosts`, {
    headers: { cookie: directCookie },
  });
  check(directHosts.status === 200, 'dev01 behaves exactly as it does today');
  // Jira still delivers straight to the backend, so the route must remain
  // *reachable without authentication* there. An unknown slug answers 404 by
  // design — it is indistinguishable from a disabled webhook and a bad
  // signature — so what proves the route is alive is that it got past the
  // auth gate at all rather than answering 401.
  const directHooks = await fetch(`${dev01.baseUrl}/api/hooks/nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    directHooks.status !== 401,
    'the hooks route is still unauthenticated on the backend itself',
    `status ${directHooks.status}`,
  );
  // Through the Hub the same request is refused twice over, and the pair is
  // worth stating because the two refusals come from different places. With
  // no session the auth gate answers 401 *before* any routing happens — which
  // is also why an anonymous caller cannot use `/h/` to probe which hosts
  // exist, since every path under it answers the same way. With a valid
  // session it is a 404: not a route at all, and nothing was dialed. Step [5]
  // asserts the authenticated half; this is the anonymous one.
  const hubHooksAnon = await fetch(`${hubBase}/h/dev01/api/hooks/nope`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const hubUnknownAnon = await fetch(`${hubBase}/h/whatever/api/anything`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  check(
    hubHooksAnon.status === 401 && hubUnknownAnon.status === 401,
    'through the Hub, anonymous /h/** is refused uniformly before routing',
    `hooks ${hubHooksAnon.status}, unknown host ${hubUnknownAnon.status}`,
  );

  console.log(
    failures === 0
      ? '\nAll checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
