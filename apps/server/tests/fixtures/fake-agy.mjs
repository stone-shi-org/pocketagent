#!/usr/bin/env node
// A stand-in for the `agy` CLI used by agy-session.test.ts (ACP mode) and
// agent-probe tests (`models` subcommand).
//
// In `acp` mode, speaks newline-delimited JSON-RPC 2.0 over stdin/stdout,
// mirroring the exact shapes captured against real `agy acp` v1.5.14:
//   - `initialize` -> capabilities
//   - `session/new` / `session/resume` -> sessionId, models, modes, + available_commands_update
//   - `session/set_model` -> updates current model live
//   - `session/prompt` -> streams session/update notifications, optionally sends
//     server-initiated `session/request_permission` (when NOT started with
//     --dangerously-skip-permissions), and resolves with per-turn usage
//   - `session/cancel` -> cancels an in-flight turn
//   - `session/close` -> acknowledges close
import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const skipPermissions = args.includes('--dangerously-skip-permissions');

if (process.env.AGY_FIXTURE_ARGV_FILE) {
  fs.appendFileSync(process.env.AGY_FIXTURE_ARGV_FILE, JSON.stringify(args) + '\n');
}
if (process.env.AGY_FIXTURE_PID_FILE) {
  fs.writeFileSync(process.env.AGY_FIXTURE_PID_FILE, String(process.pid));
}

