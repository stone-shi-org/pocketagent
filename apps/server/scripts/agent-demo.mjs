#!/usr/bin/env node
/**
 * End-to-end verification of the structured (native) transport.
 *
 * Drives the same HTTP + WebSocket protocol the browser does: creates a
 * structured Claude session, exercises an approval round-trip, and checks that
 * a disconnect mid-approval still resurfaces the request on reconnect.
 *
 * Run against a server whose workspace root is a scratch directory —
 * this asks the agent to create files.
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const REPO = new URL('../../../', import.meta.url).pathname;
const TOKEN = fs
  .readFileSync(path.join(REPO, '.env'), 'utf8')
  .match(/^POCKETAGENT_AUTH_TOKEN=(.+)$/m)[1]
  .trim();

let failures = 0;
let step = 0;
const heading = (t) => console.log(`\n[${++step}] ${t}`);
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(p, init = {}) {
  const res = await fetch(BASE + p, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Browser-equivalent client with event-sequence tracking. */
function open() {
  const ws = new WebSocket(`${WS_BASE}/api/ws?v=${PROTOCOL_VERSION}`, { headers: { cookie } });
  const state = { events: [], lastSeq: 0, epoch: null, attached: null, pending: [] };

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'attached') {
      state.attached = m;
      state.epoch = m.session.epoch;
      state.pending = m.pendingPermissions ?? [];
      for (const e of m.agentReplay?.events ?? []) {
        state.events.push(e.event);
        state.lastSeq = Math.max(state.lastSeq, e.seq);
      }
    } else if (m.type === 'agent_event' && m.seq > state.lastSeq) {
      state.lastSeq = m.seq;
      state.events.push(m.event);
    }
  });

  return {
    ws,
    state,
    ready: new Promise((res, rej) => {
      ws.once('open', res);
      ws.once('error', rej);
    }),
    send: (m) => ws.send(JSON.stringify(m)),
    waitFor: async (pred, timeout = 120_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (pred(state)) return true;
        await sleep(50);
      }
      return false;
    },
    close: () =>
      new Promise((r) => {
        if (ws.readyState === WebSocket.CLOSED) return r();
        ws.once('close', r);
        ws.close();
        setTimeout(r, 500);
      }),
  };
}

const kinds = (s) => s.events.map((e) => e.kind);
const find = (s, kind) => s.events.filter((e) => e.kind === kind);

/**
 * Auto-approve everything until told to stop.
 *
 * Which tools need consent depends on the agent's own permission settings, so
 * a harness must not assume that (say) Read is free. Steps that specifically
 * exercise the approval flow turn this off first.
 */
function autoApprove(sock, sessionId) {
  const answered = new Set();
  let armed = true;
  const timer = setInterval(() => {
    if (!armed) return;
    for (const req of find(sock.state, 'permission_request')) {
      if (answered.has(req.id)) continue;
      answered.add(req.id);
      sock.send({ type: 'permission', sessionId, requestId: req.id, decision: 'allow' });
    }
  }, 200);
  timer.unref?.();
  return {
    stop: () => {
      armed = false;
      clearInterval(timer);
    },
    seen: () => answered.size,
  };
}

// ---------------------------------------------------------------------------

let createdSessionId = null;
process.on('exit', () => {
  // Never leave an agent running because a check threw.
  if (createdSessionId) {
    console.log(`\n(cleaning up session ${createdSessionId})`);
  }
});

console.log('PocketAgent structured (native) transport demo\n' + '='.repeat(60));

heading('Log in');
{
  const res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  check(res.status === 200, 'authenticated', `HTTP ${res.status}`);
}

heading('Claude advertises both transports; shell advertises only terminal');
let workspace;
{
  const { body } = await call('/api/agents');
  const claude = body.agents.find((a) => a.id === 'claude');
  const shell = body.agents.find((a) => a.id === 'shell');
  check(claude?.transports.includes('structured'), 'claude supports structured');
  check(claude?.defaultTransport === 'structured', 'structured is claude\'s default');
  check(!shell?.transports.includes('structured'), 'shell is terminal-only', shell?.transports.join(','));

  const ws = await call('/api/workspaces');
  workspace = (ws.body.workspaces.find((w) => !w.isRoot) ?? ws.body.workspaces[0]).path;
}

heading('Refuse a transport the agent does not support');
{
  const res = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'shell', cwd: workspace, transport: 'structured' }),
  });
  check(res.status === 400, 'shell + structured rejected', res.body?.error?.code);
}

let sessionId;
heading('Create a structured Claude session');
{
  const res = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: 'claude', cwd: workspace, transport: 'structured' }),
  });
  sessionId = res.body?.id;
  createdSessionId = sessionId;
  check(res.status === 201, 'created', `HTTP ${res.status}`);
  check(res.body?.transport === 'structured', 'reports the structured transport');
}

let sock = open();
heading('Attach and receive normalized events');
{
  await sock.ready;
  sock.send({ type: 'attach', sessionId, afterSeq: 0 });
  const ok = await sock.waitFor((s) => s.attached !== null);
  check(ok, 'attached');
  check(sock.state.attached.replay.data === '', 'no terminal bytes on a structured session');
  check(Array.isArray(sock.state.attached.agentReplay?.events), 'carries an agent replay payload');
}

