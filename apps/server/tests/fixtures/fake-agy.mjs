#!/usr/bin/env node
// A stand-in for `agy --output-format stream-json` used by agy-session.test.ts.
// Real agy costs real inference and network access, so this fixture emits the
// same line shapes captured from a live probe of v1.1.12 without either.
import crypto from 'node:crypto';

const args = process.argv.slice(2);
function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

const prompt = argVal('-p') ?? '';
const conversationId = argVal('--conversation') ?? crypto.randomUUID();
const model = argVal('--model');

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// `agy models` is a genuine top-level subcommand, not `-p` print mode — plain
// text, one `<id>\t<label>` pair per line after a status line, captured live
// against v1.1.12. `AgySession.fetchInitialModels()` spawns exactly this.
if (args[0] === 'models') {
  process.stdout.write('Fetching available models...\n');
  process.stdout.write('gemini-3.6-flash-high\tGemini 3.6 Flash (High)\n');
  process.stdout.write('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n');
  process.exit(0);
}

if (prompt === 'FAIL') {
  process.stderr.write('simulated failure\n');
  process.exit(1);
}

// `/help` resolves locally in real agy — no `init` line, no tool step, zero
// tokens/duration — captured live against v1.1.12. Handled before the normal
// turn shape below since `AgySession.fetchInitialCommands()` sends exactly
// this and expects exactly this response shape.
if (prompt === '/help') {
  emit({
    event: 'command_result',
    command: {
      name: 'help',
      data: {
        commands: [
          { name: 'agents', description: 'List available custom agents' },
          { name: 'model', description: 'Set a model' },
          { name: 'usage', aliases: ['quota'], description: 'View model quota usage' },
        ],
      },
    },
  });
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: '/agents\tList available custom agents\n/model\tSet a model\n/usage (quota)\tView model quota usage\n',
      duration_seconds: 0,
      num_turns: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  process.exit(0);
}

emit({
  event: 'init',
  conversation_id: conversationId,
  init: {
    cwd: process.cwd(),
    tools: ['run_command', 'view_file'],
    permission_mode: 'always-proceed',
  },
});

emit({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' } },
  },
});
emit({
  event: 'step_update',
  step_update: {
    conversation_id: conversationId,
    step_index: 1,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: {
      name: 'run_command',
      parameters: { CommandLine: 'echo hi' },
      output: 'hi\n',
    },
  },
});

function respond() {
  // Echoes the `--model` flag (when present) into the response text, so a
  // test can confirm `AgySession.setModel()` actually reached the *next*
  // turn's argv rather than just recording it internally.
  const text = model ? `echo: ${prompt} model=${model}` : `echo: ${prompt}`;
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
    },
  });
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status: 'SUCCESS',
      response: text,
      duration_seconds: 0.01,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  process.exit(0);
}

if (prompt === 'SLOW') {
  // Long enough for a test to call interrupt()/terminate() before this fires.
  setTimeout(respond, 5000);
} else {
  respond();
}