// Keep `agy models` working for any tests that probe the model catalog directly.
if (args[0] === 'models') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stderr.write('Fetching available models...\n');
    process.stdout.write('gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n');
    process.stdout.write('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
    process.exit(0);
  });
} else if (args[0] === 'acp') {
  runAcpServer();
} else {
  process.stderr.write(`unexpected agy mode: ${args.join(' ')}\n`);
  process.exit(2);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function runAcpServer() {
  let sessionId = null;
  let currentModel = 'auto';
  let serverReqId = 1;
  let turnCounter = 0;

  /** Map of server-initiated request id -> resolve(result) */
  const pendingClientReplies = new Map();
  /** Active in-flight prompt state, for `session/cancel`. */
  let activeCancel = null;

  const AVAILABLE_MODELS = [
    { modelId: 'auto', name: 'Gemini Pro Next' },
    { modelId: 'gemini-flash-next', name: 'Gemini Flash Next' },
    { modelId: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  ];

  const AVAILABLE_MODES = [
    { id: 'default', name: 'Default', description: 'Ask before edits and commands.' },
    { id: 'accept-edits', name: 'Accept edits', description: 'Approve file edits.' },
    { id: 'auto', name: 'Auto', description: 'Approve safe commands.' },
    { id: 'plan', name: 'Plan', description: 'Plan before executing.' },
  ];

  function notifyUpdate(update) {
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update },
    });
  }

  function requestPermission(toolCall) {
    const id = String(serverReqId++);
    return new Promise((resolve) => {
      pendingClientReplies.set(id, resolve);
      send({
        jsonrpc: '2.0',
        id,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall,
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
    });
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

    // Reply from client to our server-initiated request (e.g. session/request_permission)
    if (msg.id !== undefined && msg.method === undefined) {
      const resolver = pendingClientReplies.get(String(msg.id));
      if (resolver) {
        pendingClientReplies.delete(String(msg.id));
        resolver(msg.result ?? null);
      }
      return;
    }

    // Notification from client
    if (msg.method === 'session/cancel') {
      if (activeCancel) activeCancel();
      return;
    }

    const { id, method, params = {} } = msg;

    if (method === 'initialize') {
      if (process.env.AGY_FIXTURE_HANG_INIT === '1') {
        return; // Simulate a wedged CLI that never responds to initialize.
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
          },
          agentInfo: { name: 'Fake Antigravity ACP Server', version: '1.5.14' },
        },
      });
      return;
    }

    if (method === 'session/new' || method === 'session/resume') {
      if (process.env.AGY_FIXTURE_FAIL_SESSION_NEW === '1') {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'simulated session/new failure' },
        });
        return;
      }
      sessionId = method === 'session/resume' && params.sessionId ? params.sessionId : crypto.randomUUID();
      if (process.env.AGY_FIXTURE_RPC_LOG) {
        fs.appendFileSync(process.env.AGY_FIXTURE_RPC_LOG, JSON.stringify({ method, sessionId }) + '\n');
      }
      send({
        jsonrpc: '2.0',
        id,
        result: {
          sessionId,
          models: { availableModels: AVAILABLE_MODELS, currentModelId: currentModel },
          modes: { currentModeId: 'default', availableModes: AVAILABLE_MODES },
        },
      });
      // Push available_commands_update right after session/new|resume, just like real agy acp.
      notifyUpdate({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'goal', description: 'Run until the specified goal is completely finished.' },
          { name: 'compact', description: 'Compact the conversation now.' },
          { name: 'plan', description: 'Plan carefully before executing a task.' },
        ],
      });
      return;
    }

    if (method === 'session/set_model') {
      currentModel = params.modelId ?? currentModel;
      if (process.env.AGY_FIXTURE_RPC_LOG) {
        fs.appendFileSync(
          process.env.AGY_FIXTURE_RPC_LOG,
          JSON.stringify({ method, modelId: currentModel }) + '\n',
        );
      }
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'session/close') {
      if (process.env.AGY_FIXTURE_RPC_LOG) {
        fs.appendFileSync(process.env.AGY_FIXTURE_RPC_LOG, JSON.stringify({ method, sessionId }) + '\n');
      }
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'session/prompt') {
      const blocks = Array.isArray(params.prompt) ? params.prompt : [];
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      void handlePrompt(id, text);
      return;
    }

    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  });

  rl.on('close', () => process.exit(0));

  async function handlePrompt(rpcId, text) {
    turnCounter++;

    if (text === 'CRASH') {
      process.stderr.write('simulated crash\n');
      process.exit(1);
    }

    if (text === 'CRASH_BETWEEN_TURNS') {
      notifyUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
      send({
        jsonrpc: '2.0',
        id: rpcId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } },
      });
      setTimeout(() => process.exit(1), 50);
      return;
    }

    if (text === 'DANGLING_TOOL_ERROR') {
      notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: `call_dangle_err_${turnCounter}`,
        name: 'run_command',
        rawInput: { CommandLine: 'echo fail' },
        status: 'in_progress',
        kind: 'execute',
        title: 'echo fail',
      });
      // No terminal tool_call_update — turn fails outright.
      send({
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32000, message: 'tool execution aborted' },
      });
      return;
    }

    if (text === 'DANGLING_READ_END_TURN') {
      notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: `call_dangle_read_${turnCounter}`,
        name: 'read_file',
        rawInput: { Path: '/tmp/foo.txt' },
        status: 'in_progress',
        kind: 'read',
        title: 'File foo.txt',
      });
      // Non-execute tool with no terminal update, followed by normal end_turn.
      notifyUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'done reading' },
      });
      send({
        jsonrpc: '2.0',
        id: rpcId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
      });
      return;
    }

    if (text === 'QUOTA') {
      send({
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32000,
          message: 'Eligibility check failed: RESOURCE_EXHAUSTED (code 429): quota exceeded',
        },
      });
      return;
    }

    if (text === 'TIMEOUT_ONCE') {
      const stateFile = process.env.AGY_FIXTURE_TIMEOUT_ONCE_FILE;
      if (stateFile && !fs.existsSync(stateFile)) {
        fs.writeFileSync(stateFile, 'seen');
        send({
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32000, message: 'timeout waiting for response' },
        });
        return;
      }
    }

    if (text === 'SLOW_CANCEL') {
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          activeCancel = null;
          send({
            jsonrpc: '2.0',
            id: rpcId,
            result: { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
          });
          resolve();
        }, 10_000);
        activeCancel = () => {
          clearTimeout(t);
          activeCancel = null;
          send({
            jsonrpc: '2.0',
            id: rpcId,
            error: { code: -32800, message: 'request cancelled' },
          });
          resolve();
        };
      });
      return;
    }

    // Emit live session title on the first turn, just like real agy acp.
    if (turnCounter === 1) {
      notifyUpdate({
        sessionUpdate: 'session_info_update',
        title: `Title for ${text.slice(0, 24)}`,
      });
    }

    if (text === 'NEED_APPROVAL') {
      const toolCallId = `call_perm_${turnCounter}`;
      const toolCall = {
        sessionUpdate: 'tool_call',
        toolCallId,
        name: 'run_command',
        args: { CommandLine: 'echo approved', WaitMsBeforeAsync: 5000 },
        rawInput: { CommandLine: 'echo approved', WaitMsBeforeAsync: 5000 },
        status: 'in_progress',
        kind: 'execute',
        title: 'echo approved',
      };
      notifyUpdate(toolCall);

      let allowed = skipPermissions;
      if (!skipPermissions) {
        notifyUpdate({ ...toolCall, sessionUpdate: 'tool_call_update', status: 'pending' });
        const reply = await requestPermission({ ...toolCall, status: 'pending' });
        const outcome = reply?.outcome;
        allowed = outcome?.outcome === 'selected' && outcome?.optionId === 'allow';
      }

      if (allowed) {
        notifyUpdate({ ...toolCall, sessionUpdate: 'tool_call_update', status: 'in_progress' });
        notifyUpdate({
          ...toolCall,
          sessionUpdate: 'tool_call_update',
          status: 'completed',
          rawOutput: { output: 'approved\n' },
        });
        notifyUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'ran echo approved' },
        });
      } else {
        notifyUpdate({
          ...toolCall,
          sessionUpdate: 'tool_call_update',
          status: 'failed',
          rawOutput: { error: 'User denied permission' },
        });
        notifyUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'command denied' },
        });
      }

      send({
        jsonrpc: '2.0',
        id: rpcId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } },
      });
      return;
    }

    if (text === 'BACKGROUND_TASK') {
      const taskFile = process.env.AGY_FIXTURE_BACKGROUND_TASK_FILE;
      const toolCallId = `call_bg_${turnCounter}`;
      notifyUpdate({
        sessionUpdate: 'tool_call',
        toolCallId,
        name: 'run_command',
        rawInput: { CommandLine: 'sleep 1 && echo bg', WaitMsBeforeAsync: 100 },
        status: 'in_progress',
        kind: 'execute',
        title: 'sleep 1 && echo bg',
      });
      notifyUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'started' },
      });
      // Resolve turn BEFORE background task completes — matching real agy acp v1.5.14.
      send({
        jsonrpc: '2.0',
        id: rpcId,
        result: { stopReason: 'end_turn', usage: { inputTokens: 50, outputTokens: 10 } },
      });
      // Complete background task asynchronously while process stays alive between turns.
      setTimeout(() => {
        if (taskFile) fs.writeFileSync(taskFile, 'FINISHED');
        notifyUpdate({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          name: 'run_command',
          status: 'completed',
          rawOutput: { output: 'bg\n' },
        });
        notifyUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Background task finished.' },
        });
      }, 250);
      return;
    }

    // Default turn: thought + tool_call + tool_call_update + text chunks + per-turn usage.
    notifyUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking about it' },
    });
    const callId = `call_${turnCounter}`;
    notifyUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      name: 'run_command',
      rawInput: { CommandLine: 'echo hi' },
      status: 'in_progress',
      kind: 'execute',
      title: 'echo hi',
    });
    notifyUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: callId,
      name: 'run_command',
      status: 'completed',
      rawOutput: { output: 'hi\n' },
    });
    const replyText = `echo: ${text} model=${currentModel}`;
    notifyUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: replyText },
    });
    send({
      jsonrpc: '2.0',
      id: rpcId,
      result: {
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100 + turnCounter,
          outputTokens: 25,
          cachedReadTokens: 40,
          cachedWriteTokens: 0,
        },
      },
    });
  }
}
