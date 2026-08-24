#!/usr/bin/env node
// A stand-in for `opencode serve` used by opencode-session.test.ts and
// sessions.test.ts. Real opencode needs a working model provider — network
// access this sandbox doesn't reliably have — so this fixture implements just
// enough of the documented HTTP + SSE contract (captured from a live probe of
// the real, installed v1.17.18 server and its `@opencode-ai/sdk` generated
// types) to exercise OpencodeServerManager/OpencodeSession end to end:
// session create, prompt_async + SSE-delivered response, a real permission
// round trip (gated on an actual reply, not just echoed back), abort, and
// session.error.
import http from 'node:http';
import crypto from 'node:crypto';

let nextId = 1;
const sessions = new Map(); // id -> { directory, title }
const sseClients = new Set();
const pendingAborts = new Map(); // sessionID -> AbortController-ish flag object

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

function broadcast(type, properties) {
  const payload = `data: ${JSON.stringify({ id: `evt_${crypto.randomUUID()}`, type, properties })}\n\n`;
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
    broadcast('session.error', { sessionID, error: { name: 'UnknownError', data: { message: 'simulated failure' } } });
    return;
  }

  const toolPartId = `prt_tool_${crypto.randomUUID()}`;
  broadcast('message.part.updated', {
    sessionID,
    part: { id: toolPartId, sessionID, messageID: 'msg_a', type: 'tool', callID: toolPartId, tool: 'bash', state: { status: 'running', input: { command: 'echo hi' } } },
  });
  await new Promise((r) => setTimeout(r, 10));
  if (flag.aborted) return;

  if (text === 'NEEDS_PERMISSION') {
    const permissionId = `per_${crypto.randomUUID()}`;
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
    // Real gating: wait for an actual reply, not a timer — see /permission/:id/reply below.
    await new Promise((resolve) => repliedWaiters.set(permissionId, resolve));
    if (flag.aborted) return;
  }

  if (text === 'SLOW') {
    await new Promise((r) => setTimeout(r, 5000));
    if (flag.aborted) return;
  }

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
  pendingAborts.delete(sessionID);
}

const repliedWaiters = new Map(); // permissionID -> resolve()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { healthy: true });
  }

  // Shape captured live against the real, installed server (v1.17.18) via
  // `GET /command?directory=...` and its own OpenAPI `/doc`.
  if (req.method === 'GET' && url.pathname === '/command') {
    return send(res, 200, [
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
    ]);
  }

  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ id: 'evt_init', type: 'server.connected', properties: {} })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req);
    const id = `ses_test${nextId++}`;
    const directory = url.searchParams.get('directory') ?? '';
    sessions.set(id, { directory, title: body.title ?? '' });
    const info = { id, projectID: 'global', directory, title: body.title ?? '', version: 'test', time: { created: Date.now(), updated: Date.now() } };
    broadcast('session.created', { sessionID: id, info });
    return send(res, 200, info);
  }

  const promptMatch = /^\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
  if (req.method === 'POST' && promptMatch) {
    const sessionID = promptMatch[1];
    const body = await readBody(req);
    const text = body.parts?.find((p) => p.type === 'text')?.text ?? '';
    res.writeHead(204);
    res.end();
    void runTurn(sessionID, text);
    return;
  }

  const commandMatch = /^\/session\/([^/]+)\/command$/.exec(url.pathname);
  if (req.method === 'POST' && commandMatch) {
    const sessionID = commandMatch[1];
    const body = await readBody(req);
    // Real opencode returns the completed message synchronously here rather
    // than accepting async like prompt_async — schema-confirmed, not
    // exercised against a live model turn (see `matchKnownCommand`'s doc
    // comment). This fixture mirrors "synchronous response" but still
    // broadcasts over SSE first, since that is what a real caller actually
    // listens to for rendering.
    await runTurn(sessionID, `/${body.command} ${body.arguments ?? ''}`.trim());
    return send(res, 200, { info: { id: 'msg_a', sessionID, role: 'assistant' }, parts: [] });
  }

  // Shape captured live against the real, installed server's own OpenAPI
  // `/doc` (`GET /session/{sessionID}/message` -> `Array<{info, parts}>`) —
  // see normalize.ts's `opencodeHistoryEvents` doc comment. Canned for
  // `OpencodeSession.fetchHistory`'s test: one full turn (user text, a
  // completed tool call, a final answer) so history reconstruction has
  // something real to exercise end to end without a live model provider.
  const messageMatch = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
  if (req.method === 'GET' && messageMatch) {
    const sessionID = messageMatch[1];
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

  const abortMatch = /^\/session\/([^/]+)\/abort$/.exec(url.pathname);
  if (req.method === 'POST' && abortMatch) {
    const flag = pendingAborts.get(abortMatch[1]);
    if (flag) flag.aborted = true;
    return send(res, 200, true);
  }

  const deleteMatch = /^\/session\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    sessions.delete(deleteMatch[1]);
    return send(res, 200, true);
  }

  // Shape captured live against the real, installed server's `/api/*` v2
  // surface (v1.18.18, via its own generated OpenAPI `/doc`) — the only two
  // endpoints `OpencodeSession` reaches on that surface, since the legacy
  // surface every other call here uses has no model-catalog/switch endpoint
  // at all. `location[directory]` is deepObject-style query encoding, a
  // literal bracketed key, not a nested object.
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

  const replyMatch = /^\/permission\/([^/]+)\/reply$/.exec(url.pathname);
  if (req.method === 'POST' && replyMatch) {
    const permissionID = replyMatch[1];
    const body = await readBody(req);
    broadcast('permission.replied', { sessionID: '', permissionID, id: permissionID, response: body.reply });
    const waiter = repliedWaiters.get(permissionID);
    if (waiter) {
      repliedWaiters.delete(permissionID);
      waiter();
    }
    return send(res, 200, true);
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  // eslint-disable-next-line no-console -- this exact line is what OpencodeServerManager parses.
  console.log(`opencode server listening on http://127.0.0.1:${port}`);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
