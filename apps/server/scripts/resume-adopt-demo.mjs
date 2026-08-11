#!/usr/bin/env node
/**
 * End-to-end verification of the two "take over what already exists" paths.
 *
 *   Path 3 — resume a Claude Code conversation that was started in a terminal,
 *            branching onto a new transcript so the original is only read.
 *   Path 1 — attach to a tmux pane the user started themselves, and leave it
 *            running when we let go.
 *
 * Both are checked against the real thing: a real transcript written by the
 * real CLI, and a real tmux server standing in for the user's own.
 *
 * Expects a server whose workspace root is the scratch directory below and
 * whose POCKETAGENT_ADOPT_TMUX_SOCKET is USER_SOCKET.
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8788';
const WS_BASE = BASE.replace(/^http/, 'ws');
const WORKSPACE = process.env.PA_WORKSPACE ?? '/tmp/pa-verify';
const PROJECT = path.join(WORKSPACE, 'project');
const USER_SOCKET = process.env.PA_USER_SOCKET ?? 'pa-verify-user';
const TOKEN = process.env.PA_TOKEN;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', PROJECT.replace(/\//g, '-'));

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

const tmux = (...args) =>
  execFileSync('tmux', ['-L', USER_SOCKET, ...args], { encoding: 'utf8' }).trim();

function transcripts() {
  try {
    return fs
      .readdirSync(PROJECTS_DIR)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const file = path.join(PROJECTS_DIR, f);
        return {
          id: path.basename(f, '.jsonl'),
          md5: crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'),
          lines: fs.readFileSync(file, 'utf8').trimEnd().split('\n').length,
        };
      });
  } catch {
    return [];
  }
}

/** Browser-equivalent socket for both transports. */
function open() {
  const ws = new WebSocket(`${WS_BASE}/api/ws?v=${PROTOCOL_VERSION}`, { headers: { cookie } });
  const state = { events: [], output: '', lastSeq: 0, attached: null };

  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.type === 'attached') {
      state.attached = m;
      for (const e of m.agentReplay?.events ?? []) state.events.push(e.event);
      if (m.replay) state.output += m.replay.data;
    } else if (m.type === 'agent_event') {
      state.events.push(m.event);
    } else if (m.type === 'output') {
      state.output += m.data;
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

const find = (s, kind) => s.events.filter((e) => e.kind === kind);

function autoApprove(sock, sessionId) {
  const answered = new Set();
  const timer = setInterval(() => {
    for (const req of find(sock.state, 'permission_request')) {
      if (answered.has(req.id)) continue;
      answered.add(req.id);
      sock.send({ type: 'permission', sessionId, requestId: req.id, decision: 'allow' });
    }
  }, 200);
  timer.unref?.();
  return { stop: () => clearInterval(timer), seen: () => answered.size };
}

// ---------------------------------------------------------------------------

const created = [];

async function main() {
  heading('Log in');
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token: TOKEN }),
  });
  check(login.status === 200, 'authenticated', `status ${login.status}`);

  // ---- Path 3: resume ------------------------------------------------------

  heading('Discover conversations already on disk');
  const before = transcripts();
  check(before.length >= 1, 'a real transcript exists to resume', `${before.length} file(s)`);
  const original = before[0];

  const list = await call('/api/conversations');
  check(list.status === 200, 'GET /api/conversations', `status ${list.status}`);
  const conv = list.body.conversations.find((c) => c.id === original.id);
  check(conv !== undefined, 'the conversation is listed', conv?.title);
  check(conv?.cwd === PROJECT, 'its working directory is inside the workspace root', conv?.cwd);
  check(typeof conv?.probablyLive === 'boolean', 'liveness is reported, not assumed');

  heading('Resume it from "mobile" — branching by default');
  const session = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: 'claude',
      cwd: PROJECT,
      // No cols/rows: a structured session has no character grid.
      transport: 'structured',
      resumeAgentSessionId: original.id,
      // forkSession omitted on purpose: the default must be the safe one.
    }),
  });
  check(session.status === 201, 'session created', `status ${session.status}`);
  const sessionId = session.body?.id;
  if (sessionId) created.push(sessionId);
  check(session.body?.transport === 'structured', 'runs on the structured transport');
  check(
    session.body?.agentSessionId === original.id,
    'reports which conversation it came from',
    session.body?.agentSessionId,
  );

  heading('Ask it something that requires the resumed history');
  const sock = open();
  await sock.ready;
  sock.send({ type: 'attach', sessionId });
  check(await sock.waitFor((s) => s.attached !== null, 20_000), 'attached over WebSocket');
  const approvals = autoApprove(sock, sessionId);

  sock.send({
    type: 'prompt',
    sessionId,
    text: 'What exact word did I ask you to reply with earlier? Answer with just that word.',
  });
  const done = await sock.waitFor((s) => find(s, 'turn_complete').length > 0, 180_000);
  check(done, 'the turn completed');
  approvals.stop();

  const said = find(sock.state, 'text')
    .map((e) => e.text)
    .join('\n');
  check(
    said.includes('VERIFY_ORIGINAL'),
    'it remembers the earlier turn, so the resume was real',
    said.slice(0, 80).replace(/\n/g, ' '),
  );

  heading('The original transcript must be untouched');
  const after = transcripts();
  const originalNow = after.find((t) => t.id === original.id);
  check(originalNow !== undefined, 'the original file still exists');
  check(
    originalNow?.md5 === original.md5,
    'byte-for-byte identical after the resume',
    `${original.lines} lines, md5 ${original.md5.slice(0, 8)}`,
  );
  const fresh = after.filter((t) => !before.some((b) => b.id === t.id));
  check(fresh.length === 1, 'exactly one new transcript was branched off', fresh[0]?.id);
  check(
    (fresh[0]?.lines ?? 0) > (original.lines ?? 0),
    'the branch carries the original history plus the new turn',
    `${original.lines} → ${fresh[0]?.lines} lines`,
  );

  await sock.close();
  await call(`/api/sessions/${sessionId}`, { method: 'DELETE' });

  // ---- Path 1: adopt -------------------------------------------------------

  heading("Start a tmux session as if the user had, in their own terminal");
  try {
    tmux('kill-server');
  } catch {
    /* none running */
  }
  execFileSync('tmux', [
    '-L', USER_SOCKET, '-f', '/dev/null',
    'new-session', '-d', '-s', 'mywork', '-c', PROJECT, '-x', '110', '-y', '32',
    '--', '/bin/bash', '--norc', '--noprofile', '-i',
  ]);
  await sleep(800);
  check(tmux('list-sessions', '-F', '#{session_name}').includes('mywork'), 'the user has a session');

  heading('It shows up as adoptable');
  const adoptable = await call('/api/adoptable');
  check(adoptable.body?.enabled === true, 'adoption is enabled on this server');
  const target = adoptable.body?.targets?.find((t) => t.sessionName === 'mywork');
  check(target !== undefined, 'the pane is offered', `${target?.command} · ${target?.cwd}`);
  check(target?.cols === 110 && target?.rows === 32, 'at its real size', `${target?.cols}×${target?.rows}`);
  check(!/mywork/.test(target?.id ?? ''), 'behind an opaque id, not a raw tmux target', target?.id);

  heading('Attach to it from the browser');
  const adopted = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: 'shell',
      cwd: PROJECT,
      cols: 80,
      rows: 24,
      adoptTargetId: target.id,
    }),
  });
  check(adopted.status === 201, 'session created', `status ${adopted.status}`);
  const adoptedId = adopted.body?.id;
  if (adoptedId) created.push(adoptedId);
  check(adopted.body?.adopted === true, 'flagged as adopted, so the UI can warn');
  check(
    adopted.body?.cols === 110 && adopted.body?.rows === 32,
    "keeps the pane's size instead of imposing the phone's",
    `${adopted.body?.cols}×${adopted.body?.rows}`,
  );
  check(adopted.body?.backend === 'direct', 'the attach client is our own child');

  const term = open();
  await term.ready;
  term.send({ type: 'attach', sessionId: adoptedId });
  check(await term.waitFor((s) => s.attached !== null, 20_000), 'attached over WebSocket');
  term.send({ type: 'input', sessionId: adoptedId, data: 'echo FROM_THE_PHONE\r' });
  check(
    await term.waitFor((s) => s.output.includes('FROM_THE_PHONE'), 20_000),
    'typing from the browser drives the same shell',
  );
  check(Number(tmux('list-sessions', '-F', '#{session_attached}')) >= 1, 'tmux sees a client');

  heading('Letting go must not take the user\'s work with it');
  const panePid = Number(tmux('list-panes', '-a', '-F', '#{pane_pid}').split('\n')[0]);
  await term.close();
  const del = await call(`/api/sessions/${adoptedId}`, { method: 'DELETE' });
  check(del.status === 200, 'session terminated', `status ${del.status}`);
  await sleep(1500);

  let stillThere = true;
  try {
    tmux('has-session', '-t', '=mywork');
  } catch {
    stillThere = false;
  }
  check(stillThere, "the user's tmux session survived");
  check(Number(tmux('list-sessions', '-F', '#{session_attached}')) === 0, 'we simply detached');
  let paneAlive = true;
  try {
    process.kill(panePid, 0);
  } catch {
    paneAlive = false;
  }
  check(paneAlive, 'their shell is still the same process', `pid ${panePid}`);

  try {
    tmux('kill-server');
  } catch {
    /* already gone */
  }
}

main()
  .catch((err) => {
    failures++;
    console.error('\nFATAL:', err);
  })
  .finally(async () => {
    for (const id of created) {
      await call(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
    }
    console.log(
      failures === 0
        ? `\n✅ all ${step} steps passed`
        : `\n❌ ${failures} check(s) failed across ${step} steps`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
