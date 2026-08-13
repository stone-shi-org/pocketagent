#!/usr/bin/env node
// A stand-in for `pi --mode rpc` used by pi-session.test.ts and
// sessions.test.ts. No provider in this environment has working credentials
// for pi — this fixture implements just enough of the documented RPC
// contract (docs/rpc.md and the shipped @earendil-works/pi-ai TypeScript
// declarations, read directly since no live run was possible) to exercise
// PiSession end to end. pi has no approval concept in any mode, so unlike
// the other three fixtures there is nothing to gate here — every prompt just
// runs.
import crypto from 'node:crypto';

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, success, extra = {}) {
  write({ id, type: 'response', success, ...extra });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let aborted = false;

async function runTurn(text) {
  aborted = false;
  write({ type: 'agent_start' });
  write({ type: 'turn_start' });
  write({ type: 'message_start', message: { role: 'assistant', content: [] } });

  if (text === 'FAIL') {
    await sleep(10);
    write({
      type: 'message_end',
      message: { role: 'assistant', content: [], usage: { input: 5, output: 1, cost: { total: 0.001 } }, stopReason: 'error' },
    });
    write({ type: 'agent_end', messages: [] });
    write({ type: 'agent_settled' });
    return;
  }

  const toolCallId = `call_${crypto.randomUUID()}`;
  write({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { id: toolCallId, name: 'bash', arguments: { command: 'echo hi' } } },
  });
  write({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'echo hi' } });
  await sleep(10);
  if (aborted) return;

  if (text === 'SLOW') {
    await sleep(5000);
    if (aborted) return;
  }

  write({
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'hi\n' }] },
    isError: false,
  });

  write({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 1 } });
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: `echo: ${text}` } });
  write({ type: 'message_update', assistantMessageEvent: { type: 'text_end', contentIndex: 1, content: `echo: ${text}` } });

  write({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `echo: ${text}` }],
      usage: { input: 10, output: 5, cost: { total: 0.002 } },
      stopReason: 'stop',
    },
  });
  write({ type: 'turn_end', message: {}, toolResults: [] });
  write({ type: 'agent_end', messages: [] });
  write({ type: 'agent_settled' });
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    handleLine(line);
  }
});

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (msg.type === 'prompt') {
    respond(msg.id, true, { command: 'prompt' });
    void runTurn(msg.message);
    return;
  }
  if (msg.type === 'abort') {
    aborted = true;
    respond(msg.id, true, { command: 'abort' });
    return;
  }
  if (msg.type === 'get_commands') {
    // Shape captured live against the real, installed CLI (v0.84.1) — note
    // the real server nests `sourceInfo: {path, source, scope, origin}`
    // rather than the flat `location`/`path` docs/rpc.md documents; this
    // fixture matches what was actually observed on the wire.
    respond(msg.id, true, {
      command: 'get_commands',
      data: {
        commands: [
          {
            name: 'session-name',
            description: 'Set or clear session name',
            source: 'extension',
            sourceInfo: { path: '/home/user/.pi/agent/extensions/session.ts', source: 'file', scope: 'user', origin: 'top-level' },
          },
          { name: 'skill:brave-search', description: 'Web search via Brave API', source: 'skill' },
        ],
      },
    });
    return;
  }
  respond(msg.id, true, { command: msg.type, data: {} });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
