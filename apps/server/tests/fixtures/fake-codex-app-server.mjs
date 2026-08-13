#!/usr/bin/env node
// A stand-in for `codex app-server --stdio` used by codex-session.test.ts and
// sessions.test.ts. Real codex needs a live ChatGPT/API login and burns real
// usage — this fixture implements just enough of the documented JSON-RPC
// contract (captured live against the real, installed CLI v0.147.0,
// including a genuine approval round trip that blocked a command until
// replied to) to exercise CodexServerManager/CodexSession end to end.
import readline from 'node:readline';
import crypto from 'node:crypto';

const threads = new Map(); // threadId -> { cwd }
const pendingAborts = new Map(); // threadId -> flag object
let nextServerRequestId = 0;
const approvalWaiters = new Map(); // requestId -> resolve(decision)

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params });
}

/** A server->client request (an approval). Resolves once the client replies with the matching id. */
function requestApproval(method, params) {
  const id = nextServerRequestId++;
  write({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => approvalWaiters.set(id, resolve));
}

async function runTurn(threadId, text) {
  const flag = { aborted: false };
  pendingAborts.set(threadId, flag);

  notify('item/started', {
    threadId,
    item: { type: 'userMessage', id: `msg_u_${crypto.randomUUID()}`, content: [{ type: 'text', text }] },
  });
  notify('item/completed', {
    threadId,
    item: { type: 'userMessage', id: `msg_u_${crypto.randomUUID()}`, content: [{ type: 'text', text }] },
  });

  if (text === 'FAIL') {
    await sleep(10);
    if (flag.aborted) return;
    notify('error', { threadId, error: { message: 'simulated failure' } });
    finishTurn(threadId, flag);
    return;
  }

  const commandId = `exec-${crypto.randomUUID()}`;
  notify('item/started', {
    threadId,
    item: { type: 'commandExecution', id: commandId, command: 'echo hi', cwd: threads.get(threadId)?.cwd ?? '', status: 'inProgress' },
  });
  await sleep(10);
  if (flag.aborted) return;

  if (text === 'NEEDS_PERMISSION') {
    const decision = await requestApproval('item/commandExecution/requestApproval', {
      threadId,
      turnId: 'turn_1',
      itemId: commandId,
      reason: 'Allow running echo hi?',
      command: 'echo hi',
      cwd: threads.get(threadId)?.cwd ?? '',
    });
    if (flag.aborted) return;
    if (decision !== 'accept' && decision !== 'acceptForSession') {
      notify('item/completed', {
        threadId,
        item: { type: 'commandExecution', id: commandId, command: 'echo hi', status: 'failed', aggregatedOutput: 'declined' },
      });
      finishTurn(threadId, flag);
      return;
    }
  }

  if (text === 'SLOW') {
    await sleep(5000);
    if (flag.aborted) return;
  }

  notify('item/completed', {
    threadId,
    item: { type: 'commandExecution', id: commandId, command: 'echo hi', status: 'completed', aggregatedOutput: 'hi\n' },
  });

  const agentMsgId = `msg_a_${crypto.randomUUID()}`;
  notify('item/started', { threadId, item: { type: 'agentMessage', id: agentMsgId, text: '', phase: 'final_answer' } });
  notify('item/agentMessage/delta', { threadId, itemId: agentMsgId, delta: `echo: ${text}` });
  notify('item/completed', { threadId, item: { type: 'agentMessage', id: agentMsgId, text: `echo: ${text}`, phase: 'final_answer' } });

  notify('thread/tokenUsage/updated', { threadId, turnId: 'turn_1', tokenUsage: { last: { inputTokens: 10, outputTokens: 5 } } });
  finishTurn(threadId, flag);
}

function finishTurn(threadId, flag) {
  if (flag.aborted) return;
  notify('turn/completed', { threadId, turn: { id: 'turn_1', items: [], status: 'completed', error: null, durationMs: 5 } });
  pendingAborts.delete(threadId);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // A reply to one of our own server->client requests (an approval decision).
  if (typeof msg.id === 'number' && msg.method === undefined) {
    const waiter = approvalWaiters.get(msg.id);
    if (waiter) {
      approvalWaiters.delete(msg.id);
      waiter(msg.result?.decision);
    }
    return;
  }

  // A client->server request (has both id and method).
  if (msg.method && msg.id !== undefined) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
      return respond(id, { userAgent: 'fake-codex/0.0.1', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' });
    }
    if (method === 'thread/start') {
      const threadId = `thread_test${threads.size + 1}`;
      threads.set(threadId, { cwd: params.cwd ?? '' });
      return respond(id, { thread: { id: threadId, sessionId: threadId, status: { type: 'idle' } } });
    }
    if (method === 'thread/resume') {
      const threadId = params.threadId;
      if (!threads.has(threadId)) threads.set(threadId, { cwd: '' });
      return respond(id, { thread: { id: threadId, sessionId: threadId, status: { type: 'idle' } } });
    }
    if (method === 'turn/start') {
      respond(id, { turn: { id: 'turn_1', items: [], status: 'inProgress' } });
      const text = params.input?.find((p) => p.type === 'text')?.text ?? '';
      void runTurn(params.threadId, text);
      return;
    }
    if (method === 'turn/interrupt') {
      const flag = pendingAborts.get(params.threadId);
      if (flag) flag.aborted = true;
      return respond(id, {});
    }

    // Below: just enough canned data for each slash-command RPC in
    // `CodexSession.dispatchSlashCommand` to exercise its real formatting
    // logic in codex-session.test.ts, rather than falling through to the
    // catch-all `respond(id, {})` (which would still be a valid response for
    // methods this fixture does not need to shape data for).
    if (method === 'thread/read') {
      const t = threads.get(params.threadId) ?? { cwd: '' };
      return respond(id, {
        thread: { id: params.threadId, name: 'Test thread', cwd: t.cwd, status: 'active', cliVersion: '0.147.0-test', gitInfo: { branch: 'main' } },
      });
    }
    if (method === 'model/list') {
      return respond(id, {
        data: [
          { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'General purpose', isDefault: true },
          { id: 'gpt-5.6-fast', displayName: 'GPT-5.6 Fast', description: 'Faster, less thorough', isDefault: false },
        ],
      });
    }
    if (method === 'skills/list') {
      return respond(id, { data: [{ cwd: '', errors: [], skills: [{ name: 'commit-helper', description: 'Writes commit messages', enabled: true }] }] });
    }
    if (method === 'hooks/list') {
      return respond(id, { data: [{ cwd: '', errors: [], warnings: [], hooks: [{ key: 'pre-commit', eventName: 'beforeCommit', enabled: true }] }] });
    }
    if (method === 'mcpServerStatus/list') {
      return respond(id, { data: [{ name: 'filesystem', authStatus: 'unsupported', tools: { read_file: {}, write_file: {} } }] });
    }
    if (method === 'permissionProfile/list') {
      return respond(id, { data: [{ id: 'default', description: 'Default sandbox profile', allowed: true }] });
    }
    if (method === 'thread/backgroundTerminals/list') {
      return respond(id, { data: [{ command: 'npm run dev', cwd: '/tmp/project', itemId: 'term_1', processId: 'p1', osPid: 4242 }] });
    }
    if (method === 'account/usage/read') {
      return respond(id, { summary: { lifetimeTokens: 123456, currentStreakDays: 3, longestStreakDays: 10, peakDailyTokens: 5000 } });
    }
    if (method === 'plugin/list') {
      return respond(id, { marketplaces: [{ name: 'official', plugins: [{}, {}] }] });
    }
    if (method === 'review/start') {
      respond(id, { reviewThreadId: params.threadId, turn: { id: 'turn_review', items: [], status: 'inProgress' } });
      void (async () => {
        await sleep(10);
        notify('item/started', { threadId: params.threadId, item: { type: 'agentMessage', id: 'msg_review', text: '', phase: 'final_answer' } });
        notify('item/completed', { threadId: params.threadId, item: { type: 'agentMessage', id: 'msg_review', text: 'Looks fine.', phase: 'final_answer' } });
        notify('turn/completed', { threadId: params.threadId, turn: { id: 'turn_review', items: [], status: 'completed', error: null, durationMs: 5 } });
      })();
      return;
    }

    return respond(id, {});
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