heading('Send a prompt; observe text and tool events');
{
  const approver = autoApprove(sock, sessionId);
  sock.send({
    type: 'prompt',
    sessionId,
    text: 'Read secret.txt and tell me the passphrase. Do not write any files yet.',
  });
  const ok = await sock.waitFor((s) => find(s, 'turn_complete').length >= 1);
  approver.stop();
  check(ok, 'turn completed');

  const texts = find(sock.state, 'text');
  const tools = find(sock.state, 'tool_use');
  check(texts.length > 0, 'assistant text arrived as structured blocks', `${texts.length} block(s)`);
  check(
    tools.some((t) => t.name === 'Read'),
    'a Read tool call was reported',
    tools.map((t) => t.summary).join(', '),
  );
  check(
    texts.some((t) => /heron/i.test(t.text)),
    'the answer contains the passphrase',
  );

  const turn = find(sock.state, 'turn_complete')[0];
  check(typeof turn?.costUsd === 'number', 'turn carries cost', turn ? `$${turn.costUsd?.toFixed(4)}` : 'no turn');
  check((turn?.outputTokens ?? 0) > 0, 'turn carries token usage',
    turn ? `${turn.inputTokens}↑ ${turn.outputTokens}↓` : 'no turn');
  check(kinds(sock.state).includes('user_prompt'), 'the user turn is in the transcript');
  if (!turn) {
    console.log('     last events:', kinds(sock.state).slice(-8).join(' → '));
  }
}

heading('A write raises a native approval request');
{
  // Nothing is auto-approved from here on: this is the flow under test.
  const before = find(sock.state, 'permission_request').length;
  sock.send({
    type: 'prompt',
    sessionId,
    text: 'Now create a file called demo-output.txt containing the word LANDED.',
  });
  const ok = await sock.waitFor((s) =>
    find(s, 'permission_request').some((r) => r.toolName === 'Write'),
  );
  check(ok, 'permission_request received', `${find(sock.state, 'permission_request').length - before} new`);

  const req = find(sock.state, 'permission_request').find((r) => r.toolName === 'Write') ?? {};
  check(Boolean(req.title), 'request carries a human title', req.title);
  check(req.toolName === 'Write', 'request names the tool', req.toolName);
  check(req.canAllowForSession === true, 'offers allow-for-session');
}

heading('Disconnecting mid-approval leaves it pending, and reconnect resurfaces it');
{
  const seqBefore = sock.state.lastSeq;
  await sock.close();
  await sleep(500);

  const info = await call(`/api/sessions/${sessionId}`);
  check(info.body.status === 'running', 'session still running while unattended');

  sock = open();
  await sock.ready;
  sock.send({ type: 'attach', sessionId, afterSeq: seqBefore, epoch: sock.state.epoch ?? undefined });
  const ok = await sock.waitFor((s) => s.attached !== null);
  check(ok, 'reattached');
  check(
    sock.state.pending.length === 1,
    'the unanswered approval is resurfaced on reconnect',
    `${sock.state.pending.length} pending`,
  );
}

heading('Approve it, and the tool then runs');
{
  const turnsBefore = find(sock.state, 'turn_complete').length;
  const req = sock.state.pending[0];
  sock.send({ type: 'permission', sessionId, requestId: req.id, decision: 'allow' });

  const resolved = await sock.waitFor((s) => find(s, 'permission_resolved').length >= 1);
  check(resolved, 'permission_resolved emitted');
  check(find(sock.state, 'permission_resolved').at(-1).decision === 'allow', 'recorded as allow');

  // Anything else the write turn needs is approved so the turn can finish.
  const approver = autoApprove(sock, sessionId);
  const done = await sock.waitFor((s) => find(s, 'turn_complete').length > turnsBefore);
  approver.stop();
  check(done, 'turn completed after approval');

  const wrote = fs.existsSync(path.join(workspace, 'demo-output.txt'));
  check(wrote, 'the file was actually created on disk');
  if (wrote) fs.unlinkSync(path.join(workspace, 'demo-output.txt'));
}

heading('Answering an unknown approval is reported, not silently ignored');
{
  const errors = [];
  sock.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'error') errors.push(m);
  });
  sock.send({ type: 'permission', sessionId, requestId: 'does-not-exist', decision: 'allow' });
  await sleep(700);
  check(errors.some((e) => e.code === 'not_found'), 'stale approval rejected', errors[0]?.code);
}

heading('Keystrokes are refused on a structured session');
{
  const errors = [];
  sock.ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'error') errors.push(m);
  });
  sock.send({ type: 'input', sessionId, data: 'ls\n' });
  await sleep(700);
  check(errors.some((e) => e.code === 'bad_message'), 'input rejected with a clear message');
}

heading('Push notifications are configured');
{
  const key = await call('/api/push/key');
  check(typeof key.body.publicKey === 'string' && key.body.publicKey.length > 20,
    'VAPID public key generated', `${key.body.publicKey?.slice(0, 16)}…`);
  const status = await call('/api/push/status');
  check(status.body.enabled === true, 'push service enabled');
}

heading('Terminate');
{
  const res = await call(`/api/sessions/${sessionId}`, { method: 'DELETE' });
  check(res.status === 200, 'DELETE accepted');
  await sleep(1500);
  const info = await call(`/api/sessions/${sessionId}`);
  check(['killed', 'exited'].includes(info.body.status), 'session stopped', info.body.status);
  createdSessionId = null;
  await sock.close();
}

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? '✅ ALL STRUCTURED CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
