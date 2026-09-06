#!/usr/bin/env node
/**
 * End-to-end verification of the Claude Code third-party variants (PA-19).
 *
 * This is the demo that proves the *point* of the feature rather than its
 * parts: a conversation is started on one provider, stopped, and continued on
 * another, and the second provider is asked to recall something only the first
 * one was told. If that answer comes back, the transcript really is shared
 * across the provider boundary — which is the entire premise, and the one
 * thing no unit test can establish, since it depends on the real CLI's on-disk
 * transcript layout and two real APIs.
 *
 * Run against a scratch server whose workspace root is a throwaway directory:
 * this starts real agents and writes real transcripts under `~/.claude`.
 *
 *   PA_BASE=http://127.0.0.1:8799 node scripts/deepseek-variant-demo.mjs
 */
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@pocketagent/protocol';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.PA_BASE ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const CWD = process.env.PA_CWD ?? '/tmp/pa19-ws/proj';
const REPO = new URL('../../../', import.meta.url).pathname;
const TOKEN = fs
  .readFileSync(path.join(REPO, '.env'), 'utf8')
  .match(/^POCKETAGENT_AUTH_TOKEN=(.+)$/m)[1]
  .trim();

let failures = 0;
let step = 0;
const heading = (t) => console.log(`\n[${++step}] ${t}`);
const check = (cond, label, detail = '') => {
  if (cond) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

let cookie = '';
async function call(p, init = {}) {
  const res = await fetch(BASE + p, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      origin: BASE,
      ...init.headers,
    },
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * Send one prompt and wait for the turn to finish.
 *
 * Subscribes before prompting, the same ordering `RunExecutor` is careful
 * about: attaching after the prompt races the first events.
 */
function runTurn(sessionId, prompt, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/api/ws?v=${PROTOCOL_VERSION}`, { headers: { cookie } });
    const texts = [];
    let model = null;
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve({ texts, model, reason });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', sessionId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'attached') {
        ws.send(JSON.stringify({ type: 'prompt', sessionId, text: prompt }));
        return;
      }
      const events = m.type === 'agent_event' ? [m.event] : [];
      for (const e of events) {
        if (e.kind === 'text' && e.text) texts.push(e.text);
        if (e.kind === 'session_started' && e.model) model = e.model;
        if (e.kind === 'turn_complete') {
          clearTimeout(timer);
          finish('turn_complete');
        }
      }
    });
    ws.on('error', () => finish('ws_error'));
  });
}

const reply = (r) => r.texts.join(' ').replace(/\s+/g, ' ').trim();

async function main() {
  console.log(`PA-19 variant demo against ${BASE}, cwd ${CWD}`);
  await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ token: TOKEN }) });

  heading('The variants are registered, available, and carry their own catalogs');
  const { body: agentsBody } = await call('/api/agents');
  const byId = Object.fromEntries(agentsBody.agents.map((a) => [a.id, a]));
  check(byId['claude-deepseek']?.available === true, 'claude-deepseek is available');
  check(
    byId['claude-deepseek']?.cachedModels?.some((m) => m.value === 'deepseek-chat'),
    'its catalog is the adapter’s own, not Anthropic’s',
    JSON.stringify(byId['claude-deepseek']?.cachedModels?.map((m) => m.value)),
  );
  check(
    typeof byId['claude-deepseek']?.providerDisclosure === 'string',
    'it carries a standing disclosure',
  );

  heading('Stock claude is untouched');
  check(byId.claude?.providerDisclosure === null, 'claude has no disclosure');
  check(agentsBody.agents[0].id === 'claude', 'claude is still first in the roster');

  heading('The unattended paths refuse the variant');
  const cron = await call('/api/cron/jobs', {
    method: 'POST',
    body: JSON.stringify({
      name: 'pa19 should not exist',
      cwd: CWD,
      agent: 'claude-deepseek',
      prompt: 'hi',
      cronExpr: '0 3 * * *',
      timezone: 'UTC',
    }),
  });
  check(cron.status >= 400, 'POST /api/cron/jobs rejects claude-deepseek', `status ${cron.status}`);

  heading('Start a conversation on real Anthropic and tell it a secret');
  const secret = `PA19-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const first = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: 'claude',
      cwd: CWD,
      cols: 80,
      rows: 24,
      transport: 'structured',
      skipPermissions: true,
      title: 'PA-19 cross-provider',
    }),
  });
  check(first.status === 200 || first.status === 201, 'created a claude session', `status ${first.status}`);
  const anthropicSession = first.body.id;
  const t1 = await runTurn(
    anthropicSession,
    `Remember this token: ${secret}. Reply with just the word ACK.`,
  );
  check(t1.reason === 'turn_complete', 'the Anthropic turn completed', t1.reason);
  console.log(`      model: ${t1.model}`);
  console.log(`      reply: ${reply(t1).slice(0, 120)}`);

  const { body: info } = await call(`/api/sessions/${anthropicSession}`);
  const conversationId = info.agentSessionId;
  check(!!conversationId, 'the session has an agentSessionId to resume from', conversationId);
  check(info.providerDisclosure === null, 'a stock claude session shows no disclosure');

  heading('Stop it, the way a rate-limited user would');
  await call(`/api/sessions/${anthropicSession}`, { method: 'DELETE' });

  heading('Continue THE SAME conversation as Claude Code (DeepSeek)');
  const second = await call('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      // The entire server contract for this feature is this one field.
      agent: 'claude-deepseek',
      cwd: CWD,
      cols: 80,
      rows: 24,
      transport: 'structured',
      resumeAgentSessionId: conversationId,
      forkSession: false,
      skipPermissions: true,
      title: 'PA-19 cross-provider',
    }),
  });
  check(second.status === 200 || second.status === 201, 'created the variant session', `status ${second.status}`);
  const dsSession = second.body.id;
  check(
    typeof second.body.providerDisclosure === 'string' &&
      second.body.providerDisclosure.includes('DeepSeek'),
    'the resumed session discloses its provider persistently',
  );

  const t2 = await runTurn(dsSession, 'What token did I ask you to remember? Reply with just the token.');
  check(t2.reason === 'turn_complete', 'the DeepSeek turn completed', t2.reason);
  console.log(`      model: ${t2.model}`);
  console.log(`      reply: ${reply(t2).slice(0, 160)}`);

  check(
    reply(t2).includes(secret),
    'DeepSeek recalled the secret Anthropic was told — the transcript is shared',
    `expected ${secret}`,
  );

  const { body: dsInfo } = await call(`/api/sessions/${dsSession}`);
  check(
    dsInfo.agentSessionId === conversationId,
    'it appended to the same conversation rather than forking',
    `${dsInfo.agentSessionId} vs ${conversationId}`,
  );

  heading('The transcript on disk holds both providers');
  // Stop the session first, then poll. `turn_complete` means the *turn* is
  // done, not that the CLI has flushed its transcript — reading immediately
  // races the write and intermittently sees only the Anthropic half.
  await call(`/api/sessions/${dsSession}`, { method: 'DELETE' });
  const file = path.join(
    process.env.HOME,
    '.claude',
    'projects',
    CWD.replace(/[/.]/g, '-'),
    `${conversationId}.jsonl`,
  );
  const readModels = () => {
    const models = new Set();
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line)?.message;
        if (m?.model) models.add(m.model);
      } catch {
        /* not a message line */
      }
    }
    return models;
  };
  let models = new Set();
  for (let i = 0; i < 30; i++) {
    try {
      models = readModels();
      if (models.size >= 2) break;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`      models in ${path.basename(file)}: ${[...models].join(', ')}`);
  check(models.size >= 2, 'one transcript, two providers');
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
