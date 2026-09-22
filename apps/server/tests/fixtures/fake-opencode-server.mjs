#!/usr/bin/env node
// A stand-in for `opencode serve` used by opencode-session.test.ts and
// sessions.test.ts. Real opencode needs a working model provider — network
// access this sandbox doesn't reliably have — so this fixture implements just
// enough of the documented HTTP + SSE contract (both v1 and v2) to exercise
// OpencodeServerManager/OpencodeSession end to end:
// session create, prompt + SSE-delivered response, a real permission
// round trip (gated on an actual reply, not just echoed back), interrupt/abort, and
// session.error / session.execution.failed.
import http from 'node:http';
import crypto from 'node:crypto';

const isV2 = process.env.OPENCODE_FIXTURE_VERSION === 'v2';
const FAKE_PASSWORD = 'fake-token';

let nextId = 1;
const sessions = new Map(); // id -> { directory, title }
const sseClients = new Set();
const pendingAborts = new Map(); // sessionID -> AbortController-ish flag object
const repliedWaiters = new Map(); // permissionID -> resolve()

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function broadcast(type, payloadData) {
  const id = `evt_${crypto.randomUUID()}`;
  const msg = isV2
    ? { id, type, data: payloadData }
    : { id, type, properties: payloadData };
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Simulates one assistant turn: a tool call, optionally gated on a real permission reply, then text + idle. */
async function runTurn(sessionID, text) {
  const flag = { aborted: false };
  pendingAborts.set(sessionID, flag);

  if (text === 'FAIL') {
    await new Promise((r) => setTimeout(r, 20));
    if (flag.aborted) return;
    if (isV2) {
      broadcast('session.execution.failed', { sessionID, error: { message: 'simulated failure' } });
    } else {
      broadcast('session.error', { sessionID, error: { name: 'UnknownError', data: { message: 'simulated failure' } } });
    }
    return;
  }

  const toolPartId = `prt_tool_${crypto.randomUUID()}`;
  if (isV2) {
    broadcast('session.tool.called', {
      id: toolPartId,
      sessionID,
      name: 'bash',
      input: { command: 'echo hi' },
    });
  } else {
    broadcast('message.part.updated', {
      sessionID,
      part: { id: toolPartId, sessionID, messageID: 'msg_a', type: 'tool', callID: toolPartId, tool: 'bash', state: { status: 'running', input: { command: 'echo hi' } } },
    });
  }
  await new Promise((r) => setTimeout(r, 10));
  if (flag.aborted) return;

  if (text === 'NEEDS_PERMISSION') {
    const permissionId = `per_${crypto.randomUUID()}`;
    if (isV2) {
      broadcast('permission.asked', {
        id: permissionId,
        sessionID,
        action: 'bash',
        title: 'Allow running echo hi?',
        message: 'Allow running echo hi?',
        metadata: { command: 'echo hi' },
      });
    } else {
      broadcast('permission.updated', {
        id: permissionId,
        type: 'bash',
        sessionID,
        messageID: 'msg_a',
        callID: toolPartId,
        title: 'Allow running echo hi?',
        metadata: { command: 'echo hi' },
        time: { created: Date.now() },
      });
    }
    // Real gating: wait for an actual reply, not a timer.
    await new Promise((resolve) => repliedWaiters.set(permissionId, resolve));
    if (flag.aborted) return;
  }

  if (text === 'SLOW') {
    await new Promise((r) => setTimeout(r, 5000));
    if (flag.aborted) return;
  }

  if (isV2) {
    broadcast('session.tool.success', {
      id: toolPartId,
      sessionID,
      content: 'hi\n',
    });

    const textPartId = `prt_text_${crypto.randomUUID()}`;
    broadcast('session.text.ended', {
      id: textPartId,
      sessionID,
      text: `echo: ${text}`,
    });

    broadcast('session.usage.updated', {
      sessionID,
      cost: 0.01,
      tokens: { input: 10, output: 5 },
    });

    broadcast('session.execution.succeeded', {
      sessionID,
    });
  } else {
    broadcast('message.part.updated', {
      sessionID,
      part: { id: toolPartId, sessionID, messageID: 'msg_a', type: 'tool', callID: toolPartId, tool: 'bash', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi\n', title: 'echo hi', metadata: {}, time: { start: 0, end: 1 } } },
    });

    const textPartId = `prt_text_${crypto.randomUUID()}`;
    broadcast('message.part.updated', {
      sessionID,
      part: { id: textPartId, sessionID, messageID: 'msg_a', type: 'text', text: `echo: ${text}`, time: { start: 0, end: 1 } },
    });

    broadcast('message.updated', {
      sessionID,
      info: {
        id: 'msg_a', sessionID, role: 'assistant', parentID: 'msg_u', modelID: 'test', providerID: 'test', mode: 'build',
        path: { cwd: sessions.get(sessionID)?.directory ?? '', root: '' },
        cost: 0.01, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now(), completed: Date.now() },
      },
    });

    broadcast('session.idle', { sessionID });
  }
  pendingAborts.delete(sessionID);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (isV2) {
    const auth = req.headers['authorization'];
    const expected = 'Basic ' + Buffer.from(`opencode:${FAKE_PASSWORD}`).toString('base64');
    if (auth !== expected) {
      return send(res, 401, { error: 'Unauthorized' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { healthy: true });
  }

  // Commands
  if (req.method === 'GET' && (url.pathname === '/command' || url.pathname === '/api/command')) {
    const list = [
      {
        name: 'init',
        description: 'guided AGENTS.md setup',
        source: 'command',
        template: 'Create or update `AGENTS.md` for this repository...',
        hints: ['$ARGUMENTS'],
      },
      {
        name: 'review',
        description: 'review changes [commit|branch|pr], defaults to uncommitted',
        source: 'command',
        template: 'You are a code reviewer...',
        subtask: true,
        hints: ['$ARGUMENTS'],
      },
    ];
    if (url.pathname === '/api/command') {
      return send(res, 200, { data: list });
    }
    return send(res, 200, list);
  }

  // Events SSE
  if (req.method === 'GET' && (url.pathname === '/event' || url.pathname === '/api/event')) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    if (url.pathname === '/event') {
      res.write(`data: ${JSON.stringify({ id: 'evt_init', type: 'server.connected', properties: {} })}\n\n`);
    }
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Create session
  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req);
    const id = `ses_test${nextId++}`;
    const directory = url.searchParams.get('directory') ?? '';
    sessions.set(id, { directory, title: body.title ?? '' });
    const info = { id, projectID: 'global', directory, title: body.title ?? '', version: 'test', time: { created: Date.now(), updated: Date.now() } };
    broadcast('session.created', { sessionID: id, info });
    return send(res, 200, info);
  }
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const body = await readBody(req);
    const id = `ses_test${nextId++}`;
    const directory = body.location?.directory ?? '';
    sessions.set(id, { directory, title: body.title ?? '' });
    const info = { id, projectID: 'global', directory, title: body.title ?? '', version: 'test', time: { created: Date.now(), updated: Date.now() } };
    broadcast('session.created', { sessionID: id, info });
    return send(res, 200, { data: info });
  }

  // Prompt (async / v2 prompt)
  const promptV1Match = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
  if (req.method === 'POST' && promptV1Match) {
    const sessionID = promptV1Match[1];
    const body = await readBody(req);
    const text = body.parts?.find((p) => p.type === 'text')?.text ?? '';
    res.writeHead(204);
    res.end();
    void runTurn(sessionID, text);
    return;
  }
  const promptV2Match = /^\/api\/session\/([^/]+)\/prompt$/.exec(url.pathname);
  if (req.method === 'POST' && promptV2Match) {
    const sessionID = promptV2Match[1];
    const body = await readBody(req);
    const text = body.text ?? '';
    res.writeHead(204);
    res.end();
    void runTurn(sessionID, text);
    return;
  }

  // Command
  const commandV1Match = /^\/session\/([^/]+)\/command$/.exec(url.pathname);
  if (req.method === 'POST' && commandV1Match) {
    const sessionID = commandV1Match[1];
    const body = await readBody(req);
    await runTurn(sessionID, `/${body.command} ${body.arguments ?? ''}`.trim());
    return send(res, 200, { info: { id: 'msg_a', sessionID, role: 'assistant' }, parts: [] });
  }
  const commandV2Match = /^\/api\/session\/([^/]+)\/command$/.exec(url.pathname);
  if (req.method === 'POST' && commandV2Match) {
    const sessionID = commandV2Match[1];
    const body = await readBody(req);
    await runTurn(sessionID, `/${body.name} ${body.text ?? ''}`.trim());
    return send(res, 200, { data: { info: { id: 'msg_a', sessionID, role: 'assistant' }, parts: [] } });
  }

  // Messages (History)
  const messageV1Match = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
  if (req.method === 'GET' && messageV1Match) {
    const sessionID = messageV1Match[1];
    return send(res, 200, [
      {
        info: { id: 'msg_hist_u', sessionID, role: 'user', time: { created: 0 } },
        parts: [{ id: 'prt_hist_u', sessionID, messageID: 'msg_hist_u', type: 'text', text: 'what is in this dir?' }],
      },
      {
        info: { id: 'msg_hist_a', sessionID, role: 'assistant', modelID: 'test', providerID: 'test', time: { created: 0, completed: 1 } },
        parts: [
          {
            id: 'prt_hist_tool',
            sessionID,
            messageID: 'msg_hist_a',
            type: 'tool',
            callID: 'prt_hist_tool',
            tool: 'bash',
            state: { status: 'completed', input: { command: 'ls' }, output: 'file.txt\n', title: 'ls', metadata: {}, time: { start: 0, end: 1 } },
          },
          { id: 'prt_hist_text', sessionID, messageID: 'msg_hist_a', type: 'text', text: 'Just file.txt.', time: { start: 1, end: 2 } },
        ],
      },
    ]);
  }
  const messageV2Match = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
  if (req.method === 'GET' && messageV2Match) {
    return send(res, 200, {
      data: [
        {
          id: 'msg_hist_u',
          type: 'user',
          text: 'what is in this dir?',
        },
        {
          id: 'msg_hist_a',
          type: 'assistant',
          content: [
            {
              id: 'prt_hist_tool',
              type: 'tool',
              name: 'bash',
              state: {
                status: 'completed',
                input: { command: 'ls' },
                content: 'file.txt\n',
              },
            },
            {
              id: 'prt_hist_text',
              type: 'text',
              text: 'Just file.txt.',
            },
          ],
        },
        {
          id: 'msg_hist_idle',
          type: 'idle',
        },
      ],
    });
  }

  // Interrupt / abort
  const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
  if (req.method === 'POST' && abortMatch) {
    const flag = pendingAborts.get(abortMatch[1]);
    if (flag) flag.aborted = true;
    return send(res, 200, true);
  }
  const interruptMatch = /^\/api\/session\/([^/]+)\/interrupt$/.exec(url.pathname);
  if (req.method === 'POST' && interruptMatch) {
    const flag = pendingAborts.get(interruptMatch[1]);
    if (flag) flag.aborted = true;
    return send(res, 200, { data: true });
  }

  // Delete
  const deleteV1Match = /^\/session\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteV1Match) {
    sessions.delete(deleteV1Match[1]);
    return send(res, 200, true);
  }
  const deleteV2Match = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteV2Match) {
    sessions.delete(deleteV2Match[1]);
    return send(res, 200, { data: true });
  }

  // Models
  if (req.method === 'GET' && url.pathname === '/api/model') {
    return send(res, 200, {
      location: { directory: url.searchParams.get('location[directory]') ?? '' },
      data: [
        { id: 'deepseek-v4-flash', providerID: 'omniroute', family: 'deepseek', name: 'Deepseek v4 Flash' },
        { id: 'deepseek-v4-pro', providerID: 'omniroute', family: 'deepseek', name: 'Deepseek v4 Pro' },
      ],
    });
  }

  const modelMatch = /^\/api\/session\/([^/]+)\/model$/.exec(url.pathname);
  if (req.method === 'POST' && modelMatch) {
    const body = await readBody(req);
    if (body.model?.providerID === 'FAIL') {
      return send(res, 400, { error: 'InvalidRequestError', message: 'simulated switch failure' });
    }
    res.writeHead(204);
    res.end();
    return;
  }

  // Permissions reply
  const replyV1Match = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (req.method === 'POST' && replyV1Match) {
    const permissionID = replyV1Match[1];
    const body = await readBody(req);
    broadcast('permission.replied', { sessionID: '', permissionID, id: permissionID, response: body.reply });
    const waiter = repliedWaiters.get(permissionID);
    if (waiter) {
      repliedWaiters.delete(permissionID);
      waiter();
    }
    return send(res, 200, true);
  }
  const replyV2Match = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (req.method === 'POST' && replyV2Match) {
    const sessionID = replyV2Match[1];
    const permissionID = replyV2Match[2];
    const body = await readBody(req);
    broadcast('permission.replied', { sessionID, id: permissionID, decision: body.decision, response: body.decision });
    const waiter = repliedWaiters.get(permissionID);
    if (waiter) {
      repliedWaiters.delete(permissionID);
      waiter();
    }
    return send(res, 200, { data: true });
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  /* eslint-disable no-console -- these exact lines are what OpencodeServerManager parses */
  if (isV2) {
    console.log(`server listening on http://127.0.0.1:${port}`);
    console.log(`server password ${FAKE_PASSWORD}`);
  } else {
    console.log(`opencode server listening on http://127.0.0.1:${port}`);
  }
  /* eslint-enable no-console */
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
